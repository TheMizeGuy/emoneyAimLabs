# eMoney Aim Labs

A browser game that exists to make you angry at a popup ad. The eMoney logo
lives inside a small card that does not want to be closed: it wanders the
page, and the moment your cursor gets close, it flees faster. Click the X in
its top-right corner to end its life. Good luck.

## Play

https://themizeguy.github.io/emoneyAimLabs/

## Scoring

The timer starts the instant you move your mouse and stops the moment you
land the click on the X. Every miss and near-miss along the way gets counted
against you. Your best time is saved locally in your browser, so you can
watch your record mock you on the next attempt.

## The trick

The card's top speed is capped. It cannot outrun you forever in open space,
and it definitely cannot outrun you once it's pinned in a corner. Herd it,
don't chase it — that's the intended strategy, not an exploit. The game is
extremely hard. It is not impossible.

## Fair play

The close button only responds to real, trusted pointer clicks. Keyboard
activation and synthetic or programmatic clicks are rejected. If you were
about to script your way to a win, the game already thought of that.

## Run it locally

Clone the repo, then either open `index.html` directly in a browser or
serve it:

```
python3 -m http.server
```

No build step, no dependencies, no CDN calls. It is one HTML file and one
PNG.

## Repo layout

- `index.html` — the entire game: markup, styling, and logic in one file.
- `assets/emoney.png` — the target.

---

Built by a team of Claude Code agents on request, because someone decided a
genuinely frustrating popup-ad simulator was worth shipping.
