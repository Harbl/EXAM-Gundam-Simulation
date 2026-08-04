#!/usr/bin/env node
// Trains a valueNet.js model to replace ai/score.js's hand-picked linear scoreState formula, via
// iterative self-play (see Phase 7 of the plan). A real, reusable CLI (not scratchpad) -- meant to be
// re-run again as cards/AI evolve, same precedent as bin/simulate.js.
//
// Each round: (1) collect self-play data using the current champion (round 0 = no valueModel, i.e.
// today's linear scoreState), sampling a feature vector after every main phase and labeling it with
// that game's final outcome (a Monte-Carlo target, +/-OUTPUT_SCALE win/loss, 0 draw -- timed-out games
// are discarded, ambiguous outcome); (2) train a fresh net on that data with early stopping; (3) verify
// the candidate against the current champion in self-play (weight_tune.js's z-score-gated harness
// shape); (4) adopt on a significant win and repeat, or stop -- same "keep going until no more
// improvement" rule already used for scratchpad/weight_coordinate_descent.js, one tier up.
//
// Usage: node bin/train_value_net.js [gamesPerRound] [maxRounds] [verifyGamesPerDeck] [confirmGamesPerDeck]
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const { extractFeatures } = require('../src/ai/valueFeatures');
const { createNet, forward, trainStep, saveNet, OUTPUT_SCALE } = require('../src/ai/valueNet');
const { playGame } = require('../src/sim/singleGame');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scratchpad', 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

// Same 10-deck spread weight_tune.js/weight_coordinate_descent.js used, so this round is directly
// comparable to those precedents rather than measured against a different sample.
const DECK_NAMES = [
  'deck1.txt', 'deck3.txt', 'deck8.txt', 'deck9.txt', 'deck14.txt',
  'deck17.txt', 'deck22.txt', 'deck24.txt', 'deck29.txt', 'deck34.txt'
];
const decks = DECK_NAMES.map((n) => loadDeck(n));

function zScore(winRate, n) {
  const se = Math.sqrt(0.25 / n);
  return (winRate - 0.5) / se;
}

/** Plays one self-play game (both sides using `championModel`, or today's linear scoreState if null),
 * sampling extractFeatures after every main phase. Returns the game's samples (unlabeled) plus its
 * outcome, or null if the game timed out (MAX_TURNS, ambiguous outcome -- discarded from training). */
function playAndSample(deckA, deckB, championModel) {
  const state = initializeGame(deckA, deckB, { decideMulligan });
  if (championModel) {
    state.players[0].valueModel = championModel;
    state.players[1].valueModel = championModel;
  }
  const samples = []; // {features, player}

  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    const activeIdx = state.activePlayerIdx;
    runMainPhaseMCTS(state, activeIdx, undefined, DEFAULT_MCTS_CONFIG);
    if (state.winner === null && !state.draw) {
      samples.push({ features: extractFeatures(state, activeIdx), player: activeIdx });
    }
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  const timedOut = state.winner === null && !state.draw;
  if (timedOut) return { samples: null, timedOut: true };
  return { samples, winner: state.winner, draw: state.draw, timedOut: false };
}

/** Collects a labeled training dataset from `games` self-play games spread across the deck pool. */
function collectData(games, championModel) {
  const dataset = [];
  let wins = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < games; i++) {
    const deckA = decks[i % decks.length];
    const deckB = decks[(i + 1) % decks.length];
    const result = playAndSample(deckA, deckB, championModel);
    if (result.timedOut) {
      timeouts++;
      continue;
    }
    wins++;
    if (result.draw) draws++;
    for (const { features, player } of result.samples) {
      const target = result.draw ? 0 : result.winner === player ? OUTPUT_SCALE : -OUTPUT_SCALE;
      dataset.push({ features, target });
    }
  }
  return { dataset, gamesPlayed: wins, draws, timeouts };
}

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deep-copies just the weight fields (not Adam optimizer state) -- used to checkpoint the
 * best-so-far net during training, since trainStep mutates `net` in place. */
function snapshotWeights(net) {
  return JSON.parse(JSON.stringify({ inputSize: net.inputSize, hiddenSize: net.hiddenSize, W1: net.W1, b1: net.b1, W2: net.W2, b2: net.b2 }));
}

/**
 * Trains a fresh net on `dataset` (90/10 train/val split) with early stopping.
 *
 * Two bugs found (2026-08-03) via scratchpad diagnostics after round 1 of a real training run lost
 * badly (29% win rate, z=-10.29) with a training loss that never meaningfully moved: (1) the original
 * learningRate=0.01 default was too high for this per-example online Adam setup -- at lr=0.1 the val
 * loss froze at the exact same value every single epoch, a signature of the output tanh saturating to
 * a constant +-1 and killing gradient flow entirely (d(tanh)/dx -> 0 near +-1); lr=0.003 converges
 * smoothly and was still improving at epoch 80 in the diagnostic. (2) patience=2 was returning
 * whichever epoch training happened to stop ON, not the best epoch seen -- with a val set this noisy
 * epoch-to-epoch, that's very likely to be an above-baseline (undertrained/degraded) checkpoint rather
 * than the actual best one. Fixed by snapshotting the weights every time val loss improves and
 * returning that snapshot rather than whatever `net` looks like when the loop ends.
 */
function trainNet(dataset, seed, { epochs = 60, learningRate = 0.003, patience = 10 } = {}) {
  const shuffled = shuffle(dataset);
  const splitAt = Math.floor(shuffled.length * 0.9);
  const trainSet = shuffled.slice(0, splitAt);
  const valSet = shuffled.slice(splitAt);

  const net = createNet(seed);
  let bestValLoss = Infinity;
  let bestWeights = snapshotWeights(net);
  let roundsSinceImprovement = 0;
  const history = [];

  for (let epoch = 1; epoch <= epochs; epoch++) {
    let trainLossSum = 0;
    for (const { features, target } of shuffle(trainSet)) {
      trainLossSum += trainStep(net, features, target, learningRate);
    }
    let valLossSum = 0;
    for (const { features, target } of valSet) {
      const out = forward(net, features);
      valLossSum += 0.5 * (out - target) ** 2;
    }
    const trainLoss = trainLossSum / trainSet.length;
    const valLoss = valLossSum / valSet.length;
    history.push({ epoch, trainLoss, valLoss });
    console.log(`    epoch ${epoch}: trainLoss=${trainLoss.toFixed(2)} valLoss=${valLoss.toFixed(2)}`);

    if (valLoss < bestValLoss - 1e-6) {
      bestValLoss = valLoss;
      bestWeights = snapshotWeights(net);
      roundsSinceImprovement = 0;
    } else {
      roundsSinceImprovement++;
      if (roundsSinceImprovement >= patience) {
        console.log(`    early stopping after epoch ${epoch} (best was val=${bestValLoss.toFixed(2)}, restoring that checkpoint)`);
        break;
      }
    }
  }

  return { net: bestWeights, history };
}

/** z-score-gated self-play: candidateModel vs. championModel (either may be null = linear scoreState). */
function verify(candidateModel, championModel, gamesPerDeck) {
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0;
  for (const deck of decks) {
    for (let i = 0; i < gamesPerDeck; i++) {
      const candidateIsA = i % 2 === 0;
      const r = playGame(deck, deck, {
        valueModelA: candidateIsA ? candidateModel : championModel,
        valueModelB: candidateIsA ? championModel : candidateModel
      });
      if (r.draw) draws++;
      else if (r.timedOut) timeouts++;
      else if ((r.winner === 0) === candidateIsA) winsCandidate++;
      else winsChampion++;
    }
  }
  const total = winsCandidate + winsChampion + draws + timeouts;
  const winRate = winsCandidate / total;
  return { winsCandidate, winsChampion, draws, timeouts, total, winRate, z: zScore(winRate, total) };
}

const GAMES_PER_ROUND = Number(process.argv[2] || 2500);
const MAX_ROUNDS = Number(process.argv[3] || 5);
const VERIFY_GAMES_PER_DECK = Number(process.argv[4] || 60);
const CONFIRM_GAMES_PER_DECK = Number(process.argv[5] || 400);
const SIGNIFICANCE_Z = 2.5;

console.log(
  `${decks.length} decks; ${GAMES_PER_ROUND} games/round for data collection, up to ${MAX_ROUNDS} rounds, ` +
    `verify @ ${VERIFY_GAMES_PER_DECK} games/deck, final confirm @ ${CONFIRM_GAMES_PER_DECK} games/deck\n`
);

let champion = null; // null = today's linear scoreState (DEFAULT_WEIGHTS)
const roundLog = [];
const startedAt = Date.now();

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`--- Round ${round} ---`);
  const t0 = Date.now();

  console.log(`  collecting ${GAMES_PER_ROUND} self-play games...`);
  const { dataset, gamesPlayed, draws, timeouts } = collectData(GAMES_PER_ROUND, champion);
  console.log(`  ${dataset.length} samples from ${gamesPlayed} games (draws=${draws}, timeouts=${timeouts})`);

  console.log(`  training...`);
  const { net: candidate, history } = trainNet(dataset, 1000 + round);

  console.log(`  verifying candidate vs. current champion (${VERIFY_GAMES_PER_DECK} games/deck)...`);
  const v = verify(candidate, champion, VERIFY_GAMES_PER_DECK);
  const sig = Math.abs(v.z) >= SIGNIFICANCE_Z;
  console.log(
    `  candidate ${v.winsCandidate}-${v.winsChampion} champion (${(v.winRate * 100).toFixed(1)}%, z=${v.z.toFixed(2)}, ` +
      `draws=${v.draws}, timeouts=${v.timeouts})` +
      (sig && v.z > 0 ? ' <-- ADOPTED' : sig ? ' <-- significant loss, stopping' : ' <-- not significant, stopping')
  );

  roundLog.push({
    round,
    gamesPlayed,
    samples: dataset.length,
    draws,
    timeouts,
    finalEpoch: history[history.length - 1],
    verify: v,
    adopted: sig && v.z > 0,
    elapsedMs: Date.now() - t0
  });

  if (sig && v.z > 0) {
    champion = candidate;
  } else {
    console.log(`\nStopping after round ${round}: no significant improvement.`);
    break;
  }
  if (round === MAX_ROUNDS) console.log(`\nHit MAX_ROUNDS (${MAX_ROUNDS}) with improvement still happening -- stopping as a safety valve.`);
}

console.log(`\nTotal elapsed: ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`);

let confirmation = null;
if (champion) {
  console.log(
    `\n--- Final confirmation: adopted champion vs. original linear scoreState, ` +
      `${decks.length} decks x ${CONFIRM_GAMES_PER_DECK} games/deck x 2 = ${decks.length * CONFIRM_GAMES_PER_DECK * 2} games ---`
  );
  confirmation = verify(champion, null, CONFIRM_GAMES_PER_DECK);
  const sig = Math.abs(confirmation.z) >= SIGNIFICANCE_Z;
  console.log(
    `Champion net ${confirmation.winsCandidate}-${confirmation.winsChampion} linear scoreState ` +
      `(${(confirmation.winRate * 100).toFixed(1)}%, z=${confirmation.z.toFixed(2)}, draws=${confirmation.draws}, ` +
      `timeouts=${confirmation.timeouts})` +
      (sig && confirmation.z > 0
        ? ' <-- SIGNIFICANT OVERALL WIN'
        : sig
          ? ' <-- SIGNIFICANT OVERALL LOSS (do not adopt!)'
          : ' <-- not significant')
  );

  const outPath = path.join(__dirname, '..', 'data', 'valueNet.json');
  saveNet(champion, outPath);
  console.log(`\nChampion net saved to ${outPath}`);
} else {
  console.log('\nNo round ever beat the original linear scoreState -- nothing to save.');
}

const resultPath = path.join(__dirname, '..', 'scratchpad', 'train_value_net_result.json');
fs.writeFileSync(resultPath, JSON.stringify({ roundLog, confirmation }, null, 2));
console.log(`Full round-by-round log written to ${resultPath}`);
