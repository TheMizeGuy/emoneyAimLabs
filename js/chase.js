/* eMoney Aim Labs -- chase engine.

   Extracted from the v1 single-file build and reworked for v2:

     1. Componentisation. All state lives inside start(), the markup is built in
        JS, element lookups use data-el attributes instead of document ids, and
        every listener goes through on() so stop() can unwind them.
     2. Caller-supplied config: image, localStorage key, optional audio loop.
     3. V2.1 playfield: the flat Windows 95 desktop teal, no grid or range rings.
     4. V2.2/V2.3 window: exact Win95 chrome (two-step bevel, navy title bar,
        bevelled close button flush right inside the bar) wrapped tightly around
        the image at its native size -- no plate, no padding, no caption.
     5. V2.2 difficulty retune and the V2.4 synthesized error chord on every miss.
     6. V2.6 anti-cheat annoyance. Client-side cheating cannot be prevented; the
        bar is "annoying enough not to bother". See ANTI-CHEAT below.

   Contract:
     window.AimlabChase.start(container, {
       imageSrc,          // string, default './assets/emoney.png'
       imageW, imageH,    // intrinsic pixels; the window is built around them
       bestKey,           // localStorage key, default 'emoney-aimlabs-best'
       audio,             // null  -> the chase owns its own AudioContext
                          // object-> the caller owns audio: { ctx, buffer }, either may
                          //          be null until ready; hand updates over with setAudio
       recordBest,        // false on QA-seam runs: play normally, record nothing
       onWin              // optional fn(stats)
     }) -> frozen { stop(), setAudio(audio) }

   ANTI-CHEAT (V2.6), all annoyance and never a lock -- a player who does not
   open devtools sees none of it:
     - every value is closure-local; the module and its handle are frozen, and
       nothing authoritative is exposed on window or on a DOM attribute
     - the built-ins this engine depends on are captured at parse time, so
       monkey-patching performance.now/Date.now/rAF/setTimeout later does nothing
     - the run is timed on two independent clocks with a rolling checksum; a
       splice shows up as drift or as a step, and pays out a Win95 error dialog
       instead of a victory
     - a MutationObserver re-derives the HUD and overlay from closure state, so
       edited numbers snap back and cost the editor a taunt
     - devtools hotkeys and the context menu are swallowed with a taunt, and can
       tip the run into a reversible "shame mode"
     - stored best times are salted-checksum signed

   Styles for every class used here live in the one <style> block in index.html.
*/
(function () {
  'use strict';

  /* ---- captured built-ins (V2.6 layer 2) ------------------------------
     Bound once, at parse time. Everything below calls these and never the
     live globals, so a speed hack that replaces performance.now or
     requestAnimationFrame after load has nothing to grab. */
  var W = window;
  var WALL = Date.now.bind(Date);
  var NOW = (W.performance && W.performance.now)
    ? W.performance.now.bind(W.performance)
    : WALL;                                  // fallback is the captured ref too
  var RAF       = W.requestAnimationFrame.bind(W);
  var CAF       = W.cancelAnimationFrame.bind(W);
  var DELAY     = W.setTimeout.bind(W);
  var UNDELAY   = W.clearTimeout.bind(W);
  var LOG = (W.console && W.console.log) ? W.console.log.bind(W.console) : function () {};
  var OBSERVER = W.MutationObserver || W.WebKitMutationObserver || null;

  var DEFAULT_IMAGE    = './assets/emoney.png';
  var DEFAULT_BEST_KEY = 'emoney-aimlabs-best';

  // Win95 chrome at 2x classic metrics. Kept in sync with .card/.cardin/.bar in
  // index.html so the window can be sized before the image has loaded.
  var FRAME_PX = 4;    // 2px outer bevel + 2px inner bevel, per side
  var BAR_H    = 36;   // title bar height

  var MARKUP = [
    '<div class="hud" data-el="hud">',
    '<div class="row time"><span class="k">TIME</span><span class="v" data-el="time">00:00.000</span></div>',
    '<div class="row"><span class="k">MISSES</span><span class="v" data-el="miss">0</span></div>',
    '<div class="row"><span class="k">NEAR</span><span class="v" data-el="near">0</span></div>',
    '<div class="row best hide" data-el="bestRow"><span class="k">BEST</span><span class="v" data-el="best">--</span></div>',
    '</div>',
    '<div class="sig">',
    '<h1>eMoney Aim Labs</h1>',
    '<p>Close the popup to win. It has opinions about being closed.</p>',
    '</div>',
    '<div class="wrap" data-el="wrap">',
    '<div class="card" data-el="card">',
    '<div class="cardin">',
    '<div class="bar">',
    '<span class="bartitle">eMoney.exe</span>',
    '<button class="x" data-el="close" type="button" aria-label="Close" tabindex="-1"></button>',
    '</div>',
    '<div class="shot" data-el="shot"></div>',
    '</div>',
    '<div class="taunt" data-el="taunt" aria-hidden="true"></div>',
    '</div>',
    '</div>',
    '<div class="ov" data-el="overlay">',
    '<div class="ovcard">',
    '<div class="ovbar"><span class="ovbartitle" data-el="ovTitle">Popup closed</span></div>',
    '<div class="ovbody" data-el="ovWin">',
    '<p class="ovtime" data-el="ovTime">00:00.000</p>',
    '<p class="ovnote" data-el="ovNote"></p>',
    '<dl class="ovstats">',
    '<div><dt>Misses</dt><dd data-el="ovMiss">0</dd></div>',
    '<div><dt>Near</dt><dd data-el="ovNear">0</dd></div>',
    '<div><dt>Best</dt><dd data-el="ovBest">--</dd></div>',
    '</dl>',
    '<button class="again" data-el="again" type="button">Play again</button>',
    '</div>',
    '<div class="ovbody hide" data-el="ovCheat">',
    '<div class="errrow">',
    '<span class="erricon" aria-hidden="true"></span>',
    '<p class="errtext">Two clocks, two answers. One of them is lying, and it is not ours.</p>',
    '</div>',
    '<p class="errsub">No time recorded.</p>',
    '<button class="again" data-el="againCheat" type="button">Play again</button>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="shame hide" data-el="shame">',
    '<div class="ovcard">',
    '<div class="ovbar"><span class="ovbartitle">eMoney.exe</span></div>',
    '<div class="ovbody">',
    '<div class="errrow">',
    '<span class="erricon" aria-hidden="true"></span>',
    '<p class="errtext" data-el="shameText"></p>',
    '</div>',
    '<button class="again" data-el="shameOk" type="button">OK</button>',
    '</div>',
    '</div>',
    '</div>'
  ].join('');

  function start(container, opts) {
    opts = opts || {};
    container = container || document.body;

    /* ---------------- tuning ---------------- */
    /* V2.2 retune: values marked (v1 N) were raised to make the chase harder.
       Everything unmarked is the v1 value, unchanged. Measurements for the new
       set are in the shell-integrator blackboard. */
    var FLEE_RADIUS        = 340;    // px, cursor -> nearest point of the card rect     (v1 300)
    var FLEE_ACCEL         = 9000;   // px/s^2 at d = 0, scaled by (1 - d/R)^2
    var DODGE_GAIN         = 3.2;    // perpendicular px/s^2 per px/s of cursor approach (v1 2.2)
    var DODGE_APPROACH_CAP = 2400;   // px/s
    var DODGE_HOLD_MS      = 300;    // dodge sign stays put this long so the swerve reads as intent
    var BASE_SPEED         = 190;    // px/s idle wander                                 (v1 150)
    var WANDER_GAIN        = 4.0;    // 1/s, how hard wander steers velocity toward its target
    var SPEED_CAP_FAR      = 1850;   //                                                  (v1 1600)
    var SPEED_CAP_NEAR_ADD = 550;    // FAR + NEAR_ADD lands exactly on the hard cap      (v1 500)
    var SPEED_CAP_HARD     = 2400;   // absolute ceiling, shame mode included             (v1 2100)
    var RESTITUTION        = 0.93;   // less energy bled per wall bounce                  (v1 0.9)
    var BOUNCE_JITTER      = 10 * Math.PI / 180;
    var PANIC_MS           = 260;
    var PANIC_ACCEL        = 4000;
    var PANIC_SPEED        = 900;
    var BURST_MS           = 1500;
    var BURST_MUL          = 1.6;
    var DT_MAX             = 0.032;  // s, keeps a backgrounded tab from integrating one giant step
    var NEAR_RADIUS        = 48;     // px from the close button's center
    var NEAR_DEBOUNCE      = 250;    // ms
    var EDGE_PAD           = 10;     // keeps a margin between the window and the screen edge
    var LATCH_MAX_MS       = 600;    // failsafe so a lost pointerup cannot freeze the card forever
    var BEST_KEY           = (typeof opts.bestKey === 'string' && opts.bestKey) ? opts.bestKey : DEFAULT_BEST_KEY;
    var RECORD_BEST        = (opts.recordBest !== false);

    /* V2.4: the error chord, synthesized. No Microsoft audio is fetched or shipped. */
    var ERROR_MS         = 200;   // total voice length
    var ERROR_ATTACK     = 0.008; // s
    var ERROR_GAIN       = 0.22;  // moderate, so the 8 s loop stays dominant in simulation
    var ERROR_MAX_VOICES = 4;     // click spam is capped instead of stacking into clipping
    var ERROR_CHORD = [
      { type: 'triangle', freq: 233.08, gain: 0.55, detune: -7 },  // Bb3
      { type: 'triangle', freq: 349.23, gain: 0.42, detune:  7 },  // F4
      { type: 'square',   freq: 466.16, gain: 0.16, detune:  0 }   // Bb4, adds the buzz
    ];

    /* V2.6 anti-cheat */
    var CLOCK_TOLERANCE_MS = 750;  // total allowed drift between the two clocks
    var CLOCK_STEP_MS      = 400;  // a single-frame jump between them reads as a splice
    var TAMPER_DEBOUNCE_MS = 800;  // one taunt per burst of meddling, not one per mutation
    var SHAME_MUL          = 1.15; // shame mode: the card gets 15 percent quicker
    var STORE_SALT         = 'aimlab-95';

    var TAUNTS = [
      'Wrong spot. The X is the small one.',
      'That was the ad, not the button.',
      'He is not going anywhere.',
      'Slower than that and it never closes.',
      'You clicked the face. Bold.',
      'Still open.'
    ];
    var TAUNT_FAKE   = 'Real clicks only. Keyboard does not count.';
    var TAUNT_TAMPER = 'Nice try. The numbers come from somewhere you cannot reach.';
    var TAUNT_TOOLS  = 'The devtools are not the hard part. The button is.';
    var TAUNT_STORE  = 'Record corrupted. Someone has been editing their trophies.';
    var SHAME_TEXT   = 'Caught you looking under the hood. He is 15 percent faster now. Enjoy.';

    /* ---------------- listener bookkeeping ---------------- */
    var listeners = [];

    function on(target, type, fn, o) {
      target.addEventListener(type, fn, o);
      listeners.push([target, type, fn, o]);
    }

    function offAll() {
      for (var i = 0; i < listeners.length; i++) {
        var L = listeners[i];
        L[0].removeEventListener(L[1], L[2], L[3]);
      }
      listeners.length = 0;
    }

    /* ---------------- elements ---------------- */
    var root = document.createElement('div');
    root.className = 'chase-root';
    root.innerHTML = MARKUP;

    function el(name) { return root.querySelector('[data-el="' + name + '"]'); }

    var hudEl     = el('hud');
    var wrap      = el('wrap');
    var card      = el('card');
    var btn       = el('close');
    var taunt     = el('taunt');
    var overlay   = el('overlay');
    var again     = el('again');
    var againX    = el('againCheat');
    var ovWin     = el('ovWin');
    var ovCheat   = el('ovCheat');
    var ovTitle   = el('ovTitle');
    var shameBox  = el('shame');
    var shameText = el('shameText');
    var shameOk   = el('shameOk');
    var elTime    = el('time');
    var elMiss    = el('miss');
    var elNear    = el('near');
    var elBest    = el('best');
    var rowBest   = el('bestRow');

    // The window is built around the image at its native size, so it can be
    // sized up front and the layout never shifts when the image lands.
    var imgW = (opts.imageW > 0) ? opts.imageW : 128;
    var imgH = (opts.imageH > 0) ? opts.imageH : 128;

    var img = document.createElement('img');
    img.src = (typeof opts.imageSrc === 'string' && opts.imageSrc) ? opts.imageSrc : DEFAULT_IMAGE;
    img.alt = 'eMoney';
    img.draggable = false;
    img.width = imgW;
    img.height = imgH;
    img.style.width = imgW + 'px';
    img.style.height = imgH + 'px';
    el('shot').appendChild(img);

    wrap.style.width = (imgW + FRAME_PX * 2) + 'px';

    container.appendChild(root);

    /* ---------------- state ----------------
       Everything below is closure-local on purpose (V2.6 layer 1): the HUD is a
       projection of these values, never the source of them. */
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    // Seeded from the known chrome metrics, then replaced by a real measurement.
    var cardW = imgW + FRAME_PX * 2;
    var cardH = imgH + BAR_H + FRAME_PX * 2;
    var btnOffX = cardW / 2 - 22;      // close button center, relative to card center
    var btnOffY = -cardH / 2 + 22;

    var x = vw / 2, y = vh / 2;        // card center
    var vx = 0, vy = 0;

    var heading = Math.random() * Math.PI * 2;
    var wanderT = 0;
    var ph1 = Math.random() * 6.283, ph2 = Math.random() * 6.283, ph3 = Math.random() * 6.283;

    var px = 0, py = 0, hasPointer = false;
    var cvx = 0, cvy = 0;              // smoothed cursor velocity
    var velX = 0, velY = 0, velT = 0;

    var dodgeSign = 1, dodgeAt = 0;
    var overlapping = false, panicUntil = 0;
    var burstUntil = 0;
    var pressLatch = false, pressLatchAt = 0;

    var nearInside = false, nearAt = -1e9;
    var started = false, startT = 0, won = false, finalMs = 0;
    var misses = 0, nearMisses = 0;
    var storeCorrupt = false;
    var bestMs = readBest();

    var lastT = 0, rafId = 0, tauntTimer = 0, winTimer = 0;
    var stopped = false;

    // dual-clock integrity
    var startWall = 0, clkDrift = 0, clkLast = null, clkStep = false;
    var clkSum = 0, clkPair = -1, clkStill = 0;
    var tamperAt = -1e9, shame = 1;
    var mo = null;

    // When the caller passes an audio object it owns the AudioContext, so the
    // chase never constructs a second one; practice passes null and owns nothing,
    // so the chase makes its own context lazily inside a miss click.
    var callerOwnsAudio = !!opts.audio;
    var audio = opts.audio || null;
    var ownCtx = null;
    var audioSource = null, audioStarted = false, audioArmed = false;
    var errVoices = [];

    /* ---------------- helpers ---------------- */

    // xorshift32: a stable pseudo-random source for dodge signs and bounce jitter
    var seed = (WALL() ^ 0x9e3779b9) >>> 0;
    function rnd() {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;  seed >>>= 0;
      return seed / 4294967296;
    }

    function fmt(ms) {
      if (!isFinite(ms) || ms < 0) ms = 0;
      ms = Math.floor(ms);
      var m = Math.floor(ms / 60000);
      var s = Math.floor(ms / 1000) % 60;
      var f = ms % 1000;
      return pad(m, 2) + ':' + pad(s, 2) + '.' + pad(f, 3);
    }

    function pad(n, w) {
      var out = String(n);
      while (out.length < w) out = '0' + out;
      return out;
    }

    function setText(e, v) {
      if (!e) return;
      var s = String(v);
      if (e.textContent !== s) e.textContent = s;
    }

    /* ---- signed storage (V2.6 layer 6) ---- */
    // FNV-1a over salt + value. Not cryptography: just enough that hand-editing
    // a best time in devtools is more work than earning one.
    function sign(v) {
      var s = STORE_SALT + '|' + v;
      var h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(36);
    }

    function readBest() {
      var raw;
      try {
        raw = window.localStorage.getItem(BEST_KEY);
      } catch (e) {
        return null;                       // storage blocked
      }
      if (raw === null) return null;

      var dot = raw.lastIndexOf('.');
      if (dot < 0) {
        // Unsigned. That is either a v1 record from before signing existed or
        // somebody typing a number into devtools, and the two are identical on
        // disk -- so it never counts as a record. No taunt either: an honest
        // returning player just starts a fresh best rather than being accused.
        return null;
      }

      var n = parseInt(raw.slice(0, dot), 10);
      if (!isFinite(n) || n < 0 || sign(n) !== raw.slice(dot + 1)) {
        storeCorrupt = true;   // a forged signature is nobody's accident
        return null;
      }
      return n;
    }

    function writeBest(ms) {
      try { window.localStorage.setItem(BEST_KEY, ms + '.' + sign(ms)); } catch (e) { /* blocked */ }
    }

    function showBest() {
      if (bestMs === null) return;
      setText(elBest, fmt(bestMs));
      rowBest.classList.remove('hide');
    }

    function showTaunt(text) {
      if (won) return;
      taunt.textContent = text;
      taunt.classList.add('on');
      UNDELAY(tauntTimer);
      tauntTimer = DELAY(function () { taunt.classList.remove('on'); }, 1300);
    }

    function startTimer() {
      if (started || won) return;
      started = true;
      startT = NOW();
      startWall = WALL();
      LOG('[AIMLAB] START');
    }

    function addMiss() {
      misses++;
      setText(elMiss, misses);
      LOG('[AIMLAB] MISS n=' + misses);
      playError();
    }

    /* ---------------- anti-cheat ---------------- */

    // Every detection ends here: a taunt and a noise, never a lock.
    function onTamper(text) {
      var t = NOW();
      if (t - tamperAt < TAMPER_DEBOUNCE_MS) return;
      tamperAt = t;
      showTaunt(text);
      playError();
    }

    // Two independent clocks and a rolling checksum over the pair. Backgrounding
    // a tab moves both together, so only a doctored clock separates them.
    function clockTick() {
      if (!started || won) return;
      var p = NOW() - startT;
      var w = WALL() - startWall;
      var d = p - w;
      var ad = d < 0 ? -d : d;
      if (ad > clkDrift) clkDrift = ad;
      if (clkLast !== null) {
        var jump = d - clkLast;
        if (jump < 0) jump = -jump;
        if (jump > CLOCK_STEP_MS) clkStep = true;   // a splice steps, honest drift crawls
      }
      clkLast = d;

      // The pair is hashed per frame and rolled into a running checksum. Drift
      // catches one clock being slowed; this catches both being pinned, which
      // leaves the difference at zero and would otherwise look perfect.
      var pair = (((p | 0) ^ ((w | 0) << 1)) >>> 0);
      if (pair === clkPair) {
        if (++clkStill > 45) clkStep = true;        // ~0.75 s of frames, clocks not moving
      } else {
        clkStill = 0;
        clkPair = pair;
      }
      clkSum = (Math.imul(clkSum, 31) + pair) >>> 0;
    }

    function clockIsSuspect() {
      return clkStep || clkDrift > CLOCK_TOLERANCE_MS;
    }

    // The HUD and the overlay are projections. If anything edits them, re-derive
    // from closure state; our own writes are already equal, so this never loops.
    function reproject() {
      var fixed = 0;
      fixed += reassert(elMiss, misses);
      fixed += reassert(elNear, nearMisses);
      if (bestMs !== null) fixed += reassert(elBest, fmt(bestMs));
      if (won) {
        fixed += reassert(elTime, fmt(finalMs));
        fixed += reassert(el('ovTime'), fmt(finalMs));
        fixed += reassert(el('ovMiss'), misses);
        fixed += reassert(el('ovNear'), nearMisses);
        fixed += reassert(el('ovBest'), bestMs === null ? '--' : fmt(bestMs));
      }
      if (fixed > 0) onTamper(TAUNT_TAMPER);
    }

    function reassert(node, v) {
      if (!node) return 0;
      var s = String(v);
      if (node.textContent === s) return 0;
      node.textContent = s;
      return 1;
    }

    function watchDom() {
      if (!OBSERVER) return;
      mo = new OBSERVER(reproject);
      mo.observe(hudEl, { childList: true, subtree: true, characterData: true });
      mo.observe(overlay, { childList: true, subtree: true, characterData: true });
    }

    // Reversible, and it never stops play: the card just gets ruder.
    function enterShame() {
      if (shame !== 1 || won || stopped) return;
      shame = SHAME_MUL;
      setText(shameText, SHAME_TEXT);
      shameBox.classList.remove('hide');
      playError();
    }

    function isToolsKey(e) {
      if (e.key === 'F12') return true;
      var k = (typeof e.key === 'string') ? e.key.toLowerCase() : '';
      if (k !== 'i' && k !== 'j' && k !== 'c') return false;
      if (e.ctrlKey && e.shiftKey) return true;      // Windows and Linux
      if (e.metaKey && e.altKey) return true;        // macOS
      return false;
    }

    /* ---------------- audio ---------------- */

    // Simulation hands its context down; practice builds one on the first miss,
    // which is itself a click and therefore a qualifying gesture.
    function getCtx() {
      if (audio && audio.ctx) return audio.ctx;
      if (callerOwnsAudio) return null;
      if (ownCtx) return ownCtx;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ownCtx = new AC(); } catch (e) { ownCtx = null; }
      return ownCtx;
    }

    // An AudioBufferSourceNode looping the whole buffer is sample-accurate, and
    // the source is uncompressed PCM, so there is no encoder padding to click on.
    // Wired straight to the destination, so the loop plays at full gain.
    function tryStartAudio() {
      if (stopped || won || audioStarted) return;
      if (!audio || !audio.ctx || !audio.buffer) return;
      var ctx = audio.ctx;
      if (ctx.state === 'suspended') {
        armAudioGesture();
        resumeCtx(ctx);
        return;
      }
      audioStarted = true;
      audioSource = ctx.createBufferSource();
      audioSource.buffer = audio.buffer;
      audioSource.loop = true;
      audioSource.connect(ctx.destination);
      audioSource.start(0);
      LOG('[AIMLAB] AUDIO LOOP STARTED');
    }

    function resumeCtx(ctx) {
      var p;
      try { p = ctx.resume(); } catch (e) { return; }
      if (p && p.then) p.then(tryStartAudio, function () { /* stays blocked until a gesture */ });
    }

    function onAudioGesture(e) {
      if (!e.isTrusted || !audio || !audio.ctx) return;
      resumeCtx(audio.ctx);
    }

    function armAudioGesture() {
      if (audioArmed) return;
      audioArmed = true;
      on(window, 'pointerdown', onAudioGesture, true);
    }

    // V2.4: a short synthesized error chord. Two detuned triangles carry the
    // chord, a quiet square adds the 8-bit buzz, everything decays inside 200 ms.
    function playError() {
      if (stopped) return;
      var ctx = getCtx();
      if (!ctx) return;
      if (ctx.state === 'suspended') resumeCtx(ctx);
      if (ctx.state !== 'running') return;
      if (errVoices.length >= ERROR_MAX_VOICES) return;

      var t0 = ctx.currentTime;
      var dur = ERROR_MS / 1000;
      var master = ctx.createGain();
      master.gain.value = ERROR_GAIN;
      master.connect(ctx.destination);

      for (var i = 0; i < ERROR_CHORD.length; i++) {
        var v = ERROR_CHORD[i];
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.type = v.type;
        osc.frequency.value = v.freq;
        if (osc.detune) osc.detune.value = v.detune;
        // exponential ramps cannot touch zero, so the envelope runs between
        // near-silence and the voice level
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(v.gain, t0 + ERROR_ATTACK);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      }

      errVoices.push(master);
      DELAY(function () {
        var at = errVoices.indexOf(master);
        if (at >= 0) errVoices.splice(at, 1);
        try { master.disconnect(); } catch (e) { /* already detached */ }
      }, ERROR_MS + 80);
    }

    function stopAudio() {
      if (!audioSource) return;
      try { audioSource.stop(0); } catch (e) { /* already stopped */ }
      try { audioSource.disconnect(); } catch (e) { /* already detached */ }
      audioSource = null;
    }

    function killErrorVoices() {
      for (var i = 0; i < errVoices.length; i++) {
        try { errVoices[i].disconnect(); } catch (e) { /* already detached */ }
      }
      errVoices.length = 0;
    }

    // Lets the caller hand over the context, or a buffer that finished decoding
    // after the chase had already started.
    function setAudio(a) {
      if (stopped || won) return;
      audio = a || null;
      if (audio) callerOwnsAudio = true;
      tryStartAudio();
    }

    /* ---------------- layout ---------------- */

    function measure() {
      if (won) return;
      vw = window.innerWidth;
      vh = window.innerHeight;

      var cr = card.getBoundingClientRect();
      if (cr.width > 0 && cr.height > 0) {
        cardW = cr.width;
        cardH = cr.height;
        var br = btn.getBoundingClientRect();
        if (br.width > 0) {
          btnOffX = (br.left + br.width / 2) - (cr.left + cr.width / 2);
          btnOffY = (br.top + br.height / 2) - (cr.top + cr.height / 2);
        }
      }
      clampIntoView();
      render();
    }

    function clampIntoView() {
      var hw = cardW / 2, hh = cardH / 2;
      var minX = hw + EDGE_PAD, maxX = vw - hw - EDGE_PAD;
      var minY = hh + EDGE_PAD, maxY = vh - hh - EDGE_PAD;
      // If the viewport is smaller than the card there is no legal band; park it centered.
      x = (maxX > minX) ? Math.min(maxX, Math.max(minX, x)) : vw / 2;
      y = (maxY > minY) ? Math.min(maxY, Math.max(minY, y)) : vh / 2;
    }

    function render() {
      wrap.style.transform =
        'translate3d(' + (x - cardW / 2).toFixed(2) + 'px,' + (y - cardH / 2).toFixed(2) + 'px,0)';
    }

    /* ---------------- pointer ---------------- */

    function setPointer(cx, cy, t) {
      px = cx;
      py = cy;
      var dtc = (t - velT) / 1000;
      if (hasPointer && velT > 0 && dtc >= 0.004) {
        var k = Math.min(1, dtc / 0.05);   // exponential-ish smoothing of raw sample velocity
        cvx += ((px - velX) / dtc - cvx) * k;
        cvy += ((py - velY) / dtc - cvy) * k;
        velX = px; velY = py; velT = t;
      } else if (!hasPointer || velT === 0) {
        velX = px; velY = py; velT = t;
        cvx = 0; cvy = 0;
      }
      hasPointer = true;
    }

    function dropPointer() {
      hasPointer = false;
      cvx = 0; cvy = 0;
      velT = 0;
      nearInside = false;
    }

    on(window, 'pointermove', function (e) {
      startTimer();
      setPointer(e.clientX, e.clientY, NOW());
    }, { passive: true });

    on(window, 'pointerdown', function (e) {
      startTimer();
      setPointer(e.clientX, e.clientY, NOW());
    }, { passive: true, capture: true });

    on(document, 'pointerleave', dropPointer);
    on(window, 'blur', dropPointer);

    on(window, 'touchstart', function (e) {
      var t0 = e.touches[0];
      if (!t0) return;
      startTimer();
      setPointer(t0.clientX, t0.clientY, NOW());
    }, { passive: true });

    on(window, 'touchmove', function (e) {
      var t0 = e.touches[0];
      if (!t0) return;
      startTimer();
      setPointer(t0.clientX, t0.clientY, NOW());
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    on(window, 'touchend', dropPointer, { passive: true });
    on(window, 'touchcancel', dropPointer, { passive: true });

    on(document, 'dragstart', function (e) { e.preventDefault(); });

    /* ---------------- input: press, click, keys ---------------- */

    // A `click` only fires on the button when pointerdown and pointerup share it as an
    // ancestor. A card moving at 2000 px/s would slide out from under a genuine press, so a
    // trusted press that lands on the X latches the card still until the pointer is released.
    on(btn, 'pointerdown', function (e) {
      if (won || !e.isTrusted) return;
      startTimer();
      pressLatch = true;
      pressLatchAt = NOW();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
    });

    function releaseLatch() { pressLatch = false; }
    on(window, 'pointerup', releaseLatch, true);
    on(window, 'pointercancel', releaseLatch, true);

    // tabindex="-1" already keeps the X out of the tab order; this blocks activation for a
    // pointer-focused button as well, so the only way through is a real click.
    on(btn, 'keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        showTaunt(TAUNT_FAKE);
      }
    });

    // V2.6 layer 5, the conservative half: swallow the shortcuts, taunt, move on.
    // Nothing here can stop a player who simply opens the menu instead.
    on(window, 'keydown', function (e) {
      if (won || !isToolsKey(e)) return;
      e.preventDefault();
      onTamper(TAUNT_TOOLS);
      enterShame();
    }, true);

    on(root, 'contextmenu', function (e) {
      if (won) return;
      e.preventDefault();
      onTamper(TAUNT_TOOLS);
    });

    on(window, 'click', function (e) {
      if (won) return;
      startTimer();

      var onX = (e.target === btn) || btn.contains(e.target);
      if (onX) {
        // detail > 0 rules out keyboard activation; isTrusted rules out dispatched events
        if (e.isTrusted === true && e.detail > 0) {
          win();
          return;
        }
        showTaunt(TAUNT_FAKE);
        addMiss();
        return;
      }

      addMiss();
      if (card.contains(e.target)) {
        showTaunt(TAUNTS[Math.floor(rnd() * TAUNTS.length) % TAUNTS.length]);
        burstUntil = NOW() + BURST_MS;
        var s = Math.sqrt(vx * vx + vy * vy);
        if (s > 1) { vx *= BURST_MUL; vy *= BURST_MUL; }
      }
    }, true);

    on(again, 'click', function () { window.location.reload(); });
    on(againX, 'click', function () { window.location.reload(); });
    on(shameOk, 'click', function () { shameBox.classList.add('hide'); });

    on(window, 'resize', measure);

    /* ---------------- physics ---------------- */

    function bounce(nx, ny) {
      // n points back into the playfield; vn is negative because we only call this on impact
      var vn = vx * nx + vy * ny;
      vx -= (1 + RESTITUTION) * vn * nx;
      vy -= (1 + RESTITUTION) * vn * ny;

      var a = (rnd() * 2 - 1) * BOUNCE_JITTER;
      var c = Math.cos(a), s = Math.sin(a);
      var rx = vx * c - vy * s;
      var ry = vx * s + vy * c;
      vx = rx; vy = ry;

      // jitter must never rotate the velocity back into the wall it just left
      var vn2 = vx * nx + vy * ny;
      if (vn2 < 0) { vx -= 2 * vn2 * nx; vy -= 2 * vn2 * ny; }
    }

    function step(dt, now) {
      // a parked cursor should read as approach speed zero within a few frames
      var decay = Math.exp(-dt / 0.06);
      cvx *= decay;
      cvy *= decay;

      if (pressLatch) {
        if (now - pressLatchAt > LATCH_MAX_MS) pressLatch = false;
        else return;
      }

      var hw = cardW / 2, hh = cardH / 2;
      var minX = hw + EDGE_PAD, maxX = vw - hw - EDGE_PAD;
      var minY = hh + EDGE_PAD, maxY = vh - hh - EDGE_PAD;

      // distance from the cursor to the nearest point of the card rect
      var d = Infinity, awx = 0, awy = 0;
      if (hasPointer) {
        var l = x - hw, r = x + hw, t0 = y - hh, b = y + hh;
        var gx = (px < l) ? (l - px) : ((px > r) ? (px - r) : 0);
        var gy = (py < t0) ? (t0 - py) : ((py > b) ? (py - b) : 0);
        d = Math.sqrt(gx * gx + gy * gy);

        var ox = x - px, oy = y - py;
        var ol = Math.sqrt(ox * ox + oy * oy);
        if (ol > 1e-6) { awx = ox / ol; awy = oy / ol; }
        else { awx = Math.cos(heading); awy = Math.sin(heading); }  // cursor dead center
      }

      var prox = (d >= FLEE_RADIUS) ? 0 : (1 - d / FLEE_RADIUS);   // 0 far, 1 touching
      var p2 = prox * prox;
      var burst = (now < burstUntil) ? BURST_MUL : 1;

      wanderT += dt;
      var turn = 1.15 * Math.sin(wanderT * 0.73 + ph1)
               + 0.72 * Math.sin(wanderT * 1.91 + ph2)
               + 0.41 * Math.sin(wanderT * 3.37 + ph3);
      heading += turn * 1.5 * dt;

      var ax = 0, ay = 0;

      if (hasPointer && prox > 0) {
        ax += awx * FLEE_ACCEL * p2;
        ay += awy * FLEE_ACCEL * p2;

        // dodge sideways in proportion to how fast the cursor is closing in
        var approach = cvx * awx + cvy * awy;
        if (approach < 0) approach = 0;
        if (approach > DODGE_APPROACH_CAP) approach = DODGE_APPROACH_CAP;
        if (now - dodgeAt > DODGE_HOLD_MS) {
          dodgeAt = now;
          dodgeSign = (rnd() < 0.5) ? -1 : 1;
        }
        var dodge = dodgeSign * DODGE_GAIN * approach * p2;
        ax += -awy * dodge;
        ay += awx * dodge;
      }

      // Wander steering fades out as the cursor closes in, and is what pulls speed back down
      // to BASE_SPEED once the cursor is outside the flee radius.
      var wW = 1 - prox;
      if (wW > 0) {
        var tv = BASE_SPEED * burst * shame;
        ax += (Math.cos(heading) * tv - vx) * WANDER_GAIN * wW;
        ay += (Math.sin(heading) * tv - vy) * WANDER_GAIN * wW;
      }

      // cursor sitting on top of the card: one short shove, then normal flee
      if (hasPointer && d === 0) {
        if (!overlapping) {
          overlapping = true;
          panicUntil = now + PANIC_MS;
          var s0 = Math.sqrt(vx * vx + vy * vy);
          var s1 = Math.max(s0, PANIC_SPEED);
          vx = awx * s1;
          vy = awy * s1;
        }
        if (now < panicUntil) {
          ax += awx * PANIC_ACCEL;
          ay += awy * PANIC_ACCEL;
        }
      } else {
        overlapping = false;
      }

      vx += ax * dt;
      vy += ay * dt;

      // shame mode raises the soft cap only; the hard ceiling still bounds the
      // per-frame step, which is what keeps containment provable.
      var cap = Math.min(SPEED_CAP_HARD, (SPEED_CAP_FAR + SPEED_CAP_NEAR_ADD * prox) * burst * shame);
      var sp = Math.sqrt(vx * vx + vy * vy);
      if (sp > cap && sp > 0) {
        var k = cap / sp;
        vx *= k;
        vy *= k;
      }

      x += vx * dt;
      y += vy * dt;

      // Walls: clamp to the legal band, then reflect only the component heading into it.
      if (maxX > minX) {
        if (x < minX)      { x = minX; if (vx < 0) bounce(1, 0); }
        else if (x > maxX) { x = maxX; if (vx > 0) bounce(-1, 0); }
      } else {
        x = vw / 2; vx = 0;
      }

      if (maxY > minY) {
        if (y < minY)      { y = minY; if (vy < 0) bounce(0, 1); }
        else if (y > maxY) { y = maxY; if (vy > 0) bounce(0, -1); }
      } else {
        y = vh / 2; vy = 0;
      }

      if (!isFinite(x) || !isFinite(y) || !isFinite(vx) || !isFinite(vy)) {
        x = vw / 2; y = vh / 2; vx = 0; vy = 0;
        clampIntoView();
      }

      // near miss: pointer entering the ring around the close button's center
      if (hasPointer) {
        var bx = x + btnOffX, by = y + btnOffY;
        var ndx = px - bx, ndy = py - by;
        var inZone = (ndx * ndx + ndy * ndy) <= NEAR_RADIUS * NEAR_RADIUS;
        if (inZone && !nearInside && (now - nearAt) >= NEAR_DEBOUNCE) {
          nearMisses++;
          nearAt = now;
          setText(elNear, nearMisses);
        }
        nearInside = inZone;
      } else {
        nearInside = false;
      }
    }

    function frame(t) {
      if (stopped) return;
      rafId = RAF(frame);

      var dt = (t - lastT) / 1000;
      lastT = t;
      if (!(dt > 0)) dt = 1 / 60;
      if (dt > DT_MAX) dt = DT_MAX;

      step(dt, t);
      render();
      clockTick();

      if (started) setText(elTime, fmt(t - startT));
    }

    /* ---------------- win ---------------- */

    function win() {
      if (won) return;
      if (!started) startTimer();
      won = true;
      // every published number is read straight out of the closure (V2.6 layer 7)
      finalMs = Math.round(NOW() - startT);

      CAF(rafId);
      pressLatch = false;
      UNDELAY(tauntTimer);
      taunt.classList.remove('on');
      card.classList.add('gone');
      stopAudio();

      var cheated = clockIsSuspect();

      if (cheated) {
        LOG('[AIMLAB] CHEAT kind=clock');
        playError();
      } else {
        LOG('[AIMLAB] WIN time_ms=' + finalMs +
            ' misses=' + misses +
            ' near_misses=' + nearMisses);
      }

      setText(elTime, fmt(finalMs));

      var isBest = false;
      if (!cheated && RECORD_BEST) {
        isBest = (bestMs === null || finalMs < bestMs);
        if (isBest) {
          bestMs = finalMs;
          writeBest(finalMs);
        }
      }
      showBest();

      setText(el('ovTime'), fmt(finalMs));
      setText(el('ovMiss'), misses);
      setText(el('ovNear'), nearMisses);
      setText(el('ovBest'), bestMs === null ? '--' : fmt(bestMs));
      setText(el('ovNote'), isBest ? 'New best time.' : (RECORD_BEST ? '' : 'Seam run. Not recorded.'));

      if (cheated) {
        setText(ovTitle, 'eMoney.exe - Cheat detected');
        ovWin.classList.add('hide');
        ovCheat.classList.remove('hide');
      }

      winTimer = DELAY(function () {
        overlay.classList.add('show');
        var focusTarget = cheated ? againX : again;
        if (focusTarget && focusTarget.focus) focusTarget.focus();
      }, 300);

      if (typeof opts.onWin === 'function') {
        try {
          opts.onWin({
            timeMs: finalMs,
            misses: misses,
            nearMisses: nearMisses,
            bestMs: bestMs,
            isBest: isBest,
            cheated: cheated,
            clockSum: clkSum
          });
        } catch (e) { /* a caller's handler must not break the engine */ }
      }
    }

    /* ---------------- teardown ---------------- */

    function stop() {
      if (stopped) return;
      stopped = true;
      CAF(rafId);
      UNDELAY(tauntTimer);
      UNDELAY(winTimer);
      stopAudio();
      killErrorVoices();
      if (mo) { mo.disconnect(); mo = null; }
      if (ownCtx) {
        try { ownCtx.close(); } catch (e) { /* already closed */ }
        ownCtx = null;
      }
      offAll();
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    /* ---------------- boot ---------------- */

    showBest();
    measure();
    on(window, 'load', measure);
    on(img, 'load', measure);
    watchDom();

    if (storeCorrupt) DELAY(function () { showTaunt(TAUNT_STORE); }, 600);

    tryStartAudio();

    lastT = NOW();
    rafId = RAF(frame);

    return Object.freeze({ stop: stop, setAudio: setAudio });
  }

  // frozen so the module itself cannot be swapped out from the console
  W.AimlabChase = Object.freeze({ start: start });
})();
