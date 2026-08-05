# EXAM: Gundam TCG Sim

[![Latest release](https://img.shields.io/github/v/release/Harbl/EXAM-Gundam-Simulation?label=latest%20release&color=9B1B1E)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Harbl/EXAM-Gundam-Simulation/total?color=C9A951&style=flat)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

A Windows desktop app that runs simulations of hundreds or thousands of games between two pasted decklists and gives back useful stats to gauge how a deck build actually performs: win rate, mulligan rate, opening hand curve, game length.

Full rules engine with every card released, built against the current banned/restricted list. Every card's effect is implemented from its real printed text.

### [⬇ Download EXAM for Windows](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

Grab the installer from the [latest release](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest), run it, and pick an install location. The app checks for a newer version on every launch, and a banner pops up when one's available so you can install it in one click.

![Batch simulation results](docs/screenshots/simulate-results.png)

## Features

Both sides of a batch are piloted by a [Monte Carlo Tree Search](src/ai/mcts.js) AI, not a basic random-legal-move monte carlo. It's a heavily modified version that uses a real search tree: each branch gets scored, more resources go toward the favorable branches, and it weighs the scores to pick its action. Games play to completion too, not just the first few turns like a standard monte carlo. Five skill tiers trade search strength for speed.

Stats come out readable: win rate, decisive win rate, win rate on the play vs. the draw, margin of victory, mulligan rate, turn 1/2/3 curve consistency, deck A vs. deck B side by side as a bar chart. Export any run as a PNG matchup report with the deck lists attached.

The Deck Builder browses and filters the full card database by name, color, level, or cost, with real card art. Legality feedback while you build (copy limits, banlist, color count). Save decks, reload them later, or paste a decklist straight in to edit it.

![Deck Builder with live card art and filtering](docs/screenshots/deck-builder.png)

Every batch remembers each game's seed, so any individual game is exactly reproducible. The replay viewer has a text log mode and a full visual board mode: hands revealed, Shields flipping face up as they're hit, real card art on Bases, Resources, and Tokens (including the EX Base and EX Resource every game starts with), Resources tapping as they're spent, HP bars draining in real time, units flying from hand to the battle area on deploy, tapping when they attack or block, and moving to the trash on destruction. Step through it event by event or hit play.

![Visual board replay, mid-game](docs/screenshots/board-replay.png)

Every batch you save sticks around on the Log page: deck names, game count, win rate at a glance. Pick one and it loads the full game by game results back in, ready to replay any individual game.

![Browsing a saved batch's results in the Log page](docs/screenshots/log-view.png)

Tournament mode runs a bracket, single or double elimination, across any saved decks you pick as entrants. Choose a Best of 1/3/5/7 match format and an AI skill tier, and it seeds a bracket and plays it out round by round, revealing each winner as soon as their match resolves. Double elimination means a loss drops you into a losers bracket instead of knocking you out, and the two bracket champions meet in a Grand Final. Save the finished bracket to the Log page with per-entrant win rates, and every individual game stays replayable.

![A finished tournament bracket, champion crowned](docs/screenshots/tournament.png)
