'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'eal_session';
const STATE_COOKIE = 'eal_oauth_state';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

// Constant-time compare that tolerates length mismatches without throwing.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing does not leak the length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Session token: base64url(payload JSON) "." base64url(HMAC-SHA256(payload)).
// The payload carries only the Twitch user id, the issue/expiry stamps and the
// session epoch - no tokens, no email, nothing secret.
//
// The epoch is what makes a stateless cookie revocable: it is compared against
// the user's current epoch on every authenticated request, so logging out
// (which bumps the stored epoch) retires every cookie that user ever held.
function signSession(secret, { sub, nowMs, ttlMs, epoch = 0 }) {
  const payload = JSON.stringify({ sub, iat: nowMs, exp: nowMs + ttlMs, ep: epoch });
  const body = b64url(payload);
  return `${body}.${b64url(hmac(secret, body))}`;
}

function verifySession(secret, token, nowMs) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, b64url(hmac(secret, body)))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) return null;
  return {
    sub: payload.sub,
    iat: payload.iat,
    exp: payload.exp,
    // Tokens minted before the epoch existed are treated as epoch 0.
    epoch: Number.isFinite(payload.ep) ? payload.ep : 0,
  };
}

// OAuth state: a random nonce and its issue time, signed together. The nonce
// travels in the query string, the signed triple in a short-lived cookie; the
// callback requires both to agree, which is the CSRF gate on the login flow.
//
// The issue time is inside the signed value so expiry is enforced by the SERVER
// rather than by a browser honouring Max-Age. Freshness alone does not make a
// state one-shot, so the callback also burns the nonce (see createNonceStore).
function createState(secret, nowMs) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = String(nowMs);
  const signed = `${nonce}.${issuedAt}`;
  return { nonce, cookie: `${signed}.${b64url(hmac(secret, signed))}` };
}

function verifyState(secret, cookieValue, nonceFromQuery, nowMs, ttlMs) {
  if (typeof cookieValue !== 'string' || typeof nonceFromQuery !== 'string') return false;
  if (nonceFromQuery.length === 0 || nonceFromQuery.length > 128) return false;

  const parts = cookieValue.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, sig] = parts;
  if (!safeEqual(sig, b64url(hmac(secret, `${nonce}.${issuedAt}`)))) return false;

  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs)) return false;
  const ageMs = nowMs - issuedAtMs;
  if (ageMs < 0 || ageMs > ttlMs) return false;

  return safeEqual(nonce, nonceFromQuery);
}

// Burns a nonce so a captured state pair cannot be replayed even while it is
// still inside its signed lifetime. In process, like the rest of the runtime
// state, on the single-replica assumption already documented for the feed.
function createNonceStore(options = {}) {
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs || 10 * 60 * 1000;
  const maxEntries = options.maxEntries || 10000;
  const used = new Map();

  function prune(nowMs) {
    for (const [nonce, at] of used) {
      if (nowMs - at > ttlMs) used.delete(nonce);
      else break; // insertion order is chronological
    }
  }

  // True the first time a nonce is seen, false forever after.
  function use(nonce) {
    const nowMs = now();
    prune(nowMs);
    if (used.has(nonce)) return false;
    while (used.size >= maxEntries) {
      const oldest = used.keys().next().value;
      if (oldest === undefined) break;
      used.delete(oldest);
    }
    used.set(nonce, nowMs);
    return true;
  }

  return { use, size: () => used.size };
}

// Minimal cookie header parser; avoids a dependency and only handles what the
// API sets itself.
function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (Number.isFinite(options.maxAgeSeconds)) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'None'}`);
  return parts.join('; ');
}

// The game runs on a different origin than the API, so the session cookie has
// to be SameSite=None; Secure. Cross-site request forgery is handled by the
// Origin check in middleware.js, not by SameSite.
function sessionCookie(value, ttlMs) {
  return serializeCookie(SESSION_COOKIE, value, {
    maxAgeSeconds: Math.floor(ttlMs / 1000),
    sameSite: 'None',
  });
}

function clearedSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, sameSite: 'None' });
}

// The state cookie only has to survive the top-level redirect back from
// Twitch, which SameSite=Lax allows, so it does not need None.
function stateCookie(value, ttlMs) {
  return serializeCookie(STATE_COOKIE, value, {
    maxAgeSeconds: Math.floor(ttlMs / 1000),
    sameSite: 'Lax',
  });
}

function clearedStateCookie() {
  return serializeCookie(STATE_COOKIE, '', { maxAgeSeconds: 0, sameSite: 'Lax' });
}

module.exports = {
  SESSION_COOKIE,
  STATE_COOKIE,
  signSession,
  verifySession,
  createState,
  verifyState,
  createNonceStore,
  safeEqual,
  parseCookies,
  serializeCookie,
  sessionCookie,
  clearedSessionCookie,
  stateCookie,
  clearedStateCookie,
};
