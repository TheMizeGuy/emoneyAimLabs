'use strict';

const { DEFAULT_WIN_SIG_SALT, LIMITS } = require('./validation');

const REQUIRED = [
  'DATABASE_URL',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'SESSION_SECRET',
  'GAME_ORIGIN',
  'BASE_URL',
];

const MIN_SECRET_LENGTH = 32;
const CONFIG_LIMITS = Object.freeze({
  PORT_MIN: 1,
  PORT_MAX: 65535,
  // The engine's arming gate makes a win before 700 ms impossible. A clean
  // browser run has completed at 1.839 s, so the old 2 s production minimum was
  // already a false-positive boundary rather than a physical one.
  CHASE_FLOOR_MIN_MS: 700,
  SESSION_TTL_MIN_MS: 60000,
  SESSION_TTL_MAX_MS: 30 * 24 * 60 * 60 * 1000,
  STATE_TTL_MIN_MS: 60000,
  STATE_TTL_MAX_MS: 15 * 60 * 1000,
});

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function intFromEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`Invalid ${name}: expected an integer from ${min} to ${max}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: expected an integer from ${min} to ${max}`);
  }
  return parsed;
}

function boolFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`Invalid ${name}: expected true/false, yes/no, on/off, or 1/0`);
}

function httpOriginFromEnv(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an http(s) origin`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`Invalid ${name}: expected an http(s) origin`);
  }
  const localHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error(`Invalid ${name}: expected HTTPS except for localhost development`);
  }
  return stripTrailingSlash(parsed.origin);
}

function returnPathFromEnv(env, gameOrigin) {
  let raw = env.GAME_RETURN_PATH || '/emoneyAimLabs/';
  if (!raw.startsWith('/')) raw = `/${raw}`;
  if (raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Invalid GAME_RETURN_PATH: expected a same-origin path');
  }
  let parsed;
  try {
    parsed = new URL(raw, `${gameOrigin}/`);
  } catch {
    throw new Error('Invalid GAME_RETURN_PATH: expected a same-origin path');
  }
  if (parsed.origin !== gameOrigin || parsed.search || parsed.hash) {
    throw new Error('Invalid GAME_RETURN_PATH: expected a same-origin path');
  }
  return parsed.pathname;
}

function databaseUrlFromEnv(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid DATABASE_URL: expected a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Invalid DATABASE_URL: expected a PostgreSQL URL');
  }
  // node-postgres merges connection-string query parameters *over* the pool
  // options passed by db.js. That includes ssl=0 and host=..., which could
  // silently disable verification or change the target after poolOptionsFor
  // classified the URL. Keep the connection string unambiguous; operational
  // options belong in application code.
  if (parsed.searchParams.size > 0) {
    throw new Error('Invalid DATABASE_URL: connection options are controlled by the application');
  }
  return value;
}

// Reads configuration from an env object. Throws on anything missing or
// obviously wrong so the process dies at boot instead of at first request.
// Values are never logged.
function loadConfig(env = process.env) {
  const missing = REQUIRED.filter(
    (name) => typeof env[name] !== 'string' || env[name].trim().length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.SESSION_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const gameOrigin = httpOriginFromEnv('GAME_ORIGIN', env.GAME_ORIGIN);
  const baseUrl = httpOriginFromEnv('BASE_URL', env.BASE_URL);
  const returnPath = returnPathFromEnv(env, gameOrigin);
  const winSigSalts = Array.from(new Set(
    (env.WIN_SIG_SALT || DEFAULT_WIN_SIG_SALT)
      .split(',')
      .map((salt) => salt.trim())
      .filter((salt) => salt.length > 0),
  ));
  if (winSigSalts.length === 0) {
    throw new Error('WIN_SIG_SALT must contain at least one non-empty salt');
  }

  return Object.freeze({
    port: intFromEnv(env, 'PORT', 3000, CONFIG_LIMITS.PORT_MIN, CONFIG_LIMITS.PORT_MAX),
    databaseUrl: databaseUrlFromEnv(env.DATABASE_URL),
    twitchClientId: env.TWITCH_CLIENT_ID,
    twitchClientSecret: env.TWITCH_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
    gameOrigin,
    baseUrl,
    // Where the OAuth callback drops the player back into the game.
    gameReturnUrl: `${gameOrigin}${returnPath}`,
    redirectUri: `${baseUrl}/auth/twitch/callback`,
    floors: Object.freeze({
      practice: intFromEnv(
        env,
        'FLOOR_PRACTICE_MS',
        CONFIG_LIMITS.CHASE_FLOOR_MIN_MS,
        CONFIG_LIMITS.CHASE_FLOOR_MIN_MS,
        LIMITS.MAX_TIME_MS,
      ),
      simulation: intFromEnv(
        env,
        'FLOOR_SIM_MS',
        CONFIG_LIMITS.CHASE_FLOOR_MIN_MS,
        CONFIG_LIMITS.CHASE_FLOOR_MIN_MS,
        LIMITS.SIM_CEILING_MS,
      ),
    }),
    sessionTtlMs: intFromEnv(
      env,
      'SESSION_TTL_MS',
      CONFIG_LIMITS.SESSION_TTL_MAX_MS,
      CONFIG_LIMITS.SESSION_TTL_MIN_MS,
      CONFIG_LIMITS.SESSION_TTL_MAX_MS,
    ),
    stateTtlMs: intFromEnv(
      env,
      'OAUTH_STATE_TTL_MS',
      10 * 60 * 1000,
      CONFIG_LIMITS.STATE_TTL_MIN_MS,
      CONFIG_LIMITS.STATE_TTL_MAX_MS,
    ),
    // The build salt the client signs its win line with. It ships in the
    // client, so it is public by design; a comma separated list lets a client
    // salt bump be accepted alongside the previous one during a rollout.
    winSigSalts: Object.freeze(winSigSalts),
    // Escape hatch: with strict off, a well formed signature is accepted
    // without checking its value. Only for a client/server salt mismatch.
    winSigStrict: boolFromEnv(env, 'WIN_SIG_STRICT', true),
  });
}

module.exports = { loadConfig, REQUIRED, MIN_SECRET_LENGTH, CONFIG_LIMITS };
