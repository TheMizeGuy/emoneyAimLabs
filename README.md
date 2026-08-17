# eMoney Aim Labs

A browser game that exists to make you angry at a popup ad. The start
screen offers three modes. Pick one and go make yourself miserable.

Simulation and Impossible both play loud audio. Turn your volume down first.
A mouse is required to win: touch and pen can play, but only a real mouse
click closes the window.

## Play

https://themizeguy.github.io/emoneyAimLabs/

## Modes

**Practice Mode** - the original chase. The eMoney logo lives inside a
tiny Windows-95-style popup window that does not want to be closed: it
wanders the desktop, and the moment your cursor gets close, it flees
faster. Click the beveled X in its title bar to end its life. The timer
starts the moment the chase does, and misses, near-misses and your best
time are tracked and saved locally. Practice has no visual verification --
it is just you against the window.

**Simulation (LOUD!)** - TURN YOUR VOLUME DOWN FIRST. This mode is
genuinely loud. It opens with a from-scratch Flappy-style gauntlet: flap
through pipes until you reach 10 points in a single run (any death
resets your score to zero). Clear that and the chase begins, now with a
different face on the run and an 8-second audio loop playing at full
volume for the rest of the round. A one-attempt, single-round visual
verification runs between Flappy and Chase, and the popup then spawns at a
fresh random position. A wrong match fails only that run; repeated rapid
mismatches add a brief retry delay capped at one minute, not an account ban.

**Impossible (LOUD!)** - Simulation with the mercy removed. The gauntlet
runs 20 percent faster, the window is meaningfully harder to pin down,
and the desktop is scattered with folders. Clicking a folder counts as a
miss and opens an empty Explorer window somewhere else on the desktop,
which has to be closed before the popup will accept its fate. It has its
own leaderboard.

Every missed click in Simulation and Impossible triggers its own
synthesized Windows-error chord, mixed under the loop. Practice Mode is
silent.

## Fair play

The close button only responds to a real mouse click that arrives where
the pointer actually is after a current multi-frame approach, and every ranked
run uses the same 1120 x 620 playfield even if the browser is resized. The game
keeps a running tally of anything that looks like tampering. Posted Simulation
and Impossible scores also need one fresh visual challenge; every posted score
needs a single-use server run, server-timed phases, a two-sided elapsed-time
check, and a paced heartbeat chain. High-confidence
clock/challenge violations close the run and appear in the public Activity Log.
An ordinary wrong visual match is recorded only as a failed run, never as a
cheating accusation.

These checks stop fabricated instant scores, timer-free resize pauses, replay,
and ordinary scripted events. They cannot prove that a human, rather than a
modified client or full browser automation, executed a correctly timed protocol;
the detailed threat model and current residual are in `docs/anti-cheat-audit.md`.

## Leaderboard

Sign in with Twitch on the start screen to post your times. The LEADERBOARD tab
shows the top 50 for Simulation and for Impossible, with each player's click count and three failure
tallies: total, deaths in the gauntlet, and windows that got away. Anyone can
read it, signed in or not. Play without signing in and everything works exactly
the same; your time just does not get posted.

The GAME tab carries an activity log that streams completed runs, failures, and
high-confidence cheating detections. Clicking any name,
in the log or on the leaderboard, opens that player's record: best time per mode,
failure counts, and their recent runs.

Privacy: signing in stores only your Twitch id, display name and avatar URL --
no email, no chat access, no permissions requested. Be aware that all three are
public once you sign in: your name and avatar appear in the activity log and on
the leaderboard, and your run history is readable by anyone. Scores and counters
are kept server-side. Signing out is one click and the site keeps working
without it.

## Run it locally

Clone the repo and serve it over HTTP:

```
python3 -m http.server
```

Then open http://localhost:8000/. Opening `index.html` straight off disk
works for Practice, but browsers refuse the audio fetch on `file://`, so
Simulation runs silent. The game itself has no build step, no dependencies
and no CDN calls; a local copy simply shows the leaderboard as OFFLINE,
since sign-in only works from the published site.

## Repo layout

- `index.html` - the shell: start screen, mode router, loads the scripts.
- `js/chase.js` - the chase engine shared by all three modes.
- `js/flappy.js` - the Flappy-style gauntlet in Simulation and Impossible.
- `js/main.js` - wiring between the start screen and the game modes.
- `js/sentinel.js` - build integrity check.
- `js/net.js` - leaderboard and sign-in client.
- `assets/emoney.png` - the Practice Mode target.
- `assets/simulation.png` - the Simulation and Impossible target.
- `assets/loop.wav` - the Simulation and Impossible audio loop.
- `server/` - the leaderboard API: Twitch sign-in, score validation and
  the activity feed. Node and Postgres, deployed separately. Its secrets
  live in the host's environment, never in this repo.

---

Built by a team of Claude Code agents on request, because someone decided
a genuinely frustrating popup-ad simulator was worth shipping.
