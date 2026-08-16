'use strict';

const { newRunToken } = require('./validation');

// Data access. Every query is parameterised - no request value is ever
// concatenated into SQL. The pool is injected so tests can drive an in-memory
// Postgres instead of a live one.

const MAX_TEXT = 200;
const MAX_URL = 512;
const LEADERBOARD_LIMIT = 50;
// Run history kept per player, oldest pruned on insert.
const RUN_HISTORY_LIMIT = 100;
// A run with no heartbeat for this long has been abandoned: the client beats
// every five seconds while a run is alive.
const RUN_STALE_MS = 90 * 1000;
// The audit trail is for watching live attacks, not for keeping forever.
const REJECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

  // Retention: a player keeps their newest RUN_HISTORY_LIMIT runs and nothing
  // older. Accepted scores live on in score_submissions regardless.
  async function pruneUserRuns(userId, keep = RUN_HISTORY_LIMIT) {
    // The row at offset keep-1 is the oldest run worth keeping; everything
    // strictly older than it goes.
    const { rows } = await pool.query(
      `SELECT issued_at FROM runs
       WHERE user_id = $1
       ORDER BY issued_at DESC, id DESC
       OFFSET $2 LIMIT 1`,
      [userId, Math.max(0, keep - 1)],
    );
    if (rows.length === 0) return 0;
    const result = await pool.query(
      'DELETE FROM runs WHERE user_id = $1 AND issued_at < $2',
      [userId, rows[0].issued_at],
    );
    return result.rowCount || 0;
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
      `SELECT id, user_id, mode, issued_at, chase_started_at, beats, last_beat_at,
              beat_counter, consumed, failed
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
      `UPDATE runs SET chase_started_at = $2
       WHERE id = $1 AND chase_started_at IS NULL AND consumed = false AND failed = false
       RETURNING chase_started_at`,
      [runId, now],
    );
    return rows.length > 0;
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
  async function countBeat(runId, now, options) {
    const { minSpacingMs, maxAgeMs, expectedCounter, gapMs } = options;
    const spacingCutoff = new Date(now.getTime() - minSpacingMs);
    const ageCutoff = new Date(now.getTime() - maxAgeMs);
    const { rows } = await pool.query(
      `UPDATE runs
       SET beats = beats + 1,
           beat_counter = beat_counter + 1,
           beat_gap_n = CASE WHEN $5 < 0 THEN beat_gap_n ELSE beat_gap_n + 1 END,
           beat_gap_sum = CASE WHEN $5 < 0 THEN beat_gap_sum ELSE beat_gap_sum + $5 END,
           beat_gap_sq = CASE WHEN $5 < 0 THEN beat_gap_sq ELSE beat_gap_sq + ($5 * $5) END,
           last_beat_at = $2
       WHERE id = $1
         AND consumed = false
         AND failed = false
         AND issued_at > $3
         AND beat_counter = $6
         AND (last_beat_at IS NULL OR last_beat_at <= $4)
       RETURNING beats, beat_counter`,
      [runId, now, ageCutoff, spacingCutoff, gapMs, expectedCounter],
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
  async function recordRejection(entry, now) {
    await pool.query(
      `INSERT INTO rejections (user_id, ip_hash, endpoint, reason, payload, at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId || null,
        entry.ipHash || null,
        clamp(entry.endpoint, MAX_TEXT),
        clamp(entry.reason, MAX_TEXT),
        JSON.stringify(entry.payload === undefined ? {} : entry.payload),
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
  async function addFailCounts(userId, totals) {
    if (totals.total <= 0) return;
    await pool.query(
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

  async function applyFailCounts(failures) {
    const tally = new Map();
    for (const failure of failures) {
      const current = tally.get(failure.userId) || { total: 0, chase: 0 };
      current.total += 1;
      if (failure.phase === 'chase') current.chase += 1;
      tally.set(failure.userId, current);
    }
    for (const [userId, totals] of tally) {
      await addFailCounts(userId, totals);
    }
  }

  // Called before a user opens a new run: whatever they left open is over.
  // This is also what enforces one open run per user.
  async function failOpenRunsForUser(userId) {
    const { rows } = await pool.query(
      `UPDATE runs SET failed = true, outcome = 'failed'
       WHERE user_id = $1 AND consumed = false AND failed = false
       RETURNING id, user_id, mode, fail_reason, chase_started_at`,
      [userId],
    );
    const failures = rows.map(toFailure);
    await applyFailCounts(failures);
    return failures;
  }

  // Sweep for players who closed the tab: no heartbeat for RUN_STALE_MS.
  async function failStaleRuns(now, staleMs = RUN_STALE_MS) {
    const cutoff = new Date(now.getTime() - staleMs);
    const { rows } = await pool.query(
      `UPDATE runs SET failed = true, outcome = 'failed'
       WHERE consumed = false
         AND failed = false
         AND COALESCE(last_beat_at, issued_at) < $1
       RETURNING id, user_id, mode, fail_reason, chase_started_at`,
      [cutoff],
    );
    const failures = rows.map(toFailure);
    await applyFailCounts(failures);
    return failures;
  }

  // A ban is the client's word for why a run ended. It colours the feed and the
  // player's history and can never touch a leaderboard row. When the run it
  // lands on is still open, closing it here is what makes the failure stream
  // immediately instead of waiting for the stale sweep.
  async function applyBan(userId, reason, now) {
    const { rows } = await pool.query(
      `SELECT id, outcome FROM runs
       WHERE user_id = $1 AND consumed = false AND outcome IN ('open', 'failed')
       ORDER BY CASE WHEN outcome = 'open' THEN 0 ELSE 1 END, issued_at DESC, id DESC
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;

    const closed = await pool.query(
      `UPDATE runs SET failed = true, outcome = 'failed', fail_reason = $2
       WHERE id = $1 AND consumed = false AND failed = false
       RETURNING id, user_id, mode, fail_reason, chase_started_at`,
      [rows[0].id, reason],
    );
    if (closed.rows.length > 0) {
      const failure = toFailure(closed.rows[0]);
      await applyFailCounts([failure]);
      return failure;
    }

    // The run was already closed by the sweep or by a new run; only the reason
    // is new, so nothing is counted twice and nothing is streamed twice.
    await pool.query(
      'UPDATE runs SET fail_reason = $2 WHERE id = $1 AND consumed = false',
      [rows[0].id, reason],
    );
    return null;
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
      await client.query('COMMIT');
      return { ok: true, best: mapScore(rows[0]) };
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
  async function rankOf(userId, mode, timeMs, achievedAt) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS better FROM scores
       WHERE mode = $1
         AND (time_ms < $2
              OR (time_ms = $2 AND achieved_at < $3)
              OR (time_ms = $2 AND achieved_at = $3 AND user_id < $4))`,
      [mode, timeMs, achievedAt, userId],
    );
    return Number(rows[0].better) + 1;
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

  return {
    upsertUser,
    getUser,
    getUsers,
    createRun,
    getRun,
    listRuns,
    pruneUserRuns,
    countWins,
    stampChaseStart,
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
  };
}

module.exports = {
  createStore,
  LEADERBOARD_LIMIT,
  RUN_HISTORY_LIMIT,
  RUN_STALE_MS,
  REJECTION_RETENTION_MS,
};
