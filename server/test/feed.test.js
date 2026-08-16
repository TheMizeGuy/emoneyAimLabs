'use strict';

// The replay buffer (V3.6). Without history, every page load greeted the
// player with an empty log until the next live event; now a subscriber gets
// the recent past first, and the `after` cursor keeps a reconnecting client
// from seeing the same lines twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeed, DEFAULT_HISTORY } = require('../feed');

function sink() {
  return {
    frames: [],
    write(frame) { this.frames.push(frame); return true; },
    end() { this.ended = true; },
    on() {},
  };
}

// Only event frames; the ": connected" comment and keep-alives fall through.
function eventsOf(s) {
  return s.frames
    .map((frame) => /^id: (\d+)\nevent: (\w+)\ndata: (.*)\n\n$/s.exec(frame))
    .filter(Boolean)
    .map((m) => ({ id: Number(m[1]), type: m[2], data: JSON.parse(m[3]) }));
}

test('events emitted with nobody connected replay to the next subscriber', () => {
  const feed = createFeed({ now: () => 12345 });
  assert.equal(feed.emit('run_started', { name: 'A', mode: 'simulation' }), 0);

  const s = sink();
  feed.subscribe(s);
  const got = eventsOf(s);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 1);
  assert.equal(got[0].type, 'run_started');
  assert.equal(got[0].data.name, 'A');
  assert.equal(got[0].data.at, 12345, 'the line carries when it happened');
});

test('replay arrives oldest first and live events keep flowing after it', () => {
  const feed = createFeed({ now: () => 1 });
  feed.emit('run_started', { n: 1 });
  feed.emit('run_won', { n: 2 });

  const s = sink();
  feed.subscribe(s);
  feed.emit('flappy_death', { n: 3 });
  assert.deepEqual(eventsOf(s).map((e) => e.type), ['run_started', 'run_won', 'flappy_death']);
  assert.deepEqual(eventsOf(s).map((e) => e.id), [1, 2, 3]);
});

test('subscribe(after) replays only the gap', () => {
  const feed = createFeed({ now: () => 1 });
  feed.emit('run_started', { n: 1 });
  feed.emit('run_won', { n: 2 });
  feed.emit('flappy_death', { n: 3 });

  // A client that saw everything gets nothing back.
  const caughtUp = sink();
  feed.subscribe(caughtUp, 3);
  assert.equal(eventsOf(caughtUp).length, 0);

  // One that saw only the first line gets the rest, in order.
  const behind = sink();
  feed.subscribe(behind, 1);
  assert.deepEqual(eventsOf(behind).map((e) => e.id), [2, 3]);

  // A cursor from before a restart points beyond this process's counter.
  // Everything here is new to that client: full replay, not starvation.
  const stale = sink();
  feed.subscribe(stale, 999);
  assert.deepEqual(eventsOf(stale).map((e) => e.id), [1, 2, 3]);
});

test('the buffer is a ring: only the newest lines survive', () => {
  const feed = createFeed({ historySize: 3, now: () => 1 });
  for (let i = 1; i <= 5; i += 1) feed.emit('run_started', { n: i });

  const s = sink();
  feed.subscribe(s);
  assert.deepEqual(eventsOf(s).map((e) => e.data.n), [3, 4, 5]);
  assert.deepEqual(eventsOf(s).map((e) => e.id), [3, 4, 5], 'ids are never reused by the trim');
});

test('a seeded feed replays stored history and its ids keep climbing', () => {
  const saved = [];
  const feed = createFeed({
    now: () => 7,
    save: (id, type, data) => { saved.push({ id, type, data }); },
  });

  // What a previous process life left in the store.
  const n = feed.seed([
    { id: 41, type: 'run_started', data: { n: 1, at: 5 } },
    { id: 42, type: 'run_won', data: { n: 2, at: 6 } },
  ]);
  assert.equal(n, 2);

  const s = sink();
  feed.subscribe(s, 41);
  assert.deepEqual(eventsOf(s).map((e) => e.id), [42], 'a live cursor still means what it meant');

  // New events resume past the stored ids and reach the save hook stamped.
  feed.emit('flappy_death', { n: 3 });
  assert.deepEqual(eventsOf(s).map((e) => e.id), [42, 43]);
  assert.deepEqual(saved, [{ id: 43, type: 'flappy_death', data: { n: 3, at: 7 } }]);

  // Seeding is boot-only: a second call cannot rewrite a live buffer.
  assert.equal(feed.seed([{ id: 1, type: 'run_won', data: {} }]), 0);
});

test('a save hook that throws or rejects never takes an emit down', () => {
  const feed = createFeed({ now: () => 1, save: () => { throw new Error('disk gone'); } });
  assert.equal(feed.emit('run_started', { n: 1 }), 0);
  const rejecting = createFeed({ now: () => 1, save: () => Promise.reject(new Error('later')) });
  assert.equal(rejecting.emit('run_started', { n: 1 }), 0);
});

test('emit still reports live deliveries only, and history has a default depth', () => {
  const feed = createFeed({ now: () => 1 });
  const s = sink();
  feed.subscribe(s);
  assert.equal(feed.emit('run_started', { n: 1 }), 1);
  assert.ok(DEFAULT_HISTORY >= 50, 'deep enough to fill the client log from cold');
});
