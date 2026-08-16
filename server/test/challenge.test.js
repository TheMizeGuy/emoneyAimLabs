'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  CHALLENGE_ROUNDS,
  buildChallenge,
  expectedAnswers,
  matchesAnswers,
  newChallengeSeed,
} = require('../challenge');

const RUN_ID = 'run_abcdefghijklmnopqrstuvwxyz123456';
const SECRET = 'challenge-test-secret-that-is-not-public';
const SEED = 'seed_abcdefghijklmnopqrstuvwxyz1234567890';

function decodePng(url) {
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(width * height * 4);
  const rowSize = width * 4;
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (rowSize + 1)], 0, 'test decoder expects the server filter');
    raw.copy(pixels, y * rowSize, y * (rowSize + 1) + 1, (y + 1) * (rowSize + 1));
  }
  return { width, height, pixels };
}

function channel(image, x, y, index) {
  return image.pixels[(y * image.width + x) * 4 + index];
}

// The first hostile client tried the most direct puzzle-piece attack: compare
// every loose-piece edge with the pixels immediately outside each public hole.
function boundaryScore(scene, piece, hole) {
  let score = 0;
  for (let i = 1; i < 45; i += 1) {
    for (let color = 0; color < 3; color += 1) {
      score += Math.abs(channel(piece, i, 0, color) - channel(scene, hole.x + i, hole.y - 1, color));
      score += Math.abs(channel(piece, i, 45, color) - channel(scene, hole.x + i, hole.y + 46, color));
      score += Math.abs(channel(piece, 0, i, color) - channel(scene, hole.x - 1, hole.y + i, color));
      score += Math.abs(channel(piece, 45, i, color) - channel(scene, hole.x + 46, hole.y + i, color));
    }
  }
  return score;
}

test('server challenge payload is deterministic raster data that omits its seed and answers', () => {
  const first = buildChallenge({ runId: RUN_ID, seed: SEED, secret: SECRET });
  const second = buildChallenge({ runId: RUN_ID, seed: SEED, secret: SECRET });

  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.equal(first.rounds.length, CHALLENGE_ROUNDS);
  assert.equal(JSON.stringify(first).includes(SEED), false);
  assert.equal(Object.hasOwn(first, 'answers'), false);

  for (const round of first.rounds) {
    assert.match(round.scene, /^data:image\/png;base64,/);
    assert.match(round.piece, /^data:image\/png;base64,/);
    assert.deepEqual(Object.keys(round).sort(), ['holes', 'piece', 'scene', 'start']);
    assert.equal(round.holes.length, 4);
    assert.equal(round.start.x, 6);
    assert.ok(round.start.y > 0);

    const png = Buffer.from(round.scene.slice(round.scene.indexOf(',') + 1), 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
});

test('fresh seeds and server secrets produce independent visual challenges', () => {
  const seedA = newChallengeSeed();
  const seedB = newChallengeSeed();
  assert.notEqual(seedA, seedB);
  assert.match(seedA, /^[A-Za-z0-9_-]{43}$/);

  const a = buildChallenge({ runId: RUN_ID, seed: seedA, secret: SECRET });
  const b = buildChallenge({ runId: RUN_ID, seed: seedB, secret: SECRET });
  const otherSecret = buildChallenge({ runId: RUN_ID, seed: seedA, secret: `${SECRET}-other` });
  assert.notEqual(a.rounds[0].scene, b.rounds[0].scene);
  assert.notEqual(a.rounds[0].scene, otherSecret.rounds[0].scene);
});

test('all independently keyed round answers are required in exact order', () => {
  const answers = expectedAnswers({ runId: RUN_ID, seed: SEED, secret: SECRET });
  assert.equal(answers.length, CHALLENGE_ROUNDS);
  assert.equal(matchesAnswers(answers, { runId: RUN_ID, seed: SEED, secret: SECRET }), true);

  for (let i = 0; i < answers.length; i += 1) {
    const wrong = answers.slice();
    wrong[i] = (wrong[i] + 1) % 4;
    assert.equal(matchesAnswers(wrong, { runId: RUN_ID, seed: SEED, secret: SECRET }), false);
  }
  assert.equal(matchesAnswers(answers.slice(0, -1), { runId: RUN_ID, seed: SEED, secret: SECRET }), false);
  assert.equal(matchesAnswers('0,1,2', { runId: RUN_ID, seed: SEED, secret: SECRET }), false);
});

test('public raster boundaries do not reveal the answers to a mechanical edge matcher', () => {
  let correctRounds = 0;
  let correctRuns = 0;
  const runCount = 40;
  for (let index = 0; index < runCount; index += 1) {
    const runId = `boundary-attack-${index}`;
    const seed = Buffer.alloc(32, index + 1).toString('base64url');
    const payload = buildChallenge({ runId, seed, secret: SECRET });
    const answers = expectedAnswers({ runId, seed, secret: SECRET });
    const guesses = payload.rounds.map((round) => {
      const scene = decodePng(round.scene);
      const piece = decodePng(round.piece);
      const scores = round.holes.map((hole) => boundaryScore(scene, piece, hole));
      return scores.indexOf(Math.min(...scores));
    });
    for (let round = 0; round < guesses.length; round += 1) {
      if (guesses[round] === answers[round]) correctRounds += 1;
    }
    if (guesses.every((guess, round) => guess === answers[round])) correctRuns += 1;
  }

  assert.ok(correctRounds / (runCount * CHALLENGE_ROUNDS) <= 0.45);
  assert.ok(correctRuns / runCount <= 0.15);
});
