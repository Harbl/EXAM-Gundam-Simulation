const CARD_LINE = /^(\d+)\s+(.+?)\s+([A-Z]{1,4}\d{0,2}-[A-Z0-9]{2,4})$/i;
const RESOURCE_ENTRY = /(\d+)\s+(\w+)\s+Resource/i;

/**
 * Parses a plain-text decklist, e.g.:
 *   4 Zaku II ST03-008
 *   1 Char's Gelgoog GD01-023
 *   6 Blue Resource / 4 Green Resource
 * `//`-prefixed lines are treated as comments and ignored.
 */
function parseDecklistText(text) {
  const main = [];
  const resource = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    if (/resource/i.test(line)) {
      let matched = false;
      for (const part of line.split('/')) {
        const m = part.match(RESOURCE_ENTRY);
        if (m) {
          resource.push({ quantity: Number(m[1]), color: m[2] });
          matched = true;
        }
      }
      if (matched) continue;
    }

    const cardMatch = line.match(CARD_LINE);
    if (!cardMatch) {
      throw new Error(`Could not parse decklist line: "${rawLine}"`);
    }
    main.push({ quantity: Number(cardMatch[1]), name: cardMatch[2].trim(), number: cardMatch[3].toUpperCase() });
  }

  return { main, resource };
}

module.exports = { parseDecklistText };
