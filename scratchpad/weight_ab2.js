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

const DECK_NAMES = ['deck1.txt', 'deck8.txt', 'deck14.txt', 'deck29.txt', 'deck17.txt', 'deck22.txt'];
const GAMES_PER_DECK = Number(process.argv[2] || 100);

const VARIANTS = {
  shields12: { ...DEFAULT_WEIGHTS, shields: 12 },
  shields15: { ...DEFAULT_WEIGHTS, shields: 15 },
  shields20: { ...DEFAULT_WEIGHTS, shields: 20 }
};

for (const [name, weights] of Object.entries(VARIANTS)) {
  let winsVariant = 0, winsBaseline = 0, draws = 0, timeouts = 0;
  for (const deckName of DECK_NAMES) {
    const deck = loadDeck(deckName);
    for (let i = 0; i < GAMES_PER_DECK; i++) {
      const variantIsA = i % 2 === 0;
      const r = playGame(deck, deck, {
        weightsA: variantIsA ? weights : DEFAULT_WEIGHTS,
        weightsB: variantIsA ? DEFAULT_WEIGHTS : weights
      });
      if (r.draw) draws++;
      else if (r.timedOut) timeouts++;
      else if ((r.winner === 0) === variantIsA) winsVariant++;
      else winsBaseline++;
    }
  }
  const total = winsVariant + winsBaseline + draws + timeouts;
  console.log(
    `${name}: variant ${winsVariant}-${winsBaseline} baseline (${((winsVariant / total) * 100).toFixed(1)}%), draws=${draws}, timeouts=${timeouts}`
  );
}
