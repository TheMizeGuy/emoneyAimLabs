'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { LIMITS } = require('../validation');

const ROOT = path.resolve(__dirname, '..', '..');

function source(name) {
  return fs.readFileSync(path.join(ROOT, 'js', name), 'utf8');
}

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  const end = text.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
  assert.notEqual(end, -1, `missing end marker: ${endNeedle}`);
  return text.slice(start, end);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function lifecycleHarness(net) {
  const timers = new Map();
  let nextTimer = 1;
  const notes = [];
  const chase = { winExtras: (value) => notes.push(value) };
  const sandbox = {
    NET: net,
    user: { id: '1' },
    apiUp: true,
    runId: null,
    runGen: 0,
    runOpenTail: Promise.resolve(),
    activeRunOpenGen: 0,
    activeRunOpenPromise: null,
    bootMe: null,
    runNonce: '',
    runChain: '',
    beatTimer: 0,
    inChase: false,
    BEAT_MS: 5000,
    beatRequestSeq: 0,
    activeBeatSeq: 0,
    beatInFlightRun: null,
    beatInFlightPromise: null,
    beatPending: false,
    challengePromise: Promise.resolve(null),
    challengeVerified: false,
    running: null,
    chase,
    isSeam: false,
    LOG() {},
    fmtMs: (value) => String(value),
    openModal() {},
    paintAccount() {},
    window: {
      setInterval(fn) {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, fn);
        return id;
      },
      clearInterval(id) { timers.delete(id); },
    },
    Promise,
  };

  const body = sliceBetween(
    source('main.js'),
    '  function resetBeatFlow() {',
    '  /* ---------------- modes ---------------- */',
  );
  vm.runInNewContext(`${body}\nthis.__life = {
    beginRun: beginRun,
    reportBan: reportBan,
    reportChallenge: reportChallenge,
    markChaseStarted: markChaseStarted,
    finishRun: finishRun,
    state: function () {
      return {
        runId: runId,
        runGen: runGen,
        runChain: runChain,
        inChase: inChase,
        beatInFlightRun: beatInFlightRun,
        activeTimers: beatTimer ? 1 : 0
      };
    },
    setRunning: function (mode) {
      running = mode;
    }
  };`, sandbox, { filename: 'main-lifecycle.js' });

  return {
    life: sandbox.__life,
    notes,
    fireTimers() {
      for (const fn of Array.from(timers.values())) fn();
    },
  };
}

test('a clean finish waits for its late run-open response and still submits', async () => {
  const opened = deferred();
  const beats = [];
  const submissions = [];
  const harness = lifecycleHarness({
    startRun: () => opened.promise,
    beat: (...args) => { beats.push(args); return Promise.resolve('next'); },
    submitScore: (...args) => { submissions.push(args); return Promise.resolve(null); },
  });

  harness.life.beginRun('practice');
  harness.life.finishRun({ timeMs: 9000, misses: 3, nearMisses: 4, sus: 0, sig: 'a' });
  assert.equal(submissions.length, 0);
  opened.resolve({ runId: 'late-run', nonce: 'late-run', chain: 'genesis' });
  await flushPromises();

  assert.equal(harness.life.state().runId, null);
  assert.equal(harness.life.state().activeTimers, 0);
  assert.equal(beats.length, 1);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], 'late-run');
});

test('a flagged finish still invalidates a late run-open response', async () => {
  const opened = deferred();
  const beats = [];
  const submissions = [];
  const harness = lifecycleHarness({
    startRun: () => opened.promise,
    beat: (...args) => { beats.push(args); return Promise.resolve('next'); },
    submitScore: (...args) => { submissions.push(args); return Promise.resolve(null); },
  });

  harness.life.beginRun('practice');
  harness.life.finishRun({ timeMs: 9000, misses: 3, nearMisses: 4, sus: 1, sig: 'a' });
  opened.resolve({ runId: 'late-run', nonce: 'late-run', chain: 'genesis' });
  await flushPromises();

  assert.equal(harness.life.state().runId, null);
  assert.equal(harness.life.state().activeTimers, 0);
  assert.equal(beats.length, 0);
  assert.equal(submissions.length, 0);
});

test('run-open requests stay ordered across rapidly replaced attempts', async () => {
  const starts = [];
  const harness = lifecycleHarness({
    startRun(mode) {
      const reply = deferred();
      starts.push({ mode, reply });
      return reply.promise;
    },
    beat: () => Promise.resolve('next'),
    submitScore: () => Promise.resolve(null),
  });

  harness.life.beginRun('practice');
  await flushPromises();
  assert.equal(starts.length, 1, 'the first POST must already be in flight');
  harness.life.finishRun({ timeMs: 9000, misses: 3, nearMisses: 4, sus: 0, sig: 'a' });
  harness.life.beginRun('simulation');
  await flushPromises();
  assert.equal(starts.length, 1, 'the replacement must not overtake the first POST');

  starts[0].reply.resolve({ runId: 'stale', nonce: 'stale', chain: 'c0' });
  await flushPromises();
  assert.equal(starts.length, 2);
  assert.equal(starts[1].mode, 'simulation');

  starts[1].reply.resolve({ runId: 'current', nonce: 'current', chain: 'c1' });
  await flushPromises();
  assert.equal(harness.life.state().runId, 'current');
});

test('heartbeat requests are serial and a Chase transition is not dropped', async () => {
  const calls = [];
  const replies = [];
  const harness = lifecycleHarness({
    startRun: () => Promise.resolve({ runId: 'run-1', nonce: 'run-1', chain: 'c0' }),
    beat: (...args) => {
      calls.push(args);
      const reply = deferred();
      replies.push(reply);
      return reply.promise;
    },
    submitScore: () => Promise.resolve(null),
  });

  harness.life.beginRun('simulation');
  await flushPromises();
  harness.life.markChaseStarted();
  harness.fireTimers();

  assert.equal(calls.length, 1, 'one chain token must never be in two requests at once');
  assert.equal(calls[0][3], false, 'the immediate run-open beat witnesses Flappy');

  replies[0].resolve('c1');
  await flushPromises();
  assert.equal(calls.length, 2, 'the queued phase transition follows the first response');
  assert.equal(calls[1][2], 'c1');
  assert.equal(calls[1][3], true);

  replies[1].resolve('c2');
  await flushPromises();
  assert.equal(harness.life.state().runChain, 'c2');
});

test('score submission waits for the current heartbeat chain to settle', async () => {
  const beatReplies = [];
  const submissions = [];
  const harness = lifecycleHarness({
    startRun: () => Promise.resolve({ runId: 'run-2', nonce: 'run-2', chain: 'c0' }),
    beat: () => {
      const reply = deferred();
      beatReplies.push(reply);
      return reply.promise;
    },
    submitScore: (...args) => {
      submissions.push(args);
      return Promise.resolve({ rank: 1, improved: true, bestMs: 9000 });
    },
  });

  harness.life.beginRun('practice');
  await flushPromises();
  harness.life.markChaseStarted();
  harness.life.finishRun({ timeMs: 9000, misses: 3, nearMisses: 4, sus: 0, sig: 'abc' });
  assert.equal(submissions.length, 0);

  beatReplies[0].resolve('c1');
  await flushPromises();
  assert.equal(submissions.length, 0, 'the queued Chase-stamp beat must settle too');

  beatReplies[1].resolve('c2');
  await flushPromises();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], 'run-2');
});

test('Simulation waits for the challenge solve before stamping Chase', async () => {
  const events = [];
  const eventReplies = [];
  const beats = [];
  const harness = lifecycleHarness({
    startRun: () => Promise.resolve({ runId: 'run-challenge', nonce: 'run-challenge', chain: 'c0' }),
    beat: (...args) => { beats.push(args); return Promise.resolve('c1'); },
    event: (...args) => {
      events.push(args);
      const reply = deferred();
      eventReplies.push(reply);
      return reply.promise;
    },
    submitScore: () => Promise.resolve(null),
  });

  harness.life.setRunning('simulation');
  harness.life.beginRun('simulation');
  await flushPromises();
  const started = harness.life.reportChallenge('start');
  const solved = harness.life.reportChallenge('solve', { answers: [1, 2, 3] });
  const ready = harness.life.reportChallenge('ready');
  assert.equal(typeof started.then, 'function');
  assert.equal(typeof solved.then, 'function');
  assert.equal(typeof ready.then, 'function');
  await flushPromises();

  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'challenge_start');
  assert.equal(harness.life.state().inChase, false);

  eventReplies[0].resolve({ version: 1, rounds: [{}, {}, {}] });
  await flushPromises();
  assert.equal(events.length, 2);
  assert.equal(events[1][0], 'challenge_solve');
  assert.deepEqual(events[1][3].answers, [1, 2, 3]);
  assert.equal(harness.life.state().inChase, false);

  eventReplies[1].resolve({ solved: true });
  await flushPromises();
  assert.equal(harness.life.state().inChase, true);
  assert.equal(beats.at(-1)[3], true, 'the phase-stamp beat follows the solve request');
});

test('a refused challenge solve never stamps or starts Simulation Chase', async () => {
  const replies = [];
  const beats = [];
  const harness = lifecycleHarness({
    startRun: () => Promise.resolve({ runId: 'run-refused', nonce: 'run-refused', chain: 'c0' }),
    beat: (...args) => { beats.push(args); return Promise.resolve('c1'); },
    event: () => {
      const reply = deferred();
      replies.push(reply);
      return reply.promise;
    },
    submitScore: () => Promise.resolve(null),
  });

  harness.life.setRunning('simulation');
  harness.life.beginRun('simulation');
  await flushPromises();
  harness.life.reportChallenge('start');
  harness.life.reportChallenge('solve', { answers: [0, 0, 0, 0] });
  const ready = harness.life.reportChallenge('ready');
  await flushPromises();
  replies[0].resolve({ version: 1, rounds: [{}, {}, {}, {}] });
  await flushPromises();
  replies[1].resolve({ refused: true, error: 'challenge_incorrect' });
  await ready;

  assert.equal(harness.life.state().inChase, false);
  assert.equal(beats.some((beat) => beat[3] === true), false);
});

test('a ban report stays bound to the attempt that raised it', async () => {
  const events = [];
  const harness = lifecycleHarness({
    startRun: () => Promise.resolve({ runId: 'run-banned', nonce: 'run-banned', chain: 'c0' }),
    beat: () => Promise.resolve('c1'),
    event: (...args) => { events.push(args); },
    submitScore: () => Promise.resolve(null),
  });

  harness.life.beginRun('simulation');
  await flushPromises();
  harness.life.reportBan('timeout');

  assert.deepEqual(events, [['ban', 'timeout', 'run-banned']]);
  assert.equal(harness.life.state().runId, null);
});

function flappyInputHarness() {
  const counters = { flaps: 0, begins: 0, resets: 0, sus: 0 };
  const sandbox = {
    stopped: false,
    state: 'playing',
    clock: 1,
    stateAt: 0,
    READY_INPUT_LOCK: 0.25,
    DEAD_RETRY_DELAY: 0.45,
    beginRun() { counters.begins += 1; },
    flap() { counters.flaps += 1; },
    resetRun() { counters.resets += 1; },
    sus() { counters.sus += 1; },
    note() {},
  };
  const body = sliceBetween(
    source('flappy.js'),
    '    function onInput() {',
    '    function onResize() {',
  );
  vm.runInNewContext(`${body}\nthis.__input = {
    pointer: onPointerDown,
    touch: onTouchStart,
    key: onKeyDown
  };`, sandbox, { filename: 'flappy-input.js' });
  return { input: sandbox.__input, counters };
}

test('untrusted synthetic events cannot drive Flappy gameplay', () => {
  const { input, counters } = flappyInputHarness();
  const event = {
    isTrusted: false,
    cancelable: true,
    code: 'Space',
    key: ' ',
    keyCode: 32,
    repeat: false,
    preventDefault() {},
  };

  input.pointer(event);
  input.touch(event);
  input.key(event);
  assert.equal(counters.flaps, 0);
  assert.equal(counters.sus, 3);

  input.pointer({ ...event, isTrusted: true });
  assert.equal(counters.flaps, 1, 'real browser input still reaches the game');
});

test('the winning press needs a current multi-frame aim journey', () => {
  const chase = source('chase.js');
  assert.match(chase, /var AIM_MIN_MS\s*=\s*[1-9][0-9]*;/);
  assert.match(chase, /var AIM_MIN_FRAMES\s*=\s*[2-9][0-9]*;/);
  assert.match(chase, /function recordAimMove\(cx, cy, t\)/);
  assert.match(chase, /function aimJourneyOK\(\)/);

  const gate = sliceBetween(
    chase,
    '          if (!aimJourneyOK()) {',
    '          if (CAPTCHA_ON && !captchaComplete()) {',
  );
  assert.match(gate, /addMiss\('aim-journey'\)/);
  assert.match(gate, /return;/);
});

test('the ranked Chase arming gate allows a 400 ms finish', () => {
  const chase = source('chase.js');
  assert.match(chase, /var ARM_MS\s*=\s*400;/);
  assert.match(chase, /var ARM_FRAMES\s*=\s*12;/);
});

test('every board-ranked Chase win is gated by the visual CAPTCHA; Practice plays clean', () => {
  const chase = source('chase.js');
  // V4.3: the captcha exists only in the gauntlet modes. Practice must neither
  // show one nor hold its win press hostage to a puzzle that cannot come.
  assert.match(chase, /var CAPTCHA_ON\s*=\s*PRESTART_CHALLENGE;/);
  const gate = sliceBetween(
    chase,
    '          if (CAPTCHA_ON && !captchaComplete()) {',
    '          win();',
  );
  assert.match(gate, /showCaptcha\('win'\)/);
  assert.match(gate, /return;/);
});

test('the puzzle renders only a valid server challenge before accepting a drag', () => {
  const chase = source('chase.js');
  // V4.3: one round, declared to the server on challenge_start.
  assert.match(chase, /var CAPTCHA_ROUNDS\s*=\s*1;/);
  assert.doesNotMatch(chase, /INDEFINITE BAN/);
  const shown = sliceBetween(
    chase,
    '    function showCaptcha(reason) {',
    '    function solveCaptcha() {',
  );
  assert.match(shown, /capArmed = false;/);
  assert.match(shown, /challengeSignal\('start'/);
  assert.match(shown, /validChallenge\(payload\)/);
  assert.match(shown, /capBuild\(payload\.rounds\[0\]\)/);
  assert.doesNotMatch(shown, /then\(armChallenge, armChallenge\)/);

  const pointer = sliceBetween(
    chase,
    "    on(capPiece, 'pointerdown'",
    "    on(capPiece, 'pointermove'",
  );
  assert.match(pointer, /!capArmed/);
});

test('Simulation starts its local Chase only after the server phase stamp settles', () => {
  const chase = source('chase.js');
  const completion = sliceBetween(
    chase,
    '      if (capBeatT > 0 && now >= capBeatT) {',
    '    // Trusted pointer only',
  );
  assert.match(completion, /Promise\.resolve\(challengeSignal\('ready'/);
  assert.match(completion, /then\(beginVerifiedChase, beginVerifiedChase\)/);
  assert.doesNotMatch(completion, /if \(PRESTART_CHALLENGE && !started\) startTimer\(\);/);
});

test('ranked challenge answers exist only on the server and submit as one batch', () => {
  const chase = source('chase.js');
  assert.match(chase, /var CAPTCHA_MIN_MS\s*=\s*500;/);
  assert.match(chase, /var CAPTCHA_MAX_MS\s*=\s*1800;/);
  const challenge = sliceBetween(
    chase,
    '    /* ---------------- V3.11: the visual challenge ----------------',
    '    // Reversible, and it never stops play:',
  );
  assert.doesNotMatch(challenge, /targetHole|capDrawScene|seed\s*=\s*strongSeed/);
  assert.match(challenge, /capAnswers\.push\(choice\);/);
  assert.match(challenge, /answers:\s*capAnswers\.slice\(\)/);
  assert.match(challenge, /capRound \+ 1 < capPayload\.rounds\.length/);
  assert.match(
    chase,
    /capAt = now \+ CAPTCHA_MIN_MS \+ rnd\(\) \* \(CAPTCHA_MAX_MS - CAPTCHA_MIN_MS\);/,
  );
  assert.match(chase, /if \(PRESTART_CHALLENGE\) showCaptcha\('pre-chase'\);/);
});

test('Practice excludes only puzzle time while pauses keep costing time', () => {
  const chase = source('chase.js');
  const solved = sliceBetween(
    chase,
    '    function acceptChallenge(unranked) {',
    '    function solveCaptcha() {',
  );
  assert.match(solved, /shStartT\.set\(shStartT\.get\(\) \+ solveMs\);/);
  assert.match(solved, /startWall \+= WALL\(\) - capShownWall;/);
  assert.match(solved, /startWall2 \+= wall2\(\) - capShownWall2;/);

  const resume = sliceBetween(
    chase,
    '    function leavePause() {',
    '    /* One resolver for both reasons.',
  );
  assert.doesNotMatch(resume, /shStartT\.set|startWall\s*\+=|startWall2\s*\+=/);
  assert.match(resume, /Every pause keeps costing wall-clock time/);
});

test('the Simulation chase samples a fresh bounded spawn after verification', () => {
  const chase = source('chase.js');
  const coordinate = sliceBetween(
    chase,
    '    function spawnCoordinate(min, max, unit, fallback) {',
    '    // Simulation does not inherit',
  );
  const sandbox = {};
  vm.runInNewContext(`${coordinate}\nthis.spawnCoordinate = spawnCoordinate;`, sandbox);
  assert.equal(sandbox.spawnCoordinate(10, 110, 0, 50), 10);
  assert.equal(sandbox.spawnCoordinate(10, 110, 0.25, 50), 35);
  assert.equal(sandbox.spawnCoordinate(10, 110, 1, 50), 110);
  assert.equal(sandbox.spawnCoordinate(10, 10, 0.5, 50), 50);

  const randomize = sliceBetween(
    chase,
    '    function randomizeSpawn() {',
    '    /* Ruling 3.',
  );
  assert.match(randomize, /seed = strongSeed\(\);/);
  assert.match(randomize, /x = spawnCoordinate\(bounds\.minX, bounds\.maxX, rnd\(\), vw \/ 2\);/);
  assert.match(randomize, /y = spawnCoordinate\(bounds\.minY, bounds\.maxY, rnd\(\), vh \/ 2\);/);
  assert.match(chase, /if \(PRESTART_CHALLENGE\) randomizeSpawn\(\);/);
});

test('the Simulation popup is slightly narrower than Practice and keeps its aspect ratio', () => {
  const main = source('main.js');
  function dimensions(name) {
    const block = main.match(new RegExp(`var ${name} = \\{([\\s\\S]*?)\\n  \\};`));
    assert.ok(block, `missing ${name} config`);
    return {
      width: Number(block[1].match(/imageW:\s*([0-9]+)/)[1]),
      height: Number(block[1].match(/imageH:\s*([0-9]+)/)[1]),
    };
  }
  const practice = dimensions('PRACTICE');
  const simulation = dimensions('SIMULATION');
  assert.ok(simulation.width < practice.width);
  assert.ok(simulation.height < practice.height);
  assert.ok(Math.abs(simulation.width / simulation.height - 312 / 128) < 0.02);
});

test('resizing the browser cannot shrink the ranked Chase field', () => {
  const chase = source('chase.js');
  const width = Number(chase.match(/var PLAYFIELD_W\s*=\s*([0-9]+);/)[1]);
  const height = Number(chase.match(/var PLAYFIELD_H\s*=\s*([0-9]+);/)[1]);
  assert.equal(width, 1120);
  assert.equal(height, 620);

  const boundsSource = sliceBetween(
    chase,
    '    function playBounds() {',
    '    function clampIntoView() {',
  );
  function bounds(vw, vh) {
    const sandbox = {
      vw, vh, PLAYFIELD_W: width, PLAYFIELD_H: height,
      cardW: 136, cardH: 172, EDGE_PAD: 10,
    };
    vm.runInNewContext(`${boundsSource}\nthis.bounds = playBounds();`, sandbox);
    return sandbox.bounds;
  }
  const exact = bounds(width, height);
  const wide = bounds(width + 400, height + 200);
  assert.equal(exact.maxX - exact.minX, wide.maxX - wide.minX);
  assert.equal(exact.maxY - exact.minY, wide.maxY - wide.minY);
  assert.equal(wide.minX - exact.minX, 200, 'a larger viewport only centres the field');
  assert.equal(wide.minY - exact.minY, 100);

  const playable = sliceBetween(
    chase,
    '    function playable() {',
    '    function enterPause() {',
  );
  assert.match(playable, /vw >= PLAYFIELD_W && vh >= PLAYFIELD_H/);
});

test('the landing activity log names detected cheating', () => {
  const main = source('main.js');
  assert.match(main, /cheat_detected:\s*\['fi-e',\s*'!'\]/);
  const words = sliceBetween(
    main,
    '  function feedWords(type, d) {',
    '  /* V3.6:',
  );
  assert.match(words, /type === 'cheat_detected'/);
  assert.match(words, /was caught cheating/);

  const net = source('net.js');
  assert.match(
    net,
    /var FEED_KINDS = \[[^\]]*'cheat_detected'/,
    'the SSE client must not discard the server event before main can render it',
  );
});

test('the Simulation floor retains only bounded registration slack below physics', () => {
  const flappy = source('flappy.js');
  const number = (name) => {
    const match = flappy.match(new RegExp(`(?:var |, )${name} = ([0-9.]+)`));
    assert.ok(match, `missing numeric physics constant ${name}`);
    return Number(match[1]);
  };

  const targetScore = 10;
  const scoreDistance = number('FIRST_PIPE_X')
    + (targetScore - 1) * number('PIPE_SPACING')
    + number('PIPE_W')
    - number('BIRD_X');
  const fixedStep = number('FIX_DT');
  const playingSeconds = Math.ceil(
    (scoreDistance / number('SCROLL_SPEED')) / fixedStep,
  ) * fixedStep;
  const earliestHandoffMs = Math.round(
    (number('READY_INPUT_LOCK') + playingSeconds + number('VICTORY_BEAT')) * 1000,
  );
  const registrationSlackMs = earliestHandoffMs - LIMITS.MIN_FLAPPY_PHASE_MS;

  assert.equal(earliestHandoffMs, 15922);
  assert.ok(registrationSlackMs >= 0, 'the server floor must not exceed honest physics');
  assert.ok(registrationSlackMs < 4000, 'registration slack must remain tightly bounded');
});

test('the static page constrains script execution and API connections', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const match = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
  );
  assert.ok(match, 'the GitHub Pages document needs a meta CSP');
  const policy = match[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self' https:\/\/emoney-aimlabs-api-production\.up\.railway\.app/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
});

test('the client build manifest matches every shipped script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<script type="application\/json" data-aimlab-build="1">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'missing embedded build manifest');
  const manifest = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(manifest).sort(), [
    'js/chase.js', 'js/flappy.js', 'js/main.js', 'js/net.js', 'js/sentinel.js',
  ]);
  for (const [name, expected] of Object.entries(manifest)) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, name)))
      .digest('hex');
    assert.equal(actual, expected, name);
  }
});

function netHarness({ token, legacyToken, hash = '', fetchImpl } = {}) {
  const requests = [];
  const sessionValues = new Map(token ? [['eal_session', token]] : []);
  const localValues = new Map(legacyToken ? [['eal_session', legacyToken]] : []);
  const win = {
    fetch(url, options) {
      requests.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options, requests.length);
      return Promise.resolve({ status: 204, ok: true });
    },
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) || null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: (key) => sessionValues.delete(key),
    },
    localStorage: {
      getItem: (key) => localValues.get(key) || null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: (key) => localValues.delete(key),
    },
    location: { hash, pathname: '/emoneyAimLabs/', search: '' },
    history: { replaceState() {} },
  };
  vm.runInNewContext(source('net.js'), {
    window: win,
    Promise,
    Date,
    Object,
    JSON,
    encodeURIComponent,
    decodeURIComponent,
  }, { filename: 'net.js' });
  return { net: win.AimlabNet, requests, sessionValues, localValues };
}

test('bearer-only logout sends the token before deleting the browser copy', async () => {
  const token = 'signed-session-token';
  const harness = netHarness({ token });

  const loggedOut = harness.net.logout();
  assert.equal(
    harness.sessionValues.has('eal_session'),
    false,
    'the tab-scoped copy disappears immediately',
  );
  await loggedOut;

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].url.endsWith('/auth/logout'), true);
  assert.equal(harness.requests[0].options.headers.Authorization, `Bearer ${token}`);
});

test('logout reports that server-side revocation did not complete', async () => {
  const harness = netHarness({
    token: 'signed-session-token',
    fetchImpl: async () => ({ status: 503, ok: false }),
  });

  assert.equal(await harness.net.logout(), false);
  assert.equal(harness.sessionValues.has('eal_session'), false);
  assert.equal(harness.localValues.has('eal_session'), false);
});

test('login bearer stays tab-scoped and any legacy persistent copy is purged', () => {
  const token = 'fresh-session-token';
  const harness = netHarness({
    legacyToken: 'old-persistent-token',
    hash: `#session=${encodeURIComponent(token)}`,
  });

  assert.equal(harness.sessionValues.get('eal_session'), token);
  assert.equal(harness.localValues.has('eal_session'), false);
});

test('challenge solve sends all server-blind choices in one request', async () => {
  const harness = netHarness();
  await harness.net.event('challenge_solve', '', 'run-id', { answers: [3, 0, 2, 1] });
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(
    JSON.parse(harness.requests[0].options.body),
    { type: 'challenge_solve', runId: 'run-id', answers: [3, 0, 2, 1] },
  );
});

test('challenge start declares the round count this client renders', async () => {
  // V4.3: the server serves exactly the declared count; without the field a
  // legacy server (or a legacy client) falls back to the four-round set.
  const harness = netHarness();
  await harness.net.event('challenge_start', '', 'run-id', { cycle: 1, rounds: 1 });
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(
    JSON.parse(harness.requests[0].options.body),
    { type: 'challenge_start', runId: 'run-id', rounds: 1 },
  );
});

test('challenge retry responses preserve the server delay without marking an outage', async () => {
  const harness = netHarness({
    fetchImpl: async () => ({
      status: 429,
      ok: false,
      json: async () => ({
        error: 'challenge_retry_later',
        message: 'Wait briefly',
        retryAfterSeconds: 15,
      }),
    }),
  });

  const reply = await harness.net.event('challenge_start', '', 'run-id');
  assert.equal(reply.refused, true);
  assert.equal(reply.error, 'challenge_retry_later');
  assert.equal(reply.retryAfterSeconds, 15);
});

test('a transient API cooldown cannot suppress logout revocation', async () => {
  const harness = netHarness({
    token: 'signed-session-token',
    fetchImpl(url, options, number) {
      if (number === 1) return Promise.reject(new Error('temporary network failure'));
      return Promise.resolve({ status: 204, ok: true });
    },
  });

  assert.equal(await harness.net.startRun('practice'), null);
  await harness.net.logout();

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].url.endsWith('/auth/logout'), true);
  assert.equal(
    harness.requests[1].options.headers.Authorization,
    'Bearer signed-session-token',
  );
});

test('server errors and malformed success bodies enter the client cooldown', async () => {
  const serverError = netHarness({
    fetchImpl: async () => ({ status: 503, ok: false }),
  });
  assert.equal(await serverError.net.startRun('practice'), null);
  assert.equal(await serverError.net.me(), null);
  assert.equal(serverError.requests.length, 1, '5xx should quiet subsequent traffic');

  const malformed = netHarness({
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new Error('truncated JSON'); },
    }),
  });
  assert.equal(await malformed.net.startRun('practice'), null);
  assert.equal(await malformed.net.me(), null);
  assert.equal(malformed.requests.length, 1, 'malformed 2xx should quiet subsequent traffic');
});
