'use strict';

const express = require('express');
const {
  LIMITS,
  isMode,
  isTwitchId,
  parseRunBody,
  parseBeatBody,
  parseEventBody,
  parseScoreBody,
  verifyWinSignature,
  validateRunForScore,
} = require('./validation');
const {
  sendError,
  asyncRoute,
  rateLimit,
  requireSessionFor,
  clientAddress,
} = require('./middleware');
const { clearedSessionCookie } = require('./session');
const { LEADERBOARD_LIMIT, RUN_HISTORY_LIMIT } = require('./store');
const chain = require('./chain');
const {
  buildChallenge,
  matchesAnswers,
  newChallengeSeed,
} = require('./challenge');
const { MODES } = require('./validation');

const MINUTE_MS = 60 * 1000;
const SCORE_LIMIT = 6;
const BEAT_LIMIT = 30;
const EVENT_LIMIT = 30;
const LEADERBOARD_RATE_LIMIT = 60;
const PLAYER_RATE_LIMIT = 60;
const STATS_RATE_LIMIT = 30;
const FEED_RATE_LIMIT = 10;
// Not in the published contract: a legitimate client opens one run per chase,
// so this only ever bites a script spamming run tokens.
const RUN_LIMIT = 20;
const SWEEP_INTERVAL_MS = MINUTE_MS;

// How far a claim has to fall short of the server-timed chase before the server
// will say out loud that it was forged. This is not a validation threshold -
// LIMITS.EARLY_CLAIM_TOLERANCE_MS still refuses the score at 1.5 s and nothing
// below relaxes it. It exists because the claim is structurally smaller than the
// server's window by one or two round trips (the client deducts the challenge
// across a full request, and the score POST waits on a beat that is already in
// flight), so at 1.5 s a slow mobile link earned a public "server clock
// manipulation" line in the feed and a clock-forgery ban. A forger claims a
// wildly short time and is still branded; a bad connection is only refused.
const CLOCK_FORGERY_MARGIN_MS = 8000;

const STATUS_BY_CODE = Object.freeze({
  invalid_body: 400,
  invalid_run_id: 400,
  invalid_mode: 400,
  invalid_event_type: 400,
  invalid_ban_reason: 400,
  invalid_challenge_answer: 400,
  challenge_not_started: 400,
  challenge_wrong_phase: 409,
  challenge_too_fast: 422,
  challenge_expired: 422,
  challenge_incorrect: 422,
  challenge_retry_later: 429,
  challenge_required: 422,
  invalid_player_id: 400,
  player_not_found: 404,
  invalid_attestation: 400,
  invalid_signature: 400,
  chain_invalid: 403,
  chase_not_started: 400,
  flappy_phase_too_short: 400,
  run_expired: 400,
  time_exceeds_elapsed: 400,
  time_below_elapsed: 400,
  insufficient_liveness: 400,
  below_floor: 400,
  above_sim_ceiling: 400,
  time_out_of_range: 422,
  stats_out_of_range: 422,
  client_flagged: 422,
  run_not_found: 404,
  run_consumed: 409,
  run_closed: 409,
});

/* Every message names WHICH check refused the score and what the player would
   have to do differently, in game terms. What it still never echoes (V3.3 rule
   7) is the threshold itself, a stored value, or anything internal: "your run
   was shorter than this mode's minimum" is diagnosable, "shorter than 2000 ms"
   hands a forger the number to beat. The machine-readable code travels beside
   the message, and the client prints it, so a refusal can be reported exactly
   rather than described. */
const MESSAGE_BY_CODE = Object.freeze({
  invalid_body: 'Malformed request body',
  invalid_run_id: 'Malformed run id',
  invalid_mode: 'Unknown mode',
  invalid_event_type: 'Unknown event type',
  invalid_ban_reason: 'Unknown ban reason',
  invalid_challenge_answer: 'Submit exactly one choice for every verification round',
  challenge_not_started: 'That visual verification was never started',
  challenge_wrong_phase: 'That visual verification was started outside its permitted game phase',
  challenge_too_fast: 'That visual verification completed too quickly to be trusted',
  challenge_expired: 'That visual verification expired before it was completed',
  challenge_incorrect: 'That visual verification did not match',
  challenge_retry_later: 'Wait briefly before starting another verification attempt',
  challenge_required: 'Complete the visual verification before posting a score',
  invalid_player_id: 'Malformed player id',
  player_not_found: 'No such player',
  invalid_attestation: 'Missing or malformed run attestation',
  invalid_signature: 'Run attestation did not verify',
  chain_invalid: 'The heartbeats that prove a run is being played did not line up',
  chase_not_started: 'That run never reached the popup chase',
  flappy_phase_too_short: 'The bird gauntlet was skipped rather than played',
  run_expired: 'That run sat unscored for too long to be trusted',
  time_exceeds_elapsed: 'The time claimed is longer than the run has existed',
  time_below_elapsed: 'The time claimed is shorter than the server-observed run',
  insufficient_liveness: 'That run was not held open long enough to have been played',
  below_floor: 'That time is below the fastest this mode can honestly be finished',
  above_sim_ceiling: 'That time is longer than the simulation shot clock allows',
  time_out_of_range: 'The time submitted is not a number this game can produce',
  stats_out_of_range: 'The click and miss counters are not numbers this game can produce',
  client_flagged: 'The game flagged interference during that run, so it was not counted',
  run_not_found: 'No such run',
  run_consumed: 'That run has already been scored',
  run_closed: 'That run was already closed as abandoned',
});

function publicEntry(row, rank, isYou) {
  return {
    rank,
    // Public identity, the same id GET /api/player/:twitchId takes: it is what
    // lets a leaderboard row open that player's card.
    twitchId: row.userId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    timeMs: row.timeMs,
    misses: row.misses,
    // Server-derived, never submitted: one click per miss, plus the win.
    clicks: row.clicks,
    achievedAt: row.achievedAt.toISOString(),
    // Three distinct fail counters, all server-witnessed except flappyFails.
    totalFails: row.totalFails || 0,
    flappyFails: row.flappyFails || 0,
    chaseFails: row.chaseFails || 0,
    isYou,
  };
}

function createApiRouter(deps) {
  const { config, store, limiter, recorder, feed, now, log } = deps;
  const router = express.Router();
  const requireSession = requireSessionFor(recorder, store);
  let lastRunSweepMs = 0;
  let lastRejectionPruneMs = 0;

  // Records the rejection, then answers with the shared error shape.
  function fail(req, res, code, payload) {
    recorder.record(req, code, payload || {});
    return sendError(res, STATUS_BY_CODE[code] || 400, code, MESSAGE_BY_CODE[code] || 'Rejected');
  }

  function sendChallengeRetry(res, retryAfterMs, nowMs) {
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAfterMs - nowMs) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return sendError(
      res,
      429,
      'challenge_retry_later',
      MESSAGE_BY_CODE.challenge_retry_later,
      { retryAfterSeconds },
    );
  }

  // Every limiter key is derived from the authenticated session or the
  // connecting address - never from a value the caller puts in the body. The
  // beat limiter used to bucket on the request's own run id, so a fresh random
  // id per request landed in a fresh bucket and the limit never bit; one
  // session could then issue unbounded requests, each costing a run lookup.
  // A legitimate client holds exactly one open run, so per-user is equivalent
  // for honest play and finite for everyone else.
  const scoreLimit = rateLimit(
    limiter, (req) => `score:${req.session.sub}`, SCORE_LIMIT, MINUTE_MS, recorder.note,
  );
  const runLimit = rateLimit(
    limiter, (req) => `run:${req.session.sub}`, RUN_LIMIT, MINUTE_MS, recorder.note,
  );
  const eventLimit = rateLimit(
    limiter, (req) => `event:${req.session.sub}`, EVENT_LIMIT, MINUTE_MS, recorder.note,
  );
  const beatLimit = rateLimit(
    limiter, (req) => `beat:${req.session.sub}`, BEAT_LIMIT, MINUTE_MS, recorder.note,
  );
  const leaderboardLimit = rateLimit(
    limiter, (req) => `lb:${clientAddress(req)}`, LEADERBOARD_RATE_LIMIT, MINUTE_MS, recorder.note,
  );
  const playerLimit = rateLimit(
    limiter, (req) => `player:${clientAddress(req)}`, PLAYER_RATE_LIMIT, MINUTE_MS, recorder.note,
  );
  const statsLimit = rateLimit(
    limiter, (req) => `stats:${clientAddress(req)}`, STATS_RATE_LIMIT, MINUTE_MS, recorder.note,
  );
  const feedLimit = rateLimit(
    limiter, (req) => `feed:${clientAddress(req)}`, FEED_RATE_LIMIT, MINUTE_MS, recorder.note,
  );

  // Streams a batch of freshly closed runs to the live feed. Identity is looked
  // up once per user, and a failure here never affects the request that caused
  // it.
  async function streamFailures(failures) {
    if (!failures || failures.length === 0) return;
    try {
      const ids = [...new Set(failures.map((failure) => failure.userId))];
      const users = await store.getUsers(ids);
      const byId = new Map(users.map((user) => [user.id, user]));
      for (const failure of failures) {
        const user = byId.get(failure.userId);
        if (!user) continue;
        feed.emit('run_failed', {
          twitchId: user.id,
          name: user.displayName,
          avatar: user.avatarUrl,
          mode: failure.mode,
          reason: failure.failReason,
          phase: failure.phase,
        });
      }
    } catch (err) {
      log(`feed publish failed: ${err.code || 'error'}`);
    }
  }

  // Public shaming is intentionally narrower than the private rejection log.
  // Only signals an honest client cannot emit by accident are published.
  async function streamCheat(userId, reason) {
    try {
      const user = await store.getUser(userId);
      if (!user) return;
      feed.emit('cheat_detected', {
        twitchId: user.id,
        name: user.displayName,
        avatar: user.avatarUrl,
        reason,
      });
    } catch (err) {
      log(`feed publish failed: ${err.code || 'error'}`);
    }
  }

  // Background maintenance, piggybacked on traffic. Keep stale-run closure and
  // audit retention on independent clocks: every mutation should be able to
  // trigger retention, but a score/beat must validate its subject run before a
  // maintenance pass can close that same run as abandoned.
  //
  // Each timestamp is set BEFORE its await, so concurrent requests cannot both
  // pass the guard. The work underneath is idempotent regardless.
  async function maybeSweepRuns(nowDate) {
    const nowMs = nowDate.getTime();
    if (nowMs - lastRunSweepMs < SWEEP_INTERVAL_MS) return;
    lastRunSweepMs = nowMs;
    try {
      await streamFailures(await store.failStaleRuns(nowDate));
    } catch (err) {
      log(`stale run sweep failed: ${err.code || 'error'}`);
    }
  }

  async function maybePruneRejections(nowDate) {
    const nowMs = nowDate.getTime();
    if (nowMs - lastRejectionPruneMs < SWEEP_INTERVAL_MS) return;
    lastRejectionPruneMs = nowMs;
    try {
      await store.pruneRejections(nowDate);
    } catch (err) {
      log(`rejection prune failed: ${err.code || 'error'}`);
    }
  }

  router.get('/me', requireSession, asyncRoute(async (req, res) => {
    const user = await store.getUser(req.session.sub);
    if (!user) {
      // Session points at a user that no longer exists; drop the cookie.
      res.setHeader('Set-Cookie', clearedSessionCookie());
      return sendError(res, 401, 'unauthenticated', 'Sign in with Twitch first');
    }
    res.setHeader('Cache-Control', 'no-store');
    // Exactly the three identity fields the empty Twitch scope exposes, plus
    // the two failure counters the start screen shows. No email, ever.
    return res.json({
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      flappyFails: user.flappyFails,
      chaseFails: user.chaseFails,
    });
  }));

  // Opens a run and hands back the first link of its heartbeat chain.
  // Simulation runs open at flappy start, practice runs at chase start.
  router.post('/run', requireSession, runLimit, asyncRoute(async (req, res) => {
    const nowDate = now();
    await maybePruneRejections(nowDate);
    await maybeSweepRuns(nowDate);
    const parsed = parseRunBody(req.body);
    if (!parsed.ok) return fail(req, res, parsed.code, { mode: req.body && req.body.mode });

    const user = await store.getUser(req.session.sub);
    if (!user) {
      res.setHeader('Set-Cookie', clearedSessionCookie());
      return sendError(res, 401, 'unauthenticated', 'Sign in with Twitch first');
    }

    // Close the previous run and create its successor under one per-user
    // database lock. The schema independently forbids two open rows.
    const opened = await store.replaceOpenRun(user.id, parsed.value.mode, nowDate);
    await streamFailures(opened.failures);
    const { runId } = opened;
    // V3.8: run starts deliberately do NOT stream. Every start either becomes
    // a win or a failure, both of which do -- announcing the start too said
    // everything twice and drowned the lines that carry information.
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      runId,
      // Same value under the name the beat protocol uses.
      nonce: runId,
      chain: chain.tokenFor(config.sessionSecret, runId, 0),
    });
  }));

  // Liveness proof and phase stamp. The caller echoes the last chain token it
  // was handed; only the live token earns a credited beat, and crediting one
  // advances the chain so that token can never be used again.
  router.post('/run/beat', requireSession, beatLimit, asyncRoute(async (req, res) => {
    const nowDate = now();
    await maybePruneRejections(nowDate);
    const parsed = parseBeatBody(req.body);
    if (!parsed.ok) return fail(req, res, parsed.code);
    const { runId, chase, chainToken } = parsed.value;

    const run = await store.getRun(runId);
    if (!run || run.userId !== req.session.sub) return fail(req, res, 'run_not_found');
    if (run.consumed) return fail(req, res, 'run_consumed');
    if (run.failed) return fail(req, res, 'run_closed');

    if (nowDate.getTime() - run.issuedAtMs > LIMITS.MAX_RUN_AGE_MS) {
      return fail(req, res, 'run_expired');
    }

    const verdict = chain.classify(config.sessionSecret, run.id, run.beatCounter, chainToken);
    if (verdict === 'invalid') {
      return fail(req, res, 'chain_invalid', { counter: run.beatCounter });
    }

    res.setHeader('Cache-Control', 'no-store');
    if (verdict === 'stale') {
      // A token this run really was issued, but not the live one: the client
      // lost a response in flight. Hand back the live token so it can resync;
      // nothing is credited, which is what makes replay worthless.
      recorder.record(req, 'chain_stale', { counter: run.beatCounter });
      return res.json({
        chain: chain.tokenFor(config.sessionSecret, run.id, run.beatCounter),
        credited: false,
      });
    }

    // The first beat that declares the chase has begun stamps the phase
    // boundary on the server clock, once and only once.
    const chaseStarted = chase ? await store.stampChaseStart(run.id, nowDate) : false;

    // Bounded before it reaches the telemetry columns. The run-age check above
    // already refuses a run older than this, so an honest gap can never exceed
    // the bound anyway; the clamp is here because this value gets squared in
    // SQL, and an unbounded number that only feeds observation-only telemetry
    // must never be able to abort the UPDATE that keeps the run alive.
    const gapMs = run.lastBeatAtMs === null
      ? -1
      : Math.min(nowDate.getTime() - run.lastBeatAtMs, LIMITS.MAX_RUN_AGE_MS);
    const result = await store.countBeat(run.id, nowDate, {
      minSpacingMs: LIMITS.MIN_BEAT_SPACING_MS,
      maxAgeMs: LIMITS.MAX_RUN_AGE_MS,
      expectedCounter: run.beatCounter,
      gapMs,
      // A phase boundary is itself a fresh server witness. Credit its first
      // Chase beat even when the last Flappy beat landed less than 4 s ago.
      allowUnspaced: chaseStarted,
    });

    // When the beat was too early to credit, the chain has not moved, so the
    // same token stays live and the client simply beats again later.
    const counter = result.counted ? result.counter : run.beatCounter;
    return res.json({
      chain: chain.tokenFor(config.sessionSecret, run.id, counter),
      credited: result.counted === true,
    });
  }));

  // The only path that writes the leaderboard. Everything it trusts is
  // server-witnessed: the run row, its issue time, its stamped phase boundary
  // and its credited heartbeat count.
  router.post('/score', requireSession, scoreLimit, asyncRoute(async (req, res) => {
    const nowDate = now();
    await maybePruneRejections(nowDate);
    const parsed = parseScoreBody(req.body);
    if (!parsed.ok) {
      if (parsed.code === 'client_flagged') {
        // The engine refuses to POST at all once it has logged a sus event, so
        // a submission that admits to one was assembled by hand. There is no
        // tolerance here: one sus event is as fatal as a hundred.
        log('[ANTICHEAT] hand-crafted submission: sus counter above zero');
        await streamCheat(req.session.sub, 'hand-crafted score');
      }
      return fail(req, res, parsed.code, {
        timeMs: req.body && req.body.timeMs,
        misses: req.body && req.body.misses,
        nearMisses: req.body && req.body.nearMisses,
        sus: req.body && req.body.sus,
      });
    }
    const claim = parsed.value;

    // Belt and braces on top of the server-witnessed wall. The salt is public,
    // so this proves the numbers travelled together from a real build, not that
    // the player is honest.
    if (config.winSigStrict) {
      const signed = config.winSigSalts.some((salt) => verifyWinSignature(claim, salt));
      if (!signed) {
        await streamCheat(req.session.sub, 'forged win attestation');
        return fail(req, res, 'invalid_signature', {
          timeMs: claim.timeMs, misses: claim.misses, nearMisses: claim.nearMisses,
        });
      }
    }

    const run = await store.getRun(claim.runId);
    const verdict = validateRunForScore({
      run,
      userId: req.session.sub,
      nowMs: nowDate.getTime(),
      timeMs: claim.timeMs,
      floors: config.floors,
    });
    if (!verdict.ok) {
      // Refusing is cheap and reversible; naming someone a cheat in a public
      // feed is neither, so it waits for a shortfall no round trip can explain.
      const shortfallMs = verdict.detail && Number.isFinite(verdict.detail.scoredChasePhaseMs)
        ? verdict.detail.scoredChasePhaseMs - claim.timeMs
        : 0;
      if (verdict.code === 'time_below_elapsed'
        && run && run.userId === req.session.sub
        && shortfallMs > CLOCK_FORGERY_MARGIN_MS) {
        await streamCheat(run.userId, 'server clock manipulation');
        const failure = await store.applyBan(run.userId, run.id, 'clock-forgery');
        if (failure) await streamFailures([failure]);
      }
      return fail(req, res, verdict.code, {
        timeMs: claim.timeMs,
        misses: claim.misses,
        nearMisses: claim.nearMisses,
        mode: run ? run.mode : null,
        detail: verdict.detail || null,
      });
    }

    const written = await store.submitScore(
      {
        runId: run.id,
        userId: run.userId,
        mode: run.mode,
        timeMs: claim.timeMs,
        misses: claim.misses,
        nearMisses: claim.nearMisses,
      },
      nowDate,
    );
    if (!written.ok) return fail(req, res, written.code, { timeMs: claim.timeMs });

    const best = written.best;
    const rank = written.rank;

    // Publishing is downstream of the score commit and must stay best-effort.
    // If identity lookup or feed serialization fails, the durable score still
    // gets its truthful success response instead of an unrecoverable 500.
    try {
      const winner = await store.getUser(run.userId);
      if (winner) {
        feed.emit('run_won', {
          twitchId: winner.id,
          name: winner.displayName,
          avatar: winner.avatarUrl,
          mode: run.mode,
          timeMs: claim.timeMs,
          clicks: claim.misses + 1,
        });
      }
    } catch (err) {
      log(`feed publish failed: ${err.code || 'error'}`);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      bestMs: best.timeMs,
      rank,
      mode: run.mode,
      timeMs: claim.timeMs,
      clicks: claim.misses + 1,
      // True when this submission is the record now standing. Tying your own
      // previous best also reads as improved, which is close enough for a
      // cosmetic flag on the win dialog.
      improved: best.timeMs === claim.timeMs,
    });
  }));

  // Run events. Flappy deaths and bans are cosmetic. Challenge start/solve
  // pairs are server-witnessed eligibility state and are therefore bound to an
  // authenticated, open run and timed on the server clock.
  router.post('/event', requireSession, eventLimit, asyncRoute(async (req, res) => {
    const nowDate = now();
    await maybePruneRejections(nowDate);
    const parsed = parseEventBody(req.body);
    if (!parsed.ok) {
      return fail(req, res, parsed.code, {
        type: req.body && req.body.type,
        reason: req.body && req.body.reason,
      });
    }

    const user = await store.getUser(req.session.sub);
    if (!user) {
      res.setHeader('Set-Cookie', clearedSessionCookie());
      return sendError(res, 401, 'unauthenticated', 'Sign in with Twitch first');
    }

    if (parsed.value.type === 'ban') {
      const failure = await store.applyBan(user.id, parsed.value.runId, parsed.value.reason);
      // Closing the run here is what makes the failure stream immediately
      // rather than waiting on the stale sweep.
      if (failure) await streamFailures([failure]);
      return res.status(204).end();
    }

    if (parsed.value.type === 'challenge_start' || parsed.value.type === 'challenge_solve') {
      const run = await store.getRun(parsed.value.runId);
      if (!run || run.userId !== user.id) return fail(req, res, 'run_not_found');
      if (run.consumed) return fail(req, res, 'run_consumed');
      if (run.failed) return fail(req, res, 'run_closed');
      if (parsed.value.type === 'challenge_start') {
        let challengeRun = run;
        if (run.challengeStartedAtMs === null) {
          const nowMs = nowDate.getTime();
          const retry = await store.getChallengeRetry(user.id);
          if (retry && retry.retryAfterMs !== null && retry.retryAfterMs > nowMs) {
            return sendChallengeRetry(res, retry.retryAfterMs, nowMs);
          }
          if (run.mode === 'practice') {
            const offsetMs = nowMs - run.chaseStartedAtMs;
            if (
              !Number.isFinite(offsetMs)
              || offsetMs < LIMITS.MIN_PRACTICE_CHALLENGE_OFFSET_MS
              || offsetMs > LIMITS.MAX_PRACTICE_CHALLENGE_OFFSET_MS
            ) return fail(req, res, 'challenge_wrong_phase');
          } else {
            const flappyMs = nowMs - run.issuedAtMs;
            if (
              run.chaseStartedAtMs !== null
              || !Number.isFinite(flappyMs)
              || flappyMs < LIMITS.MIN_FLAPPY_PHASE_MS
              || flappyMs > LIMITS.MAX_FLAPPY_PHASE_MS
            ) return fail(req, res, 'challenge_wrong_phase');
          }

          const started = await store.startChallenge(
            run.id, user.id, newChallengeSeed(), nowDate,
          );
          if (!started) {
            const retryAfter = await store.getChallengeRetry(user.id);
            if (
              retryAfter
              && retryAfter.retryAfterMs !== null
              && retryAfter.retryAfterMs > nowMs
            ) return sendChallengeRetry(res, retryAfter.retryAfterMs, nowMs);
          }
          // A concurrent duplicate can lose the guarded UPDATE. Re-read the
          // committed winner so both callers receive the same immutable image.
          challengeRun = await store.getRun(run.id);
        }
        if (!challengeRun) return fail(req, res, 'run_not_found');
        if (challengeRun.consumed) return fail(req, res, 'run_consumed');
        if (challengeRun.failed) return fail(req, res, 'run_closed');
        if (typeof challengeRun.challengeSeed !== 'string') {
          return fail(req, res, 'challenge_not_started');
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.json(buildChallenge({
          runId: challengeRun.id,
          seed: challengeRun.challengeSeed,
          secret: config.sessionSecret,
        }));
      }

      if (run.challengeStartedAtMs === null) {
        return fail(req, res, 'challenge_not_started');
      }
      // An already completed request is an idempotent retry, not a new solve.
      if (
        run.challengeSolvedAtMs !== null
        && run.challengeSolvedCount === run.challengeCount
      ) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ solved: true });
      }
      const solveMs = nowDate.getTime() - run.challengeStartedAtMs;
      if (solveMs < LIMITS.MIN_CHALLENGE_SOLVE_MS) {
        // This is a server-observed protocol violation, not a client hint. End
        // the run so the same script cannot merely wait out the threshold and
        // retry the open challenge after it has already been caught.
        const failure = await store.applyBan(user.id, run.id, 'captcha-fail', {
          challengeFailureAt: nowDate,
        });
        if (failure) await streamFailures([failure]);
        // Publish only after the durable run closure/one-shot marker commits.
        // A transient database failure must not publicly accuse a player while
        // leaving the allegedly offending run open.
        await streamCheat(user.id, 'automated visual verification');
        return fail(req, res, 'challenge_too_fast');
      }
      if (solveMs > LIMITS.MAX_CHALLENGE_SOLVE_MS) {
        return fail(req, res, 'challenge_expired');
      }
      if (!matchesAnswers(parsed.value.answers, {
        runId: run.id,
        seed: run.challengeSeed,
        secret: config.sessionSecret,
      })) {
        // A wrong visual match can be an honest mistake, so close the one-shot
        // run but do not publish a cheating accusation.
        const failure = await store.applyBan(user.id, run.id, 'captcha-fail', {
          challengeFailureAt: nowDate,
        });
        if (failure) await streamFailures([failure]);
        return fail(req, res, 'challenge_incorrect');
      }
      const solved = await store.solveChallenge(
        run.id, user.id, run.challengeCount, nowDate,
      );
      if (!solved) {
        const settled = await store.getRun(run.id);
        if (
          settled
          && settled.challengeSolvedAtMs !== null
          && settled.challengeSolvedCount === settled.challengeCount
        ) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json({ solved: true });
        }
        return fail(req, res, 'challenge_not_started');
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ solved: true });
    }

    await store.incrementFlappyFails(user.id);
    feed.emit('flappy_death', {
      twitchId: user.id,
      name: user.displayName,
      avatar: user.avatarUrl,
    });
    return res.status(204).end();
  }));

  router.get('/leaderboard', leaderboardLimit, asyncRoute(async (req, res) => {
    const mode = req.query.mode === undefined || req.query.mode === '' ? 'practice' : req.query.mode;
    if (!isMode(mode)) return fail(req, res, 'invalid_mode', { mode: String(mode).slice(0, 40) });

    const nowDate = now();
    await maybePruneRejections(nowDate);
    await maybeSweepRuns(nowDate);

    const viewerId = req.session ? req.session.sub : null;
    const rows = await store.topScores(mode, LEADERBOARD_LIMIT);
    const entries = rows.map((row, index) => publicEntry(row, index + 1, row.userId === viewerId));

    let you = null;
    if (viewerId) {
      const mine = entries.find((entry) => entry.isYou);
      if (mine) {
        you = mine;
      } else {
        const score = await store.getScore(viewerId, mode);
        if (score) {
          const user = await store.getUser(viewerId);
          const rank = await store.rankOf(viewerId, mode, score.timeMs, score.achievedAt);
          you = publicEntry(
            {
              userId: viewerId,
              displayName: user ? user.displayName : '',
              avatarUrl: user ? user.avatarUrl : '',
              flappyFails: user ? user.flappyFails : 0,
              chaseFails: user ? user.chaseFails : 0,
              totalFails: user ? user.totalFails : 0,
              timeMs: score.timeMs,
              misses: score.misses,
              clicks: score.clicks,
              achievedAt: score.achievedAt,
            },
            rank,
            true,
          );
        }
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ mode, entries, you });
  }));

  // Public player card. Read-only SELECTs over data that is already public on
  // the leaderboard, plus that player's retained run history.
  router.get('/player/:twitchId', playerLimit, asyncRoute(async (req, res) => {
    const playerId = req.params.twitchId;
    if (!isTwitchId(playerId)) return fail(req, res, 'invalid_player_id');

    const user = await store.getUser(playerId);
    if (!user) return fail(req, res, 'player_not_found');

    const best = {};
    for (const mode of MODES) {
      const score = await store.getScore(playerId, mode);
      best[mode] = score === null ? null : {
        timeMs: score.timeMs,
        misses: score.misses,
        clicks: score.clicks,
        achievedAt: score.achievedAt.toISOString(),
        rank: await store.rankOf(playerId, mode, score.timeMs, score.achievedAt),
      };
    }

    const wins = await store.countWins(playerId);
    const runs = await store.listRuns(playerId, RUN_HISTORY_LIMIT);

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      best,
      flappyFails: user.flappyFails,
      chaseFails: user.chaseFails,
      totalFails: user.totalFails,
      // Lifetime figures: wins comes from the submission ledger, which is never
      // pruned, and runs is wins plus every failure ever recorded.
      totals: { runs: wins + user.totalFails, wins },
      runs: runs.map((run) => ({
        mode: run.mode,
        outcome: run.outcome,
        timeMs: run.timeMs,
        failReason: run.failReason,
        phase: run.phase,
        at: run.at.toISOString(),
      })),
    });
  }));

  // V3.8: the stats board. One read across every player, made of fields the
  // leaderboard and player cards already expose one at a time. Sorting is
  // client-side; the cap and default order live in the store.
  router.get('/stats', statsLimit, asyncRoute(async (req, res) => {
    const players = await store.allPlayerStats();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ players });
  }));

  // Public live feed. No auth, no cookies, no writes: everything on it is
  // already visible on the leaderboard.
  router.get('/feed', feedLimit, (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Tells any buffering proxy to pass the stream straight through.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // Ask a reconnecting browser to wait rather than hammer.
    res.write('retry: 5000\n\n');
    // V3.6: ?after=<last event id seen> narrows the replay to the gap. The
    // client reconnects with a fresh EventSource (it closes the old one to own
    // the retry budget), so the Last-Event-ID header never travels and the
    // cursor rides the query string instead. Absent or junk means "from the
    // top of the buffer".
    const after = Number.parseInt(req.query.after, 10);
    feed.subscribe(res, Number.isInteger(after) && after > 0 ? after : 0);
  });

  return router;
}

module.exports = {
  createApiRouter,
  STATUS_BY_CODE,
  SCORE_LIMIT,
  BEAT_LIMIT,
  EVENT_LIMIT,
  LEADERBOARD_RATE_LIMIT,
  RUN_LIMIT,
};
