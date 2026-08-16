'use strict';

const { loadConfig } = require('./config');
const { createPool, migrateWithRetry } = require('./db');
const { createStore } = require('./store');
const { createTwitchClient } = require('./twitch');
const { createRateLimiter } = require('./ratelimit');
const { createRecorder } = require('./recorder');
const { createFeed } = require('./feed');
const { createApp } = require('./app');

function log(message) {
  process.stdout.write(`[api] ${message}\n`);
}

async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config);

  pool.on('error', (err) => log(`idle pool client error: ${err.code || err.message}`));

  await migrateWithRetry(pool, { log });
  log('schema ready');

  const store = createStore(pool);
  const now = () => new Date();
  const feed = createFeed();
  const limiter = createRateLimiter();
  const recorder = createRecorder({ store, config, now, log });

  const app = createApp({
    config,
    store,
    feed,
    twitch: createTwitchClient(config),
    limiter,
    recorder,
    now,
    log,
  });

  const server = app.listen(config.port, () => {
    log(`listening on ${config.port}, game origin ${config.gameOrigin}`);
  });

  const shutdown = (signal) => {
    log(`${signal} received, shutting down`);
    // Emit whatever the aggregate counters were holding before we go.
    recorder.flush();
    limiter.stop();
    feed.closeAll();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Configuration and migration failures are fatal; Railway will restart us.
  log(`fatal: ${err.message}`);
  process.exit(1);
});
