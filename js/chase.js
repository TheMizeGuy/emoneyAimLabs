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

   ADVANCED CHEAT DETECTION (V2.7). Same posture, sharper instruments. Only two
   things in the whole engine void a win -- clock divergence (V2.6 layer 3) and
   state-checksum divergence (layer C). Everything else taunts and counts:
     A. fixed 8 ms sub-step physics, so throttling the tab slows the picture and
        not the game, while the timer stays on the wall clock
     B. a cursor-presence gate on the winning press, so a click has to arrive
        where the pointer actually is
     C. every published number lives in three closures behind one accessor with a
        rolling checksum; a debugger edit to any copy is a verdict
     D. geometry attestation twice a second: the button box, the window box and
        the on-screen transform are re-derived and restored if they moved
     E. build integrity, delegated to js/sentinel.js (taunt only)
     G. the WIN console line and the win dialog carry a signature over the run
     H. every soft detection lands on a visible sus counter

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
  var EVERY     = W.setInterval.bind(W);
  var UNEVERY   = W.clearInterval.bind(W);
  var LOG = (W.console && W.console.log) ? W.console.log.bind(W.console) : function () {};
  var OBSERVER = W.MutationObserver || W.WebKitMutationObserver || null;

  /* Layer D reads every one of its measurements through this. Capturing the
     method matters more than capturing the clocks: a patched
     getBoundingClientRect feeds the geometry detector a lie, and the detector
     then never fires the restore that would have undone the attack. */
  var RECT = (W.Element && W.Element.prototype && W.Element.prototype.getBoundingClientRect)
    ? W.Element.prototype.getBoundingClientRect
    : null;

  /* A third clock, deliberately reached through a different function object
     than WALL. Date.now and Date.prototype.getTime are separate properties, so
     scaling both of the first two clocks by one factor -- which reads perfectly
     clean to a difference-based check -- still leaves this one telling the
     truth. */
  var DATE    = W.Date;
  var GETTIME = (W.Date && W.Date.prototype && W.Date.prototype.getTime)
    ? W.Date.prototype.getTime
    : null;
  // V2.7 layer G leans on these two, so they are captured with the rest
  var SUBTLE = (W.crypto && W.crypto.subtle && W.crypto.subtle.digest)
    ? W.crypto.subtle.digest.bind(W.crypto.subtle)
    : null;
  var TENC = W.TextEncoder || null;

  // Every geometry read in the engine goes through here, never through the
  // element's own (patchable) method.
  function boxOf(node) {
    // the fallback is only reached where Element.prototype is unavailable
    return RECT ? RECT.call(node) : node.getBoundingClientRect();
  }

  function wall2() {
    if (!GETTIME) return Date.now();
    try { return GETTIME.call(new DATE()); } catch (e) { return Date.now(); }
  }

  var DEFAULT_IMAGE    = './assets/emoney.png';
  var DEFAULT_BEST_KEY = 'emoney-aimlabs-best';

  // Win95 chrome at 2x classic metrics. Kept in sync with .card/.cardin/.bar in
  // index.html so the window can be sized before the image has loaded.
  var FRAME_PX = 4;    // 2px outer bevel + 2px inner bevel, per side
  var BAR_H    = 36;   // title bar height

  var MARKUP = [
    '<div class="hud" data-el="hud">',
    '<div class="row mode"><span class="v" data-el="mode">PRACTICE</span></div>',
    '<div class="row time"><span class="k">TIME</span><span class="v" data-el="time">00:00.000</span></div>',
    '<div class="row"><span class="k">MISSES</span><span class="v" data-el="miss">0</span></div>',
    '<div class="row"><span class="k">NEAR</span><span class="v" data-el="near">0</span></div>',
    '<div class="row best hide" data-el="bestRow"><span class="k">BEST</span><span class="v" data-el="best">--</span></div>',
    '<div class="tray hide" data-el="susRow"><span class="warn" aria-hidden="true"></span>SUS: <span class="v" data-el="sus">0</span></div>',
    '</div>',
    '<div class="sig">',
    '<h1>eMoney Aim Labs</h1>',
    '<p>Close the popup to win. It has opinions about being closed.</p>',
    '</div>',
    '<div class="wrap" data-el="wrap">',
    '<div class="card" data-el="card">',
    '<div class="cardin" data-el="cardin">',
    '<div class="bar" data-el="bar">',
    '<span class="bartitle" data-el="barTitle">eMoney.exe</span>',
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
    '<p class="ovsig">SIG <span class="v" data-el="ovSig">--------</span></p>',
    '<p class="ovsus hide" data-el="ovSusRow">Sus events logged: <span data-el="ovSus">0</span></p>',
    '<button class="again" data-el="again" type="button">Play again</button>',
    '</div>',
    '<div class="ovbody hide" data-el="ovCheat">',
    '<div class="errrow">',
    '<span class="erricon" aria-hidden="true"></span>',
    '<p class="errtext" data-el="cheatText">Two clocks, two answers. One of them is lying, and it is not ours.</p>',
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
    '</div>',
    '<div class="capbox hide" data-el="capBox">',
    '<div class="ovcard">',
    '<div class="ovbar"><span class="ovbartitle">eMoney Security Center</span></div>',
    '<div class="ovbody">',
    '<p class="captext">Prove you are not a robot.<br>Drag the piece into the gap.</p>',
    '<div class="capscene" data-el="capScene">',
    '<canvas class="capshot" data-el="capCanvas" width="260" height="150"></canvas>',
    '<canvas class="cappiece" data-el="capPiece" width="46" height="46"></canvas>',
    '</div>',
    '<div class="capbar">',
    '<span class="caplabel">TIME REMAINING</span>',
    '<span class="capclock" data-el="capClock">60</span>',
    '</div>',
    '<p class="capnote">One attempt. Drop it wrong and you are done.</p>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="banbox hide" data-el="banBox">',
    '<div class="baninner">',
    '<div class="banmark" aria-hidden="true"><span class="banmarktail"></span></div>',
    '<p class="bantitle">INDEFINITE BAN</p>',
    '<p class="bansub" data-el="banSub">Verification failed.</p>',
    '<div class="banbtns">',
    '<button class="banbtn" data-el="banRetry" type="button">Retry</button>',
    '<button class="banbtn" data-el="banHome" type="button">Home</button>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="pausebox hide" data-el="pauseBox">',
    '<div class="ovcard">',
    '<div class="ovbar"><span class="ovbartitle">eMoney.exe</span></div>',
    '<div class="ovbody">',
    '<div class="errrow">',
    '<span class="erricon" aria-hidden="true"></span>',
    '<p class="errtext">This window is too small to run away in.<br>Make the browser bigger to carry on.</p>',
    '</div>',
    '<p class="errsub">Paused. The clock is not running.</p>',
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
    var FLEE_RADIUS        = 470;    // px, cursor -> nearest point of the card rect     (v1 300)
    var FLEE_ACCEL         = 12500;   // px/s^2 at d = 0, scaled by (1 - d/R)^2
    var DODGE_GAIN         = 5.4;    // perpendicular px/s^2 per px/s of cursor approach (v1 2.2)
    var DODGE_APPROACH_CAP = 4200;   // px/s
    var DODGE_HOLD_MS      = 300;    // dodge sign stays put this long so the swerve reads as intent
    var BASE_SPEED         = 190;    // px/s idle wander                                 (v1 150)
    var WANDER_GAIN        = 4.0;    // 1/s, how hard wander steers velocity toward its target
    var SPEED_CAP_FAR      = 2050;   //                                                  (v1 1600)
    var SPEED_CAP_NEAR_ADD = 650;    // FAR + NEAR_ADD lands exactly on the hard cap      (v1 500)
    var SPEED_CAP_HARD     = 2700;   // absolute ceiling, shame mode included             (v1 2100)
    var RESTITUTION        = 0.93;   // bounce loss when nobody is threatening it         (v1 0.9)

    /* V2.9 -- the corner pocket is closed.
       The old pin worked because three things compounded: the flee vector pointed
       into the walls, every bounce bled 7 percent, and the card had no move except
       to rattle. Restitution now climbs toward elastic exactly while the cursor is
       close, so a threatened card keeps its energy; a wall-hug slide gives it a
       legal direction to run when the diagonal is blocked; and a bait-then-jink
       cycle punishes the flick the pocket used to invite. */
    var RESTITUTION_HOT    = 0.995;  // at prox 1: a threatened bounce loses almost nothing
    var SLIDE_PROX         = 0.30;   // cursor this close before the slide arms
    var SLIDE_BAND         = 150;    // px from a wall that counts as pinned
    var SLIDE_ACCEL        = 7600;   // px/s^2 along the wall, scaled by prox
    var SLIDE_HOLD_MIN     = 250;    // ms; the side is held this long so it reads as intent
    var SLIDE_HOLD_MAX     = 350;
    var SLIDE_MIN_ROOM     = 90;     // px; never commit to a side with less room than this
    var BAIT_PROX_MIN      = 0.25;   // the bait only makes sense mid-approach
    var BAIT_PROX_MAX      = 0.80;
    var BAIT_CHANCE        = 0.004;  // per sub-step, so about once every two seconds in range
    var BAIT_MS            = 150;    // the lull that invites the flick
    var BAIT_DAMP          = 7.0;    // 1/s of velocity damping during the lull
    var JINK_MS            = 190;    // and the sidestep that answers it
    var JINK_ACCEL         = 9500;   // px/s^2 perpendicular, scaled by prox
    var BAIT_COOL_MS       = 900;    // no second bait until this clears
    var FLOOR_PROX         = 0.25;   // being threatened at all arms the no-loiter floor
    var FLOOR_SPEED        = 2600;   // px/s it is pushed back up to, scaled by prox
    var FLOOR_GAIN         = 9.0;    // 1/s; smooth, so there is no visible speed step

    /* V2.10 -- camping and drive-by delivery.
       V2.9's slides are fast and deterministic, which turned out to mean they
       would run the X underneath a cursor that was simply sitting there, and the
       2 px presence-snap then armed the win. Two answers, and the important part
       of both is that they are scoped to a cursor that is NOT being aimed: an
       actively moving player gets exactly the game they had before. */
    var SNAP_STALE_MS   = 1500;  // the 2 px snap only arms this soon after a real move
    var CAMP_RADIUS     = 60;    // px the cursor must stay inside...
    var CAMP_MS         = 1000;  // ...for this long before it counts as camped
    var AVOID_SOFT      = 180;   // px of clearance the card steers for while camped
    var AVOID_HARD      = 150;   // px the X is never carried inside while camped
    var AVOID_ACCEL     = 15000; // px/s^2 of repulsion at contact
    var AVOID_BRAKE     = 9.0;   // 1/s; cancels momentum that is closing on the cursor
    var SLIDE_LOOKAHEAD = 190;   // px along the tangent that must stay clear to commit

    /* V2.15 -- per-mode difficulty compensation.
       The simulation window is 320 px wide against practice's 136: it presents
       2.4x the width to track, is easier to corner, and measured consistently
       easier at every viewport. Rather than fork the tuning, the evasive terms
       scale with how much wider than the practice card this window is, so both
       modes land on the same difficulty with one set of constants. Practice is
       the reference and its scale is exactly 1, so nothing about it changes. */
    var DIFF_REF_W = 136;        // the practice window width
    var DIFF_GAIN  = 0.13;       // how hard the compensation scales with excess width

    /* V2.11 -- the miss-click shockwave. Every whiff near the window shoves it
       away from the click point, hardest when you nearly had it. It is a
       velocity impulse, so the speed cap still bounds it and the wall clamp
       still contains it. */
    var SHOCK_RANGE     = 350;   // px from the card rect; beyond this a miss does nothing
    var SHOCK_IMPULSE   = 1250;  // px/s added at zero distance, scaled by (1 - d/range)^2
    var SHOCK_BURST_MS  = 600;   // brief burst that stacks with the taunt burst

    /* V2.12 -- the captcha interrupt. Simulation only, once per run. */
    var CAPTCHA_MIN_MS  = 5000;   // earliest the timer path can fire
    var CAPTCHA_MAX_MS  = 30000;  // latest
    var CAPTCHA_MISS_MIN = 15;    // or this many misses, rolled per run...
    var CAPTCHA_MISS_MAX = 30;    // ...uniform in [MIN, MAX], whichever comes first
    var CAPTCHA_TOL     = 6;      // px the piece must land within
    var CAPTCHA_BEAT_MS = 450;    // success beat before the dialog closes
    var CAPTCHA_LIMIT_MS = 60000; // V2.14: the countdown, and one drop only
    var CAP_W = 260, CAP_H = 150, CAP_PIECE = 46;
    var BOUNCE_JITTER      = 10 * Math.PI / 180;
    var PANIC_MS           = 260;
    var PANIC_ACCEL        = 4000;
    var PANIC_SPEED        = 900;
    var BURST_MS           = 1500;
    var BURST_MUL          = 1.6;
    // (v1/V2.6 had DT_MAX = 0.032 s here. V2.7 layer A replaced the variable
    // frame step with a fixed sub-step accumulator, so the per-frame ceiling is
    // now MAX_SUBSTEPS * FIXED_DT_MS and there is nothing left to clamp.)
    var NEAR_RADIUS        = 48;     // px from the close button's center
    var NEAR_DEBOUNCE      = 250;    // ms
    var EDGE_PAD           = 10;     // keeps a margin between the window and the screen edge
    var PLAY_MARGIN        = 200;    // room the card needs beyond its own size, or the run pauses
    var LATCH_MAX_MS       = 600;    // failsafe so a lost pointerup cannot freeze the card forever
    var BEST_KEY           = (typeof opts.bestKey === 'string' && opts.bestKey) ? opts.bestKey : DEFAULT_BEST_KEY;
    // Which mode the HUD announces. Static per run, so it is re-derived from
    // this constant rather than read back off the node it is printed on.
    var MODE_LABEL         = (typeof opts.modeLabel === 'string' && opts.modeLabel)
                             ? opts.modeLabel.toUpperCase() : 'PRACTICE';
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
    var CLOCK_AUDIO_TOL    = 1500; // the audio-thread cross-check, deliberately loose
    var CLOCK_STEP_MS      = 400;  // a single-frame jump between them reads as a splice
    var TAMPER_DEBOUNCE_MS = 800;  // one taunt per burst of meddling, not one per mutation
    var SHAME_MUL          = 1.15; // shame mode: the card gets 15 percent quicker
    var STORE_SALT         = 'aimlab-95';

    /* V2.7 layer A -- fixed-timestep physics.
       The card integrates in 8 ms sub-steps regardless of frame rate, so
       throttling the tab lowers the frame rate without lowering the card's
       speed. The timer never touches this path: it is wall-clock only. */
    var FIXED_DT_MS   = 8;     // one physics sub-step, in ms
    var FIXED_DT      = 0.008; // the same sub-step, in seconds
    var MAX_SUBSTEPS  = 8;     // 64 ms of simulation per frame; the rest is debt
    var SLIDESHOW_MS  = 120;   // only frames slower than this can accrue debt (<8.3 fps)
    var PAUSE_MS      = 1500;  // above this it is a pause -- alt-tab, sleep, a breakpoint
    var LAG_DEBT_MAX  = 2000;  // ms of dropped simulation before it counts as suspicious
    var LAG_HEAL_MS   = 40;    // a frame at 25 fps or better is a healthy frame...
    var LAG_HEAL_STEP = 8;     // ...and pays down 8 ms of debt, so hitches never add up
    var LOOP_DEAD_MS  = 1000;  // main loop silent this long, while visible, = restart it

    /* V2.7 layer B -- cursor presence gate on the winning press. */
    var PRESENCE_MS   = 350;   // a trusted move must be this recent...
    var PRESENCE_PX   = 150;   // ...and this close to the press point
    var PRESENCE_SNAP = 2;     // or the press must land on the pointer's own last position
    var PRESENCE_SWALLOW_MS = 400;  // how long a blocked press suppresses its own click

    /* V2.7 layer D -- geometry attestation. */
    var ATTEST_FRAMES = 30;    // roughly twice a second
    var GEOM_SUS_DEBOUNCE_MS = 2000;  // one geometry complaint per this window...
    var GEOM_SUS_MAX         = 5;     // ...and this many in a whole run
    var GEOM_TOL      = 2;     // px, box sizes and the button's offset in the frame
    var POS_TOL       = 1;     // px, on-screen transform against the engine's own position
    var EXP_BTN_W     = 28;    // the caption button, straight out of the stylesheet
    var EXP_BTN_H     = 26;
    var BAR_PAD_R     = 4;     // .bar padding-right, which sets the button's inset

    /* V2.7 layer G -- the build salt the win signature is taken over. */
    var WIN_SALT      = 'aimlab-95-v2.7';

    var TAUNTS = [
      'Wrong spot. The X is the small one.',
      'That was the ad, not the button.',
      'He is not going anywhere.',
      'Slower than that and it never closes.',
      'You clicked the face. Bold.',
      'Still open.'
    ];
    var TAUNT_FAKE     = 'Real clicks only. Keyboard does not count.';
    var TAUNT_TAMPER   = 'Nice try. The numbers come from somewhere you cannot reach.';
    var TAUNT_TOOLS    = 'The devtools are not the hard part. The button is.';
    var TAUNT_STORE    = 'Record corrupted. Someone has been editing their trophies.';
    var SHAME_TEXT     = 'Caught you looking under the hood. He is 15 percent faster now. Enjoy.';

    /* V2.7 taunts. Each one is reachable only by doing something a mouse cannot. */
    var TAUNT_LAG      = 'Slideshow mode does not slow him down. It only slows you down.';
    var TAUNT_PRESENCE = 'Clicks arrive where the pointer is. Yours did not.';
    var TAUNT_GEOM     = 'The button is 28 pixels wide. It was 28 pixels wide before you edited it too.';
    var TAUNT_BUILD    = 'This build has been modified. He noticed.';
    var TAUNT_TOUCH    = 'Fingers do not close this one. A mouse does.';
    var TAUNT_TELEPORT = 'That cursor did not travel. Move the mouse like a person.';
    var TAUNT_CAMP     = 'Camping is not aiming. Go and get it.';
    var CHEAT_TEXT_CLOCK = 'Two clocks, two answers. One of them is lying, and it is not ours.';
    var CHEAT_TEXT_STATE = 'Three copies of that number disagree. Ours are the two that match.';

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
    var cardin    = el('cardin');
    var barEl     = el('bar');
    var barTitle  = el('barTitle');
    var shotEl    = el('shot');
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
    var elMode    = el('mode');
    var rowBest   = el('bestRow');
    var rowSus    = el('susRow');
    var elSus     = el('sus');
    var elOvSig   = el('ovSig');
    var rowOvSus  = el('ovSusRow');
    var elOvSus   = el('ovSus');
    var cheatText = el('cheatText');
    var pauseBox  = el('pauseBox');
    var capBox    = el('capBox');
    var capScene  = el('capScene');
    var capCanvas = el('capCanvas');
    var capPiece  = el('capPiece');
    var capClock  = el('capClock');
    var banBox    = el('banBox');
    var banSub    = el('banSub');
    var banRetry  = el('banRetry');
    var banHome   = el('banHome');
    /* These five were the only nodes in the file resolved by el() at use time
       rather than cached here. Both consumers null-guard, so dropping a
       data-el attribute in the elements panel made every write a silent no-op
       and let a forged time survive into the win dialog next to a valid
       signature. Cached like everything else, a missing node is now impossible
       rather than merely unlikely, and checkStructure() puts it back. */
    var elOvTime  = el('ovTime');
    var elOvMiss  = el('ovMiss');
    var elOvNear  = el('ovNear');
    var elOvBest  = el('ovBest');
    var elOvNote  = el('ovNote');
    var ovStats   = elOvMiss ? elOvMiss.parentNode.parentNode : null;

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
    shotEl.appendChild(img);

    wrap.style.width = (imgW + FRAME_PX * 2) + 'px';

    container.appendChild(root);

    /* ---------------- state ----------------
       Everything below is closure-local on purpose (V2.6 layer 1): the HUD is a
       projection of these values, never the source of them. */
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    /* The window's geometry is arithmetic on the stylesheet, not a measurement:
       image + two 2px bevels per side, plus the 36px title bar. The close button
       sits flush right inside that bar. V2.7 layer D makes these the authority
       and the rendered box the thing under test -- so inflating the button in
       devtools no longer inflates the hitbox the engine aims at. calibrate()
       adopts the browser's numbers instead only if it disagrees at boot, which
       is a rendering environment we do not recognise rather than a cheat. */
    var cardW = imgW + FRAME_PX * 2;
    var cardH = imgH + BAR_H + FRAME_PX * 2;
    var btnOffX = cardW / 2 - (FRAME_PX + BAR_PAD_R + EXP_BTN_W / 2);
    var btnOffY = -cardH / 2 + (FRAME_PX + BAR_H / 2);
    var btnW = EXP_BTN_W, btnH = EXP_BTN_H;
    var calibrated = false;

    var x = vw / 2, y = vh / 2;        // card center
    var vx = 0, vy = 0;

    var heading = Math.random() * Math.PI * 2;
    var wanderT = 0;
    var ph1 = Math.random() * 6.283, ph2 = Math.random() * 6.283, ph3 = Math.random() * 6.283;

    var px = 0, py = 0, hasPointer = false;
    var cvx = 0, cvy = 0;              // smoothed cursor velocity
    var velX = 0, velY = 0, velT = 0;

    var dodgeSign = 1, dodgeAt = 0;
    // V2.9: live restitution, the held slide side, and the bait/jink cycle
    var restNow = RESTITUTION;
    // computed once from the known geometry, before any physics runs
    var diffScale = 1 + DIFF_GAIN * Math.max(0, (cardW - DIFF_REF_W) / DIFF_REF_W);
    // V2.10: is the cursor being aimed, or just sitting there?
    var campX = 0, campY = 0, campAt = -1e9, cursorParked = false;

    /* V2.12 captcha, all closure-local per V2.6 layer 1. */
    var CAPTCHA_ON = (MODE_LABEL === 'SIMULATION');
    var capFired = false, capShown = false, capAt = 0, capShownAt = 0, capBeatT = 0;
    var capMissTarget = 0, capUsed = false, banned = false, capLeftShown = -1;
    var capTX = 0, capTY = 0, capHX = 0, capHY = 0, capPX = 0, capPY = 0;
    var capDrag = false, capDX = 0, capDY = 0, capL = 0, capT = 0;
    var slideSign = 1, slideAt = -1e9, slideHold = SLIDE_HOLD_MIN;
    var baitUntil = 0, jinkUntil = 0, jinkSign = 1, baitCoolUntil = 0;
    var overlapping = false, panicUntil = 0;
    var burstUntil = 0;
    var pressLatch = false, pressLatchAt = 0;

    var nearInside = false, nearAt = -1e9;
    var started = false, won = false, finalMs = 0;
    var storeCorrupt = false;
    var bestMs = readBest();

    /* V2.7 layer C. The four numbers a cheat would want to reach are not
       variables any more; each is three copies in three separate closures behind
       one accessor, with a per-value MAC and a rolling checksum over every
       mutation the engine has ever made. Editing one copy in a debugger diverges
       from the other two, editing all three diverges from the MAC, and either is
       a verdict rather than a taunt. (The fourth, the flappy score, lives in
       flappy.js and rides in here as opts.stateCheat.)

       The nonce keys every MAC, so a value lifted out of one session is worthless
       in the next and two tabs never share a checksum. It must exist before the
       first newShadow() call, which is why it is declared here and not with the
       rest of the shadow machinery below. */
    var shNonce = ((Math.imul(WALL() >>> 0, 1103515245) ^ ((NOW() * 1000) | 0)) >>> 0);
    var shChain = shNonce;             // rolling checksum over every mutation made
    var shMisses = newShadow('misses', 0);
    var shNear   = newShadow('near', 0);
    var shStartT = newShadow('origin', 0);
    var stateBad = false, cheatLogged = false;

    var lastT = 0, rafId = 0, tauntTimer = 0, winTimer = 0;
    var stopped = false;

    // dual-clock integrity, plus the two independent references that catch a
    // coordinated edit of the first two (B4)
    var startWall = 0, clkDrift = 0, clkLast = null, clkStep = false;
    var clkSum = 0, clkPair = -1, clkStill = 0;
    var startWall2 = 0;
    var audioT0 = -1, audioWall0 = 0, audioBad = 0;
    var tamperAt = -1e9, shame = 1;
    var mo = null, mo2 = null, geomDirty = false;

    // layer D backoff: a page zoom or a user stylesheet is a mismatch restoreChrome
    // cannot undo, and re-running the repair every frame was a 123/s console flood
    var geomFailStreak = 0, geomSusAt = -1e9, geomSusCount = 0, restoreQuietUntil = 0;

    // ruling 3: too small a viewport pauses the run behind a dialog
    var paused = false, pauseAt = 0, pauseWall = 0, pauseWall2 = 0;

    // B5: the rAF id namespace is page-global, so the loop needs a heartbeat
    var watchdog = 0;

    // B6/B7: a press has to sit inside a run that actually rendered frames
    var framesRun = 0, firstMoveFrame = -1;

    // V2.7 item 1: what kind of pointer is behind the click being judged
    var lastPointerType = '', sawTouch = false;
    var HAS_POINTER_EVENTS = !!W.PointerEvent;

    // F3/F4 physics: a spoofed document.hidden, and stall-loop counting
    var hiddenFrames = 0, pauseFrames = 0, stallFlagged = false;

    // F5 quality: timers that must not outlive stop()
    var storeTimer = 0, voiceTimers = [];

    // taunt placement, recomputed from cached numbers so render() reads no layout
    var tauntOn = false, tauntW = 0;

    // V2.7 layer A: sub-step accumulator and the lag debt it sheds
    var accumMs = 0, simT = 0, lagDebtMs = 0, lagFlagged = false;

    // V2.7 layer B: the last trusted mouse position, and the press that failed the gate
    var moveT = -1e9, moveX = 0, moveY = 0, presenceBlockAt = -1e9;

    // V2.7 layer D: how many frames until the next attestation
    var attestIn = ATTEST_FRAMES;

    // V2.7 layer H: soft detections, seeded with anything flappy already saw
    var susN = (opts.susSeed > 0) ? Math.floor(opts.susSeed) : 0;

    // V2.7 layer G: the win signature, once it has been computed
    var winSig = '';

    // When the caller passes an audio object it owns the AudioContext, so the
    // chase never constructs a second one; practice passes null and owns nothing,
    // so the chase makes its own context lazily inside a miss click.
    var audio = opts.audio || null;
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

    /* ---- triple-shadow state (V2.7 layer C) ---- */

    function shMac(key, v, seq) {
      var s = key + '|' + v + '|' + seq + '|' + shNonce;
      var h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h;
    }

    // One copy, one closure. Three of these back every shadowed value.
    function shCell(v0) {
      var v = v0;
      return { r: function () { return v; }, w: function (n) { v = n; } };
    }

    function newShadow(key, v0) {
      var a = shCell(v0), b = shCell(v0), c = shCell(v0);
      var seq = 0;
      var mac = shMac(key, v0, 0);
      return {
        get: function () {
          var va = a.r();
          if (stateBad) return va;
          if (va !== b.r() || va !== c.r() || shMac(key, va, seq) !== mac) onStateDivergence();
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

    // Hard evidence, so this is one of only two paths that voids a win. win()
    // owns the console line: it recomputes the verdict from stateBad and logs it
    // exactly once, whether the divergence surfaced here or inside win's own reads.
    function onStateDivergence() {
      if (stateBad) return;
      stateBad = true;
      playError();
      if (!won) win();
      else logCheat('state');
    }

    /* ---- the sus meter (V2.7 layer H) ----
       Every soft detection ends here. It counts and it shows; it never locks. */
    function sus(reason) {
      susN++;
      renderSus();
      LOG('[AIMLAB] SUS n=' + susN + ' reason=' + reason);
    }

    function renderSus() {
      if (susN <= 0) return;
      setText(elSus, susN);
      rowSus.classList.remove('hide');
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
      if (won || stopped) return;          // a post-teardown timer must not re-arm
      taunt.textContent = text;
      taunt.classList.add('on');
      tauntOn = true;
      tauntW = taunt.offsetWidth;          // one layout read per taunt, not per frame
      placeTaunt();
      UNDELAY(tauntTimer);
      tauntTimer = DELAY(function () {
        taunt.classList.remove('on');
        tauntOn = false;
      }, 1300);
    }

    function startTimer() {
      if (started || won) return;
      started = true;
      shStartT.set(NOW());
      startWall = WALL();
      startWall2 = wall2();
      simT = NOW();
      // V2.12: one captcha per run, at a random instant in [5, 30] s
      capAt = NOW() + CAPTCHA_MIN_MS + rnd() * (CAPTCHA_MAX_MS - CAPTCHA_MIN_MS);
      // V2.14: the miss threshold is rolled per run, so it cannot be counted to
      capMissTarget = CAPTCHA_MISS_MIN +
        Math.floor(rnd() * (CAPTCHA_MISS_MAX - CAPTCHA_MISS_MIN + 1));
      LOG('[AIMLAB] START');
    }

    function addMiss(reason) {
      var n = shMisses.get() + 1;
      shMisses.set(n);
      setText(elMiss, n);
      LOG('[AIMLAB] MISS n=' + n + (reason ? (' reason=' + reason) : ''));
      playError();
      if (capMissTarget > 0 && n >= capMissTarget) showCaptcha('misses');
    }

    // V2.7 layer C keeps the near-miss counter behind the accessor as well; step()
    // calls this instead of touching the number, which also keeps the physics
    // function's free-variable surface small enough to drive from a Node harness.
    function bumpNear() {
      var n = shNear.get() + 1;
      shNear.set(n);
      setText(elNear, n);
    }

    /* ---------------- anti-cheat ---------------- */

    // Every detection ends here: a taunt, a noise and a sus point, never a lock.
    function onTamper(text, reason) {
      var t = NOW();
      if (t - tamperAt < TAMPER_DEBOUNCE_MS) return;
      tamperAt = t;
      showTaunt(text);
      playError();
      sus(reason);
    }

    // Two independent clocks and a rolling checksum over the pair. Backgrounding
    // a tab moves both together, so only a doctored clock separates them.
    function clockTick() {
      if (!started || won) return;
      var p = NOW() - shStartT.get();
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

      /* B4. Everything above measures the *difference* between two clocks, so
         scaling both by one factor reads perfectly clean. These two references
         are reached through function objects the first pair does not share. */
      var w2 = wall2() - startWall2;
      if (Math.abs(w2 - w) > CLOCK_TOLERANCE_MS) clkStep = true;

      /* The audio clock advances on the audio thread and is not reachable from
         JS at all. Only simulation has a context, and only while it is actually
         running -- a suspended or freshly resumed context re-baselines instead
         of accusing. Three consecutive violations at a generous threshold keeps
         it clear of ordinary audio-clock drift. */
      var actx = audio && audio.ctx;
      if (actx && actx.state === 'running') {
        if (audioT0 < 0) { audioT0 = actx.currentTime; audioWall0 = w; }
        else {
          var ad = (actx.currentTime - audioT0) * 1000 - (w - audioWall0);
          if (Math.abs(ad) > CLOCK_AUDIO_TOL) {
            if (++audioBad >= 3) clkStep = true;
          } else if (audioBad > 0) audioBad--;
        }
      } else {
        audioT0 = -1;
        audioBad = 0;
      }
    }

    function clockIsSuspect() {
      return clkStep || clkDrift > CLOCK_TOLERANCE_MS;
    }

    // The HUD and the overlay are projections. If anything edits them, re-derive
    // from closure state; our own writes are already equal, so this never loops.
    function reproject() {
      var fixed = 0;
      var m = shMisses.get(), nm = shNear.get();
      fixed += reassert(elMode, MODE_LABEL);
      fixed += reassert(elMiss, m);
      fixed += reassert(elNear, nm);
      if (susN > 0) fixed += reassert(elSus, susN);
      if (bestMs !== null) fixed += reassert(elBest, fmt(bestMs));
      if (won) {
        fixed += reassert(elTime, fmt(finalMs));
        fixed += reassert(elOvTime, fmt(finalMs));
        fixed += reassert(elOvMiss, m);
        fixed += reassert(elOvNear, nm);
        fixed += reassert(elOvBest, bestMs === null ? '--' : fmt(bestMs));
        if (winSig) fixed += reassert(elOvSig, winSig.slice(0, 8));
        if (susN > 0) fixed += reassert(elOvSus, susN);
      }
      if (fixed > 0) onTamper(TAUNT_TAMPER, 'hud-edit');
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

      /* V2.7 layer D. Kept on a second observer with its own callback because the
         first one fires every frame -- the timer rewrites a text node 60 times a
         second -- and a getBoundingClientRect on that schedule is a layout thrash
         nobody needs. Nothing here is written by the engine during play, so this
         one only fires when somebody else edits the DOM. .wrap is watched for
         children but never for attributes: its transform is ours, every frame. */
      var attrs = { attributes: true, attributeFilter: ['style', 'class'] };
      mo2 = new OBSERVER(function () { geomDirty = true; });
      mo2.observe(card, attrs);
      mo2.observe(cardin, attrs);
      mo2.observe(barEl, attrs);
      mo2.observe(btn, attrs);
      mo2.observe(hudEl, attrs);
      mo2.observe(overlay, attrs);
      mo2.observe(root, { childList: true });
      mo2.observe(wrap, { childList: true });
      mo2.observe(card, { childList: true, subtree: true });
    }

    /* ---- geometry attestation (V2.7 layer D) ---- */

    // Run once, when the chrome has first laid out. The stylesheet and the
    // arithmetic in the state block should agree to the pixel; if this browser
    // lays the window out differently, take its numbers instead and attest
    // against those. An unfamiliar renderer is not a cheat.
    function calibrate() {
      if (calibrated || won || stopped) return;
      var cr = boxOf(card);
      var br = boxOf(btn);
      if (!(cr.width > 0 && cr.height > 0 && br.width > 0 && br.height > 0)) return;
      calibrated = true;
      if (Math.abs(cr.width - cardW) > GEOM_TOL || Math.abs(cr.height - cardH) > GEOM_TOL ||
          Math.abs(br.width - btnW) > GEOM_TOL || Math.abs(br.height - btnH) > GEOM_TOL) {
        /* The engine boots inside the mode-button click, so a stylesheet
           injected while the start screen was up is "pre-boot" and used to be
           adopted as ground truth -- handing layer D the attacker's geometry to
           attest against. An unfamiliar renderer disagrees by a pixel or two;
           it does not disagree by 7x. Outside a sane band, keep the stylesheet
           arithmetic and let attest() restore against that instead. */
        if (Math.abs(cr.width - cardW) > cardW * 0.25 ||
            Math.abs(cr.height - cardH) > cardH * 0.25 ||
            Math.abs(br.width - btnW) > btnW * 0.25 ||
            Math.abs(br.height - btnH) > btnH * 0.25) {
          sus('geometry-boot');
          showTaunt(TAUNT_GEOM);
          restoreChrome();
          return;
        }
        cardW = cr.width;
        cardH = cr.height;
        btnW = br.width;
        btnH = br.height;
        btnOffX = (br.left + br.width / 2) - (cr.left + cr.width / 2);
        btnOffY = (br.top + br.height / 2) - (cr.top + cr.height / 2);
        wrap.style.width = cardW + 'px';
        clampIntoView();
        render();
      }
    }

    function attest() {
      if (won || stopped || !calibrated || paused) return;
      // our own restoreChrome() writes are observed by mo2; do not re-judge them
      if (NOW() < restoreQuietUntil) return;
      var br = boxOf(btn);
      var cr = boxOf(card);
      var bad = '';

      /* B2. getBoundingClientRect returns the element's own border box and says
         nothing about descendants that overflow it, while the win handler used
         to accept any descendant as the button. A 10000px child parked off
         screen therefore made the whole viewport clickable while the button
         still measured a pristine 28x26. The glyph is ::before/::after, so the
         honest child count is exactly zero. */
      if (btn.children.length !== 0) {
        while (btn.firstElementChild) btn.removeChild(btn.firstElementChild);
        bad = 'button-children';
      } else if (!(br.width > 0 && br.height > 0) || !(cr.width > 0 && cr.height > 0)) {
        bad = 'hidden';
      } else if (Math.abs(br.width - btnW) > GEOM_TOL || Math.abs(br.height - btnH) > GEOM_TOL) {
        bad = 'button';
      } else if (Math.abs(cr.width - cardW) > GEOM_TOL || Math.abs(cr.height - cardH) > GEOM_TOL) {
        bad = 'window';
      } else {
        var ox = (br.left + br.width / 2) - (cr.left + cr.width / 2);
        var oy = (br.top + br.height / 2) - (cr.top + cr.height / 2);
        if (Math.abs(ox - btnOffX) > GEOM_TOL || Math.abs(oy - btnOffY) > GEOM_TOL) {
          bad = 'offset';
        } else if (Math.abs((cr.left + cr.width / 2) - x) > POS_TOL ||
                   Math.abs((cr.top + cr.height / 2) - y) > POS_TOL) {
          // what is on screen against what the engine believes it drew
          bad = 'transform';
        }
      }

      if (!bad) { geomFailStreak = 0; return; }

      /* Not every mismatch is repairable. A page-level `zoom` or a
         `transform: scale()` from a user stylesheet or an accessibility
         extension touches none of the nodes restoreChrome() stamps, so the
         repair fails, mo2 sees the write, geomDirty re-arms, and the whole
         thing used to run again on the very next frame -- 123 detections a
         second, a console flood and a layout-thrash loop, at a player who was
         merely using page zoom. Repair a few times, complain at most once every
         couple of seconds and at most a handful of times per run, then leave it
         alone. */
      geomFailStreak++;
      if (geomFailStreak <= 3) restoreChrome();

      var t = NOW();
      if (t - geomSusAt < GEOM_SUS_DEBOUNCE_MS || geomSusCount >= GEOM_SUS_MAX) return;
      geomSusAt = t;
      geomSusCount++;
      sus('geometry-' + bad);
      showTaunt(TAUNT_GEOM);
    }

    function stamp(node, props) {
      if (!node) return;
      for (var i = 0; i < props.length; i += 2) {
        try { node.style.setProperty(props[i], props[i + 1], 'important'); } catch (e) { /* ignore */ }
      }
    }

    // Inline !important outranks any author rule, so this survives an edited
    // stylesheet as well as an edited element. Nothing is stamped until something
    // has actually moved, so a clean run never carries a byte of inline style.
    function restoreChrome() {
      stamp(wrap, ['width', cardW + 'px', 'display', 'block', 'visibility', 'visible',
                   'opacity', '1', 'position', 'fixed', 'left', '0px', 'top', '0px',
                   'z-index', '20', 'pointer-events', 'auto']);
      stamp(card, ['width', '100%', 'box-sizing', 'border-box', 'transform', 'none',
                   'padding', '0px', 'border-width', '2px', 'display', 'block',
                   'visibility', 'visible', 'opacity', '1', 'position', 'relative',
                   'pointer-events', 'auto']);
      stamp(cardin, ['padding', '0px', 'border-width', '2px', 'display', 'block',
                     'visibility', 'visible', 'opacity', '1']);
      stamp(barEl, ['height', BAR_H + 'px', 'padding', '0px ' + BAR_PAD_R + 'px 0px 6px',
                    'display', 'flex', 'align-items', 'center', 'box-sizing', 'border-box',
                    'visibility', 'visible', 'opacity', '1']);
      stamp(btn, ['width', btnW + 'px', 'height', btnH + 'px',
                  'min-width', btnW + 'px', 'min-height', btnH + 'px',
                  'max-width', btnW + 'px', 'max-height', btnH + 'px',
                  'box-sizing', 'border-box', 'padding', '0px', 'margin', '0px',
                  'border-width', '2px', 'flex', 'none', 'position', 'relative',
                  'transform', 'none', 'display', 'block', 'visibility', 'visible',
                  'opacity', '1', 'pointer-events', 'auto']);
      render();
      restoreQuietUntil = NOW() + 50;   // mo2 will see these writes; they are ours
    }

    function ensure(parent, child, before) {
      if (!parent || !child || child.parentNode === parent) return 0;
      if (before && before.parentNode === parent) parent.insertBefore(child, before);
      else parent.appendChild(child);
      return 1;
    }

    // Deleting the close button in the elements panel is a fair thing to try. It
    // comes back with its listeners intact, because the engine never let go of
    // the node -- only the document did.
    function checkStructure() {
      if (won || stopped) return;
      var n = 0;
      n += ensure(root, wrap, null);
      n += ensure(wrap, card, taunt);
      n += ensure(card, cardin, null);
      n += ensure(cardin, barEl, shotEl);
      n += ensure(cardin, shotEl, null);
      n += ensure(barEl, btn, null);
      n += ensure(barEl, barTitle, btn);
      n += ensure(root, capBox, null);
      n += ensure(root, banBox, null);
      n += ensure(capScene, capCanvas, capPiece);
      n += ensure(capScene, capPiece, null);
      n += ensure(hudEl, rowSus, null);
      n += ensure(rowSus, elSus, null);
      n += ensure(ovWin, elOvTime, elOvNote);
      n += ensure(ovWin, elOvNote, ovStats);
      n += ensure(ovStats ? elOvMiss.parentNode : null, elOvMiss, null);
      n += ensure(ovStats ? elOvNear.parentNode : null, elOvNear, null);
      n += ensure(ovStats ? elOvBest.parentNode : null, elOvBest, null);
      if (n === 0) return;
      restoreChrome();
      sus('structure');
      showTaunt(TAUNT_GEOM);
    }

    /* ---------------- V2.12: the captcha interrupt ----------------
       Simulation only, once per run, on whichever comes first: a random instant
       in [5, 30] s, or the fifteenth miss. While it is up the playfield is
       shielded -- no pointer reaches the game, the X is inert and the card
       wanders as though the cursor had left the window -- but the run timer
       deliberately keeps going. Every pixel of it is drawn here; nothing is
       fetched and no real security product is named or imitated.

       The jigsaw outline: a square with a tab on the right edge and a matching
       notch on the left, so the piece reads as a puzzle piece at 46 px. */
    function capPath(c, ox, oy, sz) {
      var t = sz * 0.22;                       // tab radius
      var m = sz * 0.5;
      c.beginPath();
      c.moveTo(ox, oy);
      c.lineTo(ox + sz, oy);
      c.lineTo(ox + sz, oy + m - t);
      c.arc(ox + sz, oy + m, t, -Math.PI / 2, Math.PI / 2, false);   // tab, bulging right
      c.lineTo(ox + sz, oy + sz);
      c.lineTo(ox, oy + sz);
      c.lineTo(ox, oy + m + t);
      // anticlockwise, so this bites INTO the piece instead of bulging out past
      // its left edge -- where it was being clipped off the 46px piece canvas
      // entirely, leaving a hole 10px wider than the piece that fills it
      c.arc(ox, oy + m, t, Math.PI / 2, -Math.PI / 2, true);         // notch, biting in
      c.closePath();
    }

    // A small original scene: sky wash, hills, a low sun and a few windows.
    function capDrawScene(c, w, h) {
      var g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2b4a7a');
      g.addColorStop(0.55, '#6f86a8');
      g.addColorStop(1, '#c8b48a');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);

      c.fillStyle = '#f0d9a0';
      c.beginPath();
      c.arc(w * 0.74, h * 0.34, 16, 0, Math.PI * 2);
      c.fill();

      c.fillStyle = '#3c5570';
      c.beginPath();
      c.moveTo(0, h * 0.72);
      c.lineTo(w * 0.28, h * 0.48);
      c.lineTo(w * 0.52, h * 0.72);
      c.closePath();
      c.fill();

      c.fillStyle = '#31485f';
      c.beginPath();
      c.moveTo(w * 0.34, h * 0.74);
      c.lineTo(w * 0.66, h * 0.44);
      c.lineTo(w, h * 0.74);
      c.closePath();
      c.fill();

      c.fillStyle = '#243544';
      c.fillRect(0, h * 0.72, w, h * 0.28);
      for (var i = 0; i < 7; i++) {
        var bx = 12 + i * 36, bh = 18 + ((i * 37) % 5) * 7;
        c.fillStyle = '#1b2836';
        c.fillRect(bx, h * 0.72 - bh, 24, bh);
        c.fillStyle = '#e8c96a';
        for (var r = 0; r < Math.floor(bh / 9); r++) {
          if ((i + r) % 3 === 0) continue;
          c.fillRect(bx + 5, h * 0.72 - bh + 4 + r * 9, 5, 5);
          c.fillRect(bx + 14, h * 0.72 - bh + 4 + r * 9, 5, 5);
        }
      }
    }

    function capBuild() {
      if (!capCanvas || !capPiece || !capCanvas.getContext) return false;
      var c = capCanvas.getContext('2d');
      var pc = capPiece.getContext('2d');
      if (!c || !pc) return false;

      // clean copy first, so the piece can be cut from an unpunched scene
      var off = document.createElement('canvas');
      off.width = CAP_W; off.height = CAP_H;
      var oc = off.getContext('2d');
      if (!oc) return false;
      capDrawScene(oc, CAP_W, CAP_H);

      // where the gap goes, and where the piece starts out
      capTX = Math.round(80 + rnd() * (CAP_W - CAP_PIECE - 100));
      capTY = Math.round(18 + rnd() * (CAP_H - CAP_PIECE - 36));
      capHX = 6;
      capHY = Math.round(CAP_H - CAP_PIECE - 8);
      capPX = capHX; capPY = capHY;

      c.clearRect(0, 0, CAP_W, CAP_H);
      c.drawImage(off, 0, 0);
      c.save();
      capPath(c, capTX, capTY, CAP_PIECE);
      c.fillStyle = 'rgba(10, 16, 24, 0.82)';
      c.fill();
      c.strokeStyle = '#0a1018';
      c.lineWidth = 1;
      c.stroke();
      c.restore();

      pc.clearRect(0, 0, CAP_PIECE, CAP_PIECE);
      pc.save();
      capPath(pc, 0, 0, CAP_PIECE);
      pc.clip();
      pc.drawImage(off, -capTX, -capTY);
      pc.restore();
      pc.save();
      capPath(pc, 0, 0, CAP_PIECE);
      pc.strokeStyle = '#ffffff';
      pc.lineWidth = 1;
      pc.stroke();
      pc.restore();

      capPlace();
      return true;
    }

    function capPlace() {
      capPiece.style.left = capPX + 'px';
      capPiece.style.top = capPY + 'px';
    }

    function showCaptcha(reason) {
      if (!CAPTCHA_ON || capFired || capShown || won || stopped) return;
      if (!capBuild()) { capFired = true; return; }   // no canvas, no captcha
      capFired = true;
      capShown = true;
      capShownAt = NOW();
      capUsed = false;
      capLeftShown = -1;
      capClock.classList.remove('low');
      setText(capClock, Math.round(CAPTCHA_LIMIT_MS / 1000));
      capBox.classList.remove('hide');
      dropPointer();                 // the card carries on as if the cursor had left
      LOG('[AIMLAB] CAPTCHA SHOWN reason=' + reason);
    }

    function solveCaptcha() {
      if (!capShown) return;
      LOG('[AIMLAB] CAPTCHA SOLVED ms=' + Math.round(NOW() - capShownAt));
      capBeatT = NOW() + CAPTCHA_BEAT_MS;
      capPiece.classList.add('solved');
      capBox.classList.add('solved');
    }

    /* V2.14. A failed verification ends the run: the audio stops, the captcha
       closes and the ban overlay takes the screen. Neither button is a win path,
       so neither is presence-gated -- any trusted click is enough. */
    function banPlayer(reason) {
      if (banned || won || stopped) return;
      banned = true;
      capShown = false;
      capDrag = false;
      capBeatT = 0;
      capBox.classList.add('hide');
      stopAudio();
      killErrorVoices();
      setText(banSub, (reason === 'captcha-timeout')
        ? 'You ran out of time.' : 'That is not where the piece goes.');
      banBox.classList.remove('hide');
      LOG('[AIMLAB] BANNED reason=' + reason);
    }

    function banExit(action) {
      if (typeof opts.onExit === 'function') {
        try { opts.onExit(action); return; } catch (e) { /* fall through to reload */ }
      }
      window.location.reload();
    }

    on(banRetry, 'click', function (e) { if (e.isTrusted) banExit('retry'); });
    on(banHome, 'click', function (e) { if (e.isTrusted) banExit('home'); });

    // called from frame(): closes the dialog after the success beat
    function capTick(now) {
      if (capShown && capBeatT === 0 && !banned) {
        var left = Math.ceil((CAPTCHA_LIMIT_MS - (now - capShownAt)) / 1000);
        if (left < 0) left = 0;
        if (left !== capLeftShown) { capLeftShown = left; setText(capClock, left); }
        if (left <= 10) capClock.classList.add('low');
        if (now - capShownAt >= CAPTCHA_LIMIT_MS) { banPlayer('captcha-timeout'); return; }
      }
      if (capBeatT > 0 && now >= capBeatT) {
        capBeatT = 0;
        capShown = false;
        capDrag = false;
        capBox.classList.add('hide');
        capBox.classList.remove('solved');
        capPiece.classList.remove('solved');
      }
    }

    // Trusted pointer only, so a dispatched drag solves nothing. Touch is
    // welcome here: solving the captcha is not winning the game.
    on(capPiece, 'pointerdown', function (e) {
      if (!capShown || capBeatT > 0 || !e.isTrusted) return;
      var r = boxOf(capScene);
      capL = r.left; capT = r.top;
      capDX = e.clientX - (capL + capPX);
      capDY = e.clientY - (capT + capPY);
      capDrag = true;
      try { capPiece.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
      e.preventDefault();
    });

    on(capPiece, 'pointermove', function (e) {
      if (!capDrag || !e.isTrusted) return;
      capPX = e.clientX - capL - capDX;
      capPY = e.clientY - capT - capDY;
      if (capPX < 0) capPX = 0;
      if (capPY < 0) capPY = 0;
      if (capPX > CAP_W - CAP_PIECE) capPX = CAP_W - CAP_PIECE;
      if (capPY > CAP_H - CAP_PIECE) capPY = CAP_H - CAP_PIECE;
      capPlace();
      e.preventDefault();
    });

    function capRelease(e) {
      if (!capDrag) return;
      capDrag = false;
      if (capUsed) return;               // V2.14: exactly one drop, ever
      capUsed = true;
      var dx = capPX - capTX, dy = capPY - capTY;
      if (Math.sqrt(dx * dx + dy * dy) <= CAPTCHA_TOL) {
        capPX = capTX; capPY = capTY;
        capPlace();
        solveCaptcha();
      } else {
        banPlayer('captcha-fail');        // no snap-back, no second try
      }
      if (e && e.preventDefault) e.preventDefault();
    }

    on(capPiece, 'pointerup', capRelease);
    on(capPiece, 'pointercancel', capRelease);

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
    /* V2.8: the caller owns every AudioContext there is. Simulation hands one
       down; practice hands down nothing and is therefore silent -- no error
       chord, no context, no autoplay surface at all. The engine no longer
       builds its own under any circumstances. */
    function getCtx() {
      return (audio && audio.ctx) ? audio.ctx : null;
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
      var reap = DELAY(function () {
        var at = errVoices.indexOf(master);
        if (at >= 0) errVoices.splice(at, 1);
        var ti = voiceTimers.indexOf(reap);
        if (ti >= 0) voiceTimers.splice(ti, 1);
        try { master.disconnect(); } catch (e) { /* already detached */ }
      }, ERROR_MS + 80);
      voiceTimers.push(reap);
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
      tryStartAudio();
    }

    /* ---------------- layout ---------------- */

    function measure() {
      if (won) return;
      vw = window.innerWidth;
      vh = window.innerHeight;
      // The window's own dimensions do not depend on the viewport, so a resize
      // re-clamps and nothing more. Adopting a fresh measurement on every resize
      // was V2.6's behaviour and was also a way to hand the engine an inflated
      // hitbox; calibrate() now takes exactly one reading, at boot.
      calibrate();
      clampIntoView();
      render();
      checkPlayable();
    }

    function clampIntoView() {
      var hw = cardW / 2, hh = cardH / 2;
      var minX = hw + EDGE_PAD, maxX = vw - hw - EDGE_PAD;
      var minY = hh + EDGE_PAD, maxY = vh - hh - EDGE_PAD;
      // If the viewport is smaller than the card there is no legal band; park it
      // centered. Unreachable during play now that playable() gates the run, but
      // kept as the safety net it always was.
      x = (maxX > minX) ? Math.min(maxX, Math.max(minX, x)) : vw / 2;
      y = (maxY > minY) ? Math.min(maxY, Math.max(minY, y)) : vh / 2;
    }

    /* Ruling 3. Below this the card has nowhere to flee: the legal band collapses,
       the engine parks it dead centre and the chase stops being a chase. That is
       reachable without any tooling -- a half-height window, or Ctrl+= to 500%,
       which divides the CSS viewport and froze the card outright. Rather than
       let a pinned playfield produce a "record", the run pauses behind a Win95
       dialog with the clock stopped, and resumes untouched when the window comes
       back. No accusation: resizing a browser is not cheating. */
    function playable() {
      return vw >= cardW + 2 * EDGE_PAD + PLAY_MARGIN &&
             vh >= cardH + 2 * EDGE_PAD + PLAY_MARGIN;
    }

    function enterPause() {
      if (paused || won || stopped) return;
      paused = true;
      pauseAt = NOW();
      pauseWall = WALL();
      pauseWall2 = wall2();
      pauseBox.classList.remove('hide');
    }

    function leavePause() {
      if (!paused) return;
      paused = false;
      pauseBox.classList.add('hide');
      // Every clock the engine keeps skips the paused interval, so a pause can
      // neither pad a time nor read as drift when the run continues.
      var d = NOW() - pauseAt;
      if (started && d > 0) {
        shStartT.set(shStartT.get() + d);
        startWall += WALL() - pauseWall;
        startWall2 += wall2() - pauseWall2;
      }
      clkLast = null; clkPair = -1; clkStill = 0;
      audioT0 = -1; audioBad = 0;
      accumMs = 0;
      simT = NOW();
      lastT = NOW();
    }

    function checkPlayable() {
      if (won || stopped) return;
      if (playable()) leavePause(); else enterPause();
    }

    function render() {
      // Integer pixels, or the two-step bevel subpixel-blurs into a soft
      // approximation of Win95 chrome. x/y stay float in the physics; only the
      // paint is rounded, which is at most 0.5px per axis and well inside POS_TOL.
      wrap.style.transform =
        'translate3d(' + Math.round(x - cardW / 2) + 'px,' + Math.round(y - cardH / 2) + 'px,0)';
      if (tauntOn) placeTaunt();
    }

    /* The taunt is the entire response mechanism of the anti-cheat layer, and it
       used to hang off a 136px window as a 400px nowrap bubble that clipped
       against `overflow: hidden` -- reliably invisible in exactly the corners
       where the endgame is played. It now flips above the card near the bottom
       edge and slides horizontally to stay on screen. Width is cached at show
       time so this reads no layout per frame. */
    function placeTaunt() {
      var half = tauntW / 2;
      var shift = 0;
      if (x - half < 8) shift = 8 - (x - half);
      else if (x + half > vw - 8) shift = (vw - 8) - (x + half);
      taunt.style.marginLeft = Math.round(shift) + 'px';
      if (y + cardH / 2 + 52 > vh) taunt.classList.add('up');
      else taunt.classList.remove('up');
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

    /* hasPointer is the master switch for the whole flee block, and a dispatched
       `blur` or `pointerleave` used to throw it -- one line in the console
       disarmed the physics permanently for zero sus. Only the browser's own
       events may disarm it now, and a blur is only believed when the document
       really did lose focus. */
    function dropPointer(e) {
      if (e && e.isTrusted === false) return;
      hasPointer = false;
      cvx = 0; cvy = 0;
      velT = 0;
      nearInside = false;
    }

    function onBlur(e) {
      if (e && e.isTrusted === false) return;
      if (document.hasFocus && document.hasFocus()) return;
      dropPointer();
    }

    on(window, 'pointermove', function (e) {
      if (capShown) return;                 // V2.12: the playfield is shielded
      var t = NOW();
      setPointer(e.clientX, e.clientY, t);
      // V2.7 layer B: only a trusted move is evidence that a pointer is really
      // there. Dispatched moves still push the physics around, as they always
      // did, but they cannot vouch for a press.
      if (e.isTrusted) {
        moveT = t; moveX = e.clientX; moveY = e.clientY;
        if (firstMoveFrame < 0) firstMoveFrame = framesRun;
      }
    }, { passive: true });

    on(window, 'pointerdown', function (e) {
      if (capShown) return;                 // V2.12: the playfield is shielded
      setPointer(e.clientX, e.clientY, NOW());
      if (!e.isTrusted) return;
      // which device is behind the click that is about to be judged (V2.7 item 1)
      lastPointerType = e.pointerType || '';
      if (e.pointerType === 'touch' || e.pointerType === 'pen') sawTouch = true;
      if (firstMoveFrame < 0) firstMoveFrame = framesRun;
    }, { passive: true, capture: true });

    on(document, 'pointerleave', dropPointer);
    on(window, 'blur', onBlur);

    on(window, 'touchstart', function (e) {
      var t0 = e.touches[0];
      if (!t0 || capShown) return;
      if (e.isTrusted) sawTouch = true;
      setPointer(t0.clientX, t0.clientY, NOW());
    }, { passive: true });

    on(window, 'touchmove', function (e) {
      var t0 = e.touches[0];
      if (!t0 || capShown) return;
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
      if (won || paused || capShown || !e.isTrusted) return;   // the X is inert behind the captcha

      // V2.7 layer B. A mouse cannot press where it is not: the browser streams a
      // pointermove to every position the cursor passes through, so the last
      // trusted move is always at the press point. Touch and pen are exempt -- a
      // tap legitimately arrives with nothing in front of it.
      var refused = (e.pointerType === 'mouse') ? presenceBlock(e.clientX, e.clientY) : '';
      if (refused) {
        if (e.button === 0) presenceBlockAt = NOW();   // only a primary press makes a click
        addMiss(refused);
        // camping is bad play, not tampering, so it costs a miss but never a sus point
        if (refused !== 'camping') sus(refused);
        showTaunt(refused === 'camping' ? TAUNT_CAMP : TAUNT_PRESENCE);
        return;                    // no latch either: the window keeps running
      }

      pressLatch = true;
      pressLatchAt = NOW();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
    });

    // Passes when a trusted move is both recent and nearby, or when the press
    // lands on the pointer's own last known position -- which is what a player
    // who parks the cursor and waits for the window to come to them produces,
    // and what an injected press at an arbitrary coordinate never does.
    /* V2.7 item 1. `pointerType` on the press behind this click is the primary
       signal; Blink's sourceCapabilities.firesTouchEvents is a secondary one for
       clicks synthesised out of a tap. Pen counts as touch. A click with no
       pointer event behind it at all, in a browser that has pointer events, is
       not a mouse either. */
    function inputIsMouse(e) {
      if (lastPointerType && lastPointerType !== 'mouse') return false;
      var sc = e.sourceCapabilities;
      if (sc && sc.firesTouchEvents === true) return false;
      if (HAS_POINTER_EVENTS && !lastPointerType) return false;
      return true;
    }

    // At least two rendered frames between the first pointer event of the run and
    // the winning press. Every human clears this by thousands; a move-down-up
    // burst dispatched in one task clears it by none.
    function journeyOK() {
      return firstMoveFrame >= 0 && (framesRun - firstMoveFrame) >= 2;
    }

    // A rejection, not a verdict: it never latches cheatLogged, so a genuine
    // clock or state verdict later in the run still gets its own line.
    function logReject(kind) {
      LOG('[AIMLAB] CHEAT kind=' + kind);
    }

    /* Returns '' to allow the press, or the reason it was refused. V2.10 bounds
       the snap branch by age: resting a hand mid-play is fine, parking the
       cursor and waiting for the window to arrive under it is not. The active
       350 ms / 150 px branch is unchanged. */
    function presenceBlock(cx, cy) {
      if (moveT <= -1e8) return 'presence';     // no trusted mouse movement at all yet
      var dx = cx - moveX, dy = cy - moveY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var age = NOW() - moveT;
      if (dist <= PRESENCE_SNAP) return (age <= SNAP_STALE_MS) ? '' : 'camping';
      return (age <= PRESENCE_MS && dist <= PRESENCE_PX) ? '' : 'presence';
    }

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
      onTamper(TAUNT_TOOLS, 'devtools-key');
      enterShame();
    }, true);

    /* A long-press on a touchscreen fires contextmenu, so accusing every
       contextmenu told a phone player resting a finger on the playfield that
       they were poking at devtools. Suppress the menu for everyone; only count
       it against a session that has never produced a touch. */
    on(root, 'contextmenu', function (e) {
      if (won) return;
      e.preventDefault();
      if (sawTouch) return;
      onTamper(TAUNT_TOOLS, 'contextmenu');
    });

    on(window, 'click', function (e) {
      if (won || paused || capShown) return;

      // The engine's own dialogs are not the playfield. Dismissing the shame box
      // used to cost the player a miss and an error chord for a dialog the game
      // put in front of them.
      if (shameBox.contains(e.target) || overlay.contains(e.target) ||
          pauseBox.contains(e.target)) return;

      // A press that failed the presence gate already counted as a miss. Whatever
      // click it produces, and wherever that click retargets to, must not count
      // a second time. Only a primary press yields a click at all, so only a
      // primary press arms this -- a middle or right press used to leave the
      // swallow armed and eat the player's next genuine winning click.
      if (NOW() - presenceBlockAt < PRESENCE_SWALLOW_MS) { presenceBlockAt = -1e9; return; }

      // B2: the button has no element children, so anything else claiming to be
      // inside it is an injected overlay, not the close button.
      var onX = (e.target === btn);
      if (onX) {
        // detail > 0 rules out keyboard activation; isTrusted rules out dispatched events
        if (e.isTrusted === true && e.detail > 0) {
          // V2.7 item 1: touch and pen play the game but cannot end it.
          if (!inputIsMouse(e)) {
            logReject('touch');
            showTaunt(TAUNT_TOUCH);
            addMiss('touch');
            return;
          }
          // B6/B7: a real run renders frames between the pointer arriving and the
          // press landing. A single injected burst renders none.
          if (!journeyOK()) {
            logReject('teleport');
            showTaunt(TAUNT_TELEPORT);
            addMiss('teleport');
            sus('teleport');
            return;
          }
          win();
          return;
        }
        showTaunt(TAUNT_FAKE);
        addMiss();
        return;
      }

      addMiss();
      shockwave(e.clientX, e.clientY);
      if (card.contains(e.target)) {
        showTaunt(TAUNTS[Math.floor(rnd() * TAUNTS.length) % TAUNTS.length]);
        burstUntil = NOW() + BURST_MS;
        var s = Math.sqrt(vx * vx + vy * vy);
        if (s > 1) { vx *= BURST_MUL; vy *= BURST_MUL; }
      }
    }, true);

    /* V2.11. Radial impulse away from where the click landed, measured to the
       nearest point of the card rect so a whiff that grazed the frame hits
       hardest. Added to velocity rather than to position: the cap in step()
       still bounds the result and the wall clamp still contains it, so no
       amount of click-spam can push the window off screen.

       Known tradeoff, accepted: this is a crude steering tool -- a player can
       shove the card away from where they do not want it. It costs a miss every
       time and it makes the card faster, which makes it harder to catch, so
       using it as steering is paying to make your own job worse. */
    function shockwave(cx, cy) {
      if (won || paused || stopped) return;
      var hw = cardW / 2, hh = cardH / 2;
      var gx = (cx < x - hw) ? (x - hw - cx) : ((cx > x + hw) ? (cx - x - hw) : 0);
      var gy = (cy < y - hh) ? (y - hh - cy) : ((cy > y + hh) ? (cy - y - hh) : 0);
      var dist = Math.sqrt(gx * gx + gy * gy);
      if (dist >= SHOCK_RANGE) return;

      var k = 1 - dist / SHOCK_RANGE;
      var mag = SHOCK_IMPULSE * k * k;
      var ox = x - cx, oy = y - cy;
      var ol = Math.sqrt(ox * ox + oy * oy);
      if (ol > 1e-6) { ox /= ol; oy /= ol; }
      else { ox = Math.cos(heading); oy = Math.sin(heading); }

      vx += ox * mag;
      vy += oy * mag;
      var bt = NOW() + SHOCK_BURST_MS;
      if (bt > burstUntil) burstUntil = bt;
    }


    on(again, 'click', function () { window.location.reload(); });
    on(againX, 'click', function () { window.location.reload(); });
    on(shameOk, 'click', function () { shameBox.classList.add('hide'); });

    on(window, 'resize', measure);

    /* ---------------- physics ---------------- */

    function bounce(nx, ny) {
      // n points back into the playfield; vn is negative because we only call this on impact
      var vn = vx * nx + vy * ny;
      vx -= (1 + restNow) * vn * nx;
      vy -= (1 + restNow) * vn * ny;

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

      /* V2.10 -- is this cursor being aimed, or parked? A hand that is actually
         playing sweeps hundreds of pixels; a camper sits in one small patch and
         waits for the window to be delivered. Everything below that treats the
         cursor as an obstacle is gated on this, so an active player's game is
         completely unchanged -- the shield only exists for someone who stopped
         playing. A 2-3 px wiggle never leaves the disc, so it stays camped. */
      if (hasPointer) {
        if (campAt <= -1e8) { campX = px; campY = py; campAt = now; }
        var cmx = px - campX, cmy = py - campY;
        if ((cmx * cmx + cmy * cmy) > CAMP_RADIUS * CAMP_RADIUS) {
          campX = px; campY = py; campAt = now; cursorParked = false;
        } else if (now - campAt > CAMP_MS) {
          cursorParked = true;
        }
      } else {
        cursorParked = false;
      }

      // the close button, which is the thing that must never be handed over
      var bx = x + btnOffX, by = y + btnOffY;
      var cbx = bx - px, cby = by - py;
      var cbd = Math.sqrt(cbx * cbx + cby * cby);
      var cux = (cbd > 1e-6) ? cbx / cbd : Math.cos(heading);
      var cuy = (cbd > 1e-6) ? cby / cbd : Math.sin(heading);

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
        var dodge = dodgeSign * DODGE_GAIN * diffScale * approach * p2;
        ax += -awy * dodge;
        ay += awx * dodge;
      }

      /* V2.9a. A threatened card keeps its energy. Outside the flee radius the
         old 0.93 still applies, so an idle card settles exactly as before; as
         the cursor closes, bounces go almost perfectly elastic and the corner
         stops being a place where speed goes to die. */
      restNow = RESTITUTION + (RESTITUTION_HOT - RESTITUTION) * prox;

      /* V2.9b -- wall-hug escape slide. Pinned against a wall with the cursor
         inside the flee radius, the repulsion vector points into the wall and
         the card has no legal escape along it. Steer along the wall instead.
         The side is pseudo-random but held a quarter second so a player can read
         and cut it off, and it is never chosen into a corner with no room. */
      if (hasPointer && prox > SLIDE_PROX) {
        var dLeft = x - minX, dRight = maxX - x;
        var dTop = y - minY, dBot = maxY - y;
        var nearH = Math.min(dLeft, dRight);
        var nearV = Math.min(dTop, dBot);
        if (Math.min(nearH, nearV) < SLIDE_BAND) {
          // slide along whichever wall is closest: the tangent is its long axis
          var alongY = (nearH <= nearV);
          if (now - slideAt > slideHold) {
            slideAt = now;
            slideHold = SLIDE_HOLD_MIN + rnd() * (SLIDE_HOLD_MAX - SLIDE_HOLD_MIN);
            slideSign = (rnd() < 0.5) ? -1 : 1;
            // never commit to the short end of a corner
            var room = alongY ? (slideSign < 0 ? dTop : dBot)
                              : (slideSign < 0 ? dLeft : dRight);
            if (room < SLIDE_MIN_ROOM) slideSign = -slideSign;
          }

          /* V2.10 -- the slide is what was delivering the X. Look along the
             tangent before committing: if that side would carry the button
             through a camped cursor's clearance, take the other one; if both
             are blocked, leave the wall entirely and arc outward instead of
             running the gauntlet. Against a moving cursor none of this arms. */
          var laX = alongY ? 0 : SLIDE_LOOKAHEAD;
          var laY = alongY ? SLIDE_LOOKAHEAD : 0;
          var posBad = false, negBad = false;
          if (cursorParked) {
            var fpx = (bx + laX) - px, fpy = (by + laY) - py;
            var fnx = (bx - laX) - px, fny = (by - laY) - py;
            posBad = (fpx * fpx + fpy * fpy) < AVOID_SOFT * AVOID_SOFT;
            negBad = (fnx * fnx + fny * fny) < AVOID_SOFT * AVOID_SOFT;
            if (slideSign > 0 && posBad && !negBad) slideSign = -1;
            else if (slideSign < 0 && negBad && !posBad) slideSign = 1;
          }

          if (posBad && negBad) {
            // both ways are through the cursor: peel off the wall and go around
            var outX = alongY ? ((dLeft <= dRight) ? 1 : -1) : 0;
            var outY = alongY ? 0 : ((dTop <= dBot) ? 1 : -1);
            ax += outX * SLIDE_ACCEL * diffScale * prox;
            ay += outY * SLIDE_ACCEL * diffScale * prox;
          } else {
            var slide = SLIDE_ACCEL * diffScale * prox * slideSign;
            if (alongY) ay += slide; else ax += slide;
          }
        }
      }

      /* V2.10 -- the cursor as an obstacle. A camped cursor gets a clearance
         disc the button steers around: a repulsion that grows as it closes, and
         a brake on whatever momentum is carrying the button in. Both are
         accelerations, so the motion stays continuous and nothing teleports. */
      if (cursorParked && cbd < AVOID_SOFT) {
        var av = (AVOID_SOFT - cbd) / AVOID_SOFT;
        ax += cux * AVOID_ACCEL * diffScale * av * av;
        ay += cuy * AVOID_ACCEL * diffScale * av * av;
        var closing = -(vx * cux + vy * cuy);
        if (closing > 0) {
          ax += cux * closing * AVOID_BRAKE;
          ay += cuy * closing * AVOID_BRAKE;
        }
      }

      /* V2.9a, second half. Elastic bounces stop the pocket draining energy, but
         the card can still coast to a crawl on its own. While it is being
         threatened it is pushed back up along its current heading -- smoothly,
         so there is no visible snap -- which is what makes "wait for it to slow
         down, then flick" stop working. Below prox it is untouched, so an
         unthreatened card still drifts at its lazy wander speed. */
      if (hasPointer && prox > FLOOR_PROX) {
        var spNow = Math.sqrt(vx * vx + vy * vy);
        var spFloor = FLOOR_SPEED * diffScale * prox;
        if (spNow > 1 && spNow < spFloor) {
          var boost = (spFloor - spNow) * FLOOR_GAIN;
          ax += (vx / spNow) * boost;
          ay += (vy / spNow) * boost;
        }
      }

      /* V2.9c -- bait and jink. A short lull invites the flick the pocket used
         to reward, then the card cuts hard across the approach. Seeded off the
         same xorshift as everything else, and it only ever adds acceleration --
         there is no teleport here. */
      if (hasPointer && prox > BAIT_PROX_MIN && prox < BAIT_PROX_MAX &&
          baitUntil === 0 && jinkUntil === 0 && now > baitCoolUntil && rnd() < BAIT_CHANCE) {
        baitUntil = now + BAIT_MS;
        jinkSign = (rnd() < 0.5) ? -1 : 1;
      }
      if (baitUntil > 0) {
        if (now < baitUntil) {
          ax -= vx * BAIT_DAMP;                 // the lull
          ay -= vy * BAIT_DAMP;
        } else {
          baitUntil = 0;
          jinkUntil = now + JINK_MS;
        }
      }
      if (jinkUntil > 0) {
        if (now < jinkUntil) {
          var jink = JINK_ACCEL * diffScale * prox * jinkSign;
          ax += -awy * jink;                    // hard across the cursor's line
          ay += awx * jink;
        } else {
          jinkUntil = 0;
          baitCoolUntil = now + BAIT_COOL_MS;
        }
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

      /* V2.10 hard floor. After the cap, remove any velocity component still
         closing on a camped cursor inside AVOID_HARD. This is a projection of
         the velocity, not a move of the card: position stays continuous and the
         wall clamp below is untouched, so containment is unaffected. */
      if (cursorParked && cbd < AVOID_HARD) {
        var closeV = -(vx * cux + vy * cuy);
        if (closeV > 0) { vx += cux * closeV; vy += cuy * closeV; }
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
          nearAt = now;
          bumpNear();
        }
        nearInside = inZone;
      } else {
        nearInside = false;
      }
    }

    /* V2.7 layer A -- fixed-timestep integration.

       The card advances in 8 ms sub-steps whatever the frame rate is, so a
       throttled tab renders a slideshow of a game running at its normal speed
       rather than a game running in slow motion. Eight sub-steps is the ceiling
       for one frame; simulation past that is dropped on the floor, and dropped
       simulation is exactly what a CPU-throttle cheat produces in bulk.

       Two guards keep the debt honest. Frames slower than PAUSE_MS are a pause,
       not a slideshow -- alt-tab, a sleeping laptop, a breakpoint -- and cost
       nothing. Frames faster than SLIDESHOW_MS are ordinary jank and also cost
       nothing; below 8.3 fps is where the ceiling starts billing. Reaching
       LAG_DEBT_MAX therefore takes sustained single-digit frame rates, which no
       machine that can render this page produces by accident.

       Returns the number of sub-steps actually taken. */
    function integrate(dtMs, t) {
      if (!(dtMs > 0)) dtMs = 1000 / 60;

      /* A hidden tab receives no rAF callbacks in any shipping browser, so
         "hidden while animating" is a contradiction and the flag is a lie. It
         used to be cached from an unauthenticated visibilitychange, which made
         two console lines enough to freeze the physics for free. Believe it for
         a handful of frames, then stop. */
      var hidden = !!document.hidden;
      if (hidden) {
        if (++hiddenFrames > 10) hidden = false;
      } else {
        hiddenFrames = 0;
      }

      if (dtMs > PAUSE_MS || hidden) {
        // A genuine pause costs nothing, but a stall *loop* is not alt-tab.
        if (dtMs > PAUSE_MS && !hidden) {
          if (++pauseFrames > 3 && !stallFlagged) {
            stallFlagged = true;
            sus('stall');
            showTaunt(TAUNT_LAG);
          }
        }
        accumMs = 0;                    // a pause is not lag; resync and move on
        simT = t;
        return 0;
      }
      pauseFrames = 0;

      accumMs += dtMs;
      var n = 0;
      while (accumMs >= FIXED_DT_MS && n < MAX_SUBSTEPS) {
        accumMs -= FIXED_DT_MS;
        simT += FIXED_DT_MS;
        step(FIXED_DT, simT);
        n++;
      }

      if (accumMs >= FIXED_DT_MS) {
        var dropped = accumMs - (accumMs % FIXED_DT_MS);
        accumMs -= dropped;
        simT += dropped;                // the clock moved on without the physics
        if (dtMs > SLIDESHOW_MS) lagDebtMs += dropped;
      }

      // Debt is only interesting when it is sustained. A machine that stutters
      // and recovers pays its debt back at 8 ms per healthy frame -- about half a
      // second of credit for every second at 60 fps -- so nothing short of a tab
      // that never recovers can reach the ceiling.
      if (dtMs <= LAG_HEAL_MS && lagDebtMs > 0) {
        lagDebtMs -= LAG_HEAL_STEP;
        if (lagDebtMs < 0) lagDebtMs = 0;
      }
      return n;
    }

    function frame(t) {
      if (stopped) return;
      rafId = RAF(frame);
      framesRun++;

      var dtMs = t - lastT;
      lastT = t;

      // Paused: the picture holds, the clock holds, and nothing is judged.
      if (paused) return;

      integrate(dtMs, t);
      render();
      clockTick();

      if (lagDebtMs > LAG_DEBT_MAX && !lagFlagged) {
        lagFlagged = true;
        sus('lag-debt');
        showTaunt(TAUNT_LAG);
      }

      // Layer D samples between sub-step batches: the transform on screen is the
      // one this frame just drew, so it can be compared against the position the
      // engine integrated to.
      if (CAPTCHA_ON && !capFired && started && t >= capAt) showCaptcha('timer');
      capTick(t);

      if (geomDirty) { geomDirty = false; checkStructure(); attest(); }
      if (--attestIn <= 0) { attestIn = ATTEST_FRAMES; checkStructure(); attest(); }

      if (started) setText(elTime, fmt(t - shStartT.get()));
    }

    /* B5. rAF ids are a page-global integer namespace, so capturing the function
       does not protect the loop it schedules: a sweep cancelling ids 1..400
       stops the engine dead without touching anything the engine owns. This
       heartbeat notices its own main loop has died and restarts it, which makes
       the sweep pointless rather than merely detectable. */
    function heartbeat() {
      if (stopped || won || paused || !started) return;
      if (document.hidden) return;              // no rAF is expected while hidden
      var gap = NOW() - lastT;
      if (gap < LOOP_DEAD_MS) return;
      lastT = NOW();
      accumMs = 0;
      simT = lastT;
      sus('loop-stall');
      showTaunt(TAUNT_LAG);
      rafId = RAF(frame);
    }

    /* ---------------- win ---------------- */

    /* ---- the win signature (V2.7 layer G) ----
       SHA-256 where the browser offers it, a doubled FNV-1a where it does not.
       Either way the console line ends in 16 hex characters that only this build,
       with these three numbers, produces -- so a WIN line pasted into a chat is
       checkable, and a hand-typed one is not. */
    function signWin(ms, m, nm, cb) {
      var msg = ms + '|' + m + '|' + nm + '|' + WIN_SALT;
      if (SUBTLE && TENC) {
        var p = null;
        try { p = SUBTLE('SHA-256', new TENC().encode(msg)); } catch (e) { p = null; }
        if (p && p.then) {
          p.then(function (buf) { cb(hex16(buf)); }, function () { cb(fnv16(msg)); });
          return;
        }
      }
      cb(fnv16(msg));
    }

    function hex16(buf) {
      var b = new Uint8Array(buf), out = '';
      for (var i = 0; i < 8 && i < b.length; i++) out += pad(b[i].toString(16), 2);
      return out;
    }

    function fnv16(s) {
      var h1 = 0x811c9dc5, h2 = 0x9e3779b9;
      for (var i = 0; i < s.length; i++) {
        h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ s.charCodeAt(s.length - 1 - i), 0x85ebca6b) >>> 0;
      }
      return pad(h1.toString(16), 8) + pad(h2.toString(16), 8);
    }

    function logCheat(kind) {
      if (cheatLogged) return;
      cheatLogged = true;
      LOG('[AIMLAB] CHEAT kind=' + kind);
    }

    function win() {
      if (won || banned) return;
      if (!started) startTimer();
      won = true;
      // every published number is read straight out of the closure (V2.6 layer 7),
      // and since V2.7 out of the accessor that guards three copies of it
      finalMs = Math.round(NOW() - shStartT.get());
      var m = shMisses.get();
      var nm = shNear.get();

      CAF(rafId);
      pressLatch = false;
      UNDELAY(tauntTimer);
      taunt.classList.remove('on');
      // drop any transform layer D stamped, or the pop-out keyframes lose to it
      card.style.removeProperty('transform');
      card.classList.add('gone');
      stopAudio();

      // The only two things that void a run: three copies of a number that no
      // longer agree (here or in flappy), and two clocks that no longer agree.
      var kind = (stateBad || opts.stateCheat === true) ? 'state'
               : (clockIsSuspect() ? 'clock' : '');
      var cheated = !!kind;

      if (cheated) {
        logCheat(kind);
        playError();
      } else {
        // Layer G signs asynchronously. The overlay is on a 300 ms delay and a
        // digest of a 40-character string resolves in well under that, so the
        // dialog has never yet rendered before its signature; the console line is
        // emitted from the same callback and so may trail the other lines of the
        // run by a tick.
        signWin(finalMs, m, nm, function (sig) {
          winSig = sig;
          setText(elOvSig, sig.slice(0, 8));
          LOG('[AIMLAB] WIN time_ms=' + finalMs +
              ' misses=' + m +
              ' near_misses=' + nm +
              ' sus=' + susN +
              ' sig=' + sig);
        });
      }

      setText(elTime, fmt(finalMs));

      // Defence in depth behind the pause: the click handler already refuses to
      // act while paused, so this should be unreachable -- but the best-time key
      // is the one thing a pinned playfield must never be able to write.
      var isBest = false;
      if (!cheated && RECORD_BEST && playable()) {
        isBest = (bestMs === null || finalMs < bestMs);
        if (isBest) {
          bestMs = finalMs;
          writeBest(finalMs);
        }
      }
      showBest();

      setText(elOvTime, fmt(finalMs));
      setText(elOvMiss, m);
      setText(elOvNear, nm);
      setText(elOvBest, bestMs === null ? '--' : fmt(bestMs));
      setText(elOvNote, isBest ? 'New best time.' : (RECORD_BEST ? '' : 'Seam run. Not recorded.'));

      // V2.7 layer H: the count is on the dialog only when there is one to show
      if (susN > 0) {
        setText(elOvSus, susN);
        rowOvSus.classList.remove('hide');
      }

      if (cheated) {
        setText(ovTitle, 'eMoney.exe - Cheat detected');
        setText(cheatText, (kind === 'state') ? CHEAT_TEXT_STATE : CHEAT_TEXT_CLOCK);
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
            misses: m,
            nearMisses: nm,
            bestMs: bestMs,
            isBest: isBest,
            cheated: cheated,
            cheatKind: kind,
            sus: susN,
            clockSum: clkSum,
            stateSum: shChain
          });
        } catch (e) { /* a caller's handler must not break the engine */ }
      }
    }

    /* ---------------- teardown ---------------- */

    function stop() {
      if (stopped) return;
      stopped = true;
      CAF(rafId);
      UNEVERY(watchdog);
      UNDELAY(tauntTimer);
      UNDELAY(winTimer);
      UNDELAY(storeTimer);
      for (var vi = 0; vi < voiceTimers.length; vi++) UNDELAY(voiceTimers[vi]);
      voiceTimers.length = 0;
      stopAudio();
      killErrorVoices();
      if (mo) { mo.disconnect(); mo = null; }
      if (mo2) { mo2.disconnect(); mo2 = null; }
      offAll();
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    /* ---------------- boot ---------------- */

    setText(elMode, MODE_LABEL);
    showBest();
    renderSus();                 // only visible if flappy already saw something
    measure();
    on(window, 'load', measure);
    on(img, 'load', measure);
    watchDom();

    // V2.7 layer A: a hidden tab is paused, not throttled, so it never bills debt.
    // integrate() reads document.hidden live and disbelieves it if rAF keeps
    // arriving, so nothing is cached from this event any more.
    on(document, 'visibilitychange', function () {
      if (!document.hidden) { accumMs = 0; lastT = NOW(); }
    });

    if (storeCorrupt) storeTimer = DELAY(function () { showTaunt(TAUNT_STORE); }, 600);

    // V2.7 layer E: taunt only, never a verdict. A modified build is the one
    // finding this engine is not allowed to be sure about.
    if (W.AimlabSentinel && typeof W.AimlabSentinel.check === 'function') {
      W.AimlabSentinel.check(function (verdict) {
        if (verdict !== 'modified' || stopped || won) return;
        sus('build');
        showTaunt(TAUNT_BUILD);
      });
    }

    tryStartAudio();

    lastT = NOW();
    simT = lastT;
    /* Ruling 1: the clock starts when the chase does. Entering a mode is itself a
       deliberate gesture, and starting on first input let a player park the
       cursor, start the run from the keyboard and click a card that had never
       moved -- a two-millisecond "record" with no tampering of any kind. */
    startTimer();
    checkPlayable();
    rafId = RAF(frame);
    watchdog = EVERY(heartbeat, 500);

    return Object.freeze({ stop: stop, setAudio: setAudio });
  }

  // Frozen so the module cannot be edited from the console, and defined as a
  // non-writable property so it cannot be REPLACED either -- Object.freeze alone
  // protects the object, not the binding that points at it, and
  // `window.AimlabChase = {...}` from a sloppy-mode console would otherwise just
  // work. Assignment now fails silently there and throws in strict mode.
  publish(W, 'AimlabChase', Object.freeze({ start: start }));

  function publish(host, name, value) {
    try {
      Object.defineProperty(host, name, {
        value: value, writable: false, configurable: false, enumerable: true
      });
    } catch (e) {
      host[name] = value;      // an environment that will not take the descriptor
    }
  }
})();
