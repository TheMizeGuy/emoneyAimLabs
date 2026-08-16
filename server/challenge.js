'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CHALLENGE_ROUNDS = 4;
const WIDTH = 260;
const HEIGHT = 140;
const PIECE = 46;
const HOLE_BASES = Object.freeze([
  Object.freeze({ x: 55, y: 14 }),
  Object.freeze({ x: 155, y: 18 }),
  Object.freeze({ x: 82, y: 86 }),
  Object.freeze({ x: 175, y: 83 }),
]);
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function newChallengeSeed() {
  return crypto.randomBytes(32).toString('base64url');
}

function keyedBytes(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest();
}

function expectedAnswers({ runId, seed, secret }) {
  return Array.from({ length: CHALLENGE_ROUNDS }, (_, round) => (
    keyedBytes(secret, `challenge-answer\0${runId}\0${seed}\0${round}`)[0] & 3
  ));
}

function matchesAnswers(candidate, key) {
  if (!Array.isArray(candidate) || candidate.length !== CHALLENGE_ROUNDS) return false;
  if (!candidate.every((answer) => Number.isInteger(answer) && answer >= 0 && answer < 4)) {
    return false;
  }
  const expected = Buffer.from(expectedAnswers(key));
  return crypto.timingSafeEqual(Buffer.from(candidate), expected);
}

function makeRng(secret, runId, seed, round) {
  let block = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;

  function byte() {
    if (offset >= block.length) {
      block = keyedBytes(secret, `challenge-render\0${runId}\0${seed}\0${round}\0${counter}`);
      counter += 1;
      offset = 0;
    }
    const value = block[offset];
    offset += 1;
    return value;
  }

  function int(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 65536) {
      throw new RangeError('challenge rng bound must be an integer from 1 through 65536');
    }
    const space = maxExclusive <= 256 ? 256 : 65536;
    const draw = maxExclusive <= 256 ? byte : () => (byte() << 8) | byte();
    const ceiling = space - (space % maxExclusive);
    let value = draw();
    while (value >= ceiling) value = draw();
    return value % maxExclusive;
  }

  return { byte, int };
}

function image(width, height) {
  return { width, height, pixels: Buffer.alloc(width * height * 4) };
}

function setPixel(target, x, y, color) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  const at = (Math.floor(y) * target.width + Math.floor(x)) * 4;
  target.pixels[at] = color[0];
  target.pixels[at + 1] = color[1];
  target.pixels[at + 2] = color[2];
  target.pixels[at + 3] = color.length > 3 ? color[3] : 255;
}

function fillRect(target, x, y, width, height, color) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(target.width, Math.ceil(x + width));
  const bottom = Math.min(target.height, Math.ceil(y + height));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) setPixel(target, px, py, color);
  }
}

function drawLine(target, x0, y0, x1, y1, color) {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const sx = ax < bx ? 1 : -1;
  const dy = -Math.abs(by - ay);
  const sy = ay < by ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setPixel(target, ax, ay, color);
    if (ax === bx && ay === by) break;
    const twice = err * 2;
    if (twice >= dy) { err += dy; ax += sx; }
    if (twice <= dx) { err += dx; ay += sy; }
  }
}

function fillCircle(target, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= r2) setPixel(target, cx + x, cy + y, color);
    }
  }
}

function fillTriangle(target, a, b, c, color) {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const edge = (p1, p2, x, y) => (x - p1.x) * (p2.y - p1.y) - (y - p1.y) * (p2.x - p1.x);
  const area = edge(a, b, c.x, c.y);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const e1 = edge(a, b, x, y);
      const e2 = edge(b, c, x, y);
      const e3 = edge(c, a, x, y);
      if (area < 0 ? (e1 <= 0 && e2 <= 0 && e3 <= 0) : (e1 >= 0 && e2 >= 0 && e3 >= 0)) {
        setPixel(target, x, y, color);
      }
    }
  }
}

function copyRect(source, x, y, width, height) {
  const out = image(width, height);
  for (let py = 0; py < height; py += 1) {
    const from = ((y + py) * source.width + x) * 4;
    const to = py * width * 4;
    source.pixels.copy(out.pixels, to, from, from + width * 4);
  }
  return out;
}

function renderScene(rng) {
  const out = image(WIDTH, HEIGHT);
  const skyTop = [25 + rng.int(45), 35 + rng.int(55), 70 + rng.int(80), 255];
  const skyBottom = [105 + rng.int(55), 95 + rng.int(65), 110 + rng.int(75), 255];
  for (let y = 0; y < HEIGHT; y += 1) {
    const mix = y / (HEIGHT - 1);
    const color = [
      Math.round(skyTop[0] + (skyBottom[0] - skyTop[0]) * mix),
      Math.round(skyTop[1] + (skyBottom[1] - skyTop[1]) * mix),
      Math.round(skyTop[2] + (skyBottom[2] - skyTop[2]) * mix),
      255,
    ];
    fillRect(out, 0, y, WIDTH, 1, color);
  }

  fillCircle(out, 165 + rng.int(70), 22 + rng.int(32), 10 + rng.int(10), [235, 205, 105, 255]);
  fillTriangle(out, { x: 0, y: 105 }, { x: 55 + rng.int(45), y: 48 + rng.int(22) },
    { x: 168, y: 105 }, [58 + rng.int(25), 64 + rng.int(25), 77 + rng.int(30), 255]);
  fillTriangle(out, { x: 70, y: 108 }, { x: 155 + rng.int(45), y: 42 + rng.int(28) },
    { x: WIDTH, y: 108 }, [43 + rng.int(20), 49 + rng.int(20), 63 + rng.int(24), 255]);
  fillRect(out, 0, 101, WIDTH, 39, [24, 29, 39, 255]);

  for (let i = 0; i < 7; i += 1) {
    const x = 7 + i * 37;
    const height = 17 + rng.int(36);
    const shade = 18 + rng.int(22);
    fillRect(out, x, 101 - height, 25, height, [shade, shade + 4, shade + 11, 255]);
    for (let row = 0; row < Math.floor(height / 9); row += 1) {
      if (rng.int(4) === 0) continue;
      const wy = 105 - height + row * 9;
      fillRect(out, x + 5, wy, 5, 5, [226, 177 + rng.int(45), 75 + rng.int(55), 255]);
      fillRect(out, x + 14, wy, 5, 5, [226, 177 + rng.int(45), 75 + rng.int(55), 255]);
    }
  }

  // Thin, high-entropy paths cross several candidate boundaries. A person can
  // match their continuations; the correct slot is not present as metadata.
  for (let i = 0; i < 28; i += 1) {
    const color = [80 + rng.int(176), 80 + rng.int(176), 80 + rng.int(176), 255];
    drawLine(out, rng.int(WIDTH), rng.int(HEIGHT), rng.int(WIDTH), rng.int(HEIGHT), color);
  }
  for (let i = 0; i < 18; i += 1) {
    fillCircle(out, rng.int(WIDTH), rng.int(HEIGHT), 1 + rng.int(3),
      [100 + rng.int(156), 100 + rng.int(156), 100 + rng.int(156), 255]);
  }
  return out;
}

function challengeHoles(rng) {
  return HOLE_BASES.map((base) => ({
    x: base.x + rng.int(17) - 8,
    y: base.y + rng.int(13) - 6,
  }));
}

function camouflagePiece(piece) {
  const edge = 4;
  const light = [118, 126, 138, 255];
  const dark = [44, 51, 62, 255];
  fillRect(piece, 0, 0, PIECE, edge, light);
  fillRect(piece, 0, PIECE - edge, PIECE, edge, dark);
  fillRect(piece, 0, 0, edge, PIECE, light);
  fillRect(piece, PIECE - edge, 0, edge, PIECE, dark);
}

function stylizePiece(source, rng) {
  const out = image(PIECE, PIECE);
  const turns = rng.int(4);
  const inverted = rng.int(2) === 1;
  const low = [rng.int(65), rng.int(65), rng.int(65)];
  const high = [190 + rng.int(66), 190 + rng.int(66), 190 + rng.int(66)];

  function sourcePoint(x, y) {
    if (turns === 1) return { x: y, y: PIECE - 1 - x };
    if (turns === 2) return { x: PIECE - 1 - x, y: PIECE - 1 - y };
    if (turns === 3) return { x: PIECE - 1 - y, y: x };
    return { x, y };
  }

  for (let y = 0; y < PIECE; y += 1) {
    for (let x = 0; x < PIECE; x += 1) {
      const point = sourcePoint(x, y);
      const from = (point.y * PIECE + point.x) * 4;
      let level = Math.round((
        source.pixels[from] * 0.299
        + source.pixels[from + 1] * 0.587
        + source.pixels[from + 2] * 0.114
      ) / 255 * 4) / 4;
      if (inverted) level = 1 - level;
      setPixel(out, x, y, [
        Math.round(low[0] + (high[0] - low[0]) * level),
        Math.round(low[1] + (high[1] - low[1]) * level),
        Math.round(low[2] + (high[2] - low[2]) * level),
        255,
      ]);
    }
  }
  camouflagePiece(out);
  return out;
}

function punchHoles(scene, holes) {
  const edge = 8;
  for (const hole of holes) {
    // Every candidate receives the same opaque frame outside the missing
    // pixels. That small visual gap leaves a person enough context to continue
    // lines and shapes, but removes the exact edge-to-edge pixel oracle that a
    // mechanical matcher would otherwise exploit with near-perfect accuracy.
    fillRect(scene, hole.x - edge, hole.y - edge,
      PIECE + edge * 2, PIECE + edge * 2, [44, 51, 62, 255]);
    fillRect(scene, hole.x - edge, hole.y - edge,
      PIECE + edge * 2, edge, [118, 126, 138, 255]);
    fillRect(scene, hole.x - edge, hole.y - edge,
      edge, PIECE + edge * 2, [118, 126, 138, 255]);
    fillRect(scene, hole.x, hole.y, PIECE, PIECE, [10, 16, 24, 255]);
  }
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([size, name, data, checksum]);
}

function pngDataUrl(source) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(source.width, 0);
  header.writeUInt32BE(source.height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowSize = source.width * 4;
  const raw = Buffer.alloc((rowSize + 1) * source.height);
  for (let y = 0; y < source.height; y += 1) {
    const to = y * (rowSize + 1);
    raw[to] = 0;
    source.pixels.copy(raw, to + 1, y * rowSize, (y + 1) * rowSize);
  }
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function buildChallenge({ runId, seed, secret }) {
  if (typeof runId !== 'string' || !runId || typeof seed !== 'string' || !seed || !secret) {
    throw new TypeError('challenge key material is required');
  }
  const answers = expectedAnswers({ runId, seed, secret });
  const rounds = [];
  for (let round = 0; round < CHALLENGE_ROUNDS; round += 1) {
    const rng = makeRng(secret, runId, seed, round);
    const scene = renderScene(rng);
    const holes = challengeHoles(rng);
    const piece = stylizePiece(
      copyRect(scene, holes[answers[round]].x, holes[answers[round]].y, PIECE, PIECE),
      rng,
    );
    punchHoles(scene, holes);
    rounds.push({
      scene: pngDataUrl(scene),
      piece: pngDataUrl(piece),
      holes,
      start: { x: 6, y: HEIGHT - PIECE - 8 },
    });
  }
  return { version: 1, rounds };
}

module.exports = {
  CHALLENGE_ROUNDS,
  buildChallenge,
  expectedAnswers,
  matchesAnswers,
  newChallengeSeed,
};
