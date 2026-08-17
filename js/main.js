/* eMoney Aim Labs -- mode router.

   Owns the start screen, the modes, and the shared AudioContext for the loud
   ones. Nothing here knows how either game works; it only wires them:

     Practice    -> AimlabChase with emoney.png, no shared audio.
     Simulation  -> AimlabFlappy to 10 points, then AimlabChase with
                    simulation.png and the 8 s loop.
     Impossible  -> Simulation's pipeline with the gauntlet at 1.2x, then the
                    chase at its cruelest (the engine keys off the mode label).

   Autoplay policy: the loop.wav bytes are fetched immediately (a plain network
   request needs no permission), but an AudioContext is only ever constructed
   inside a user gesture -- the mode button click on the normal path, the first
   trusted pointerdown on the QA-seam path.
*/
(function () {
  'use strict';

  /* Captured at parse time (V2.6 layer 2), so patching these later does nothing. */
  var W = window;
  var LOG = (W.console && W.console.log) ? W.console.log.bind(W.console) : function () {};
  var ERR = (W.console && W.console.error) ? W.console.error.bind(W.console) : LOG;
  var FETCH = W.fetch ? W.fetch.bind(W) : null;

  var LOOP_URL     = './assets/loop.wav';
  var TARGET_SCORE = 10;

  var PRACTICE = {
    imageSrc: './assets/emoney.png',
    imageW: 128,
    imageH: 128,
    bestKey: 'emoney-aimlabs-best'
  };

  var SIMULATION = {
    imageSrc: './assets/simulation.png',
    // Preserve the source's 312:128 aspect ratio while making the complete
    // 128px-wide Win95 window slightly narrower than Practice's 136px.
    imageW: 120,
    imageH: 49,
    bestKey: 'emoney-aimlabs-best-sim',
    flappySpeed: 1
  };

  /* V4.0: Simulation's window and gauntlet with the mercy removed. The engine
     reads the difficulty off the IMPOSSIBLE mode label; this module only picks
     the assets, the best-time key and the 1.2x gauntlet clock. */
  var IMPOSSIBLE = {
    imageSrc: './assets/simulation.png',
    imageW: 120,
    imageH: 49,
    bestKey: 'emoney-aimlabs-best-imp',
    flappySpeed: 1.2
  };

  var startScreen = document.getElementById('startScreen');
  var stage       = document.getElementById('stage');

  var chase = null, flappy = null;
  var running = null;           // re-entrancy guard: engines must never stack

  /* ---------------- shared audio ---------------- */

  var ctx = null, buffer = null, raw = null;
  var fetching = false, decoding = false, gestureArmed = false;

  function fetchLoop() {
    if (fetching || raw || buffer || !FETCH) return;
    fetching = true;
    FETCH(LOOP_URL).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (bytes) {
      raw = bytes;
      decodeLoop();
    }, function (err) {
      ERR('[AIMLAB] loop fetch failed: ' + err.message);
    });
  }

  // Only ever called from inside a user gesture.
  function ensureContext() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    pushAudio();
    decodeLoop();
    return ctx;
  }

  function decodeLoop() {
    if (!ctx || !raw || buffer || decoding) return;
    decoding = true;
    var bytes = raw;
    raw = null;                     // decodeAudioData detaches the ArrayBuffer
    // Both the callback form and the promise form are wired up, so this works
    // whichever one the browser implements; onDecoded guards against running twice.
    var p;
    try {
      p = ctx.decodeAudioData(bytes, onDecoded, onDecodeFailed);
    } catch (e) {
      onDecodeFailed();
      return;
    }
    // Chrome honours both forms, so a bad buffer used to report twice
    if (p && p.then) p.then(onDecoded, onDecodeFailed);
  }

  function onDecoded(decoded) {
    if (buffer || !decoded) return;
    decoding = false;
    buffer = decoded;
    pushAudio();
  }

  // Chrome honours both the callback and the promise form, so this used to
  // report the same bad buffer twice.
  var decodeReported = false;
  function onDecodeFailed() {
    decoding = false;
    if (decodeReported) return;
    decodeReported = true;
    ERR('[AIMLAB] loop decode failed');
  }

  // Hands whatever exists so far to a running chase. The engine starts the loop
  // when both halves are present and ignores the call otherwise, so a buffer
  // that lands after the chase has begun still gets played.
  function pushAudio() {
    if (chase && chase.setAudio) chase.setAudio({ ctx: ctx, buffer: buffer });
  }

  // QA-seam path only: no button was clicked, so wait for the first real
  // pointer press before touching an AudioContext.
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    window.addEventListener('pointerdown', function onFirst(e) {
      if (!e.isTrusted) return;
      window.removeEventListener('pointerdown', onFirst, true);
      ensureContext();
    }, true);
  }

  /* ---------------- V3: account, leaderboard, run lifecycle ----------------
     Everything here is best-effort. net.js resolves to null rather than throwing
     for every failure there is, so each call site only has to handle "no data",
     and the game itself never waits on any of it. */

  var NET = window.AimlabNet || null;
  var user = null;                 // the signed-in user, or null
  var apiUp = true;                // flips false the first time a call comes back empty
  var runId = null;                // the server's id for the run in progress
  var runGen = 0;                  // guards a late boot-me() from opening a stale run
  var runOpenTail = Promise.resolve(); // preserves server ordering across replaced attempts
  var activeRunOpenGen = 0;        // lets a clean fast win wait for its own POST
  var activeRunOpenPromise = null;
  var bootMe = null;               // resolves once the boot identity call has settled
  var runNonce = '';               // V3.4 run nonce, presented on every beat
  var runChain = '';               // V3.4 newest chain token the server handed back
  var beatTimer = 0;
  var beatRequestSeq = 0;          // identifies the one request allowed to own the chain
  var activeBeatSeq = 0;
  var beatInFlightRun = null;
  var beatInFlightPromise = null;
  var beatPending = false;         // only a phase transition is urgent enough to queue
  var challengePromise = Promise.resolve(null); // orders start -> solve for one run
  var challengeVerified = false;   // only a server `{solved:true}` qualifies a ranked run
  var challengeUnranked = false;   // keeps signed-out/offline local play usable
  var inChase = false;             // V3.3: beats carry this once the chase is live
  var BEAT_MS = 5000;
  /* V3.6: practice runs still record and still travel the activity feed;
     they just never make the board, which only ever shows simulation. */

  var acctLogin = document.getElementById('btnLogin');
  var acctIn = document.getElementById('acctIn');
  var acctAvatar = document.getElementById('acctAvatar');
  var acctName = document.getElementById('acctName');
  var acctNote = document.getElementById('acctNote');
  var btnLogout = document.getElementById('btnLogout');

  function fmtMs(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    ms = Math.floor(ms);
    var m = Math.floor(ms / 60000);
    var sec = Math.floor(ms / 1000) % 60;
    var f = ms % 1000;
    function pad(n, w) { var o = String(n); while (o.length < w) o = '0' + o; return o; }
    return pad(m, 2) + ':' + pad(sec, 2) + '.' + pad(f, 3);
  }

  function paintAccount() {
    if (!acctLogin) return;
    if (!apiUp) {
      /* The OFFLINE note used to take the sign-in button down with it, and
         nothing ever re-probed, so one slow boot me() against a cold container
         left a visitor with no way to sign in for the rest of the page's life.
         Signing in is a top-level navigation, not a fetch: it works whatever
         the API is doing, so a signed-out visitor keeps the button beside the
         note. Someone already signed in has nothing to do here, so their row
         still steps aside for it. */
      acctLogin.classList.toggle('hide', !!user);
      acctIn.classList.add('hide');
      acctNote.classList.remove('hide');
      return;
    }
    acctNote.classList.add('hide');
    if (user) {
      acctLogin.classList.add('hide');
      acctIn.classList.remove('hide');
      acctName.textContent = user.displayName || user.login || 'player';
      if (user.avatarUrl) acctAvatar.src = user.avatarUrl;
    } else {
      acctIn.classList.add('hide');
      acctLogin.classList.remove('hide');
    }
  }

  /* One renderer, two mounts: the start-screen panel and the win-dialog modal.
     Builds rows with DOM calls rather than innerHTML, so a display name out of
     Twitch is text and never markup. */
  /* Each mount carries its own request counter, the way the Properties sheet
     carries propToken. Without one, a first read that timed out at six seconds
     landed after a later successful one, wiped the good board and latched
     apiUp=false for the rest of the page. A single shared counter would not do:
     these are two separate boards, and a reply for one must not be thrown away
     because the other was opened while it was in flight. */
  var boardReq = { seq: 0 };
  var modalReq = { seq: 0 };

  function renderBoard(listEl, mode, statusEl, req) {
    if (!listEl) return;
    var seq = ++req.seq;
    clear(listEl);

    // the era's idea of "working on it"
    var wait = document.createElement('div');
    wait.className = 'lbwait';
    var hg = document.createElement('span');
    hg.className = 'hourglass';
    wait.appendChild(hg);
    var waitTxt = document.createElement('span');
    waitTxt.textContent = 'Reading leaderboard...';
    wait.appendChild(waitTxt);
    listEl.appendChild(wait);
    setStatus(statusEl, 'Working...');

    if (!NET) { clear(listEl); offlineInto(listEl, statusEl); return; }

    NET.leaderboard(mode).then(function (data) {
      if (seq !== req.seq) return;                 // a newer read already owns this mount
      clear(listEl);
      /* The server's payload is {mode, entries, you}. Reading `rows` here made
         every board permanently empty AND latched apiUp=false at boot, which
         hid the sign-in button entirely -- a logged-out visitor had no way in.
         `rows` is still accepted so either shape works. */
      var rows = data && (data.entries || data.rows);
      if (!rows) {
        apiUp = false;
        paintAccount();
        offlineInto(listEl, statusEl);
        return;
      }
      apiUp = true;
      var mine = data.you || null;

      if (!rows.length) {
        var none = document.createElement('p');
        none.className = 'lbempty';
        none.textContent = 'No scores yet. Be the first.';
        listEl.appendChild(none);
      }

      var sawMine = false;
      for (var i = 0; i < rows.length; i++) {
        // the server marks its own row; the rank compare is the fallback
        var isMe = (rows[i].isYou === true) || !!(mine && rows[i].rank === mine.rank);
        if (isMe) sawMine = true;
        listEl.appendChild(boardRow(rows[i], isMe));
      }
      if (mine && !sawMine) {
        var gap = document.createElement('p');
        gap.className = 'lbempty';
        gap.textContent = '. . .';
        listEl.appendChild(gap);
        listEl.appendChild(boardRow(mine, true));
      }

      // Explorer counted its objects; so does this
      var n = rows.length;
      var status = n + ' object' + (n === 1 ? '' : 's');
      if (mine) status += '   |   you are #' + mine.rank;
      setStatus(statusEl, status);
    });
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function setStatus(el, text) {
    if (el) el.textContent = text;
  }

  function offlineInto(listEl, statusEl) {
    var off = document.createElement('p');
    off.className = 'lbempty';
    off.textContent = 'Leaderboard unavailable.';
    listEl.appendChild(off);
    setStatus(statusEl, 'OFFLINE');
  }

  function boardRow(r, isMe) {
    var row = document.createElement('div');
    row.className = 'lbrow' + (isMe ? ' you' : '');

    var rank = document.createElement('span');
    rank.className = 'lbrank';
    rank.textContent = r.rank;
    row.appendChild(rank);

    // name cell carries the 16x16 icon, the way a file row does
    var nameCell = document.createElement('span');
    nameCell.className = 'lbname';
    var av = document.createElement('img');
    av.className = 'lbav';
    av.alt = '';
    av.width = 16;
    av.height = 16;
    if (r.avatarUrl) av.src = r.avatarUrl;
    nameCell.appendChild(av);
    var nm = nameEl(r.displayName, r.twitchId || r.id);
    nm.className += (nm.className ? ' ' : '') + 'lbnametext';
    nameCell.appendChild(nm);
    row.appendChild(nameCell);

    var tm = document.createElement('span');
    tm.className = 'lbtime';
    tm.textContent = fmtMs(r.timeMs);
    row.appendChild(tm);

    /* server-derived: misses plus the click that landed */
    var ck = document.createElement('span');
    ck.className = 'lbclicks';
    ck.textContent = num(r.clicks);
    row.appendChild(ck);

    /* three fail stats, all visible: every failed run, then the two ways to
       fail one -- eaten by the bird, or the window got away in the chase. */
    var tf = document.createElement('span');
    tf.className = 'lbfails';
    tf.textContent = num(r.totalFails);
    row.appendChild(tf);

    var fd = document.createElement('span');
    fd.className = 'lbbird';
    fd.textContent = num(r.flappyFails);
    row.appendChild(fd);

    var cf = document.createElement('span');
    cf.className = 'lbchase';
    cf.textContent = num(r.chaseFails);
    row.appendChild(cf);

    return row;
  }

  // a column the server did not send reads as a dash, never as "undefined"
  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? String(v) : '-';
  }

  function resetBeatFlow() {
    // The request itself cannot be cancelled, but its sequence no longer owns
    // any state. A late completion therefore cannot clear or advance a new run.
    activeBeatSeq = 0;
    beatInFlightRun = null;
    beatInFlightPromise = null;
    beatPending = false;
  }

  /* The canvas challenge is visible client-side, but its eligibility state is
     timed by the server. Requests stay ordered even if the player solves while
     the run-open POST is still landing. `ready` is local-only: Simulation uses
     it to start the scored Chase after the pre-Chase puzzle has closed. */
  function reportChallenge(stage, detail) {
    var gen = runGen;
    if (stage === 'ready') {
      return Promise.resolve(challengePromise).then(function () {
        if (
          gen === runGen
          && (running === 'simulation' || running === 'impossible')
          && (challengeVerified || challengeUnranked)
        ) return markChaseStarted();
        return null;
      });
    }
    if (stage !== 'start' && stage !== 'solve') return Promise.resolve(null);
    var opening = (!runId && activeRunOpenGen === gen && activeRunOpenPromise)
      ? activeRunOpenPromise : Promise.resolve(null);
    challengePromise = Promise.resolve(challengePromise).then(function () {
      return opening;
    }).then(function () {
      if (gen !== runGen) return null;
      if (!NET || !user || !runId) {
        challengeUnranked = true;
        return { unranked: true };
      }
      // V4.3: the practice challenge-start pacing delay lived here; practice
      // no longer challenges, so the request goes straight out.
      return NET.event('challenge_' + stage, '', runId, detail || {});
    }, function () { return null; }).then(function (result) {
      if (stage === 'start' && !result) {
        challengeUnranked = true;
        return { unranked: true };
      }
      if (stage === 'solve') challengeVerified = !!(result && result.solved === true);
      return result;
    });
    return challengePromise;
  }

  /* V3.5. The chase engine ended the run on a ban screen. This is cosmetic --
     it names the reason on the feed and in the player's history and can never
     move a score -- so it is fire-and-forget, and seam runs never report. */
  function reportBan(reason) {
    /* The ban closes the run on the server immediately, so every later heartbeat
       is refused -- one false [ANTICHEAT] line and one rejections row every five
       seconds, indefinitely, polluting the very audit trail the rejections table
       exists to keep clean. The run is over here too. */
    stopBeats();
    resetBeatFlow();
    var bannedRun = runId;
    runGen++;                       // nothing in flight may reopen this run
    runId = null;
    runNonce = '';
    runChain = '';
    challengeVerified = false;
    challengeUnranked = false;
    // A server retry delay is not a failed verification and is not one of the
    // public run-failure reasons. The next run replacement closes this attempt
    // normally; do not mislabel the player for merely retrying too quickly.
    if (reason === 'challenge-retry') return;
    if (isSeam || !NET || !user || !bannedRun) return;
    NET.event('ban', reason, bannedRun);
  }

  /* run lifecycle. Seam runs never touch the API at all. */
  /* V3.3. For simulation this fires at FLAPPY start, so the server witnesses
     the whole run including the gauntlet; practice still opens its run when the
     chase does. Seam runs never get here. */
  function beginRun(mode) {
    runId = null;
    runNonce = '';
    runChain = '';
    inChase = false;
    challengePromise = Promise.resolve(null);
    challengeVerified = false;
    challengeUnranked = false;
    stopBeats();
    resetBeatFlow();
    if (!NET || isSeam) return;

    /* The mode buttons are the first thing a returning player clicks, and on a
       cold container the boot me() can still be in flight when they do. Bailing
       on !user there cost them the ENTIRE run -- no run row, no beats, no score,
       and a win dialog telling a signed-in player there was no server run. Wait
       for the identity to land, then open the run; the chase may already be
       under way by then, which startRun's own inChase handling covers. */
    var gen = ++runGen;
    if (user) { openRun(mode, gen); return; }
    if (!bootMe) return;
    /* The wait itself has to be publishable, not just the POST that follows it.
       While the boot me() was still in flight nothing had set
       activeRunOpenPromise, so reportChallenge's `opening` guard found nothing
       to wait behind, saw a null user and declared the challenge unranked --
       and acceptChallenge(true) then skipped the puzzle entirely. The identity
       landed a moment later, a real run opened, the player won it, and the
       server refused the score with challenge_required. */
    var pending = bootMe.then(
      function () { return openRun(mode, gen); },
      // net.js never rejects, but a replacement client must not leave anything
      // waiting on this promise stranded behind an unhandled rejection.
      function () { return null; });
    activeRunOpenGen = gen;
    activeRunOpenPromise = pending;
    pending.then(function () {
      // openRun republishes with its own handled promise and clears that one;
      // this only has to release the boot wait when there was no POST at all.
      if (activeRunOpenGen === gen && activeRunOpenPromise === pending) {
        activeRunOpenGen = 0;
        activeRunOpenPromise = null;
      }
    });
  }

  // Returns the promise that settles once the run is open (or once the attempt
  // has been abandoned), so the deferred boot path above can publish the wait.
  function openRun(mode, gen) {
    if (!NET || isSeam || !user) return;      // genuinely signed out: nothing to open
    if (gen !== runGen) return;               // that run was abandoned while we waited
    var opened = runOpenTail.then(function () {
      // A newer attempt may have replaced this one while it waited behind an
      // older POST. In that case there is no reason to open it at all.
      if (!NET || isSeam || !user || gen !== runGen) return null;
      return NET.startRun(mode);
    });
    var handled = opened.then(function (r) {
      if (gen !== runGen) return;             // it ended while the POST itself was in flight
      if (!r) { apiUp = false; paintAccount(); return; }
      runId = r.runId;
      runNonce = r.nonce;
      runChain = r.chain;              // V3.4 genesis token
      startBeats();
    }, function () {
      // net.js promises never reject, but a replacement client must not leave
      // an unhandled rejection or permanently wedge the open queue.
      if (gen === runGen) { apiUp = false; paintAccount(); }
    });
    activeRunOpenGen = gen;
    activeRunOpenPromise = handled;
    handled.then(function () {
      if (activeRunOpenGen === gen && activeRunOpenPromise === handled) {
        activeRunOpenGen = 0;
        activeRunOpenPromise = null;
      }
    });
    // Keep the queue usable even if a replacement network client rejects in
    // violation of net.js's always-resolve contract.
    runOpenTail = handled.then(function () { return null; }, function () { return null; });
    return handled;
  }

  /* The chase segment has begun: the server stamps the phase transition off the
     first beat carrying chase:true, so one goes out immediately rather than
     waiting up to five seconds for the next tick. */
  function markChaseStarted() {
    inChase = true;
    return sendBeat(true);
  }

  /* V3.4. One beat, carrying the run nonce and the newest chain token. The
     reply advances the token; a beat that does not land leaves the one we hold
     in place, so the next beat simply re-presents it and the server closes the
     gap on its side. Nothing here blocks or throws. */
  function sendBeat(urgent) {
    if (!NET || !runId) return Promise.resolve(null);
    var forRun = runId;
    if (activeBeatSeq && beatInFlightRun === forRun) {
      // Interval ticks are disposable. A phase transition is not: send it as
      // soon as the request that currently owns the chain returns.
      if (urgent) beatPending = true;
      return beatInFlightPromise || Promise.resolve(null);
    }

    var seq = ++beatRequestSeq;
    activeBeatSeq = seq;
    beatInFlightRun = forRun;
    var request;
    try {
      request = NET.beat(forRun, runNonce, runChain, inChase);
    } catch (e) {
      request = Promise.resolve(null);
    }

    beatInFlightPromise = Promise.resolve(request).then(function (next) {
      // a late reply must not overwrite the token of a run that already ended
      if (next && runId === forRun && activeBeatSeq === seq) runChain = next;
    }, function () {
      // net.js promises never reject, but a replacement client must not wedge
      // the chain forever if it violates that contract.
    }).then(function () {
      if (activeBeatSeq !== seq) return null;
      activeBeatSeq = 0;
      beatInFlightRun = null;
      beatInFlightPromise = null;
      var follow = beatPending && runId === forRun;
      beatPending = false;
      return follow ? sendBeat(false) : null;
    });
    return beatInFlightPromise;
  }

  // The heartbeat is what makes a forged time expensive: it has to be held for
  // the whole server-observed scored duration. Practice's server-timestamped
  // puzzle interval is excluded from that window; extra beats during it are
  // harmless and never reduce the later requirement.
  function startBeats() {
    stopBeats();
    beatTimer = window.setInterval(sendBeat, BEAT_MS);
    // Witness the run immediately. Besides adding honest-client slack, this is
    // the first phase-specific beat for a Simulation gauntlet.
    sendBeat(false);
  }

  function stopBeats() {
    if (beatTimer) { window.clearInterval(beatTimer); beatTimer = 0; }
  }

  function finishRun(stats) {
    stopBeats();
    if (!chase || !chase.winExtras) { runGen++; return; }
    if (isSeam) { runGen++; return; }         // seam runs are never submitted
    if (!NET) { runGen++; return; }

    if (!user) {
      runGen++;
      chase.winExtras({ note: 'Sign in with Twitch to post your score.' });
      return;
    }

    /* V3.4 block 4b. A run that tripped ANY soft detection is never offered to
       the leaderboard. The server rejects sus > 0 as well -- this is the near
       side of the same rule, so a flagged run costs no request and the dialog
       has already named the checks that fired. The run is left open on the
       server, which its own sweep will close as a fail. */
    /* A clock or state verdict voids the run without ever touching the sus
       counter, so a cheated win arrived here with sus:0 and an EMPTY signature
       and sailed through a gate that V3.4b calls absolute. The server refused it,
       but the client should never have asked. All three fields ride on the same
       payload, so all three are checked. */
    if (stats.sus > 0 || stats.cheated || !stats.sig) {
      runGen++;                       // a pending open response is no longer this run
      runId = null;
      runNonce = '';
      runChain = '';
      resetBeatFlow();
      LOG('[AIMLAB] SCORE WITHHELD sus=' + stats.sus +
          ' cheated=' + (stats.cheated ? 1 : 0) + ' sig=' + (stats.sig ? 1 : 0));
      return;                       // the engine's own dialog is the notice
    }

    // A fast Practice win can beat a cold /run response. A clean finish waits
    // for its own generation instead of discarding a valid server run; a ban,
    // exit, retry, or newer attempt increments runGen and wins the race.
    var finishGen = runGen;
    var opening = (!runId && activeRunOpenGen === finishGen && activeRunOpenPromise)
      ? activeRunOpenPromise : Promise.resolve(null);
    opening.then(function () {
      if (runGen !== finishGen) return;
      stopBeats(); // openRun may have armed the interval while this win waited
      if (!user) {
        runGen++;
        chase.winExtras({ note: 'Sign in with Twitch to post your score.' });
        return;
      }
      if (!runId) {
        runGen++;
        chase.winExtras({ note: 'Score not recorded: no server run for this attempt.' });
        return;
      }

      var id = runId;
      var submitGen = ++runGen;                 // no later completion may revive it
      var settled = Promise.all([
        (beatInFlightRun === id && beatInFlightPromise)
          ? beatInFlightPromise : Promise.resolve(null),
        challengePromise || Promise.resolve(null)
      ]);
      settled.then(function () {
        // A ban, exit, retry or newer run won the lifecycle while the final beat
        // was landing. It must also win over this stale submission.
        if (runId !== id || runGen !== submitGen) return;
        runId = null;
        runNonce = '';
        runChain = '';
        resetBeatFlow();
        NET.submitScore(id, stats.timeMs, stats.misses, stats.nearMisses,
                        stats.sus, stats.sig).then(function (r) {
          if (!r) {
            chase.winExtras({ note: 'Score could not be recorded. The leaderboard is offline.' });
            return;
          }
          if (r.refused) {
            /* The server refused it and said why; passing that on beats inventing an
               outage. The code rides along in brackets so a refusal can be reported
               and looked up exactly, rather than paraphrased from memory. */
            var why = r.message || 'Score not accepted by the server.';
            if (r.error) why += '   [' + r.error + ']';
            chase.winExtras({ note: why });
            return;
          }
          var note = (r.improved ? 'New record.   ' : '') + 'Rank #' + r.rank;
          if (typeof r.bestMs === 'number') note += '   best ' + fmtMs(r.bestMs);
          chase.winExtras({
            note: note,
            onBoard: function () { openModal(stats.mode); }
          });
        });
      });
    });
  }

  /* ---------------- modes ---------------- */

  /* The one thing both modes need was the one call with no guard on it: a 404,
     a CSP block or a rewritten chase.js used to throw *after* the start screen
     was already hidden, leaving a black rectangle with no menu and no recovery
     short of a reload. In simulation it detonated inside flappy's rAF stack the
     instant the player finished earning their tenth point. Now a failure puts
     the menu back and says so. */
  function startChase(cfg) {
    if (!window.AimlabChase || !window.AimlabChase.start) {
      ERR('[AIMLAB] chase engine unavailable');
      failToMenu();
      return null;
    }
    try {
      return window.AimlabChase.start(stage, cfg);
    } catch (e) {
      ERR('[AIMLAB] chase failed to start: ' + (e && e.message));
      failToMenu();
      return null;
    }
  }

  function failToMenu() {
    stopBeats();
    resetBeatFlow();
    runGen++;
    runId = null;
    runNonce = '';
    runChain = '';
    running = null;
    startScreen.classList.remove('hide');
  }

  function startPractice() {
    if (running) return;               // one engine at a time, whatever clicks arrive
    running = 'practice';
    startScreen.classList.add('hide');
    LOG('[AIMLAB] MODE mode=practice');
    beginRun('practice');
    /* Practice has no gauntlet: the run and the chase begin together, so the
       phase is stamped immediately. Without this the server would still see
       chase_started_at NULL at the end, and V3.5 derives the fail phase from
       exactly that -- a lost practice run would be reported as a bird death in
       a mode that has no bird. */
    markChaseStarted();
    chase = startChase({
      imageSrc: PRACTICE.imageSrc,
      imageW: PRACTICE.imageW,
      imageH: PRACTICE.imageH,
      bestKey: PRACTICE.bestKey,
      modeLabel: 'PRACTICE',
      recordBest: !isSeam,
      onWin: function (st) { finishRun({ mode: 'practice', timeMs: st.timeMs,
                                         misses: st.misses, nearMisses: st.nearMisses,
                                         sus: st.sus, sig: st.sig,
                                         cheated: st.cheated }); },
      onChallenge: reportChallenge,
      onBan: reportBan,
      onExit: function (action) { onChaseExit(action, 'practice'); },
      // V2.8: practice is silent. No loop, no error chord, no AudioContext -- the
      // engine never builds one, so there is nothing here to autoplay-gate.
      audio: null
    });
  }

  function startSimulation(fromGesture) { startGauntlet('simulation', fromGesture); }
  function startImpossible(fromGesture) { startGauntlet('impossible', fromGesture); }

  /* V4.0: Simulation and Impossible share one shape -- a witnessed run from
     flappy start, the audio loop, the gauntlet, then the chase. The mode picks
     the assets, the gauntlet speed and the engine's difficulty label. */
  function startGauntlet(mode, fromGesture) {
    if (running) return;
    running = mode;
    var cfg = (mode === 'impossible') ? IMPOSSIBLE : SIMULATION;
    startScreen.classList.add('hide');
    LOG('[AIMLAB] MODE mode=' + mode);
    beginRun(mode);                  // V3.3: witnessed from the gauntlet onward
    fetchLoop();

    if (fromGesture) ensureContext();   // the mode button click is the gesture
    else armGesture();

    if (!skipFlappy && window.AimlabFlappy && window.AimlabFlappy.start) {
      flappy = window.AimlabFlappy.start(stage, {
        targetScore: TARGET_SCORE,
        speedScale: cfg.flappySpeed,
        title: mode,
        // V3.2: a vanity counter, fire-and-forget. Never on a seam run, and
        // net.js ignores it entirely when signed out or offline.
        onDeath: function () {
          if (!isSeam && NET && user) NET.event('flappy_death');
        },
        // Unchanged handoff: at 10 points flappy stops and the chase starts. The
        // info argument is new in V2.7 and purely additive -- it carries flappy's
        // sus count and any state verdict across so the chase can show them.
        onComplete: function (info) {
          // a throw in teardown must not cost the player the run they just earned
          try { if (flappy && flappy.stop) flappy.stop(); }
          catch (e) { ERR('[AIMLAB] flappy stop threw: ' + (e && e.message)); }
          flappy = null;
          startGauntletChase(mode, cfg, info);
        }
      });
      return;
    }

    /* Starting the chase anyway was a doomed run: beginRun has already opened a
       server-witnessed one, and a gauntlet-mode win with no gauntlet behind it
       is refused with flappy_phase_too_short -- so an honest player got a fail
       row on their record for a script that failed to load. startChase's own
       equivalent failure puts the menu back; so does this one. ?skipflappy=1 is
       the QA seam and means it on purpose. */
    if (!skipFlappy) {
      ERR('[AIMLAB] flappy unavailable');
      failToMenu();
      return;
    }
    startGauntletChase(mode, cfg, null);
  }

  function startGauntletChase(mode, cfg, info) {
    chase = startChase({
      imageSrc: cfg.imageSrc,
      imageW: cfg.imageW,
      imageH: cfg.imageH,
      bestKey: cfg.bestKey,
      modeLabel: mode.toUpperCase(),
      recordBest: !isSeam,
      onWin: function (st) { finishRun({ mode: mode, timeMs: st.timeMs,
                                         misses: st.misses, nearMisses: st.nearMisses,
                                         sus: st.sus, sig: st.sig,
                                         cheated: st.cheated }); },
      // The visual challenge runs after Flappy and before startTimer(), so its
      // solve time never contaminates the Chase leaderboard time.
      challengeBeforeStart: true,
      onChallenge: reportChallenge,
      // V2.14: the ban screen's two buttons come back through here
      onExit: function (action) { onChaseExit(action, mode); },
      onBan: reportBan,
      susSeed: (info && info.sus > 0) ? info.sus : 0,
      stateCheat: !!(info && info.stateCheat),
      // A non-null object tells the engine this module owns the audio. Either
      // field may still be null; pushAudio fills them in as they arrive.
      audio: { ctx: ctx, buffer: buffer }
    });
  }

  /* A failed run lets the player retry the same mode or return home. Either
     path tears the old engine down before opening a fresh server run. */
  function onChaseExit(action, mode) {
    stopBeats();
    resetBeatFlow();
    runGen++;
    runId = null;
    runNonce = '';
    runChain = '';
    try { if (chase && chase.stop) chase.stop(); }
    catch (e) { ERR('[AIMLAB] chase stop threw: ' + (e && e.message)); }
    chase = null;
    running = null;

    if (action === 'retry') {
      if (mode === 'practice') startPractice();
      else {
        skipFlappy = false;           // a gauntlet-mode retry starts at the gauntlet
        startGauntlet(mode, true);    // the button click is the audio gesture
      }
      return;
    }
    startScreen.classList.remove('hide');
  }

  /* ==================== V3.5: activity log ============================== */

  var feedList = document.getElementById('feedList');
  var feedState = document.getElementById('feedState');
  var FEED_MAX = 50;             // displayed lines; the oldest fall off the end

  /* Each event type gets an Event-Viewer severity badge and a sentence. The
     sentences deliberately name the SEGMENT the run died in, because "failed"
     on its own tells a spectator nothing. */
  var FEED_ICON = {
    fallback: ['fi-i', 'i'],
    run_won: ['fi-win', '*'],
    run_failed: ['fi-e', 'x'],
    flappy_death: ['fi-w', '!'],
    cheat_detected: ['fi-e', '!']
  };

  function secs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '?';
    return (ms / 1000).toFixed(2) + 's';
  }

  /* The one line of language that matters: WHERE the run ended, and why.
     Sweep-detected abandons arrive late, so they get the quiet "gave up"
     phrasing rather than anything that claims to be breaking news. */
  function failWords(d) {
    var abandoned = !d.reason;
    if (d.phase !== 'chase') {
      return abandoned ? 'gave up in the bird gauntlet' : 'failed on flappy bird';
    }
    if (d.reason === 'captcha-fail') return 'failed the popup chase (wrong piece)';
    if (d.reason === 'captcha-timeout') return 'failed the popup chase (verification timeout)';
    if (d.reason === 'clock-forgery') return 'was removed for a forged popup-chase clock';
    if (d.reason === 'timeout') return 'ran out of time on the popup chase';
    return 'gave up on the popup chase';
  }

  function feedWords(type, d) {
    if (type === 'run_won') {
      /* The mode with its own board earns its own words; every other win reads
         as it always has. Older stored lines carry no mode and fall through. */
      var what = (d.mode === 'impossible') ? 'the impossible window' : 'the window';
      var t = 'closed ' + what + ' in ' + secs(d.timeMs);
      if (typeof d.clicks === 'number') t += ' (' + d.clicks + ' click' + (d.clicks === 1 ? '' : 's') + ')';
      return t;
    }
    if (type === 'run_failed') return failWords(d);
    if (type === 'cheat_detected') {
      return 'was caught cheating' + (d.reason ? ' (' + d.reason + ')' : '');
    }
    return 'failed on flappy bird';
  }

  /* V3.6: replayed lines carry the server's `at` stamp, so a run from twenty
     minutes ago reads as twenty minutes ago instead of "just now". A live line
     without one falls back to the wall clock. */
  function clockAt(ms) {
    var t = (typeof ms === 'number' && isFinite(ms)) ? new Date(ms) : new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
  }

  /* A player's name is the way into their properties. When the event carries no
     id there is nothing to open, so it stays plain text rather than a dead link. */
  function nameEl(name, id) {
    var label = name || 'someone';
    if (!id) {
      var flat = document.createElement('span');
      flat.textContent = label;
      return flat;
    }
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pname';
    b.textContent = label;
    b.addEventListener('click', function () { openProps(id, label); });
    return b;
  }

  function pushFeed(type, d) {
    if (!feedList) return;
    var empty = feedList.querySelector('.feedempty');
    if (empty) feedList.removeChild(empty);

    var icon = FEED_ICON[type] || FEED_ICON.fallback;
    /* an abandon is not an error; soften the badge to match the wording */
    if (type === 'run_failed' && !d.reason) icon = FEED_ICON.flappy_death;

    var line = document.createElement('div');
    line.className = 'feedline';

    var badge = document.createElement('span');
    badge.className = 'fi ' + icon[0];
    badge.textContent = icon[1];
    line.appendChild(badge);

    var when = document.createElement('span');
    when.className = 'feedtime';
    when.textContent = clockAt(d.at);
    line.appendChild(when);

    var text = document.createElement('span');
    text.className = 'feedtext';
    text.appendChild(nameEl(d.name, d.twitchId || d.id));
    text.appendChild(document.createTextNode(' ' + feedWords(type, d)));
    line.appendChild(text);

    // newest at the top, so a busy feed never makes the eye chase it downward
    feedList.insertBefore(line, feedList.firstChild);
    while (feedList.childNodes.length > FEED_MAX) feedList.removeChild(feedList.lastChild);
  }

  function feedQuiet(msg) {
    if (!feedList || feedList.querySelector('.feedline')) return;
    clear(feedList);
    var p = document.createElement('p');
    p.className = 'feedempty';
    p.textContent = msg;
    feedList.appendChild(p);
  }

  /* The stream being down is a quiet state, never an error surface.

     Reconnects are deliberately invisible once the feed has been live. SSE
     drops and re-establishes as a matter of course, and flipping the label back
     to "Connecting..." each time makes a working feed look broken. The label
     only ever leaves "Monitoring" when net.js has given up for good. */
  var feedEverLive = false;

  function feedStatus(state) {
    if (!feedState) return;
    if (state === 'live') {
      feedEverLive = true;
      feedState.textContent = 'Monitoring';
      feedQuiet('No activity yet.');
      return;
    }
    if (state === 'offline') {
      feedState.textContent = 'OFFLINE';
      feedQuiet('Activity log unavailable.');
      return;
    }
    if (feedEverLive) return;                 // a blip, not a state change
    feedState.textContent = 'Connecting...';
  }

  function startFeed() {
    if (!NET || !NET.openFeed) { feedStatus('offline'); return; }
    feedStatus('connecting');
    NET.openFeed(pushFeed, feedStatus);
  }

  /* ==================== V3.5: player Properties ========================== */

  var propsBox = document.getElementById('props');
  var propTitle = document.getElementById('propTitle');
  var propAv = document.getElementById('propAv');
  var propName = document.getElementById('propName');
  var propSub = document.getElementById('propSub');
  var propStats = document.getElementById('propStats');
  var propRuns = document.getElementById('propRuns');
  var propToken = 0;             // guards against a slow reply repainting a reopened dialog

  function relTime(at) {
    var t = Date.parse(at);
    if (!isFinite(t)) return '';
    var d = Math.max(0, Date.now() - t);
    var mins = Math.floor(d / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    var days = Math.floor(hrs / 24);
    if (days < 30) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
    return new Date(t).toLocaleDateString();
  }

  var REASON_WORDS = {
    'captcha-fail': 'wrong piece',
    'captcha-timeout': 'verification timeout',
    'clock-forgery': 'forged clock',
    'timeout': 'out of time'
  };

  /* An unknown mode reads as Practice rather than as markup or "undefined";
     the map keeps a fourth mode from silently wearing the wrong name the way
     Impossible briefly wore "Practice". */
  var MODE_WORDS = {
    practice: 'Practice',
    simulation: 'Simulation',
    impossible: 'Impossible'
  };

  /* propStatRow, not statRow: the stats tab (V3.8) declares its own statRow
     in this same scope, and the later declaration wins -- while both carried
     the name, every one of these rows was built and thrown away, and the
     Properties sheet showed an empty grid. */
  function propStatRow(k, v, mono) {
    var a = document.createElement('span');
    a.className = 'propk';
    a.textContent = k;
    var b = document.createElement('span');
    b.className = 'propv' + (mono ? ' mono' : '');
    b.textContent = v;
    propStats.appendChild(a);
    propStats.appendChild(b);
  }

  function firstNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }

  // accepts the record, a bare number, or null
  function bestMsOf(entry, legacy) {
    if (entry && typeof entry === 'object') return firstNum(entry.timeMs);
    return firstNum(entry, legacy);
  }

  function bestText(ms) {
    return (typeof ms === 'number' && isFinite(ms) && ms > 0) ? fmtMs(ms) : '--';
  }

  function runRow(r) {
    var row = document.createElement('div');
    row.className = 'prow';

    var won = r.outcome === 'won';
    var open = r.outcome === 'open';
    var oc = document.createElement('span');
    oc.className = 'poutcome ' + (won ? 'won' : open ? 'open' : 'lost');
    oc.textContent = won ? 'WON' : open ? 'OPEN' : 'FAILED';
    row.appendChild(oc);

    var tm = document.createElement('span');
    tm.className = 'ptime';
    tm.textContent = won ? fmtMs(r.timeMs) : '--';
    row.appendChild(tm);

    var why = document.createElement('span');
    why.className = 'pwhy';
    var label = MODE_WORDS[r.mode] || 'Practice';
    if (!won && !open) {
      /* A ban names itself; anything else is placed by the phase the server
         stamped, so an abandoned gauntlet does not read the same as an
         abandoned chase. */
      var reasonWord = REASON_WORDS[r.failReason];
      if (!reasonWord) reasonWord = (r.phase === 'flappy') ? 'gave up in the gauntlet' : 'abandoned';
      label += ' - ' + reasonWord;
    }
    why.textContent = label;
    row.appendChild(why);

    var when = document.createElement('span');
    when.className = 'pwhen';
    when.textContent = relTime(r.at);
    row.appendChild(when);

    return row;
  }

  function paintProps(p) {
    propName.textContent = p.displayName || 'Unknown';
    propTitle.textContent = (p.displayName || 'Player') + ' Properties';
    if (p.avatarUrl) propAv.src = p.avatarUrl;

    var totals = p.totals || {};
    var runs = firstNum(totals.runs, p.runsTotal);
    var wins = firstNum(totals.wins, p.wins);
    var fails = firstNum(p.totalFails,
                         (runs !== null && wins !== null) ? runs - wins : null);

    propSub.textContent = (runs === null ? 'No runs on record' :
      runs + ' run' + (runs === 1 ? '' : 's') + ' on record');

    clear(propStats);
    /* best.<mode> is a record ({timeMs, misses, clicks, achievedAt, rank}) or
       null -- not a number. Treating it as one printed "--" for every player who
       actually had a best time. */
    var best = p.best || {};
    propStatRow('Best (Practice)', bestText(bestMsOf(best.practice, p.bestPractice)), true);
    propStatRow('Best (Simulation)', bestText(bestMsOf(best.simulation, p.bestSimulation)), true);
    propStatRow('Best (Impossible)', bestText(bestMsOf(best.impossible)), true);
    propStatRow('Runs', num(runs));
    propStatRow('Wins', num(wins));
    propStatRow('Fails', num(fails));
    propStatRow('Bird gauntlet', num(p.flappyFails));
    propStatRow('Popup chase', num(p.chaseFails));

    clear(propRuns);
    var list = p.runs || [];
    if (!list.length) {
      var none = document.createElement('p');
      none.className = 'feedempty';
      none.textContent = 'No runs recorded.';
      propRuns.appendChild(none);
      return;
    }
    /* One unexpected row must not cost the player the other ninety-nine. */
    for (var i = 0; i < list.length; i++) {
      try { propRuns.appendChild(runRow(list[i])); } catch (e) { /* skip that row */ }
    }
  }

  function propsMessage(msg) {
    clear(propStats);
    clear(propRuns);
    var p = document.createElement('p');
    p.className = 'feedempty';
    p.textContent = msg;
    propRuns.appendChild(p);
  }

  function openProps(id, name) {
    if (!propsBox || !id) return;
    var mine = ++propToken;
    propsBox.classList.remove('hide');
    propTitle.textContent = (name || 'Player') + ' Properties';
    propName.textContent = name || '';
    propSub.textContent = 'Reading...';
    propAv.removeAttribute('src');
    clear(propStats);
    clear(propRuns);

    if (!NET || !NET.player) { propSub.textContent = ''; propsMessage('Player details unavailable.'); return; }
    NET.player(id).then(function (p) {
      if (mine !== propToken) return;               // a newer dialog already owns the box
      if (!p) { propSub.textContent = ''; propsMessage('Player details unavailable.'); return; }
      paintProps(p);
    });
  }

  function closeProps() {
    propToken++;                                     // orphan any reply still in flight
    if (propsBox) propsBox.classList.add('hide');
  }

  if (propsBox) {
    document.getElementById('propX').addEventListener('click', closeProps);
    document.getElementById('propOk').addEventListener('click', closeProps);
    // clicking the darkened desktop behind the dialog dismisses it, as it should
    propsBox.addEventListener('click', function (e) {
      if (e.target === propsBox) closeProps();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !propsBox.classList.contains('hide')) closeProps();
    });
  }

  var tabGame = document.getElementById('tabGame');
  var tabBoard = document.getElementById('tabBoard');
  var panelGame = document.getElementById('panelGame');
  var panelBoard = document.getElementById('panelBoard');
  var boardList = document.getElementById('boardList');
  var boardStatus = document.getElementById('boardStatus');

  var lbBox = document.getElementById('lbBox');
  var lbList = document.getElementById('lbList');
  var lbStatus = document.getElementById('lbStatus');
  var lbClose = document.getElementById('lbClose');

  var tabStats = document.getElementById('tabStats');
  var panelStats = document.getElementById('panelStats');
  var statsList = document.getElementById('statsList');
  var statsStatus = document.getElementById('statsStatus');

  /* V4.0: which of the two boards the panel is showing. The pair of toggle
     buttons above the list flips it; the tab re-render keeps whatever the
     visitor last picked. */
  var boardMode = 'simulation';
  var bmSim = document.getElementById('bmSim');
  var bmImp = document.getElementById('bmImp');

  function setBoardMode(m) {
    boardMode = m;
    if (bmSim) {
      bmSim.classList.toggle('on', m === 'simulation');
      bmSim.setAttribute('aria-pressed', String(m === 'simulation'));
    }
    if (bmImp) {
      bmImp.classList.toggle('on', m === 'impossible');
      bmImp.setAttribute('aria-pressed', String(m === 'impossible'));
    }
    renderBoard(boardList, m, boardStatus, boardReq);
  }

  if (bmSim && bmImp) {
    bmSim.addEventListener('click', function () { setBoardMode('simulation'); });
    bmImp.addEventListener('click', function () { setBoardMode('impossible'); });
  }

  function showTab(which) {
    var board = (which === 'board');
    var stats = (which === 'stats');
    tabGame.classList.toggle('on', !board && !stats);
    tabBoard.classList.toggle('on', board);
    tabStats.classList.toggle('on', stats);
    panelGame.classList.toggle('hide', board || stats);
    panelBoard.classList.toggle('hide', !board);
    panelStats.classList.toggle('hide', !stats);
    if (board) renderBoard(boardList, boardMode, boardStatus, boardReq);
    if (stats) loadStats();
  }

  /* ---------------- V3.8: the stats board ----------------
     One fetch per tab visit, then every sort is a client-side re-render of
     the same array. Rows with no time in a time column sink to the bottom
     whichever way the sort points -- "never played" is not a ranking. */

  var statsPlayers = null;
  var statsSort = { key: 'wins', dir: -1 };   // winners first, out of the box

  function statCell(text, cls) {
    var el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function statRow(p) {
    var row = document.createElement('div');
    row.className = 'lbrow';

    var nameCell = document.createElement('span');
    nameCell.className = 'lbname';
    var av = document.createElement('img');
    av.className = 'lbav';
    av.alt = '';
    av.width = 16;
    av.height = 16;
    if (p.avatarUrl) av.src = p.avatarUrl;
    nameCell.appendChild(av);
    var nm = nameEl(p.displayName, p.userId);
    nm.className += (nm.className ? ' ' : '') + 'lbnametext';
    nameCell.appendChild(nm);
    row.appendChild(nameCell);

    row.appendChild(statCell(num(p.wins), 'stnumcol'));
    row.appendChild(statCell(num(p.flappyFails), 'stnumcol'));
    row.appendChild(statCell(num(p.chaseFails), 'stnumcol'));
    row.appendChild(statCell(num(p.totalFails), 'stnumcol'));
    row.appendChild(statCell(typeof p.bestPracticeMs === 'number' ? secs(p.bestPracticeMs) : '--', 'sttimecol'));
    row.appendChild(statCell(typeof p.bestSimMs === 'number' ? secs(p.bestSimMs) : '--', 'sttimecol'));
    row.appendChild(statCell(typeof p.bestImpMs === 'number' ? secs(p.bestImpMs) : '--', 'sttimecol'));
    return row;
  }

  function paintStatsHead() {
    var btns = panelStats.querySelectorAll('.stsort');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var label = b.getAttribute('data-label');
      var on = b.getAttribute('data-key') === statsSort.key;
      b.textContent = '';
      var dir = null;
      if (on) {
        dir = document.createElement('span');
        dir.className = 'stdir';
        dir.textContent = statsSort.dir < 0 ? '▼' : '▲';
      }
      // The arrow floats in the header's empty side (absolute, .stdir), so
      // the label's edge stays planted over its column whichever header
      // carries the sort and however narrow the column runs.
      b.appendChild(document.createTextNode(label));
      if (dir) b.appendChild(dir);
      b.setAttribute('aria-label',
        label + (on ? (statsSort.dir < 0 ? ', sorted descending' : ', sorted ascending') : ''));
    }
  }

  function renderStats() {
    if (!statsPlayers) return;
    var key = statsSort.key;
    var dir = statsSort.dir;
    statsPlayers.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      // == null: a column the server omitted arrives undefined, not null,
      // and must sink the same way instead of throwing in the string branch
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.toLowerCase().localeCompare(bv.toLowerCase());
      return dir * (av - bv);
    });
    paintStatsHead();
    clear(statsList);
    if (!statsPlayers.length) {
      var none = document.createElement('p');
      none.className = 'lbempty';
      none.textContent = 'Nobody has signed in and played yet.';
      statsList.appendChild(none);
    }
    for (var i = 0; i < statsPlayers.length; i++) statsList.appendChild(statRow(statsPlayers[i]));
    setStatus(statsStatus, statsPlayers.length + ' object' + (statsPlayers.length === 1 ? '' : 's'));
  }

  function loadStats() {
    if (!statsList) return;
    if (statsPlayers) { renderStats(); }   // stale is fine while the refresh runs
    if (!NET) { clear(statsList); offlineInto(statsList, statsStatus); return; }
    setStatus(statsStatus, 'Working...');
    NET.stats().then(function (d) {
      var players = d && d.players;
      if (!players) {
        if (!statsPlayers) { clear(statsList); offlineInto(statsList, statsStatus); }
        return;
      }
      statsPlayers = players;
      renderStats();
    });
  }

  // The modal, used by the win dialog's View leaderboard button. It shows the
  // board of the mode that was just played; anything unranked (practice
  // included) falls back to simulation, as it always has.
  var lbModalCap = document.getElementById('lbModalCap');

  function openModal(mode) {
    var m = (mode === 'impossible') ? 'impossible' : 'simulation';
    if (lbModalCap) {
      lbModalCap.textContent = (m === 'impossible')
        ? 'Impossible runs only' : 'Simulation runs only';
    }
    lbBox.classList.remove('hide');
    renderBoard(lbList, m, lbStatus, modalReq);
  }

  if (tabGame) {
    tabGame.addEventListener('click', function () { showTab('game'); });
    tabBoard.addEventListener('click', function () { showTab('board'); });
    tabStats.addEventListener('click', function () { showTab('stats'); });
  }
  if (panelStats) {
    panelStats.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== panelStats && !(t.getAttribute && t.getAttribute('data-key'))) t = t.parentNode;
      if (!t || t === panelStats) return;
      var key = t.getAttribute('data-key');
      if (statsSort.key === key) {
        statsSort.dir = -statsSort.dir;
      } else {
        // Names read forward and times rank fastest-first; counts rank most-first.
        statsSort = { key: key, dir: (key === 'displayName' || key.indexOf('best') === 0) ? 1 : -1 };
      }
      renderStats();
    });
  }
  if (lbBox) {
    lbClose.addEventListener('click', function () { lbBox.classList.add('hide'); });
  }
  if (acctLogin) {
    // a top-level navigation, so the Twitch redirect and the session cookie both land
    acctLogin.addEventListener('click', function () {
      if (NET) window.location.href = NET.loginUrl();
    });
    btnLogout.addEventListener('click', function () {
      if (!NET) return;
      NET.logout().then(function () { user = null; paintAccount(); });
    });
  }

  /* net.js sleeps for thirty seconds after the first outright failure, and the
     boot pair below is serialised, so a cold container that loses the identity
     call also loses the leaderboard call queued behind it -- apiUp latches false
     with nothing in the page left to clear it. One retry after that cooldown has
     expired costs a single request and gives a container that has since woken up
     its account panel back. Once per page: a backend that is genuinely gone is
     not worth a second one. */
  var REPROBE_MS = 31000;
  var reprobed = false;

  function reprobeApi() {
    if (reprobed || !NET) return;
    reprobed = true;
    window.setTimeout(function () {
      NET.me().then(function (u) {
        if (u && !user) user = u;
        return NET.leaderboard('simulation');
      }).then(function (d) {
        apiUp = !!(d && (d.entries || d.rows));
        paintAccount();
      });
    }, REPROBE_MS);
  }

  /* Ask who we are once at boot. Any failure just leaves the panel in its
     signed-out state, or OFFLINE if the API never answered. */
  if (NET) {
    /* Serialised on purpose. net.js puts itself to sleep after the first
       outright failure, so asking these one after the other means a dead backend
       costs ONE request instead of two -- which halves the browser's own network
       log noise in the offline case. */
    bootMe = NET.me().then(function (u) {
      user = u;
      paintAccount();
      return u;
    });
    bootMe.then(function () {
      return NET.leaderboard('simulation');
    }).then(function (d) {
      apiUp = !!(d && (d.entries || d.rows));
      paintAccount();
      if (!apiUp) reprobeApi();
    });
  } else {
    apiUp = false;
    paintAccount();
  }

  /* ---------------- router ---------------- */

  function query() {
    var out = {};
    var s = window.location.search;
    if (!s || s.length < 2) return out;
    var parts = s.slice(1).split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf('=');
      var k = (eq < 0) ? parts[i] : parts[i].slice(0, eq);
      var v = (eq < 0) ? '' : parts[i].slice(eq + 1);
      try {
        out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch (e) { /* malformed escape, ignore the pair */ }
    }
    return out;
  }

  var q = query();
  var mode = q.mode;
  var skipFlappy = (q.skipflappy === '1');
  // A seam run plays exactly like a real one but never writes a best time (V2.6 layer 8).
  var isSeam = (mode === 'practice' || mode === 'simulation'
                || mode === 'impossible' || skipFlappy);

  if (isSeam) LOG('[AIMLAB] QA SEAM USED');

  document.getElementById('btnPractice').addEventListener('click', startPractice);
  document.getElementById('btnSimulation').addEventListener('click', function () {
    startSimulation(true);
  });
  document.getElementById('btnImpossible').addEventListener('click', function () {
    startImpossible(true);
  });

  /* V3.5. The activity log is on the landing tab, so it opens itself -- the
     player never has to ask for it. It is a separate connection from the account
     and leaderboard calls and degrades on its own terms. A seam run hides the
     start screen immediately, so the panel would never be seen: no stream is
     opened for one, which also keeps the seam's network footprint minimal. */
  if (!isSeam) startFeed();

  /* V3.10: the taskbar clock. Decorative like the rest of the bar, but a
     tray that never ticks reads as a hang, which is the wrong joke. */
  var tray = document.getElementById('trayClock');

  function tickTray() {
    var d = new Date();
    var h = d.getHours();
    var m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    tray.textContent = h + ':' + (m < 10 ? '0' + m : m) + ' ' + ap;
  }

  if (tray) {
    tickTray();
    window.setInterval(tickTray, 15000);
  }

  if (mode === 'practice') startPractice();
  else if (mode === 'simulation') startSimulation(false);
  else if (mode === 'impossible') startImpossible(false);
})();
