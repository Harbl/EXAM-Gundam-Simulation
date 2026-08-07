#!/usr/bin/env node
// Trains a valueNet.js model to replace ai/score.js's hand-picked linear scoreState formula, via
// iterative self-play (see Phase 7 of the plan). A real, reusable CLI (not scratchpad) -- meant to be
// re-run again as cards/AI evolve, same precedent as bin/simulate.js.
//
// Each round: (1) collect self-play data using the current champion (round 0 = no valueModel, i.e.
// today's linear scoreState), sampling a feature vector after every main phase and labeling it with
// that game's final outcome (a Monte-Carlo target, +/-OUTPUT_SCALE win/loss, 0 draw -- timed-out games
// are discarded, ambiguous outcome); (2) train a fresh net on a replay window of the last few rounds'
// pooled data (not just this round's own batch -- see REPLAY_WINDOW_ROUNDS below) with early stopping;
// (3) verify the candidate against the current champion via SPRT self-play (src/ai/sprt.js -- plays
// games one at a time and stops as soon as the result is a definitive accept/reject, instead of a fixed
// sample size that can come back ambiguous); (4) adopt on accept and repeat, or stop -- same "keep going
// until no more improvement" rule already used for scratchpad/weight_coordinate_descent.js, one tier up.
//
// Usage: node bin/train_value_net.js [gamesPerRound] [maxRounds] [verifyMaxGamesPerDeck] [confirmMaxGamesPerDeck] [replayWindowRounds] [--resume]
//   verifyMaxGamesPerDeck/confirmMaxGamesPerDeck are now safety caps, not fixed spends -- SPRT stops
//   as soon as it resolves, and only runs up to the cap in the (rare, near-p0) case where it doesn't.
//   replayWindowRounds (default 1 = old exact behavior): how many of the most recent rounds' self-play
//   datasets stay pooled for training, instead of discarding a round's ~37k samples the instant its
//   candidate doesn't get adopted. Adapted from MuZero Unplugged's "Reanalyze" -- can't reuse that
//   technique literally here (Reanalyze re-labels old trajectories with the current model's value
//   estimate, but this project's targets are the real Monte-Carlo game outcome, which never changes),
//   but the underlying "don't throw away still-valid self-play games just because their round's
//   candidate didn't win" idea carries over as a rolling replay window -- standard practice in most
//   real self-play RL implementations (a bounded window, not the literal full history, so training
//   doesn't end up dominated by games collected under a much weaker, long-superseded champion).
//   --resume starts from the currently saved data/valueNet.json as the champion (continuing training
//   from the best model found so far) instead of round 0's default starting point (today's linear
//   scoreState). Verification/confirmation are always against the true baseline this run started from,
//   so a --resume run's "SIGNIFICANT OVERALL WIN" still means "beats the linear formula," not just
//   "beats where we left off."
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
const { extractFeatures } = require('../src/ai/valueFeatures');
const { createNet, forward, trainStep, saveNet, loadNet, OUTPUT_SCALE } = require('../src/ai/valueNet');
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

// Was a fixed 10-deck spread (same one weight_tune.js/weight_coordinate_descent.js used). Widened
// (2026-08-05) to the entire real decklist pool -- same directory value_net_crash_sweep.js already
// reads in full -- since a value net trained/verified against only 10 decks generalizing to the other
// ~180 was itself an untested assumption, and the earlier feature-count expansion in valueFeatures.js
// was motivated by exactly this kind of "is the model actually seeing enough of the real distribution"
// question. VERIFY_GAMES_PER_DECK/CONFIRM_GAMES_PER_DECK below are recalibrated down proportionally so
// the total game budget (what actually drives z-score power) stays in the same practical ballpark as
// the old 10-deck defaults, just spread across far more distinct decks instead of repeating a few.
const DECKLISTS_DIR = path.join(__dirname, '..', 'scratchpad', 'decklists');
const DECK_NAMES = fs.readdirSync(DECKLISTS_DIR);
const decks = DECK_NAMES.map((n) => loadDeck(n));

function zScore(winRate, n) {
  const se = Math.sqrt(0.25 / n);
  return (winRate - 0.5) / se;
}

// Self-play *data collection* now runs at BALANCED_MCTS_CONFIG's playout budget (100, up from
// DEFAULT_MCTS_CONFIG's 25) -- confirmed 2026-08-05 (scratchpad/mcts_valuenet_budget_compare.js) that
// the budget bump still holds a significant edge (53.3%, z=4.26, n=4200) even with the trained net as
// evaluator, so it's not redundant with the net itself. Training on higher-quality self-play games
// should teach the net more than the same volume of cheaper/noisier ones would. verify()/the final
// confirmation deliberately stay at the implicit DEFAULT_MCTS_CONFIG fallback (unchanged) rather than
// also paying the ~4x per-game cost there -- this isolates "does training on better data help" as its
// own question, and keeps this run in the same runtime ballpark as prior ones instead of ~4x longer.
const SELFPLAY_MCTS_CONFIG = BALANCED_MCTS_CONFIG;

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
    runMainPhaseMCTS(state, activeIdx, undefined, SELFPLAY_MCTS_CONFIG);
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

/** SPRT-gated self-play: candidateModel vs. championModel (either may be null = linear scoreState).
 * Plays games one at a time, deck-cycling and alternating which side is the candidate exactly like the
 * old fixed-sample verify() did, but stops as soon as src/ai/sprt.js's stopping rule resolves rather
 * than always spending a fixed sample -- up to a `maxGamesPerDeck * decks.length` safety cap for the
 * (rare) case the true rate sits too close to p0 to resolve quickly. `z` is kept for display continuity
 * with every existing log, but `verdict` ('accept'/'reject'/'inconclusive') is what decides adoption. */
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
// These are now SPRT safety caps (games/deck), not fixed spends -- SPRT stops as soon as it resolves
// accept/reject and only approaches the cap when the true rate sits too close to p0 to resolve fast.
// Verify (runs every round) gets a smaller cap than confirm (runs once, can afford to be patient) --
// both comfortably above the 3920-game rerun this project already needed once under the old fixed-N
// scheme, so a real effect at DEFAULT_SPRT.p1's scale should resolve well inside either cap.
const VERIFY_MAX_GAMES_PER_DECK = Number(positional[2] || Math.max(1, Math.round(2940 / decks.length)));
const CONFIRM_MAX_GAMES_PER_DECK = Number(positional[3] || Math.max(1, Math.round(5880 / decks.length)));
const REPLAY_WINDOW_ROUNDS = Number(positional[4] || 1); // 1 = old exact behavior (this round's data only)

const VALUE_NET_PATH = path.join(__dirname, '..', 'data', 'valueNet.json');
let champion = null; // null = today's linear scoreState (DEFAULT_WEIGHTS)
if (RESUME) {
  champion = loadNet(VALUE_NET_PATH);
  console.log(`Resuming from ${VALUE_NET_PATH} as the starting champion.`);
}

console.log(
  `${decks.length} decks; ${GAMES_PER_ROUND} games/round for data collection, up to ${MAX_ROUNDS} rounds, ` +
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

  const outPath = path.join(__dirname, '..', 'data', 'valueNet.json');
  saveNet(champion, outPath);
  console.log(`\nChampion net saved to ${outPath}`);
} else {
  console.log('\nNo round ever beat the original linear scoreState -- nothing to save.');
}

const resultPath = path.join(__dirname, '..', 'scratchpad', 'train_value_net_result.json');
fs.writeFileSync(resultPath, JSON.stringify({ roundLog, confirmation }, null, 2));
console.log(`Full round-by-round log written to ${resultPath}`);
