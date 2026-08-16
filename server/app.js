'use strict';

const express = require('express');
const {
  sendError,
  securityHeaders,
  corsFor,
  csrfWallFor,
  sessionLoaderFor,
  rateLimit,
  clientAddress,
} = require('./middleware');
const { createAuthRouter } = require('./auth');
const { createApiRouter } = require('./api');

const BODY_LIMIT = '4kb';
const MINUTE_MS = 60 * 1000;
// Coarse per-address ceiling in front of everything. One session was measured
// sustaining 1282 rps, each request costing an indexed lookup and an audit
// write; past this line a flood costs a header parse and nothing else - no
// cookie parsing, no session verification, no database work at all.
//
// Deliberately generous: an active player makes roughly 20-30 requests a
// minute (a heartbeat every five seconds plus board reads), so this leaves
// room for about ten of them behind one shared address before it bites, and it
// answers 429 with Retry-After rather than shutting anyone out.
const GLOBAL_IP_LIMIT = 300;

// Request log: method, full path and status only.
//
// The path is captured HERE, at dispatch, not inside the finish handler: by the
// time the response finishes, express has rewritten req.url and req.baseUrl for
// whichever router handled it, so `req.path` would read `/twitch` for
// `/auth/twitch` and `/run` for `/api/run` - and requests rejected before the
// router would log the full path, giving two shapes for one endpoint.
//
// The query string is split off and never logged: the OAuth callback carries an
// authorization code in one.
function requestLogger(log) {
  return function logRequest(req, res, next) {
    if (req.path === '/healthz') return next();
    const path = req.originalUrl.split('?')[0];
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    return next();
  };
}

function createApp(deps) {
  const { config, recorder, log = () => {} } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');

  app.use(securityHeaders);
  app.use(requestLogger(log));

  // Railway healthcheck: no database, no auth, no CORS.
  app.get('/healthz', (req, res) => {
    res.type('text/plain').status(200).send('ok');
  });

  // CORS goes first so that every response the limiter produces still carries
  // Access-Control-Allow-Origin. A bare 429 is unreadable to the browser: fetch
  // rejects it as an opaque network error, and js/net.js cannot tell that apart
  // from an unreachable host, so it marks the backend dead and tells the player
  // the leaderboard is offline while it is up and merely asking them to slow
  // down. Ordering costs nothing: this layer only sets headers, so a flood still
  // reaches the limiter without parsing a cookie, verifying a session or
  // touching the database, and a preflight it answers early is cheaper than the
  // 429 it replaces.
  app.use(corsFor(config.gameOrigin));

  // The cheapest place left to shed a flood: in front of cookies and the wall,
  // and after /healthz so Railway's healthcheck is never throttled.
  app.use(rateLimit(
    deps.limiter,
    (req) => `ip:${clientAddress(req)}`,
    deps.globalIpLimit || GLOBAL_IP_LIMIT,
    MINUTE_MS,
    recorder.note,
  ));

  // Loaded before the CSRF wall so a rejected request can still be attributed
  // to whoever's cookie it carried.
  app.use(sessionLoaderFor(config, deps.now));
  app.use(csrfWallFor(config.gameOrigin, recorder.note));
  // Bound every JSON-bearing route, including /auth/logout and unknown POST
  // paths. Limiting only /api left the rest of the state-changing surface able
  // to receive an arbitrarily large body from a non-browser caller.
  app.use(express.json({ limit: BODY_LIMIT }));

  app.use('/auth', createAuthRouter(deps));
  app.use('/api', createApiRouter(deps));

  app.use((req, res) => sendError(res, 404, 'not_found', 'No such endpoint'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return sendError(res, 400, 'invalid_json', 'Body was not valid JSON');
    }
    if (err && err.type === 'entity.too.large') {
      return sendError(res, 413, 'payload_too_large', 'Body too large');
    }
    log(`unhandled error on ${req.method} ${req.path}: ${err && err.message}`);
    if (err && err.stack) process.stderr.write(`${err.stack}\n`);
    if (res.headersSent) return next(err);
    // Never echoes an internal: the caller gets a shape, the operator gets the
    // stack on stderr.
    return sendError(res, 500, 'internal', 'Something broke on our end');
  });

  return app;
}

module.exports = { createApp };
