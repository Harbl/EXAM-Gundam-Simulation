// Phase 5 step 3: empirical tuning pass for MCTS's own knobs (explorationC, playoutBudget,
// rolloutTurns), same rigor already established for scoreState's weights in weight_tune.js -- same
// deck both sides, candidate config vs. a champion config, z-score-gated significance across many
// decks/games rather than trusting a small sample. Reusable across rounds via a JSON candidates arg.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_MCTS_CONFIG, EXPLORATION_C } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

function zScore(winRate, n) {
  const se = Math.sqrt(0.25 / n);
  return (winRate - 0.5) / se;
}

// Same 10-deck sample weight_tune.js uses, for consistency across the project's tuning tools.
const DECK_NAMES = [
  'deck1.txt', 'deck3.txt', 'deck8.txt', 'deck9.txt', 'deck14.txt',
  'deck17.txt', 'deck22.txt', 'deck24.txt', 'deck29.txt', 'deck34.txt'
];
const GAMES_PER_DECK = Number(process.argv[3] || 40); // MCTS games cost much more per-game than weight_tune's scoreState-only variant -- default budget is much smaller
const decks = DECK_NAMES.map((n) => ({ name: n, deck: loadDeck(n) }));

function runVariant(champion, candidate) {
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0;
  for (const { deck } of decks) {
    for (let i = 0; i < GAMES_PER_DECK; i++) {
      const candidateIsA = i % 2 === 0;
      const r = playGame(deck, deck, {
        mctsConfigA: candidateIsA ? candidate : champion,
        mctsConfigB: candidateIsA ? champion : candidate
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

// Candidate name -> mctsConfig, passed as a JSON arg so this script is reusable across rounds without editing.
const candidatesArg = process.argv[2];
const CANDIDATES = candidatesArg
  ? JSON.parse(candidatesArg)
  : {
      // EXPLORATION_C sweep (post REWARD_SCALE fix -- see mcts.js) at the default budget/rollout.
      explorationLow: { ...DEFAULT_MCTS_CONFIG, explorationC: 0.7 },
      explorationHigh: { ...DEFAULT_MCTS_CONFIG, explorationC: 2.8 },
      explorationVeryHigh: { ...DEFAULT_MCTS_CONFIG, explorationC: 4 },
      // Budget sweep at the current EXPLORATION_C.
      moreBudget: { ...DEFAULT_MCTS_CONFIG, playoutBudget: 50 },
      lessBudget: { ...DEFAULT_MCTS_CONFIG, playoutBudget: 12 },
      // Rollout-horizon sweep.
      deeperRollout: { ...DEFAULT_MCTS_CONFIG, rolloutTurns: 4 },
      shallowerRollout: { ...DEFAULT_MCTS_CONFIG, rolloutTurns: 1 }
    };

const CHAMPION = process.argv[4] ? JSON.parse(process.argv[4]) : DEFAULT_MCTS_CONFIG;

console.log(`Champion: ${JSON.stringify(CHAMPION)} (module EXPLORATION_C default: ${EXPLORATION_C})`);
console.log(`${decks.length} decks x ${GAMES_PER_DECK} games/deck x 2 = ${decks.length * GAMES_PER_DECK} games per variant\n`);

const t0 = Date.now();
for (const [name, config] of Object.entries(CANDIDATES)) {
  const r = runVariant(CHAMPION, config);
  const flag = Math.abs(r.z) >= 2.5 ? (r.z > 0 ? ' <-- SIGNIFICANT WIN' : ' <-- SIGNIFICANT LOSS') : '';
  console.log(
    `${name} (${JSON.stringify(config)}): ${r.winsCandidate}-${r.winsChampion} (${(r.winRate * 100).toFixed(1)}%, z=${r.z.toFixed(2)}, draws=${r.draws}, timeouts=${r.timeouts})${flag}`
  );
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
