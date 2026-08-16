'use strict';

const crypto = require('node:crypto');
const { CHALLENGE_ROUNDS } = require('./challenge');

// Pure validation logic for the eMoney Aim Labs leaderboard API.
// Nothing here touches the database, the network, or the clock: every input is
// an argument, so the whole anti-cheat surface is unit-testable.
//
// Governing principle (V3.3): client numbers are claims, the server's own clock
// is truth. A claim is accepted only when the server witnessed a run that could
// plausibly have produced it.

const MODES = Object.freeze(['practice', 'simulation']);

// Client-reported cosmetic events. Nothing on the leaderboard depends on these:
// a flappy death is a vanity counter, a ban is flavour text on a run that the
// server already knows was never scored.
const EVENT_TYPES = Object.freeze([
  'flappy_death', 'ban', 'challenge_start', 'challenge_solve',
]);
const BAN_REASONS = Object.freeze(['captcha-fail', 'captcha-timeout', 'timeout']);

// Twitch user ids are numeric strings; the wider character class here just
// keeps the route from passing anything exotic to the database.
const TWITCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isTwitchId(value) {
  return typeof value === 'string' && TWITCH_ID_RE.test(value);
}

const LIMITS = Object.freeze({
  // Outer bound on a run row's life, whatever phase it is in.
  MAX_RUN_AGE_MS: 2 * 60 * 60 * 1000,
  // A chase must be scored within this long of its own start.
  RUN_TTL_MS: 10 * 60 * 1000,
  // Conservative server-observed floor. The client physics need 15.922 s from
  // the earliest accepted ready input through the victory handoff; this leaves
  // under four seconds for a cold run-registration response to land after the
  // local gauntlet has already started.
  MIN_FLAPPY_PHASE_MS: 12000,
  // Nobody grinds the gauntlet longer than this in one sitting.
  MAX_FLAPPY_PHASE_MS: 30 * 60 * 1000,
  // Claimed time can never exceed the chase phase the server timed, plus a
  // small allowance for network latency and clock skew.
  ELAPSED_TOLERANCE_MS: 3000,
  // A client also cannot wait out a live server window and then claim a much
  // shorter score. Registration/submission latency can reverse a small part of
  // the delta, so the lower-side allowance is deliberately non-zero and tighter.
  EARLY_CLAIM_TOLERANCE_MS: 1500,
  // Longest claimable run time.
  MAX_TIME_MS: 2 * 60 * 60 * 1000,
  // Simulation has a 60 s shot clock in the client (V2.19); anything past the
  // clock plus one second of slack is impossible.
  SIM_CEILING_MS: 61000,
  // Heartbeat cadence the client is asked to keep.
  BEAT_INTERVAL_MS: 5000,
  // Beats forgiven against the server-witnessed window (startup, tab
  // throttling, one dropped request).
  BEAT_SLACK: 1,
  // A clean Chase can finish after its first server-witnessed beat. Requiring
  // two paced beats imposed an undocumented four-second minimum on a client
  // whose actual arming gate is 700 ms.
  MIN_CREDITED_BEATS: 1,
  // The most recent credited beat must be this fresh at the moment the score
  // is posted, so beats have to straddle the chase window instead of bunching
  // at its start.
  MAX_LAST_BEAT_AGE_MS: 10000,
  // Two beats closer together than this credit as one, measured on the server
  // clock. Stuffing a hundred beats into a second credits one.
  MIN_BEAT_SPACING_MS: 4000,
  // Sanity bound on the cosmetic counters.
  MAX_STAT: 10000,
  // The visual puzzle is deliberately server-timed. A sub-second start/solve
  // pair is a protocol script, not a person finding and dragging the piece.
  MIN_CHALLENGE_SOLVE_MS: 1200,
  // Kept in lockstep with the client's visible challenge countdown.
  MAX_CHALLENGE_SOLVE_MS: 60000,
  // Practice promises an early random interruption, not a puzzle that can be
  // prepaid at run creation or deferred until after the meaningful play.
  MIN_PRACTICE_CHALLENGE_OFFSET_MS: 500,
  MAX_PRACTICE_CHALLENGE_OFFSET_MS: 10000,
  // Simulation must flow promptly from its post-Flappy solve into Chase.
  MAX_CHALLENGE_TO_CHASE_MS: 10000,
});

// Run ids are opaque 192-bit random tokens, not uuids: more entropy than the
// 122 random bits a uuid v4 carries, and unguessable by construction.
const RUN_TOKEN_BYTES = 24;
const RUN_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
// The client's win signature is 16 hex characters (see js/chase.js, layer G).
const WIN_SIG_RE = /^[0-9a-f]{16}$/i;
const CHALLENGE_SEED_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_WIN_SIG_SALT = 'aimlab-95-v2.7';

function newRunToken() {
  return crypto.randomBytes(RUN_TOKEN_BYTES).toString('base64url');
}

function isRunToken(value) {
  return typeof value === 'string' && RUN_TOKEN_RE.test(value);
}

function isMode(value) {
  return MODES.includes(value);
}

function isSafeInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// How many credited heartbeats a run must carry, driven off the chase window
// the SERVER timed - never off the claimed time.
//
// The first beat is enough for a sub-cadence win; longer windows scale from the
// server clock and cannot be argued down by the caller. This is liveness, not a
// proof of skill: short records ultimately rely on the engine's physical floor.
function requiredBeats(chaseWindowMs) {
  const fromWindow = Math.floor(chaseWindowMs / LIMITS.BEAT_INTERVAL_MS) - LIMITS.BEAT_SLACK;
  return Math.max(LIMITS.MIN_CREDITED_BEATS, fromWindow);
}

// Body shape for POST /api/run.
function parseRunBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body' };
  }
  if (!isMode(body.mode)) return { ok: false, code: 'invalid_mode' };
  return { ok: true, value: { mode: body.mode } };
}

// The run token travels as `nonce` in the beat protocol and as `runId`
// everywhere else; both names mean the same opaque token.
function runIdFrom(body) {
  return body.runId === undefined ? body.nonce : body.runId;
}

// Body shape for POST /api/run/beat. `chain` is the last chain token the server
// handed out; `chase` marks the first beat sent after the chase segment starts,
// which is what stamps the phase boundary.
function parseBeatBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body' };
  }
  const runId = runIdFrom(body);
  if (!isRunToken(runId)) return { ok: false, code: 'invalid_run_id' };
  if (body.chase !== undefined && typeof body.chase !== 'boolean') {
    return { ok: false, code: 'invalid_body' };
  }
  if (typeof body.chain !== 'string' || body.chain.length === 0 || body.chain.length > 128) {
    return { ok: false, code: 'invalid_body' };
  }
  return {
    ok: true,
    value: { runId, chase: body.chase === true, chainToken: body.chain },
  };
}

// Body shape for POST /api/event.
function parseEventBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body' };
  }
  if (!EVENT_TYPES.includes(body.type)) return { ok: false, code: 'invalid_event_type' };
  if (body.type === 'ban') {
    if (!BAN_REASONS.includes(body.reason)) return { ok: false, code: 'invalid_ban_reason' };
    if (!isRunToken(body.runId)) return { ok: false, code: 'invalid_run_id' };
    return { ok: true, value: { type: 'ban', reason: body.reason, runId: body.runId } };
  }
  if (body.type === 'challenge_start') {
    if (!isRunToken(body.runId)) return { ok: false, code: 'invalid_run_id' };
    return { ok: true, value: { type: body.type, runId: body.runId } };
  }
  if (body.type === 'challenge_solve') {
    if (!isRunToken(body.runId)) return { ok: false, code: 'invalid_run_id' };
    if (
      !Array.isArray(body.answers)
      || body.answers.length !== CHALLENGE_ROUNDS
      || !body.answers.every((answer) => isSafeInt(answer, 0, 3))
    ) {
      return { ok: false, code: 'invalid_challenge_answer' };
    }
    return {
      ok: true,
      value: { type: body.type, runId: body.runId, answers: body.answers.slice() },
    };
  }
  return { ok: true, value: { type: body.type } };
}

// Body shape and plausibility floors for POST /api/score. All of it is DB-free,
// so a nonsense claim never reaches Postgres.
//
// Structural problems answer 400; values that are well formed but could not
// have come from a real win answer 422.
function parseScoreBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body' };
  }
  const runId = runIdFrom(body);
  if (!isRunToken(runId)) return { ok: false, code: 'invalid_run_id' };
  if (typeof body.sig !== 'string' || !WIN_SIG_RE.test(body.sig)) {
    return { ok: false, code: 'invalid_attestation' };
  }
  if (!isSafeInt(body.sus, 0, LIMITS.MAX_STAT)) {
    return { ok: false, code: 'invalid_attestation' };
  }
  if (!isSafeInt(body.timeMs, 1, LIMITS.MAX_TIME_MS)) {
    return { ok: false, code: 'time_out_of_range' };
  }
  if (!isSafeInt(body.misses, 0, LIMITS.MAX_STAT)) {
    return { ok: false, code: 'stats_out_of_range' };
  }
  if (!isSafeInt(body.nearMisses, 0, LIMITS.MAX_STAT)) {
    return { ok: false, code: 'stats_out_of_range' };
  }
  // The engine only reports a positive sus count when it caught the player
  // interfering with it. Belt and braces on top of the server-witnessed wall.
  if (body.sus > 0) return { ok: false, code: 'client_flagged' };
  return {
    ok: true,
    value: {
      runId,
      timeMs: body.timeMs,
      misses: body.misses,
      nearMisses: body.nearMisses,
      sus: body.sus,
      sig: body.sig.toLowerCase(),
    },
  };
}

function pad2(value, width) {
  return value.length >= width ? value : '0'.repeat(width - value.length) + value;
}

// The client hashes with SubtleCrypto where it exists and falls back to a
// doubled FNV-1a where it does not, so both are valid signatures for a run.
// Reimplemented here exactly as js/chase.js computes them.
function fnv16(message) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < message.length; i += 1) {
    h1 = Math.imul(h1 ^ message.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ message.charCodeAt(message.length - 1 - i), 0x85ebca6b) >>> 0;
  }
  return pad2(h1.toString(16), 8) + pad2(h2.toString(16), 8);
}

function sha16(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex').slice(0, 16);
}

function winSignatures(claim, salt = DEFAULT_WIN_SIG_SALT) {
  const message = `${claim.timeMs}|${claim.misses}|${claim.nearMisses}|${salt}`;
  return { sha: sha16(message), fnv: fnv16(message) };
}

// Constant-time string compare that tolerates length mismatches. Nothing here
// guards a secret (the salt is public), but every other compare in this service
// is hardened and a future reader should not have to wonder about this one.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// The salt is public (it ships in the client), so this signature proves the
// numbers travelled together from a real build - not that the player is honest.
// Friction on top of the wall, never the wall itself.
function verifyWinSignature(claim, salt = DEFAULT_WIN_SIG_SALT) {
  const expected = winSignatures(claim, salt);
  const given = String(claim.sig || '').toLowerCase();
  // Both branches always evaluate: no early exit on the first match.
  const matchesSha = safeEqual(given, expected.sha);
  const matchesFnv = safeEqual(given, expected.fnv);
  return matchesSha || matchesFnv;
}

// The heart of the anti-cheat: given the run row the server issued, the caller,
// the current time and the claim, decide whether the claim is possible.
//
// Order is fixed and tested:
//    1. run_not_found        - unknown run, or a run belonging to someone else
//    2. run_consumed         - replay of an already-scored run
//    3. run_closed           - run already counted as an abandoned chase
//    4. run_expired          - run row older than MAX_RUN_AGE_MS
//    5. chase_not_started    - no server-stamped chase phase to measure against
//    6. flappy_phase_too_short - ten pipes cleared impossibly fast
//    7. run_expired          - flappy phase absurdly long, or chase phase older
//                              than RUN_TTL_MS
//    8. time_exceeds_elapsed - claim longer than the chase phase the server timed
//    9. challenge_required   - no complete server-timed visual verification
//   10. time_exceeds_elapsed/time_below_elapsed - claim disagrees with the
//                              server-observed scored window
//   11. insufficient_liveness - too few phase-specific credited heartbeats for
//       the windows the server timed, or a most-recent beat too old to be live
//   12. below_floor          - faster than the mode's physical floor
//   13. above_sim_ceiling    - simulation claim past the 60 s shot clock
function validateRunForScore(input) {
  const { run, userId, nowMs, timeMs, floors } = input;

  if (!run || run.userId !== userId) return { ok: false, code: 'run_not_found' };
  if (run.consumed) return { ok: false, code: 'run_consumed' };
  // Already tallied as a chase failure; scoring it now would double-count.
  if (run.failed) return { ok: false, code: 'run_closed' };
  if (!isMode(run.mode)) return { ok: false, code: 'invalid_mode' };

  const runAgeMs = nowMs - run.issuedAtMs;
  if (!Number.isFinite(runAgeMs) || runAgeMs < 0 || runAgeMs > LIMITS.MAX_RUN_AGE_MS) {
    return { ok: false, code: 'run_expired' };
  }

  // Practice runs are stamped at creation; simulation runs are stamped by the
  // first heartbeat that declares the chase has begun.
  if (run.chaseStartedAtMs === null || run.chaseStartedAtMs === undefined) {
    return { ok: false, code: 'chase_not_started' };
  }
  const flappyPhaseMs = run.chaseStartedAtMs - run.issuedAtMs;
  if (flappyPhaseMs < 0) return { ok: false, code: 'chase_not_started' };
  if (run.mode === 'simulation') {
    if (flappyPhaseMs < LIMITS.MIN_FLAPPY_PHASE_MS) {
      return { ok: false, code: 'flappy_phase_too_short', detail: { flappyPhaseMs } };
    }
    if (flappyPhaseMs > LIMITS.MAX_FLAPPY_PHASE_MS) {
      return { ok: false, code: 'run_expired', detail: { flappyPhaseMs } };
    }

    // Beats from the gauntlet cannot be reused as evidence that Chase stayed
    // live. The database snapshots this count when it stamps the phase boundary.
    const flappyBeats = run.chaseStartBeats;
    const flappyNeeded = requiredBeats(flappyPhaseMs);
    if (!Number.isInteger(flappyBeats) || flappyBeats < flappyNeeded || flappyBeats > run.beats) {
      return {
        ok: false,
        code: 'insufficient_liveness',
        detail: {
          phase: 'flappy', reason: 'count', needed: flappyNeeded,
          beats: Number.isInteger(flappyBeats) ? flappyBeats : null, flappyPhaseMs,
        },
      };
    }
  }

  const chasePhaseMs = nowMs - run.chaseStartedAtMs;
  if (chasePhaseMs < 0 || chasePhaseMs > LIMITS.RUN_TTL_MS) {
    return { ok: false, code: 'run_expired', detail: { chasePhaseMs } };
  }
  if (timeMs > chasePhaseMs + LIMITS.ELAPSED_TOLERANCE_MS) {
    return { ok: false, code: 'time_exceeds_elapsed', detail: { chasePhaseMs } };
  }

  // Every leaderboard win must cross the visible canvas challenge. These are
  // server timestamps written by two authenticated event requests, not fields
  // copied out of the score body. Requiring the latest started cycle to be the
  // latest solved cycle also prevents an old solve from paying for a newer
  // challenge that was shown during a longer run.
  const challengeMs = run.challengeSolvedAtMs - run.challengeStartedAtMs;
  if (
    !Number.isInteger(run.challengeCount)
    || !Number.isInteger(run.challengeSolvedCount)
    || run.challengeCount !== 1
    || run.challengeSolvedCount !== 1
    || typeof run.challengeSeed !== 'string'
    || !CHALLENGE_SEED_RE.test(run.challengeSeed)
    || !Number.isFinite(run.challengeStartedAtMs)
    || !Number.isFinite(run.challengeSolvedAtMs)
    || run.challengeStartedAtMs < run.issuedAtMs
    || run.challengeSolvedAtMs > nowMs
    || challengeMs < LIMITS.MIN_CHALLENGE_SOLVE_MS
    || challengeMs > LIMITS.MAX_CHALLENGE_SOLVE_MS
  ) {
    return { ok: false, code: 'challenge_required' };
  }
  if (run.mode === 'practice') {
    const challengeOffsetMs = run.challengeStartedAtMs - run.chaseStartedAtMs;
    if (
      challengeOffsetMs < LIMITS.MIN_PRACTICE_CHALLENGE_OFFSET_MS
      || challengeOffsetMs > LIMITS.MAX_PRACTICE_CHALLENGE_OFFSET_MS
    ) return { ok: false, code: 'challenge_required' };
  } else {
    const challengeOffsetMs = run.challengeStartedAtMs - run.issuedAtMs;
    const challengeToChaseMs = run.chaseStartedAtMs - run.challengeSolvedAtMs;
    if (
      challengeOffsetMs < LIMITS.MIN_FLAPPY_PHASE_MS
      || challengeToChaseMs < 0
      || challengeToChaseMs > LIMITS.MAX_CHALLENGE_TO_CHASE_MS
    ) return { ok: false, code: 'challenge_required' };
  }

  // Practice displays the puzzle after its Chase clock begins, but puzzle time
  // is not gameplay time. Simulation completes it before Chase and therefore
  // has nothing to subtract. Both timestamps are server-owned.
  const scoredChasePhaseMs = chasePhaseMs - (run.mode === 'practice' ? challengeMs : 0);
  if (!Number.isFinite(scoredChasePhaseMs) || scoredChasePhaseMs < 0) {
    return { ok: false, code: 'challenge_required' };
  }
  if (timeMs > scoredChasePhaseMs + LIMITS.ELAPSED_TOLERANCE_MS) {
    return {
      ok: false,
      code: 'time_exceeds_elapsed',
      detail: { chasePhaseMs, scoredChasePhaseMs },
    };
  }
  if (timeMs < scoredChasePhaseMs - LIMITS.EARLY_CLAIM_TOLERANCE_MS) {
    return {
      ok: false,
      code: 'time_below_elapsed',
      detail: { chasePhaseMs, scoredChasePhaseMs },
    };
  }

  // Liveness. Two independent conditions: enough credited beats, and a
  // most-recent beat that is actually recent - the second is what stops a
  // forger front-loading every beat and then sleeping out the window.
  //
  // The two-sided elapsed checks pin the claim to the server-observed scored
  // window. Taking the shorter value here only absorbs the permitted request
  // timing margin; it cannot turn a long pause into a shorter valid score.
  //
  // This cannot be argued down into nothing: a claim can never exceed the
  // window beyond the network allowance (the elapsed check above), and at the
  // mode floor the clamp still demands one fresh, credited chained witness.
  // The clamp and freshness rule are liveness evidence, not proof of skill.
  const beatWindowMs = Math.min(scoredChasePhaseMs, timeMs + LIMITS.ELAPSED_TOLERANCE_MS);
  const needed = requiredBeats(beatWindowMs);
  const chaseStartBeats = run.mode === 'simulation' ? run.chaseStartBeats : 0;
  const chaseBeats = run.beats - chaseStartBeats;
  if (!Number.isInteger(chaseBeats) || chaseBeats < needed) {
    return {
      ok: false,
      code: 'insufficient_liveness',
      detail: { phase: 'chase', reason: 'count', needed, beats: chaseBeats, chasePhaseMs },
    };
  }
  const lastBeatAgeMs = run.lastBeatAtMs === null || run.lastBeatAtMs === undefined
    ? null
    : nowMs - run.lastBeatAtMs;
  if (
    lastBeatAgeMs === null
    || lastBeatAgeMs < 0
    || lastBeatAgeMs > LIMITS.MAX_LAST_BEAT_AGE_MS
  ) {
    return {
      ok: false,
      code: 'insufficient_liveness',
      detail: { reason: 'stale', lastBeatAgeMs, chasePhaseMs },
    };
  }

  const floorMs = floors[run.mode];
  if (!Number.isFinite(floorMs)) return { ok: false, code: 'invalid_mode' };
  if (timeMs < floorMs) return { ok: false, code: 'below_floor', detail: { floorMs } };

  if (run.mode === 'simulation' && timeMs > LIMITS.SIM_CEILING_MS) {
    return { ok: false, code: 'above_sim_ceiling', detail: { ceilingMs: LIMITS.SIM_CEILING_MS } };
  }

  return { ok: true, value: { chasePhaseMs, scoredChasePhaseMs, flappyPhaseMs } };
}

// A heartbeat is credited only when the server's own clock says enough time has
// passed since the last credited one.
function beatCounts(lastBeatAtMs, nowMs) {
  if (lastBeatAtMs === null || lastBeatAtMs === undefined) return true;
  return nowMs - lastBeatAtMs >= LIMITS.MIN_BEAT_SPACING_MS;
}

module.exports = {
  MODES,
  EVENT_TYPES,
  BAN_REASONS,
  LIMITS,
  DEFAULT_WIN_SIG_SALT,
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
  safeEqual,
  validateRunForScore,
  beatCounts,
};
