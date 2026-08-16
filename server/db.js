'use strict';

const { Pool } = require('pg');

// Every statement in this file is either DDL or parameterised; no SQL string is
// ever built from request data.
//
// The CHECK constraints are deliberate belt and braces: the application already
// refuses these values, and the database refuses them again.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     twitch_id    text PRIMARY KEY,
     login        text NOT NULL,
     display_name text NOT NULL,
     avatar_url   text NOT NULL DEFAULT '',
     created_at   timestamptz NOT NULL,
     last_login   timestamptz NOT NULL,
     flappy_fails integer NOT NULL DEFAULT 0,
     chase_fails  integer NOT NULL DEFAULT 0,
     runs_failed_total integer NOT NULL DEFAULT 0,
     session_epoch integer NOT NULL DEFAULT 0,
     challenge_fail_count integer NOT NULL DEFAULT 0,
     challenge_fail_last_at timestamptz,
     challenge_retry_after timestamptz,
     CONSTRAINT users_counters_ck CHECK (
       flappy_fails >= 0 AND chase_fails >= 0
       AND runs_failed_total >= 0 AND session_epoch >= 0
       AND challenge_fail_count >= 0
       AND (
         (challenge_fail_count = 0
          AND challenge_fail_last_at IS NULL AND challenge_retry_after IS NULL)
         OR
         (challenge_fail_count > 0
          AND challenge_fail_last_at IS NOT NULL AND challenge_retry_after IS NOT NULL
          AND challenge_retry_after >= challenge_fail_last_at)
       )
     )
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id               text PRIMARY KEY,
     user_id          text NOT NULL REFERENCES users(twitch_id) ON DELETE CASCADE,
     mode             text NOT NULL,
     issued_at        timestamptz NOT NULL,
     chase_started_at timestamptz,
     chase_start_beats integer NOT NULL DEFAULT 0,
     beats            integer NOT NULL DEFAULT 0,
     last_beat_at     timestamptz,
     beat_counter     integer NOT NULL DEFAULT 0,
     beat_gap_n       integer NOT NULL DEFAULT 0,
     beat_gap_sum     double precision NOT NULL DEFAULT 0,
     beat_gap_sq      double precision NOT NULL DEFAULT 0,
     challenge_started_at timestamptz,
     challenge_solved_at timestamptz,
     challenge_count integer NOT NULL DEFAULT 0,
     challenge_solved_count integer NOT NULL DEFAULT 0,
     challenge_seed text,
     challenge_failure_counted boolean NOT NULL DEFAULT false,
     consumed         boolean NOT NULL DEFAULT false,
     failed           boolean NOT NULL DEFAULT false,
     outcome          text NOT NULL DEFAULT 'open',
     time_ms          integer,
     fail_reason      text,
     CONSTRAINT runs_mode_ck CHECK (mode IN ('practice', 'simulation', 'impossible')),
     CONSTRAINT runs_outcome_ck CHECK (outcome IN ('open', 'won', 'failed')),
     CONSTRAINT runs_counters_ck CHECK (
       beats >= 0 AND beat_counter = beats
       AND chase_start_beats >= 0 AND chase_start_beats <= beats
       AND beat_gap_n >= 0
       AND challenge_count >= 0 AND challenge_count <= 1
       AND challenge_solved_count >= 0
       AND challenge_solved_count <= challenge_count
       AND (challenge_failure_counted = false OR (challenge_count = 1 AND failed = true))
       AND (
         (challenge_count = 0 AND challenge_solved_count = 0
          AND challenge_started_at IS NULL AND challenge_solved_at IS NULL
          AND challenge_seed IS NULL)
         OR
         (challenge_count = 1 AND challenge_started_at IS NOT NULL
          AND challenge_seed IS NOT NULL AND (
           (challenge_solved_at IS NULL
            AND challenge_solved_count = challenge_count - 1)
           OR
           (challenge_solved_at IS NOT NULL
            AND challenge_solved_count = challenge_count)
         ))
       )
     ),
     CONSTRAINT runs_state_ck CHECK (
       (outcome = 'open' AND consumed = false AND failed = false AND time_ms IS NULL)
       OR (outcome = 'won' AND consumed = true AND failed = false AND time_ms IS NOT NULL)
       OR (outcome = 'failed' AND consumed = false AND failed = true AND time_ms IS NULL)
     )
   )`,
  `CREATE TABLE IF NOT EXISTS scores (
     user_id     text NOT NULL REFERENCES users(twitch_id) ON DELETE CASCADE,
     mode        text NOT NULL,
     time_ms     integer NOT NULL,
     misses      integer NOT NULL,
     near_misses integer NOT NULL,
     achieved_at timestamptz NOT NULL,
     PRIMARY KEY (user_id, mode),
     CONSTRAINT scores_mode_ck CHECK (mode IN ('practice', 'simulation', 'impossible')),
     CONSTRAINT scores_time_ck CHECK (
       time_ms > 0 AND time_ms <= 7200000
       AND (mode NOT IN ('simulation', 'impossible') OR time_ms <= 61000)
     ),
     CONSTRAINT scores_counters_ck CHECK (
       misses >= 0 AND misses <= 10000
       AND near_misses >= 0 AND near_misses <= 10000
     )
   )`,
  // One row per accepted submission. The primary key is the run token, so the
  // database itself guarantees a run can be scored at most once.
  `CREATE TABLE IF NOT EXISTS score_submissions (
     run_id      text PRIMARY KEY,
     user_id     text NOT NULL,
     mode        text NOT NULL,
     time_ms     integer NOT NULL,
     misses      integer NOT NULL,
     near_misses integer NOT NULL,
     created_at  timestamptz NOT NULL,
     CONSTRAINT score_submissions_user_fk FOREIGN KEY (user_id)
       REFERENCES users(twitch_id) ON DELETE CASCADE,
     CONSTRAINT score_submissions_mode_ck CHECK (mode IN ('practice', 'simulation', 'impossible')),
     CONSTRAINT score_submissions_time_ck CHECK (
       time_ms > 0 AND time_ms <= 7200000
       AND (mode NOT IN ('simulation', 'impossible') OR time_ms <= 61000)
     ),
     CONSTRAINT score_submissions_counters_ck CHECK (
       misses >= 0 AND misses <= 10000
       AND near_misses >= 0 AND near_misses <= 10000
     )
   )`,
  // Attack audit trail: one row per rejected request. Never read by any
  // endpoint - it exists so the owner can watch the cheating attempts pile up.
  // The address is stored only as a keyed hash, and the payload holds the
  // claimed game numbers, never a cookie, header or token.
  `CREATE TABLE IF NOT EXISTS rejections (
     id       bigserial PRIMARY KEY,
     user_id  text,
     ip_hash  text,
     endpoint text NOT NULL,
     reason   text NOT NULL,
     payload  jsonb,
     at       timestamptz NOT NULL
   )`,
  // V3.7: the live feed's replay buffer, so a deploy no longer greets every
  // page with an empty log. The id comes from the feed's own counter (seeded
  // from MAX(id) at boot), which keeps SSE event ids monotonic across
  // restarts; `at` lives inside data alongside everything else the line shows.
  `CREATE TABLE IF NOT EXISTS feed_events (
     id   bigint PRIMARY KEY,
     type text NOT NULL,
     data jsonb NOT NULL
   )`,
  // Forward migrations for databases created before these columns existed.
  // Harmless on a fresh schema.
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS runs_failed_total integer NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_fail_count integer NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_fail_last_at timestamptz',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_retry_after timestamptz',
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'open'`,
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS time_ms integer',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS fail_reason text',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_counter integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_gap_n integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_gap_sum double precision NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_gap_sq double precision NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS challenge_started_at timestamptz',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS challenge_solved_at timestamptz',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS challenge_count integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS challenge_solved_count integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS challenge_seed text',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS challenge_failure_counted boolean NOT NULL DEFAULT false',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS flappy_fails integer NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS chase_fails integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS failed boolean NOT NULL DEFAULT false',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS chase_started_at timestamptz',
  // Snapshot of credited beats at the phase boundary. Existing simulation runs
  // receive zero and therefore fail the Flappy-liveness check closed; new runs
  // stamp the actual count atomically with chase_started_at.
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS chase_start_beats integer NOT NULL DEFAULT 0',
  // Lifecycle and counters are server-owned, but constraints make a future
  // internal writer fail closed instead of creating a row validation trusts.
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_counters_ck;
   ALTER TABLE users ADD CONSTRAINT users_counters_ck CHECK (
     flappy_fails >= 0 AND chase_fails >= 0
     AND runs_failed_total >= 0 AND session_epoch >= 0
     AND challenge_fail_count >= 0
     AND (
       (challenge_fail_count = 0
        AND challenge_fail_last_at IS NULL AND challenge_retry_after IS NULL)
       OR
       (challenge_fail_count > 0
        AND challenge_fail_last_at IS NOT NULL AND challenge_retry_after IS NOT NULL
        AND challenge_retry_after >= challenge_fail_last_at)
     )
   )`,
  `ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_counters_ck;
   ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_state_ck;
   ALTER TABLE runs ADD CONSTRAINT runs_counters_ck CHECK (
     beats >= 0 AND beat_counter = beats
     AND chase_start_beats >= 0 AND chase_start_beats <= beats
     AND beat_gap_n >= 0
     AND challenge_count >= 0 AND challenge_count <= 1
     AND challenge_solved_count >= 0
     AND challenge_solved_count <= challenge_count
     AND (challenge_failure_counted = false OR (challenge_count = 1 AND failed = true))
     AND (
       (challenge_count = 0 AND challenge_solved_count = 0
        AND challenge_started_at IS NULL AND challenge_solved_at IS NULL
        AND challenge_seed IS NULL)
       OR
       (challenge_count = 1 AND challenge_started_at IS NOT NULL
        AND challenge_seed IS NOT NULL AND (
         (challenge_solved_at IS NULL
          AND challenge_solved_count = challenge_count - 1)
         OR
         (challenge_solved_at IS NOT NULL
          AND challenge_solved_count = challenge_count)
       ))
     )
   );
   ALTER TABLE runs ADD CONSTRAINT runs_state_ck CHECK (
     (outcome = 'open' AND consumed = false AND failed = false AND time_ms IS NULL)
     OR (outcome = 'won' AND consumed = true AND failed = false AND time_ms IS NOT NULL)
     OR (outcome = 'failed' AND consumed = false AND failed = true AND time_ms IS NULL)
   )`,
  // V3.11: near-miss counts are display telemetry, not proof. A real one-pass
  // approach may report fewer than three, while a forged request can claim any
  // number. Replace the old >=3 constraint without leaving duplicate variants.
  `ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_counters_ck;
   ALTER TABLE scores ADD CONSTRAINT scores_counters_ck CHECK (
     misses >= 0 AND misses <= 10000
     AND near_misses >= 0 AND near_misses <= 10000
   )`,
  // V4.0: the Impossible mode. Databases created before it exists carry the
  // two-mode CHECKs, which would refuse every Impossible row at the very
  // bottom of the stack. Same 61 s ceiling as Simulation: both clients run the
  // 60 s shot clock.
  `ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_mode_ck;
   ALTER TABLE runs ADD CONSTRAINT runs_mode_ck CHECK (
     mode IN ('practice', 'simulation', 'impossible')
   )`,
  `ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_mode_ck;
   ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_time_ck;
   ALTER TABLE scores ADD CONSTRAINT scores_mode_ck CHECK (
     mode IN ('practice', 'simulation', 'impossible')
   );
   ALTER TABLE scores ADD CONSTRAINT scores_time_ck CHECK (
     time_ms > 0 AND time_ms <= 7200000
     AND (mode NOT IN ('simulation', 'impossible') OR time_ms <= 61000)
   )`,
  // The immutable submission ledger is independently valid even if a future
  // internal writer bypasses the API and leaderboard table.
  `ALTER TABLE score_submissions
     DROP CONSTRAINT IF EXISTS score_submissions_user_fk;
   ALTER TABLE score_submissions
     DROP CONSTRAINT IF EXISTS score_submissions_mode_ck;
   ALTER TABLE score_submissions
     DROP CONSTRAINT IF EXISTS score_submissions_time_ck;
   ALTER TABLE score_submissions
     DROP CONSTRAINT IF EXISTS score_submissions_counters_ck;
   ALTER TABLE score_submissions
     ADD CONSTRAINT score_submissions_user_fk FOREIGN KEY (user_id)
       REFERENCES users(twitch_id) ON DELETE CASCADE;
   ALTER TABLE score_submissions
     ADD CONSTRAINT score_submissions_mode_ck CHECK (
       mode IN ('practice', 'simulation', 'impossible')
     );
   ALTER TABLE score_submissions
     ADD CONSTRAINT score_submissions_time_ck CHECK (
       time_ms > 0 AND time_ms <= 7200000
       AND (mode NOT IN ('simulation', 'impossible') OR time_ms <= 61000)
     );
   ALTER TABLE score_submissions
     ADD CONSTRAINT score_submissions_counters_ck CHECK (
       misses >= 0 AND misses <= 10000
       AND near_misses >= 0 AND near_misses <= 10000
     )`,
  // Serves both the per-player run history and the retention prune.
  'CREATE INDEX IF NOT EXISTS runs_user_issued_idx ON runs (user_id, issued_at)',
  'CREATE INDEX IF NOT EXISTS runs_issued_idx ON runs (issued_at)',
  // Serves the "still open" sweep: the equality prefix filters out every run
  // that has already been scored or already been counted as a failure.
  'CREATE INDEX IF NOT EXISTS runs_open_idx ON runs (consumed, failed, last_beat_at)',
  // The application also serialises replacement on the owning user row. This
  // index is the final database invariant if a caller ever skips that path.
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_one_open_per_user_idx
   ON runs ((CASE WHEN consumed = false AND failed = false THEN user_id ELSE NULL END))`,
  'CREATE INDEX IF NOT EXISTS scores_mode_time_idx ON scores (mode, time_ms, achieved_at)',
  'CREATE INDEX IF NOT EXISTS score_submissions_user_idx ON score_submissions (user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS rejections_at_idx ON rejections (at)',
  'CREATE INDEX IF NOT EXISTS rejections_reason_idx ON rejections (reason, at)',
];

function poolOptionsFor(databaseUrl) {
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  // Railway's production DATABASE_URL resolves to its private service network,
  // where the platform docs recommend direct service-to-service traffic. Public
  // database hosts use TLS with normal CA/hostname verification; it is never
  // acceptable to encrypt a public connection while trusting any certificate.
  const privateRailway = hostname.endsWith('.railway.internal');
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  const needsSsl = !privateRailway && !local;
  return {
    connectionString: databaseUrl,
    ssl: needsSsl ? { rejectUnauthorized: true } : false,
    enableChannelBinding: needsSsl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Acquiring a connection was bounded, but work on one was not. A blocked
    // DDL lock or stalled database could otherwise occupy all five clients
    // indefinitely and turn one lock into a full API outage.
    statement_timeout: 10000,
    query_timeout: 12000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 15000,
  };
}

function createPool(config) {
  return new Pool(poolOptionsFor(config.databaseUrl));
}

async function migrate(pool) {
  for (const statement of SCHEMA) {
    await pool.query(statement);
  }
}

// Boot-time migration with a short retry loop: Railway can start the app
// before Postgres finishes accepting connections.
async function migrateWithRetry(pool, { attempts = 5, delayMs = 2000, log = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await migrate(pool);
      return;
    } catch (err) {
      lastError = err;
      log(`migration attempt ${attempt}/${attempts} failed: ${err.code || err.message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

module.exports = { SCHEMA, poolOptionsFor, createPool, migrate, migrateWithRetry };
