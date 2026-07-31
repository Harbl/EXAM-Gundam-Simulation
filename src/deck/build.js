/** Expands a validated, quantity-based decklist into the flat CardDef arrays initializeGame expects. */
function buildGameDeck(parsed, lookupCard) {
  const main = [];
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    for (let i = 0; i < entry.quantity; i++) main.push(def);
  }

  const resource = [];
  for (const entry of parsed.resource) {
    const color = entry.color.toLowerCase();
    const def = { number: `RESOURCE-${color.toUpperCase()}`, name: `${entry.color} Resource`, type: 'resource', color, cost: 0, level: 0 };
    for (let i = 0; i < entry.quantity; i++) resource.push(def);
  }

  return { main, resource };
}

module.exports = { buildGameDeck };
