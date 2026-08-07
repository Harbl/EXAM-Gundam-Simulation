#!/usr/bin/env node
// DeepSets-variant sibling of bin/train_value_net.js -- trains src/ai/deepSetValueNet.js (per-unit
// board representation, see the project plan) instead of valueNet.js's flat MLP. Deliberately a
// separate, duplicated CLI rather than a shared harness: keeps this brand-new, unproven architecture
// from touching the already-working, already-shipped script's internals at all. Same collect -> train
// -> z-gated verify -> final-confirm-vs-linear-formula -> save loop, same discipline throughout.
//
// Can't --resume from data/valueNet.json (flat net, incompatible shape) -- this always cold-starts
// like the original Phase 7 run did (round 1's self-play uses the linear scoreState as champion).
// --resume here instead continues from data/valueNetDeepSet.json, this script's own prior output.
//
// Usage: node bin/train_value_net_deepset.js [gamesPerRound] [maxRounds] [verifyMaxGamesPerDeck] [confirmMaxGamesPerDeck] [replayWindowRounds] [--resume]
//   verify/confirm now use SPRT (src/ai/sprt.js, see bin/train_value_net.js's header for why) -- these
//   args are safety caps, not fixed spends. replayWindowRounds (default 1) pools the last N rounds'
//   self-play data for training instead of discarding a round's games the instant its candidate isn't
//   adopted -- see bin/train_value_net.js's header for the full Reanalyze-adapted rationale.
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
const { runMainPhaseMCTS, BALANCED_MCTS_CONFIG } = require('../src/ai/mcts');
const { extractDeepSetFeatures } = require('../src/ai/valueFeaturesV2');
const { createNet, forward, trainStep, saveNet, loadNet } = require('../src/ai/deepSetValueNet');
const { OUTPUT_SCALE } = require('../src/ai/valueNet'); // shared calibration constant, see deepSetValueNet.js's own net.outputScale
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_SPRT, sprtBounds, llrIncrement, sprtVerdict } = require('../src/ai/sprt');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scratchpad', 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const DECKLISTS_DIR = path.join(__dirname, '..', 'scratchpad', 'decklists');
const DECK_NAMES = fs.readdirSync(DECKLISTS_DIR);
const decks = DECK_NAMES.map((n) => loadDeck(n));

function zScore(winRate, n) {
  const se = Math.sqrt(0.25 / n);
  return (winRate - 0.5) / se;
}

// Same reasoning as bin/train_value_net.js: self-play data collection at BALANCED_MCTS_CONFIG's
// budget (100), verify()/confirm stay at the implicit DEFAULT_MCTS_CONFIG fallback.
const SELFPLAY_MCTS_CONFIG = BALANCED_MCTS_CONFIG;

/** Plays one self-play game (both sides using `championModel`, or today's linear scoreState if null),
 * sampling extractDeepSetFeatures after every main phase. Returns the game's samples (unlabeled) plus
 * its outcome, or null if the game timed out (MAX_TURNS, ambiguous outcome -- discarded from training). */
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
    runMainPhaseMCTS(state, activeIdx, undefined, SELFPLAY_MCTS_CONFIG);
    if (state.winner === null && !state.draw) {
      samples.push({ features: extractDeepSetFeatures(state, activeIdx), player: activeIdx });
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
  return JSON.parse(
    JSON.stringify({
      // kind is load-bearing here, not decoration -- score.js's scoreState dispatch reads it to route
      // to deepSetValueNet.js's forward instead of valueNet.js's flat one. Omitting it (easy to miss,
      // since createNet's own return value has it and this only LOOKS like a plain deep-copy) would
      // silently misroute every candidate net through the wrong forward pass during verify().
      kind: 'deepset',
      unitFeatureSize: net.unitFeatureSize,
      unitEmbedSize: net.unitEmbedSize,
      combinerHiddenSize: net.combinerHiddenSize,
      combinerInputSize: net.combinerInputSize,
      outputScale: net.outputScale,
      WEnc: net.WEnc,
      bEnc: net.bEnc,
      WC1: net.WC1,
      bC1: net.bC1,
      WC2: net.WC2,
      bC2: net.bC2
    })
  );
}

/**
 * Trains a fresh net on `dataset` (90/10 train/val split) with early stopping. Same lr/patience
 * defaults and "snapshot on every val-loss improvement, restore that snapshot" logic as
 * bin/train_value_net.js's trainNet -- both fixes there were real bugs found the hard way (too-high
 * learning rate saturating tanh; returning whichever epoch training happened to stop on instead of
 * the actual best one), so this keeps them rather than re-deriving from scratch.
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

/** SPRT-gated self-play: candidateModel vs. championModel (either may be null = linear scoreState).
 * See bin/train_value_net.js's sprtVerify for the full rationale -- identical logic, duplicated per
 * this file pair's existing sibling-file convention rather than shared. */
function sprtVerify(candidateModel, championModel, maxGamesPerDeck, sprtParams = DEFAULT_SPRT) {
  const bounds = sprtBounds(sprtParams);
  const maxGames = maxGamesPerDeck * decks.length;
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0, llr = 0, total = 0;

  for (; total < maxGames; total++) {
    const deck = decks[total % decks.length];
    const candidateIsA = total % 2 === 0;
    const r = playGame(deck, deck, {
      valueModelA: candidateIsA ? candidateModel : championModel,
      valueModelB: candidateIsA ? championModel : candidateModel
    });
    let candidateWon = false;
    if (r.draw) draws++;
    else if (r.timedOut) timeouts++;
    else if ((r.winner === 0) === candidateIsA) {
      winsCandidate++;
      candidateWon = true;
    } else winsChampion++;

    llr += llrIncrement(candidateWon, sprtParams);
    const verdict = sprtVerdict(llr, bounds);
    if (verdict) return finalize(verdict);
  }
  return finalize('inconclusive');

  function finalize(verdict) {
    const n = total + 1;
    const winRate = winsCandidate / n;
    return { winsCandidate, winsChampion, draws, timeouts, total: n, winRate, z: zScore(winRate, n), llr, verdict };
  }
}

const rawArgs = process.argv.slice(2);
const RESUME = rawArgs.includes('--resume');
const positional = rawArgs.filter((a) => a !== '--resume');
const GAMES_PER_ROUND = Number(positional[0] || 2500);
const MAX_ROUNDS = Number(positional[1] || 5);
// SPRT safety caps (games/deck), not fixed spends -- see bin/train_value_net.js for the full rationale.
const VERIFY_MAX_GAMES_PER_DECK = Number(positional[2] || Math.max(1, Math.round(2940 / decks.length)));
const CONFIRM_MAX_GAMES_PER_DECK = Number(positional[3] || Math.max(1, Math.round(5880 / decks.length)));
const REPLAY_WINDOW_ROUNDS = Number(positional[4] || 1); // 1 = old exact behavior (this round's data only)

// Separate path from data/valueNet.json (the flat net) -- never overwritten by this script, so the
// shipped flat net stays the live default the entire time this architecture is developed/verified.
const VALUE_NET_PATH = path.join(__dirname, '..', 'data', 'valueNetDeepSet.json');
let champion = null; // null = today's linear scoreState (DEFAULT_WEIGHTS)
if (RESUME) {
  champion = loadNet(VALUE_NET_PATH);
  console.log(`Resuming from ${VALUE_NET_PATH} as the starting champion.`);
}

console.log(
  `[DeepSets] ${decks.length} decks; ${GAMES_PER_ROUND} games/round for data collection, up to ${MAX_ROUNDS} rounds, ` +
    `SPRT verify (p0=${DEFAULT_SPRT.p0}, p1=${DEFAULT_SPRT.p1}, cap ${VERIFY_MAX_GAMES_PER_DECK} games/deck), ` +
    `final confirm cap ${CONFIRM_MAX_GAMES_PER_DECK} games/deck, replay window ${REPLAY_WINDOW_ROUNDS} round(s)\n`
);

const roundLog = [];
const startedAt = Date.now();
const replayBuffer = []; // [{round, dataset}, ...], oldest first, capped at REPLAY_WINDOW_ROUNDS entries

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`--- Round ${round} ---`);
  const t0 = Date.now();

  console.log(`  collecting ${GAMES_PER_ROUND} self-play games...`);
  const { dataset, gamesPlayed, draws, timeouts } = collectData(GAMES_PER_ROUND, champion);
  console.log(`  ${dataset.length} samples from ${gamesPlayed} games (draws=${draws}, timeouts=${timeouts})`);

  replayBuffer.push({ round, dataset });
  if (replayBuffer.length > REPLAY_WINDOW_ROUNDS) replayBuffer.shift();
  const trainingData = replayBuffer.length > 1 ? replayBuffer.flatMap((entry) => entry.dataset) : dataset;

  console.log(
    replayBuffer.length > 1
      ? `  training on ${trainingData.length} samples pooled from rounds ${replayBuffer[0].round}-${round}...`
      : `  training...`
  );
  const { net: candidate, history } = trainNet(trainingData, 1000 + round);

  console.log(`  SPRT-verifying candidate vs. current champion (cap ${VERIFY_MAX_GAMES_PER_DECK} games/deck)...`);
  const v = sprtVerify(candidate, champion, VERIFY_MAX_GAMES_PER_DECK);
  console.log(
    `  candidate ${v.winsCandidate}-${v.winsChampion} champion (${(v.winRate * 100).toFixed(1)}%, z=${v.z.toFixed(2)}, ` +
      `llr=${v.llr.toFixed(2)}, n=${v.total}, draws=${v.draws}, timeouts=${v.timeouts})` +
      (v.verdict === 'accept'
        ? ' <-- ADOPTED'
        : v.verdict === 'reject'
          ? ' <-- rejected, stopping'
          : ' <-- inconclusive (hit safety cap without resolving), stopping')
  );

  roundLog.push({
    round,
    gamesPlayed,
    samples: dataset.length,
    draws,
    timeouts,
    finalEpoch: history[history.length - 1],
    verify: v,
    adopted: v.verdict === 'accept',
    elapsedMs: Date.now() - t0
  });

  if (v.verdict === 'accept') {
    champion = candidate;
  } else {
    console.log(`\nStopping after round ${round}: ${v.verdict === 'reject' ? 'confirmed no improvement' : 'inconclusive result'}.`);
    break;
  }
  if (round === MAX_ROUNDS) console.log(`\nHit MAX_ROUNDS (${MAX_ROUNDS}) with improvement still happening -- stopping as a safety valve.`);
}

console.log(`\nTotal elapsed: ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`);

let confirmation = null;
if (champion) {
  console.log(
    `\n--- Final confirmation: adopted champion vs. original linear scoreState (SPRT, cap ` +
      `${decks.length} decks x ${CONFIRM_MAX_GAMES_PER_DECK} games/deck x 2 = ${decks.length * CONFIRM_MAX_GAMES_PER_DECK * 2} games) ---`
  );
  confirmation = sprtVerify(champion, null, CONFIRM_MAX_GAMES_PER_DECK);
  console.log(
    `Champion net ${confirmation.winsCandidate}-${confirmation.winsChampion} linear scoreState ` +
      `(${(confirmation.winRate * 100).toFixed(1)}%, z=${confirmation.z.toFixed(2)}, llr=${confirmation.llr.toFixed(2)}, ` +
      `n=${confirmation.total}, draws=${confirmation.draws}, timeouts=${confirmation.timeouts})` +
      (confirmation.verdict === 'accept'
        ? ' <-- SIGNIFICANT OVERALL WIN'
        : confirmation.verdict === 'reject'
          ? ' <-- SIGNIFICANT OVERALL LOSS (do not adopt!)'
          : ' <-- inconclusive')
  );

  saveNet(champion, VALUE_NET_PATH);
  console.log(`\nChampion net saved to ${VALUE_NET_PATH}`);
} else {
  console.log('\nNo round ever beat the original linear scoreState -- nothing to save.');
}

const resultPath = path.join(__dirname, '..', 'scratchpad', 'train_value_net_deepset_result.json');
fs.writeFileSync(resultPath, JSON.stringify({ roundLog, confirmation }, null, 2));
console.log(`Full round-by-round log written to ${resultPath}`);
