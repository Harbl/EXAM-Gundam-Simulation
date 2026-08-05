# EXAM — Gundam TCG Sim

[![Latest release](https://img.shields.io/github/v/release/Harbl/EXAM-Gundam-Simulation?label=latest%20release&color=9B1B1E)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Harbl/EXAM-Gundam-Simulation/total?color=C9A951&style=flat)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

A Windows desktop app that plays out full games of the Gundam Card Game between
two pasted decklists — hundreds or thousands of them, unattended — and reports
back real stats: win rate, mulligan rate, opening-hand curve quality, game
length. Built to answer one question: **how does this deck actually perform**,
not just "does it goldfish okay."

Built against the official Comprehensive Rules and the current banned/restricted
list. Every card's effect is implemented from its real, researched text — never
guessed, never left as a generic vanilla stat-line.

### [⬇ Download EXAM for Windows](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

Grab the installer from the [latest release](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest),
run it, and pick your install location in the setup wizard. After that, the app
checks for a newer version on every launch — when one's out, a small banner
shows up so you can download and install it with one click, right from inside
the app.

![Batch simulation results](docs/screenshots/simulate-results.png)

## Features

**Batch simulation with a real opponent, not a coin flip.** Paste two decklists,
pick a game count, hit Launch. Both sides are piloted by [Monte Carlo Tree
Search](src/ai/mcts.js) — the AI searches deploys, pairs, Commands, and attacks
as one interleaved decision tree per turn, not a fixed "always curve out first"
script. Five skill tiers (Beginner → Expert) trade search strength for speed, so
a quick 1,000-game batch and a "play this one game as strong as possible" run
are both practical.

**Visual stats, not a wall of numbers.** Win rate, decisive-win rate, win-when-
first/second, margin of victory (shields left), mulligan rate, and turn-1/2/3
curve consistency — deck A vs. deck B, side by side, as a hand-rolled bar chart.
Export any run as a shareable PNG matchup report, deck lists included.

**A real Deck Builder**, not just a text box. Browse and filter the full card
database by name, color, level, or cost, with real card art. Live legality
feedback (copy limits, banlist, color count) while you build. Save decks by
name, reload them later, or import a pasted decklist straight into the builder
for editing.

![Deck Builder with live card art and filtering](docs/screenshots/deck-builder.png)

**Watch any simulated game play out, turn by turn.** Every batch remembers each
game's seed, so any individual game is exactly reproducible. The replay viewer
has two modes: a text log, or a full visual board — both players' hands
revealed, Shields flipping face-up as they're hit, Bases and Resources on
display with real card art (down to Unit Tokens and the EX Base/EX Resource
every game starts with), Resources tapping as they're spent, HP bars draining
in real time, units physically flying from hand to the battle area on deploy,
tapping when they attack or block, and flying off to the trash on destruction.
Step through event-by-event or hit play and watch it run.

![Visual board replay, mid-game](docs/screenshots/board-replay.png)

**Every batch you save stays around.** The Log page lists every batch you've
ever saved — deck names, game count, win rate at a glance — and picking one
loads its full game-by-game results back in, ready to replay any individual
game from that run the same way as a batch you just finished.

![Browsing a saved batch's results in the Log page](docs/screenshots/log-view.png)
