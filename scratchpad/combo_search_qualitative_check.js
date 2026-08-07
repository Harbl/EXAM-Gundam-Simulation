// Qualitative sanity check for comboSearchOdds/runCommandsLookahead (item 4, moonlit-hugging-shannon.md):
// does the 'beginner' (lookahead) engine now visibly hold/prioritize a draw Command while Char Aznable
// is in hand without a real Link target yet, and stop caring once Zeong is found/no longer needed?
// Not a win-rate check -- see the plan's own reasoning for why an SPRT gate doesn't apply to this item.
const { traceGame } = require('../src/sim/traceGame');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const banlist = require('../data/banlist.json');

const JAKES_DECKLIST = `
4 GM ST01-005
4 Guntank GD01-008
4 Zaku II ST03-008
4 Char's Zaku II GD01-026
4 Char's Zaku II ST03-006
4 Char Aznable ST03-011
4 Rick Dom GD01-030
4 ReZEL GD01-018
4 Amuro Ray ST01-010
4 Gundam ST01-001
4 A Show of Resolve GD01-100
2 Delta Plus GD01-006
2 Jaburo GD04-122
2 Zeong GD04-017
`;

function loadDeck() {
  const parsed = parseDecklistText(JAKES_DECKLIST);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(v.errors.join(' | '));
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const deck = loadDeck();
const seed = Number(process.argv[2] || 1);
const events = traceGame(deck, deck, seed, { engineA: 'lookahead', engineB: 'lookahead' });

for (const ev of events) {
  if (ev.type === 'command') {
    console.log(`turn ${ev.turn} p${ev.player}: played ${ev.card.number} (${ev.card.name})`);
  }
  if (ev.type === 'deploy' && ev.card.number === 'GD04-017') {
    console.log(`turn ${ev.turn} p${ev.player}: deployed Zeong`);
  }
  if (ev.type === 'pair' || (ev.type === 'whenPaired' && ev.pilot && ev.pilot.number === 'ST03-011')) {
    console.log(`turn ${ev.turn} p${ev.player}: pair event`, JSON.stringify(ev));
  }
}
