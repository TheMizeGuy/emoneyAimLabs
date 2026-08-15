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
    if (p && p.then) p.then(onDecoded, onDecodeFailed);
  }

  function onDecoded(decoded) {
    if (buffer || !decoded) return;
    decoding = false;
    buffer = decoded;
    pushAudio();
  }

  function onDecodeFailed() {
    decoding = false;
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

  /* ---------------- modes ---------------- */

  function startPractice() {
    startScreen.classList.add('hide');
    LOG('[AIMLAB] MODE mode=practice');
    chase = window.AimlabChase.start(stage, {
      imageSrc: PRACTICE.imageSrc,
      imageW: PRACTICE.imageW,
      imageH: PRACTICE.imageH,
      bestKey: PRACTICE.bestKey,
      recordBest: !isSeam,
      // null hands audio ownership to the engine, which builds its own context
      // inside the first miss click for the error chord. There is no loop here.
      audio: null
    });
  }

  function startSimulation(fromGesture) {
    startScreen.classList.add('hide');
    LOG('[AIMLAB] MODE mode=simulation');
    fetchLoop();

    if (fromGesture) ensureContext();   // the mode button click is the gesture
    else armGesture();

    if (!skipFlappy && window.AimlabFlappy && window.AimlabFlappy.start) {
      flappy = window.AimlabFlappy.start(stage, {
        targetScore: TARGET_SCORE,
        onComplete: function () {
          if (flappy && flappy.stop) flappy.stop();
          flappy = null;
          startSimChase();
        }
      });
      return;
    }

    if (!skipFlappy) ERR('[AIMLAB] flappy unavailable, starting the chase directly');
    startSimChase();
  }

  function startSimChase() {
    chase = window.AimlabChase.start(stage, {
      imageSrc: SIMULATION.imageSrc,
      imageW: SIMULATION.imageW,
      imageH: SIMULATION.imageH,
      bestKey: SIMULATION.bestKey,
      recordBest: !isSeam,
      // A non-null object tells the engine this module owns the audio. Either
      // field may still be null; pushAudio fills them in as they arrive.
      audio: { ctx: ctx, buffer: buffer }
    });
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

  if (mode === 'practice') startPractice();
  else if (mode === 'simulation') startSimulation(false);
})();
