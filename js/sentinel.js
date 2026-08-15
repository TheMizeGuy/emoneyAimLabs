/* eMoney Aim Labs -- build integrity sentinel (V2.7 layer E).

   Fetches this build's own JavaScript back off the server with cache:'no-store',
   hashes it with SHA-256, and compares against the manifest embedded in
   index.html. A mismatch means the script the browser ran is not the script the
   build shipped -- a rewritten file, a proxy in the middle, or an extension
   editing source on the way in.

   Deliberately the softest layer in the stack:
     - it NEVER produces a verdict, only a taunt and one sus point
     - it is silent on file:// (no origin to fetch from) and wherever
       crypto.subtle is missing (an insecure origin), because both are honest
       setups, not tampering
     - index.html is not attested. Anyone who can edit it can delete this file's
       <script> tag, so hashing it would only cost bytes.

   Every manifest value ships as the literal "UNSTAMPED", which disables the
   check for that file; with all four unstamped nothing is even fetched.

   The only global is window.AimlabSentinel, frozen:
     AimlabSentinel.status()      -> 'pending' | 'skipped' | 'ok' | 'modified'
     AimlabSentinel.check(fn)     -> fn(status, detail) once the verdict is known
                                     (immediately if it already is)
*/
(function () {
  'use strict';

  /* Captured at parse time, same doctrine as the chase engine: a later patch of
     fetch or crypto.subtle cannot reach what this file already holds. */
  var W = window;
  var D = W.document;
  var FETCH = W.fetch ? W.fetch.bind(W) : null;
  var SUBTLE = (W.crypto && W.crypto.subtle && W.crypto.subtle.digest)
    ? W.crypto.subtle.digest.bind(W.crypto.subtle)
    : null;

  var PLACEHOLDER = 'UNSTAMPED';
  var MANIFEST_SEL = 'script[type="application/json"][data-aimlab-build]';

  var status = 'pending';
  var detail = '';
  var waiting = [];

  function settle(next, why) {
    if (status !== 'pending') return;
    status = next;
    detail = why || '';
    for (var i = 0; i < waiting.length; i++) {
      try { waiting[i](status, detail); } catch (e) { /* a listener must not break the rest */ }
    }
    waiting.length = 0;
  }

  function check(fn) {
    if (typeof fn === 'function') {
      if (status === 'pending') waiting.push(fn);
      else fn(status, detail);
    }
    return status;
  }

  function hex(buf) {
    var b = new Uint8Array(buf);
    var out = '';
    for (var i = 0; i < b.length; i++) {
      var h = b[i].toString(16);
      out += (h.length < 2) ? ('0' + h) : h;
    }
    return out;
  }

  function manifest() {
    var node = D.querySelector(MANIFEST_SEL);
    if (!node) return null;
    try {
      var parsed = JSON.parse(node.textContent);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function run() {
    var proto = (W.location && W.location.protocol) || '';
    // file:// has no same-origin fetch, and an insecure origin has no subtle crypto.
    // Both are honest ways to run this page, so neither is worth a word about.
    if (proto !== 'http:' && proto !== 'https:') { settle('skipped', 'protocol'); return; }
    if (!FETCH || !SUBTLE) { settle('skipped', 'unavailable'); return; }

    var man = manifest();
    if (!man) { settle('skipped', 'no-manifest'); return; }

    var names = [];
    for (var key in man) {
      if (!Object.prototype.hasOwnProperty.call(man, key)) continue;
      if (typeof man[key] !== 'string' || man[key] === PLACEHOLDER) continue;
      names.push(key);
    }
    if (names.length === 0) { settle('skipped', 'unstamped'); return; }

    var left = names.length;
    var bad = [];

    function done() {
      if (--left > 0) return;
      if (bad.length) settle('modified', bad.join(','));
      else settle('ok', '');
    }

    names.forEach(function (name) {
      FETCH('./' + name, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (bytes) { return SUBTLE('SHA-256', bytes); })
        .then(function (digest) {
          if (hex(digest) !== String(man[name]).toLowerCase()) bad.push(name);
          done();
        })
        .catch(function () {
          // A file we cannot read is not a file we can accuse. Offline, a blocked
          // request or a dead server all land here and none of them is cheating.
          done();
        });
    });
  }

  // Non-writable as well as frozen: freezing the object would still leave the
  // binding replaceable, and a sentinel you can swap for one that always says
  // "ok" is not a sentinel.
  try {
    Object.defineProperty(W, 'AimlabSentinel', {
      value: Object.freeze({ status: function () { return status; }, check: check }),
      writable: false, configurable: false, enumerable: true
    });
  } catch (e) {
    W.AimlabSentinel = Object.freeze({ status: function () { return status; }, check: check });
  }

  run();
})();
