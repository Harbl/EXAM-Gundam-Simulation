// One-off scratch tool: rigorous scoreState weight tuning. Runs each candidate variant against the
// current champion in mirrored self-play (same deck both sides, weights differ) across many decks
// and many games/deck -- large enough samples (thousands per variant) that a win rate needs a real
// z-score to be believed, unlike the earlier ~400-900-game sweep that produced a result which flatly
// reversed sign on a different deck sample.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_WEIGHTS } = require('../src/ai/score');
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

const DECK_NAMES = [
  'deck1.txt', 'deck3.txt', 'deck8.txt', 'deck9.txt', 'deck14.txt',
  'deck17.txt', 'deck22.txt', 'deck24.txt', 'deck29.txt', 'deck34.txt'
];
const GAMES_PER_DECK = Number(process.argv[3] || 500);
const decks = DECK_NAMES.map((n) => ({ name: n, deck: loadDeck(n) }));

function runVariant(champion, candidate) {
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0;
  for (const { deck } of decks) {
    for (let i = 0; i < GAMES_PER_DECK; i++) {
      const candidateIsA = i % 2 === 0;
      const r = playGame(deck, deck, {
        weightsA: candidateIsA ? candidate : champion,
        weightsB: candidateIsA ? champion : candidate
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

// Candidate name -> weights, passed as a JSON arg so this script is reusable across rounds without editing.
const candidatesArg = process.argv[2];
const CANDIDATES = candidatesArg
  ? JSON.parse(candidatesArg)
  : {
      boardHeavy: { ...DEFAULT_WEIGHTS, boardStats: 2 },
      boardLight: { ...DEFAULT_WEIGHTS, boardStats: 0.5 },
      handLight: { ...DEFAULT_WEIGHTS, hand: 1 },
      handHeavy: { ...DEFAULT_WEIGHTS, hand: 3 },
      shieldsUp: { ...DEFAULT_WEIGHTS, shields: 13 },
      shieldsDown: { ...DEFAULT_WEIGHTS, shields: 7 },
      resourcesUp: { ...DEFAULT_WEIGHTS, resources: 2 },
      resourcesDown: { ...DEFAULT_WEIGHTS, resources: 0 }
    };

const CHAMPION = process.argv[4] ? JSON.parse(process.argv[4]) : DEFAULT_WEIGHTS;

console.log(`Champion: ${JSON.stringify(CHAMPION)}`);
console.log(`${decks.length} decks x ${GAMES_PER_DECK} games/deck x 2 = ${decks.length * GAMES_PER_DECK} games per variant\n`);

for (const [name, weights] of Object.entries(CANDIDATES)) {
  const r = runVariant(CHAMPION, weights);
  const flag = Math.abs(r.z) >= 2.5 ? (r.z > 0 ? ' <-- SIGNIFICANT WIN' : ' <-- SIGNIFICANT LOSS') : '';
  console.log(
    `${name}: ${r.winsCandidate}-${r.winsChampion} (${(r.winRate * 100).toFixed(1)}%, z=${r.z.toFixed(2)}, draws=${r.draws}, timeouts=${r.timeouts})${flag}`
  );
}
