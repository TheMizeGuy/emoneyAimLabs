'use strict';

// Drives the real SQL of store.js against pg-mem, an in-memory Postgres. No
// database server is started anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStore, LEADERBOARD_LIMIT, RUN_HISTORY_LIMIT } = require('../store');
const { createMemPool, createClock } = require('./helpers');
const { LIMITS } = require('../validation');

const BEAT_OPTS = {
  minSpacingMs: LIMITS.MIN_BEAT_SPACING_MS,
  maxAgeMs: LIMITS.MAX_RUN_AGE_MS,
  expectedCounter: 0,
  gapMs: -1,
};

async function fixture() {
  const pool = await createMemPool();
  const store = createStore(pool);
  const clock = createClock();
  return { pool, store, clock };
}

async function seed(store, clock, id) {
  return store.upsertUser(
    { id, login: id, displayName: id.toUpperCase(), avatarUrl: `https://cdn/${id}.png` },
    clock.now(),
  );
}

// A run that has reached the chase, with beats already credited.
async function liveRun(store, clock, userId, mode = 'practice') {
  const runId = await store.createRun(userId, mode, clock.now());
  if (mode !== 'practice') await store.stampChaseStart(runId, clock.now());
  return runId;
}

test('migration is idempotent', async () => {
  const { pool } = await fixture();
  const { migrate } = require('../db');
  await migrate(pool);
  await migrate(pool);
  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(Number(rows[0].n), 0);
  await pool.end();
});

test('user upsert creates then refreshes the profile', async () => {
  const { pool, store, clock } = await fixture();
  const created = await store.upsertUser(
    { id: '42', login: 'emoney', displayName: 'eMoney', avatarUrl: 'https://cdn/a.png' },
    clock.now(),
  );
  assert.deepEqual(created, {
    id: '42',
    login: 'emoney',
    displayName: 'eMoney',
    avatarUrl: 'https://cdn/a.png',
    flappyFails: 0,
    chaseFails: 0,
    totalFails: 0,
  });
  // Identity is exactly what an empty-scope Twitch token exposes. There is no
  // column to put an email in.
  assert.equal(Object.hasOwn(created, 'email'), false);

  clock.advance(86400000);
  const updated = await store.upsertUser(
    { id: '42', login: 'emoney2', displayName: 'eMoney 2', avatarUrl: 'https://cdn/b.png' },
    clock.now(),
  );
  assert.equal(updated.login, 'emoney2');

  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(Number(rows[0].n), 1, 'upsert must not duplicate the user');
  await pool.end();
});

test('user upsert truncates absurd profile strings', async () => {
  const { pool, store, clock } = await fixture();
  const user = await store.upsertUser(
    { id: '43', login: 'x'.repeat(5000), displayName: 'y'.repeat(5000), avatarUrl: 'z'.repeat(5000) },
    clock.now(),
  );
  assert.equal(user.login.length, 200);
  assert.equal(user.displayName.length, 200);
  assert.equal(user.avatarUrl.length, 512);
  await pool.end();
});

test('run tokens are unguessable and unique', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const runId = await store.createRun('1', 'practice', clock.advance(1000));
    // 24 random bytes, base64url encoded: 192 bits of entropy.
    assert.equal(runId.length, 32);
    assert.match(runId, /^[A-Za-z0-9_-]{32}$/);
    seen.add(runId);
  }
  assert.equal(seen.size, 50);
  await pool.end();
});

test('practice runs stamp the chase immediately, simulation runs do not', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  const practice = await store.getRun(await store.createRun('1', 'practice', clock.now()));
  assert.equal(practice.chaseStartedAtMs, practice.issuedAtMs);
  assert.equal(practice.outcome, undefined, 'outcome is not part of the run view used in scoring');

  const sim = await store.getRun(await store.createRun('1', 'simulation', clock.now()));
  assert.equal(sim.chaseStartedAtMs, null);

  clock.advance(20000);
  assert.equal(await store.stampChaseStart(sim.id, clock.now()), true);
  const stamped = await store.getRun(sim.id);
  assert.equal(stamped.chaseStartedAtMs, clock.nowMs());

  // The stamp is monotonic: a second attempt cannot move it.
  clock.advance(20000);
  assert.equal(await store.stampChaseStart(sim.id, clock.now()), false);
  assert.equal((await store.getRun(sim.id)).chaseStartedAtMs, stamped.chaseStartedAtMs);
  await pool.end();
});

test('heartbeats credit only when paced and only on the live chain counter', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await liveRun(store, clock, '1');

  const first = await store.countBeat(runId, clock.advance(5000), { ...BEAT_OPTS, expectedCounter: 0 });
  assert.equal(first.counted, true);
  assert.equal(first.beats, 1);
  assert.equal(first.counter, 1);

  // Too soon: nothing credited, and the chain has not moved.
  const spam = await store.countBeat(runId, clock.advance(1000), {
    ...BEAT_OPTS, expectedCounter: 1, gapMs: 1000,
  });
  assert.equal(spam.counted, false);
  assert.equal((await store.getRun(runId)).beatCounter, 1);

  // A stale counter cannot credit even when the pacing is fine.
  const stale = await store.countBeat(runId, clock.advance(9000), {
    ...BEAT_OPTS, expectedCounter: 0, gapMs: 10000,
  });
  assert.equal(stale.counted, false);

  const second = await store.countBeat(runId, clock.now(), {
    ...BEAT_OPTS, expectedCounter: 1, gapMs: 10000,
  });
  assert.equal(second.counted, true);
  assert.equal(second.beats, 2);
  assert.equal(second.counter, 2);
  await pool.end();
});

test('heartbeats stop crediting once the run is consumed, failed or expired', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  const failedRun = await liveRun(store, clock, '1');
  await store.failOpenRunsForUser('1');
  const afterFail = await store.countBeat(failedRun, clock.advance(5000), BEAT_OPTS);
  assert.equal(afterFail.counted, false);

  const oldRun = await liveRun(store, clock, '1');
  const afterExpiry = await store.countBeat(
    oldRun, clock.advance(LIMITS.MAX_RUN_AGE_MS + 1000), BEAT_OPTS,
  );
  assert.equal(afterExpiry.counted, false);
  await pool.end();
});

test('beat telemetry records intervals and is never consulted by validation', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await liveRun(store, clock, '1');

  const gaps = [5000, 5200, 4900];
  let counter = 0;
  await store.countBeat(runId, clock.advance(5000), { ...BEAT_OPTS, expectedCounter: counter });
  counter += 1;
  for (const gap of gaps) {
    await store.countBeat(runId, clock.advance(gap), {
      ...BEAT_OPTS, expectedCounter: counter, gapMs: gap,
    });
    counter += 1;
  }

  const telemetry = await store.beatTelemetry(runId);
  assert.equal(telemetry.count, 3);
  assert.ok(Math.abs(telemetry.meanMs - 5033.33) < 1, `mean was ${telemetry.meanMs}`);
  assert.ok(telemetry.stddevMs > 0, 'a varying cadence has spread');
  await pool.end();
});

test('opening a new run closes the previous one and moves both fail counters', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  // A practice run always reached the chase.
  await store.createRun('1', 'practice', clock.now());
  clock.advance(30000);
  const failures = await store.failOpenRunsForUser('1');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].phase, 'chase');

  const after = await store.getUser('1');
  assert.equal(after.totalFails, 1);
  assert.equal(after.chaseFails, 1);
  assert.equal(after.flappyFails, 0);

  // Closing again is a no-op: the flag makes each run countable exactly once.
  assert.equal((await store.failOpenRunsForUser('1')).length, 0);
  assert.equal((await store.getUser('1')).totalFails, 1);
  await pool.end();
});

test('a simulation run abandoned in the gauntlet raises the total but not the chase count', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  await store.createRun('1', 'simulation', clock.now());
  const failures = await store.failOpenRunsForUser('1');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].phase, 'flappy');

  const user = await store.getUser('1');
  assert.equal(user.totalFails, 1);
  assert.equal(user.chaseFails, 0, 'it never reached the popup');
  await pool.end();
});

test('a simulation run abandoned after the chase stamp raises both counters', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  const runId = await store.createRun('1', 'simulation', clock.now());
  clock.advance(20000);
  await store.stampChaseStart(runId, clock.now());

  const failures = await store.failOpenRunsForUser('1');
  assert.equal(failures[0].phase, 'chase');
  const user = await store.getUser('1');
  assert.equal(user.totalFails, 1);
  assert.equal(user.chaseFails, 1);
  await pool.end();
});

test('flappy death events move neither run counter', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  assert.equal(await store.incrementFlappyFails('1'), 1);
  assert.equal(await store.incrementFlappyFails('1'), 2);

  const user = await store.getUser('1');
  assert.equal(user.flappyFails, 2);
  assert.equal(user.chaseFails, 0);
  assert.equal(user.totalFails, 0);
  assert.equal(await store.incrementFlappyFails('ghost'), null);
  await pool.end();
});

test('stale runs are swept per owner and only once', async () => {
  const { pool, store, clock } = await fixture();
  for (const id of ['1', '2']) await seed(store, clock, id);

  await store.createRun('1', 'practice', clock.now());
  await store.createRun('1', 'simulation', clock.now());
  const live = await store.createRun('2', 'practice', clock.now());

  clock.advance(60000);
  await store.countBeat(live, clock.now(), BEAT_OPTS);

  clock.advance(60000);
  const swept = await store.failStaleRuns(clock.now());
  assert.equal(swept.length, 2, 'both of user 1 runs went stale');
  assert.equal((await store.getUser('1')).totalFails, 2);
  assert.equal((await store.getUser('1')).chaseFails, 1, 'only the practice run reached the chase');
  assert.equal((await store.getUser('2')).totalFails, 0);

  assert.equal((await store.failStaleRuns(clock.now())).length, 0, 'the sweep is idempotent');

  clock.advance(120000);
  assert.equal((await store.failStaleRuns(clock.now())).length, 1);
  assert.equal((await store.getUser('2')).totalFails, 1);
  await pool.end();
});

test('a scored run is never counted as a failure', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await liveRun(store, clock, '1');

  const written = await store.submitScore(
    { runId, userId: '1', mode: 'practice', timeMs: 20000, misses: 2, nearMisses: 4 },
    clock.now(),
  );
  assert.equal(written.ok, true);

  assert.equal((await store.failOpenRunsForUser('1')).length, 0);
  clock.advance(10 * 60 * 1000);
  assert.equal((await store.failStaleRuns(clock.now())).length, 0);
  assert.equal((await store.getUser('1')).totalFails, 0);
  await pool.end();
});

test('a run can only be scored once, enforced by the submission primary key', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await liveRun(store, clock, '1');
  const entry = { runId, userId: '1', mode: 'practice', timeMs: 20000, misses: 2, nearMisses: 4 };

  assert.equal((await store.submitScore(entry, clock.now())).ok, true);
  const replay = await store.submitScore(entry, clock.now());
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'run_consumed');

  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM score_submissions');
  assert.equal(Number(rows[0].n), 1);
  await pool.end();
});

test('an accepted score marks the run won and records the time', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await liveRun(store, clock, '1');
  await store.submitScore(
    { runId, userId: '1', mode: 'practice', timeMs: 20000, misses: 2, nearMisses: 4 },
    clock.now(),
  );

  const [history] = await store.listRuns('1');
  assert.equal(history.outcome, 'won');
  assert.equal(history.timeMs, 20000);
  assert.equal(history.failReason, null);
  assert.equal(history.phase, 'chase');
  assert.equal(await store.countWins('1'), 1);
  await pool.end();
});

test('the record only moves when a run is strictly faster', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  async function post(timeMs, misses, nearMisses) {
    const runId = await liveRun(store, clock, '1');
    const written = await store.submitScore(
      { runId, userId: '1', mode: 'practice', timeMs, misses, nearMisses }, clock.advance(1000),
    );
    return written.best;
  }

  assert.equal((await post(20000, 5, 4)).timeMs, 20000);

  const slower = await post(45000, 99, 99);
  assert.equal(slower.timeMs, 20000);
  assert.equal(slower.misses, 5, 'a slower run must not overwrite the record stats');
  assert.equal(slower.nearMisses, 4);

  const faster = await post(12000, 1, 3);
  assert.equal(faster.timeMs, 12000);
  assert.equal(faster.misses, 1);
  assert.equal(faster.clicks, 2, 'clicks is derived as misses plus the winning click');

  // Modes are scored independently.
  const simRun = await store.createRun('1', 'simulation', clock.now());
  await store.stampChaseStart(simRun, clock.now());
  const sim = await store.submitScore(
    { runId: simRun, userId: '1', mode: 'simulation', timeMs: 30000, misses: 0, nearMisses: 3 },
    clock.now(),
  );
  assert.equal(sim.best.timeMs, 30000);
  assert.equal((await store.getScore('1', 'practice')).timeMs, 12000);
  await pool.end();
});

test('the database refuses an impossible score even if the app ever let one through', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  await assert.rejects(
    () => pool.query(
      `INSERT INTO scores (user_id, mode, time_ms, misses, near_misses, achieved_at)
       VALUES ('1', 'simulation', 90000, 0, 5, $1)`,
      [clock.now()],
    ),
    /check/i,
    'a simulation time past the shot clock violates the CHECK bound',
  );

  await assert.rejects(
    () => pool.query(
      `INSERT INTO scores (user_id, mode, time_ms, misses, near_misses, achieved_at)
       VALUES ('1', 'practice', 20000, 0, 0, $1)`,
      [clock.now()],
    ),
    /check/i,
    'a win with no near misses violates the CHECK bound',
  );
  await pool.end();
});

test('rank counts everybody faster, with a stable tie break', async () => {
  const { pool, store, clock } = await fixture();
  const times = [9000, 12000, 15000, 21000];
  for (let i = 0; i < times.length; i += 1) {
    const id = `u${i}`;
    await seed(store, clock, id);
    const runId = await liveRun(store, clock, id);
    await store.submitScore(
      { runId, userId: id, mode: 'practice', timeMs: times[i], misses: 0, nearMisses: 3 },
      clock.advance(1000),
    );
  }
  for (let i = 0; i < times.length; i += 1) {
    const score = await store.getScore(`u${i}`, 'practice');
    assert.equal(await store.rankOf(`u${i}`, 'practice', score.timeMs, score.achievedAt), i + 1);
  }

  // A tie is broken by who got there first.
  await seed(store, clock, 'late');
  const lateRun = await liveRun(store, clock, 'late');
  await store.submitScore(
    { runId: lateRun, userId: 'late', mode: 'practice', timeMs: 9000, misses: 0, nearMisses: 3 },
    clock.advance(1000),
  );
  const lateScore = await store.getScore('late', 'practice');
  assert.equal(await store.rankOf('late', 'practice', lateScore.timeMs, lateScore.achievedAt), 2);
  await pool.end();
});

test('leaderboard ascends, caps at fifty and carries the derived columns', async () => {
  const { pool, store, clock } = await fixture();
  for (let i = 0; i < 60; i += 1) {
    const id = `u${String(i).padStart(3, '0')}`;
    await seed(store, clock, id);
    const runId = await liveRun(store, clock, id);
    await store.submitScore(
      { runId, userId: id, mode: 'practice', timeMs: 60000 - i * 100, misses: i, nearMisses: 3 },
      clock.advance(1000),
    );
  }
  await store.incrementFlappyFails('u059');
  await store.addFailCounts('u059', { total: 4, chase: 2 });

  const top = await store.topScores('practice', LEADERBOARD_LIMIT);
  assert.equal(top.length, 50);
  assert.equal(top[0].timeMs, 54100);
  assert.equal(top[0].displayName, 'U059');
  assert.equal(top[0].clicks, top[0].misses + 1, 'clicks is derived in the SELECT');
  assert.equal(top[0].flappyFails, 1);
  assert.equal(top[0].chaseFails, 2);
  assert.equal(top[0].totalFails, 4);
  for (let i = 1; i < top.length; i += 1) {
    assert.ok(top[i].timeMs >= top[i - 1].timeMs, 'leaderboard must ascend');
  }
  await pool.end();
});

test('run history is pruned to the newest hundred per player', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  await seed(store, clock, '2');

  let firstRun = null;
  for (let i = 0; i < RUN_HISTORY_LIMIT + 25; i += 1) {
    const runId = await store.createRun('1', 'practice', clock.advance(1000));
    if (i === 0) firstRun = runId;
  }
  await store.createRun('2', 'practice', clock.advance(1000));

  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM runs WHERE user_id = $1', ['1']);
  assert.ok(Number(rows[0].n) <= RUN_HISTORY_LIMIT, `kept ${rows[0].n}`);
  assert.equal(await store.getRun(firstRun), null, 'the oldest run is gone');

  const history = await store.listRuns('1');
  assert.equal(history.length, RUN_HISTORY_LIMIT);
  // Newest first.
  assert.ok(history[0].at.getTime() > history[1].at.getTime());

  const other = await pool.query('SELECT COUNT(*) AS n FROM runs WHERE user_id = $1', ['2']);
  assert.equal(Number(other.rows[0].n), 1, 'another player is untouched');
  await pool.end();
});

test('a ban closes the open run, colours it and counts once', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await store.createRun('1', 'simulation', clock.now());
  clock.advance(20000);
  await store.stampChaseStart(runId, clock.now());

  const failure = await store.applyBan('1', 'captcha-fail', clock.now());
  assert.equal(failure.runId, runId);
  assert.equal(failure.failReason, 'captcha-fail');
  assert.equal(failure.phase, 'chase');

  const user = await store.getUser('1');
  assert.equal(user.totalFails, 1);
  assert.equal(user.chaseFails, 1);

  const [history] = await store.listRuns('1');
  assert.equal(history.outcome, 'failed');
  assert.equal(history.failReason, 'captcha-fail');

  // A second ban only recolours the already closed run.
  assert.equal(await store.applyBan('1', 'timeout', clock.now()), null);
  assert.equal((await store.getUser('1')).totalFails, 1, 'no double counting');
  assert.equal((await store.listRuns('1'))[0].failReason, 'timeout');
  await pool.end();
});

test('a ban with no run at all is a no-op', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  assert.equal(await store.applyBan('1', 'timeout', clock.now()), null);
  assert.equal((await store.getUser('1')).totalFails, 0);
  await pool.end();
});

test('a ban can never touch a scored run', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  const runId = await liveRun(store, clock, '1');
  await store.submitScore(
    { runId, userId: '1', mode: 'practice', timeMs: 20000, misses: 1, nearMisses: 3 },
    clock.now(),
  );

  assert.equal(await store.applyBan('1', 'captcha-fail', clock.now()), null);
  const [history] = await store.listRuns('1');
  assert.equal(history.outcome, 'won');
  assert.equal(history.failReason, null);
  assert.equal((await store.getUser('1')).totalFails, 0);
  await pool.end();
});

test('rejections are recorded and never surface anywhere else', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  await store.recordRejection({
    userId: '1',
    ipHash: 'abc123',
    endpoint: 'POST /api/score',
    reason: 'below_floor',
    payload: { timeMs: 12 },
  }, clock.now());
  await store.recordRejection({
    userId: null,
    ipHash: null,
    endpoint: 'POST /api/run',
    reason: 'origin_missing',
    payload: {},
  }, clock.now());

  assert.equal(await store.countRejections(), 2);
  assert.equal(await store.countRejections('below_floor'), 1);
  const { rows } = await pool.query('SELECT user_id, reason, payload FROM rejections ORDER BY id');
  assert.equal(rows[0].reason, 'below_floor');
  assert.deepEqual(rows[0].payload, { timeMs: 12 });
  assert.equal(rows[1].user_id, null);
  await pool.end();
});

test('the audit trail is pruned to its retention window', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  await store.recordRejection({
    userId: '1', ipHash: 'aa', endpoint: 'POST /api/score', reason: 'old', payload: {},
  }, clock.now());
  clock.advance(8 * 24 * 60 * 60 * 1000);
  await store.recordRejection({
    userId: '1', ipHash: 'bb', endpoint: 'POST /api/score', reason: 'fresh', payload: {},
  }, clock.now());

  assert.equal(await store.countRejections(), 2);
  assert.equal(await store.pruneRejections(clock.now()), 1);
  assert.equal(await store.countRejections('old'), 0);
  assert.equal(await store.countRejections('fresh'), 1);
  await pool.end();
});

test('the session epoch revokes every cookie a user holds', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');

  assert.equal(await store.getSessionEpoch('1'), 0);
  assert.equal(await store.bumpSessionEpoch('1', 0), 1);
  assert.equal(await store.getSessionEpoch('1'), 1);

  // A cookie carrying a retired epoch cannot drive another bump, so a stale
  // copy cannot spend writes by logging out over and over.
  assert.equal(await store.bumpSessionEpoch('1', 0), null);
  assert.equal(await store.getSessionEpoch('1'), 1);
  assert.equal(await store.bumpSessionEpoch('1', 1), 2);

  // An unknown user has no epoch to compare against.
  assert.equal(await store.getSessionEpoch('ghost'), null);
  assert.equal(await store.bumpSessionEpoch('ghost', 0), null);

  // Logging out does not disturb the player's record or counters.
  assert.equal((await store.getUser('1')).totalFails, 0);
  await pool.end();
});

test('users can be looked up in a batch for the feed', async () => {
  const { pool, store, clock } = await fixture();
  await seed(store, clock, '1');
  await seed(store, clock, '2');
  const users = await store.getUsers(['1', '2', 'missing']);
  assert.equal(users.length, 2);
  assert.deepEqual(users.map((user) => user.id).sort(), ['1', '2']);
  assert.deepEqual(await store.getUsers([]), []);
  await pool.end();
});

test('hostile strings are stored as data, never executed as SQL', async () => {
  const { pool, store, clock } = await fixture();
  const nasty = "Robert'); DROP TABLE scores; --";
  await store.upsertUser({ id: nasty, login: nasty, displayName: nasty, avatarUrl: '' }, clock.now());
  const runId = await liveRun(store, clock, nasty);
  await store.submitScore(
    { runId, userId: nasty, mode: 'practice', timeMs: 9000, misses: 0, nearMisses: 3 },
    clock.now(),
  );

  const top = await store.topScores('practice', 50);
  assert.equal(top.length, 1);
  assert.equal(top[0].displayName, nasty);
  assert.equal(await store.getRun("' OR 1=1 --"), null);
  await pool.end();
});

test('feed events round-trip the store, newest window only, oldest pruned', async () => {
  const { pool, store } = await fixture();

  await store.saveFeedEvent(1, 'run_started', { name: 'A', at: 100 });
  await store.saveFeedEvent(2, 'run_won', { name: 'A', at: 200 });
  await store.saveFeedEvent(3, 'flappy_death', { name: 'B', at: 300 });

  // Oldest-first for replay, and the JSON payload survives intact.
  assert.deepEqual(await store.recentFeedEvents(50), [
    { id: 1, type: 'run_started', data: { name: 'A', at: 100 } },
    { id: 2, type: 'run_won', data: { name: 'A', at: 200 } },
    { id: 3, type: 'flappy_death', data: { name: 'B', at: 300 } },
  ]);

  // The limit takes the newest window, not the oldest.
  assert.deepEqual((await store.recentFeedEvents(2)).map((e) => e.id), [2, 3]);

  // A replayed id is ignored, not an error (the fire-and-forget hook retries nothing).
  await store.saveFeedEvent(3, 'run_won', { name: 'C', at: 999 });
  assert.equal((await store.recentFeedEvents(50)).length, 3);

  // The retention prune trims everything far behind the newest write.
  await store.saveFeedEvent(504, 'run_started', { name: 'D', at: 400 });
  const kept = (await store.recentFeedEvents(50)).map((e) => e.id);
  assert.ok(!kept.includes(1), 'id 1 fell past the retention cap');
  assert.ok(kept.includes(504));
  await pool.end();
});
