'use strict';

const crypto = require('node:crypto');

// Rolling heartbeat chain (V3.4 rule 3).
//
// Each run carries a counter. The token for a counter is an HMAC of the run
// nonce and that counter under the server secret, so the sequence cannot be
// computed anywhere but here. A client proves it held a live, ordered
// conversation with the server by echoing the last token it was handed; only
// the token for the run's current counter earns a credited beat, and a credited
// beat advances the counter, which retires that token forever.
//
// Replaying a captured beat therefore buys nothing: by the time it is replayed
// the counter has moved, and while it has not moved the pacing rule refuses to
// credit a second beat anyway.

// How many retired tokens are still recognised, purely so a client whose
// response was dropped in flight can be told the current token instead of
// being locked out. A retired token never credits a beat.
const RESYNC_WINDOW = 3;

function tokenFor(secret, nonce, counter) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${nonce}|${counter}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function equalTokens(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// 'current' - earns a credited beat and advances the chain
// 'stale'   - a token this run really was issued, but no longer the live one
// 'invalid' - never issued for this run: a forgery, or a token from another run
function classify(secret, nonce, counter, presented) {
  if (typeof presented !== 'string' || presented.length !== 32) return 'invalid';
  if (equalTokens(presented, tokenFor(secret, nonce, counter))) return 'current';
  for (let back = 1; back <= RESYNC_WINDOW; back += 1) {
    const older = counter - back;
    if (older < 0) break;
    if (equalTokens(presented, tokenFor(secret, nonce, older))) return 'stale';
  }
  return 'invalid';
}

module.exports = { tokenFor, classify, equalTokens, RESYNC_WINDOW };
