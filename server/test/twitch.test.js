'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTwitchClient, MAX_PROVIDER_BODY_BYTES } = require('../twitch');
const { testConfig } = require('./helpers');

function responseWith(user) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [user] }),
  });
}

test('Twitch identity ingestion rejects malformed provider identifiers', async () => {
  const malformed = [
    { id: '', login: 'player' },
    { id: 'bad id!', login: 'player' },
    { id: 'x'.repeat(65), login: 'player' },
    { id: '123', login: '' },
    { id: '123', login: 'x'.repeat(201) },
  ];

  for (const user of malformed) {
    const twitch = createTwitchClient(testConfig(), responseWith(user));
    await assert.rejects(
      twitch.fetchIdentity('access-token'),
      (err) => err && err.code === 'helix_malformed',
    );
  }
});

test('Twitch identity ingestion keeps only the empty-scope profile fields', async () => {
  const twitch = createTwitchClient(testConfig(), responseWith({
    id: '123',
    login: 'player',
    display_name: 'Player',
    profile_image_url: 'https://static-cdn.jtvnw.net/player.png',
    email: 'must-not-travel@example.test',
  }));
  assert.deepEqual(await twitch.fetchIdentity('access-token'), {
    id: '123',
    login: 'player',
    displayName: 'Player',
    avatarUrl: 'https://static-cdn.jtvnw.net/player.png',
  });
});

test('Twitch JSON responses are byte-bounded before parsing', async () => {
  const oversized = JSON.stringify({
    access_token: 'x'.repeat((MAX_PROVIDER_BODY_BYTES || 64 * 1024) + 1),
  });
  const twitch = createTwitchClient(testConfig(), async () => new Response(oversized, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(
    twitch.exchangeCode('authorization-code'),
    (err) => err && err.code === 'token_malformed',
  );
});

test('Twitch token revocation reports provider refusal and network failure', async () => {
  const refused = createTwitchClient(testConfig(), async () => ({ ok: false, status: 503 }));
  assert.equal(await refused.revoke('access-token'), false);

  const unreachable = createTwitchClient(testConfig(), async () => {
    throw new Error('network down');
  });
  assert.equal(await unreachable.revoke('access-token'), false);

  const accepted = createTwitchClient(testConfig(), async () => ({ ok: true, status: 200 }));
  assert.equal(await accepted.revoke('access-token'), true);
});
