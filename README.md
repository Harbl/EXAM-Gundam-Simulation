# EXAM: Gundam TCG Sim

[![Latest release](https://img.shields.io/github/v/release/Harbl/EXAM-Gundam-Simulation?label=latest%20release&color=9B1B1E)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Harbl/EXAM-Gundam-Simulation/total?color=C9A951&style=flat)](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

A Windows desktop app that runs simulations of hundreds or thousands of games between two pasted decklists and gives back useful stats to gauge how a deck build actually performs: win rate, mulligan rate, opening hand curve, game length.

Full rules engine with every card released, built against the current banned/restricted list. Every card's effect is implemented from its real printed text.

### [⬇ Download EXAM for Windows](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest)

Grab the installer from the [latest release](https://github.com/Harbl/EXAM-Gundam-Simulation/releases/latest), run it, and pick an install location. The app checks for a newer version on every launch, and a banner pops up when one's available so you can install it in one click.

![Batch simulation results](docs/screenshots/simulate-results.png)

## Features

### Batch simulation

Both sides of a batch are piloted by [Monte Carlo Tree Search](src/ai/mcts.js), not a basic random-legal-move monte carlo. Paste two decklists, pick a game count, hit Launch, and it plays out real games between them: every real game runs turn by turn until someone wins, it's a draw, or it hits a 60-turn safety cap, not a few turns and a guess. Five skill tiers (Beginner through Expert) trade search strength for speed, so a quick 1,000-game batch and a "play this one game as strong as possible" run are both practical.

### How the AI works

Every decision point (deploy this, pair that, attack with this one, or pass) gets modeled as a branch in a search tree. Each branch gets scored based on how it's performed in simulations so far, plus a bonus for branches that haven't been explored much yet (standard UCT, balances "keep testing what's worked" against "make sure nothing promising got ignored"). Search budget naturally flows toward the branches that are scoring well. At the end it doesn't just take the branch with the best average, it takes the one that got visited the most, since that's more stable at low sample sizes than a raw average.

Each individual simulated playout inside the search only looks a couple turns ahead before handing off to a position evaluator (win condition progress, board state, hand quality) instead of finishing the game out. That evaluator is a hand-tuned formula, weighted and checked against thousands of self-play games. There's also a trained neural net version that beat the hand-tuned formula in testing, but it's not wired in as the default yet. The full-game completion behavior comes from running a fresh search like that at every single decision across an entire real game, not from any one playout going the distance.

Skill tiers trade off playout budget, how many turns the rollout looks ahead, and whether the rollout itself uses a cheap heuristic or the full lookahead AI. Beginner skips the tree search entirely and just uses the older heuristic AI. It scales up from there.

### Stats and reports

Win rate, decisive win rate, win rate on the play vs. the draw, margin of victory, mulligan rate, turn 1/2/3 curve consistency, deck A vs. deck B side by side as a bar chart. Export any run as a PNG matchup report with the deck lists attached.

### Deck Builder

Browses and filters the full card database by name, color, level, or cost, with real card art. Legality feedback while you build (copy limits, banlist, color count). Save decks, reload them later, or paste a decklist straight in to edit it.

![Deck Builder with live card art and filtering](docs/screenshots/deck-builder.png)

### Replay viewer

Every batch remembers each game's seed, so any individual game is exactly reproducible. The replay viewer has a text log mode and a full visual board mode: hands revealed, Shields flipping face up as they're hit, real card art on Bases, Resources, and Tokens (including the EX Base and EX Resource every game starts with), Resources tapping as they're spent, HP bars draining in real time, units flying from hand to the battle area on deploy, tapping when they attack or block, and moving to the trash on destruction. Step through it event by event or hit play.

![Visual board replay, mid-game](docs/screenshots/board-replay.png)

### Log page

Every batch you save sticks around here: deck names, game count, win rate at a glance. Pick one and it loads the full game by game results back in, ready to replay any individual game.

![Browsing a saved batch's results in the Log page](docs/screenshots/log-view.png)

### Tournament mode

Runs a bracket, single or double elimination, across any saved decks you pick as entrants. Choose a Best of 1/3/5/7 match format and an AI skill tier, and it seeds a bracket and plays it out round by round, revealing each winner as soon as their match resolves. Double elimination means a loss drops you into a losers bracket instead of knocking you out, and the two bracket champions meet in a Grand Final. Save the finished bracket to the Log page with per-entrant win rates, and every individual game stays replayable.

![A finished tournament bracket, champion crowned](docs/screenshots/tournament.png)
