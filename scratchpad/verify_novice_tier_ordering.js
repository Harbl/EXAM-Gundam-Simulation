// Before adding a "Novice" skill tier between Beginner (old lookahead AI) and Casual (MCTS fast,
// 25 playouts), verify the intended ordering actually holds: does MCTS at a much smaller playout
// budget (12, already measured elsewhere as a real, significant loss vs the 25-playout default,
// z=-2.30) actually beat the old lookahead AI outright? Don't assume just because it's "still MCTS".
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');

const WEAK_MCTS_CONFIG = { playoutBudget: 12, rolloutTurns: 2, rolloutPolicy: 'cheap' };

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const DECKS = ['barbatos_real.txt', 'nu_gundam_real.txt'];
const N = Number(process.argv[2] || 40);

let weakerMctsWins = 0, total = 0;
for (const deckName of DECKS) {
  const deck = loadDeck(deckName);
  for (let i = 0; i < N; i++) {
    const mctsIsA = i % 2 === 0;
    const options = mctsIsA
      ? { engineA: 'mcts', mctsConfigA: WEAK_MCTS_CONFIG, engineB: 'lookahead' }
      : { engineB: 'mcts', mctsConfigB: WEAK_MCTS_CONFIG, engineA: 'lookahead' };
    const result = playGame(deck, deck, options);
    if (result.winner === null) continue;
    total++;
    const mctsIdx = mctsIsA ? 0 : 1;
    if (result.winner === mctsIdx) weakerMctsWins++;
  }
}

console.log(`MCTS(playoutBudget=12) vs old-lookahead, same deck both sides, ${total} decided games across ${DECKS.length} decklists`);
console.log(`MCTS(12) win rate: ${weakerMctsWins}/${total} (${((weakerMctsWins / total) * 100).toFixed(1)}%)`);
