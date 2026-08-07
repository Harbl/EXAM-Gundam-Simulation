// Phase 5 step 2: does a bigger playoutBudget/rolloutPolicy config actually play better, not just cost
// more? Same-deck self-play, candidate vs. the current DEFAULT_MCTS_CONFIG champion, alternating sides,
// z-score gated -- same rigor as weight_tune.js/mcts_vs_lookahead.js, reused here for mctsConfig instead
// of aiWeights via playGame's existing mctsConfigA/mctsConfigB options.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const { loadNet } = require('../src/ai/valueNet');
const banlist = require('../data/banlist.json');

// Both sides get the trained net (data/valueNet.json, adopted as the app's default evaluator
// 2026-08-05) so this isolates the search-budget effect alone -- the original BALANCED_MCTS_CONFIG
// finding (52.2%, z=2.90, n=4200) was measured under the old linear scoreState, before that net
// existed. Re-running the same comparison now answers "does the budget bump still help with a much
// sharper evaluator" instead of assuming the old result still holds.
const VALUE_MODEL = loadNet(path.join(__dirname, '..', 'data', 'valueNet.json'));

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

const DECK_NAMES = ['deck3.txt', 'deck9.txt', 'deck24.txt', 'deck31.txt', 'deck45.txt', 'deck70.txt'];
const GAMES_PER_DECK = Number(process.argv[3] || 25);
const decks = DECK_NAMES.map((n) => ({ name: n, deck: loadDeck(n) }));

function runVariant(champion, candidate) {
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0;
  for (const { deck } of decks) {
    for (let i = 0; i < GAMES_PER_DECK; i++) {
      const candidateIsA = i % 2 === 0;
      const r = playGame(deck, deck, {
        mctsConfigA: candidateIsA ? candidate : champion,
        mctsConfigB: candidateIsA ? champion : candidate,
        valueModelA: VALUE_MODEL,
        valueModelB: VALUE_MODEL
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

const candidatesArg = process.argv[2];
const CANDIDATES = candidatesArg
  ? JSON.parse(candidatesArg)
  : {
      'cheap/400/2': { playoutBudget: 400, rolloutTurns: 2, rolloutPolicy: 'cheap' },
      'good/10/1': { playoutBudget: 10, rolloutTurns: 1, rolloutPolicy: 'good' }
    };

console.log(`Champion: DEFAULT_MCTS_CONFIG = ${JSON.stringify(DEFAULT_MCTS_CONFIG)}`);
console.log(`${decks.length} decks x ${GAMES_PER_DECK} games/deck = ${decks.length * GAMES_PER_DECK} games per candidate\n`);

const t0 = Date.now();
for (const [name, cfg] of Object.entries(CANDIDATES)) {
  const r = runVariant(DEFAULT_MCTS_CONFIG, cfg);
  const flag = Math.abs(r.z) >= 2.5 ? (r.z > 0 ? ' <-- SIGNIFICANT WIN' : ' <-- SIGNIFICANT LOSS') : '';
  console.log(
    `${name}: ${r.winsCandidate}-${r.winsChampion} (${(r.winRate * 100).toFixed(1)}%, z=${r.z.toFixed(2)}, draws=${r.draws}, timeouts=${r.timeouts})${flag}`
  );
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
