// One-off scratch tool: A/B tests scoreState weight variants against the current baseline in
// mirrored self-play (same deck both sides, only the weights differ), across several real decks so
// results aren't tied to one archetype's quirks.
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

const DECK_NAMES = ['deck1.txt', 'deck8.txt', 'deck14.txt', 'deck29.txt']; // varied archetypes
const GAMES_PER_DECK = Number(process.argv[2] || 100);

const VARIANTS = {
  boardHeavy: { ...DEFAULT_WEIGHTS, boardStats: 2 },
  handLight: { ...DEFAULT_WEIGHTS, hand: 0.5 },
  shieldsHeavy: { ...DEFAULT_WEIGHTS, shields: 15 },
  noResourceTerm: { ...DEFAULT_WEIGHTS, resources: 0 }
};

for (const [name, weights] of Object.entries(VARIANTS)) {
  let winsVariant = 0, winsBaseline = 0, draws = 0, timeouts = 0;
  for (const deckName of DECK_NAMES) {
    const deck = loadDeck(deckName);
    for (let i = 0; i < GAMES_PER_DECK; i++) {
      // Alternate which side (A/B) gets the variant so deck-A/B asymmetries (e.g. EX Resource,
      // who's forced first/second isn't controlled by this) cancel out over many games.
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
