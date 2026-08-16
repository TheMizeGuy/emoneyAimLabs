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
const { CHALLENGE_ROUNDS } = require('../challenge');
const { TEST_ENV } = require('./helpers');

const RUN_ID = newRunToken();
const CHAIN = 'a'.repeat(32);
const FLOORS = { practice: 8000, simulation: 15000 };

function baseRun(overrides = {}) {
  const run = {
    id: RUN_ID,
    userId: 'user-1',
    mode: 'practice',
    issuedAtMs: 1000000,
    chaseStartedAtMs: 1000000,
    challengeSeed: 'a'.repeat(43),
    challengeStartedAtMs: 1005000,
    challengeSolvedAtMs: 1008000,
    challengeCount: 1,
    challengeSolvedCount: 1,
    beats: 100,
    beatCounter: 0,
    consumed: false,
    failed: false,
    ...overrides,
  };
  if (run.mode === 'simulation') {
    if (!Object.hasOwn(overrides, 'challengeStartedAtMs')) {
      run.challengeStartedAtMs = Math.max(
        run.issuedAtMs + LIMITS.MIN_FLAPPY_PHASE_MS,
        run.chaseStartedAtMs - LIMITS.MIN_CHALLENGE_SOLVE_MS,
      );
    }
    if (!Object.hasOwn(overrides, 'challengeSolvedAtMs')) {
      run.challengeSolvedAtMs = run.challengeStartedAtMs + LIMITS.MIN_CHALLENGE_SOLVE_MS;
    }
  }
  return run;
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
  // A real Chase can end after the first witnessed beat. Requiring two paced
  // beats silently imposed a four-second floor the engine itself does not have.
  assert.equal(requiredBeats(0), 1);
  assert.equal(requiredBeats(8000), 1);
  assert.equal(requiredBeats(9999), 1);
  assert.equal(requiredBeats(14999), 1);
  // From 15 s the window drives it: floor(w/5000) - 1.
  assert.equal(requiredBeats(15000), 2);
  assert.equal(requiredBeats(20000), 3);
  assert.equal(requiredBeats(60000), 11);
  assert.equal(requiredBeats(300000), 59);
});

// The false-reject safety proof. The client beats at chase t=0 then every 5 s
// (unchanged by this fix), so a run of length T carries floor(T/5000) + 1
// credited beats, and the server demands max(1, floor(T/5000) - 1).
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

test('parseEventBody accepts only known types, complete challenge answers and ban reasons', () => {
  assert.deepEqual(parseEventBody({ type: 'flappy_death' }).value, { type: 'flappy_death' });
  assert.deepEqual(
    parseEventBody({ type: 'challenge_start', runId: RUN_ID }).value,
    { type: 'challenge_start', runId: RUN_ID },
  );
  const answers = Array.from({ length: CHALLENGE_ROUNDS }, (_, index) => index % 4);
  assert.deepEqual(
    parseEventBody({ type: 'challenge_solve', runId: RUN_ID, answers }).value,
    { type: 'challenge_solve', runId: RUN_ID, answers },
  );
  assert.equal(parseEventBody({ type: 'challenge_start' }).code, 'invalid_run_id');
  assert.equal(parseEventBody({ type: 'challenge_solve', runId: RUN_ID }).code, 'invalid_challenge_answer');
  assert.equal(parseEventBody({ type: 'challenge_solve', runId: RUN_ID, answers: [0, 1] }).code,
    'invalid_challenge_answer');
  const outOfRange = answers.slice();
  outOfRange[outOfRange.length - 1] = 4;
  assert.equal(parseEventBody({ type: 'challenge_solve', runId: RUN_ID, answers: outOfRange }).code,
    'invalid_challenge_answer');
  for (const reason of BAN_REASONS) {
    assert.deepEqual(
      parseEventBody({ type: 'ban', reason, runId: RUN_ID }).value,
      { type: 'ban', reason, runId: RUN_ID },
    );
  }
  assert.equal(parseEventBody({ type: 'ban' }).code, 'invalid_ban_reason');
  assert.equal(parseEventBody({ type: 'ban', reason: 'timeout' }).code, 'invalid_run_id');
  assert.equal(parseEventBody({ type: 'ban', reason: 'timeout', runId: 'old' }).code, 'invalid_run_id');
  assert.equal(parseEventBody({ type: 'ban', reason: 'because' }).code, 'invalid_ban_reason');
  assert.equal(parseEventBody({ type: 'chase_win' }).code, 'invalid_event_type');
  assert.equal(parseEventBody({ type: 'FLAPPY_DEATH' }).code, 'invalid_event_type');
  assert.equal(parseEventBody(null).code, 'invalid_body');
});

test('parseScoreBody enforces types and sanity caps without trusting cosmetic counters', () => {
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

  // These are client-reported display stats, not security evidence. A real
  // one-approach win can produce one sample, while a forger can simply claim 3.
  assert.equal(parseScoreBody(claim({ misses: 0, nearMisses: 0 })).ok, true);
  assert.equal(parseScoreBody(claim({ nearMisses: 2 })).ok, true);
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

test('score validation requires a fresh server-witnessed visual challenge', () => {
  assert.equal(
    check(baseRun({
      challengeSeed: null,
      challengeStartedAtMs: null,
      challengeSolvedAtMs: null,
      challengeCount: 0,
      challengeSolvedCount: 0,
    }), 20000, 21000).code,
    'challenge_required',
  );
  assert.equal(
    check(baseRun({ challengeSolvedAtMs: null, challengeSolvedCount: 0 }), 20000, 21000).code,
    'challenge_required',
  );
  assert.equal(
    check(baseRun({ challengeCount: 2, challengeSolvedCount: 1 }), 20000, 21000).code,
    'challenge_required',
  );
  assert.equal(
    check(baseRun({ challengeCount: 2, challengeSolvedCount: 2 }), 20000, 21000).code,
    'challenge_required',
    'one solved puzzle cannot be replayed into a second server cycle',
  );
  assert.equal(
    check(baseRun({
      challengeStartedAtMs: 1005000,
      challengeSolvedAtMs: 1005000 + LIMITS.MIN_CHALLENGE_SOLVE_MS - 1,
    }), 20000, 21000).code,
    'challenge_required',
  );
  assert.equal(
    check(baseRun({
      challengeStartedAtMs: 1005000,
      challengeSolvedAtMs: 1005000 + LIMITS.MIN_CHALLENGE_SOLVE_MS,
    }), 20000, 21000).ok,
    true,
  );

  assert.equal(check(baseRun({
    challengeStartedAtMs: 1000000 + LIMITS.MIN_PRACTICE_CHALLENGE_OFFSET_MS - 1,
    challengeSolvedAtMs: 1000000 + LIMITS.MIN_PRACTICE_CHALLENGE_OFFSET_MS
      + LIMITS.MIN_CHALLENGE_SOLVE_MS,
  }), 20000, 21000).code, 'challenge_required',
  'Practice cannot start verification before its requested random window');
  assert.equal(check(baseRun({
    challengeStartedAtMs: 1000000 + LIMITS.MAX_PRACTICE_CHALLENGE_OFFSET_MS + 1,
    challengeSolvedAtMs: 1000000 + LIMITS.MAX_PRACTICE_CHALLENGE_OFFSET_MS
      + LIMITS.MIN_CHALLENGE_SOLVE_MS + 1,
  }), 20000, 21000).code, 'challenge_required',
  'Practice cannot defer verification until an arbitrary later point');

  const simulation = baseRun({
    mode: 'simulation',
    issuedAtMs: 1000000,
    chaseStartedAtMs: 1020000,
    chaseStartBeats: 4,
    challengeStartedAtMs: 1016000,
    challengeSolvedAtMs: 1016000 + LIMITS.MIN_CHALLENGE_SOLVE_MS,
  });
  assert.equal(check(simulation, 20000, 21000).ok, true,
    'Simulation accepts a challenge between Flappy and Chase');
  assert.equal(check(baseRun({
    ...simulation,
    challengeStartedAtMs: 1020001,
    challengeSolvedAtMs: 1020001 + LIMITS.MIN_CHALLENGE_SOLVE_MS,
  }), 20000, 21000).code, 'challenge_required',
  'Simulation cannot move the challenge into its scored Chase window');
  assert.equal(check(baseRun({
    ...simulation,
    challengeStartedAtMs: 1000000 + LIMITS.MIN_FLAPPY_PHASE_MS - 1,
    challengeSolvedAtMs: 1000000 + LIMITS.MIN_FLAPPY_PHASE_MS
      + LIMITS.MIN_CHALLENGE_SOLVE_MS,
  }), 20000, 21000).code, 'challenge_required',
  'Simulation cannot overlap verification with the minimum Flappy window');
  assert.equal(check(baseRun({
    ...simulation,
    challengeSolvedAtMs: 1020000 - LIMITS.MAX_CHALLENGE_TO_CHASE_MS - 1,
  }), 20000, 21000).code, 'challenge_required',
  'Simulation cannot solve verification and then defer Chase indefinitely');
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
      chaseStartBeats: 4,
    });
  }
  // Ten pipes cannot be cleared in three seconds.
  assert.equal(check(sim(3000), 20000, 21000).code, 'flappy_phase_too_short');
  assert.equal(check(sim(11999), 20000, 21000).code, 'flappy_phase_too_short');
  assert.equal(check(sim(LIMITS.MIN_FLAPPY_PHASE_MS + LIMITS.MIN_CHALLENGE_SOLVE_MS),
    20000, 21000).ok, true);
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
  // the explicit beats here. Practice's three-second challenge is excluded
  // from the score that must match the server window.
  assert.equal(check(baseRun({ beats: 200 }), 20000, LIMITS.RUN_TTL_MS + 1).code, 'run_expired');
  assert.equal(
    check(baseRun({ beats: 200 }), LIMITS.RUN_TTL_MS - 3000, LIMITS.RUN_TTL_MS).ok,
    true,
  );
  // A clock that runs backwards.
  assert.equal(check(baseRun(), 20000, -5000).code, 'run_expired');
});

test('score validation rejects a time longer than the chase the server timed', () => {
  assert.equal(check(baseRun(), 20000, 16000).code, 'time_exceeds_elapsed');
  assert.equal(
    check(baseRun(), 20000, 20000).ok,
    true,
    'three seconds beyond the scored server window is tolerated',
  );
});

test('score validation rejects a claim materially shorter than the server clock', () => {
  const waitedOut = check(baseRun({ beats: 5, lastBeatAtMs: 1021000 }), 8000, 21000);
  assert.equal(waitedOut.code, 'time_below_elapsed');

  const networkMargin = check(baseRun({ beats: 5, lastBeatAtMs: 1021000 }), 19500, 21000);
  assert.equal(networkMargin.ok, true, 'ordinary request timing stays inside the lower allowance');
});

test('Practice verification time is excluded from the server-observed score window', () => {
  const run = baseRun({
    challengeStartedAtMs: 1005000,
    challengeSolvedAtMs: 1010000,
    beats: 5,
    lastBeatAtMs: 1025000,
  });
  assert.equal(check(run, 20000, 25000).ok, true,
    'five seconds spent on the puzzle does not inflate a 20 second score');
  assert.equal(check(run, 16000, 25000).code, 'time_below_elapsed');
  assert.equal(check(run, 24000, 25000).code, 'time_exceeds_elapsed');
});

test('score validation rejects a run without enough credited heartbeats', () => {
  // The three-second Practice challenge is excluded, so the 58 s scored window
  // needs floor(58000/5000) - 1 = 10 credited beats.
  const verdict = check(baseRun({ beats: 7, lastBeatAtMs: 1060000 }), 60000, 61000);
  assert.equal(verdict.code, 'insufficient_liveness');
  assert.equal(verdict.detail.reason, 'count');
  assert.equal(verdict.detail.needed, 10);
  assert.equal(verdict.detail.beats, 7);
  assert.equal(check(baseRun({ beats: 10, lastBeatAtMs: 1060000 }), 60000, 61000).ok, true);
});

test('simulation chase liveness cannot be prepaid during the flappy phase', () => {
  const issuedAtMs = 1000000;
  const run = baseRun({
    mode: 'simulation',
    issuedAtMs,
    chaseStartedAtMs: issuedAtMs + 55000,
    // Eleven paced beats landed before Chase. Only the final fresh beat landed
    // during Chase, so this is not a server-witnessed 60-second chase.
    chaseStartBeats: 11,
    beats: 12,
    lastBeatAtMs: issuedAtMs + 115000,
  });

  const verdict = check(run, 60000, 60000);
  assert.equal(verdict.code, 'insufficient_liveness');
  assert.equal(verdict.detail.phase, 'chase');
  assert.equal(verdict.detail.beats, 1);
  assert.equal(verdict.detail.needed, 11);
});

test('simulation requires server-witnessed liveness during the flappy phase too', () => {
  const issuedAtMs = 1000000;
  const run = baseRun({
    mode: 'simulation',
    issuedAtMs,
    chaseStartedAtMs: issuedAtMs + 20000,
    chaseStartBeats: 1,
    beats: 20,
    lastBeatAtMs: issuedAtMs + 39000,
  });

  const verdict = check(run, 20000, 20000);
  assert.equal(verdict.code, 'insufficient_liveness');
  assert.equal(verdict.detail.phase, 'flappy');
  assert.equal(verdict.detail.beats, 1);
  assert.equal(verdict.detail.needed, 3);
});

test('no score is accepted with zero beats, however short the window', () => {
  // The old rule made this pass: requiredBeats(8000) was 0, so the entire
  // chain, the paced crediting and the telemetry were bypassed by the only
  // claim worth forging - the floor, which is also rank 1.
  const forged = check(baseRun({ beats: 0, lastBeatAtMs: null }), 8000, 8100);
  assert.equal(forged.code, 'insufficient_liveness');
  assert.equal(forged.detail.reason, 'count');
  assert.equal(forged.detail.needed, 1);

  // One fresh, server-credited witness is the physical minimum for a sub-15 s
  // Chase and must not invent a longer gameplay floor.
  assert.equal(check(baseRun({ beats: 1, lastBeatAtMs: 1008000 }), 8000, 8100).ok, true);
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

  // A wall-clock rollback or corrupt future timestamp must fail closed rather
  // than turning a negative age into a permanently fresh heartbeat.
  const fromFuture = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 40, lastBeatAtMs: issuedAtMs + 61001 }),
    60000,
    61000,
  );
  assert.equal(fromFuture.code, 'insufficient_liveness');
  assert.equal(fromFuture.detail.reason, 'stale');
  assert.equal(fromFuture.detail.lastBeatAgeMs, -1);
});

// A timer-free pause is itself an exploit: a modified client could idle behind
// the small-window dialog while the server witnessed a long run, then submit a
// much shorter claim. Both clocks now charge pauses. Only the server-timestamped
// Practice challenge is excluded from the scored window.
test('a paused or backgrounded chase cannot submit a timer-free score', () => {
  const issuedAtMs = 1000000;
  const paused = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 5 }),
    20000,
    140000,
  );
  assert.equal(paused.code, 'time_below_elapsed');

  // A claim matching that wall-clock window remains valid with matching
  // liveness. The default Practice challenge removes three seconds.
  const honest = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 28 }),
    137000,
    140000,
  );
  assert.equal(honest.ok, true);

  // Matching the time is not enough without heartbeats spanning the run.
  const empty = check(
    baseRun({ issuedAtMs, chaseStartedAtMs: issuedAtMs, beats: 1 }),
    137000,
    140000,
  );
  assert.equal(empty.code, 'insufficient_liveness');
  assert.equal(empty.detail.reason, 'count');
  assert.equal(empty.detail.needed, 26);
});

test('score validation enforces the per-mode floor', () => {
  assert.equal(check(baseRun(), 7999, 9000).code, 'below_floor');
  assert.equal(check(baseRun(), 8000, 9000).ok, true);

  const issuedAtMs = 1000000;
  const sim = baseRun({
    mode: 'simulation', issuedAtMs, chaseStartedAtMs: issuedAtMs + 20000, chaseStartBeats: 4,
  });
  assert.equal(check(sim, 14999, 16000).code, 'below_floor');
  assert.equal(check(sim, 15000, 16000).ok, true);
});

test('score validation enforces the simulation shot clock ceiling', () => {
  const issuedAtMs = 1000000;
  const sim = baseRun({
    mode: 'simulation', issuedAtMs, chaseStartedAtMs: issuedAtMs + 20000, chaseStartBeats: 4,
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

test('config refuses values that would silently weaken anti-cheat or redirect trust', () => {
  const invalid = [
    [{ PORT: '3000junk' }, /Invalid PORT/],
    [{ PORT: '0' }, /Invalid PORT/],
    [{ PORT: '65536' }, /Invalid PORT/],
    [{ FLOOR_PRACTICE_MS: '699' }, /Invalid FLOOR_PRACTICE_MS/],
    [{ FLOOR_SIM_MS: '699' }, /Invalid FLOOR_SIM_MS/],
    [{ FLOOR_SIM_MS: '61001' }, /Invalid FLOOR_SIM_MS/],
    [{ SESSION_TTL_MS: '0' }, /Invalid SESSION_TTL_MS/],
    [{ OAUTH_STATE_TTL_MS: '0' }, /Invalid OAUTH_STATE_TTL_MS/],
    [{ OAUTH_STATE_TTL_MS: '900001' }, /Invalid OAUTH_STATE_TTL_MS/],
    [{ WIN_SIG_STRICT: 'flase' }, /Invalid WIN_SIG_STRICT/],
    [{ WIN_SIG_SALT: ', ,' }, /WIN_SIG_SALT/],
    [{ GAME_ORIGIN: 'javascript:alert(1)' }, /Invalid GAME_ORIGIN/],
    [{ GAME_ORIGIN: 'http://example.test' }, /Invalid GAME_ORIGIN/],
    [{ GAME_ORIGIN: 'https://themizeguy.github.io/not-an-origin' }, /Invalid GAME_ORIGIN/],
    [{ BASE_URL: 'http://api.example.test' }, /Invalid BASE_URL/],
    [{ BASE_URL: 'https://user:password@api.example.test' }, /Invalid BASE_URL/],
    [{ BASE_URL: 'https://api.example.test/prefix' }, /Invalid BASE_URL/],
    [{ GAME_RETURN_PATH: '//attacker.example/callback' }, /Invalid GAME_RETURN_PATH/],
    [{ TWITCH_CLIENT_ID: '   ' }, /Missing required environment variables/],
  ];

  for (const [overrides, expected] of invalid) {
    assert.throws(() => loadConfig({ ...TEST_ENV, ...overrides }), expected);
  }

  const config = loadConfig({
    ...TEST_ENV,
    PORT: '65535',
    FLOOR_PRACTICE_MS: '9000',
    FLOOR_SIM_MS: '16000',
    SESSION_TTL_MS: '60000',
    OAUTH_STATE_TTL_MS: '60000',
    WIN_SIG_STRICT: 'YES',
    WIN_SIG_SALT: ' current , current , previous ',
  });
  assert.equal(config.port, 65535);
  assert.deepEqual(config.floors, { practice: 9000, simulation: 16000 });
  assert.equal(config.winSigStrict, true);
  assert.deepEqual(config.winSigSalts, ['current', 'previous']);

  const engineFloors = loadConfig({
    ...TEST_ENV,
    FLOOR_PRACTICE_MS: '700',
    FLOOR_SIM_MS: '700',
  });
  assert.deepEqual(engineFloors.floors, { practice: 700, simulation: 700 });

  const localDevelopment = loadConfig({
    ...TEST_ENV,
    GAME_ORIGIN: 'http://localhost:8080',
    BASE_URL: 'http://127.0.0.1:3000',
  });
  assert.equal(localDevelopment.gameOrigin, 'http://localhost:8080');
  assert.equal(localDevelopment.baseUrl, 'http://127.0.0.1:3000');
});
