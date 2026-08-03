const NUMBER = '[A-Z]{1,4}\\d{0,2}-[A-Z0-9]{2,4}';

// Tried in order for each line. Every pattern anchors the card-number token to its own distinctive
// shape (letters-digits-hyphen-alphanumerics), which real card names never happen to match -- that's
// what lets a pattern fail cleanly and fall through to the next one instead of misparsing, e.g. a
// name that happens to start with "X" (Xi Gundam, Kshatriya's pilot, etc.) never gets its leading
// letter mistaken for a "4x"-style multiplier, since patterns 1-2 require the *entire* remainder of
// the line to be just the number, not just a name that happens to start the right letter.
const LINE_FORMATS = [
  // "4xST05-004", "4 x ST01-005", "4X ST01-005" -- an explicit x/X multiplier, no name.
  { re: new RegExp(`^(\\d+)\\s*[xX]\\s*(${NUMBER})$`, 'i'), groups: ['quantity', 'number'] },
  // "4 ST03-008" -- quantity and number only, no name.
  { re: new RegExp(`^(\\d+)\\s+(${NUMBER})$`, 'i'), groups: ['quantity', 'number'] },
  // "2 GD01-039 Dopp" -- quantity, then number, then name.
  { re: new RegExp(`^(\\d+)\\s+(${NUMBER})\\s+(.+)$`, 'i'), groups: ['quantity', 'number', 'name'] },
  // "4 Zaku II ST03-008" -- quantity, then name, then number (the original/most common format).
  { re: new RegExp(`^(\\d+)\\s+(.+?)\\s+(${NUMBER})$`, 'i'), groups: ['quantity', 'name', 'number'] }
];

/**
 * Parses a plain-text decklist. Accepts several real-world quantity/name/number orderings and
 * separators (see LINE_FORMATS above) -- decklists pasted from different sites/apps vary on this.
 * `//`-prefixed lines are treated as comments and ignored. There's no resource-deck line: per
 * 6-1-1/2-4-2, a resource deck is always exactly 10 colorless Resource cards with no other
 * distinguishing property, so it's never something a decklist paste needs to specify.
 */
function parseDecklistText(text) {
  const main = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    let entry = null;
    for (const format of LINE_FORMATS) {
      const match = line.match(format.re);
      if (!match) continue;
      entry = { quantity: 0, name: '', number: '' };
      format.groups.forEach((group, i) => {
        entry[group] = match[i + 1].trim();
      });
      break;
    }
    if (!entry) {
      throw new Error(`Could not parse decklist line: "${rawLine}"`);
    }
    main.push({ quantity: Number(entry.quantity), name: entry.name, number: entry.number.toUpperCase() });
  }

  return { main };
}

module.exports = { parseDecklistText };
