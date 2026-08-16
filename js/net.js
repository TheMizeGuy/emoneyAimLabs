/* eMoney Aim Labs -- backend client.

   Every call to the V3 API goes through here. The single rule this file exists
   to enforce is SILENT DEGRADATION: if the backend is missing, unreachable,
   slow, or returns something unexpected, the game must play exactly as it did
   before there was a backend. No throw escapes, no console noise, no blocked
   frame. Every helper resolves to a value or to null, never rejects.

   Two states count as "no backend":
     - API_BASE still carries the deploy placeholder. In that state this file
       makes NO network request at all. The domain is baked in now, so this is
       the escape hatch rather than the shipped state.
     - a request fails, times out, or answers with a non-2xx. The first outright
       failure puts every helper to sleep for COOLDOWN_MS, so a dead backend
       costs one request rather than one per heartbeat.

   Nothing secret lives here. API_BASE and the Twitch redirect are public by
   nature: the OAuth exchange, the client secret and the session HMAC are all
   server-side. Two copies of the signed session travel from here: the httpOnly
   cookie (rides on credentials: 'include', works where third-party cookies
   still exist) and, since V3.7, the same token held in tab-scoped
   sessionStorage and sent as an Authorization bearer -- because Safari and
   Firefox never present a railway.app cookie to this page's fetch, which made
   sign-in a silent no-op there. The token arrives once, in the login redirect's
   URL fragment, and is scrubbed from the address bar before anything else runs.

   The only global is window.AimlabNet, frozen.
*/
(function () {
  'use strict';

  var API_BASE = 'https://emoney-aimlabs-api-production.up.railway.app';

  /* Captured at parse time, same doctrine as the rest of the engine. */
  var W = window;
  var FETCH = W.fetch ? W.fetch.bind(W) : null;
  var DELAY = W.setTimeout.bind(W);
  var UNDELAY = W.clearTimeout.bind(W);

  var TIMEOUT_MS = 6000;        // no API call may hold the game up longer than this
  var PLACEHOLDER = 'REPLACE-ME';

  // The deploy step patches API_BASE; until then there is nothing to talk to.
  var CONFIGURED = (API_BASE.indexOf(PLACEHOLDER) < 0) && !!FETCH;

  /* ---- V3.7: the session token, when the cookie cannot travel ---- */

  var TOKEN_KEY = 'eal_session';

  function readToken() {
    try { return W.sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function dropToken() {
    try { W.sessionStorage.removeItem(TOKEN_KEY); } catch (e) { }
    // V3.10 migration: old clients persisted a bearer across tabs and browser
    // restarts. GitHub Pages paths share one origin, so remove that wider copy
    // even when the current tab does not hold a session.
    try { W.localStorage.removeItem(TOKEN_KEY); } catch (e) { }
  }

  /* The login redirect lands with #session=<token>. Harvest it at parse time,
     before any frame paints, and scrub the fragment so the token never sits in
     the address bar, a bookmark, or a share. */
  (function harvest() {
    // Purge the V3.7-V3.9 persistent location on every load. We deliberately do
    // not migrate it: requiring a fresh login is safer than extending a bearer
    // whose exposure window was wider than the current policy.
    try { W.localStorage.removeItem(TOKEN_KEY); } catch (e) { }
    var h = '';
    try { h = W.location.hash || ''; } catch (e) { return; }
    if (h.indexOf('#session=') !== 0) return;
    try { W.sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(h.slice(9))); } catch (e) { }
    try { W.history.replaceState(null, '', W.location.pathname + W.location.search); } catch (e) { }
  })();

  /* Once a call fails outright we stop trying for a while, so a dead backend
     costs one request rather than one per heartbeat. */
  var COOLDOWN_MS = 30000;
  var deadUntil = 0;

  function offline(force) {
    return !CONFIGURED || (!force && Date.now() < deadUntil);
  }

  function markDead() {
    deadUntil = Date.now() + COOLDOWN_MS;
  }

  /* The one place a network error can occur, and it is swallowed here.
     Resolves to the parsed body, or to null for every failure mode there is. */
  function call(method, path, body, wantError, force) {
    if (offline(force)) return Promise.resolve(null);

    var ctrl = null;
    try { if (W.AbortController) ctrl = new W.AbortController(); } catch (e) { ctrl = null; }

    var opts = {
      method: method,
      credentials: 'include',
      mode: 'cors',
      cache: 'no-store'
    };
    if (ctrl) opts.signal = ctrl.signal;
    /* The CSRF wall requires BOTH `credentials: 'include'` (above, always) and
       Content-Type: application/json on every POST -- an HTML form cannot send
       that header cross-origin without tripping a preflight, which is what makes
       it a wall. It goes on bodyless POSTs too (logout is one); without it the
       server answers 415, correctly. */
    if (method !== 'GET') opts.headers = { 'Content-Type': 'application/json' };
    /* The bearer copy of the session, for browsers that withhold the cookie.
       The server prefers it over the cookie; sending both is fine. */
    var tok = readToken();
    if (tok) {
      opts.headers = opts.headers || {};
      opts.headers.Authorization = 'Bearer ' + tok;
    }
    if (body) opts.body = JSON.stringify(body);

    var timer = 0;
    var settled = false;

    return new Promise(function (resolve) {
      function done(v) {
        if (settled) return;
        settled = true;
        UNDELAY(timer);
        resolve(v);
      }

      timer = DELAY(function () {
        try { if (ctrl) ctrl.abort(); } catch (e) { /* already gone */ }
        markDead();
        done(null);
      }, TIMEOUT_MS);

      var p;
      try {
        p = FETCH(API_BASE + path, opts);
      } catch (e) {
        markDead();
        done(null);
        return;
      }

      p.then(function (res) {
        if (!res) { markDead(); return done(null); }
        // 401 is a normal answer (not signed in), not a dead backend. A held
        // token that earns one is expired or revoked -- keeping it would just
        // repeat this refusal forever, so it goes.
        if (res.status === 401) { if (tok) dropToken(); return done(null); }
        if (!res.ok) {
          /* 7.1. Every non-2xx used to collapse into null, so a score the server
             deliberately REFUSED was reported to the player as "the leaderboard
             is offline" -- while the leaderboard was up and had just answered.
             The server ships a human-readable message per code; callers that ask
             for it get the refusal instead of a lie. A 5xx is still an outage. */
          if (res.status >= 500) { markDead(); return done(null); }
          if (!wantError) return done(null);
          return res.json().then(
            function (j) {
              done({
                refused: true,
                error: (j && j.error) || '',
                message: (j && j.message) || '',
                retryAfterSeconds: (j && typeof j.retryAfterSeconds === 'number')
                  ? j.retryAfterSeconds : 0
              });
            },
            function () { done({ refused: true, error: '', message: '' }); });
        }
        if (res.status === 204) return done(true);
        return res.json().then(function (j) { done(j); }, function () {
          markDead();
          done(null);
        });
      }, function () {
        markDead();
        done(null);
      });
    });
  }

  /* ---------------- the API surface ---------------- */

  // Where the browser goes to start the Twitch flow. Server-side from there on.
  function loginUrl() {
    return API_BASE + '/auth/twitch';
  }

  // null when signed out, when offline, or when anything at all goes wrong.
  function me() {
    return call('GET', '/api/me', null).then(function (u) {
      return (u && u.id) ? u : null;
    });
  }

  function logout() {
    // Build the request while the bearer copy still exists. Browsers that block
    // the cross-site cookie rely on this header for the server-side epoch bump;
    // deleting first made logout look successful without actually revoking it.
    // Logout bypasses the ordinary outage cooldown. One transient failure must
    // not turn a healthy server-side revocation into a local-only token delete.
    var request = call('POST', '/auth/logout', null, false, true);
    dropToken();
    // The local copy is gone either way. True means the server also confirmed
    // its epoch bump; false means a captured copy may remain live until expiry.
    return request.then(function (revoked) { return revoked === true; });
  }

  /* mode: 'practice' | 'simulation'. Resolves to {runId, nonce, chain}, or null.
     V3.4: the server opens the run with a nonce and a genesis chain token; the
     caller carries both through the heartbeats below. */
  function startRun(mode) {
    return call('POST', '/api/run', { mode: mode }).then(function (r) {
      if (!r || !r.runId) return null;
      return { runId: r.runId, nonce: r.nonce || '', chain: r.chain || '' };
    });
  }

  /* V3.3: the path is /api/run/beat, and once the chase segment is live every beat
     carries chase:true -- the server stamps the phase transition off the first
     one it sees, so the caller sends it promptly at chase start. Crediting is
     server-paced, so sending more of these buys nothing.

     V3.4: each beat also presents the run nonce and the newest chain token, and
     the reply carries the next token. Resolves to that token, or null when the
     beat did not land -- on null the caller keeps the token it already holds
     and re-presents it next time, which the server tolerates as a gap. */
  function beat(runId, nonce, chain, inChase) {
    // No token means nothing the server would accept: `chain` has to be a
    // non-empty string or the body is refused outright.
    if (!runId || !chain) return Promise.resolve(null);
    return call('POST', '/api/run/beat', {
      runId: runId,
      nonce: nonce || runId,
      chain: chain,
      chase: !!inChase
    }).then(function (r) {
      /* 200 {chain, credited}. A stale token is still answered with the live
         one, so the returned token is adopted whether or not this beat was
         credited -- that is the resync path, and refusing it here would leave a
         client that lost one response desynced for the rest of the run. */
      return (r && r.chain) ? r.chain : null;
    });
  }

  // Resolves to {bestMs, rank}, or null if the server refused or is unreachable.
  // V3.3: the engine's sus counter and signed WIN line ride along as the
  // client-attestation layer. Friction on top of the server's own witness.
  function submitScore(runId, timeMs, misses, nearMisses, sus, sig) {
    if (!runId) return Promise.resolve(null);
    return call('POST', '/api/score', {
      runId: runId,
      timeMs: timeMs,
      misses: misses,
      nearMisses: nearMisses,
      sus: sus,
      sig: sig
    }, true).then(function (r) {
      if (!r) return null;                       // unreachable
      if (r.refused) return r;                   // refused, with the server's own words
      return (typeof r.rank !== 'undefined') ? r : null;
    });
  }

  /* V3.2. Fire-and-forget vanity counter: the caller does not wait on it and
     never sees a failure. Authed-only server-side, rate limited there, and
     ignored entirely when signed out -- so this is safe to call unconditionally
     from the death path.

     V3.5 adds type:'ban' with a reason, which colours the feed line and the
     player's run history. It is cosmetic by design -- the server validates the
     reason against an enum and it can never move a leaderboard row. */
  function event(type, reason, runId, detail) {
    var body = { type: type };
    if (reason) body.reason = reason;
    if (runId) body.runId = runId;
    if (detail && Array.isArray(detail.answers)) body.answers = detail.answers.slice();
    return call('POST', '/api/event', body,
      type === 'challenge_start' || type === 'challenge_solve');
  }

  // Resolves to the server's payload (rows + optional own row), or null.
  function leaderboard(mode) {
    return call('GET', '/api/leaderboard?mode=' + encodeURIComponent(mode), null);
  }

  // V3.8: every player's public numbers in one read, for the stats tab.
  function stats() {
    return call('GET', '/api/stats', null);
  }

  /* V3.5. Public read-only profile. Resolves to the payload, or null. */
  function player(twitchId) {
    if (!twitchId) return Promise.resolve(null);
    return call('GET', '/api/player/' + encodeURIComponent(twitchId), null);
  }

  /* V3.5. The public SSE feed.
     EventSource reconnects on its own, which is exactly the wrong behaviour
     against a backend that is simply gone -- it would retry every few seconds
     forever. So the reconnects are counted: a stream that never opens is given
     FEED_TRIES attempts and then closed for good, and the panel settles into
     its quiet offline state. A stream that DID open resets the budget, because
     that is an ordinary connection drop rather than a missing backend.

     onLine(payload) gets each event, onState(state) gets one of
     'connecting' | 'live' | 'offline'. Returns a closer. */
  var FEED_TRIES = 4;
  var FEED_HEALTHY_MS = 60000;   // a stream must last this long to earn a fresh budget
  /* run_started is deliberately absent (V3.8): the server stopped emitting
     them, and skipping the name here keeps any old stored line from rendering
     during the replay window either. */
  var FEED_KINDS = ['run_won', 'run_failed', 'flappy_death', 'cheat_detected'];

  function openFeed(onLine, onState) {
    var ES = W.EventSource;
    if (!CONFIGURED || !ES) { onState('offline'); return function () { }; }

    var es = null, tries = 0, dead = false, opened = false, openedAt = 0;
    var lastId = '';               // V3.6: the newest event id this client has seen

    function state(s) { try { onState(s); } catch (e) { } }

    function connect() {
      if (dead) return;
      state('connecting');
      /* V3.6: the retry is ours (a fresh EventSource each attempt), so the
         replay cursor rides the query string; why is explained at the route. */
      var url = API_BASE + '/api/feed';
      if (lastId) url += '?after=' + encodeURIComponent(lastId);
      try { es = new ES(url); } catch (e) { stop(); state('offline'); return; }

      es.onopen = function () { opened = true; openedAt = Date.now(); state('live'); };

      es.onerror = function () {
        /* EventSource retries by itself, so the only job here is deciding when
           to stop letting it. Closing the handle first makes that decision ours
           rather than the browser's. */
        try { es.close(); } catch (e) { }
        if (dead) return;
        /* Resetting the budget on every open only bounded a stream that NEVER
           opened: one that opens and immediately EOFs reconnected forever
           (measured at 43 times in 123 s). The budget is forgiven only by a
           stream that actually stayed up for a while. */
        if (opened && openedAt && (Date.now() - openedAt) >= FEED_HEALTHY_MS) tries = 0;
        tries++;
        if (tries >= FEED_TRIES) { stop(); state('offline'); return; }
        state('connecting');
        DELAY(connect, 3000 * tries);      // back off rather than hammer
      };

      // named events, with a generic fallback for a server that sends none
      for (var i = 0; i < FEED_KINDS.length; i++) bind(FEED_KINDS[i]);
      es.onmessage = function (ev) { deliver(null, ev); };

      function bind(kind) {
        es.addEventListener(kind, function (ev) { deliver(kind, ev); });
      }
    }

    function deliver(kind, ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }   // keep-alives, junk
      if (!data || typeof data !== 'object') return;
      if (ev.lastEventId) lastId = ev.lastEventId;
      var type = kind || data.type;
      if (FEED_KINDS.indexOf(type) < 0) return;
      try { onLine(type, data); } catch (e) { }
    }

    function stop() {
      dead = true;
      if (es) { try { es.close(); } catch (e) { } es = null; }
    }

    connect();
    return stop;
  }

  function configured() {
    return CONFIGURED;
  }

  W.AimlabNet = Object.freeze({
    configured: configured,
    loginUrl: loginUrl,
    me: me,
    logout: logout,
    startRun: startRun,
    beat: beat,
    event: event,
    submitScore: submitScore,
    leaderboard: leaderboard,
    stats: stats,
    player: player,
    openFeed: openFeed
  });
})();
