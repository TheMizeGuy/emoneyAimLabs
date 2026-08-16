'use strict';

// Sliding-window rate limiter held in process memory. The API runs as a single
// Railway service, so a shared store is not needed; if it is ever scaled out,
// the limits become per-instance and must move to Postgres or Redis.
//
// The structure is hard-bounded. An earlier version treated `maxKeys` as a
// trigger for a full-map scan that could only evict already-expired keys, so an
// attacker holding every key fresh grew the map without limit AND paid a full
// scan per insert - quadratic work. Now:
//
//   * the map never exceeds maxKeys: the least recently used key is evicted to
//     make room, so memory is flat under attack;
//   * `take` touches only its own key, never the whole map;
//   * expiry sweeping runs on an unref'd interval, off the request path.
//
// Eviction fails OPEN (an evicted attacker gets a fresh budget) rather than
// closed (locking out a legitimate player). With every limiter now keyed on a
// session id or an address rather than anything the caller invents, the key
// space is bounded by real users, so eviction pressure needs a genuine crowd.

const DEFAULT_MAX_KEYS = 20000;
const DEFAULT_SWEEP_MS = 60000;

function createRateLimiter(options = {}) {
  const now = options.now || (() => Date.now());
  const maxKeys = options.maxKeys || DEFAULT_MAX_KEYS;
  const sweepIntervalMs = options.sweepIntervalMs || DEFAULT_SWEEP_MS;
  // Map iteration order is insertion order, and `take` re-inserts on every
  // touch, so the first key is always the least recently used one.
  const hits = new Map();
  let timer = null;
  let evictions = 0;

  function sweepExpired() {
    const nowMs = now();
    for (const [key, entry] of hits) {
      const last = entry.stamps.length === 0 ? 0 : entry.stamps[entry.stamps.length - 1];
      if (nowMs - last > entry.windowMs) hits.delete(key);
    }
    if (hits.size === 0) stop();
  }

  function start() {
    if (timer) return;
    timer = setInterval(sweepExpired, sweepIntervalMs);
    // A background sweep must never hold the process open.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  // Returns { allowed, retryAfterSeconds }.
  function take(key, limit, windowMs) {
    const nowMs = now();
    const cutoff = nowMs - windowMs;

    let entry = hits.get(key);
    if (entry) {
      // Re-insert to move this key to the most-recently-used end.
      hits.delete(key);
    } else {
      // Hard cap: make room before growing, never after.
      while (hits.size >= maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
        evictions += 1;
      }
      entry = { stamps: [], windowMs };
    }
    entry.windowMs = windowMs;
    hits.set(key, entry);
    start();

    const { stamps } = entry;
    // Only this key's own stamps are touched - bounded by `limit`.
    while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
    if (stamps.length >= limit) {
      const retryMs = Math.max(0, stamps[0] + windowMs - nowMs);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryMs / 1000) || 1 };
    }
    stamps.push(nowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function reset() {
    hits.clear();
    stop();
  }

  return {
    take,
    reset,
    stop,
    sweep: sweepExpired,
    size: () => hits.size,
    evicted: () => evictions,
    maxKeys,
  };
}

module.exports = { createRateLimiter, DEFAULT_MAX_KEYS };
