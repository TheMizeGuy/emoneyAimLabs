'use strict';

const { isTwitchId } = require('./validation');

// Twitch OAuth authorization-code client. The user access token exists only
// inside these functions: it is never stored, never returned to the browser and
// never written to a log.

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const HELIX_USERS_URL = 'https://api.twitch.tv/helix/users';
const TIMEOUT_MS = 10000;
const MAX_LOGIN_LENGTH = 200;
const MAX_PROVIDER_BODY_BYTES = 64 * 1024;

class TwitchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TwitchError';
    this.code = code;
  }
}

// Provider responses are tiny in normal operation. Bound the decoded stream,
// not only Content-Length, because a chunked or compressed response can omit or
// understate that header and otherwise make `response.json()` allocate without
// limit on an external trust boundary.
async function readJsonLimited(response) {
  const lengthText = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length') : null;
  if (lengthText !== null) {
    const length = Number(lengthText);
    if (Number.isFinite(length) && length > MAX_PROVIDER_BODY_BYTES) {
      if (response.body && typeof response.body.cancel === 'function') {
        await response.body.cancel().catch(() => {});
      }
      return null;
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
      return null;
    }
  }

  // Test doubles and older fetch implementations may expose only json(). Size
  // the result after parsing there; real production fetches take the streaming
  // branch above and never allocate an unbounded body first.
  const payload = await response.json().catch(() => null);
  if (payload === null) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PROVIDER_BODY_BYTES) return null;
  } catch {
    return null;
  }
  return payload;
}

function authorizeUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    // Empty scope: identity only. No email, no channel data.
    scope: '',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function createTwitchClient(config, fetchImpl = globalThis.fetch) {
  async function exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: config.twitchClientId,
      client_secret: config.twitchClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    });
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new TwitchError('token_unreachable', 'Could not reach Twitch token endpoint');
    }
    if (!response.ok) {
      // Status only: the response body can echo request parameters.
      throw new TwitchError('token_rejected', `Twitch token exchange failed (${response.status})`);
    }
    const payload = await readJsonLimited(response);
    if (!payload || typeof payload.access_token !== 'string') {
      throw new TwitchError('token_malformed', 'Twitch token response was malformed');
    }
    return payload.access_token;
  }

  async function fetchIdentity(accessToken) {
    let response;
    try {
      response = await fetchImpl(HELIX_USERS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': config.twitchClientId,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new TwitchError('helix_unreachable', 'Could not reach Twitch Helix');
    }
    if (!response.ok) {
      throw new TwitchError('helix_rejected', `Twitch identity lookup failed (${response.status})`);
    }
    const payload = await readJsonLimited(response);
    const user = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (
      !user
      || !isTwitchId(user.id)
      || typeof user.login !== 'string'
      || user.login.length === 0
      || user.login.length > MAX_LOGIN_LENGTH
    ) {
      throw new TwitchError('helix_malformed', 'Twitch identity response was malformed');
    }
    return {
      id: user.id,
      login: user.login,
      displayName: typeof user.display_name === 'string' && user.display_name.length > 0
        ? user.display_name
        : user.login,
      avatarUrl: typeof user.profile_image_url === 'string' ? user.profile_image_url : '',
    };
  }

  // Best effort: the token has served its purpose the moment identity is read,
  // so hand it back to Twitch. Failure here is never fatal.
  async function revoke(accessToken) {
    try {
      const response = await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.twitchClientId,
          token: accessToken,
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok === true;
    } catch {
      return false;
    }
  }

  return { exchangeCode, fetchIdentity, revoke };
}

module.exports = {
  authorizeUrl,
  createTwitchClient,
  TwitchError,
  AUTHORIZE_URL,
  MAX_PROVIDER_BODY_BYTES,
};
