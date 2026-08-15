# eMoney Aim Labs

A browser game that exists to make you angry at a popup ad. The start
screen offers two modes. Pick one and go make yourself miserable.

## Play

https://themizeguy.github.io/emoneyAimLabs/

## Modes

**Practice Mode** - the original chase. The eMoney logo lives inside a
tiny Windows-95-style popup window that does not want to be closed: it
wanders the desktop, and the moment your cursor gets close, it flees
faster. Click the beveled X in its title bar to end its life. Timer,
misses, near-misses, and your best time are tracked and saved locally.

**Simulation (LOUD!)** - TURN YOUR VOLUME DOWN FIRST. This mode is
genuinely loud. It opens with a from-scratch Flappy-style gauntlet: flap
through pipes until you reach 10 points in a single run (any death
resets your score to zero). Clear that and the chase begins, now with a
different face on the run and an 8-second audio loop playing at full
volume for the rest of the round.

Every missed click, in both modes, triggers its own synthesized
Windows-error chord.

## Fair play

The close button only responds to real, trusted pointer clicks, and the
game keeps a running tally of anything that looks like tampering.

## Run it locally

Clone the repo, then either open `index.html` directly in a browser or
serve it:

```
python3 -m http.server
```

No build step, no dependencies, no CDN calls.

## Repo layout

- `index.html` - the shell: start screen, mode router, loads the scripts.
- `js/chase.js` - the chase engine shared by both modes.
- `js/flappy.js` - the Flappy-style gauntlet in Simulation mode.
- `js/main.js` - wiring between the start screen and the game modes.
- `js/sentinel.js` - anti-tamper plumbing.
- `assets/emoney.png` - the Practice Mode target.
- `assets/simulation.png` - the Simulation Mode target.
- `assets/loop.wav` - the Simulation Mode audio loop.

---

Built by a team of Claude Code agents on request, because someone decided
a genuinely frustrating popup-ad simulator was worth shipping.
