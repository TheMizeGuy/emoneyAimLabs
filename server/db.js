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
     session_epoch integer NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id               text PRIMARY KEY,
     user_id          text NOT NULL REFERENCES users(twitch_id) ON DELETE CASCADE,
     mode             text NOT NULL,
     issued_at        timestamptz NOT NULL,
     chase_started_at timestamptz,
     beats            integer NOT NULL DEFAULT 0,
     last_beat_at     timestamptz,
     beat_counter     integer NOT NULL DEFAULT 0,
     beat_gap_n       integer NOT NULL DEFAULT 0,
     beat_gap_sum     double precision NOT NULL DEFAULT 0,
     beat_gap_sq      double precision NOT NULL DEFAULT 0,
     consumed         boolean NOT NULL DEFAULT false,
     failed           boolean NOT NULL DEFAULT false,
     outcome          text NOT NULL DEFAULT 'open',
     time_ms          integer,
     fail_reason      text,
     CONSTRAINT runs_mode_ck CHECK (mode IN ('practice', 'simulation')),
     CONSTRAINT runs_outcome_ck CHECK (outcome IN ('open', 'won', 'failed'))
   )`,
  `CREATE TABLE IF NOT EXISTS scores (
     user_id     text NOT NULL REFERENCES users(twitch_id) ON DELETE CASCADE,
     mode        text NOT NULL,
     time_ms     integer NOT NULL,
     misses      integer NOT NULL,
     near_misses integer NOT NULL,
     achieved_at timestamptz NOT NULL,
     PRIMARY KEY (user_id, mode),
     CONSTRAINT scores_mode_ck CHECK (mode IN ('practice', 'simulation')),
     CONSTRAINT scores_time_ck CHECK (
       time_ms > 0 AND time_ms <= 7200000
       AND (mode <> 'simulation' OR time_ms <= 61000)
     ),
     CONSTRAINT scores_counters_ck CHECK (
       misses >= 0 AND misses <= 10000
       AND near_misses >= 3 AND near_misses <= 10000
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
     created_at  timestamptz NOT NULL
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
  // Forward migrations for databases created before these columns existed.
  // Harmless on a fresh schema.
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS runs_failed_total integer NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 0',
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'open'`,
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS time_ms integer',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS fail_reason text',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_counter integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_gap_n integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_gap_sum double precision NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS beat_gap_sq double precision NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS flappy_fails integer NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS chase_fails integer NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS failed boolean NOT NULL DEFAULT false',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS chase_started_at timestamptz',
  // Serves both the per-player run history and the retention prune.
  'CREATE INDEX IF NOT EXISTS runs_user_issued_idx ON runs (user_id, issued_at)',
  'CREATE INDEX IF NOT EXISTS runs_issued_idx ON runs (issued_at)',
  // Serves the "still open" sweep: the equality prefix filters out every run
  // that has already been scored or already been counted as a failure.
  'CREATE INDEX IF NOT EXISTS runs_open_idx ON runs (consumed, failed, last_beat_at)',
  'CREATE INDEX IF NOT EXISTS scores_mode_time_idx ON scores (mode, time_ms, achieved_at)',
  'CREATE INDEX IF NOT EXISTS score_submissions_user_idx ON score_submissions (user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS rejections_at_idx ON rejections (at)',
  'CREATE INDEX IF NOT EXISTS rejections_reason_idx ON rejections (reason, at)',
];

function createPool(config) {
  // Railway Postgres terminates TLS with its own certificate chain; the pg
  // driver needs the relaxed verification that every Railway service uses.
  const needsSsl = !/localhost|127\.0\.0\.1/.test(config.databaseUrl);
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
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

module.exports = { SCHEMA, createPool, migrate, migrateWithRetry };
