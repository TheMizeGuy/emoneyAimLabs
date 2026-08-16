/* eMoney Aim Labs -- Simulation stage (Flappy-style mechanics replica).
 *
 * Mechanics homage, not an asset copy: every pixel here is drawn procedurally
 * with canvas primitives. No sprites, no external images, no fonts, no audio,
 * no network access. The only global it defines is window.AimlabFlappy.
 *
 * Public API:
 *   var handle = window.AimlabFlappy.start(container, {
 *     targetScore: 10,
 *     speedScale: 1,        // V4.0: Impossible runs the whole game at 1.2x
 *     title: 'SIMULATION',  // V4.0: the get-ready card names the mode
 *     onComplete: function () {}
 *   });
 *   handle.stop();
 *
 * Console contract:
 *   [AIMLAB] FLAPPY SCORE n=<int>
 *   [AIMLAB] FLAPPY DEATH score=<int>
 *   [AIMLAB] FLAPPY DONE
 *
 * V2.7 anti-cheat, this module's share of it:
 *   C. the score is three copies in three closures behind one accessor with a
 *      rolling checksum, cross-checked against the physics counter every step.
 *      A divergence taints the run and the chase that follows opens with the
 *      CHEAT DETECTED dialog instead of a timer.
 *   F. inter-flap intervals roll in a twelve-wide window that survives deaths;
 *      a coefficient of variation under five percent is a metronome, not a
 *      person. Costs a sus point and a line of text, never a life.
 * Both counts ride to the chase engine through onComplete(info).
 */
(function () {
  'use strict';

  /* Captured at parse time, same doctrine as the chase engine: patching
     console.log or performance.now later reaches nothing this file holds. */
  var WF = window;
  var LOGF = (WF.console && WF.console.log) ? WF.console.log.bind(WF.console) : function () {};
  var NOWF = (WF.performance && WF.performance.now)
    ? WF.performance.now.bind(WF.performance)
    : Date.now.bind(Date);
  var WARNF = (WF.console && WF.console.warn) ? WF.console.warn.bind(WF.console) : LOGF;

  /* ---- PHYSICS CORE START ----
   * Everything between these markers is pure logic with no DOM dependency, so
   * it can be sliced out verbatim and driven headlessly by a Node harness.
   */
  var W = 288;
  var H = 512;
  var GROUND_H = 64;
  var FLOOR = H - GROUND_H;          /* 448 -- ground contact line */
  var GRAVITY = 1350;                /* px/s^2 */
  var FLAP_V = -380;                 /* px/s, assigned (not added) on flap */
  var MAX_FALL = 450;                /* px/s terminal fall */
  var BIRD_X = 80;                   /* 27.8% of 288 */
  var BIRD_HW = 11;                  /* collision half-width */
  var BIRD_HH = 8;                   /* collision half-height */
  var BIRD_START_Y = 190;
  var PIPE_W = 52;
  var PIPE_GAP = 115;
  var PIPE_SPACING = 172;            /* 1.433 s between pairs at 120 px/s */
  var SCROLL_SPEED = 120;            /* px/s */
  var FIRST_PIPE_X = 288;            /* enters at the right edge on run start */
  var GAP_MIN_CENTER = 108;          /* gap top >= 50.5 px below the ceiling */
  var GAP_MAX_CENTER = 330;          /* gap bottom <= 60.5 px above the ground */
  var DEATH_BOUNCE = -150;           /* small pop when a pipe is clipped */

  function makeWorld(rand) {
    return {
      rand: rand,
      y: BIRD_START_Y,
      vy: 0,
      alive: true,
      score: 0,
      scrollX: 0,
      spawned: 0,
      pipes: [],
      time: 0,
      scoredThisStep: 0,
      diedThisStep: false,
      groundedThisStep: false
    };
  }

  function worldFlap(w) {
    if (!w.alive) { return false; }
    w.vy = FLAP_V;
    return true;
  }

  function worldStep(w, dt) {
    w.scoredThisStep = 0;
    w.diedThisStep = false;
    w.groundedThisStep = false;
    w.time += dt;

    if (!w.alive) {
      /* Corpse keeps falling until it rests on the ground, as in the classic. */
      w.vy = Math.min(MAX_FALL, w.vy + GRAVITY * dt);
      w.y += w.vy * dt;
      if (w.y + BIRD_HH >= FLOOR) {
        w.y = FLOOR - BIRD_HH;
        w.vy = 0;
        w.groundedThisStep = true;
      }
      return;
    }

    w.scrollX += SCROLL_SPEED * dt;

    while (FIRST_PIPE_X + w.spawned * PIPE_SPACING - w.scrollX <= W + 1) {
      w.pipes.push({
        wx: FIRST_PIPE_X + w.spawned * PIPE_SPACING,
        gapY: GAP_MIN_CENTER + w.rand() * (GAP_MAX_CENTER - GAP_MIN_CENTER),
        scored: false
      });
      w.spawned++;
    }

    w.vy = Math.min(MAX_FALL, w.vy + GRAVITY * dt);
    w.y += w.vy * dt;

    /* Ceiling clamps instead of killing -- matches the original. */
    if (w.y - BIRD_HH < 0) {
      w.y = BIRD_HH;
      if (w.vy < 0) { w.vy = 0; }
    }

    var birdTop = w.y - BIRD_HH;
    var birdBottom = w.y + BIRD_HH;
    var birdLeft = BIRD_X - BIRD_HW;
    var birdRight = BIRD_X + BIRD_HW;
    var hit = false;
    var i, p, sx;

    for (i = 0; i < w.pipes.length; i++) {
      p = w.pipes[i];
      sx = p.wx - w.scrollX;

      if (!p.scored && BIRD_X > sx + PIPE_W) {
        p.scored = true;
        w.score++;
        w.scoredThisStep++;
      }

      if (birdRight > sx && birdLeft < sx + PIPE_W) {
        if (birdTop < p.gapY - PIPE_GAP / 2 || birdBottom > p.gapY + PIPE_GAP / 2) {
          hit = true;
        }
      }
    }

    while (w.pipes.length > 0 && w.pipes[0].wx - w.scrollX + PIPE_W < -24) {
      w.pipes.shift();
    }

    if (birdBottom >= FLOOR) {
      w.y = FLOOR - BIRD_HH;
      w.vy = 0;
      w.alive = false;
      w.diedThisStep = true;
      w.groundedThisStep = true;
      return;
    }

    if (hit) {
      w.alive = false;
      w.diedThisStep = true;
      w.vy = Math.min(w.vy, DEATH_BOUNCE);
    }
  }

  /* Index of the pair the bird is still working on, or -1. */
  function worldNextPipe(w) {
    for (var i = 0; i < w.pipes.length; i++) {
      if (w.pipes[i].wx - w.scrollX + PIPE_W >= BIRD_X - BIRD_HW) { return i; }
    }
    return -1;
  }
  /* ---- PHYSICS CORE END ---- */

  var CAP_H = 20;
  var CAP_OVERHANG = 4;
  var FONT_STACK = '"Trebuchet MS", "Arial Black", Verdana, system-ui, sans-serif';
  var DEAD_RETRY_DELAY = 0.45;       /* seconds before a retry tap is accepted */
  var READY_INPUT_LOCK = 0.25;       /* swallows the tail of the retry tap */
  var VICTORY_BEAT = 0.6;            /* seconds frozen before onComplete fires */

  var sessionBest = 0;               /* best across runs in this page session */

  /* V2.7 layer F. Both of the original numbers made this detector unreachable
   * against the only thing it exists to catch:
   *   - 20 intervals meant 21 flaps in ONE run, and the buffer was cleared on
   *     every death. A rigid metronome cannot thread a 115 px gap and dies in
   *     about five flaps, so it never accumulated enough to be judged at all.
   *   - a 0.02 CV threshold sits BELOW the noise floor of the medium: one frame
   *     of jitter at 60 Hz on a half-second cadence is already 2.9 % CV, so any
   *     bot driving from a frame callback passed by construction.
   * The window is now short, rolls across deaths (intervals that span a death
   * are skipped, not counted), and the threshold sits between a frame-quantised
   * bot (~3 %) and the least variable plausible human (10 %+). */
  /* F6. The old threshold (CV < 5%, 12 intervals, population SD, latching across
   * deaths) sat INSIDE the human range: isochronous finger tapping is 3-6%, and
   * a run measured at 4.6% was flagged -- in a game whose evenly spaced pipes
   * actively teach that rhythm. Under the V3.4b absolute gate one steady stretch
   * of twelve taps then silently voided the player's whole simulation score.
   * Now: a longer window, sample SD, a CV no hand reaches, and an independent
   * absolute-spread condition. A human tapping near 300 ms at even 3% CV spreads
   * ~30 ms across twenty taps; a timer spreads two or three. */
  var CADENCE_MIN_INTERVALS = 20;    /* rolling window, not a whole-run total */
  var CADENCE_CV = 0.015;            /* below this a human is not driving */
  var CADENCE_SPREAD_MS = 12;        /* ...and the raw max-min must be this tight too */
  var CADENCE_MIN_GAP = 30;          /* ms; below this it is one tap counted twice */
  var NOTE_SECONDS = 3;              /* how long a detection stays on the canvas */

  /* ---- triple-shadow score (V2.7 layer C) ----
   * Three copies in three closures, a MAC per value keyed on a per-run nonce,
   * and a rolling checksum over every mutation. world.score stays the physics
   * counter; the two are compared on every scoring step, so editing either the
   * shadow or the counter shows up as a disagreement.
   */
  var shNonce = ((Math.imul(Date.now() >>> 0, 2246822519) ^ 0x9e3779b9) >>> 0);
  var shChain = shNonce;

  function shMac(key, v, seq) {
    var s = key + '|' + v + '|' + seq + '|' + shNonce;
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  function shCell(v0) {
    var v = v0;
    return { r: function () { return v; }, w: function (n) { v = n; } };
  }

  function newShadow(key, v0, onDiverge) {
    var a = shCell(v0), b = shCell(v0), c = shCell(v0);
    var seq = 0;
    var mac = shMac(key, v0, 0);
    return {
      get: function () {
        var va = a.r();
        if (va !== b.r() || va !== c.r() || shMac(key, va, seq) !== mac) { onDiverge(); }
        return va;
      },
      set: function (n) {
        seq++;
        a.w(n); b.w(n); c.w(n);
        mac = shMac(key, n, seq);
        shChain = (Math.imul(shChain, 33) ^ mac) >>> 0;
      }
    };
  }

  /* Deterministic decor so the skyline is stable between runs. */
  function decorRand(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  var SKYLINE = (function () {
    var r = decorRand(20260815);
    var out = [];
    var x = -6;
    while (x < W + 6) {
      var bw = 16 + Math.floor(r() * 22);
      var bh = 26 + Math.floor(r() * 62);
      var wins = [];
      var wy = 6;
      while (wy < bh - 6) {
        var wx = 4;
        while (wx < bw - 5) {
          if (r() > 0.55) { wins.push(wx, wy); }
          wx += 7;
        }
        wy += 9;
      }
      out.push({ x: x, w: bw, h: bh, wins: wins });
      x += bw + 3 + Math.floor(r() * 7);
    }
    return out;
  })();

  var SKYLINE_SPAN = (function () {
    var last = SKYLINE[SKYLINE.length - 1];
    return last.x + last.w + 8;
  })();

  var CLOUDS = [
    { x: 30, y: 88, r: 17 },
    { x: 132, y: 126, r: 13 },
    { x: 226, y: 74, r: 20 },
    { x: 300, y: 140, r: 15 }
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function rrect(ctx, x, y, w, h, r) {
    var rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }

  function label(ctx, str, x, y, size, fill, strokeW, stroke, align) {
    ctx.font = 'bold ' + size + 'px ' + FONT_STACK;
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    if (strokeW > 0) {
      ctx.lineWidth = strokeW;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(str, x, y);
  }

  function drawSky(ctx, cache) {
    if (!cache.sky) {
      var g = ctx.createLinearGradient(0, 0, 0, FLOOR);
      g.addColorStop(0, '#101d33');
      g.addColorStop(0.42, '#1f4a6d');
      g.addColorStop(0.78, '#3f88a2');
      g.addColorStop(1, '#87c3b8');
      cache.sky = g;
    }
    ctx.fillStyle = cache.sky;
    ctx.fillRect(0, 0, W, FLOOR);
  }

  function drawClouds(ctx, scroll) {
    var off = (scroll * 0.14) % 360;
    ctx.fillStyle = 'rgba(233, 243, 248, 0.16)';
    for (var pass = 0; pass < 2; pass++) {
      var base = pass * 360 - off;
      for (var i = 0; i < CLOUDS.length; i++) {
        var c = CLOUDS[i];
        var cx = base + c.x;
        if (cx < -70 || cx > W + 70) { continue; }
        ctx.beginPath();
        ctx.arc(cx, c.y, c.r, 0, Math.PI * 2);
        ctx.arc(cx + c.r * 0.9, c.y + 4, c.r * 0.72, 0, Math.PI * 2);
        ctx.arc(cx - c.r * 0.95, c.y + 5, c.r * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawSkyline(ctx, scroll) {
    var off = (scroll * 0.22) % SKYLINE_SPAN;
    for (var pass = 0; pass < 2; pass++) {
      var base = pass * SKYLINE_SPAN - off;
      for (var i = 0; i < SKYLINE.length; i++) {
        var b = SKYLINE[i];
        var bx = base + b.x;
        if (bx > W + 4 || bx + b.w < -4) { continue; }
        ctx.fillStyle = '#152f47';
        ctx.fillRect(bx, FLOOR - b.h, b.w, b.h);
        ctx.fillStyle = 'rgba(246, 205, 122, 0.42)';
        for (var k = 0; k < b.wins.length; k += 2) {
          ctx.fillRect(bx + b.wins[k], FLOOR - b.h + b.wins[k + 1], 2, 3);
        }
      }
    }
  }

  function drawHills(ctx, scroll) {
    var off = (scroll * 0.45) % 96;
    ctx.fillStyle = '#1d4f5c';
    ctx.beginPath();
    ctx.moveTo(-8, FLOOR);
    for (var x = -8; x <= W + 8; x += 8) {
      var t = (x + off) / 96 * Math.PI * 2;
      ctx.lineTo(x, FLOOR - 20 - Math.sin(t) * 9 - Math.sin(t * 0.5) * 5);
    }
    ctx.lineTo(W + 8, FLOOR);
    ctx.closePath();
    ctx.fill();
  }

  function drawPipePair(ctx, sx, gapY) {
    var gapTop = gapY - PIPE_GAP / 2;
    var gapBot = gapY + PIPE_GAP / 2;
    drawPipeShaft(ctx, sx, 0, gapTop - CAP_H);
    drawPipeCap(ctx, sx, gapTop - CAP_H);
    drawPipeShaft(ctx, sx, gapBot + CAP_H, FLOOR - (gapBot + CAP_H));
    drawPipeCap(ctx, sx, gapBot);
  }

  function pipeGradient(ctx, x, w) {
    var g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#15532f');
    g.addColorStop(0.1, '#5fc98d');
    g.addColorStop(0.38, '#2f8f5b');
    g.addColorStop(0.72, '#22713f');
    g.addColorStop(1, '#0f3d22');
    return g;
  }

  function drawPipeShaft(ctx, x, y, h) {
    if (h <= 0) { return; }
    ctx.fillStyle = pipeGradient(ctx, x, PIPE_W);
    ctx.fillRect(x, y, PIPE_W, h);
    ctx.fillStyle = 'rgba(9, 34, 19, 0.55)';
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + PIPE_W - 1, y, 1, h);
  }

  function drawPipeCap(ctx, x, y) {
    var cx = x - CAP_OVERHANG;
    var cw = PIPE_W + CAP_OVERHANG * 2;
    ctx.fillStyle = pipeGradient(ctx, cx, cw);
    ctx.fillRect(cx, y, cw, CAP_H);
    ctx.fillStyle = 'rgba(9, 34, 19, 0.6)';
    ctx.fillRect(cx, y, cw, 1);
    ctx.fillRect(cx, y + CAP_H - 1, cw, 1);
    ctx.fillRect(cx, y, 1, CAP_H);
    ctx.fillRect(cx + cw - 1, y, 1, CAP_H);
    ctx.fillStyle = 'rgba(190, 245, 210, 0.22)';
    ctx.fillRect(cx + 3, y + 3, 4, CAP_H - 6);
  }

  function drawGround(ctx, scroll) {
    ctx.fillStyle = '#5a4a30';
    ctx.fillRect(0, FLOOR, W, GROUND_H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, FLOOR, W, 13);
    ctx.clip();
    ctx.fillStyle = '#88ab48';
    ctx.fillRect(0, FLOOR, W, 13);
    ctx.fillStyle = '#6d8e36';
    var o = scroll % 26;
    for (var x = -26; x < W + 26; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x - o, FLOOR + 13);
      ctx.lineTo(x - o + 13, FLOOR);
      ctx.lineTo(x - o + 26, FLOOR);
      ctx.lineTo(x - o + 13, FLOOR + 13);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle = '#c9dd85';
    ctx.fillRect(0, FLOOR, W, 2);
    ctx.fillStyle = '#3d3120';
    ctx.fillRect(0, FLOOR + 13, W, 3);

    ctx.fillStyle = 'rgba(28, 22, 13, 0.35)';
    var d = (scroll * 0.85) % 18;
    for (var i = -18; i < W + 18; i += 18) {
      ctx.fillRect(i - d, FLOOR + 24, 9, 2);
      ctx.fillRect(i - d + 9, FLOOR + 40, 6, 2);
    }
  }

  function drawBird(ctx, x, y, tilt, wing) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);

    ctx.fillStyle = 'rgba(8, 14, 22, 0.28)';
    ctx.beginPath();
    ctx.ellipse(1, 2, 14, 10.5, 0, 0, Math.PI * 2);
    ctx.fill();

    var body = ctx.createLinearGradient(0, -11, 0, 11);
    body.addColorStop(0, '#ffe08a');
    body.addColorStop(0.5, '#f8c44a');
    body.addColorStop(1, '#d8862a');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 13.5, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#3a2411';
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 246, 214, 0.7)';
    ctx.beginPath();
    ctx.ellipse(-0.5, 6, 7, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    var wingLift = Math.sin(wing) * 5;
    ctx.save();
    ctx.translate(-3.5, 0.5);
    ctx.rotate(Math.sin(wing) * 0.55);
    ctx.fillStyle = '#f6e2ad';
    ctx.beginPath();
    ctx.ellipse(0, wingLift * 0.2, 6.4, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = '#3a2411';
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#fdfdfd';
    ctx.beginPath();
    ctx.arc(6, -3.5, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#3a2411';
    ctx.stroke();
    ctx.fillStyle = '#241708';
    ctx.beginPath();
    ctx.arc(7.4, -3.5, 1.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff9c3d';
    ctx.beginPath();
    ctx.moveTo(11, 0.5);
    ctx.lineTo(19.5, 3);
    ctx.lineTo(11, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#7a3d0d';
    ctx.stroke();
    ctx.fillStyle = '#e07a22';
    ctx.beginPath();
    ctx.moveTo(11, 3.4);
    ctx.lineTo(17.4, 4.2);
    ctx.lineTo(11, 5.5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawVignette(ctx, alpha) {
    ctx.fillStyle = 'rgba(6, 9, 14, ' + alpha + ')';
    ctx.fillRect(0, 0, W, H);
  }

  function drawCard(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(9, 13, 20, 0.93)';
    rrect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f2c14e';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(242, 193, 78, 0.25)';
    rrect(ctx, x + 4, y + 4, w - 8, h - 8, 7);
    ctx.stroke();
  }

  function start(container, opts) {
    opts = opts || {};

    if (!container || typeof container.appendChild !== 'function') {
      WARNF('[AIMLAB] FLAPPY start called without a container element');
      return Object.freeze({ stop: function () {} });
    }

    var targetScore = typeof opts.targetScore === 'number' && opts.targetScore > 0
      ? Math.floor(opts.targetScore) : 10;
    var onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : null;
    /* V3.2: optional, additive. Fires once per death so the shell can report the
       flappy-fail counter. Guarded exactly like onComplete -- a throwing caller
       must never wedge the loop. */
    var onDeath = typeof opts.onDeath === 'function' ? opts.onDeath : null;
    /* V4.0: one uniform time scale over the simulation -- scroll, gravity and
     * flap response all speed up together, so the game FEELS identical, just
     * quicker. Clamped: below 1 would make the gauntlet easier than the server
     * assumes when it times the phase, and past 2 it is not a game. */
    var speedScale = (typeof opts.speedScale === 'number' && isFinite(opts.speedScale))
      ? Math.min(2, Math.max(1, opts.speedScale)) : 1;
    var title = (typeof opts.title === 'string' && opts.title)
      ? opts.title.toUpperCase() : 'SIMULATION';

    var doc = container.ownerDocument || document;
    var win = doc.defaultView || window;

    /* One game per container. A second start() used to leave the first running
     * with no handle to stop it: two rAF loops, two keydown listeners and two
     * canvases stacked on the same node. */
    if (container.getAttribute('data-aimlab-flappy') === 'live') {
      WARNF('[AIMLAB] FLAPPY already running in this container');
      return { stop: function () {} };
    }
    container.setAttribute('data-aimlab-flappy', 'live');

    var prevPosition = container.style.position;
    var computed = win.getComputedStyle ? win.getComputedStyle(container) : null;
    if (!computed || computed.position === 'static') {
      container.style.position = 'relative';
    }

    var wrap = doc.createElement('div');
    wrap.setAttribute('data-aimlab', 'flappy');
    wrap.style.cssText = [
      'position:absolute',
      'left:0', 'top:0', 'right:0', 'bottom:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:#080a0f',
      'overflow:hidden',
      'cursor:pointer',
      'touch-action:none',
      '-webkit-user-select:none',
      'user-select:none',
      '-webkit-tap-highlight-color:transparent'
    ].join(';') + ';';

    var canvas = doc.createElement('canvas');
    canvas.style.cssText = 'display:block;image-rendering:pixelated;';
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    var ctx = canvas.getContext('2d');
    var cache = {};

    var view = {
      scroll: 0,
      tilt: 0,
      tiltHold: 0,
      wing: 0,
      flash: 0,
      bob: 0,
      cardIn: 0
    };

    var world = makeWorld(Math.random);
    var state = 'getready';          /* getready | playing | dead | complete */
    var stateAt = 0;                 /* seconds, module clock */
    var clock = 0;
    var completeFired = false;
    var stopped = false;
    var rafId = 0;
    var lastTs = 0;
    var ro = null;

    /* V2.7 layers C and F. susN and tainted are per session and ride to the
     * chase engine. The interval window and the verdict are per session too:
     * whatever is driving the input does not become a different thing because
     * the bird hit a pipe. */
    var shScore = newShadow('score', 0, onDiverge);
    var tainted = false;
    var susN = 0;
    var intervals = [];          /* rolling, survives deaths */
    var lastFlapT = 0;           /* 0 = no interval may start here (fresh run) */
    var cadenceFlagged = false;
    var noteText = '';
    var noteUntil = -1;

    function log(msg) { LOGF(msg); }

    function sus(reason) {
      susN++;
      log('[AIMLAB] SUS n=' + susN + ' reason=' + reason);
    }

    function note(text) {
      noteText = text;
      noteUntil = clock + NOTE_SECONDS;
    }

    /* The score disagreeing with itself is hard evidence, so unlike everything
     * else in this file it is not a sus point -- it voids the run that follows. */
    function onDiverge() {
      if (tainted) { return; }
      tainted = true;
      log('[AIMLAB] CHEAT kind=state');
      note('SCORE STATE MISMATCH');
    }

    /* Two independent conditions, both of which a timer meets and neither of
     * which a hand does. It never blocks, resets or costs a life. */
    function cadenceCheck() {
      if (cadenceFlagged) { return; }
      var n = intervals.length;
      if (n < CADENCE_MIN_INTERVALS) { return; }
      var i, d, sum = 0, lo = intervals[0], hi = intervals[0];
      for (i = 0; i < n; i++) {
        sum += intervals[i];
        if (intervals[i] < lo) { lo = intervals[i]; }
        if (intervals[i] > hi) { hi = intervals[i]; }
      }
      var mean = sum / n;
      if (!(mean > 0)) { return; }
      /* Absolute spread, independent of the mean: no rounding of a human's
       * timing lands twenty taps inside a twelve-millisecond band. */
      if (hi - lo >= CADENCE_SPREAD_MS) { return; }
      var vsum = 0;
      for (i = 0; i < n; i++) {
        d = intervals[i] - mean;
        vsum += d * d;
      }
      /* Sample standard deviation: dividing by n under-estimates the spread of
       * a sample and biased the old test further toward firing. */
      if (Math.sqrt(vsum / (n - 1)) / mean >= CADENCE_CV) { return; }
      cadenceFlagged = true;
      sus('cadence');
      note('METRONOME DETECTED');
    }

    function setState(next) {
      state = next;
      stateAt = clock;
    }

    function layout() {
      var cw = container.clientWidth || win.innerWidth || W;
      var ch = container.clientHeight || win.innerHeight || H;
      var dpr = clamp(win.devicePixelRatio || 1, 1, 3);
      var raw = Math.min(cw / W, ch / H);
      if (!(raw > 0)) { raw = 1; }

      /* Device pixels per logical pixel; snap to an integer when the space
       * lost by snapping is small, so the art stays crisp. */
      var device = raw * dpr;
      var snapped = Math.floor(device);
      if (snapped >= 1 && snapped / device >= 0.85) { device = snapped; }

      canvas.width = Math.round(W * device);
      canvas.height = Math.round(H * device);
      canvas.style.width = (canvas.width / dpr) + 'px';
      canvas.style.height = (canvas.height / dpr) + 'px';
      /* One uniform scale for both axes so rounding the backing store never
       * stretches the art; any leftover half-pixel becomes a centred margin. */
      var s = Math.min(canvas.width / W, canvas.height / H);
      ctx.setTransform(s, 0, 0, s, (canvas.width - W * s) / 2, (canvas.height - H * s) / 2);
      cache.sky = null;
    }

    function resetRun() {
      world = makeWorld(Math.random);
      shScore = newShadow('score', 0, onDiverge);
      /* F6. Intervals used to survive a death, so a whole session could be read
       * as one rhythm and any twenty steady taps anywhere in it condemned the
       * run. A death is a genuine break in the input; the window starts again. */
      intervals.length = 0;
      lastFlapT = 0;
      view.tilt = 0;
      view.tiltHold = 0;
      view.flash = 0;
      view.cardIn = 0;
      setState('getready');
    }

    function beginRun() {
      setState('playing');
      view.bob = 0;
      world.y = BIRD_START_Y;
      world.vy = 0;
      flap();
    }

    function flap() {
      if (worldFlap(world)) {
        view.tilt = -0.42;
        view.tiltHold = 0.13;
        view.wing = 0;
        if (state === 'playing') {
          var ft = NOWF();
          /* A touchscreen delivers pointerdown AND touchstart for one physical
           * tap, and worldFlap accepts both, so the pair used to land a ~0 ms
           * interval in the buffer and wreck the statistic. Nothing human or
           * mechanical flaps twice inside CADENCE_MIN_GAP; below it, the second
           * event is the same tap arriving twice. */
          if (lastFlapT > 0 && (ft - lastFlapT) >= CADENCE_MIN_GAP) {
            intervals.push(ft - lastFlapT);
            if (intervals.length > CADENCE_MIN_INTERVALS) { intervals.shift(); }
            lastFlapT = ft;
            cadenceCheck();
          } else if (lastFlapT <= 0) {
            lastFlapT = ft;
          }
        }
      }
    }

    function onInput() {
      if (stopped) { return; }
      if (state === 'getready') {
        if (clock - stateAt < READY_INPUT_LOCK) { return; }
        beginRun();
      } else if (state === 'playing') {
        flap();
      } else if (state === 'dead') {
        if (clock - stateAt >= DEAD_RETRY_DELAY) { resetRun(); }
      }
      /* 'complete' swallows input while the victory beat plays. */
    }

    function rejectSyntheticInput(e) {
      if (e && e.isTrusted === true) { return false; }
      sus('synthetic-input');
      note('SYNTHETIC INPUT BLOCKED');
      return true;
    }

    function onPointerDown(e) {
      if (rejectSyntheticInput(e)) { return; }
      if (e.cancelable) { e.preventDefault(); }
      onInput();
    }

    function onTouchStart(e) {
      if (rejectSyntheticInput(e)) { return; }
      if (e.cancelable) { e.preventDefault(); }
      onInput();
    }

    function onKeyDown(e) {
      if (e.repeat) { return; }
      if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) {
        if (rejectSyntheticInput(e)) { return; }
        e.preventDefault();
        onInput();
      }
    }

    function onResize() { layout(); }

    /* A flap sets velocity rather than adding to it, so a pointerdown and a
     * touchstart raised by the same physical tap produce one identical result. */
    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('touchstart', onTouchStart, { passive: false });
    doc.addEventListener('keydown', onKeyDown);
    win.addEventListener('resize', onResize);
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(onResize);
      ro.observe(container);
    }

    function advance(dt) {
      dt *= speedScale;      // V4.0: everything downstream runs on scaled time
      clock += dt;
      view.tiltHold = Math.max(0, view.tiltHold - dt);

      if (state === 'getready') {
        view.scroll += SCROLL_SPEED * dt;
        view.bob += dt;
        world.y = BIRD_START_Y + Math.sin(view.bob * 4.4) * 7;
        world.vy = 0;
        view.tilt += (0 - view.tilt) * Math.min(1, dt * 10);
        view.wing += dt * 9;
        return;
      }

      if (state === 'playing') {
        view.scroll += SCROLL_SPEED * dt;
        worldStep(world, dt);

        var n = world.scoredThisStep;
        while (n > 0) {
          shScore.set(shScore.get() + 1);
          log('[AIMLAB] FLAPPY SCORE n=' + shScore.get());
          n--;
        }
        /* The shadow is what the game plays by; the physics counter is only its
         * witness. Editing world.score to skip ahead therefore does not skip
         * ahead, it just gets noticed. */
        if (shScore.get() !== world.score) { onDiverge(); }

        /* Death is tested first. A pipe stays lethal for ~11 px after it
         * becomes scorable, so clipping the tenth pair's cap on the frame it
         * clears your nose used to complete the gauntlet and discard the death.
         * Classic rules: the death wins the tie. */
        if (world.diedThisStep) {
          log('[AIMLAB] FLAPPY DEATH score=' + shScore.get());
          if (shScore.get() > sessionBest) { sessionBest = shScore.get(); }
          view.flash = 1;
          setState('dead');
          if (onDeath) {
            try { onDeath(shScore.get()); }
            catch (e) { WARNF('[AIMLAB] FLAPPY onDeath threw: ' + (e && e.message)); }
          }
        } else if (shScore.get() >= targetScore) {
          log('[AIMLAB] FLAPPY DONE');
          if (shScore.get() > sessionBest) { sessionBest = shScore.get(); }
          view.flash = 1;
          setState('complete');
          return;
        }
      } else if (state === 'dead') {
        worldStep(world, dt);
        view.cardIn = Math.min(1, view.cardIn + dt * 4);
      }

      /* Tilt follows velocity: snaps up on a flap, noses over on the fall. */
      var target;
      if (state === 'dead') {
        target = 1.6;
      } else if (view.tiltHold > 0) {
        target = -0.42;
      } else {
        var k = clamp((world.vy - FLAP_V) / (MAX_FALL - FLAP_V), 0, 1);
        target = -0.42 + k * 1.97;
      }
      view.tilt += (target - view.tilt) * Math.min(1, dt * 13);
      view.wing += dt * (view.tiltHold > 0 ? 26 : 10);
      view.flash = Math.max(0, view.flash - dt * 3.2);

      if (state === 'complete' && !completeFired && clock - stateAt >= VICTORY_BEAT) {
        completeFired = true;
        /* The handoff is unchanged -- same trigger, same moment, same call. The
         * argument is additive: main.js forwards it to the chase engine so the
         * sus counter and any state verdict survive the transition.
         * Wrapped because this runs inside a rAF callback, where a throw is
         * reported and then swallowed: the next frame is already scheduled and
         * completeFired is already true, so an unguarded throw left the loop
         * running forever on a frozen victory card that could never hand off. */
        if (onComplete) {
          try {
            onComplete({ sus: susN, stateCheat: tainted });
          } catch (e) {
            WARNF('[AIMLAB] FLAPPY onComplete threw: ' + (e && e.message));
            stop();
          }
        }
      }
    }

    function render() {
      ctx.clearRect(0, 0, W, H);
      drawSky(ctx, cache);
      drawClouds(ctx, view.scroll);
      drawSkyline(ctx, view.scroll);
      drawHills(ctx, view.scroll);

      var i;
      for (i = 0; i < world.pipes.length; i++) {
        drawPipePair(ctx, world.pipes[i].wx - world.scrollX, world.pipes[i].gapY);
      }

      drawGround(ctx, view.scroll);
      /* dim the scene before the bird so the title card never mutes it */
      if (state === 'getready') { drawVignette(ctx, 0.28); }
      drawBird(ctx, BIRD_X, world.y, view.tilt, view.wing);

      if (state === 'playing' || state === 'complete') {
        label(ctx, String(shScore.get()), W / 2, 58, 42, '#ffffff', 5, '#10151f');
        label(ctx, shScore.get() + ' / ' + targetScore, W / 2, 90, 12,
          'rgba(236, 244, 255, 0.82)', 3, 'rgba(12, 17, 26, 0.85)');
      }

      /* V2.7: the only thing anti-cheat draws on this screen, and only after
       * something has actually been detected. */
      if (noteText && clock < noteUntil) {
        label(ctx, noteText, W / 2, 116, 12, '#ffd166', 3, 'rgba(12, 17, 26, 0.9)');
      }

      if (state === 'getready') {
        label(ctx, title, W / 2, 142, 26, '#f2c14e', 5, '#10151f');
        label(ctx, 'TAP TO START', W / 2, 244, 22, '#ffffff', 5, '#10151f');
        var pulse = 0.55 + 0.45 * Math.sin(view.bob * 4);
        ctx.globalAlpha = pulse;
        label(ctx, 'CLICK  -  TAP  -  SPACE', W / 2, 274, 11,
          '#d6e4f2', 3, 'rgba(12, 17, 26, 0.9)');
        ctx.globalAlpha = 1;
        label(ctx, 'REACH ' + targetScore + ' POINTS IN ONE RUN',
          W / 2, 312, 11, 'rgba(214, 228, 242, 0.75)', 3, 'rgba(12, 17, 26, 0.9)');
      }

      if (state === 'dead') {
        var a = view.cardIn;
        ctx.globalAlpha = a;
        drawVignette(ctx, 0.42 * a);
        drawCard(ctx, 44, 168, 200, 146);
        label(ctx, 'GAME OVER', W / 2, 200, 22, '#f26d4e', 4, '#10151f');
        label(ctx, 'SCORE', 92, 236, 12, 'rgba(214, 228, 242, 0.7)', 0, '', 'left');
        label(ctx, String(shScore.get()), 196, 236, 16, '#ffffff', 0, '', 'right');
        label(ctx, 'BEST', 92, 258, 12, 'rgba(214, 228, 242, 0.7)', 0, '', 'left');
        label(ctx, String(sessionBest), 196, 258, 16, '#f2c14e', 0, '', 'right');
        label(ctx, 'TARGET  ' + targetScore + '  IN ONE RUN', W / 2, 280, 10,
          'rgba(214, 228, 242, 0.6)', 0, '');
        if (clock - stateAt >= DEAD_RETRY_DELAY) {
          ctx.globalAlpha = a * (0.55 + 0.45 * Math.sin(clock * 6));
          label(ctx, 'TAP TO RETRY', W / 2, 302, 13, '#ffffff', 0, '');
        }
        ctx.globalAlpha = 1;
      }

      if (state === 'complete') {
        drawVignette(ctx, 0.5);
        drawCard(ctx, 34, 196, 220, 96);
        label(ctx, title + ' READY', W / 2, 228, 19, '#6fe3a5', 4, '#10151f');
        label(ctx, 'TARGET REACHED  -  ' + shScore.get() + ' / ' + targetScore,
          W / 2, 258, 11, 'rgba(214, 228, 242, 0.82)', 0, '');
      }

      if (view.flash > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (view.flash * 0.7) + ')';
        ctx.fillRect(0, 0, W, H);
      }
    }

    /* V2.7 layer A, applied here at last. Integrating straight from the frame
     * delta meant a tab throttled to 10 fps advanced roughly a third of a second
     * of game time per wall second: human reaction time is fixed in wall time,
     * so slow motion shrank it in game time and took the gauntlet from about two
     * attempts per clear to one. Fixed 8 ms sub-steps off the captured clock fix
     * the rate; the same pause/slideshow guards the chase uses keep an honest
     * hitch from ever billing debt. */
    var FIX_DT_MS = 8, FIX_DT = 0.008, FIX_MAX = 8;
    var FIX_PAUSE_MS = 1500, FIX_SLIDESHOW_MS = 120;
    var FIX_DEBT_MAX = 2000, FIX_HEAL_MS = 40, FIX_HEAL_STEP = 8;
    var accumMs = 0, lagDebtMs = 0, lagFlagged = false;

    function frame(ts) {
      if (stopped) { return; }
      rafId = win.requestAnimationFrame(frame);

      var nowMs = NOWF();
      if (!lastTs) { lastTs = nowMs; }
      var dtMs = nowMs - lastTs;
      lastTs = nowMs;

      if (dtMs > FIX_PAUSE_MS || doc.hidden) {
        accumMs = 0;                       // alt-tab, sleep, a breakpoint: free
      } else {
        accumMs += dtMs;
        var n = 0;
        while (accumMs >= FIX_DT_MS && n < FIX_MAX) {
          accumMs -= FIX_DT_MS;
          advance(FIX_DT);
          n++;
        }
        if (accumMs >= FIX_DT_MS) {
          var dropped = accumMs - (accumMs % FIX_DT_MS);
          accumMs -= dropped;
          if (dtMs > FIX_SLIDESHOW_MS) { lagDebtMs += dropped; }
        }
        if (dtMs <= FIX_HEAL_MS && lagDebtMs > 0) {
          lagDebtMs -= FIX_HEAL_STEP;
          if (lagDebtMs < 0) { lagDebtMs = 0; }
        }
        if (lagDebtMs > FIX_DEBT_MAX && !lagFlagged) {
          lagFlagged = true;
          note('slowed to a crawl');
          sus('lag-debt');
        }
      }

      render();
    }

    function stop() {
      if (stopped) { return; }
      stopped = true;
      container.removeAttribute('data-aimlab-flappy');
      /* The run was already won; the 600 ms victory beat just had not elapsed.
       * Tearing down in that window used to discard the handoff entirely and
       * strand the player on an empty stage after they had earned the points. */
      if (state === 'complete' && !completeFired && onComplete) {
        completeFired = true;
        try {
          onComplete({ sus: susN, stateCheat: tainted });
        } catch (e) {
          WARNF('[AIMLAB] FLAPPY onComplete threw: ' + (e && e.message));
        }
      }
      if (rafId) { win.cancelAnimationFrame(rafId); rafId = 0; }
      wrap.removeEventListener('pointerdown', onPointerDown);
      wrap.removeEventListener('touchstart', onTouchStart);
      doc.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('resize', onResize);
      if (ro) { ro.disconnect(); ro = null; }
      if (wrap.parentNode) { wrap.parentNode.removeChild(wrap); }
      container.style.position = prevPosition;
      cache.sky = null;
    }

    layout();
    render();
    rafId = win.requestAnimationFrame(frame);

    return Object.freeze({ stop: stop });
  }

  // Frozen for the same reason AimlabChase is (V2.6 layer 1): the module cannot
  // be edited from the console, and neither can the handle it returns. The
  // non-writable descriptor is what stops the whole binding being replaced --
  // freezing the object alone leaves `window.AimlabFlappy = {...}` working.
  try {
    Object.defineProperty(window, 'AimlabFlappy', {
      value: Object.freeze({ start: start }), writable: false, configurable: false, enumerable: true
    });
  } catch (e) {
    window.AimlabFlappy = Object.freeze({ start: start });
  }
})();
