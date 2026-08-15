/* eMoney Aim Labs -- Simulation stage (Flappy-style mechanics replica).
 *
 * Mechanics homage, not an asset copy: every pixel here is drawn procedurally
 * with canvas primitives. No sprites, no external images, no fonts, no audio,
 * no network access. The only global it defines is window.AimlabFlappy.
 *
 * Public API:
 *   var handle = window.AimlabFlappy.start(container, {
 *     targetScore: 10,
 *     onComplete: function () {}
 *   });
 *   handle.stop();
 *
 * Console contract:
 *   [AIMLAB] FLAPPY SCORE n=<int>
 *   [AIMLAB] FLAPPY DEATH score=<int>
 *   [AIMLAB] FLAPPY DONE
 */
(function () {
  'use strict';

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
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[AIMLAB] FLAPPY start called without a container element');
      }
      return { stop: function () {} };
    }

    var targetScore = typeof opts.targetScore === 'number' && opts.targetScore > 0
      ? Math.floor(opts.targetScore) : 10;
    var onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : null;

    var doc = container.ownerDocument || document;
    var win = doc.defaultView || window;

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

    function log(msg) {
      if (typeof console !== 'undefined' && console.log) { console.log(msg); }
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

    function onPointerDown(e) {
      if (e.cancelable) { e.preventDefault(); }
      onInput();
    }

    function onTouchStart(e) {
      if (e.cancelable) { e.preventDefault(); }
      onInput();
    }

    function onKeyDown(e) {
      if (e.repeat) { return; }
      if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) {
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
          log('[AIMLAB] FLAPPY SCORE n=' + (world.score - n + 1));
          n--;
        }

        if (world.score >= targetScore) {
          log('[AIMLAB] FLAPPY DONE');
          if (world.score > sessionBest) { sessionBest = world.score; }
          view.flash = 1;
          setState('complete');
          return;
        }

        if (world.diedThisStep) {
          log('[AIMLAB] FLAPPY DEATH score=' + world.score);
          if (world.score > sessionBest) { sessionBest = world.score; }
          view.flash = 1;
          setState('dead');
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
        if (onComplete) { onComplete(); }
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
        label(ctx, String(world.score), W / 2, 58, 42, '#ffffff', 5, '#10151f');
        label(ctx, world.score + ' / ' + targetScore, W / 2, 90, 12,
          'rgba(236, 244, 255, 0.82)', 3, 'rgba(12, 17, 26, 0.85)');
      }

      if (state === 'getready') {
        label(ctx, 'SIMULATION', W / 2, 142, 26, '#f2c14e', 5, '#10151f');
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
        label(ctx, String(world.score), 196, 236, 16, '#ffffff', 0, '', 'right');
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
        label(ctx, 'SIMULATION READY', W / 2, 228, 19, '#6fe3a5', 4, '#10151f');
        label(ctx, 'TARGET REACHED  -  ' + world.score + ' / ' + targetScore,
          W / 2, 258, 11, 'rgba(214, 228, 242, 0.82)', 0, '');
      }

      if (view.flash > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (view.flash * 0.7) + ')';
        ctx.fillRect(0, 0, W, H);
      }
    }

    function frame(ts) {
      if (stopped) { return; }
      rafId = win.requestAnimationFrame(frame);
      if (!lastTs) { lastTs = ts; }
      var dt = (ts - lastTs) / 1000;
      lastTs = ts;
      if (!(dt > 0)) { dt = 0; }
      if (dt > 0.032) { dt = 0.032; }
      advance(dt);
      render();
    }

    function stop() {
      if (stopped) { return; }
      stopped = true;
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

    return { stop: stop };
  }

  window.AimlabFlappy = { start: start };
})();
