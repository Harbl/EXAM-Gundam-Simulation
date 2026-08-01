const { LIMITS } = require('../rules/constants');

// 3-6/6-1-1: a Resource card has no color, cost, or Lv (2-4-2, 2-9-2, 2-10-2) and every resource
// deck is just 10 of them -- there's nothing for a decklist paste to configure here.
const RESOURCE_DEF = Object.freeze({ number: 'RESOURCE', name: 'Resource', type: 'resource' });

/** Expands a validated, quantity-based decklist into the flat CardDef arrays initializeGame expects. */
function buildGameDeck(parsed, lookupCard) {
  const main = [];
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    for (let i = 0; i < entry.quantity; i++) main.push(def);
  }

  const resource = new Array(LIMITS.RESOURCE_DECK_SIZE).fill(RESOURCE_DEF);

  return { main, resource };
}

module.exports = { buildGameDeck };
