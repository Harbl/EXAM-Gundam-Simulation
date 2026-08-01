const CARD_LINE = /^(\d+)\s+(.+?)\s+([A-Z]{1,4}\d{0,2}-[A-Z0-9]{2,4})$/i;

/**
 * Parses a plain-text decklist, e.g.:
 *   4 Zaku II ST03-008
 *   1 Char's Gelgoog GD01-023
 * `//`-prefixed lines are treated as comments and ignored. There's no resource-deck line: per
 * 6-1-1/2-4-2, a resource deck is always exactly 10 colorless Resource cards with no other
 * distinguishing property, so it's never something a decklist paste needs to specify.
 */
function parseDecklistText(text) {
  const main = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const cardMatch = line.match(CARD_LINE);
    if (!cardMatch) {
      throw new Error(`Could not parse decklist line: "${rawLine}"`);
    }
    main.push({ quantity: Number(cardMatch[1]), name: cardMatch[2].trim(), number: cardMatch[3].toUpperCase() });
  }

  return { main };
}

module.exports = { parseDecklistText };
