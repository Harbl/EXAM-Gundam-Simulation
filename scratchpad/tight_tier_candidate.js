// Re-deriving the skill ladder after promoting BALANCED_MCTS_CONFIG's numbers to be the new
// default/'casual' tier (see project memory / plan doc): does a playoutBudget=400 config
// (still 'cheap' rollout) beat the new casual(100) baseline enough to serve as a distinct 'tight'
// tier? Same z-gated self-play shape as mcts_config_compare.js, but champion is the new casual(100)
// baseline explicitly, not today's still-unedited DEFAULT_MCTS_CONFIG.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
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

const DECK_NAMES = ['deck3.txt', 'deck9.txt', 'deck24.txt', 'deck31.txt', 'deck45.txt', 'deck70.txt'];
const GAMES_PER_DECK = Number(process.argv[2] || 400);
const decks = DECK_NAMES.map((n) => ({ name: n, deck: loadDeck(n) }));

const champion = { playoutBudget: 100, rolloutTurns: 2, rolloutPolicy: 'cheap' }; // new casual
const candidate = { playoutBudget: 400, rolloutTurns: 2, rolloutPolicy: 'cheap' }; // tight candidate

let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0;
const t0 = Date.now();
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
const z = zScore(winRate, total);
const flag = Math.abs(z) >= 2.5 ? (z > 0 ? ' <-- SIGNIFICANT WIN' : ' <-- SIGNIFICANT LOSS') : '';
console.log(`${decks.length} decks x ${GAMES_PER_DECK} games/deck = ${total} games`);
console.log(
  `budget400 ${winsCandidate}-${winsChampion} budget100 (${(winRate * 100).toFixed(1)}%, z=${z.toFixed(2)}, draws=${draws}, timeouts=${timeouts})${flag}`
);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s total`);
