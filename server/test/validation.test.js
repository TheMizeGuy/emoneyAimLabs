'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  LIMITS,
  BAN_REASONS,
  newRunToken,
  isRunToken,
  isMode,
  isTwitchId,
  requiredBeats,
  parseRunBody,
  parseBeatBody,
  parseEventBody,
  parseScoreBody,
  winSignatures,
  verifyWinSignature,
  validateRunForScore,
  beatCounts,
} = require('../validation');
const chain = require('../chain');
const { createRateLimiter } = require('../ratelimit');
const { loadConfig } = require('../config');
const { TEST_ENV } = require('./helpers');

const RUN_ID = newRunToken();
const CHAIN = 'a'.repeat(32);
const FLOORS = { practice: 8000, simulation: 15000 };

function baseRun(overrides = {}) {
  return {
    id: RUN_ID,
    userId: 'user-1',
    mode: 'practice',
    issuedAtMs: 1000000,
    chaseStartedAtMs: 1000000,
    beats: 100,
    beatCounter: 0,
    consumed: false,
    failed: false,
    ...overrides,
  };
}

// Checks a claim against a run, with `now` expressed as an offset from the
// moment the chase started. A run that does not say otherwise is treated as
// having beaten a second ago, so tests aimed at other rules are not tripped by
// the beat-freshness one.
function check(run, timeMs, chaseOffsetMs, userId = 'user-1') {
  const anchor = run ? run.chaseStartedAtMs || run.issuedAtMs : 0;
  const nowMs = anchor + chaseOffsetMs;
  if (run && !Object.hasOwn(run, 'lastBeatAtMs')) run.lastBeatAtMs = nowMs - 1000;
  return validateRunForScore({
    run,
    userId,
    nowMs,
    timeMs,
    floors: FLOORS,
  });
}

function claim(overrides = {}) {
  const value = {
    runId: RUN_ID, timeMs: 20000, misses: 3, nearMisses: 4, sus: 0, ...overrides,
  };
  if (value.sig === undefined) value.sig = winSignatures(value).sha;
  return value;
}

test('run tokens carry 192 bits of entropy and validate by shape', () => {
  const token = newRunToken();
  assert.equal(token.length, 32);
  assert.equal(isRunToken(token), true);
  assert.equal(isRunToken('short'), false);
  assert.equal(isRunToken(`${token}!`), false);
  assert.equal(isRunToken("' OR 1=1 --"), false);
  assert.equal(isRunToken(null), false);
  const many = new Set(Array.from({ length: 500 }, () => newRunToken()));
  assert.equal(many.size, 500);
});

test('mode and player id validation', () => {
  assert.equal(isMode('practice'), true);
  assert.equal(isMode('simulation'), true);
  assert.equal(isMode('Practice'), false);
  assert.equal(isTwitchId('12345678'), true);
  assert.equal(isTwitchId('a'.repeat(65)), false);
  assert.equal(isTwitchId('../../etc/passwd'), false);
  assert.equal(isTwitchId(''), false);
});

test('requiredBeats is driven off the server window and never falls below the floor', () => {
  // The clamp is the point: without it the requirement collapses to zero for a
  // short window, which is exactly the claim worth forging.
  assert.equal(requiredBeats(0), 2);
  assert.equal(requiredBeats(8000), 2);
  assert.equal(requiredBeats(9999), 2);
  assert.equal(requiredBeats(14999), 2);
  // From 15 s the window drives it: floor(w/5000) - 1.
  assert.equal(requiredBeats(15000), 2);
  assert.equal(requiredBeats(20000), 3);
  assert.equal(requiredBeats(60000), 11);
  assert.equal(requiredBeats(300000), 59);
});

// The false-reject safety proof. The client beats at chase t=0 then every 5 s
// (unchanged by this fix), so a run of length T carries floor(T/5000) + 1
// credited beats, and the server demands max(2, floor(T/5000) - 1).
test('every legitimate cadence clears the liveness bar', () => {
  for (const windowMs of [8000, 9000, 10000, 12000, 15000, 20000, 30000, 45000, 60000, 120000]) {
    const credited = Math.floor(windowMs / 5000) + 1;
    const needed = requiredBeats(windowMs);
    assert.ok(
      credited >= needed,
      `a ${windowMs} ms run beats ${credited} times but needs ${needed}`,
    );
  }
});

test('parseRunBody validates mode', () => {
  assert.deepEqual(parseRunBody({ mode: 'simulation' }), { ok: true, value: { mode: 'simulation' } });
  assert.equal(parseRunBody({ mode: 'nope' }).code, 'invalid_mode');
  assert.equal(parseRunBody(null).code, 'invalid_body');
  assert.equal(parseRunBody([]).code, 'invalid_body');
});

test('parseBeatBody requires a run token and a chain token', () => {
  const good = parseBeatBody({ nonce: RUN_ID, chain: CHAIN, chase: true });
  assert.deepEqual(good.value, { runId: RUN_ID, chase: true, chainToken: CHAIN });
  // runId is accepted as an alias for nonce.
  assert.equal(parseBeatBody({ runId: RUN_ID, chain: CHAIN }).value.chase, false);
  assert.equal(parseBeatBody({ nonce: 'x', chain: CHAIN }).code, 'invalid_run_id');
  assert.equal(parseBeatBody({ nonce: RUN_ID }).code, 'invalid_body');
  assert.equal(parseBeatBody({ nonce: RUN_ID, chain: 123 }).code, 'invalid_body');
  assert.equal(parseBeatBody({ nonce: RUN_ID, chain: CHAIN, chase: 'yes' }).code, 'invalid_body');
  assert.equal(parseBeatBody('string').code, 'invalid_body');
});

test('parseEventBody accepts only known types and ban reasons', () => {
  assert.deepEqual(parseEventBody({ type: 'flappy_death' }).value, { type: 'flappy_death' });
  for (const reason of BAN_REASONS) {
    assert.deepEqual(parseEventBody({ type: 'ban', reason }).value, { type: 'ban', reason });
  }
  assert.equal(parseEventBody({ type: 'ban' }).code, 'invalid_ban_reason');
  assert.equal(parseEventBody({ type: 'ban', reason: 'because' }).code, 'invalid_ban_reason');
  assert.equal(parseEventBody({ type: 'chase_win' }).code, 'invalid_event_type');
  assert.equal(parseEventBody({ type: 'FLAPPY_DEATH' }).code, 'invalid_event_type');
  assert.equal(parseEventBody(null).code, 'invalid_body');
});

test('parseScoreBody enforces types, sanity caps and plausibility floors', () => {
  const good = parseScoreBody(claim());
  assert.equal(good.ok, true);
  assert.equal(good.value.runId, RUN_ID);

  assert.equal(parseScoreBody(claim({ runId: 'nope' })).code, 'invalid_run_id');
  assert.equal(parseScoreBody(claim({ timeMs: -1 })).code, 'time_out_of_range');
  assert.equal(parseScoreBody(claim({ timeMs: 0 })).code, 'time_out_of_range');
  assert.equal(parseScoreBody(claim({ timeMs: 1.5 })).code, 'time_out_of_range');
  assert.equal(parseScoreBody(claim({ timeMs: '9000' })).code, 'time_out_of_range');
  assert.equal(parseScoreBody(claim({ timeMs: LIMITS.MAX_TIME_MS + 1 })).code, 'time_out_of_range');
  assert.equal(parseScoreBody(claim({ misses: 10001 })).code, 'stats_out_of_range');
  assert.equal(parseScoreBody(claim({ misses: -1 })).code, 'stats_out_of_range');
  assert.equal(parseScoreBody(claim({ nearMisses: 10001 })).code, 'stats_out_of_range');

  // The forgery this exists to kill: a flawless run with nothing near it.
  assert.equal(parseScoreBody(claim({ misses: 0, nearMisses: 0 })).code, 'implausible_stats');
  assert.equal(parseScoreBody(claim({ nearMisses: 2 })).code, 'implausible_stats');
  assert.equal(parseScoreBody(claim({ nearMisses: 3 })).ok, true);

  // Attestation must be present, well formed, and report a clean run.
  const noSig = claim();
  delete noSig.sig;
  assert.equal(parseScoreBody(noSig).code, 'invalid_attestation');
  const noSus = claim();
  delete noSus.sus;
  assert.equal(parseScoreBody(noSus).code, 'invalid_attestation');
  assert.equal(parseScoreBody(claim({ sig: 'nothex!!!!!!!!!!' })).code, 'invalid_attestation');
  assert.equal(parseScoreBody(claim({ sig: 'abc' })).code, 'invalid_attestation');
  assert.equal(parseScoreBody(claim({ sus: '0' })).code, 'invalid_attestation');
  assert.equal(parseScoreBody(claim({ sus: 1 })).code, 'client_flagged');
});

test('the win signature matches what the browser computes', () => {
  // js/chase.js: sha256(timeMs|misses|nearMisses|WIN_SALT), first 16 hex chars,
  // with a doubled FNV-1a fallback where SubtleCrypto is missing.
  const value = { timeMs: 20000, misses: 3, nearMisses: 4 };
  const expected = crypto
    .createHash('sha256')
    .update('20000|3|4|aimlab-95-v2.7', 'utf8')
    .digest('hex')
    .slice(0, 16);
  const signatures = winSignatures(value);
  assert.equal(signatures.sha, expected);
  assert.equal(signatures.fnv.length, 16);
  assert.notEqual(signatures.sha, signatures.fnv);

  assert.equal(verifyWinSignature({ ...value, sig: signatures.sha }), true);
  assert.equal(verifyWinSignature({ ...value, sig: signatures.sha.toUpperCase() }), true);
  assert.equal(verifyWinSignature({ ...value, sig: signatures.fnv }), true);
  assert.equal(verifyWinSignature({ ...value, sig: '0'.repeat(16) }), false);
  // A signature over different numbers does not travel with these ones.
  const other = winSignatures({ timeMs: 9000, misses: 3, nearMisses: 4 });
  assert.equal(verifyWinSignature({ ...value, sig: other.sha }), false);
  // A different build salt is a different signature.
  assert.equal(verifyWinSignature({ ...value, sig: signatures.sha }, 'other-salt'), false);
});

test('score validation accepts an honest practice run', () => {
  const verdict = check(baseRun(), 20000, 21000);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.chasePhaseMs, 21000);
});

test('score validation rejects unknown, foreign, replayed and closed runs', () => {
  assert.equal(check(null, 20000, 21000).code, 'run_not_found');
  assert.equal(check(baseRun({ userId: 'someone-else' }), 20000, 21000).code, 'run_not_found');
  assert.equal(check(baseRun({ consumed: true }), 20000, 21000).code, 'run_consumed');
  assert.equal(check(baseRun({ failed: true }), 20000, 21000).code, 'run_closed');
  assert.equal(
    check(baseRun({ failed: true, consumed: true }), 20000, 21000).code,
    'run_consumed',
    'consumption is reported first when a run is somehow both',
  );
});

test('score validation rejects a chase that never started', () => {
  const sim = baseRun({ mode: 'simulation', chaseStartedAtMs: null });
  assert.equal(check(sim, 20000, 21000).code, 'chase_not_started');
  assert.equal(
    check(baseRun({ chaseStartedAtMs: undefined }), 20000, 21000).code,
    'chase_not_started',
  );
});

test('score validation enforces the gauntlet phase for simulation runs', () => {
  const issuedAtMs = 1000000;
  function sim(flappyPhaseMs) {
    return baseRun({
      mode: 'simulation',
      issuedAtMs,
      chaseStartedAtMs: issuedAtMs + flappyPhaseMs,
    });
  }
  // Ten pipes cannot be cleared in three seconds.
  assert.equal(check(sim(3000), 20000, 21000).code, 'flappy_phase_too_short');
  assert.equal(check(sim(11999), 20000, 21000).code, 'flappy_phase_too_short');
  assert.equal(check(sim(12000), 20000, 21000).ok, true);
  // Nor can a run sit in the gauntlet for an hour.
  assert.equal(check(sim(LIMITS.MAX_FLAPPY_PHASE_MS + 1), 20000, 21000).code, 'run_expired');
  // Practice has no gauntlet, so the rule does not apply to it.
  assert.equal(check(baseRun(), 20000, 21000).ok, true);
});

test('score validation expires old runs and old chases', () => {
  // Outer bound on the whole run row.
  const ancient = baseRun({ issuedAtMs: 0, chaseStartedAtMs: 0 });
  assert.equal(check(ancient, 20000, LIMITS.MAX_RUN_AGE_MS + 1).code, 'run_expired');
  // Chase phase window. A window this long needs a matching beat count, hence
  // the explicit beats here - see the divergence test below.
  assert.equal(check(baseRun({ beats: 200 }), 20000, LIMITS.RUN_TTL_MS + 1).code, 'run_expired');
  assert.equal(check(baseRun({ beats: 200 }), 20000, LIMITS.RUN_TTL_MS).ok, true);
  // A clock that runs backwards.
  assert.equal(check(baseRun(), 20000, -5000).code, 'run_expired');
});

test('score validation rejects a time longer than the chase the server timed', () => {
  assert.equal(check(baseRun(), 20000, 16000).code, 'time_exceeds_elapsed');
  assert.equal(check(baseRun(), 20000, 17001).ok, true, 'three seconds of tolerance');
});

test('score validation rejects a run without enough credited heartbeats', () => {
  // A 61 s window needs floor(61000/5000) - 1 = 11 credited beats.
  const verdict = check(baseRun({ beats: 7, lastBeatAtMs: 1060000 }), 60000, 61000);
  assert.equal(verdict.code, 'insufficient_liveness');
  assert.equal(verdict.detail.reason, 'count');
  assert.equal(verdict.detail.needed, 11);
  assert.equal(verdict.detail.beats, 7);
  assert.equal(check(baseRun({ beats: 11, lastBeatAtMs: 1060000 }), 60000, 61000).ok, true);
});

test('no score is accepted with zero beats, however short the window', () => {
  // The old rule made this pass: requiredBeats(8000) was 0, so the entire
  // chain, the paced crediting and the telemetry were bypassed by the only
  // claim worth forging - the floor, which is also rank 1.
  const forged = check(baseRun({ beats: 0, lastBeatAtMs: null }), 8000, 8100);
  assert.equal(forged.code, 'insufficient_liveness');
  assert.equal(forged.detail.reason, 'count');
  assert.equal(forged.detail.needed, 2);

  // One beat is still not enough.
  assert.equal(check(baseRun({ beats: 1, lastBeatAtMs: 1008000 }), 8000, 8100).ok, false);
});

test('beats must straddle the window, not cluster at its start', () => {
  // Enough beats, but the most recent one is ancient: a forger who sent every
  // beat up front and then slept out the window.
  const issuedAtMs = 1000000;
  const clustered = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 40, lastBeatAtMs: issuedAtMs + 5000 }),
    60000,
    61000,
  );
  assert.equal(clustered.code, 'insufficient_liveness');
  assert.equal(clustered.detail.reason, 'stale');
  assert.equal(clustered.detail.lastBeatAgeMs, 56000);

  // A beat that landed inside the freshness bound is fine.
  const fresh = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 40, lastBeatAtMs: issuedAtMs + 58000 }),
    60000,
    61000,
  );
  assert.equal(fresh.ok, true);

  // Exactly at the bound passes; one millisecond past it does not.
  const atBound = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 40, lastBeatAtMs: issuedAtMs + 51000 }),
    60000,
    61000,
  );
  assert.equal(atBound.ok, true);
  const pastBound = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 40, lastBeatAtMs: issuedAtMs + 50999 }),
    60000,
    61000,
  );
  assert.equal(pastBound.detail.reason, 'stale');
});

// A player who alt-tabs to answer a message, or who trips the window-too-small
// pause dialog, leaves the server window running while their run timer does
// not. Scaling the beat requirement by the window alone rejected them for a
// legitimate win - invisibly, and with no way to recover. The requirement is
// therefore scaled by the SHORTER of the window and the time they claim.
test('a paused or backgrounded chase is judged on the time it claims', () => {
  const issuedAtMs = 1000000;
  // 20 s of play inside a 140 s server window, with the beats a throttled tab
  // would actually have managed.
  const paused = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 5 }),
    20000,
    140000,
  );
  assert.equal(paused.ok, true, 'two minutes away must not cost a real win');

  // A long pause with an honest long claim is still judged on the claim.
  const longPause = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 12 }),
    45000,
    600000,
  );
  assert.equal(longPause.ok, true);

  // What the shorter window does NOT do is let a run through with no beats.
  const empty = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 1 }),
    20000,
    140000,
  );
  assert.equal(empty.code, 'insufficient_liveness');
  assert.equal(empty.detail.reason, 'count');
  assert.equal(empty.detail.needed, 3, 'scaled by the 23 s claim, not the 140 s window');
});

test('score validation enforces the per-mode floor', () => {
  assert.equal(check(baseRun(), 7999, 9000).code, 'below_floor');
  assert.equal(check(baseRun(), 8000, 9000).ok, true);

  const issuedAtMs = 1000000;
  const sim = baseRun({
    mode: 'simulation', issuedAtMs, chaseStartedAtMs: issuedAtMs + 20000,
  });
  assert.equal(check(sim, 14999, 16000).code, 'below_floor');
  assert.equal(check(sim, 15000, 16000).ok, true);
});

test('score validation enforces the simulation shot clock ceiling', () => {
  const issuedAtMs = 1000000;
  const sim = baseRun({
    mode: 'simulation', issuedAtMs, chaseStartedAtMs: issuedAtMs + 20000,
  });
  assert.equal(check(sim, 61000, 62000).ok, true);
  assert.equal(check(sim, 61001, 62000).code, 'above_sim_ceiling');
  assert.equal(check(baseRun(), 61001, 62000).ok, true, 'practice has no shot clock');
});

test('score validation rejects a run with an unknown mode', () => {
  assert.equal(check(baseRun({ mode: 'sandbox' }), 20000, 21000).code, 'invalid_mode');
});

test('beat spacing rule', () => {
  assert.equal(beatCounts(null, 1000), true);
  assert.equal(beatCounts(1000, 1000 + LIMITS.MIN_BEAT_SPACING_MS), true);
  assert.equal(beatCounts(1000, 1000 + LIMITS.MIN_BEAT_SPACING_MS - 1), false);
});

test('chain tokens are unguessable, run bound and counter bound', () => {
  const secret = 'server-secret-of-adequate-length-000000';
  const a = chain.tokenFor(secret, RUN_ID, 0);
  const b = chain.tokenFor(secret, RUN_ID, 1);
  const other = chain.tokenFor(secret, newRunToken(), 0);

  assert.equal(a.length, 32);
  assert.notEqual(a, b);
  assert.notEqual(a, other);
  assert.equal(chain.tokenFor(secret, RUN_ID, 0), a, 'derivation is deterministic');
  assert.notEqual(chain.tokenFor(`${secret}x`, RUN_ID, 0), a, 'a different secret is a different chain');
});

test('chain classification credits only the live token', () => {
  const secret = 'server-secret-of-adequate-length-000000';
  const at = (counter) => chain.tokenFor(secret, RUN_ID, counter);

  assert.equal(chain.classify(secret, RUN_ID, 4, at(4)), 'current');
  // Retired tokens are recognised for resync but never credit.
  assert.equal(chain.classify(secret, RUN_ID, 4, at(3)), 'stale');
  assert.equal(chain.classify(secret, RUN_ID, 4, at(1)), 'stale');
  assert.equal(chain.classify(secret, RUN_ID, 4, at(0)), 'invalid', 'beyond the resync window');
  // A token from the future cannot be produced without the secret, and is not
  // accepted even if guessed at.
  assert.equal(chain.classify(secret, RUN_ID, 4, at(5)), 'invalid');
  // A token from another run is worthless here.
  assert.equal(chain.classify(secret, RUN_ID, 4, chain.tokenFor(secret, newRunToken(), 4)), 'invalid');
  assert.equal(chain.classify(secret, RUN_ID, 0, 'z'.repeat(32)), 'invalid');
  assert.equal(chain.classify(secret, RUN_ID, 0, 'short'), 'invalid');
  assert.equal(chain.classify(secret, RUN_ID, 0, null), 'invalid');
});

test('rate limiter enforces a sliding window', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ now: () => nowMs });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(limiter.take('score:u', 6, 60000).allowed, true, `hit ${i}`);
  }
  const blocked = limiter.take('score:u', 6, 60000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(limiter.take('score:other', 6, 60000).allowed, true);
  nowMs += 60001;
  assert.equal(limiter.take('score:u', 6, 60000).allowed, true);
  limiter.stop();
});

test('rate limiter is hard bounded and stays flat under a fresh-key flood', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ now: () => nowMs, maxKeys: 500 });

  // Every key fresh, so nothing is ever expired to reclaim: the old
  // implementation grew without limit and ran a full scan per insert.
  for (let i = 0; i < 5000; i += 1) limiter.take(`flood:${i}`, 30, 60000);
  assert.equal(limiter.size(), 500, 'the map never exceeds its cap');
  assert.ok(limiter.evicted() >= 4500);

  // Cost per insert must not climb with the number of keys seen.
  const timeSlice = (start) => {
    const t0 = process.hrtime.bigint();
    for (let i = start; i < start + 2000; i += 1) limiter.take(`bench:${i}`, 30, 60000);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const early = timeSlice(0);
  const late = timeSlice(100000);
  assert.ok(late < early * 8 + 50, `insert cost grew: ${early}ms then ${late}ms`);
  assert.equal(limiter.size(), 500);
  limiter.stop();
});

test('rate limiter forgets keys once their window has passed', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ now: () => nowMs });
  limiter.take('a', 5, 60000);
  limiter.take('b', 5, 60000);
  assert.equal(limiter.size(), 2);
  nowMs += 60001;
  limiter.sweep();
  assert.equal(limiter.size(), 0);
  limiter.stop();
});

test('config rejects weak or missing settings and normalises origins', () => {
  assert.throws(() => loadConfig({}), /Missing required environment variables/);
  assert.throws(
    () => loadConfig({ ...TEST_ENV, SESSION_SECRET: 'too-short' }),
    /at least 32 characters/,
  );
  const config = loadConfig({
    ...TEST_ENV,
    GAME_ORIGIN: 'https://themizeguy.github.io/',
    BASE_URL: 'https://api.example.test/',
  });
  assert.equal(config.gameOrigin, 'https://themizeguy.github.io');
  assert.equal(config.gameReturnUrl, 'https://themizeguy.github.io/emoneyAimLabs/');
  assert.equal(config.redirectUri, 'https://api.example.test/auth/twitch/callback');
  assert.deepEqual(config.floors, { practice: 8000, simulation: 15000 });
  assert.deepEqual(config.winSigSalts, ['aimlab-95-v2.7']);
  assert.equal(config.winSigStrict, true);

  const rolling = loadConfig({ ...TEST_ENV, WIN_SIG_SALT: 'old-salt, new-salt' });
  assert.deepEqual(rolling.winSigSalts, ['old-salt', 'new-salt']);
  assert.equal(loadConfig({ ...TEST_ENV, WIN_SIG_STRICT: 'false' }).winSigStrict, false);
});
