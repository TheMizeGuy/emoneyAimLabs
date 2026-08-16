'use strict';

const { isIP } = require('node:net');
const {
  parseCookies, verifySession, clearedSessionCookie, SESSION_COOKIE,
} = require('./session');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Railway's public edge supplies the original peer in X-Real-IP. Express's
// req.ip instead consumes X-Forwarded-For when `trust proxy` is enabled, but
// Railway does not document that header as the client identity and a caller can
// supply it. Trust exactly the platform header, validate it to one IP, and fall
// back to the socket for local development or a malformed edge request.
function clientAddress(req) {
  const real = req.headers && req.headers['x-real-ip'];
  if (typeof real === 'string') {
    const candidate = real.trim();
    if (isIP(candidate)) return candidate;
  }
  const remote = req.socket && req.socket.remoteAddress;
  return typeof remote === 'string' && remote.length > 0 ? remote : 'unknown';
}

function sendError(res, status, code, message, extra) {
  const body = { error: code, message };
  if (extra) Object.assign(body, extra);
  return res.status(status).json(body);
}

// Hand-rolled hardening headers. The API returns JSON only and is never framed
// or embedded, so the policy can be maximally restrictive.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// CORS pinned to exactly one origin, with credentials. Any other origin gets no
// CORS headers at all, and its preflight is refused outright.
function corsFor(gameOrigin) {
  return function cors(req, res, next) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (origin === gameOrigin) {
      res.setHeader('Access-Control-Allow-Origin', gameOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }
    if (req.method === 'OPTIONS') {
      return sendError(res, 403, 'forbidden_origin', 'Origin not allowed');
    }
    return next();
  };
}

// The CSRF wall (V3.4 rule 1).
//
// The session cookie has to be SameSite=None for a cross-origin game, so it
// rides along on cross-site requests. CORS only stops an attacker from READING
// a response - a simple form post still EXECUTES. So every state-changing
// request must additionally prove it came from the game:
//
//   * Origin present and exactly equal to GAME_ORIGIN. Browsers always attach
//     Origin to cross-origin POSTs, including form posts, and it cannot be set
//     by page script. A missing Origin is refused too, which costs a non-browser
//     client nothing but one header.
//   * Content-Type: application/json. A cross-origin HTML form can only send
//     the three simple types, and asking for JSON forces a preflight, which the
//     CORS layer above already refuses for foreign origins.
// `onThrottle` is the recorder's LOG-ONLY path. The wall sits in front of
// everything, before any session or limiter, so its rejections are both
// unauthenticated and unbounded in volume - persisting a row per rejection
// would make a flood of header-less POSTs a disk-exhaustion attack. The
// aggregate log line keeps the signal without the write.
function csrfWallFor(gameOrigin, onThrottle) {
  return function csrfWall(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    if (req.headers.origin !== gameOrigin) {
      const reason = req.headers.origin === undefined ? 'origin_missing' : 'origin_mismatch';
      onThrottle(req, reason);
      return sendError(res, 403, 'forbidden_origin', 'Origin not allowed');
    }

    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
      onThrottle(req, 'content_type');
      return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    return next();
  };
}

// Attaches req.session ({ sub }) when a valid signed token is presented.
//
// The token arrives one of two ways (V3.7). The SameSite=None cookie only
// works where the browser still hands third-party cookies to a github.io
// page's fetch -- standard Chrome, roughly. Safari blocks them and Firefox
// partitions them, which made sign-in a silent no-op there: the callback
// succeeded, the cookie was set, and /api/me never saw it again. So the same
// signed token also travels as an Authorization bearer, handed to the page
// once at the end of the login redirect. The header wins when both appear:
// it is deliberate where the cookie is ambient.
function sessionLoaderFor(config, now) {
  return function sessionLoader(req, res, next) {
    const header = req.headers.authorization;
    const bearer = (typeof header === 'string' && header.startsWith('Bearer '))
      ? header.slice('Bearer '.length)
      : null;
    const cookies = parseCookies(req.headers.cookie);
    const token = bearer || cookies[SESSION_COOKIE] || null;
    req.session = token ? verifySession(config.sessionSecret, token, now().getTime()) : null;
    next();
  };
}

// Requires a valid session AND that the session has not been revoked. The
// cookie is stateless, so revocation is a stored per-user epoch signed into the
// token: logging out bumps it and every cookie that user held stops working.
// One narrow indexed read per authenticated request buys a real "sign out".
function requireSessionFor(recorder, store) {
  return function requireSession(req, res, next) {
    if (!req.session) {
      // Pre-auth and unbounded, so log-only: see the note on csrfWallFor.
      recorder.note(req, 'unauthenticated');
      return sendError(res, 401, 'unauthenticated', 'Sign in with Twitch first');
    }
    return Promise.resolve()
      .then(() => store.getSessionEpoch(req.session.sub))
      .then((epoch) => {
        if (epoch === null || epoch !== req.session.epoch) {
          // Either the account is gone or this cookie was retired by a logout.
          // Real signal, and bounded by who holds a validly signed cookie.
          recorder.record(req, 'session_revoked', {});
          res.setHeader('Set-Cookie', clearedSessionCookie());
          return sendError(res, 401, 'unauthenticated', 'Sign in with Twitch first');
        }
        return next();
      })
      .catch(next);
  };
}

// Wraps async handlers so a rejected promise reaches the error handler instead
// of hanging the request.
function asyncRoute(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// `onThrottle` is the recorder's LOG-ONLY path, never the persisting one.
// Blocking a request must not convert a cheap 429 into a database write, or a
// flood becomes a disk-exhaustion attack on the whole service.
function rateLimit(limiter, keyFn, limit, windowMs, onThrottle) {
  return function limited(req, res, next) {
    const key = keyFn(req);
    if (key === null) return next();
    const result = limiter.take(key, limit, windowMs);
    if (!result.allowed) {
      if (onThrottle) onThrottle(req, 'rate_limited');
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return sendError(res, 429, 'rate_limited', 'Slow down');
    }
    return next();
  };
}

module.exports = {
  clientAddress,
  sendError,
  securityHeaders,
  corsFor,
  csrfWallFor,
  sessionLoaderFor,
  requireSessionFor,
  asyncRoute,
  rateLimit,
};
