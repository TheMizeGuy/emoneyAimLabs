'use strict';

const { DEFAULT_WIN_SIG_SALT } = require('./validation');

const REQUIRED = [
  'DATABASE_URL',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'SESSION_SECRET',
  'GAME_ORIGIN',
  'BASE_URL',
];

const MIN_SECRET_LENGTH = 32;

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer`);
  }
  return parsed;
}

function boolFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

// Reads configuration from an env object. Throws on anything missing or
// obviously wrong so the process dies at boot instead of at first request.
// Values are never logged.
function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.SESSION_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const gameOrigin = stripTrailingSlash(env.GAME_ORIGIN);
  const baseUrl = stripTrailingSlash(env.BASE_URL);
  let returnPath = env.GAME_RETURN_PATH || '/emoneyAimLabs/';
  if (!returnPath.startsWith('/')) returnPath = `/${returnPath}`;

  return Object.freeze({
    port: intFromEnv(env, 'PORT', 3000),
    databaseUrl: env.DATABASE_URL,
    twitchClientId: env.TWITCH_CLIENT_ID,
    twitchClientSecret: env.TWITCH_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
    gameOrigin,
    baseUrl,
    // Where the OAuth callback drops the player back into the game.
    gameReturnUrl: `${gameOrigin}${returnPath}`,
    redirectUri: `${baseUrl}/auth/twitch/callback`,
    floors: Object.freeze({
      practice: intFromEnv(env, 'FLOOR_PRACTICE_MS', 8000),
      simulation: intFromEnv(env, 'FLOOR_SIM_MS', 15000),
    }),
    sessionTtlMs: intFromEnv(env, 'SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    stateTtlMs: intFromEnv(env, 'OAUTH_STATE_TTL_MS', 10 * 60 * 1000),
    // The build salt the client signs its win line with. It ships in the
    // client, so it is public by design; a comma separated list lets a client
    // salt bump be accepted alongside the previous one during a rollout.
    winSigSalts: Object.freeze(
      (env.WIN_SIG_SALT || DEFAULT_WIN_SIG_SALT)
        .split(',')
        .map((salt) => salt.trim())
        .filter((salt) => salt.length > 0),
    ),
    // Escape hatch: with strict off, a well formed signature is accepted
    // without checking its value. Only for a client/server salt mismatch.
    winSigStrict: boolFromEnv(env, 'WIN_SIG_STRICT', true),
  });
}

module.exports = { loadConfig, REQUIRED, MIN_SECRET_LENGTH };
