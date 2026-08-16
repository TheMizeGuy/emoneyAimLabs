/* eMoney Aim Labs -- mode router.

   Owns the start screen, the two modes, and the shared AudioContext for
   simulation. Nothing here knows how either game works; it only wires them:

     Practice    -> AimlabChase with emoney.png, no shared audio.
     Simulation  -> AimlabFlappy to 10 points, then AimlabChase with
                    simulation.png and the 8 s loop.

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
    imageW: 312,
    imageH: 128,
    bestKey: 'emoney-aimlabs-best-sim'
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
  var bootMe = null;               // resolves once the boot identity call has settled
  var runNonce = '';               // V3.4 run nonce, presented on every beat
  var runChain = '';               // V3.4 newest chain token the server handed back
  var beatTimer = 0;
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
      acctLogin.classList.add('hide');
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
  function renderBoard(listEl, mode, statusEl) {
    if (!listEl) return;
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

  /* V3.5. The chase engine ended the run on a ban screen. This is cosmetic --
     it names the reason on the feed and in the player's history and can never
     move a score -- so it is fire-and-forget, and seam runs never report. */
  function reportBan(reason) {
    /* The ban closes the run on the server immediately, so every later heartbeat
       is refused -- one false [ANTICHEAT] line and one rejections row every five
       seconds, indefinitely, polluting the very audit trail the rejections table
       exists to keep clean. The run is over here too. */
    stopBeats();
    runGen++;                       // nothing in flight may reopen this run
    runId = null;
    runNonce = '';
    runChain = '';
    if (isSeam || !NET || !user) return;
    NET.event('ban', reason);
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
    stopBeats();
    if (!NET || isSeam) return;

    /* The mode buttons are the first thing a returning player clicks, and on a
       cold container the boot me() can still be in flight when they do. Bailing
       on !user there cost them the ENTIRE run -- no run row, no beats, no score,
       and a win dialog telling a signed-in player there was no server run. Wait
       for the identity to land, then open the run; the chase may already be
       under way by then, which startRun's own inChase handling covers. */
    var gen = ++runGen;
    if (user) { openRun(mode, gen); return; }
    if (bootMe) bootMe.then(function () { openRun(mode, gen); });
  }

  function openRun(mode, gen) {
    if (!NET || isSeam || !user) return;      // genuinely signed out: nothing to open
    if (gen !== runGen) return;               // that run was abandoned while we waited
    NET.startRun(mode).then(function (r) {
      if (!r) { apiUp = false; paintAccount(); return; }
      runId = r.runId;
      runNonce = r.nonce;
      runChain = r.chain;              // V3.4 genesis token
      startBeats();
      /* The chase can begin before this POST resolves -- flappy being
         unavailable sends us straight through, and a fast gauntlet could too.
         In that case the phase flag is already set and the stamping beat has to
         go out here instead, or the server would not see chase:true until the
         next five-second tick. */
      if (inChase) sendBeat();
    });
  }

  /* The chase segment has begun: the server stamps the phase transition off the
     first beat carrying chase:true, so one goes out immediately rather than
     waiting up to five seconds for the next tick. */
  function markChaseStarted() {
    inChase = true;
    sendBeat();
  }

  /* V3.4. One beat, carrying the run nonce and the newest chain token. The
     reply advances the token; a beat that does not land leaves the one we hold
     in place, so the next beat simply re-presents it and the server closes the
     gap on its side. Nothing here blocks or throws. */
  function sendBeat() {
    if (!NET || !runId) return;
    var forRun = runId;
    NET.beat(runId, runNonce, runChain, inChase).then(function (next) {
      // a late reply must not overwrite the token of a run that already ended
      if (next && runId === forRun) runChain = next;
    });
  }

  // The heartbeat is what makes a forged time expensive: it has to be held for
  // the whole claimed duration. It keeps running through captchas, because the
  // run timer does too.
  function startBeats() {
    stopBeats();
    beatTimer = window.setInterval(sendBeat, BEAT_MS);
  }

  function stopBeats() {
    if (beatTimer) { window.clearInterval(beatTimer); beatTimer = 0; }
  }

  function finishRun(stats) {
    stopBeats();
    if (!chase || !chase.winExtras) return;
    if (isSeam) return;                      // seam runs are never submitted
    if (!NET) return;

    if (!user) {
      chase.winExtras({ note: 'Sign in with Twitch to post your score.' });
      return;
    }
    if (!runId) {
      chase.winExtras({ note: 'Score not recorded: no server run for this attempt.' });
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
      runId = null;
      runNonce = '';
      runChain = '';
      LOG('[AIMLAB] SCORE WITHHELD sus=' + stats.sus +
          ' cheated=' + (stats.cheated ? 1 : 0) + ' sig=' + (stats.sig ? 1 : 0));
      return;                       // the engine's own dialog is the notice
    }

    var id = runId;
    runId = null;
    runNonce = '';
    runChain = '';
    NET.submitScore(id, stats.timeMs, stats.misses, stats.nearMisses,
                    stats.sus, stats.sig).then(function (r) {
      if (!r) {
        chase.winExtras({ note: 'Score could not be recorded. The leaderboard is offline.' });
        return;
      }
      if (r.refused) {
        // the server refused it and said why; passing that on beats inventing an outage
        chase.winExtras({ note: r.message || 'Score not accepted by the server.' });
        return;
      }
      var note = (r.improved ? 'New record.   ' : '') + 'Rank #' + r.rank;
      if (typeof r.bestMs === 'number') note += '   best ' + fmtMs(r.bestMs);
      chase.winExtras({
        note: note,
        onBoard: function () { openModal(); }
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
      onBan: reportBan,
      // V2.8: practice is silent. No loop, no error chord, no AudioContext -- the
      // engine never builds one, so there is nothing here to autoplay-gate.
      audio: null
    });
  }

  function startSimulation(fromGesture) {
    if (running) return;
    running = 'simulation';
    startScreen.classList.add('hide');
    LOG('[AIMLAB] MODE mode=simulation');
    beginRun('simulation');          // V3.3: witnessed from the gauntlet onward
    fetchLoop();

    if (fromGesture) ensureContext();   // the mode button click is the gesture
    else armGesture();

    if (!skipFlappy && window.AimlabFlappy && window.AimlabFlappy.start) {
      flappy = window.AimlabFlappy.start(stage, {
        targetScore: TARGET_SCORE,
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
          startSimChase(info);
        }
      });
      return;
    }

    if (!skipFlappy) ERR('[AIMLAB] flappy unavailable, starting the chase directly');
    startSimChase(null);
  }

  function startSimChase(info) {
    markChaseStarted();              // V3.3: the run was opened at flappy start
    chase = startChase({
      imageSrc: SIMULATION.imageSrc,
      imageW: SIMULATION.imageW,
      imageH: SIMULATION.imageH,
      bestKey: SIMULATION.bestKey,
      modeLabel: 'SIMULATION',
      recordBest: !isSeam,
      onWin: function (st) { finishRun({ mode: 'simulation', timeMs: st.timeMs,
                                         misses: st.misses, nearMisses: st.nearMisses,
                                         sus: st.sus, sig: st.sig,
                                         cheated: st.cheated }); },
      // V2.14: the ban screen's two buttons come back through here
      onExit: onChaseExit,
      onBan: reportBan,
      susSeed: (info && info.sus > 0) ? info.sus : 0,
      stateCheat: !!(info && info.stateCheat),
      // A non-null object tells the engine this module owns the audio. Either
      // field may still be null; pushAudio fills them in as they arrive.
      audio: { ctx: ctx, buffer: buffer }
    });
  }

  /* V2.14. A captcha ban ends the run; the player picks where to go next.
     Retry restarts SIMULATION from the flappy gauntlet as a completely fresh
     run, Home returns to the start screen. Either way the chase is torn down
     first, which stops its audio and unbinds everything it owns. */
  function onChaseExit(action) {
    stopBeats();
    runId = null;
    runNonce = '';
    runChain = '';
    try { if (chase && chase.stop) chase.stop(); }
    catch (e) { ERR('[AIMLAB] chase stop threw: ' + (e && e.message)); }
    chase = null;
    running = null;

    if (action === 'retry') {
      skipFlappy = false;             // a retry always starts at the gauntlet
      startSimulation(true);          // the ban button click is the gesture
      return;
    }
    startScreen.classList.remove('hide');
  }

  /* ---------------- V3 UI: tabs, panels, modal ---------------- */

  /* ==================== V3.5: activity log ============================== */

  var feedList = document.getElementById('feedList');
  var feedState = document.getElementById('feedState');
  var FEED_MAX = 50;             // displayed lines; the oldest fall off the end

  /* Each event type gets an Event-Viewer severity badge and a sentence. The
     sentences deliberately name the SEGMENT the run died in, because "failed"
     on its own tells a spectator nothing. */
  var FEED_ICON = {
    run_started: ['fi-i', 'i'],
    run_won: ['fi-win', '*'],
    run_failed: ['fi-e', 'x'],
    flappy_death: ['fi-w', '!']
  };

  function modeWord(m) {
    return (m === 'simulation') ? 'SIMULATION' : 'PRACTICE';
  }

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
    if (d.reason === 'captcha-fail') return 'failed the popup chase (INDEFINITE BAN: wrong piece)';
    if (d.reason === 'captcha-timeout') return 'failed the popup chase (INDEFINITE BAN: verification timeout)';
    if (d.reason === 'timeout') return 'ran out of time on the popup chase';
    return 'gave up on the popup chase';
  }

  function feedWords(type, d) {
    if (type === 'run_started') return 'started ' + modeWord(d.mode);
    if (type === 'run_won') {
      var t = 'closed the window in ' + secs(d.timeMs);
      if (typeof d.clicks === 'number') t += ' (' + d.clicks + ' click' + (d.clicks === 1 ? '' : 's') + ')';
      return t;
    }
    if (type === 'run_failed') return failWords(d);
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

    var icon = FEED_ICON[type] || FEED_ICON.run_started;
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
    'timeout': 'out of time'
  };

  function statRow(k, v, mono) {
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
    var label = (r.mode === 'simulation') ? 'Simulation' : 'Practice';
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
    statRow('Best (Practice)', bestText(bestMsOf(best.practice, p.bestPractice)), true);
    statRow('Best (Simulation)', bestText(bestMsOf(best.simulation, p.bestSimulation)), true);
    statRow('Runs', num(runs));
    statRow('Wins', num(wins));
    statRow('Fails', num(fails));
    statRow('Bird gauntlet', num(p.flappyFails));
    statRow('Popup chase', num(p.chaseFails));

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

  function showTab(which) {
    var board = (which === 'board');
    tabGame.classList.toggle('on', !board);
    tabBoard.classList.toggle('on', board);
    panelGame.classList.toggle('hide', board);
    panelBoard.classList.toggle('hide', !board);
    if (board) renderBoard(boardList, 'simulation', boardStatus);
  }

  // the modal, used by the win dialog's View leaderboard button
  function openModal() {
    lbBox.classList.remove('hide');
    renderBoard(lbList, 'simulation', lbStatus);
  }

  if (tabGame) {
    tabGame.addEventListener('click', function () { showTab('game'); });
    tabBoard.addEventListener('click', function () { showTab('board'); });
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
  var isSeam = (mode === 'practice' || mode === 'simulation' || skipFlappy);

  if (isSeam) LOG('[AIMLAB] QA SEAM USED');

  document.getElementById('btnPractice').addEventListener('click', startPractice);
  document.getElementById('btnSimulation').addEventListener('click', function () {
    startSimulation(true);
  });

  /* V3.5. The activity log is on the landing tab, so it opens itself -- the
     player never has to ask for it. It is a separate connection from the account
     and leaderboard calls and degrades on its own terms. A seam run hides the
     start screen immediately, so the panel would never be seen: no stream is
     opened for one, which also keeps the seam's network footprint minimal. */
  if (!isSeam) startFeed();

  if (mode === 'practice') startPractice();
  else if (mode === 'simulation') startSimulation(false);
})();
