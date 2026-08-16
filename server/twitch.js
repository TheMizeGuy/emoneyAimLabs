'use strict';

// Twitch OAuth authorization-code client. The user access token exists only
// inside these functions: it is never stored, never returned to the browser and
// never written to a log.

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const HELIX_USERS_URL = 'https://api.twitch.tv/helix/users';
const TIMEOUT_MS = 10000;

class TwitchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TwitchError';
    this.code = code;
  }
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
    const payload = await response.json().catch(() => null);
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
    const payload = await response.json().catch(() => null);
    const user = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!user || typeof user.id !== 'string' || typeof user.login !== 'string') {
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
      await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.twitchClientId,
          token: accessToken,
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Ignored on purpose.
    }
  }

  return { exchangeCode, fetchIdentity, revoke };
}

module.exports = { authorizeUrl, createTwitchClient, TwitchError, AUTHORIZE_URL };
