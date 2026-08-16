'use strict';

// End-to-end HTTP tests: the real express app, the real routers, the real SQL,
// running against pg-mem on an ephemeral port with an injected clock.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createContext, playRun, sendBeat, signClaim } = require('./helpers');
const { newRunToken } = require('../validation');
const chain = require('../chain');

const FOREIGN_RUN_ID = newRunToken();

// A syntactically perfect score body for a run that does not belong to us.
function forgery(overrides = {}) {
  const claim = {
    runId: FOREIGN_RUN_ID, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0, ...overrides,
  };
  if (claim.sig === undefined) claim.sig = signClaim(claim);
  return claim;
}

test('healthz answers without a session, a database or CORS', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const response = await fetch(`${ctx.base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), 'ok');
});

test('security headers are present on every response', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const response = await ctx.makeClient().get('/api/leaderboard?mode=practice');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('CORS allows the game origin with credentials and refuses everything else', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const allowed = await fetch(`${ctx.base}/api/leaderboard`, {
    headers: { Origin: ctx.config.gameOrigin },
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), ctx.config.gameOrigin);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(allowed.headers.get('vary'), 'Origin');

  const evil = await fetch(`${ctx.base}/api/leaderboard`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const goodPreflight = await fetch(`${ctx.base}/api/score`, {
    method: 'OPTIONS',
    headers: { Origin: ctx.config.gameOrigin, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(goodPreflight.status, 204);

  const evilPreflight = await fetch(`${ctx.base}/api/score`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(evilPreflight.status, 403);
});

test('the CSRF wall refuses a state-changing call with a foreign, absent or partial origin', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const cookie = ctx.cookieFor('1');

  const bodies = { mode: 'practice' };
  const cases = [
    ['https://evil.example', 403],
    ['null', 403],
    // A prefix of the real origin is not the real origin.
    ['https://themizeguy.github.io.evil.example', 403],
  ];
  for (const [origin, expected] of cases) {
    const response = await fetch(`${ctx.base}/api/run`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(bodies),
    });
    assert.equal(response.status, expected, origin);
    assert.equal((await response.json()).error, 'forbidden_origin');
  }

  // No Origin header at all is refused too: a browser always sends one on a
  // cross-origin POST, so its absence is never the game.
  const noOrigin = await fetch(`${ctx.base}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(bodies),
  });
  assert.equal(noOrigin.status, 403);

  // Pre-auth rejections are counted in memory and reported as an aggregate,
  // never as one row per request: the wall sits in front of everything, so a
  // flood of header-less POSTs must not become a database write per request.
  assert.equal(await ctx.store.countRejections('origin_missing'), 0);
  assert.equal(await ctx.store.countRejections('origin_mismatch'), 0);
  assert.equal(await ctx.store.countRejections(), 0, 'no audit row at all');

  ctx.recorder.flush();
  const line = ctx.logs.find((entry) => entry.includes('[ANTICHEAT] suppressed'));
  assert.ok(line, 'the flood is still visible in the logs');
  assert.match(line, /origin_mismatch=3/);
  assert.match(line, /origin_missing=1/);
});

test('the CSRF wall refuses the content types an HTML form can send', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const cookie = ctx.cookieFor('1');

  for (const type of [
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
  ]) {
    const response = await fetch(`${ctx.base}/api/score`, {
      method: 'POST',
      headers: { Origin: ctx.config.gameOrigin, 'Content-Type': type, Cookie: cookie },
      body: 'runId=x&timeMs=1',
    });
    assert.equal(response.status, 415, type);
  }
  assert.equal(await ctx.store.countRejections('content_type'), 0);
  ctx.recorder.flush();
  assert.ok(ctx.logs.some((entry) => entry.includes('content_type=3')));
});

test('unauthenticated calls are rejected, public reads are not', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  const anon = ctx.makeClient();

  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await anon.post('/api/run', { mode: 'practice' })).status, 401);
  assert.equal((await anon.post('/api/event', { type: 'flappy_death' })).status, 401);
  assert.equal((await anon.post('/api/score', forgery())).status, 401);
  assert.equal((await anon.get('/api/leaderboard?mode=practice')).status, 200);
  // Unauthenticated is another pre-auth, unbounded reason: counted, not stored.
  assert.equal(await ctx.store.countRejections('unauthenticated'), 0);
  ctx.recorder.flush();
  assert.ok(ctx.logs.some((entry) => /unauthenticated=[45]/.test(entry)));
});

test('a forged session cookie is rejected', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');

  const forged = ctx.makeClient('eal_session=eyJzdWIiOiIxIn0.not-a-real-signature');
  assert.equal((await forged.get('/api/me')).status, 401);
});

test('me returns exactly the identity the empty Twitch scope allows', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');

  const response = await ctx.clientFor('1').get('/api/me');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), [
    'avatarUrl', 'chaseFails', 'displayName', 'flappyFails', 'id', 'login',
  ]);
  assert.equal(response.json.email, undefined);
});

test('an honest practice run is accepted and ranked', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const { created, submitted } = await playRun(ctx, client, 'practice', 20000);
  assert.equal(created.status, 200);
  assert.equal(created.json.runId, created.json.nonce);
  assert.equal(created.json.chain, chain.tokenFor(ctx.config.sessionSecret, created.json.runId, 0));
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.bestMs, 20000);
  assert.equal(submitted.json.rank, 1);
  assert.equal(submitted.json.clicks, 4, 'three misses plus the winning click');
  assert.equal(await ctx.store.countRejections(), 0, 'an honest run leaves no audit trail');
});

test('an honest simulation run is accepted end to end', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const { submitted } = await playRun(ctx, client, 'simulation', 40000, { flappyMs: 30000 });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.bestMs, 40000);
  assert.equal(submitted.json.mode, 'simulation');
});

test('a run token cannot be replayed', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const { claim, submitted } = await playRun(ctx, client, 'practice', 20000);
  assert.equal(submitted.status, 200);

  const replay = await client.post('/api/score', claim);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error, 'run_consumed');
  assert.equal(await ctx.store.countRejections('run_consumed'), 1);
});

test('a run belonging to another player cannot be scored or beaten', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'owner');
  await ctx.seedUser('2', 'thief');

  const owner = ctx.clientFor('1');
  const created = await owner.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  let token = created.json.chain;
  for (let i = 0; i < 4; i += 1) {
    ctx.clock.advance(5000);
    ({ chain: token } = await sendBeat(owner, runId, token, true));
  }

  const thief = ctx.clientFor('2');
  const claim = { runId, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const stolen = await thief.post('/api/score', claim);
  assert.equal(stolen.status, 404);
  assert.equal(stolen.json.error, 'run_not_found');

  // Even with the owner's live chain token in hand.
  const stolenBeat = await thief.post('/api/run/beat', { nonce: runId, chain: token });
  assert.equal(stolenBeat.status, 404);

  // The owner can still finish their own run.
  const honest = await owner.post('/api/score', claim);
  assert.equal(honest.status, 200);
});

test('a fabricated run token is never valid', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  for (let i = 0; i < 3; i += 1) {
    const response = await client.post('/api/score', forgery({ runId: newRunToken() }));
    assert.equal(response.status, 404);
  }
});

test('a time longer than the chase the server timed is rejected', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  let token = created.json.chain;
  for (let i = 0; i < 12; i += 1) {
    ctx.clock.advance(5000);
    ({ chain: token } = await sendBeat(client, runId, token, true));
  }
  const claim = { runId, timeMs: 300000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'time_exceeds_elapsed');
  // The error does not tell the forger how far off they were.
  assert.equal(response.json.chasePhaseMs, undefined);
  assert.equal(await ctx.store.countRejections('time_exceeds_elapsed'), 1);
});

// The forgery that used to land rank 1 on both boards in seconds: claim the
// mode floor, which is the best score anyone can hold, and note that the old
// claim-driven rule demanded zero beats for exactly that claim.
test('the floor forgery no longer lands: a practice claim with no beats is refused', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'forger');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  // Wait out the elapsed check and nothing else. No beats at all.
  ctx.clock.advance(8100);
  const claim = { runId: created.json.runId, timeMs: 8000, misses: 0, nearMisses: 3, sus: 0 };
  claim.sig = signClaim(claim);

  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'insufficient_liveness');

  const board = await client.get('/api/leaderboard?mode=practice');
  assert.equal(board.json.entries.length, 0, 'nothing reached the board');
});

test('the floor forgery no longer lands: a simulation claim with one beat is refused', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'forger');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'simulation' });
  const runId = created.json.runId;
  // Sleep out the gauntlet minimum without playing it.
  ctx.clock.advance(12200);
  const stamped = await sendBeat(client, runId, created.json.chain, true);
  assert.equal(stamped.response.json.credited, true);
  // Sleep out the chase window with no further beats.
  ctx.clock.advance(15100);

  const claim = { runId, timeMs: 15000, misses: 0, nearMisses: 3, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'insufficient_liveness');
  assert.equal((await client.get('/api/leaderboard?mode=simulation')).json.entries.length, 0);
});

test('beats clustered at the start of the window do not buy a score', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'forger');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  let token = created.json.chain;

  // Beat honestly for the first 25 seconds, then go silent for the rest.
  for (let i = 0; i < 5; i += 1) {
    ({ chain: token } = await sendBeat(client, runId, token, true));
    ctx.clock.advance(5000);
  }
  ctx.clock.advance(35000);

  const claim = { runId, timeMs: 60000, misses: 5, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'insufficient_liveness');
});

test('a run that stops beating mid-way cannot be scored', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'forger');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  let token = created.json.chain;

  ({ chain: token } = await sendBeat(client, runId, token, true));
  ctx.clock.advance(5000);
  ({ chain: token } = await sendBeat(client, runId, token, true));
  // Forty seconds of silence, then a claim covering the whole window.
  ctx.clock.advance(40000);

  const claim = { runId, timeMs: 45000, misses: 4, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'insufficient_liveness');
});

// The other half of the same rule: the honest cadence must never be refused.
test('legitimate runs at and around the floors are accepted', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'honest');
  const client = ctx.clientFor('1');

  // Exactly the practice floor: beats at chase t=0 and t=5000, win at t=8000.
  const atFloor = await playRun(ctx, client, 'practice', 8000);
  assert.equal(atFloor.submitted.status, 200, JSON.stringify(atFloor.submitted.json));
  assert.equal(atFloor.submitted.json.bestMs, 8000);

  // Exactly the simulation floor, after a real gauntlet.
  const simFloor = await playRun(ctx, client, 'simulation', 15000, { flappyMs: 20000 });
  assert.equal(simFloor.submitted.status, 200, JSON.stringify(simFloor.submitted.json));

  // A comfortable thirty second run, with margin.
  const thirty = await playRun(ctx, client, 'practice', 30000);
  assert.equal(thirty.submitted.status, 200);
  assert.equal(thirty.submitted.json.bestMs, 8000, 'still the best time standing');

  // A full length simulation run.
  const long = await playRun(ctx, client, 'simulation', 58000, { flappyMs: 35000 });
  assert.equal(long.submitted.status, 200);
  assert.equal(await ctx.store.countRejections(), 0, 'honest play leaves no audit trail');
});

test('a long claim without heartbeats is rejected for liveness', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  ctx.clock.advance(300000);
  const claim = { runId: created.json.runId, timeMs: 300000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'insufficient_liveness');
});

test('heartbeat stuffing credits nothing', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  let token = created.json.chain;

  // Twenty beats inside the same millisecond, each echoing the token it was
  // handed back.
  for (let i = 0; i < 20; i += 1) {
    const result = await sendBeat(client, runId, token, true);
    token = result.chain;
  }
  assert.equal((await ctx.store.getRun(runId)).beats, 1, 'only the first beat credited');

  ctx.clock.advance(300000);
  const claim = { runId, timeMs: 300000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'insufficient_liveness');
});

test('a replayed chain token never credits a beat', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  const firstToken = created.json.chain;

  ctx.clock.advance(5000);
  const first = await sendBeat(client, runId, firstToken, true);
  assert.equal(first.response.json.credited, true);
  assert.equal((await ctx.store.getRun(runId)).beats, 1);

  // Replaying the retired token: recognised, resynced, never credited, however
  // long we wait between attempts.
  for (let i = 0; i < 5; i += 1) {
    ctx.clock.advance(10000);
    const replay = await sendBeat(client, runId, firstToken, true);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.json.credited, false);
    assert.equal(replay.response.json.chain, first.chain, 'the client is told the live token');
  }
  assert.equal((await ctx.store.getRun(runId)).beats, 1, 'replays credited nothing');
  assert.ok(await ctx.store.countRejections('chain_stale') >= 5);
});

test('a chain token from another run is refused outright', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const first = await client.post('/api/run', { mode: 'practice' });
  ctx.clock.advance(1000);
  const second = await client.post('/api/run', { mode: 'practice' });

  const crossed = await client.post('/api/run/beat', {
    nonce: second.json.runId,
    chain: first.json.chain,
  });
  assert.equal(crossed.status, 403);
  assert.equal(crossed.json.error, 'chain_invalid');
  assert.equal((await ctx.store.getRun(second.json.runId)).beats, 0);
  assert.equal(await ctx.store.countRejections('chain_invalid'), 1);
});

test('a guessed chain token is refused', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  for (const guess of ['0'.repeat(32), 'f'.repeat(32), created.json.runId.slice(0, 32)]) {
    const response = await client.post('/api/run/beat', {
      nonce: created.json.runId, chain: guess,
    });
    assert.equal(response.status, 403, guess);
  }
  assert.equal((await ctx.store.getRun(created.json.runId)).beats, 0);
});

test('a simulation run cannot skip the gauntlet', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  // Chase declared three seconds after the run opened.
  const played = await playRun(ctx, client, 'simulation', 20000, { flappyMs: 3000 });
  assert.equal(played.submitted.status, 400);
  assert.equal(played.submitted.json.error, 'flappy_phase_too_short');
});

test('a simulation run that never stamped a chase cannot be scored', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'simulation' });
  const runId = created.json.runId;
  let token = created.json.chain;
  // Beat honestly, but never declare the chase.
  for (let i = 0; i < 8; i += 1) {
    ctx.clock.advance(5000);
    ({ chain: token } = await sendBeat(client, runId, token, false));
  }
  const claim = { runId, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const response = await client.post('/api/score', claim);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'chase_not_started');
});

test('the chase stamp cannot be moved once set', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'simulation' });
  const runId = created.json.runId;
  let token = created.json.chain;
  ctx.clock.advance(20000);
  ({ chain: token } = await sendBeat(client, runId, token, true));
  const stamped = (await ctx.store.getRun(runId)).chaseStartedAtMs;

  // Keep declaring the chase for another minute; the boundary must not move,
  // so a forger cannot restart their own chase clock.
  for (let i = 0; i < 12; i += 1) {
    ctx.clock.advance(5000);
    ({ chain: token } = await sendBeat(client, runId, token, true));
  }
  assert.equal((await ctx.store.getRun(runId)).chaseStartedAtMs, stamped);
});

test('a time under the mode floor is rejected', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const practice = await playRun(ctx, client, 'practice', 7999);
  assert.equal(practice.submitted.status, 400);
  assert.equal(practice.submitted.json.error, 'below_floor');
  assert.equal(practice.submitted.json.floorMs, undefined, 'the floor is not echoed back');

  const sim = await playRun(ctx, client, 'simulation', 14999);
  assert.equal(sim.submitted.status, 400);
  assert.equal(sim.submitted.json.error, 'below_floor');
});

test('a simulation time past the shot clock is rejected, practice is not', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const over = await playRun(ctx, client, 'simulation', 61001);
  assert.equal(over.submitted.status, 400);
  assert.equal(over.submitted.json.error, 'above_sim_ceiling');

  const atCeiling = await playRun(ctx, client, 'simulation', 61000);
  assert.equal(atCeiling.submitted.status, 200);

  const practice = await playRun(ctx, client, 'practice', 61001);
  assert.equal(practice.submitted.status, 200, 'practice has no shot clock');
});

test('a win claiming no near misses is refused as implausible', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  // The screenshot forgery this rule exists for: zero clicks, zero misses.
  const zero = await playRun(ctx, client, 'practice', 20000, { misses: 0, nearMisses: 0 });
  assert.equal(zero.submitted.status, 422);
  assert.equal(zero.submitted.json.error, 'implausible_stats');

  const two = await playRun(ctx, client, 'practice', 20000, { nearMisses: 2 });
  assert.equal(two.submitted.status, 422);

  const three = await playRun(ctx, client, 'practice', 20000, { misses: 0, nearMisses: 3 });
  assert.equal(three.submitted.status, 200, 'a clean but plausible run still counts');
});

test('any sus event at all blocks a submission', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  // One sus event is as fatal as a hundred: there is no tolerance threshold.
  for (const sus of [1, 2, 100]) {
    const flagged = await playRun(ctx, client, 'practice', 20000, { sus });
    assert.equal(flagged.submitted.status, 422, `sus=${sus}`);
    assert.equal(flagged.submitted.json.error, 'client_flagged');
  }
  assert.equal(await ctx.store.countRejections('client_flagged'), 3);
  assert.ok(
    ctx.logs.some((line) => line.includes('[ANTICHEAT] hand-crafted submission')),
    'a sus submission gets its own log flavour',
  );

  const clean = await playRun(ctx, client, 'practice', 20000, { sus: 0 });
  assert.equal(clean.submitted.status, 200);
});

test('a win signature that does not verify is refused', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  // Well formed, but signed over different numbers.
  const wrong = await playRun(ctx, client, 'practice', 20000, {
    sig: signClaim({ timeMs: 9000, misses: 0, nearMisses: 3 }),
  });
  assert.equal(wrong.submitted.status, 400);
  assert.equal(wrong.submitted.json.error, 'invalid_signature');
  assert.equal(await ctx.store.countRejections('invalid_signature'), 1);

  // The FNV fallback the client uses without SubtleCrypto is accepted.
  const { winSignatures } = require('../validation');
  const fnv = await playRun(ctx, client, 'practice', 20000, {
    sig: winSignatures({ timeMs: 20000, misses: 3, nearMisses: 4 }).fnv,
  });
  assert.equal(fnv.submitted.status, 200);
});

test('malformed submissions are rejected before the database', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const cases = [
    [forgery({ runId: 'not-a-token' }), 400, 'invalid_run_id'],
    [forgery({ timeMs: '9000' }), 422, 'time_out_of_range'],
    [forgery({ timeMs: -1 }), 422, 'time_out_of_range'],
    [forgery({ timeMs: 99999999 }), 422, 'time_out_of_range'],
    [forgery({ misses: 20000 }), 422, 'stats_out_of_range'],
    [forgery({ nearMisses: null }), 422, 'stats_out_of_range'],
  ];
  for (const [body, status, expected] of cases) {
    const response = await client.post('/api/score', body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.json.error, expected);
  }

  const broken = await client.post('/api/score', '{not json');
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error, 'invalid_json');
});

test('an oversized body is refused', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');

  const response = await ctx.clientFor('1').post('/api/score', forgery({ padding: 'x'.repeat(10000) }));
  assert.equal(response.status, 413);
});

test('only a faster run replaces the record, and rank follows', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'alpha');
  await ctx.seedUser('2', 'beta');
  const alpha = ctx.clientFor('1');
  const beta = ctx.clientFor('2');

  const first = await playRun(ctx, alpha, 'practice', 30000, { misses: 10, nearMisses: 4 });
  assert.equal(first.submitted.json.rank, 1);

  const betaRun = await playRun(ctx, beta, 'practice', 20000, { misses: 2, nearMisses: 3 });
  assert.equal(betaRun.submitted.json.rank, 1);

  const slower = await playRun(ctx, alpha, 'practice', 45000, { misses: 99, nearMisses: 99 });
  assert.equal(slower.submitted.status, 200);
  assert.equal(slower.submitted.json.bestMs, 30000, 'keep-best ignores the slower run');
  assert.equal(slower.submitted.json.improved, false);
  assert.equal(slower.submitted.json.rank, 2);

  const faster = await playRun(ctx, alpha, 'practice', 12000, { misses: 1, nearMisses: 3 });
  assert.equal(faster.submitted.json.bestMs, 12000);
  assert.equal(faster.submitted.json.rank, 1);

  const board = await alpha.get('/api/leaderboard?mode=practice');
  assert.deepEqual(board.json.entries.map((e) => e.timeMs), [12000, 20000]);
  assert.deepEqual(board.json.entries.map((e) => e.rank), [1, 2]);
  assert.equal(board.json.entries[0].misses, 1, 'stats travel with the best time');
  assert.equal(board.json.entries[0].clicks, 2);
  assert.equal(board.json.entries[0].isYou, true);
  assert.equal(board.json.you.rank, 1);
});

test('leaderboard rows carry clicks and all three fail counters', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  await client.post('/api/event', { type: 'flappy_death' });
  await client.post('/api/event', { type: 'flappy_death' });
  // A simulation run abandoned in the gauntlet: total only.
  await client.post('/api/run', { mode: 'simulation' });
  ctx.clock.advance(5000);
  // A practice run abandoned in the chase: total and chase.
  await client.post('/api/run', { mode: 'practice' });
  ctx.clock.advance(5000);
  const played = await playRun(ctx, client, 'practice', 20000, { misses: 6, nearMisses: 4 });
  assert.equal(played.submitted.status, 200);

  const board = await client.get('/api/leaderboard?mode=practice');
  const row = board.json.entries[0];
  // The published row shape, exactly. twitchId is what lets a row open the
  // player card at GET /api/player/:twitchId.
  assert.deepEqual(Object.keys(row).sort(), [
    'achievedAt', 'avatarUrl', 'chaseFails', 'clicks', 'displayName', 'flappyFails',
    'isYou', 'misses', 'rank', 'timeMs', 'totalFails', 'twitchId',
  ]);
  assert.equal(row.twitchId, '1');
  assert.deepEqual(Object.keys(board.json.you).sort(), Object.keys(row).sort());
  assert.equal(board.json.you.twitchId, '1');
  assert.equal(row.clicks, 7);
  assert.equal(row.flappyFails, 2);
  assert.equal(row.chaseFails, 1);
  assert.equal(row.totalFails, 2);
  assert.equal(board.json.you.totalFails, 2);
});

test('leaderboard modes are independent and the mode parameter is validated', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  await playRun(ctx, client, 'practice', 20000);
  await playRun(ctx, client, 'simulation', 30000);

  assert.equal((await client.get('/api/leaderboard?mode=practice')).json.entries[0].timeMs, 20000);
  assert.equal((await client.get('/api/leaderboard?mode=simulation')).json.entries[0].timeMs, 30000);
  assert.equal((await client.get('/api/leaderboard')).json.mode, 'practice');

  const bogus = await client.get('/api/leaderboard?mode=sandbox');
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json.error, 'invalid_mode');
});

test('a logged out viewer sees the board without an own row', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  await playRun(ctx, ctx.clientFor('1'), 'practice', 20000);

  const anon = await ctx.makeClient().get('/api/leaderboard?mode=practice');
  assert.equal(anon.json.entries.length, 1);
  assert.equal(anon.json.entries[0].isYou, false);
  assert.equal(anon.json.you, null);
});

test('a player outside the top fifty still gets their own row', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  for (let i = 0; i < 50; i += 1) {
    const id = `f${String(i).padStart(3, '0')}`;
    await ctx.seedUser(id, id);
    const runId = await ctx.store.createRun(id, 'practice', ctx.clock.now());
    await ctx.store.submitScore(
      { runId, userId: id, mode: 'practice', timeMs: 9000 + i, misses: 0, nearMisses: 3 },
      ctx.clock.now(),
    );
  }
  await ctx.seedUser('slow', 'slowpoke');
  const client = ctx.clientFor('slow');
  const played = await playRun(ctx, client, 'practice', 90000);
  assert.equal(played.submitted.json.rank, 51);

  const board = await client.get('/api/leaderboard?mode=practice');
  assert.equal(board.json.entries.length, 50);
  assert.equal(board.json.entries.some((e) => e.isYou), false);
  assert.equal(board.json.you.rank, 51);
  assert.equal(board.json.you.timeMs, 90000);
  // The own-row fallback path builds its row separately, so it needs the id too.
  assert.equal(board.json.you.twitchId, 'slow');

  // Every public row carries an id the player card accepts.
  for (const entry of board.json.entries) {
    assert.match(entry.twitchId, /^[A-Za-z0-9_-]{1,64}$/);
  }
  const card = await client.get(`/api/player/${board.json.entries[0].twitchId}`);
  assert.equal(card.status, 200);
  assert.equal(card.json.displayName, board.json.entries[0].displayName);
});

test('score submissions are rate limited per user', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  await ctx.seedUser('2', 'other');
  const client = ctx.clientFor('1');

  for (let i = 0; i < 6; i += 1) {
    assert.equal((await client.post('/api/score', forgery())).status, 404, `attempt ${i}`);
  }
  const blocked = await client.post('/api/score', forgery());
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  assert.equal((await ctx.clientFor('2').post('/api/score', forgery())).status, 404);

  // A blocked request must cost the database nothing - otherwise being rate
  // limited is an invitation to fill the volume and take the service down.
  assert.equal(await ctx.store.countRejections('rate_limited'), 0);
  ctx.recorder.flush();
  assert.ok(ctx.logs.some((entry) => entry.includes('rate_limited=1')));
});

test('heartbeats and events are rate limited', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  let token = created.json.chain;
  for (let i = 0; i < 30; i += 1) {
    const result = await sendBeat(client, created.json.runId, token, true);
    assert.equal(result.response.status, 200, `beat ${i}`);
    token = result.chain;
  }
  assert.equal((await client.post('/api/run/beat', {
    nonce: created.json.runId, chain: token,
  })).status, 429);

  for (let i = 0; i < 30; i += 1) {
    assert.equal((await client.post('/api/event', { type: 'flappy_death' })).status, 204, `event ${i}`);
  }
  assert.equal((await client.post('/api/event', { type: 'flappy_death' })).status, 429);
  assert.equal((await client.get('/api/me')).json.flappyFails, 30);
});

// The beat limiter used to bucket on the run id in the request body, so a
// fresh random id per request landed in a fresh bucket and the limit never bit.
test('rotating the run id cannot escape the beat limit', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'flooder');
  const client = ctx.clientFor('1');

  const statuses = {};
  for (let i = 0; i < 40; i += 1) {
    const response = await client.post('/api/run/beat', {
      nonce: newRunToken(),
      chain: 'a'.repeat(32),
    });
    statuses[response.status] = (statuses[response.status] || 0) + 1;
  }
  assert.ok(statuses['429'] >= 9, `expected throttling, saw ${JSON.stringify(statuses)}`);
  assert.equal(statuses['404'], 30, 'exactly the per-user budget reached the lookup');

  // The limit is per session, so it does not punish a different player.
  await ctx.seedUser('2', 'bystander');
  const other = await ctx.clientFor('2').post('/api/run/beat', {
    nonce: newRunToken(), chain: 'a'.repeat(32),
  });
  assert.equal(other.status, 404);
});

test('public reads are rate limited per address', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  const client = ctx.makeClient();

  for (let i = 0; i < 60; i += 1) {
    assert.equal((await client.get('/api/leaderboard')).status, 200, `read ${i}`);
  }
  assert.equal((await client.get('/api/leaderboard')).status, 429);

  await ctx.seedUser('1', 'player');
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await client.get('/api/player/1')).status, 200, `player read ${i}`);
  }
  assert.equal((await client.get('/api/player/1')).status, 429);
});

test('run creation closes the previous run and streams the failure', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');
  const stream = ctx.collectFeed();

  await client.post('/api/run', { mode: 'simulation' });
  ctx.clock.advance(20000);
  await client.post('/api/run', { mode: 'simulation' });

  const me = await client.get('/api/me');
  assert.equal(me.json.chaseFails, 0, 'it never reached the popup');
  const failed = stream.of('run_failed');
  assert.equal(failed.length, 1);
  const { at: failedAt, ...failedData } = failed[0].data;
  assert.equal(typeof failedAt, 'number');
  assert.deepEqual(failedData, {
    twitchId: '1',
    name: 'PLAYER',
    avatar: 'https://cdn.test/player.png',
    mode: 'simulation',
    reason: null,
    phase: 'flappy',
  });

  const started = stream.of('run_started');
  assert.equal(started.length, 2);
  const { at: startedAt, ...startedData } = started[0].data;
  assert.equal(typeof startedAt, 'number');
  assert.deepEqual(startedData, {
    twitchId: '1',
    name: 'PLAYER',
    avatar: 'https://cdn.test/player.png',
    mode: 'simulation',
  });
});

test('an abandoned run is swept into a failure and streamed with its phase', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');
  const stream = ctx.collectFeed();

  const created = await client.post('/api/run', { mode: 'practice' });
  ctx.clock.advance(120000);
  await client.get('/api/leaderboard?mode=practice');

  const me = await client.get('/api/me');
  assert.equal(me.json.chaseFails, 1);
  const failed = stream.of('run_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.phase, 'chase', 'a practice run is in the chase from the start');

  // A swept run can no longer be scored.
  const claim = { runId: created.json.runId, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const late = await client.post('/api/score', claim);
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'run_closed');

  // Repeated reads do not keep counting the same run.
  ctx.clock.advance(120000);
  await client.get('/api/leaderboard?mode=practice');
  assert.equal((await client.get('/api/me')).json.chaseFails, 1);
});

test('a win streams to the feed with its time and clicks', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');
  const stream = ctx.collectFeed();

  await playRun(ctx, client, 'practice', 20000, { misses: 5, nearMisses: 4 });

  const won = stream.of('run_won');
  assert.equal(won.length, 1);
  const { at: wonAt, ...wonData } = won[0].data;
  assert.equal(wonAt, ctx.clock.nowMs(), 'the line is stamped on the server clock');
  assert.deepEqual(wonData, {
    twitchId: '1',
    name: 'PLAYER',
    avatar: 'https://cdn.test/player.png',
    mode: 'practice',
    timeMs: 20000,
    clicks: 6,
  });
});

test('a flappy death streams live', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const stream = ctx.collectFeed();

  await ctx.clientFor('1').post('/api/event', { type: 'flappy_death' });
  const deaths = stream.of('flappy_death');
  assert.equal(deaths.length, 1);
  const { at: deathAt, ...deathData } = deaths[0].data;
  assert.equal(typeof deathAt, 'number');
  assert.deepEqual(deathData, {
    twitchId: '1',
    name: 'PLAYER',
    avatar: 'https://cdn.test/player.png',
  });
});

test('a ban event colours the run, closes it and streams immediately', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');
  const stream = ctx.collectFeed();

  const created = await client.post('/api/run', { mode: 'simulation' });
  let token = created.json.chain;
  ctx.clock.advance(20000);
  ({ chain: token } = await sendBeat(client, created.json.runId, token, true));

  const banned = await client.post('/api/event', { type: 'ban', reason: 'captcha-timeout' });
  assert.equal(banned.status, 204);

  const failed = stream.of('run_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.twitchId, '1');
  assert.equal(failed[0].data.reason, 'captcha-timeout');
  assert.equal(failed[0].data.phase, 'chase');
  assert.equal(failed[0].data.mode, 'simulation');

  const me = await client.get('/api/me');
  assert.equal(me.json.chaseFails, 1);

  // A banned run is closed, so it can never be scored afterwards.
  const claim = { runId: created.json.runId, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  assert.equal((await client.post('/api/score', claim)).status, 409);
});

test('a spoofed ban reason is refused and a spammed one cannot touch the leaderboard', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  for (const body of [
    { type: 'ban' },
    { type: 'ban', reason: 'because-i-said-so' },
    { type: 'ban', reason: 1 },
  ]) {
    const response = await client.post('/api/event', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.error, 'invalid_ban_reason');
  }

  // A legitimate win, then a pile of ban claims: the record does not move.
  await playRun(ctx, client, 'practice', 20000);
  for (let i = 0; i < 5; i += 1) {
    await client.post('/api/event', { type: 'ban', reason: 'timeout' });
  }
  const board = await client.get('/api/leaderboard?mode=practice');
  assert.equal(board.json.entries.length, 1);
  assert.equal(board.json.entries[0].timeMs, 20000);
});

test('unknown event types are rejected', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  for (const body of [{ type: 'chase_win' }, { type: '' }, { type: 42 }, {}, []]) {
    const response = await client.post('/api/event', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await client.get('/api/me')).json.flappyFails, 0);
});

test('the player card is public and shows history, bests and totals', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('7', 'player');
  const client = ctx.clientFor('7');

  await playRun(ctx, client, 'practice', 20000, { misses: 4, nearMisses: 5 });
  ctx.clock.advance(1000);
  await client.post('/api/run', { mode: 'simulation' });
  await client.post('/api/event', { type: 'ban', reason: 'captcha-fail' });
  await client.post('/api/event', { type: 'flappy_death' });

  const card = await ctx.makeClient().get('/api/player/7');
  assert.equal(card.status, 200, 'the card needs no session');
  assert.equal(card.json.displayName, 'PLAYER');
  assert.equal(card.json.avatarUrl, 'https://cdn.test/player.png');
  assert.equal(card.json.best.practice.timeMs, 20000);
  assert.equal(card.json.best.practice.clicks, 5);
  assert.equal(card.json.best.practice.rank, 1);
  assert.equal(card.json.best.simulation, null);
  assert.equal(card.json.flappyFails, 1);
  assert.equal(card.json.chaseFails, 0);
  assert.equal(card.json.totalFails, 1);
  assert.deepEqual(card.json.totals, { runs: 2, wins: 1 });

  assert.equal(card.json.runs.length, 2);
  assert.equal(card.json.runs[0].outcome, 'failed');
  assert.equal(card.json.runs[0].failReason, 'captcha-fail');
  assert.equal(card.json.runs[0].phase, 'flappy');
  assert.equal(card.json.runs[1].outcome, 'won');
  assert.equal(card.json.runs[1].timeMs, 20000);
  // Nothing private leaks onto a public card.
  assert.equal(card.json.login, undefined);
  assert.equal(card.json.email, undefined);
});

test('the player card validates its id and 404s cleanly', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  const client = ctx.makeClient();

  assert.equal((await client.get('/api/player/does-not-exist')).status, 404);
  const bad = await client.get(`/api/player/${'x'.repeat(80)}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_player_id');
});

test('the live feed streams over SSE and survives a disconnect', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const controller = new AbortController();
  const response = await fetch(`${ctx.base}/api/feed`, {
    headers: { Origin: ctx.config.gameOrigin, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function readUntil(marker, budget = 40) {
    for (let i = 0; i < budget; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(marker)) return true;
    }
    return false;
  }

  // The connection preamble arrives before anything happens.
  assert.ok(await readUntil('retry:'), 'the stream opens with a retry hint');

  await client.post('/api/run', { mode: 'practice' });
  assert.ok(await readUntil('event: run_started'), `saw: ${buffer}`);
  assert.match(buffer, /"mode":"practice"/);
  assert.match(buffer, /"name":"PLAYER"/);
  // The id survives serialisation over the wire, not just the in-process sink.
  assert.match(buffer, /"twitchId":"1"/);

  controller.abort();
  // The server notices the drop and forgets the client.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.feed.size(), 0);
});

test('the feed replays recent history on connect and ?after narrows it', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  // Two events happen while nobody at all is watching.
  await client.post('/api/run', { mode: 'practice' });
  await client.post('/api/event', { type: 'flappy_death' });

  async function connectAndRead(query, marker) {
    const controller = new AbortController();
    const response = await fetch(`${ctx.base}/api/feed${query}`, {
      headers: { Origin: ctx.config.gameOrigin, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let i = 0; i < 40 && !buffer.includes(marker); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await response.body?.cancel().catch(() => {});
    return buffer;
  }

  // A cold connect gets the whole recent past, oldest first, stamped.
  const cold = await connectAndRead('', 'event: flappy_death');
  assert.match(cold, /id: 1\nevent: run_started/);
  assert.match(cold, /id: 2\nevent: flappy_death/);
  assert.ok(cold.indexOf('run_started') < cold.indexOf('flappy_death'));
  assert.match(cold, /"at":\d+/);

  // A reconnect that already saw line 1 gets only the gap.
  const warm = await connectAndRead('?after=1', 'event: flappy_death');
  assert.ok(!warm.includes('event: run_started'), `saw: ${warm}`);
  assert.match(warm, /id: 2\nevent: flappy_death/);

  // Junk cursors mean "from the top", never an error.
  const junk = await connectAndRead('?after=banana', 'event: flappy_death');
  assert.match(junk, /id: 1\nevent: run_started/);
});

test('feed connections are capped and rate limited', async (t) => {
  const ctx = await createContext({ feed: { maxClients: 3 } });
  t.after(() => ctx.close());

  const sinks = [];
  function fakeSink() {
    const sink = { frames: [], write(f) { this.frames.push(f); return true; }, end() { this.ended = true; }, on() {} };
    sinks.push(sink);
    ctx.feed.subscribe(sink);
    return sink;
  }
  for (let i = 0; i < 5; i += 1) fakeSink();
  assert.equal(ctx.feed.size(), 3, 'oldest connections are dropped at the cap');
  assert.equal(sinks[0].ended, true);
  assert.equal(sinks[4].ended, undefined);

  // Connection attempts themselves are limited per address.
  const client = ctx.makeClient();
  let limited = 0;
  for (let i = 0; i < 12; i += 1) {
    const controller = new AbortController();
    const response = await fetch(`${ctx.base}/api/feed`, {
      headers: { Origin: ctx.config.gameOrigin },
      signal: controller.signal,
    });
    if (response.status === 429) limited += 1;
    controller.abort();
    await response.body?.cancel().catch(() => {});
  }
  assert.ok(limited >= 1, 'the eleventh connection in a minute is refused');
  assert.equal((await client.get('/api/leaderboard')).status, 200, 'other reads are unaffected');
});

test('the login redirect asks Twitch for no scopes at all', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const response = await fetch(`${ctx.base}/auth/twitch`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(location.searchParams.get('scope'), '', 'empty scope: identity only, no email');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('client_id'), 'test-client-id');
  assert.equal(
    location.searchParams.get('redirect_uri'),
    'https://api.example.test/auth/twitch/callback',
  );
  assert.ok(location.searchParams.get('state').length >= 16);
  assert.equal(location.searchParams.has('client_secret'), false);

  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^eal_oauth_state=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(!setCookie.includes(`=${location.searchParams.get('state')};`), 'the cookie is signed');
});

test('the callback refuses a state that does not match the cookie', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const start = await fetch(`${ctx.base}/auth/twitch`, { redirect: 'manual' });
  const stateCookieValue = start.headers.get('set-cookie').split(';')[0];

  const forged = await fetch(`${ctx.base}/auth/twitch/callback?code=attacker&state=attacker-nonce`, {
    headers: { Cookie: stateCookieValue },
    redirect: 'manual',
  });
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).error, 'invalid_state');

  const naked = await fetch(`${ctx.base}/auth/twitch/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(naked.status, 400);
  assert.equal(await ctx.store.countRejections('oauth_state_mismatch'), 2);
});

test('a complete login round trip sets a session and discards the token', async (t) => {
  const identity = {
    id: '999', login: 'winner', displayName: 'Winner', avatarUrl: 'https://cdn/w.png',
  };
  const seen = { codes: [], revoked: [] };
  const ctx = await createContext({
    twitch: {
      exchangeCode: async (code) => { seen.codes.push(code); return 'secret-user-token'; },
      fetchIdentity: async () => identity,
      revoke: async (token) => { seen.revoked.push(token); },
    },
  });
  t.after(() => ctx.close());

  const start = await fetch(`${ctx.base}/auth/twitch`, { redirect: 'manual' });
  const stateCookieValue = start.headers.get('set-cookie').split(';')[0];
  const nonce = new URL(start.headers.get('location')).searchParams.get('state');

  const callback = await fetch(
    `${ctx.base}/auth/twitch/callback?code=live-code&state=${nonce}`,
    { headers: { Cookie: stateCookieValue }, redirect: 'manual' },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), 'https://themizeguy.github.io/emoneyAimLabs/');
  assert.deepEqual(seen.codes, ['live-code']);
  assert.deepEqual(seen.revoked, ['secret-user-token'], 'the user token is handed straight back');

  const cookies = callback.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('eal_session='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=None/);
  assert.match(session, /Max-Age=2592000/);
  assert.ok(cookies.some((c) => c.startsWith('eal_oauth_state=') && c.includes('Max-Age=0')));

  const me = await ctx.makeClient(session.split(';')[0]).get('/api/me');
  assert.equal(me.json.id, '999');
  assert.equal(me.json.displayName, 'Winner');

  // The state nonce is single use, cookie or no cookie: the server burns it.
  const replayWithCookie = await fetch(
    `${ctx.base}/auth/twitch/callback?code=live-code&state=${nonce}`,
    { headers: { Cookie: stateCookieValue }, redirect: 'manual' },
  );
  assert.equal(replayWithCookie.status, 400);
  assert.equal((await replayWithCookie.json()).error, 'invalid_state');
  assert.equal(await ctx.store.countRejections('oauth_state_replay'), 1);

  const replayWithout = await fetch(
    `${ctx.base}/auth/twitch/callback?code=live-code&state=${nonce}`,
    { redirect: 'manual' },
  );
  assert.equal(replayWithout.status, 400);
  assert.deepEqual(seen.codes, ['live-code'], 'no replay ever reached Twitch');
});

test('an expired state is refused even when the browser returns the cookie', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const start = await fetch(`${ctx.base}/auth/twitch`, { redirect: 'manual' });
  const stateCookieValue = start.headers.get('set-cookie').split(';')[0];
  const nonce = new URL(start.headers.get('location')).searchParams.get('state');

  // The expiry lives inside the signed value, so a client that ignores
  // Max-Age gains nothing.
  ctx.clock.advance(ctx.config.stateTtlMs + 1);
  const late = await fetch(
    `${ctx.base}/auth/twitch/callback?code=live-code&state=${nonce}`,
    { headers: { Cookie: stateCookieValue }, redirect: 'manual' },
  );
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, 'invalid_state');
});

test('a failing Twitch exchange never leaks the reason or a token', async (t) => {
  const ctx = await createContext({
    twitch: {
      exchangeCode: async () => {
        const err = new Error('Twitch token exchange failed (400)');
        err.code = 'token_rejected';
        throw err;
      },
      fetchIdentity: async () => { throw new Error('unreachable'); },
      revoke: async () => {},
    },
  });
  t.after(() => ctx.close());

  const start = await fetch(`${ctx.base}/auth/twitch`, { redirect: 'manual' });
  const stateCookieValue = start.headers.get('set-cookie').split(';')[0];
  const nonce = new URL(start.headers.get('location')).searchParams.get('state');

  const callback = await fetch(
    `${ctx.base}/auth/twitch/callback?code=bad&state=${nonce}`,
    { headers: { Cookie: stateCookieValue }, redirect: 'manual' },
  );
  assert.equal(callback.status, 502);
  const body = await callback.json();
  assert.equal(body.error, 'twitch_unavailable');
  assert.equal(JSON.stringify(body).includes('client_secret'), false);
});

test('a declined consent screen sends the player back to the game', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const response = await fetch(
    `${ctx.base}/auth/twitch/callback?error=access_denied&error_description=denied`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('location'),
    'https://themizeguy.github.io/emoneyAimLabs/?login=cancelled',
  );
});

test('logout clears the session cookie and obeys the CSRF wall', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');

  const response = await ctx.clientFor('1').post('/auth/logout', {});
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);

  const crossSite = await fetch(`${ctx.base}/auth/logout`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
  });
  assert.equal(crossSite.status, 403);
});

// A cleared cookie is not revocation: whoever copied the value still holds it.
test('logout revokes the cookie itself, not just the browser copy', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');

  // Two clients holding the same session, as a shared or streamed machine would.
  const cookie = ctx.cookieFor('1');
  const player = ctx.makeClient(cookie);
  const captured = ctx.makeClient(cookie);

  assert.equal((await player.get('/api/me')).status, 200);
  assert.equal((await captured.get('/api/me')).status, 200);

  assert.equal((await player.post('/auth/logout', {})).status, 204);

  // The captured copy is dead too, and the server says so while clearing it.
  const after = await captured.get('/api/me');
  assert.equal(after.status, 401);
  assert.match(after.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await captured.post('/api/run', { mode: 'practice' })).status, 401);
  assert.equal(await ctx.store.countRejections('session_revoked'), 2);

  // Signing in again issues a cookie stamped with the new epoch.
  const fresh = ctx.makeClient(
    `eal_session=${require('../session').signSession(ctx.config.sessionSecret, {
      sub: '1', nowMs: ctx.clock.nowMs(), ttlMs: ctx.config.sessionTtlMs, epoch: 1,
    })}`,
  );
  assert.equal((await fresh.get('/api/me')).status, 200);
});

test('logout is safe to call without a session and twice over', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');

  assert.equal((await ctx.makeClient().post('/auth/logout', {})).status, 204);
  assert.equal(await ctx.store.getSessionEpoch('1'), 0, 'no session, nothing revoked');

  const client = ctx.clientFor('1');
  assert.equal((await client.post('/auth/logout', {})).status, 204);
  assert.equal((await client.post('/auth/logout', {})).status, 204);
  // The second call carries an already-retired cookie: still 204, but it
  // revokes nothing, so a stale copy cannot spend writes on repeat calls.
  assert.equal(await ctx.store.getSessionEpoch('1'), 1);
});

test('no log line and no audit row ever contains a query string or a secret', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  await fetch(`${ctx.base}/auth/twitch/callback?code=super-secret-code&state=abc`, {
    redirect: 'manual',
  });
  await ctx.makeClient().get('/api/leaderboard?mode=practice');

  const joined = ctx.logs.join('\n');
  assert.equal(joined.includes('super-secret-code'), false);
  assert.equal(joined.includes('?'), false);
  assert.equal(joined.includes(ctx.config.sessionSecret), false);
  assert.equal(joined.includes(ctx.config.twitchClientSecret), false);
  // The FULL path is logged, not the router-relative one, so the same endpoint
  // reads the same whether it was handled or rejected at the wall.
  assert.ok(joined.includes('GET /auth/twitch/callback 400'), joined);
  assert.equal(joined.includes(' /twitch/callback '), false);

  const { rows } = await ctx.pool.query('SELECT endpoint, ip_hash FROM rejections');
  for (const row of rows) {
    assert.equal(row.endpoint.includes('?'), false);
    // The address is stored only as a keyed hash.
    if (row.ip_hash !== null) assert.match(row.ip_hash, /^[0-9a-f]{32}$/);
  }
});

test('unknown endpoints answer 404 in the shared error shape', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());

  const response = await ctx.makeClient().get('/api/nope');
  assert.equal(response.status, 404);
  assert.equal(response.json.error, 'not_found');
});

test('a global per-address ceiling sheds a flood before any work happens', async (t) => {
  const ctx = await createContext({ globalIpLimit: 25 });
  t.after(() => ctx.close());
  const client = ctx.makeClient();

  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < 60; i += 1) {
    const response = await client.get('/api/leaderboard?mode=practice');
    if (response.status === 429) blocked += 1;
    else allowed += 1;
  }
  assert.equal(allowed, 25, 'exactly the budget got through');
  assert.ok(blocked >= 30);

  // The healthcheck is never throttled, whatever else is happening.
  const health = await fetch(`${ctx.base}/healthz`);
  assert.equal(health.status, 200);

  // And the shedding cost the database nothing.
  assert.equal(await ctx.store.countRejections(), 0);
});

test('the audit trail keeps verdicts and discards flood noise', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  // Noise: unknown run ids, the shape a flood takes. Kept under the score
  // budget so the genuine verdict below still gets its turn.
  for (let i = 0; i < 3; i += 1) {
    await client.post('/api/score', forgery({ runId: newRunToken() }));
  }
  assert.equal(await ctx.store.countRejections('run_not_found'), 0, 'noise is not stored');

  // Signal: a genuine verdict on a real run.
  const flagged = await playRun(ctx, ctx.clientFor('1'), 'practice', 20000, { sus: 3 });
  assert.equal(flagged.submitted.status, 422);
  assert.equal(await ctx.store.countRejections('client_flagged'), 1, 'verdicts are kept');

  // The policy is explicit, and the two lists must never overlap.
  const { LOG_ONLY_REASONS, ALWAYS_PERSISTED_REASONS } = require('../recorder');
  for (const reason of ALWAYS_PERSISTED_REASONS) {
    assert.equal(LOG_ONLY_REASONS.has(reason), false, `${reason} must always be stored`);
  }
});

test('there is no endpoint that reads or writes the audit trail', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  for (const path of [
    '/api/rejections', '/api/admin', '/api/debug', '/api/runs', '/api/scores',
    '/api/leaderboard/reset', '/api/player/1/delete',
  ]) {
    const response = await client.get(path);
    assert.equal(response.status, 404, path);
  }
});

test('two concurrent submissions of one run produce a single score', async (t) => {
  const ctx = await createContext();
  t.after(() => ctx.close());
  await ctx.seedUser('1', 'player');
  const client = ctx.clientFor('1');

  const created = await client.post('/api/run', { mode: 'practice' });
  const runId = created.json.runId;
  let token = created.json.chain;
  for (let i = 0; i < 4; i += 1) {
    ctx.clock.advance(5000);
    ({ chain: token } = await sendBeat(client, runId, token, true));
  }

  const claim = { runId, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0 };
  claim.sig = signClaim(claim);
  const [a, b] = await Promise.all([
    client.post('/api/score', claim),
    client.post('/api/score', claim),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);

  const board = await client.get('/api/leaderboard?mode=practice');
  assert.equal(board.json.entries.length, 1);
  const { rows } = await ctx.pool.query('SELECT COUNT(*) AS n FROM score_submissions');
  assert.equal(Number(rows[0].n), 1);
});
