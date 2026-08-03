// Phase 5 step 2 measurement spike: real per-game cost across the two independent axes of the
// cost/quality tradeoff (more playouts under cheap rollout vs. fewer playouts under good rollout),
// post REWARD_SCALE fix. Measure, don't guess, before naming config tiers -- same discipline as the
// original (deleted) mcts_spike.js. Both sides run the same config (mirrored self-play), 6 decks.
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

const DECK_NAMES = ['deck3.txt', 'deck9.txt', 'deck24.txt'];
const decks = DECK_NAMES.map(loadDeck);

const CONFIGS = {
  'cheap/25/2 (current default)': { playoutBudget: 25, rolloutTurns: 2, rolloutPolicy: 'cheap' },
  'cheap/50/2': { playoutBudget: 50, rolloutTurns: 2, rolloutPolicy: 'cheap' },
  'cheap/100/2': { playoutBudget: 100, rolloutTurns: 2, rolloutPolicy: 'cheap' },
  'cheap/200/2': { playoutBudget: 200, rolloutTurns: 2, rolloutPolicy: 'cheap' },
  'cheap/400/2': { playoutBudget: 400, rolloutTurns: 2, rolloutPolicy: 'cheap' },
  'good/10/1': { playoutBudget: 10, rolloutTurns: 1, rolloutPolicy: 'good' },
  'good/25/1': { playoutBudget: 25, rolloutTurns: 1, rolloutPolicy: 'good' },
  'good/25/2 (current strong)': { playoutBudget: 25, rolloutTurns: 2, rolloutPolicy: 'good' }
};

const GAMES_PER_DECK = Number(process.argv[2] || 4);

for (const [name, cfg] of Object.entries(CONFIGS)) {
  const t0 = Date.now();
  let games = 0;
  for (const deck of decks) {
    for (let i = 0; i < GAMES_PER_DECK; i++) {
      playGame(deck, deck, { mctsConfigA: cfg, mctsConfigB: cfg });
      games++;
    }
  }
  const elapsed = Date.now() - t0;
  console.log(`${name}: ${(elapsed / games).toFixed(0)}ms/game (${games} games, ${(elapsed / 1000).toFixed(1)}s total)`);
}
