const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck, resolveResourceDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { runBatch } = require('../src/sim/batch');
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

function buildJakesDeck() {
  const parsed = parseDecklistText(JAKES_DECKLIST);
  const validation = validateDeck(parsed, lookupCard, banlist);
  const resourceEntries = resolveResourceDeck(parsed.resource, validation.colors);
  return buildGameDeck({ main: parsed.main, resource: resourceEntries }, lookupCard);
}

test('runBatch aggregates results, reports progress every game, and yields well-formed stats', async () => {
  const deck = buildJakesDeck();
  const progressEvents = [];

  const stats = await runBatch(deck, deck, 5, (p) => progressEvents.push(p));

  assert.equal(progressEvents.length, 5);
  assert.deepEqual(progressEvents[4], { completed: 5, games: 5 });

  assert.equal(stats.games, 5);
  assert.equal(stats.deckA.wins + stats.deckB.wins + stats.timeouts, 5);
  assert.ok(stats.averageTurns > 0);
  for (const side of [stats.deckA, stats.deckB]) {
    assert.ok(side.winRate >= 0 && side.winRate <= 1);
    assert.ok(side.mulliganRate >= 0 && side.mulliganRate <= 1);
    assert.ok(side.turn1PlayRate <= side.turn2PlayRate);
    assert.ok(side.turn2PlayRate <= side.turn3PlayRate);
  }
});
