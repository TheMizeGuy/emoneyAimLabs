'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  signSession,
  verifySession,
  createState,
  verifyState,
  createNonceStore,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  stateCookie,
} = require('../session');

const SECRET = 'a-secret-that-is-at-least-32-characters-long';
const NOW = 1_760_000_000_000;
const TTL = 30 * 24 * 60 * 60 * 1000;

function signedPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

test('session token round-trips', () => {
  const token = signSession(SECRET, { sub: '12345', nowMs: NOW, ttlMs: TTL });
  const claims = verifySession(SECRET, token, NOW + 1000);
  assert.equal(claims.sub, '12345');
  assert.equal(claims.exp, NOW + TTL);
});

test('session token fails under a different secret', () => {
  const token = signSession(SECRET, { sub: '12345', nowMs: NOW, ttlMs: TTL });
  assert.equal(verifySession(`${SECRET}-other`, token, NOW), null);
});

test('session token fails when the payload is tampered with', () => {
  const token = signSession(SECRET, { sub: '12345', nowMs: NOW, ttlMs: TTL });
  const [body, sig] = token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ sub: '99999', iat: NOW, exp: NOW + TTL }))
    .toString('base64url');
  assert.equal(verifySession(SECRET, `${forgedBody}.${sig}`, NOW), null);
  // Signature swapped for junk.
  assert.equal(verifySession(SECRET, `${body}.deadbeef`, NOW), null);
  // Unsigned payload.
  assert.equal(verifySession(SECRET, body, NOW), null);
  assert.equal(verifySession(SECRET, `${body}.`, NOW), null);
});

test('session token expires', () => {
  const token = signSession(SECRET, { sub: '12345', nowMs: NOW, ttlMs: 1000 });
  assert.equal(verifySession(SECRET, token, NOW + 999).sub, '12345');
  assert.equal(verifySession(SECRET, token, NOW + 1000), null);
});

test('session verification survives hostile input', () => {
  for (const bad of [null, undefined, '', '.', '..', 'a.b.c', 'x'.repeat(2000), 42, {}]) {
    assert.equal(verifySession(SECRET, bad, NOW), null);
  }
});

test('session verification rejects signed but nonsensical claims', () => {
  const invalid = [
    { sub: 'bad player id!', iat: NOW, exp: NOW + 1000, ep: 0 },
    { sub: '12345', iat: NOW + 1, exp: NOW + 1000, ep: 0 },
    { sub: '12345', iat: NOW, exp: NOW - 1, ep: 0 },
    { sub: '12345', iat: NOW, exp: NOW + TTL + 1, ep: 0 },
    { sub: '12345', iat: 'now', exp: NOW + 1000, ep: 0 },
    { sub: '12345', iat: NOW, exp: NOW + 1000, ep: -1 },
    { sub: '12345', iat: NOW, exp: NOW + 1000, ep: 1.5 },
  ];
  for (const payload of invalid) {
    assert.equal(verifySession(SECRET, signedPayload(payload), NOW), null);
  }
});

const STATE_TTL = 600000;

test('oauth state round-trips and rejects mismatches', () => {
  const state = createState(SECRET, NOW);
  assert.equal(verifyState(SECRET, state.cookie, state.nonce, NOW, STATE_TTL), true);
  assert.equal(verifyState(SECRET, state.cookie, 'attacker-nonce', NOW, STATE_TTL), false);
  assert.equal(verifyState(SECRET, 'attacker-nonce.0.sig', 'attacker-nonce', NOW, STATE_TTL), false);
  assert.equal(verifyState(`${SECRET}-other`, state.cookie, state.nonce, NOW, STATE_TTL), false);
  assert.equal(verifyState(SECRET, undefined, state.nonce, NOW, STATE_TTL), false);
  assert.equal(verifyState(SECRET, state.cookie, undefined, NOW, STATE_TTL), false);
});

test('oauth state expiry is enforced by the server, not by the browser', () => {
  const state = createState(SECRET, NOW);
  assert.equal(verifyState(SECRET, state.cookie, state.nonce, NOW + STATE_TTL, STATE_TTL), true);
  // One millisecond past the signed lifetime, whatever the cookie's Max-Age said.
  assert.equal(verifyState(SECRET, state.cookie, state.nonce, NOW + STATE_TTL + 1, STATE_TTL), false);
  // A clock that runs backwards is not a valid state either.
  assert.equal(verifyState(SECRET, state.cookie, state.nonce, NOW - 1, STATE_TTL), false);

  // The issue time is inside the signature, so it cannot be edited forward.
  const [nonce, issuedAt, sig] = state.cookie.split('.');
  const forged = `${nonce}.${Number(issuedAt) + STATE_TTL}.${sig}`;
  assert.equal(verifyState(SECRET, forged, nonce, NOW + STATE_TTL + 1, STATE_TTL), false);
});

test('a state nonce can only be spent once', () => {
  let nowMs = NOW;
  const store = createNonceStore({ now: () => nowMs, ttlMs: STATE_TTL });
  const state = createState(SECRET, nowMs);

  assert.equal(store.use(state.nonce), true, 'first use is the real login');
  assert.equal(store.use(state.nonce), false, 'a replay of the same state is refused');
  assert.equal(store.use(state.nonce), false);
  // A different login is unaffected.
  assert.equal(store.use(createState(SECRET, nowMs).nonce), true);

  // Spent nonces are forgotten once they could no longer be valid anyway.
  nowMs += STATE_TTL + 1;
  store.use('anything');
  assert.ok(store.size() <= 2);
});

test('the nonce store is bounded', () => {
  const store = createNonceStore({ now: () => NOW, ttlMs: STATE_TTL, maxEntries: 100 });
  for (let i = 0; i < 5000; i += 1) store.use(`nonce-${i}`);
  assert.ok(store.size() <= 100, `held ${store.size()}`);
});

test('two states never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(createState(SECRET, NOW).nonce);
  assert.equal(seen.size, 200);
});

test('the session epoch travels in the signed payload', () => {
  const token = signSession(SECRET, { sub: '12345', nowMs: NOW, ttlMs: TTL, epoch: 7 });
  assert.equal(verifySession(SECRET, token, NOW).epoch, 7);
  // A token minted before epochs existed reads as epoch 0.
  assert.equal(verifySession(SECRET, signSession(SECRET, { sub: '1', nowMs: NOW, ttlMs: TTL }), NOW).epoch, 0);

  // The epoch cannot be edited without breaking the signature.
  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.ep = 0;
  const forgedBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.equal(verifySession(SECRET, `${forgedBody}.${sig}`, NOW), null);
});

test('cookie parsing handles multiple pairs and junk', () => {
  const jar = parseCookies('eal_session=abc.def; other=1; broken; quoted="v a l"');
  assert.equal(jar.eal_session, 'abc.def');
  assert.equal(jar.other, '1');
  assert.equal(jar.quoted, 'v a l');
  assert.equal(Object.hasOwn(jar, 'broken'), false);
  assert.deepEqual(parseCookies(undefined), Object.create(null));
  // Prototype pollution attempt stays inert.
  const polluted = parseCookies('__proto__=evil');
  assert.equal({}.evil, undefined);
  assert.equal(polluted.__proto__, 'evil');
});

test('session cookie carries the cross-site flags', () => {
  const header = sessionCookie('token-value', TTL);
  assert.match(header, /^eal_session=token-value/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=None/);
  assert.match(header, /Max-Age=2592000/);
  assert.match(header, /Path=\//);
  assert.match(clearedSessionCookie(), /Max-Age=0/);
});

test('state cookie is Lax so it survives the Twitch redirect without riding on every cross-site call', () => {
  const header = stateCookie('nonce.sig', 600000);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /Max-Age=600/);
});
