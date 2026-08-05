# EXAM: Gundam TCG Sim

[![Latest release](https://img.shields.io/github/v/release/Harbl/EXAM-Gundam-Simulation?label=latest%20release&color=9B1B1E)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Harbl/EXAM-Gundam-Simulation/total?color=C9A951&style=flat)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

A Windows desktop app that plays out full games of the Gundam Card Game between two pasted decklists, hundreds or thousands of them, unattended. Reports back win rate, mulligan rate, opening hand curve, and game length.

Built against the official Comprehensive Rules and the current banned/restricted list. Every card's effect is implemented from its real printed text.

### [⬇ Download EXAM for Windows](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

Grab the installer from the [latest release](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest), run it, and pick an install location. The app checks for a newer version on every launch. When one's out, a banner shows up so you can download and install it in one click.

![Batch simulation results](docs/screenshots/simulate-results.png)

## Features

**Batch simulation with a real opponent.** Paste two decklists, pick a game count, hit Launch. Both sides are piloted by [Monte Carlo Tree Search](src/ai/mcts.js), searching deploys, pairs, Commands, and attacks as one decision tree per turn. Five skill tiers trade search strength for speed.

**Stats you can read.** Win rate, decisive win rate, win rate on the play vs. the draw, margin of victory, mulligan rate, turn 1/2/3 curve consistency, deck A vs. deck B side by side as a bar chart. Export any run as a PNG matchup report with the deck lists attached.

**A real Deck Builder.** Browse and filter the full card database by name, color, level, or cost, with real card art. Live legality feedback (copy limits, banlist, color count) while you build. Save decks, reload them later, or paste a decklist straight into the builder to edit it.

![Deck Builder with live card art and filtering](docs/screenshots/deck-builder.png)

**Watch any simulated game play out, turn by turn.** Every batch remembers each game's seed, so any individual game is exactly reproducible. The replay viewer has a text log mode and a full visual board mode: hands revealed, Shields flipping face up as they're hit, real card art on Bases, Resources, and Tokens (including the EX Base and EX Resource every game starts with), Resources tapping as they're spent, HP bars draining in real time, units flying from hand to the battle area on deploy, tapping when they attack or block, and moving to the trash on destruction. Step through event by event or hit play.

![Visual board replay, mid-game](docs/screenshots/board-replay.png)

**Every batch you save sticks around.** The Log page lists every saved batch, deck names, game count, win rate at a glance. Picking one loads its full game-by-game results back in, ready to replay any individual game.

![Browsing a saved batch's results in the Log page](docs/screenshots/log-view.png)

**Run a tournament, single or double elimination.** Pick saved decks as entrants, choose a Best of 1/3/5/7 match format and an AI skill tier. EXAM seeds a bracket and plays it out round by round, revealing each winner as soon as their match resolves. In double elimination, a loss drops you into a losers bracket instead of knocking you out, and the two bracket champions meet in a Grand Final. Save the finished bracket to the Log page with per-entrant win rates, and every individual game stays replayable.

![A finished tournament bracket, champion crowned](docs/screenshots/tournament.png)
