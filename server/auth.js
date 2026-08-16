'use strict';

const express = require('express');
const {
  createState,
  verifyState,
  createNonceStore,
  parseCookies,
  signSession,
  sessionCookie,
  clearedSessionCookie,
  stateCookie,
  clearedStateCookie,
  STATE_COOKIE,
} = require('./session');
const { authorizeUrl } = require('./twitch');
const { sendError, asyncRoute, rateLimit } = require('./middleware');

const AUTH_LIMIT = 10;
const AUTH_WINDOW_MS = 60 * 1000;
const MAX_CODE_LENGTH = 512;

function createAuthRouter(deps) {
  const { config, store, twitch, limiter, recorder, now, log } = deps;
  const router = express.Router();

  const authLimit = rateLimit(
    limiter, (req) => `auth:${req.ip}`, AUTH_LIMIT, AUTH_WINDOW_MS, recorder.note,
  );
  // Burns each state nonce on first use, so a captured pair cannot be replayed
  // even inside its signed lifetime.
  const usedStates = createNonceStore({
    now: () => now().getTime(),
    ttlMs: config.stateTtlMs,
  });

  // Step 1: mint a CSRF nonce, park the signed copy in a short-lived cookie and
  // bounce the player to Twitch.
  router.get('/twitch', authLimit, (req, res) => {
    const state = createState(config.sessionSecret, now().getTime());
    res.setHeader('Set-Cookie', stateCookie(state.cookie, config.stateTtlMs));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, authorizeUrl(config, state.nonce));
  });

  // Step 2: the nonce in the query must match the signed one in the cookie,
  // then the code is exchanged server-side and never leaves this process.
  router.get('/twitch/callback', authLimit, asyncRoute(async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    // The state cookie is single-use whatever happens next.
    res.append('Set-Cookie', clearedStateCookie());
    res.setHeader('Cache-Control', 'no-store');

    if (typeof req.query.error === 'string') {
      // The player declined on Twitch's consent screen.
      return res.redirect(302, `${config.gameReturnUrl}?login=cancelled`);
    }

    // The CSRF gate on the login flow, in three parts: the cookie must be one
    // this server signed, its embedded issue time must be inside the TTL (a
    // server-side check, not a browser honouring Max-Age), and the nonce must
    // not have been used before.
    const stateOk = verifyState(
      config.sessionSecret,
      cookies[STATE_COOKIE],
      req.query.state,
      now().getTime(),
      config.stateTtlMs,
    );
    if (!stateOk) {
      recorder.record(req, 'oauth_state_mismatch', {});
      return sendError(res, 400, 'invalid_state', 'Login session expired, try again');
    }
    if (!usedStates.use(req.query.state)) {
      recorder.record(req, 'oauth_state_replay', {});
      return sendError(res, 400, 'invalid_state', 'Login session expired, try again');
    }

    const code = req.query.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
      recorder.record(req, 'oauth_code_missing', {});
      return sendError(res, 400, 'invalid_code', 'Missing authorization code');
    }

    let profile;
    let accessToken;
    try {
      accessToken = await twitch.exchangeCode(code);
      profile = await twitch.fetchIdentity(accessToken);
    } catch (err) {
      log(`auth callback failed: ${err.code || 'unknown'}`);
      return sendError(res, 502, 'twitch_unavailable', 'Twitch login failed, try again');
    } finally {
      if (accessToken) await twitch.revoke(accessToken);
    }

    const nowDate = now();
    await store.upsertUser(profile, nowDate);
    // The cookie is stamped with the user's current epoch, so a later logout
    // can retire it.
    const epoch = await store.getSessionEpoch(profile.id);
    const token = signSession(config.sessionSecret, {
      sub: profile.id,
      nowMs: nowDate.getTime(),
      ttlMs: config.sessionTtlMs,
      epoch: epoch === null ? 0 : epoch,
    });
    res.append('Set-Cookie', sessionCookie(token, config.sessionTtlMs));
    return res.redirect(302, config.gameReturnUrl);
  }));

  // Real revocation, not just a cleared cookie: bumping the stored epoch
  // retires every token this user holds, including a copy someone captured off
  // a shared or streamed machine. Always answers 204, session or not, so it
  // leaks nothing and is safe to call twice.
  router.post('/logout', asyncRoute(async (req, res) => {
    res.setHeader('Set-Cookie', clearedSessionCookie());
    res.setHeader('Cache-Control', 'no-store');
    if (req.session) {
      try {
        await store.bumpSessionEpoch(req.session.sub, req.session.epoch);
      } catch (err) {
        log(`logout epoch bump failed: ${err.code || 'error'}`);
      }
    }
    return res.status(204).end();
  }));

  return router;
}

module.exports = { createAuthRouter, AUTH_LIMIT, AUTH_WINDOW_MS };
