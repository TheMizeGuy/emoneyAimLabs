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
  var RANDOM_VALUES = (W.crypto && W.crypto.getRandomValues)
    ? W.crypto.getRandomValues.bind(W.crypto)
    : null;
  var IMAGE = W.Image || null;

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
    '<div class="hud" data-el="hud" translate="no">',
    '<div class="row mode"><span class="v" data-el="mode">PRACTICE</span></div>',
    '<div class="row time"><span class="k">TIME</span><span class="v" data-el="time">00:00.000</span></div>',
    '<div class="row shot hide" data-el="shotRow"><span class="k">TIME LEFT</span><span class="v" data-el="shotClock">60</span></div>',
    '<div class="row"><span class="k">MISSES</span><span class="v" data-el="miss">0</span></div>',
    '<div class="row"><span class="k">NEAR</span><span class="v" data-el="near">0</span></div>',
    '<div class="row best hide" data-el="bestRow"><span class="k">BEST</span><span class="v" data-el="best">--</span></div>',
    '<div class="tray hide" data-el="susRow"><span class="warn" aria-hidden="true"></span>SUS: <span class="v" data-el="sus">0</span></div>',
    '</div>',
    '<div class="sig">',
    '<h1>eMoney Aim Labs</h1>',
    '<p>Close the popup to win. It has opinions about being closed.</p>',
    '</div>',
    /* V4.0: the Impossible desktop rides in two static layers so opening and
       closing folder windows never churns root's child list (mo2 watches it).
       Icons sit under the popup, their windows over it. Hidden for every other
       mode. */
    '<div class="desk" data-el="desk"></div>',
    '<div class="deskwins" data-el="deskWins"></div>',
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
    '<p class="ovnet hide" data-el="ovNet"></p>',
    '<button class="again hide" data-el="ovBoard" type="button">View leaderboard</button>',
    '<p class="ovsig">SIG <span class="v" data-el="ovSig">--------</span></p>',
    '<p class="ovsus hide" data-el="ovSusRow">Sus events logged: <span data-el="ovSus">0</span></p>',
    '<ul class="ovsuslist hide" data-el="ovSusList"></ul>',
    '<p class="ovsusnote hide" data-el="ovSusNote">Score not submitted to the leaderboard.</p>',
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
    '<p class="captext" data-el="capText">Loading visual verification...</p>',
    '<div class="capscene" data-el="capScene">',
    '<canvas class="capshot" data-el="capCanvas" width="260" height="140"></canvas>',
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
    '<p class="bantitle" data-el="banTitle">RUN FAILED</p>',
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
    '<p class="errtext"><span data-el="pauseL1">This window is too small to run away in.</span><br>',
    '<span data-el="pauseL2">Make the browser bigger to carry on.</span></p>',
    '</div>',
    '<p class="errsub" data-el="pauseSub">Paused. The clock is STILL RUNNING.</p>',
    '</div>',
    '</div>',
    '</div>'
  ].join('');

  function start(container, opts) {
    opts = opts || {};
    container = container || document.body;

    /* ---------------- tuning ---------------- */
    /* V2.2 retune: values marked (v1 N) were raised to make the chase harder.
       V3.7 retune: launch-night reports said the window died in seconds, so
       every evasive term below marked (v2 N) got 15-30 percent. The camping,
       corner and resume guards are deliberately untouched -- harder to catch,
       not harder to be treated fairly. Everything unmarked is v1, unchanged. */
    var FLEE_RADIUS        = 520;    // px, cursor -> nearest point of the card rect     (v2 470)
    var FLEE_ACCEL         = 15500;  // px/s^2 at d = 0, scaled by (1 - d/R)^2           (v2 12500)
    var DODGE_GAIN         = 7.0;    // perpendicular px/s^2 per px/s of cursor approach (v2 5.4)
    var DODGE_APPROACH_CAP = 4200;   // px/s
    var DODGE_HOLD_MS      = 300;    // dodge sign stays put this long so the swerve reads as intent
    var BASE_SPEED         = 230;    // px/s idle wander                                 (v2 190)
    var WANDER_GAIN        = 4.0;    // 1/s, how hard wander steers velocity toward its target
    var SPEED_CAP_FAR      = 2350;   //                                                  (v2 2050)
    var SPEED_CAP_NEAR_ADD = 750;    // FAR + NEAR_ADD lands exactly on the hard cap      (v2 650)
    var SPEED_CAP_HARD     = 3100;   // absolute ceiling, shame mode included             (v2 2700)
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
    var SLIDE_ACCEL        = 8800;   // px/s^2 along the wall, scaled by prox            (v2 7600)
    var SLIDE_HOLD_MIN     = 250;    // ms; the side is held this long so it reads as intent
    var SLIDE_HOLD_MAX     = 350;
    var SLIDE_MIN_ROOM     = 90;     // px; never commit to a side with less room than this
    var BAIT_PROX_MIN      = 0.25;   // the bait only makes sense mid-approach
    var BAIT_PROX_MAX      = 0.80;
    var BAIT_CHANCE        = 0.006;  // per sub-step: a bait-jink every second-and-a-bit  (v2 0.004)
    var BAIT_MS            = 150;    // the lull that invites the flick
    var BAIT_DAMP          = 7.0;    // 1/s of velocity damping during the lull
    var JINK_MS            = 190;    // and the sidestep that answers it
    var JINK_ACCEL         = 11500;  // px/s^2 perpendicular, scaled by prox             (v2 9500)
    var BAIT_COOL_MS       = 900;    // no second bait until this clears
    var FLOOR_PROX         = 0.25;   // being threatened at all arms the no-loiter floor
    var FLOOR_SPEED        = 2900;   // px/s it is pushed back up to, scaled by prox     (v2 2600)
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
    var SHOCK_IMPULSE   = 1600;  // px/s added at zero distance, scaled by (1 - d/range)^2 (v2 1250)
    var SHOCK_BURST_MS  = 600;   // brief burst that stacks with the taunt burst

    /* V3.10 -- one visual challenge per run. Simulation puts it between the
       gauntlet and the scored Chase. Practice has no preceding phase, so its
       challenge arrives at an unpredictable point near the start instead. */
    var CAPTCHA_MIN_MS  = 500;
    var CAPTCHA_MAX_MS  = 1800;
    var CAPTCHA_MISS_MIN = 15;    // or this many misses, rolled per run...
    var CAPTCHA_MISS_MAX = 30;    // ...uniform in [MIN, MAX], whichever comes first
    var CAPTCHA_TOL     = 12;     // forgiving snap radius; candidates are widely separated
    var CAPTCHA_BEAT_MS = 450;    // success beat before the dialog closes
    var CAPTCHA_LIMIT_MS = 60000; // V2.14: the countdown, and one drop only
    var CAPTCHA_ROUNDS = 4;
    var CAP_W = 260, CAP_H = 140, CAP_PIECE = 46;

    /* V2.19 -- the simulation shot clock. Sixty seconds of scored Chase time to
       close the window. Simulation completes verification before Chase starts;
       Practice has neither a shot clock nor a timeout ban. */
    var SHOT_CLOCK_MS = 60000;
    var SHOT_LOW_MS   = 10000;   // the readout reddens here

    /* V2.16 -- hostile resume. The shield marks the cursor absent so the card
       wanders while the dialog is up; without this the engine stayed blind until
       the player's NEXT pointermove, handing them a becalmed card doing idle
       speed with no accumulated approach velocity to dodge against. */
    var WAKE_MS    = 500;    // how long the wake-up shove lasts after a resume
    var WAKE_ACCEL = 9000;   // px/s^2 straight away from the cursor

    /* V3.9 -- the arming gate. Two ways a run could be won while the engine was
       not defending itself, both seen live on launch night:

         1. THE SPAWN GRAB. The card materialised dead centre with zero velocity
            while hasPointer was still false -- and hasPointer is the master
            switch for the entire flee block -- directly under a cursor that had
            just clicked a centred mode button. One wiggle to satisfy presence,
            then a spam-click took it before the physics had ever run.
         2. THE BLUR PARK. Unfocusing the page dropped the pointer, so the card
            stopped fleeing and idled at wander speed. The player lined the
            cursor up on the drifting X and clicked; on macOS that single click
            refocuses the window AND passes through to the page, so the press
            landed against a target that had spent the whole approach asleep.

       Both are the same hole, so both get the same answer: the X is ARMED, not
       merely present. Arming restarts every time the playfield becomes live
       again -- run start, pause exit, captcha resume -- and until it finishes
       the X cannot be won. It costs a miss and a taunt but never a sus point:
       clicking a sleeping engine is bad play, not tampering. */
    var ARM_MS     = 400;    // the field must have been live this long...
    var ARM_FRAMES = 12;     // ...and rendered this many frames...
                             // ...and seen a trusted move since it woke (see armed()).
    var ARM_CLEAR  = 300;    // px of clearance the card takes when it wakes up

    /* V3.9 -- the spam gate, and the reason the arming gate alone was not enough.
       Measured on the launch-night exploit: 30 presses in 515 ms, every one of
       them re-aimed at the X's live position -- about 58 clicks a second. Arming
       only moved that to 755 ms, because the attacker simply kept clicking until
       the window expired. The distinguishing signal is not WHERE the press
       landed, it is the cadence: a hand spamming flat out manages 10-15 clicks a
       second, an elite butterfly-clicker maybe 20, and an autoclicker or a
       scripted pursuit loop runs three times that.

       So the cadence bounds the WIN, not the play: you may click as fast as you
       like, but the press that closes the window has to have arrived at a speed
       a hand could produce. Deliberately generous -- refusing costs a miss and a
       taunt but never a sus point, because a fast mouse is not a confession. */
    var CLICK_MIN_GAP_MS    = 55;    // a win this soon after the previous press is not a hand
    var CLICK_WINDOW_MS     = 1000;
    var CLICK_MAX_IN_WINDOW = 16;    // sustained presses/second a hand can really make
    var BOUNCE_JITTER      = 10 * Math.PI / 180;
    var PANIC_MS           = 260;
    var PANIC_ACCEL        = 5000;                                              // (v2 4000)
    var PANIC_SPEED        = 1100;                                              // (v2 900)
    var BURST_MS           = 1500;
    var BURST_MUL          = 1.6;
    // (v1/V2.6 had DT_MAX = 0.032 s here. V2.7 layer A replaced the variable
    // frame step with a fixed sub-step accumulator, so the per-frame ceiling is
    // now MAX_SUBSTEPS * FIXED_DT_MS and there is nothing left to clamp.)
    var NEAR_RADIUS        = 48;     // px from the close button's center
    var NEAR_DEBOUNCE      = 250;    // ms
    var EDGE_PAD           = 10;     // keeps a margin between the window and the field edge
    var PLAYFIELD_W        = 1120;   // one ranked field size, independent of browser dimensions
    var PLAYFIELD_H        = 620;
    var LATCH_MAX_MS       = 600;    // failsafe so a lost pointerup cannot freeze the card forever
    var BEST_KEY           = (typeof opts.bestKey === 'string' && opts.bestKey) ? opts.bestKey : DEFAULT_BEST_KEY;
    // Which mode the HUD announces. Static per run, so it is re-derived from
    // this constant rather than read back off the node it is printed on.
    var MODE_LABEL         = (typeof opts.modeLabel === 'string' && opts.modeLabel)
                             ? opts.modeLabel.toUpperCase() : 'PRACTICE';
    var RECORD_BEST        = (opts.recordBest !== false);
    var IMPOSSIBLE         = (MODE_LABEL === 'IMPOSSIBLE');

    /* V4.0 -- Impossible. Simulation's window after it stops negotiating.
       Only the EVASIVE terms move: it flees from further away, dodges a flick
       roughly twice as hard, jinks half again as often, and its speed floor
       under threat sits above Simulation's soft cap -- so the flick that ends
       a Simulation run mostly buys a near miss here. The fairness guards
       (camping, arming, resume, presence) are untouched on purpose, per the
       V3.7 rule: harder to catch, never harder to be treated fairly. The
       desktop folders below are the mode's second hazard. */
    if (IMPOSSIBLE) {
      FLEE_RADIUS        = 560;
      FLEE_ACCEL         = 24000;
      DODGE_GAIN         = 12.0;
      DODGE_HOLD_MS      = 180;
      BASE_SPEED         = 290;
      SPEED_CAP_FAR      = 2950;
      SPEED_CAP_NEAR_ADD = 850;
      SPEED_CAP_HARD     = 3800;
      SLIDE_ACCEL        = 12000;
      BAIT_CHANCE        = 0.016;
      BAIT_COOL_MS       = 500;
      JINK_MS            = 230;
      JINK_ACCEL         = 17500;
      FLOOR_SPEED        = 3400;
      SHOCK_IMPULSE      = 2100;
    }

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
    var CLOCK_TOLERANCE_MS = 750;  // allowed disagreement between the TWO WALL references
    /* F3. A wall-clock discontinuity used to VOID the run: closing a laptop lid,
       an NTP correction or a VM resume all freeze performance.now() while
       Date.now() keeps counting, which read as a splice and cost the player
       their time entirely. Those are absorbed as pauses now. What still cannot
       be explained innocently is (a) too many of them, and (b) performance.now()
       drifting away from the rAF timestamp -- the two are the same browser clock,
       so a suspend moves them together and only a shim separates them. Since the
       reported time IS performance.now-based, that is exactly the cheat. */
    var CLOCK_DRIFT_MAX    = 5000; // slow divergence between monotonic and wall
    var CLOCK_REBASE_MAX   = 6;    // absorbed discontinuities before it is a stepper
    var CLOCK_RAF_TOL      = 3000; // performance.now() against the frame timestamp
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
    var LOOP_STALL_GRACE = 2;  // F10: a browser that hiccups once is not an attacker
    var LOOP_STALL_MAX   = 3;  // F10: and it can never be more than this per run
    /* How many frames of a whole run may claim document.hidden before the flag
       is treated as a lie. A hidden tab is a PAUSED one here, so the only honest
       source is the frame that races a visibility change -- one per tab switch.
       A spoof has to claim most frames to be worth anything, so it spends this
       inside two seconds at 60 fps while a player never gets close. */
    var HIDDEN_LIE_FRAMES = 60;

    /* V2.7 layer B -- cursor presence gate on the winning press. */
    var PRESENCE_MS   = 350;   // a trusted move must be this recent...
    var PRESENCE_PX   = 150;   // ...and this close to the press point
    var PRESENCE_SNAP = 2;     // or the press must land on the pointer's own last position
    var PRESENCE_SWALLOW_MS = 400;  // how long a blocked press suppresses its own click
    /* V3.10. `isTrusted` does not mean human: CDP and Playwright both drive the
       native input path. A winning press therefore needs evidence from THIS
       approach, including a pointer sample in the outer aiming band and enough
       real rendered time to cross it. A locator bot that teleports directly to
       the live button centre never produces that middle-band observation. */
    var AIM_RADIUS     = 260;
    var AIM_CLOSE_PX   = 44;
    var AIM_MIN_MS     = 96;
    var AIM_MAX_MS     = 1400;
    var AIM_MIN_FRAMES = 4;

    /* V2.7 layer D -- geometry attestation. */
    var ATTEST_FRAMES = 30;    // roughly twice a second
    var GEOM_SUS_DEBOUNCE_MS = 2000;  // one geometry complaint per this window...
    var GEOM_SUS_MAX         = 5;     // ...and this many in a whole run
    var PRESENCE_SUS_MAX     = 3;     // F11: presence points per run
    var GEOM_TOL      = 2;     // px, box sizes and the button's offset in the frame
    /* F2. The position check used to derive the card's centre from the MEASURED
       box (cr.top + cr.height/2) and compare it against `y` at 1px. On a display
       at 125% or 175% the Win95 chrome snaps to device pixels and the card lays
       out ~1.6px short -- inside GEOM_TOL, so calibrate() refuses to adopt it,
       yet enough to fail the centre test forever. Fractional scaling is the
       Windows default on most laptops, so that was a clean run flagged 4-5x.
       The check now compares the card's rendered ORIGIN against the exact
       integers render() wrote, which is what "did the picture move" actually
       means and never touches a measured height. */
    var DRAW_TOL      = 2;     // px, on-screen origin against the transform we wrote
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
    var TAUNT_ARMING   = 'He is not even awake yet. Wait for him.';
    var TAUNT_SPAM     = 'That is a macro, not a hand. Aim once instead.';
    var TAUNT_FOLDER   = 'You have a folder open. One mess at a time.';
    var TAUNT_AUTOPOP  = 'A folder opened itself. Deal with it.';
    var CHEAT_TEXT_CLOCK = 'Two clocks, two answers. One of them is lying, and it is not ours.';
    var CHEAT_TEXT_STATE = 'Three copies of that number disagree. Ours are the two that match.';

    /* V3.4 block 4b. Every soft detection the engine can raise, in the words the
       player sees on the dialog. Saying "sus events: 3" and nothing else reads
       as an accusation with no evidence; naming the checks is fairer and, since
       these are the same checks a tamperer is poking at, it costs us nothing. */
    var SUS_REASON_MAX = 8;
    var SUS_WORDS = {
      'build':              'SUS: build attestation failed',
      'gauntlet':           'SUS: flagged during the bird gauntlet',
      'geometry-boot':      'SUS: geometry attestation failed at startup',
      'geometry-hidden':    'SUS: target visibility altered',
      'geometry-button':    'SUS: target size altered',
      'geometry-window':    'SUS: window size altered',
      'geometry-offset':    'SUS: target position altered',
      'geometry-transform': 'SUS: display transform detected',
      'structure':          'SUS: window structure altered',
      'geometry-button-children': 'SUS: foreign node inside the target',
      'hud-edit':           'SUS: scoreboard numbers rewritten',
      'presence':           'SUS: click with no pointer behind it',
      'teleport':           'SUS: pointer teleport detected',
      'stall':              'SUS: engine stall detected',
      'hidden-lie':         'SUS: page visibility flag spoofed',
      'lag-debt':           'SUS: frame lag debt exceeded',
      'loop-stall':         'SUS: render loop stalled'
    };

    function susWords(reason) {
      return SUS_WORDS[reason] || ('SUS: ' + String(reason));
    }

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
    var elOvSusList = el('ovSusList');
    var elOvSusNote = el('ovSusNote');
    var cheatText = el('cheatText');
    var pauseBox  = el('pauseBox');
    var pauseL1   = el('pauseL1');
    var pauseL2   = el('pauseL2');
    var pauseSub  = el('pauseSub');
    var capBox    = el('capBox');
    var capScene  = el('capScene');
    var capCanvas = el('capCanvas');
    var capPiece  = el('capPiece');
    var capText   = el('capText');
    var capClock  = el('capClock');
    var shotRow   = el('shotRow');
    var elShot    = el('shotClock');   // NOT 'shot': that data-el names the card's image holder
    var banBox    = el('banBox');
    var banTitle  = el('banTitle');
    var banSub    = el('banSub');
    var banRetry  = el('banRetry');
    var banHome   = el('banHome');
    var deskEl    = el('desk');
    var deskWins  = el('deskWins');
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
    var elOvNet   = el('ovNet');
    var elOvBoard = el('ovBoard');
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
    var CAPTCHA_ON = true;
    var PRESTART_CHALLENGE = (opts.challengeBeforeStart === true);
    var CAPTCHA_TIMED = !PRESTART_CHALLENGE;
    var SHOT_CLOCK_ON = (MODE_LABEL === 'SIMULATION' || IMPOSSIBLE);
    var shotLeftShown = -1;
    var capBroken = false, capShown = false, capAt = Infinity, capShownAt = 0, capBeatT = 0;
    var capShownWall = 0, capShownWall2 = 0;
    var capCycle = 0, capSolvedCount = 0;
    var capMissTarget = 0, capUsed = false, banned = false, capLeftShown = -1;
    var capHX = 0, capHY = 0, capPX = 0, capPY = 0;
    var capPayload = null, capRound = 0, capAnswers = [], capHoles = [], capLoadGen = 0;
    var capArmed = false, capDrag = false, capDX = 0, capDY = 0, capL = 0, capT = 0;
    /* Where the pointer is while the playfield is shielded. Deliberately
       separate from moveT/moveX/moveY: the physics may know where the cursor is,
       but a drag inside the dialog must never count as presence evidence for a
       winning press. */
    var shieldX = 0, shieldY = 0, shieldSeen = false;
    var wakeUntil = 0;
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

    var lastIsBest = false, lastCheated = false, lastKind = '';
    var lastT = 0, rafId = 0, tauntTimer = 0, winTimer = 0;
    var stopped = false;

    // dual-clock integrity, plus the two independent references that catch a
    // coordinated edit of the first two (B4)
    var startWall = 0, clkDrift = 0, clkLast = null, clkStep = false;
    var clkSum = 0, clkPair = -1, clkStill = 0;
    var clkRebases = 0, rafSkew0 = null;
    var startWall2 = 0;
    var audioT0 = -1, audioWall0 = 0, audioBad = 0;
    var tamperAt = -1e9, shame = 1;
    var mo = null, mo2 = null, geomDirty = false;

    // layer D backoff: a page zoom or a user stylesheet is a mismatch restoreChrome
    // cannot undo, and re-running the repair every frame was a 123/s console flood
    var geomFailStreak = 0, geomSusAt = -1e9, geomSusCount = 0, restoreQuietUntil = 0;
    var loopStalls = 0, loopSusAt = -1e9, loopSusCount = 0;
    var rootW0 = 0, rootH0 = 0;      // F7: the frame of reference outside the card
    /* F2. What render() last wrote, and where the card actually sits relative to
       that (a constant, measured once at calibration). Attesting against these
       tests the picture the engine drew rather than a re-derived centre. */
    var drawnX = 0, drawnY = 0, drawOffX = 0, drawOffY = 0;

    // ruling 3: too small a viewport pauses the run behind a dialog
    var paused = false;
    /* Two independent reasons to hold the run. Kept apart so that resizing the
       window while it is unfocused cannot resume a run nobody is looking at,
       and vice versa: the field is live only when BOTH are clear. */
    var pauseSmall = false, pauseUnfocused = false;
    // When the playfield last became live. The arming gate reads it (V3.9).
    var armAt = -1e9, armFrame = -1e9;
    // Trusted press timestamps inside CLICK_WINDOW_MS, for the spam gate (V3.9).
    var pressTimes = [];

    // B5: the rAF id namespace is page-global, so the loop needs a heartbeat
    var watchdog = 0;

    // B6/B7: a press has to sit inside a run that actually rendered frames
    var framesRun = 0, firstMoveFrame = -1;

    // V2.7 item 1: what kind of pointer is behind the click being judged
    var lastPointerType = '', sawTouch = false;
    var HAS_POINTER_EVENTS = !!W.PointerEvent;

    // F3/F4 physics: a spoofed document.hidden, and stall-loop counting
    var hiddenFrames = 0, hiddenLies = false, pauseFrames = 0, stallFlagged = false;

    // F5 quality: timers that must not outlive stop()
    var storeTimer = 0, voiceTimers = [];

    // taunt placement, recomputed from cached numbers so render() reads no layout
    var tauntOn = false, tauntW = 0;

    // V2.7 layer A: sub-step accumulator and the lag debt it sheds
    var accumMs = 0, simT = 0, lagDebtMs = 0, lagFlagged = false;

    // V2.7 layer B: the last trusted mouse position, and the press that failed the gate
    var moveT = -1e9, moveX = 0, moveY = 0, presenceBlockAt = -1e9;
    var aimAt = -1e9, aimFrame = -1e9, aimLastAt = -1e9;
    var presenceSus = 0;

    // V2.7 layer D: how many frames until the next attestation
    var attestIn = ATTEST_FRAMES;

    // V2.7 layer H: soft detections, seeded with anything flappy already saw
    var susN = (opts.susSeed > 0) ? Math.floor(opts.susSeed) : 0;
    var susSeeded = susN > 0;

    // V2.7 layer G: the win signature, once it has been computed
    var winSig = '';

    // When the caller passes an audio object it owns the AudioContext, so the
    // chase never constructs a second one; practice passes null and owns nothing,
    // so the chase makes its own context lazily inside a miss click.
    var audio = opts.audio || null;
    var audioSource = null, audioStarted = false, audioArmed = false;
    var errVoices = [];

    /* ---------------- helpers ---------------- */

    function strongSeed() {
      if (RANDOM_VALUES && W.Uint32Array) {
        try {
          var words = new W.Uint32Array(1);
          RANDOM_VALUES(words);
          if (words[0] !== 0) return words[0] >>> 0;
        } catch (e) { /* fall through to the mixed-clock fallback */ }
      }
      return (WALL() ^ Math.floor(NOW() * 1000) ^ 0x9e3779b9) >>> 0;
    }

    // Physics is deterministic inside a frame sequence, while every run and
    // every visual puzzle begin from fresh cryptographic entropy where offered.
    var seed = strongSeed();
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
    /* V3.4 block 4b: the player is told WHAT tripped, not just how many times.
       Reasons are kept distinct and in the order they first fired, so a single
       misbehaving check cannot flood the dialog with the same line. */
    var susReasons = [];

    function sus(reason) {
      susN++;
      if (susReasons.length < SUS_REASON_MAX && susReasons.indexOf(reason) < 0) {
        susReasons.push(reason);
      }
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
      if (PRESTART_CHALLENGE) randomizeSpawn();
      // V3.9: the run begins armed-but-not-yet-winnable, and the card takes its
      // clearance from wherever the cursor that pressed the mode button is.
      arm();
      shStartT.set(NOW());
      startWall = WALL();
      startWall2 = wall2();
      simT = NOW();
      // Practice gets one challenge 0.5-1.8 s into Chase. Simulation has already
      // completed its challenge before this timer starts.
      scheduleCaptcha(NOW());
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
      if (!nuisance(text)) return;
      sus(reason);
    }

    /* F4/F5. The same taunt and the same noise, with no sus point. Some things
       are worth answering without being worth an accusation: a right-click (a
       Mac trackpad two-finger tap IS one, with no touch event to exempt it) and
       a devtools shortcut are both ordinary player behaviour, and under the V3.4b
       absolute gate one stray keypress silently cost a real player their score.
       The deterrent was always the taunt. Anyone actually tampering trips
       geometry, structure or state the moment they change anything, which is
       where the detection genuinely lives. Returns false when debounced. */
    function nuisance(text) {
      var t = NOW();
      if (t - tamperAt < TAMPER_DEBOUNCE_MS) return false;
      tamperAt = t;
      showTaunt(text);
      playError();
      return true;
    }

    // Two independent clocks and a rolling checksum over the pair. Backgrounding
    // a tab moves both together, so only a doctored clock separates them.
    function clockTick(rafT) {
      if (!started || won) return;
      var p = NOW() - shStartT.get();
      var w = WALL() - startWall;
      var d = p - w;

      /* F3. A step means the wall clock and the monotonic clock parted company
         in one frame. The player cannot cause that by playing, and a suspend
         causes it every time, so absorb it the way leavePause() absorbs a pause:
         rebase every wall reference onto the monotonic clock and carry on. The
         run keeps the time the player actually played. Only an implausible
         NUMBER of these reads as someone stepping the clock repeatedly. */
      if (clkLast !== null) {
        var jump = d - clkLast;
        if (jump < 0) jump = -jump;
        if (jump > CLOCK_STEP_MS) {
          startWall += (w - p);          // d becomes 0
          startWall2 = wall2() - p;
          audioT0 = -1;
          audioBad = 0;
          if (++clkRebases > CLOCK_REBASE_MAX) clkStep = true;
          w = WALL() - startWall;
          d = p - w;
        }
      }
      var ad = d < 0 ? -d : d;
      if (ad > clkDrift) clkDrift = ad;
      clkLast = d;

      /* The frame timestamp and performance.now() are the same browser clock, so
         their difference is a constant that a suspend cannot move -- both freeze
         and both resume together. A pre-parse shim of performance.now() moves it
         immediately, and since the reported time is derived from performance.now()
         that shim is the only way to actually shorten a run. */
      if (typeof rafT === 'number' && isFinite(rafT)) {
        var skew = NOW() - rafT;
        if (rafSkew0 === null) rafSkew0 = skew;
        else if (Math.abs(skew - rafSkew0) > CLOCK_RAF_TOL) clkStep = true;
      }

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
      return clkStep || clkDrift > CLOCK_DRIFT_MAX;
    }

    // The HUD and the overlay are projections. If anything edits them, re-derive
    // from closure state; our own writes are already equal, so this never loops.
    /* F8. Every repair used to be an accusation, so Chrome's own translate
       feature, reader modes and grammar extensions -- all of which rewrite text
       nodes -- charged a sus point for rewording a static label. Only the NUMBERS
       are worth defending: they are what a cheat would edit, and a label carries
       no state. Labels are still repaired, silently. */
    function reproject() {
      var values = 0;
      var m = shMisses.get(), nm = shNear.get();
      reassert(elMode, MODE_LABEL);                 // a label: repair, never accuse
      values += reassert(elMiss, m);
      values += reassert(elNear, nm);
      if (susN > 0) values += reassert(elSus, susN);
      if (bestMs !== null) values += reassert(elBest, fmt(bestMs));
      if (won) {
        values += reassert(elTime, fmt(finalMs));
        values += reassert(elOvTime, fmt(finalMs));
        values += reassert(elOvMiss, m);
        values += reassert(elOvNear, nm);
        values += reassert(elOvBest, bestMs === null ? '--' : fmt(bestMs));
        if (winSig) values += reassert(elOvSig, winSig.slice(0, 8));
        if (susN > 0) values += reassert(elOvSus, susN);
      }
      if (values > 0) onTamper(TAUNT_TAMPER, 'hud-edit');
    }

    function reassert(node, v) {
      if (!node) return 0;
      var s = String(v);
      var cur = node.textContent;
      if (cur === s) return 0;
      node.textContent = s;
      // F8: a node whose text only gained or lost surrounding whitespace still
      // says the same thing. Repair it, but do not call it an edit.
      return (cur !== null && String(cur).replace(/\s+/g, ' ').trim() === s) ? 0 : 1;
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
          syncDrawOffset();
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
      }
      syncDrawOffset();
    }

    /* F2. Where the card's border box lands relative to the transform we wrote.
       On a fractional display scale this is a fraction of a pixel rather than
       zero, and it is CONSTANT -- so measuring it once here means attest() can
       compare an absolute on-screen position without ever inheriting the layout
       rounding as an error. Anything that later moves the card really has moved
       it, which is the only thing this check was ever meant to catch. */
    function syncDrawOffset() {
      render();
      var c2 = boxOf(card);
      if (!(c2.width > 0 && c2.height > 0)) return;
      drawOffX = c2.left - drawnX;
      drawOffY = c2.top - drawnY;
      var rr = boxOf(root);
      if (rr.width > 0 && rr.height > 0) { rootW0 = rr.width; rootH0 = rr.height; }
    }

    /* F7. Page zoom, a user stylesheet and accessibility extensions all scale
       the whole interface, and every one of them used to read as an inflated
       hitbox. The tell is WHERE the scale stops: the playfield root is outside
       the card, so an attacker inflating the button or the window leaves it
       alone, while an environment scaling the page moves it by exactly the same
       factor. When every ratio agrees, adopt the new geometry and say nothing --
       a uniformly scaled game is no easier, because the precision it demands
       scales with it. Returns true when the mismatch was environmental. */
    function adoptUniformScale(cr, br) {
      if (!(rootW0 > 0 && rootH0 > 0)) return false;
      var rr = boxOf(root);
      if (!(rr.width > 0 && rr.height > 0)) return false;

      var k = rr.width / rootW0;
      // an unmoved root means whatever changed is inside the card: that is an attack
      if (Math.abs(k - 1) < 0.01) return false;
      if (!(k > 0.2 && k < 5)) return false;

      var ratios = [rr.height / rootH0,
                    cr.width / cardW, cr.height / cardH,
                    br.width / btnW, br.height / btnH];
      for (var i = 0; i < ratios.length; i++) {
        if (Math.abs(ratios[i] - k) > k * 0.04) return false;   // all of it, or none
      }

      cardW = cr.width;
      cardH = cr.height;
      btnW = br.width;
      btnH = br.height;
      btnOffX = (br.left + br.width / 2) - (cr.left + cr.width / 2);
      btnOffY = (br.top + br.height / 2) - (cr.top + cr.height / 2);
      wrap.style.width = cardW + 'px';
      clampIntoView();
      syncDrawOffset();
      geomFailStreak = 0;
      return true;
    }

    function attest() {
      if (won || banned || stopped || !calibrated || paused) return;
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
        } else if (Math.abs(cr.left - (drawnX + drawOffX)) > DRAW_TOL ||
                   Math.abs(cr.top - (drawnY + drawOffY)) > DRAW_TOL) {
          // where the card actually landed against the transform we just wrote
          bad = 'transform';
        }
      }

      if (!bad) { geomFailStreak = 0; return; }

      /* F7: a mismatch in the SIZES may just be the page being zoomed. The
         position check ('transform') is deliberately not routed through here --
         a moved card is a moved card at any scale. */
      if ((bad === 'button' || bad === 'window' || bad === 'offset') &&
          adoptUniformScale(cr, br)) return;

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
      if (won || banned || stopped) return;
      var n = 0;
      // The desk layers come back with their children attached, so deleting
      // the hazard in the elements panel restores every seeded icon and any
      // window still open -- and each seeded icon is re-attested on its own,
      // the same treatment the close button gets.
      n += ensure(root, deskEl, wrap);
      n += ensure(root, deskWins, wrap);
      for (var di = 0; di < deskIcons.length; di++) n += ensure(deskEl, deskIcons[di], null);
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
      if (SHOT_CLOCK_ON) n += ensure(hudEl, shotRow, null);
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

    /* ---------------- V3.11: the visual challenge ----------------
       The server owns the seed, the generated rasters and the four correct
       choices. The browser receives only a punched scene, one loose piece and
       four candidate coordinates per round; there is no local answer to read
       from a closure, DOM node or response field. */
    function validPoint(point) {
      return !!point
        && typeof point.x === 'number' && isFinite(point.x)
        && typeof point.y === 'number' && isFinite(point.y)
        && point.x >= 0 && point.x <= CAP_W - CAP_PIECE
        && point.y >= 0 && point.y <= CAP_H - CAP_PIECE;
    }

    function validRaster(value) {
      return typeof value === 'string'
        && value.indexOf('data:image/png;base64,') === 0
        && value.length <= 512000;
    }

    function validRound(round) {
      return !!round
        && validRaster(round.scene)
        && validRaster(round.piece)
        && Array.isArray(round.holes)
        && round.holes.length === 4
        && round.holes.every(validPoint)
        && validPoint(round.start);
    }

    function validChallenge(payload) {
      return !!payload
        && payload.version === 1
        && Array.isArray(payload.rounds)
        && payload.rounds.length === CAPTCHA_ROUNDS
        && payload.rounds.every(validRound);
    }

    function loadRaster(url) {
      return new Promise(function (resolve) {
        if (!IMAGE) { resolve(null); return; }
        var img = new IMAGE();
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = url;
      });
    }

    function capBuild(round) {
      if (!validRound(round) || !capCanvas || !capPiece || !capCanvas.getContext) {
        return Promise.resolve(false);
      }
      var c = capCanvas.getContext('2d');
      var pc = capPiece.getContext('2d');
      if (!c || !pc) return Promise.resolve(false);
      var loadGen = ++capLoadGen;
      capArmed = false;
      capUsed = false;
      capPiece.style.visibility = 'hidden';
      setText(capText, 'Round ' + (capRound + 1) +
        ' of ' + CAPTCHA_ROUNDS + '. Match the shapes; the piece may be rotated and recolored.');

      return Promise.all([loadRaster(round.scene), loadRaster(round.piece)]).then(function (images) {
        if (
          loadGen !== capLoadGen || !capShown || stopped || banned
          || !images[0] || !images[1]
        ) return false;
        try {
          c.clearRect(0, 0, CAP_W, CAP_H);
          c.drawImage(images[0], 0, 0, CAP_W, CAP_H);
          pc.clearRect(0, 0, CAP_PIECE, CAP_PIECE);
          pc.drawImage(images[1], 0, 0, CAP_PIECE, CAP_PIECE);
        } catch (e) {
          return false;
        }
        capHoles = round.holes.map(function (hole) { return [hole.x, hole.y]; });
        capHX = round.start.x;
        capHY = round.start.y;
        capPX = capHX;
        capPY = capHY;
        capPlace();
        capPiece.style.visibility = 'visible';
        capArmed = true;
        return true;
      });
    }

    function capPlace() {
      capPiece.style.left = capPX + 'px';
      capPiece.style.top = capPY + 'px';
    }

    /* V2.17. Both triggers are re-armed per cycle: a fresh time window, and a
       fresh miss threshold measured from wherever the counter stands now. */
    function scheduleCaptcha(now) {
      if (!CAPTCHA_ON || !CAPTCHA_TIMED || capBroken || capSolvedCount > 0) return;
      capAt = now + CAPTCHA_MIN_MS + rnd() * (CAPTCHA_MAX_MS - CAPTCHA_MIN_MS);
      capMissTarget = shMisses.get() + CAPTCHA_MISS_MIN +
        Math.floor(rnd() * (CAPTCHA_MISS_MAX - CAPTCHA_MISS_MIN + 1));
    }

    function showCaptcha(reason) {
      if (!CAPTCHA_ON || capBroken || capShown || won || stopped || banned) return;
      // Disarm both triggers for the duration. Nothing becomes draggable until
      // the authenticated start request returns four well-formed server rasters.
      capAt = Infinity;
      capMissTarget = 0;
      capCycle++;
      capShown = true;
      capArmed = false;
      capPayload = null;
      capRound = 0;
      capAnswers = [];
      capHoles = [];
      capShownAt = NOW();
      capShownWall = WALL();
      capShownWall2 = wall2();
      capUsed = false;
      capLeftShown = -1;
      capClock.classList.remove('low');
      setText(capClock, Math.round(CAPTCHA_LIMIT_MS / 1000));
      setText(capText, 'Loading visual verification...');
      capPiece.style.visibility = 'hidden';
      capBox.classList.remove('hide');
      dropPointer();                 // the card carries on as if the cursor had left
      LOG('[AIMLAB] CAPTCHA SHOWN reason=' + reason);
      Promise.resolve(challengeSignal('start', { cycle: capCycle })).then(function (payload) {
        if (!capShown || stopped || banned) return;
        if (payload && payload.unranked === true) {
          setText(capText, 'Leaderboard unavailable. Continuing as an unranked run.');
          acceptChallenge(true);
          return;
        }
        if (payload && payload.refused) {
          if (payload.error === 'challenge_retry_later') {
            banPlayer('challenge-retry', payload.retryAfterSeconds);
            return;
          }
          /* Every other refusal used to fall through to captcha-fail, which
             tells the player "That is not where the piece goes." about a puzzle
             that never rendered and posts a public ban line under their name.
             It is reachable honestly: a Practice run paused past the server's
             challenge-offset window comes back with challenge_wrong_phase, which
             is a player losing a race rather than answering wrongly. Carry on
             unranked instead. The server still requires a completed challenge,
             so the score is refused with challenge_required rather than
             credited -- nothing rankable is gained by never seeing the puzzle. */
          setText(capText, 'Verification unavailable. Continuing as an unranked run.');
          acceptChallenge(true);
          return;
        }
        if (!validChallenge(payload)) { banPlayer('captcha-fail'); return; }
        capPayload = payload;
        capBuild(payload.rounds[0]).then(function (built) {
          if (!built && capShown && !stopped && !banned) banPlayer('captcha-fail');
        });
      }, function () { banPlayer('captcha-fail'); });
    }

    function acceptChallenge(unranked) {
      if (!capShown || capSolvedCount > 0) return;
      var solveMs = Math.round(NOW() - capShownAt);
      // Verification is mandatory but not part of a Practice score. Move all
      // three captured clock origins together so the displayed/attested timer
      // resumes from the instant the puzzle appeared. The server independently
      // subtracts its own challenge timestamps from the eligible window.
      if (CAPTCHA_TIMED && started && solveMs > 0) {
        shStartT.set(shStartT.get() + solveMs);
        startWall += WALL() - capShownWall;
        startWall2 += wall2() - capShownWall2;
        clkLast = null; clkPair = -1; clkStill = 0; rafSkew0 = null;
      }
      capSolvedCount++;
      LOG('[AIMLAB] CAPTCHA SOLVED ms=' + solveMs + ' unranked=' + (unranked ? 1 : 0));
      capBeatT = NOW() + CAPTCHA_BEAT_MS;
      capPiece.classList.add('solved');
      capBox.classList.add('solved');
    }

    function solveCaptcha() {
      if (!capShown || capAnswers.length !== CAPTCHA_ROUNDS) return;
      capArmed = false;
      setText(capText, 'Checking all four matches...');
      var solveMs = Math.round(NOW() - capShownAt);
      Promise.resolve(challengeSignal('solve', {
        cycle: capCycle,
        solveMs: solveMs,
        answers: capAnswers.slice()
      })).then(function (result) {
        if (!capShown || stopped || banned) return;
        if (result && result.solved === true) { acceptChallenge(false); return; }
        /* Only the server's own verdict may fail a player here. net.js collapses
           a timeout, a 5xx, an expired session and the dead-backend cooldown
           into the same empty answer, which is indistinguishable from a wrong
           drop -- so a network blip used to ban somebody who had just solved all
           four rounds, and say so on the public feed. A refusal is a verdict; no
           answer at all is not, and it continues unranked. The server never saw
           a completed challenge either way, so it holds the score to
           challenge_required. */
        if (result && result.refused === true) {
          banPlayer(result.error === 'challenge_expired' ? 'captcha-timeout' : 'captcha-fail');
          return;
        }
        setText(capText, 'Verification unavailable. Continuing as an unranked run.');
        acceptChallenge(true);
      }, function () { banPlayer('captcha-fail'); });
    }

    function challengeSignal(stage, detail) {
      if (typeof opts.onChallenge !== 'function') return null;
      try { return opts.onChallenge(stage, detail || {}); }
      catch (e) { return null; /* game stays live */ }
    }

    function captchaComplete() {
      return capSolvedCount > 0;
    }

    /* V2.16. Hand the engine the cursor back the instant the dialog closes, so
       flee is live on the very next sub-step rather than on the player's next
       mouse movement, and shove the card away once so the resume costs them
       ground instead of gifting it. setPointer zeroes the smoothed approach
       velocity, which is correct: nothing was being tracked while shielded. */
    function resumeFromShield(now) {
      if (!shieldSeen) return;
      setPointer(shieldX, shieldY, now);        // hasPointer = true, same frame
      campX = shieldX; campY = shieldY; campAt = now; cursorParked = false;
      // V3.9: arm() carries the wake shove now, and adds the clearance and the
      // winnability gate a hostile resume wants just as much as a fresh run.
      arm();
    }

    /* V2.14. A failed verification ends the run: the audio stops, the captcha
       closes and the ban overlay takes the screen. Neither button is a win path,
       so neither is presence-gated -- any trusted click is enough. */
    function banPlayer(reason, retryAfterSeconds) {
      if (banned || won || stopped) return;
      banned = true;
      /* The run is over, so the loop that defends it stops with it -- win() has
         always ended the same way. Left running, it kept attesting geometry and
         charging sus points against a finished run, and kept integrating a card
         nobody can see behind an opaque failure screen. */
      CAF(rafId);
      capLoadGen++;
      capShown = false;
      capArmed = false;
      capDrag = false;
      capBeatT = 0;
      capBox.classList.add('hide');
      stopAudio();
      killErrorVoices();
      setText(banTitle, reason === 'challenge-retry' ? 'PLEASE WAIT' : 'RUN FAILED');
      setText(banSub, (reason === 'challenge-retry')
        ? 'Too many recent mismatches. Try a fresh run in ' +
          Math.max(1, Number(retryAfterSeconds) || 1) + ' seconds.'
        : (reason === 'timeout')
          ? 'Sixty seconds. The window outlasted you.'
          : (reason === 'captcha-timeout')
            ? 'You ran out of time.'
            : 'That is not where the piece goes.');
      banBox.classList.remove('hide');
      LOG('[AIMLAB] RUN FAILED reason=' + reason);

      /* V3.5. Tell the shell how this ended, so the run history and the public
         feed can name the reason. Cosmetic only -- it cannot affect a score --
         and, like every other opts callback, a throw here must not derail the
         ban screen. */
      if (typeof opts.onBan === 'function') {
        try { opts.onBan(reason); } catch (e) { /* never blocks the overlay */ }
      }
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
        capArmed = false;
        capDrag = false;
        capBox.classList.add('hide');
        capBox.classList.remove('solved');
        capPiece.classList.remove('solved');
        resumeFromShield(now);
        if (PRESTART_CHALLENGE && !started) {
          function beginVerifiedChase() {
            if (!started && !stopped && !banned) startTimer();
          }
          // reportChallenge resolves only after the solve and the urgent
          // chase:true heartbeat have settled, so server and local clocks begin
          // in the same order even on a slow connection.
          Promise.resolve(challengeSignal('ready', { cycle: capCycle }))
            .then(beginVerifiedChase, beginVerifiedChase);
        } else {
          challengeSignal('ready', { cycle: capCycle });
        }
        scheduleCaptcha(now);            // a solved one-time challenge does not re-arm
      }
    }

    // Trusted pointer only, so a dispatched drag solves nothing. Touch is
    // welcome here: solving the captcha is not winning the game.
    on(capPiece, 'pointerdown', function (e) {
      if (!capShown || !capArmed || capBeatT > 0 || !e.isTrusted) return;
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
      if (capUsed) return;               // exactly one ANSWER per server round
      var choice = -1, nearest = Infinity;
      for (var i = 0; i < capHoles.length; i++) {
        var dx = capPX - capHoles[i][0], dy = capPY - capHoles[i][1];
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < nearest) { nearest = distance; choice = i; }
      }
      /* Letting go anywhere else is not an answer, it is a slip. The piece holds
         pointer capture for the whole drag, so releasing early -- crossing the
         scene, catching the edge of the dialog, a trackpad that lets go on its
         own -- used to land here, miss every candidate, and end the run on the
         spot with "That is not where the piece goes." Put it back and let them
         pick it up again. Committing to a candidate is still one shot: the
         branch below consumes the attempt whether the choice is right or wrong,
         so nothing is learned by trying, and the answers still travel as one
         batch the server grades at the end. */
      if (!(choice >= 0 && nearest <= CAPTCHA_TOL)) {
        capPX = capHX;
        capPY = capHY;
        capPlace();
        if (e && e.preventDefault) e.preventDefault();
        return;
      }
      capUsed = true;
      capArmed = false;
      capPX = capHoles[choice][0];
      capPY = capHoles[choice][1];
      capPlace();
      capAnswers.push(choice);
      if (capRound + 1 < capPayload.rounds.length) {
        capRound++;
        capPiece.style.visibility = 'hidden';
        capBuild(capPayload.rounds[capRound]).then(function (built) {
          if (!built && capShown && !stopped && !banned) banPlayer('captcha-fail');
        });
      } else {
        solveCaptcha();
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

    function playBounds() {
      var hw = cardW / 2, hh = cardH / 2;
      var fieldLeft = (vw - PLAYFIELD_W) / 2;
      var fieldTop = (vh - PLAYFIELD_H) / 2;
      return {
        minX: fieldLeft + hw + EDGE_PAD,
        maxX: fieldLeft + PLAYFIELD_W - hw - EDGE_PAD,
        minY: fieldTop + hh + EDGE_PAD,
        maxY: fieldTop + PLAYFIELD_H - hh - EDGE_PAD
      };
    }

    function clampIntoView() {
      var bounds = playBounds();
      // If the viewport is smaller than the card there is no legal band; park it
      // centered. Unreachable during play now that playable() gates the run, but
      // kept as the safety net it always was.
      x = (bounds.maxX > bounds.minX)
        ? Math.min(bounds.maxX, Math.max(bounds.minX, x)) : vw / 2;
      y = (bounds.maxY > bounds.minY)
        ? Math.min(bounds.maxY, Math.max(bounds.minY, y)) : vh / 2;
    }

    function spawnCoordinate(min, max, unit, fallback) {
      return (max > min) ? min + unit * (max - min) : fallback;
    }

    // Simulation does not inherit the centred placeholder that sat behind the
    // Flappy handoff. Once verification closes, draw fresh browser entropy and
    // sample both axes independently across the entire legal play band.
    function randomizeSpawn() {
      var bounds = playBounds();
      seed = strongSeed();
      x = spawnCoordinate(bounds.minX, bounds.maxX, rnd(), vw / 2);
      y = spawnCoordinate(bounds.minY, bounds.maxY, rnd(), vh / 2);
      heading = rnd() * Math.PI * 2;
      vx = 0;
      vy = 0;
      render();
    }

    /* Ruling 3. Every ranked run uses the same centred field. A smaller browser
       (or browser zoom, which shrinks the CSS viewport) pauses instead of making
       the escape area easier; a larger browser adds scenery, not room to flee. */
    function playable() {
      return vw >= PLAYFIELD_W && vh >= PLAYFIELD_H;
    }

    function enterPause() {
      if (paused || won || stopped) return;
      paused = true;
      pauseBox.classList.remove('hide');
    }

    function leavePause() {
      if (!paused) return;
      paused = false;
      /* V3.9: coming back from a pause is exactly the situation the arming gate
         exists for -- most of all the unfocused one, where the very click that
         restores focus also lands on the page. */
      arm();
      pauseBox.classList.add('hide');
      /* Every pause keeps costing wall-clock time. Otherwise a resized client
         can bank arbitrarily long timer-free intervals while the server sees a
         live run, then claim a shorter score. The fixed field makes the pause
         fair; the two-sided server clock makes it enforceable. */
      clkLast = null; clkPair = -1; clkStill = 0; rafSkew0 = null;
      audioT0 = -1; audioBad = 0;
      accumMs = 0;
      simT = NOW();
      lastT = NOW();
    }

    /* One resolver for both reasons. The dialog says which one is holding the
       run, so an unfocused pause never reads as a window-size complaint. */
    function refreshPause() {
      if (won || stopped) return;
      pauseSmall = !playable();
      if (pauseSmall || pauseUnfocused) {
        if (pauseSmall) {
          setText(pauseL1, 'This window is too small to run away in.');
          setText(pauseL2, 'Make the browser bigger to carry on.');
        } else {
          setText(pauseL1, 'He does not perform for an empty room.');
          setText(pauseL2, 'Click back into the window to carry on.');
        }
        setText(pauseSub, 'Paused. The clock is STILL RUNNING.');
        enterPause();
        return;
      }
      leavePause();
    }

    function checkPlayable() { refreshPause(); }

    /* V3.9. Wakes the playfield: restarts the arming clock and shoves the card
       clear of wherever the cursor was last seen, so a run never begins -- and
       never resumes -- with the X sitting under a waiting pointer. The shove is
       the same WAKE the captcha resume uses, plus a one-off displacement when
       the card is already inside the clearance radius, because acceleration
       alone cannot undo a zero-distance start. */
    function arm() {
      var now = NOW();
      resetAimTrail();
      armAt = now;
      armFrame = framesRun;
      wakeUntil = now + WAKE_MS;

      // Idle wander speed from the first frame: a stationary spawn was half the
      // spawn grab, since the card had to accelerate from nothing.
      if ((vx * vx + vy * vy) < 1) {
        vx = Math.cos(heading) * BASE_SPEED;
        vy = Math.sin(heading) * BASE_SPEED;
      }
      if (!hasPointer) return;

      var dx = x - px, dy = y - py;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d >= ARM_CLEAR) return;
      if (d < 1e-6) { dx = Math.cos(heading); dy = Math.sin(heading); d = 1; }
      var ux = dx / d, uy = dy / d;
      // Move to the clearance ring, then let the wall clamp put it back in play.
      x = px + ux * ARM_CLEAR;
      y = py + uy * ARM_CLEAR;
      clampIntoView();
      var s = Math.sqrt(vx * vx + vy * vy);
      if (s < BASE_SPEED) { vx = ux * BASE_SPEED; vy = uy * BASE_SPEED; }
    }

    /* The X is winnable only once the field has been live long enough to have
       actually defended itself: real time, rendered frames, and a trusted move
       made SINCE it woke. The last clause is the one that stops a refocusing
       click, whose pointer evidence all predates the resume. */
    function armed() {
      return (NOW() - armAt) >= ARM_MS
          && (framesRun - armFrame) >= ARM_FRAMES
          && moveT > armAt;
    }

    /* True when the press that is about to win arrived at a rate a hand could
       produce: not on the heels of the previous one, and not out of a burst
       that has been running faster than a hand all second. */
    function cadenceOK() {
      var n = pressTimes.length;
      if (n >= 2 && (pressTimes[n - 1] - pressTimes[n - 2]) < CLICK_MIN_GAP_MS) return false;
      return n <= CLICK_MAX_IN_WINDOW;
    }

    function render() {
      // Integer pixels, or the two-step bevel subpixel-blurs into a soft
      // approximation of Win95 chrome. x/y stay float in the physics; only the
      // paint is rounded, which is at most 0.5px per axis and well inside POS_TOL.
      drawnX = Math.round(x - cardW / 2);
      drawnY = Math.round(y - cardH / 2);
      wrap.style.transform = 'translate3d(' + drawnX + 'px,' + drawnY + 'px,0)';
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

    function resetAimTrail() {
      aimAt = -1e9;
      aimFrame = -1e9;
      aimLastAt = -1e9;
    }

    function recordAimMove(cx, cy, t) {
      if (paused || capShown || won || stopped) { resetAimTrail(); return; }
      var dx = cx - (x + btnOffX), dy = cy - (y + btnOffY);
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > AIM_RADIUS) { resetAimTrail(); return; }
      // Direct automation that reads the current rect and jumps straight to its
      // centre reports d ~= 0 only, so a middle-band point is the whole test.
      // Two of them are kept: the FIRST is the evidence that crossing the band
      // took real time and real frames, the LATEST is the evidence that this is
      // the approach being judged rather than one from a minute ago.
      if (d > AIM_CLOSE_PX) {
        aimLastAt = t;
        if (aimAt <= -1e8) {
          aimAt = t;
          aimFrame = framesRun;
        }
      }
    }

    /* One timestamp had to clear the minimum age AND the maximum age at once,
       and the pointer is only ever pulled out past AIM_RADIUS by a player who
       gives up on the window. So any endgame that stayed inside 260 px for more
       than AIM_MAX_MS refused EVERY winning click as a teleport, for as long as
       it lasted -- the commonest way to finish this game. The maximum now reads
       the newest observation and the minimum still reads the oldest, which is
       what each of them was always asking about. */
    function aimJourneyOK() {
      var now = NOW();
      return aimAt > -1e8
          && (now - aimAt) >= AIM_MIN_MS
          && (now - aimLastAt) <= AIM_MAX_MS
          && (framesRun - aimFrame) >= AIM_MIN_FRAMES;
    }

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
      resetAimTrail();
    }

    /* V3.9. Losing focus used to just drop the pointer, which disarmed the whole
       flee block and left the card idling for anyone who wanted to line up on it
       from outside the window. An unfocused playfield is now a PAUSED one: the
       X goes inert and coming back re-arms, while the run and shot clocks keep
       charging the time spent away. Still no accusation -- alt-tabbing is not
       cheating, but it cannot bank a frozen attempt either. */
    function onBlur(e) {
      if (e && e.isTrusted === false) return;
      if (document.hasFocus && document.hasFocus()) return;
      dropPointer();
      pauseUnfocused = true;
      refreshPause();
    }

    function onFocus(e) {
      if (e && e.isTrusted === false) return;
      pauseUnfocused = false;
      refreshPause();
    }

    on(window, 'pointermove', function (e) {
      if (capShown) {                       // V2.12: the playfield is shielded
        // physics-only: remembered so the resume is not blind (V2.16)
        if (e.isTrusted) { shieldX = e.clientX; shieldY = e.clientY; shieldSeen = true; }
        return;
      }
      var t = NOW();
      setPointer(e.clientX, e.clientY, t);
      // V2.7 layer B: only a trusted move is evidence that a pointer is really
      // there. Dispatched moves still push the physics around, as they always
      // did, but they cannot vouch for a press.
      if (e.isTrusted) {
        recordAimMove(e.clientX, e.clientY, t);
        moveT = t; moveX = e.clientX; moveY = e.clientY;
        if (firstMoveFrame < 0) firstMoveFrame = framesRun;
      }
    }, { passive: true });

    on(window, 'pointerdown', function (e) {
      if (capShown) {                       // V2.12: the playfield is shielded
        if (e.isTrusted) { shieldX = e.clientX; shieldY = e.clientY; shieldSeen = true; }
        return;
      }
      setPointer(e.clientX, e.clientY, NOW());
      if (!e.isTrusted) return;
      /* V3.9: every trusted press is remembered, wherever it landed -- the spam
         gate measures the hand, and a pursuit loop misses far more than it hits,
         so counting only the presses that found the X would measure nothing. */
      var pt = NOW();
      pressTimes.push(pt);
      while (pressTimes.length && (pt - pressTimes[0]) > CLICK_WINDOW_MS) pressTimes.shift();
      // which device is behind the click that is about to be judged (V2.7 item 1)
      lastPointerType = e.pointerType || '';
      if (e.pointerType === 'touch' || e.pointerType === 'pen') sawTouch = true;
      if (firstMoveFrame < 0) firstMoveFrame = framesRun;
    }, { passive: true, capture: true });

    on(document, 'pointerleave', dropPointer);
    on(window, 'blur', onBlur);
    on(window, 'focus', onFocus);
    // A tab switch does not always deliver blur; visibility always changes.
    on(document, 'visibilitychange', function () {
      if (document.hidden) { dropPointer(); pauseUnfocused = true; }
      else if (document.hasFocus && document.hasFocus()) pauseUnfocused = false;
      refreshPause();
    });

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

    /* ---------------- V4.0: the Impossible desktop ----------------
       Folders seeded across the field behind the popup. A click on one is a
       desktop click like any other, so the shared handler below charges it a
       miss and a shockwave -- and it ALSO opens an empty Explorer window at a
       random spot, which must be closed before the X can be won. The open
       count is closure state: deleting a window node in devtools does not
       close it, it just leaves the X refusing forever. All annoyance, never a
       wall the server relies on -- the run and shot clocks charge throughout,
       and closing a window costs nothing but the trip. */
    var FOLDER_COUNT   = 10;
    var FW_W = 300, FW_H = 210; // the folder window, chrome included
    var FOLDER_NAMES = ['New Folder', 'New Folder (2)', 'New Folder (3)',
                        'My Documents', 'DO NOT OPEN', 'taxes 1997',
                        'backup (final)', 'backup (final) FINAL',
                        'eMoney private', 'sim results OLD', 'untitled',
                        'wedding pics 2003'];
    /* V4.1: the desktop opens folders on its own. Every few seconds of live
       Chase a random closed folder pops its window over the field -- same
       economy as a clicked one: it usually lands right on the X, but the way
       out stays free, the server never checks, and it never charges a miss
       the player did not click for. */
    var FOLDER_POP_MIN_MS = 4000, FOLDER_POP_MAX_MS = 7000;
    var nextFolderPopAt = 0;
    var foldersOpen = 0;
    var folderReg = [];          // {name, holder} per icon, for the auto-opener
    var deskIcons = [];          // seeded nodes, so checkStructure can re-attest them

    function deskLive() {
      return IMPOSSIBLE && !won && !banned && !paused && !capShown && !stopped;
    }

    /* Fixed chrome the icons must never hide under, in field coordinates at
       the minimum playable viewport -- the one case where the field's origin
       meets the screen's. There the HUD (top-left, z 30, pointer-events none)
       would paint OVER a seeded icon while passing clicks through to it: an
       invisible hazard, which is a worse joke than the visible kind. The sig
       text block has the mirror problem at bottom-left. At larger viewports
       the chrome sits further off-field and these rects merely cost two
       corners. Chrome rejection is HARD -- unlike the icon-gap test it is
       never conceded to a crowded draw. */
    var FOLDER_KEEPOUT = [
      [0, 0, 250, 190],
      [0, 500, 440, 620]
    ];
    var FOLDER_BOX_W = 198, FOLDER_BOX_H = 120; // the icon's own footprint

    function inKeepout(fx, fy) {
      for (var k = 0; k < FOLDER_KEEPOUT.length; k++) {
        var r = FOLDER_KEEPOUT[k];
        if (fx < r[2] && fx + FOLDER_BOX_W > r[0]
            && fy < r[3] && fy + FOLDER_BOX_H > r[1]) return true;
      }
      return false;
    }

    function seedFolders() {
      if (!IMPOSSIBLE || !deskEl || !deskWins) return;
      var names = FOLDER_NAMES.slice();
      var placed = [];
      for (var i = 0; i < FOLDER_COUNT; i++) {
        // Rejection-sampled so icons never stack: the icon-gap test relaxes
        // after enough failed draws (an overlap is only untidy), the chrome
        // keep-out never does, and the last-resort draw comes from a central
        // band that no keep-out touches.
        var fx = 0, fy = 0, ok = false, tries = 0;
        while (!ok && tries++ < 80) {
          fx = 24 + rnd() * (PLAYFIELD_W - 246);
          fy = 16 + rnd() * (PLAYFIELD_H - 162);
          if (inKeepout(fx, fy)) continue;
          ok = true;
          if (tries <= 50) {
            // Exact box separation, not an origin-distance circle: at this
            // icon size a circle wide enough to guarantee no overlap starves
            // the draw, and a narrower one lies about the guarantee.
            for (var j = 0; j < placed.length; j++) {
              var gx = fx - placed[j][0], gy = fy - placed[j][1];
              if (gx > -FOLDER_BOX_W && gx < FOLDER_BOX_W
                  && gy > -FOLDER_BOX_H && gy < FOLDER_BOX_H) { ok = false; break; }
            }
          }
        }
        if (!ok) {
          fx = 300 + rnd() * (PLAYFIELD_W - 520);
          fy = 210 + rnd() * 160;
        }
        placed.push([fx, fy]);
        var pick = Math.floor(rnd() * names.length) % names.length;
        var name = names.splice(pick, 1)[0];
        var made = folderIcon(name, fx, fy);
        deskIcons.push(made.node);
        folderReg.push({ name: name, holder: made.holder });
        deskEl.appendChild(made.node);
      }
      deskEl.classList.add('on');
      deskWins.classList.add('on');
    }

    function folderIcon(name, fx, fy) {
      var f = document.createElement('div');
      f.className = 'fold';
      f.style.left = Math.round(fx) + 'px';
      f.style.top = Math.round(fy) + 'px';
      var ic = document.createElement('span');
      ic.className = 'foldic';
      f.appendChild(ic);
      var lb = document.createElement('span');
      lb.className = 'foldlb';
      lb.textContent = name;
      f.appendChild(lb);
      // One window per folder at a time; re-clicking while it is open only
      // costs the miss the shared handler already charged.
      var holder = { open: false };
      on(f, 'click', function (e) {
        if (!e.isTrusted || !deskLive() || holder.open) return;
        holder.open = true;
        openFolderWindow(name, holder, false);
      });
      return { node: f, holder: holder };
    }

    function openFolderWindow(name, holder, auto) {
      var fw = document.createElement('div');
      fw.className = 'fw';
      // Parked on the chase, not in a corner: the window lands jittered around
      // the card's current position, exactly where the player is looking. The
      // desk layer shares the field's centring, so client coords convert by
      // the same origin playBounds() uses.
      var fx = x - (vw - PLAYFIELD_W) / 2 - FW_W / 2 + (rnd() * 200 - 100);
      var fy = y - (vh - PLAYFIELD_H) / 2 - FW_H / 2 + (rnd() * 150 - 75);
      fx = Math.min(PLAYFIELD_W - FW_W - 8, Math.max(8, fx));
      fy = Math.min(PLAYFIELD_H - FW_H - 8, Math.max(8, fy));
      fw.style.left = Math.round(fx) + 'px';
      fw.style.top = Math.round(fy) + 'px';

      var bar = document.createElement('div');
      bar.className = 'fwbar';
      var title = document.createElement('span');
      title.className = 'fwtitle';
      title.textContent = name;
      bar.appendChild(title);
      var fwx = document.createElement('button');
      fwx.className = 'fwx';
      fwx.type = 'button';
      fwx.setAttribute('aria-label', 'Close ' + name);
      bar.appendChild(fwx);
      fw.appendChild(bar);

      var body = document.createElement('div');
      body.className = 'fwbody';
      var msg = document.createElement('p');
      msg.textContent = (name === 'DO NOT OPEN') ? 'You were told.' : 'This folder is empty.';
      body.appendChild(msg);
      fw.appendChild(body);

      foldersOpen++;
      var closed = false;
      on(fwx, 'click', function (e) {
        if (!e.isTrusted || closed) return;
        closed = true;
        holder.open = false;
        foldersOpen--;
        if (fw.parentNode) fw.parentNode.removeChild(fw);
        LOG('[AIMLAB] FOLDER CLOSED name=' + name + ' open=' + foldersOpen);
      });
      deskWins.appendChild(fw);
      LOG('[AIMLAB] FOLDER OPENED name=' + name + ' open=' + foldersOpen
          + (auto ? ' src=auto' : ''));
    }

    /* The auto-opener's clock. The desk being live is the gate; see the call
       in frame() for why it sits ahead of the pause return. */
    function folderPopTick(now) {
      if (!deskLive() || !started) { nextFolderPopAt = 0; return; }
      if (!nextFolderPopAt) {
        nextFolderPopAt = now + FOLDER_POP_MIN_MS
                        + rnd() * (FOLDER_POP_MAX_MS - FOLDER_POP_MIN_MS);
        return;
      }
      if (now < nextFolderPopAt) return;
      nextFolderPopAt = now + FOLDER_POP_MIN_MS
                      + rnd() * (FOLDER_POP_MAX_MS - FOLDER_POP_MIN_MS);
      var closed = [];
      for (var i = 0; i < folderReg.length; i++) {
        if (!folderReg[i].holder.open) closed.push(folderReg[i]);
      }
      if (!closed.length) return;
      var pick = closed[Math.floor(rnd() * closed.length) % closed.length];
      pick.holder.open = true;
      openFolderWindow(pick.name, pick.holder, true);
      // The pop already announces itself twice -- the window and the chord --
      // so it defers to any taunt currently explaining a refused press.
      if (!tauntOn) showTaunt(TAUNT_AUTOPOP);
      playError();
    }

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
        /* F11. Capped: presence was the only sus path with no rate limit, and
           one misbehaving environment could post hundreds of points. Past the
           cap the press is still refused and still taunted -- only the counter
           stops, which is all the gate needs from it. */
        if (refused !== 'camping' && ++presenceSus <= PRESENCE_SUS_MAX) sus(refused);
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
      /* F9. "No trusted move yet" is the same evidential situation as camping --
         a pointer that has not moved -- and camping is already correctly graded
         as bad play rather than tampering. It happens to real players: the
         cursor sits where the mode button was, the window drifts under it, and
         they click. In simulation it also happens on the first press after a
         captcha closes, because moveT updates are dropped while shielded. */
      if (moveT <= -1e8) return 'camping';
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
      nuisance(TAUNT_TOOLS);
      enterShame();            // the run gets harder; the score stays earnable
    }, true);

    /* Suppress the menu for everyone and taunt the mouse users. The old
       sawTouch exemption existed because a long-press on a touchscreen fires
       contextmenu -- but a Mac trackpad two-finger tap fires one with no touch
       event at all, so the exemption never covered the commonest case. It is
       moot now: this costs no sus point either way (F4). */
    on(root, 'contextmenu', function (e) {
      if (won) return;
      e.preventDefault();
      if (sawTouch) return;
      nuisance(TAUNT_TOOLS);
    });

    on(window, 'click', function (e) {
      /* `banned` belongs on this line as much as `won` does. The failure screen
         covers the page and carries two buttons, and every press of one used to
         run the playfield handler below: an [AIMLAB] MISS line after
         [AIMLAB] RUN FAILED, an error chord and a shockwave, all against a run
         that had already ended. */
      if (won || banned || paused || capShown) return;

      // The engine's own dialogs are not the playfield. Dismissing the shame box
      // used to cost the player a miss and an error chord for a dialog the game
      // put in front of them. Folder windows ride the same rule: opening one
      // was the miss; closing it must not be another.
      if (shameBox.contains(e.target) || overlay.contains(e.target) ||
          pauseBox.contains(e.target) || banBox.contains(e.target) ||
          (deskWins && deskWins.contains(e.target))) return;

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
          /* V3.9. Last gate before the win: the field has to have been awake and
             defending. Costs a miss, never a sus point -- see the ARM_* block. */
          if (!armed()) {
            showTaunt(TAUNT_ARMING);
            addMiss('unarmed');
            return;
          }
          // V3.9: and it has to be a hand doing the clicking. See the CLICK_* block.
          if (!cadenceOK()) {
            showTaunt(TAUNT_SPAM);
            addMiss('clickspam');
            return;
          }
          if (!aimJourneyOK()) {
            showTaunt(TAUNT_TELEPORT);
            addMiss('aim-journey');
            return;
          }
          /* V4.0: an open folder window outranks the X. A miss like any other
             refused press, and the shot clock keeps charging the detour. */
          if (foldersOpen > 0) {
            showTaunt(TAUNT_FOLDER);
            addMiss('folder-open');
            return;
          }
          if (!captchaComplete()) {
            showCaptcha('win');
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
      if (won || banned || paused || stopped) return;
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
      var bounds = playBounds();
      var minX = bounds.minX, maxX = bounds.maxX;
      var minY = bounds.minY, maxY = bounds.maxY;

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

      // V2.16 wake-up: a brief unconditional shove away from the cursor after a
      // shielded interlude, so the card is never handed over becalmed.
      if (hasPointer && now < wakeUntil) {
        ax += awx * WAKE_ACCEL;
        ay += awy * WAKE_ACCEL;
      }

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
         two console lines enough to freeze the physics for free.

         The grace used to be CONSECUTIVE, and any frame that read false reset
         it, so a getter answering true on ten frames out of every eleven never
         reached the limit: integrate() returned 0 on nine tenths of the frames,
         the card crawled at a ninth of its speed and the reported time kept full
         pace. Nothing else caught it either -- the stall path is skipped while
         hidden, the dropped simulation goes out with the accumulator, and the
         heartbeat stands down on the same flag. The budget is spent over the
         whole run now and the verdict sticks for the rest of it. */
      var hidden = !hiddenLies && !!document.hidden;
      if (hidden && ++hiddenFrames > HIDDEN_LIE_FRAMES) {
        hiddenLies = true;
        hidden = false;
        sus('hidden-lie');
        showTaunt(TAUNT_LAG);
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

      /* V3.9 backstop. A blur event can be missed -- another window taking focus
         on some window managers, a click-through that focuses and clicks in the
         same gesture -- so the loop checks the truth every frame. rAF keeps
         running for a visible-but-unfocused window, which is exactly the case
         the blur park relied on. */
      if (document.hasFocus) {
        var hasIt = document.hasFocus();
        if (hasIt === pauseUnfocused) {      // disagreement with what we believe
          if (!hasIt) dropPointer();
          pauseUnfocused = !hasIt;
          refreshPause();
        }
      }

      // Ahead of the pause return on purpose: deskLive() is false while paused
      // or shielded, so the tick spends those frames resetting its deadline and
      // a resume gets the full grace period, never a window in the face.
      folderPopTick(t);

      // Paused: the picture holds, but elapsed wall time continues to count and
      // is judged as soon as the field resumes.
      if (paused) return;

      integrate(dtMs, t);
      render();
      clockTick(t);

      if (lagDebtMs > LAG_DEBT_MAX && !lagFlagged) {
        lagFlagged = true;
        sus('lag-debt');
        showTaunt(TAUNT_LAG);
      }

      // Layer D samples between sub-step batches: the transform on screen is the
      // one this frame just drew, so it can be compared against the position the
      // engine integrated to.
      /* V2.19. Simulation verification happens before this timer begins, so the
         shot clock always measures Chase rather than puzzle time. */
      if (SHOT_CLOCK_ON && started && !won && !banned) {
        var elapsed = t - shStartT.get();
        var leftMs = SHOT_CLOCK_MS - elapsed;
        var leftS = Math.ceil(leftMs / 1000);
        if (leftS < 0) leftS = 0;
        if (leftS !== shotLeftShown) { shotLeftShown = leftS; setText(elShot, leftS); }
        if (leftMs <= SHOT_LOW_MS) elShot.classList.add('low');
        if (leftMs <= 0) { banPlayer('timeout'); return; }
      }

      if (CAPTCHA_ON && !capBroken && !capShown && started && t >= capAt) showCaptcha('timer');
      capTick(t);

      if (geomDirty) { geomDirty = false; checkStructure(); attest(); }
      if (--attestIn <= 0) { attestIn = ATTEST_FRAMES; checkStructure(); attest(); }

      if (started) {
        // Hold the visible number while the timed Practice puzzle is unsolved;
        // solveCaptcha then removes the same interval from every clock origin.
        var clockNow = (CAPTCHA_TIMED && capShown && capBeatT === 0) ? capShownAt : t;
        setText(elTime, fmt(clockNow - shStartT.get()));
      }
    }

    /* B5. rAF ids are a page-global integer namespace, so capturing the function
       does not protect the loop it schedules: a sweep cancelling ids 1..400
       stops the engine dead without touching anything the engine owns. This
       heartbeat notices its own main loop has died and restarts it, which makes
       the sweep pointless rather than merely detectable. */
    function heartbeat() {
      // banned belongs here with won: banPlayer() cancels the loop, and without
      // this the watchdog would restart it a second later and charge a
      // loop-stall sus point against a run that has already ended.
      if (stopped || won || banned || paused || !started) return;
      /* No rAF is expected while hidden, and a genuinely hidden tab is a paused
         one, which the line above already covers. Once integrate() has caught
         the flag lying, though, standing down here is precisely what the spoof
         wants: the loop stays dead and the watchdog agrees to leave it dead. */
      if (!hiddenLies && document.hidden) return;
      var gap = NOW() - lastT;
      if (gap < LOOP_DEAD_MS) return;
      lastT = NOW();
      accumMs = 0;
      simT = lastT;
      /* F10. This was the one reason with no debounce and no per-run cap, and
         it trusts document.hidden to be truthful. Any environment where rAF
         stops while visibility stays "visible" -- some Linux WMs, RDP/VNC, an
         occluded window -- fired it about once a second forever. Restart the
         loop every time; charge for it rarely. */
      if (++loopStalls >= LOOP_STALL_GRACE) {
        var lt = NOW();
        if (lt - loopSusAt >= GEOM_SUS_DEBOUNCE_MS && loopSusCount < LOOP_STALL_MAX) {
          loopSusAt = lt;
          loopSusCount++;
          sus('loop-stall');
        }
      }
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
      lastKind = kind;
      lastCheated = cheated;

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
          emitWin(sig);
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
      lastIsBest = isBest;
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

        /* V3.4 block 4b: name the checks that tripped, and say plainly that the
           run is not going to the board. The shell enforces that separately --
           this is the player-facing half of the same rule. */
        if (susSeeded && susReasons.indexOf('gauntlet') < 0) susReasons.unshift('gauntlet');
        if (elOvSusList) {
          while (elOvSusList.firstChild) elOvSusList.removeChild(elOvSusList.firstChild);
          for (var si = 0; si < susReasons.length; si++) {
            var li = document.createElement('li');
            li.textContent = susWords(susReasons[si]);
            elOvSusList.appendChild(li);
          }
          if (susReasons.length) elOvSusList.classList.remove('hide');
        }
        if (elOvSusNote) elOvSusNote.classList.remove('hide');
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

      /* V3.3 wants the signed WIN line in the score POST, and layer G signs
         asynchronously -- so the callback now fires from inside that callback
         rather than ahead of it. The digest of a 40-character string resolves
         well inside the 300 ms overlay delay, and the cheated path has no
         signature to wait for. */
      emitWin(cheated ? '' : null);
    }

    var winEmitted = false;
    function emitWin(sig) {
      if (winEmitted) return;
      if (sig === null) return;              // still waiting on the digest
      winEmitted = true;
      if (typeof opts.onWin !== 'function') return;
      try {
        opts.onWin({
          timeMs: finalMs,
          misses: shMisses.get(),
          nearMisses: shNear.get(),
          bestMs: bestMs,
          isBest: lastIsBest,
          cheated: lastCheated,
          cheatKind: lastKind,
          sus: susN,
      susReasons: susReasons.slice(),
          sig: sig,
          clockSum: clkSum,
          stateSum: shChain
        });
      } catch (e) { /* a caller's handler must not break the engine */ }
    }

    /* V3 touchpoint. main.js owns the backend; the engine only lends it two
       slots on the win dialog -- a line of text and a button -- and never learns
       what a leaderboard is. Safe to call late: the score POST resolves after
       the dialog is already up. */
    var boardFn = null;
    on(elOvBoard, 'click', function (e) {
      if (e.isTrusted && typeof boardFn === 'function') boardFn();
    });

    function winExtras(o) {
      if (stopped || !won || !o) return;
      if (typeof o.note === 'string' && o.note) {
        setText(elOvNet, o.note);
        elOvNet.classList.remove('hide');
      }
      if (typeof o.onBoard === 'function') {
        boardFn = o.onBoard;
        elOvBoard.classList.remove('hide');
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
    if (SHOT_CLOCK_ON) {
      setText(elShot, Math.round(SHOT_CLOCK_MS / 1000));
      shotRow.classList.remove('hide');
    }
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
    checkPlayable();
    seedFolders();
    /* Ruling 1: the clock starts when the Chase does. Simulation's mandatory
       visual challenge lives between Flappy and Chase, so it is displayed now
       and startTimer() is deferred until its success beat closes the dialog.
       Practice starts immediately and receives its one random early challenge. */
    if (PRESTART_CHALLENGE) showCaptcha('pre-chase');
    else startTimer();
    rafId = RAF(frame);
    watchdog = EVERY(heartbeat, 500);

    return Object.freeze({ stop: stop, setAudio: setAudio, winExtras: winExtras });
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
