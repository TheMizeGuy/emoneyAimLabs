'use strict';

// Local target for the red team (V3.4 rule 7). Boots the REAL application -
// same routers, same validation, same SQL - against an in-memory Postgres, so
// attack scripts can be run without a database server anywhere.
//
// This file is never loaded by the deployed app: Railway runs `node index.js`.
// It needs pg-mem, which is a devDependency, so a production install cannot
// start it even by accident.
//
//   node tools/dev-server.js [port]
//
// It prints the base URL and a ready-made session cookie for a seeded player,
// then serves until interrupted.

// Fail CLOSED. This file prints signed session cookies, and it ships in a
// public repository, so it must be unsafe-by-refusal rather than safe-by-
// convention. An earlier guard keyed on NODE_ENV === 'production', which Railway
// never sets - it would have been inert in exactly the environment it was meant
// to protect. Now it runs only on an explicit opt-in, and never anywhere that
// looks remotely like a deployment.
function refuse(reason) {
  process.stderr.write(`dev-server refuses to start: ${reason}\n`);
  process.exit(1);
}

if (process.env.ALLOW_DEV_SERVER !== '1') {
  refuse('set ALLOW_DEV_SERVER=1 to run the local red-team target');
}
if (process.env.NODE_ENV === 'production') {
  refuse('NODE_ENV=production');
}
for (const marker of ['RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_ID', 'RAILWAY_PROJECT_ID']) {
  if (process.env[marker]) refuse(`${marker} is set, this looks like a deployed environment`);
}
// A DATABASE_URL pointing anywhere but this machine means a real database.
if (process.env.DATABASE_URL && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL)) {
  refuse('DATABASE_URL points at a non-local host');
}

const { newDb } = require('pg-mem');
const { migrate } = require('../db');
const { createStore } = require('../store');
const { createRateLimiter } = require('../ratelimit');
const { createRecorder } = require('../recorder');
const { createFeed } = require('../feed');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { signSession } = require('../session');

const ENV = {
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  TWITCH_CLIENT_ID: 'dev-client-id',
  TWITCH_CLIENT_SECRET: 'dev-client-secret',
  SESSION_SECRET: 'dev-session-secret-that-is-long-enough-000000',
  GAME_ORIGIN: 'http://localhost:8080',
  BASE_URL: 'http://localhost:3000',
};

async function main() {
  const port = Number.parseInt(process.argv[2], 10) || 3000;
  const config = loadConfig({ ...ENV, ...process.env, PORT: String(port) });

  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);

  const store = createStore(pool);
  const now = () => new Date();
  const log = (message) => process.stdout.write(`[dev] ${message}\n`);

  const players = [
    { id: '100', login: 'target', displayName: 'Target', avatarUrl: 'https://cdn.test/t.png' },
    { id: '200', login: 'bystander', displayName: 'Bystander', avatarUrl: 'https://cdn.test/b.png' },
  ];
  for (const player of players) await store.upsertUser(player, now());

  const app = createApp({
    config,
    store,
    feed: createFeed(),
    twitch: {
      exchangeCode: async () => 'dev-token',
      fetchIdentity: async () => players[0],
      revoke: async () => {},
    },
    limiter: createRateLimiter(),
    recorder: createRecorder({ store, config, now, log }),
    now,
    log,
  });

  app.listen(port, () => {
    log(`red-team target on http://127.0.0.1:${port}`);
    log(`GAME_ORIGIN is ${config.gameOrigin} - state changing calls need that Origin`);
    for (const player of players) {
      const token = signSession(config.sessionSecret, {
        sub: player.id,
        nowMs: Date.now(),
        ttlMs: config.sessionTtlMs,
      });
      log(`cookie for ${player.displayName} (${player.id}): eal_session=${token}`);
    }
    log('rejections land in the in-memory `rejections` table and on stdout as [ANTICHEAT]');
  });
}

main().catch((err) => {
  process.stderr.write(`dev-server failed: ${err.stack}\n`);
  process.exit(1);
});
