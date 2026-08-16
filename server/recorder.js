'use strict';

const crypto = require('node:crypto');

// The attack audit trail (V3.4 rule 4). Every rejected request leaves a log
// line, and everything worth keeping leaves a row, so the owner can watch
// attempts pile up.
//
// What is deliberately NOT recorded: raw addresses (only a keyed hash), cookies,
// headers, anything from the OAuth flow. The payload holds the claimed game
// numbers and nothing else.
//
// Two entry points, because a rejection that costs the attacker nothing must
// not cost the database anything either:
//
//   record(req, reason, payload)  persists a row - used for rejections that
//                                 required a session and got past the limiter,
//                                 i.e. real signal.
//   note(req, reason)             counts in memory and logs a periodic
//                                 aggregate - used for rate-limited requests,
//                                 which are unauthenticated, unbounded in
//                                 volume, and would otherwise turn a cheap 429
//                                 into a database write. A flood must never be
//                                 able to fill the volume and take the service
//                                 down with it.

// Ceiling on audit writes in flight at once. The pool has 5 connections and the
// writer is fire-and-forget, so without this an attacker who outruns Postgres
// grows node-postgres's internal acquisition queue without limit.
const MAX_INFLIGHT_WRITES = 32;
const AGGREGATE_FLUSH_MS = 60000;

// Rejections that are cheap to provoke, unauthenticated, and unbounded in
// volume. They are counted and logged in aggregate, never stored.
//
// Storing them was worse than a disk problem: a measured 20-second flood filled
// the table with 26548 `run_not_found` rows against four genuine anti-cheat
// verdicts - 98.2% noise in the one table whose entire purpose is letting the
// owner see cheating attempts. An audit trail nobody can read is not an audit
// trail. The verdicts below are what actually belongs in it.
const LOG_ONLY_REASONS = new Set([
  'rate_limited',
  'run_not_found',
  'unauthenticated',
  'origin_missing',
  'origin_mismatch',
  'content_type',
]);

// Genuine anti-cheat verdicts: each one means a request got past the wall, the
// limiter and the session check and was then judged a forgery. These must
// always reach the table.
const ALWAYS_PERSISTED_REASONS = Object.freeze([
  'client_flagged',
  'chain_invalid',
  'implausible_stats',
  'invalid_signature',
  'time_exceeds_elapsed',
  'insufficient_liveness',
  'below_floor',
  'above_sim_ceiling',
  'flappy_phase_too_short',
  'forbidden_origin',
  'invalid_state',
]);

function createRecorder(deps) {
  const { store, config, now, log } = deps;
  const counters = new Map();
  let inflight = 0;
  let dropped = 0;
  // Set on the first counted event rather than at construction, so the very
  // first rejection after boot does not immediately emit an aggregate of one.
  let lastFlushMs = null;

  function ipHash(ip) {
    if (typeof ip !== 'string' || ip.length === 0) return null;
    return crypto
      .createHmac('sha256', config.sessionSecret)
      .update(ip, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }

  // baseUrl + path, never originalUrl: the OAuth callback carries a code in its
  // query string and that must never be written down.
  function endpointOf(req) {
    return `${req.method} ${req.baseUrl || ''}${req.path}`;
  }

  function bump(reason) {
    counters.set(reason, (counters.get(reason) || 0) + 1);
  }

  // Emits one line summarising everything suppressed since the last flush, so a
  // flood is visible in the logs as a count instead of as a million rows.
  function flush(force) {
    const nowMs = now().getTime();
    if (lastFlushMs === null) lastFlushMs = nowMs;
    if (!force && nowMs - lastFlushMs < AGGREGATE_FLUSH_MS) return;
    if (counters.size === 0 && dropped === 0) {
      lastFlushMs = nowMs;
      return;
    }
    const parts = [...counters.entries()].map(([reason, count]) => `${reason}=${count}`);
    if (dropped > 0) parts.push(`audit_writes_dropped=${dropped}`);
    log(`[ANTICHEAT] suppressed ${parts.join(' ')}`);
    counters.clear();
    dropped = 0;
    lastFlushMs = nowMs;
  }

  // Log-only. Never touches the database, whatever the volume.
  function note(req, reason) {
    bump(reason);
    flush(false);
  }

  // Never throws and never awaits the caller: an audit write must not be able
  // to break, slow or fail a request. Drops rather than queueing without limit.
  //
  // Reasons on the log-only list are downgraded here rather than at the call
  // site, so a route cannot accidentally persist a flood-shaped rejection, and
  // any reason added later persists by default.
  function record(req, reason, payload) {
    if (LOG_ONLY_REASONS.has(reason)) return note(req, reason);

    const userId = req.session ? req.session.sub : null;
    const endpoint = endpointOf(req);
    log(`[ANTICHEAT] reason=${reason} endpoint=${endpoint} user=${userId || '-'}`);
    flush(false);

    if (inflight >= MAX_INFLIGHT_WRITES) {
      dropped += 1;
      return;
    }
    inflight += 1;
    Promise.resolve()
      .then(() => store.recordRejection(
        { userId, ipHash: ipHash(req.ip), endpoint, reason, payload },
        now(),
      ))
      .catch((err) => log(`rejection audit write failed: ${err.code || 'error'}`))
      .finally(() => { inflight -= 1; });
  }

  return {
    record,
    note,
    ipHash,
    flush: () => flush(true),
    inflight: () => inflight,
    droppedWrites: () => dropped,
  };
}

module.exports = {
  createRecorder,
  MAX_INFLIGHT_WRITES,
  AGGREGATE_FLUSH_MS,
  LOG_ONLY_REASONS,
  ALWAYS_PERSISTED_REASONS,
};
