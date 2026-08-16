'use strict';

// Shared test rig. There is no local Postgres on this machine by policy, so the
// store runs against pg-mem (an in-memory Postgres implementation) and the app
// runs on an ephemeral port with an injected clock.

const { newDb } = require('pg-mem');
const { migrate } = require('../db');
const { createStore } = require('../store');
const { createRateLimiter } = require('../ratelimit');
const { createRecorder } = require('../recorder');
const { createFeed } = require('../feed');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { signSession } = require('../session');
const { LIMITS, winSignatures } = require('../validation');
const { expectedAnswers } = require('../challenge');

const TEST_ENV = Object.freeze({
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-000000',
  GAME_ORIGIN: 'https://themizeguy.github.io',
  BASE_URL: 'https://api.example.test',
  FLOOR_PRACTICE_MS: '8000',
  FLOOR_SIM_MS: '15000',
});

function testConfig(overrides = {}) {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

async function createMemPool() {
  // noAstCoverageCheck: re-running CREATE TABLE IF NOT EXISTS over an existing
  // table makes pg-mem complain that it never read the column constraints of
  // the statement it correctly skipped. Real Postgres just returns a notice.
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return pool;
}

// A clock the tests drive by hand so elapsed-time rules are deterministic.
function createClock(startIso = '2026-08-15T21:00:00.000Z') {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance(ms) {
      current += ms;
      return new Date(current);
    },
  };
}

// The signature the browser puts on its WIN line, recomputed here exactly as
// js/chase.js does it.
function signClaim(claim, salt) {
  return winSignatures(claim, salt).sha;
}

async function createContext(options = {}) {
  const config = testConfig(options.env);
  const pool = await createMemPool();
  const baseStore = createStore(pool);
  const store = options.decorateStore ? options.decorateStore(baseStore) : baseStore;
  const clock = createClock();
  const limiter = createRateLimiter({ now: () => clock.nowMs() });
  const logs = [];
  const log = (message) => logs.push(message);
  // The feed rides the test clock so every event's `at` stamp is deterministic.
  const feed = createFeed({ now: () => clock.nowMs(), ...(options.feed || {}) });
  const twitch = options.twitch || {
    exchangeCode: async () => 'unused-token',
    fetchIdentity: async () => ({ id: '1', login: 'x', displayName: 'X', avatarUrl: '' }),
    revoke: async () => {},
  };
  const now = () => clock.now();
  const recorder = createRecorder({ store, config, now, log });

  const app = createApp({
    config,
    store,
    feed,
    twitch,
    limiter,
    recorder,
    now,
    log,
    // Tests that are not about the global ceiling raise it out of the way.
    globalIpLimit: options.globalIpLimit || 100000,
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Thin fetch wrapper: always sends the game Origin, keeps a cookie string.
  function makeClient(cookie = '') {
    let jar = cookie;
    async function call(method, path, body, extra = {}) {
      const headers = { Origin: config.gameOrigin, ...(extra.headers || {}) };
      if (jar) headers.Cookie = jar;
      const init = { method, headers, redirect: 'manual' };
      if (body !== undefined && body !== null) {
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetch(`${base}${path}`, init);
      let json = null;
      const type = response.headers.get('content-type') || '';
      if (type.includes('application/json')) json = await response.json();
      return { status: response.status, headers: response.headers, json };
    }
    return {
      get: (path, extra) => call('GET', path, null, extra),
      post: (path, body, extra) => call('POST', path, body, extra),
      call,
      setCookie: (value) => { jar = value; },
      cookie: () => jar,
    };
  }

  function cookieFor(userId) {
    const token = signSession(config.sessionSecret, {
      sub: userId,
      nowMs: clock.nowMs(),
      ttlMs: config.sessionTtlMs,
    });
    return `eal_session=${token}`;
  }

  function clientFor(userId) {
    return makeClient(cookieFor(userId));
  }

  async function seedUser(id, login) {
    return store.upsertUser(
      { id, login, displayName: login.toUpperCase(), avatarUrl: `https://cdn.test/${login}.png` },
      clock.now(),
    );
  }

  // Collects everything the live feed emits, without an HTTP connection.
  function collectFeed() {
    const events = [];
    const sink = {
      write(frame) {
        const match = /^(?:id: \d+\n)?event: (\w+)\ndata: (.*)\n\n$/s.exec(frame);
        if (match) events.push({ type: match[1], data: JSON.parse(match[2]) });
        return true;
      },
      end() {},
      on() {},
    };
    feed.subscribe(sink);
    return {
      events,
      of: (type) => events.filter((event) => event.type === type),
      clear: () => { events.length = 0; },
    };
  }

  async function close() {
    limiter.stop();
    feed.closeAll();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  return {
    config,
    pool,
    store,
    clock,
    limiter,
    logs,
    feed,
    recorder,
    app,
    base,
    makeClient,
    clientFor,
    cookieFor,
    seedUser,
    collectFeed,
    close,
  };
}

// One heartbeat, echoing the last chain token and returning the next one.
async function sendBeat(client, runId, chainToken, chase) {
  const response = await client.post('/api/run/beat', {
    nonce: runId,
    chain: chainToken,
    chase: chase === true,
  });
  const next = response.status === 200 && response.json && response.json.chain
    ? response.json.chain
    : chainToken;
  return { response, chain: next };
}

async function solveChallenge(ctx, client, runId) {
  const before = await ctx.store.getRun(runId);
  if (
    before
    && before.mode === 'practice'
    && ctx.clock.nowMs() - before.chaseStartedAtMs < LIMITS.MIN_PRACTICE_CHALLENGE_OFFSET_MS
  ) {
    ctx.clock.advance(
      LIMITS.MIN_PRACTICE_CHALLENGE_OFFSET_MS
      - (ctx.clock.nowMs() - before.chaseStartedAtMs),
    );
  }
  const started = await client.post('/api/event', { type: 'challenge_start', runId });
  if (started.status !== 200) return { started, solved: null };
  const run = await ctx.store.getRun(runId);
  const answers = expectedAnswers({
    runId,
    seed: run.challengeSeed,
    secret: ctx.config.sessionSecret,
  });
  ctx.clock.advance(LIMITS.MIN_CHALLENGE_SOLVE_MS);
  const solved = await client.post('/api/event', {
    type: 'challenge_solve', runId, answers,
  });
  return { started, solved };
}

// Plays a legitimate run end to end: opens it, walks the gauntlet when the mode
// has one, stamps the chase, heartbeats on the real cadence while advancing the
// clock, then submits a properly signed score.
async function playRun(ctx, client, mode, timeMs, stats = {}) {
  const created = await client.post('/api/run', { mode });
  if (created.status !== 200) return { created, submitted: null, runId: null };
  const runId = created.json.runId;
  let chainToken = created.json.chain;

  if (mode === 'simulation') {
    // Simulation runs open at flappy start, so the gauntlet is played first.
    const flappyMs = stats.flappyMs === undefined ? 20000 : stats.flappyMs;
    const flappyBeats = Math.floor(flappyMs / 5000);
    for (let i = 0; i < flappyBeats; i += 1) {
      ctx.clock.advance(5000);
      ({ chain: chainToken } = await sendBeat(client, runId, chainToken, false));
    }
    ctx.clock.advance(Math.max(0, flappyMs - flappyBeats * 5000));
  }

  // Simulation places this between Flappy and Chase; Practice has no separate
  // pre-Chase phase, so the same helper completes it before the first beat.
  await solveChallenge(ctx, client, runId);

  // The first beat that declares the chase stamps the phase boundary.
  ({ chain: chainToken } = await sendBeat(client, runId, chainToken, true));

  const chaseBeats = Math.floor(timeMs / 5000);
  for (let i = 0; i < chaseBeats; i += 1) {
    ctx.clock.advance(5000);
    ({ chain: chainToken } = await sendBeat(client, runId, chainToken, true));
  }
  ctx.clock.advance(Math.max(0, timeMs - chaseBeats * 5000));

  const claim = {
    runId,
    timeMs,
    misses: stats.misses === undefined ? 3 : stats.misses,
    nearMisses: stats.nearMisses === undefined ? 4 : stats.nearMisses,
    sus: stats.sus === undefined ? 0 : stats.sus,
  };
  claim.sig = stats.sig === undefined ? signClaim(claim) : stats.sig;
  if (stats.beforeSubmit) await stats.beforeSubmit({ claim, runId, chain: chainToken });
  const submitted = await client.post('/api/score', claim);
  return { runId, chain: chainToken, created, submitted, claim };
}

module.exports = {
  TEST_ENV,
  testConfig,
  createMemPool,
  createClock,
  createContext,
  playRun,
  solveChallenge,
  sendBeat,
  signClaim,
};
