'use strict';

const { newRunToken } = require('./validation');

// Data access. Every query is parameterised - no request value is ever
// concatenated into SQL. The pool is injected so tests can drive an in-memory
// Postgres instead of a live one.

const MAX_TEXT = 200;
const MAX_URL = 512;
// Serialized size ceiling for one audit row's payload. Several fail() sites
// echo the caller's own request body back into the note, and the body limit is
// 4 KB, so an authenticated account could otherwise write 120 KB a minute into
// the one table whose whole purpose is being readable.
const MAX_PAYLOAD = 1000;
const LEADERBOARD_LIMIT = 50;
// Run history kept per player, oldest pruned on insert.
const RUN_HISTORY_LIMIT = 100;
// A run with no heartbeat for this long has been abandoned: the client beats
// every five seconds while a run is alive.
const RUN_STALE_MS = 90 * 1000;
// The audit trail is for watching live attacks, not for keeping forever.
const REJECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Feed events kept beyond the replay window, so the prune never races a read.
const FEED_RETENTION = 500;
// The stats board shows at most this many players in one response.
const STATS_LIMIT = 200;
// Repeated blind guesses are slowed without treating an honest mismatch as a
// ban. The first miss has no delay; later misses ramp to one minute, and either
// a correct solve or ten quiet minutes returns the player to zero.
const CHALLENGE_RETRY_DELAYS_MS = Object.freeze([0, 5000, 15000, 30000, 60000]);
const CHALLENGE_RETRY_RESET_MS = 10 * 60 * 1000;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

function clamp(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function toMs(value) {
  return value === null || value === undefined ? null : new Date(value).getTime();
}

// pg reports constraint failures with SQLSTATE codes; pg-mem only carries the
// message, so both are checked.
function isViolation(err, code, pattern) {
  if (!err) return false;
  if (err.code === code) return true;
  return pattern.test(String(err.message || ''));
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    issuedAtMs: toMs(row.issued_at),
    chaseStartedAtMs: toMs(row.chase_started_at),
    chaseStartBeats: Number(row.chase_start_beats || 0),
    challengeSeed: row.challenge_seed === undefined ? null : row.challenge_seed,
    challengeStartedAtMs: toMs(row.challenge_started_at),
    challengeSolvedAtMs: toMs(row.challenge_solved_at),
    challengeCount: Number(row.challenge_count || 0),
    challengeSolvedCount: Number(row.challenge_solved_count || 0),
    beats: Number(row.beats),
    lastBeatAtMs: toMs(row.last_beat_at),
    beatCounter: Number(row.beat_counter || 0),
    consumed: row.consumed === true,
    failed: row.failed === true,
  };
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.twitch_id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    // Three lifetime counters with distinct meanings (V3.2 as refined):
    //   flappyFails - bird deaths, client reported
    //   chaseFails  - failed runs that reached the popup chase
    //   totalFails  - every failed run, chase or abandoned mid-gauntlet
    flappyFails: Number(row.flappy_fails || 0),
    chaseFails: Number(row.chase_fails || 0),
    totalFails: Number(row.runs_failed_total || 0),
  };
}

function mapRunHistory(row) {
  return {
    mode: row.mode,
    outcome: row.outcome,
    timeMs: row.time_ms === null || row.time_ms === undefined ? null : Number(row.time_ms),
    failReason: row.fail_reason === undefined ? null : row.fail_reason,
    at: new Date(row.issued_at),
    // Server-derived: a run that never stamped a chase start died in the
    // gauntlet.
    phase: row.chase_started_at === null || row.chase_started_at === undefined
      ? 'flappy'
      : 'chase',
  };
}

function mapScore(row) {
  if (!row) return null;
  return {
    timeMs: Number(row.time_ms),
    misses: Number(row.misses),
    nearMisses: Number(row.near_misses),
    // Derived by the database, never submitted: every miss was a click, and
    // the win itself was one more.
    clicks: row.clicks === undefined ? Number(row.misses) + 1 : Number(row.clicks),
    achievedAt: new Date(row.achieved_at),
  };
}

function createStore(pool) {
  async function upsertUser(profile, now) {
    const { rows } = await pool.query(
      `INSERT INTO users (twitch_id, login, display_name, avatar_url, created_at, last_login)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (twitch_id) DO UPDATE SET
         login = EXCLUDED.login,
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         last_login = EXCLUDED.last_login
       RETURNING twitch_id, login, display_name, avatar_url,
                 flappy_fails, chase_fails, runs_failed_total`,
      [
        String(profile.id),
        clamp(profile.login, MAX_TEXT),
        clamp(profile.displayName || profile.login, MAX_TEXT),
        clamp(profile.avatarUrl || '', MAX_URL),
        now,
      ],
    );
    return mapUser(rows[0]);
  }

  async function getUser(userId) {
    const { rows } = await pool.query(
      `SELECT twitch_id, login, display_name, avatar_url,
              flappy_fails, chase_fails, runs_failed_total
       FROM users WHERE twitch_id = $1`,
      [userId],
    );
    return mapUser(rows[0]);
  }

  async function getChallengeRetry(userId) {
    const { rows } = await pool.query(
      `SELECT challenge_fail_count, challenge_fail_last_at, challenge_retry_after
       FROM users WHERE twitch_id = $1`,
      [userId],
    );
    if (rows.length === 0) return null;
    return {
      failureCount: Number(rows[0].challenge_fail_count || 0),
      lastFailureAtMs: toMs(rows[0].challenge_fail_last_at),
      retryAfterMs: toMs(rows[0].challenge_retry_after),
    };
  }

  // The session epoch makes a stateless cookie revocable: it is signed into the
  // token and compared on every authenticated request, so bumping it retires
  // every cookie that user ever held. One narrow indexed read per authed call.
  async function getSessionEpoch(userId) {
    const { rows } = await pool.query(
      'SELECT session_epoch FROM users WHERE twitch_id = $1',
      [userId],
    );
    return rows.length === 0 ? null : Number(rows[0].session_epoch || 0);
  }

  // Bumps only when the caller presents the epoch that is currently live, so a
  // logout is idempotent and an already-retired cookie cannot drive writes by
  // calling it again. Guarded in the predicate, so concurrent logouts settle to
  // one increment.
  async function bumpSessionEpoch(userId, expectedEpoch) {
    const { rows } = await pool.query(
      `UPDATE users SET session_epoch = session_epoch + 1
       WHERE twitch_id = $1 AND session_epoch = $2
       RETURNING session_epoch`,
      [userId, expectedEpoch],
    );
    return rows.length === 0 ? null : Number(rows[0].session_epoch);
  }

  // Used to attach identities to a batch of swept runs before they stream.
  // The IN list is built from numbered placeholders, never from the values.
  async function getUsers(userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) return [];
    const placeholders = userIds.map((value, index) => `$${index + 1}`).join(', ');
    const { rows } = await pool.query(
      `SELECT twitch_id, login, display_name, avatar_url,
              flappy_fails, chase_fails, runs_failed_total
       FROM users WHERE twitch_id IN (${placeholders})`,
      userIds,
    );
    return rows.map(mapUser);
  }

  // Practice runs open at chase start, so their chase phase begins immediately.
  // Simulation runs open at flappy start and get stamped later by the first
  // heartbeat that declares the chase has begun.
  async function createRun(userId, mode, now) {
    const id = newRunToken();
    await pool.query(
      `INSERT INTO runs
         (id, user_id, mode, issued_at, chase_started_at, beats, last_beat_at,
          consumed, failed, outcome)
       VALUES ($1, $2, $3, $4, $5, 0, NULL, false, false, 'open')`,
      [id, userId, mode, now, mode === 'practice' ? now : null],
    );
    await pruneUserRuns(userId);
    return id;
  }

  // Close-and-open is one transaction, serialised on the stable owning user
  // row. Without that lock, two concurrent /run requests can both close
  // nothing and then both insert an open run. The expression unique index is a
  // second line of defence; one retry also covers a rolling deploy where an old
  // process that does not take the user lock races this transaction.
  async function replaceOpenRun(userId, mode, now) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = await client.query(
          'SELECT twitch_id FROM users WHERE twitch_id = $1 FOR UPDATE',
          [userId],
        );
        if (owner.rows.length === 0) throw new Error('run owner disappeared');

        const closed = await client.query(
          `UPDATE runs SET failed = true, outcome = 'failed'
           WHERE user_id = $1 AND consumed = false AND failed = false
           RETURNING id, user_id, mode, fail_reason, chase_started_at`,
          [userId],
        );
        const failures = closed.rows.map(toFailure);
        if (failures.length > 0) {
          const chase = failures.filter((failure) => failure.phase === 'chase').length;
          await client.query(
            `UPDATE users
             SET runs_failed_total = runs_failed_total + $2,
                 chase_fails = chase_fails + $3
             WHERE twitch_id = $1`,
            [userId, failures.length, chase],
          );
        }

        const runId = newRunToken();
        await client.query(
          `INSERT INTO runs
             (id, user_id, mode, issued_at, chase_started_at, beats, last_beat_at,
              consumed, failed, outcome)
           VALUES ($1, $2, $3, $4, $5, 0, NULL, false, false, 'open')`,
          [runId, userId, mode, now, mode === 'practice' ? now : null],
        );
        await pruneUserRunsWith(client, userId, RUN_HISTORY_LIMIT);
        await client.query('COMMIT');
        return { runId, failures };
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // Preserve the original failure.
        }
        if (attempt === 0 && isViolation(err, UNIQUE_VIOLATION, /duplicate key|unique constraint/i)) {
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
    throw new Error('unreachable run replacement state');
  }

  // Retention: a player keeps their newest RUN_HISTORY_LIMIT runs and nothing
  // older. Accepted scores live on in score_submissions regardless.
  async function pruneUserRunsWith(queryable, userId, keep) {
    // The row at offset keep-1 is the oldest run worth keeping; everything
    // strictly older than it goes.
    const { rows } = await queryable.query(
      `SELECT issued_at FROM runs
       WHERE user_id = $1
       ORDER BY issued_at DESC, id DESC
       OFFSET $2 LIMIT 1`,
      [userId, Math.max(0, keep - 1)],
    );
    if (rows.length === 0) return 0;
    const result = await queryable.query(
      'DELETE FROM runs WHERE user_id = $1 AND issued_at < $2',
      [userId, rows[0].issued_at],
    );
    return result.rowCount || 0;
  }

  async function pruneUserRuns(userId, keep = RUN_HISTORY_LIMIT) {
    return pruneUserRunsWith(pool, userId, keep);
  }

  async function listRuns(userId, limit = RUN_HISTORY_LIMIT) {
    const { rows } = await pool.query(
      `SELECT mode, outcome, time_ms, fail_reason, issued_at, chase_started_at
       FROM runs
       WHERE user_id = $1
       ORDER BY issued_at DESC, id DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map(mapRunHistory);
  }

  // Lifetime wins, counted from the submission ledger, which is never pruned.
  async function countWins(userId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS n FROM score_submissions WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0].n);
  }

  async function getRun(runId) {
    const { rows } = await pool.query(
      `SELECT id, user_id, mode, issued_at, chase_started_at, chase_start_beats,
              beats, last_beat_at, beat_counter,
              challenge_seed, challenge_started_at, challenge_solved_at,
              challenge_count, challenge_solved_count, consumed, failed
       FROM runs WHERE id = $1`,
      [runId],
    );
    return mapRun(rows[0]);
  }

  // Stamps the phase boundary once, on the server's clock. A second attempt
  // cannot move it, so a client cannot shorten its own flappy phase or restart
  // its chase clock.
  async function stampChaseStart(runId, now) {
    const { rows } = await pool.query(
      `UPDATE runs SET chase_started_at = $2, chase_start_beats = beats
       WHERE id = $1 AND chase_started_at IS NULL AND consumed = false AND failed = false
       RETURNING chase_started_at, chase_start_beats`,
      [runId, now],
    );
    return rows.length > 0;
  }

  // Opens the one server-witnessed visual challenge. A duplicate start while
  // it is open is harmless and does not reset its timer; once solved, no later
  // request can reopen it or replace the timestamps scoring will validate.
  async function startChallenge(runId, userId, challengeSeed, now) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT twitch_id, challenge_retry_after
         FROM users WHERE twitch_id = $1 FOR UPDATE`,
        [userId],
      );
      if (owner.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const retryAfterMs = toMs(owner.rows[0].challenge_retry_after);
      if (retryAfterMs !== null && retryAfterMs > now.getTime()) {
        await client.query('ROLLBACK');
        return false;
      }
      const { rows } = await client.query(
        `UPDATE runs
         SET challenge_seed = $3,
             challenge_started_at = $4,
             challenge_solved_at = NULL,
             challenge_count = challenge_count + 1
         WHERE id = $1 AND user_id = $2
           AND consumed = false AND failed = false
           AND challenge_count = 0
           AND challenge_started_at IS NULL
           AND challenge_solved_at IS NULL
         RETURNING challenge_count`,
        [runId, userId, challengeSeed, now],
      );
      await client.query('COMMIT');
      return rows.length > 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // Completes exactly the challenge the API just validated. The count in the
  // predicate prevents a delayed or fabricated request from changing cycles.
  async function solveChallenge(runId, userId, challengeCount, now) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        'SELECT twitch_id FROM users WHERE twitch_id = $1 FOR UPDATE',
        [userId],
      );
      if (owner.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const { rows } = await client.query(
        `UPDATE runs
         SET challenge_solved_at = $4,
             challenge_solved_count = challenge_count
         WHERE id = $1 AND user_id = $2
           AND challenge_count = $3
           AND challenge_started_at IS NOT NULL
           AND challenge_solved_at IS NULL
           AND consumed = false AND failed = false
         RETURNING challenge_solved_count`,
        [runId, userId, challengeCount, now],
      );
      if (rows.length > 0) {
        await client.query(
          `UPDATE users
           SET challenge_fail_count = 0,
               challenge_fail_last_at = NULL,
               challenge_retry_after = NULL
           WHERE twitch_id = $1`,
          [userId],
        );
      }
      await client.query('COMMIT');
      return rows.length > 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // Credits a heartbeat only when the server's own clock says it is spaced far
  // enough from the last credited one, the run is still live, and the chain is
  // exactly where the caller claims. Every guard lives in the UPDATE predicate,
  // so two concurrent beats cannot both credit and cannot both advance the
  // chain: the row lock serialises them and the loser matches nothing.
  //
  // gapMs is the interval since the previous credited beat, or a negative
  // sentinel for the first beat of a run. It feeds observation-only jitter
  // telemetry and is never read back by any validation path.
  //
  // last_beat_at is assigned LAST: several expressions above read its previous
  // value, and not every Postgres-compatible engine evaluates a SET list
  // simultaneously.
  //
  // The gap parameter is cast to double precision at every use. Uncast, `$5 < 0`
  // let Postgres infer integer, so `$5 * $5` overflowed int4 at a gap of 46341 ms
  // and aborted the whole UPDATE - last_beat_at included. Browsers throttle a
  // background tab's timers to roughly one tick a minute, so an honest player who
  // switched tabs sent a 60000 ms gap, got a 500, and then failed every later beat
  // identically because last_beat_at never advanced: the run died. Telemetry that
  // is never read back by any validation path must never be able to break the
  // liveness write it rides along with.
  async function countBeat(runId, now, options) {
    const {
      minSpacingMs, maxAgeMs, expectedCounter, gapMs, allowUnspaced = false,
    } = options;
    const spacingCutoff = new Date(now.getTime() - minSpacingMs);
    const ageCutoff = new Date(now.getTime() - maxAgeMs);
    const { rows } = await pool.query(
      `UPDATE runs
       SET beats = beats + 1,
           beat_counter = beat_counter + 1,
           beat_gap_n = CASE WHEN $5::double precision < 0 THEN beat_gap_n ELSE beat_gap_n + 1 END,
           beat_gap_sum = CASE WHEN $5::double precision < 0
             THEN beat_gap_sum ELSE beat_gap_sum + $5::double precision END,
           beat_gap_sq = CASE WHEN $5::double precision < 0
             THEN beat_gap_sq ELSE beat_gap_sq + ($5::double precision * $5::double precision) END,
           last_beat_at = $2
       WHERE id = $1
         AND consumed = false
         AND failed = false
         AND issued_at > $3
         AND beat_counter = $6
         AND ($7 = true OR last_beat_at IS NULL OR last_beat_at <= $4)
       RETURNING beats, beat_counter`,
      [runId, now, ageCutoff, spacingCutoff, gapMs, expectedCounter, allowUnspaced],
    );
    if (rows.length === 0) return { counted: false };
    return {
      counted: true,
      beats: Number(rows[0].beats),
      counter: Number(rows[0].beat_counter),
    };
  }

  // Observation only (V3.4 rule 5). Humans are noisy, naive bots are
  // metronomes; this is recorded for the owner to look at and is deliberately
  // not wired into any accept or reject decision.
  async function beatTelemetry(runId) {
    const { rows } = await pool.query(
      'SELECT beat_gap_n, beat_gap_sum, beat_gap_sq FROM runs WHERE id = $1',
      [runId],
    );
    if (rows.length === 0) return null;
    const n = Number(rows[0].beat_gap_n);
    if (n === 0) return { count: 0, meanMs: null, stddevMs: null };
    const sum = Number(rows[0].beat_gap_sum);
    const sq = Number(rows[0].beat_gap_sq);
    const mean = sum / n;
    const variance = Math.max(0, sq / n - mean * mean);
    return { count: n, meanMs: mean, stddevMs: Math.sqrt(variance) };
  }

  // One row per rejected request. Writing it must never break the response, so
  // every caller treats a failure here as nothing worse than a missing note.
  //
  // The payload was the one field with no ceiling, and it is the only one an
  // attacker writes directly: it is the claimed game numbers, but several fail()
  // sites hand it the raw request body. Oversize notes are replaced rather than
  // sliced, because the column is jsonb and half a serialized object is not
  // valid JSON - the head is kept as a string so the trail still shows what was
  // sent.
  function boundedPayload(value) {
    const serialized = JSON.stringify(value === undefined ? {} : value);
    if (typeof serialized !== 'string') return JSON.stringify({});
    if (serialized.length <= MAX_PAYLOAD) return serialized;
    return JSON.stringify({
      truncated: true,
      length: serialized.length,
      head: clamp(serialized, MAX_PAYLOAD),
    });
  }

  async function recordRejection(entry, now) {
    await pool.query(
      `INSERT INTO rejections (user_id, ip_hash, endpoint, reason, payload, at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId || null,
        entry.ipHash || null,
        clamp(entry.endpoint, MAX_TEXT),
        clamp(entry.reason, MAX_TEXT),
        boundedPayload(entry.payload),
        now,
      ],
    );
  }

  // Retention for the audit trail. Without it the table only ever grows, and a
  // flood of cheap rejections becomes a disk-exhaustion attack on the whole
  // service.
  async function pruneRejections(now, retentionMs = REJECTION_RETENTION_MS) {
    const cutoff = new Date(now.getTime() - retentionMs);
    const result = await pool.query('DELETE FROM rejections WHERE at < $1', [cutoff]);
    return result.rowCount || 0;
  }

  async function countRejections(reason) {
    const { rows } = reason === undefined
      ? await pool.query('SELECT COUNT(*) AS n FROM rejections')
      : await pool.query('SELECT COUNT(*) AS n FROM rejections WHERE reason = $1', [reason]);
    return Number(rows[0].n);
  }

  // Failures are counted from run rows the server issued: a run that never
  // becomes an accepted score is a failure. Closing it flips `failed`, so it
  // can only ever be counted once.
  //
  // Two lifetime counters move together: every failure raises the total, and a
  // failure that had reached the chase also raises the chase count. A run
  // abandoned during the flappy gauntlet raises only the total.
  async function addFailCounts(userId, totals, queryable = pool) {
    if (totals.total <= 0) return;
    await queryable.query(
      `UPDATE users
       SET runs_failed_total = runs_failed_total + $2,
           chase_fails = chase_fails + $3
       WHERE twitch_id = $1`,
      [userId, totals.total, totals.chase],
    );
  }

  function toFailure(row) {
    return {
      runId: row.id,
      userId: row.user_id,
      mode: row.mode,
      failReason: row.fail_reason === undefined ? null : row.fail_reason,
      phase: row.chase_started_at === null || row.chase_started_at === undefined
        ? 'flappy'
        : 'chase',
    };
  }

  async function applyFailCounts(failures, queryable = pool) {
    const tally = new Map();
    for (const failure of failures) {
      const current = tally.get(failure.userId) || { total: 0, chase: 0 };
      current.total += 1;
      if (failure.phase === 'chase') current.chase += 1;
      tally.set(failure.userId, current);
    }
    for (const [userId, totals] of tally) {
      await addFailCounts(userId, totals, queryable);
    }
  }

  async function closeRunsAndCount(sql, params) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(sql, params);
      const failures = rows.map(toFailure);
      await applyFailCounts(failures, client);
      await client.query('COMMIT');
      return failures;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Called before a user opens a new run: whatever they left open is over.
  // This is also what enforces one open run per user.
  async function failOpenRunsForUser(userId) {
    return closeRunsAndCount(
      `UPDATE runs SET failed = true, outcome = 'failed'
       WHERE user_id = $1 AND consumed = false AND failed = false
       RETURNING id, user_id, mode, fail_reason, chase_started_at`,
      [userId],
    );
  }

  // Sweep for players who closed the tab: no heartbeat for RUN_STALE_MS.
  async function failStaleRuns(now, staleMs = RUN_STALE_MS) {
    const cutoff = new Date(now.getTime() - staleMs);
    return closeRunsAndCount(
      `UPDATE runs SET failed = true, outcome = 'failed'
       WHERE consumed = false
         AND failed = false
         AND COALESCE(last_beat_at, issued_at) < $1
       RETURNING id, user_id, mode, fail_reason, chase_started_at`,
      [cutoff],
    );
  }

  // A ban is the client's word for why a run ended. It colours the feed and the
  // player's history and can never touch a leaderboard row. When the run it
  // lands on is still open, closing it here is what makes the failure stream
  // immediately instead of waiting for the stale sweep.
  async function applyBan(userId, runId, reason, options = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT twitch_id, challenge_fail_count, challenge_fail_last_at
         FROM users WHERE twitch_id = $1 FOR UPDATE`,
        [userId],
      );
      if (owner.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const closed = await client.query(
        `UPDATE runs SET failed = true, outcome = 'failed', fail_reason = $2
         WHERE id = $1 AND user_id = $3 AND consumed = false AND failed = false
         RETURNING id, user_id, mode, fail_reason, chase_started_at`,
        [runId, reason, userId],
      );
      const failure = closed.rows.length > 0 ? toFailure(closed.rows[0]) : null;
      if (failure) await applyFailCounts([failure], client);

      const failedAt = options.challengeFailureAt;
      if (failedAt instanceof Date && Number.isFinite(failedAt.getTime())) {
        // This marker belongs to the server-observed answer, not the client's
        // cosmetic ban event. It makes a concurrent/duplicate report count at
        // most once even if that report happened to close the run first.
        const counted = await client.query(
          `UPDATE runs SET challenge_failure_counted = true
           WHERE id = $1 AND user_id = $2
             AND failed = true
             AND challenge_count = 1
             AND challenge_started_at IS NOT NULL
             AND challenge_failure_counted = false
           RETURNING id`,
          [runId, userId],
        );
        if (counted.rows.length > 0) {
          const previousAtMs = toMs(owner.rows[0].challenge_fail_last_at);
          const previousCount = Number(owner.rows[0].challenge_fail_count || 0);
          const quiet = previousAtMs === null
            || failedAt.getTime() - previousAtMs > CHALLENGE_RETRY_RESET_MS;
          const failureCount = quiet ? 1 : previousCount + 1;
          const delay = CHALLENGE_RETRY_DELAYS_MS[
            Math.min(failureCount - 1, CHALLENGE_RETRY_DELAYS_MS.length - 1)
          ];
          await client.query(
            `UPDATE users
             SET challenge_fail_count = $2,
                 challenge_fail_last_at = $3,
                 challenge_retry_after = $4
             WHERE twitch_id = $1`,
            [userId, failureCount, failedAt, new Date(failedAt.getTime() + delay)],
          );
        }
      }

      // The named run was already closed by the sweep or by a replacement;
      // only its reason is new. Binding this update to the run id is critical:
      // a late event from an old attempt must never select the newer open run.
      //
      // fail_reason IS NULL is what keeps this a labelling step rather than an
      // overwrite. The sweep and failOpenRunsForUser close a run without naming
      // a reason, which is the only case that wants a name later. A run the
      // server itself closed already carries the server's verdict, and without
      // this guard a player closed with 'clock-forgery' or 'captcha-fail' could
      // POST /api/event {type:'ban',reason:'timeout'} for that run id and
      // relabel the public record of their own cheating.
      await client.query(
        `UPDATE runs SET fail_reason = $2
         WHERE id = $1 AND user_id = $3 AND consumed = false AND failed = true
           AND fail_reason IS NULL`,
        [runId, reason, userId],
      );
      await client.query('COMMIT');
      return failure;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Flappy deaths happen before a run exists, so they are client-reported.
  // Purely cosmetic: nothing on the leaderboard depends on this number.
  async function incrementFlappyFails(userId) {
    const { rows } = await pool.query(
      'UPDATE users SET flappy_fails = flappy_fails + 1 WHERE twitch_id = $1 RETURNING flappy_fails',
      [userId],
    );
    return rows.length > 0 ? Number(rows[0].flappy_fails) : null;
  }

  // The single write path to the leaderboard, in one transaction:
  //   1. burn the run token (a lost race means somebody already scored it)
  //   2. record the submission, whose primary key is the run token, so the
  //      database refuses a second score for the same run even under a race
  //   3. replace the record only when this time is strictly better
  //   4. read the standing record back inside the same transaction
  async function submitScore(entry, now) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const burned = await client.query(
        `UPDATE runs SET consumed = true, outcome = 'won', time_ms = $2
         WHERE id = $1 AND consumed = false AND failed = false
         RETURNING id`,
        [entry.runId, entry.timeMs],
      );
      if (burned.rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'run_consumed' };
      }

      try {
        await client.query(
          `INSERT INTO score_submissions
             (run_id, user_id, mode, time_ms, misses, near_misses, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.runId, entry.userId, entry.mode, entry.timeMs, entry.misses, entry.nearMisses, now],
        );

        // No UPDATE path except a strictly better time: when the WHERE fails,
        // the existing record is left exactly as it was.
        await client.query(
          `INSERT INTO scores (user_id, mode, time_ms, misses, near_misses, achieved_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, mode) DO UPDATE SET
             time_ms = EXCLUDED.time_ms,
             misses = EXCLUDED.misses,
             near_misses = EXCLUDED.near_misses,
             achieved_at = EXCLUDED.achieved_at
           WHERE EXCLUDED.time_ms < scores.time_ms`,
          [entry.userId, entry.mode, entry.timeMs, entry.misses, entry.nearMisses, now],
        );
      } catch (err) {
        await client.query('ROLLBACK');
        if (isViolation(err, UNIQUE_VIOLATION, /duplicate key|unique constraint/i)) {
          return { ok: false, code: 'run_consumed' };
        }
        if (isViolation(err, CHECK_VIOLATION, /check constraint/i)) {
          return { ok: false, code: 'time_out_of_range' };
        }
        throw err;
      }

      const { rows } = await client.query(
        `SELECT time_ms, misses, near_misses, achieved_at
         FROM scores WHERE user_id = $1 AND mode = $2`,
        [entry.userId, entry.mode],
      );
      const best = mapScore(rows[0]);
      // Rank is part of the committed response, so compute it before COMMIT.
      // A failure here rolls the score back instead of returning a 500 after
      // the run has already been irreversibly consumed.
      const rank = await rankWith(
        client, entry.userId, entry.mode, best.timeMs, best.achievedAt,
      );
      await client.query('COMMIT');
      return { ok: true, best, rank };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already unusable; the release below discards it.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Rank ordering matches the leaderboard ordering exactly:
  // time ascending, then earliest achievement, then user id.
  async function rankWith(queryable, userId, mode, timeMs, achievedAt) {
    const { rows } = await queryable.query(
      `SELECT COUNT(*) AS better FROM scores
       WHERE mode = $1
         AND (time_ms < $2
              OR (time_ms = $2 AND achieved_at < $3)
              OR (time_ms = $2 AND achieved_at = $3 AND user_id < $4))`,
      [mode, timeMs, achievedAt, userId],
    );
    return Number(rows[0].better) + 1;
  }

  async function rankOf(userId, mode, timeMs, achievedAt) {
    return rankWith(pool, userId, mode, timeMs, achievedAt);
  }

  async function getScore(userId, mode) {
    const { rows } = await pool.query(
      `SELECT time_ms, misses, near_misses, misses + 1 AS clicks, achieved_at
       FROM scores WHERE user_id = $1 AND mode = $2`,
      [userId, mode],
    );
    return mapScore(rows[0]);
  }

  // Read-only SELECT. There is no endpoint anywhere that deletes or edits a
  // leaderboard row.
  async function topScores(mode, limit = LEADERBOARD_LIMIT) {
    const { rows } = await pool.query(
      `SELECT s.user_id, u.display_name, u.avatar_url,
              u.flappy_fails, u.chase_fails, u.runs_failed_total,
              s.time_ms, s.misses, s.near_misses, s.misses + 1 AS clicks, s.achieved_at
       FROM scores s
       JOIN users u ON u.twitch_id = s.user_id
       WHERE s.mode = $1
       ORDER BY s.time_ms ASC, s.achieved_at ASC, s.user_id ASC
       LIMIT $2`,
      [mode, limit],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      flappyFails: Number(row.flappy_fails || 0),
      chaseFails: Number(row.chase_fails || 0),
      totalFails: Number(row.runs_failed_total || 0),
      timeMs: Number(row.time_ms),
      misses: Number(row.misses),
      nearMisses: Number(row.near_misses),
      clicks: Number(row.clicks),
      achievedAt: new Date(row.achieved_at),
    }));
  }

  // V3.8: the stats board. Every signed-in player who ever ran, with the same
  // public fields the leaderboard and player card already show -- nothing new
  // leaves the building, it is just all in one place. Sorting is the client's
  // job; the order here only decides who makes the cut at the cap.
  async function allPlayerStats(limit = STATS_LIMIT) {
    const { rows } = await pool.query(
      `SELECT u.twitch_id, u.display_name, u.avatar_url,
              u.flappy_fails, u.chase_fails, u.runs_failed_total,
              p.time_ms AS best_practice_ms,
              s.time_ms AS best_sim_ms,
              COALESCE(w.n, 0) AS wins
       FROM users u
       LEFT JOIN scores p ON p.user_id = u.twitch_id AND p.mode = 'practice'
       LEFT JOIN scores s ON s.user_id = u.twitch_id AND s.mode = 'simulation'
       LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM score_submissions GROUP BY user_id) w
              ON w.user_id = u.twitch_id
       ORDER BY u.runs_failed_total DESC, u.twitch_id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      userId: row.twitch_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      flappyFails: Number(row.flappy_fails || 0),
      chaseFails: Number(row.chase_fails || 0),
      totalFails: Number(row.runs_failed_total || 0),
      wins: Number(row.wins || 0),
      bestPracticeMs: row.best_practice_ms === null ? null : Number(row.best_practice_ms),
      bestSimMs: row.best_sim_ms === null ? null : Number(row.best_sim_ms),
    }));
  }

  // V3.7: the feed's replay buffer, persisted so a deploy does not empty the
  // activity log. Writes are fire-and-forget from the feed's point of view;
  // the prune keeps the table at roughly the retention cap and nothing more.
  async function saveFeedEvent(id, type, data) {
    await pool.query(
      'INSERT INTO feed_events (id, type, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, type, JSON.stringify(data)],
    );
    await pool.query('DELETE FROM feed_events WHERE id <= $1', [id - FEED_RETENTION]);
  }

  async function recentFeedEvents(limit) {
    const { rows } = await pool.query(
      'SELECT id, type, data FROM feed_events ORDER BY id DESC LIMIT $1',
      [limit],
    );
    // Newest-first out of the index, oldest-first for replay.
    return rows.reverse().map((row) => ({
      id: Number(row.id),
      type: row.type,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    }));
  }

  return {
    upsertUser,
    getUser,
    getChallengeRetry,
    getUsers,
    createRun,
    replaceOpenRun,
    getRun,
    listRuns,
    pruneUserRuns,
    countWins,
    stampChaseStart,
    startChallenge,
    solveChallenge,
    countBeat,
    beatTelemetry,
    recordRejection,
    pruneRejections,
    countRejections,
    getSessionEpoch,
    bumpSessionEpoch,
    submitScore,
    rankOf,
    getScore,
    topScores,
    addFailCounts,
    failOpenRunsForUser,
    failStaleRuns,
    applyBan,
    incrementFlappyFails,
    saveFeedEvent,
    recentFeedEvents,
    allPlayerStats,
  };
}

module.exports = {
  createStore,
  LEADERBOARD_LIMIT,
  RUN_HISTORY_LIMIT,
  RUN_STALE_MS,
  REJECTION_RETENTION_MS,
  CHALLENGE_RETRY_DELAYS_MS,
  CHALLENGE_RETRY_RESET_MS,
};
