const NUMBER = '[A-Z]{1,4}\\d{0,2}-[A-Z0-9]{2,4}';
const NUMBER_TOKEN_RE = new RegExp(`^\\(?(${NUMBER})\\)?$`, 'i');

function stripParens(token) {
  const m = token.match(/^\((.+)\)$/);
  return m ? m[1] : token;
}

/**
 * Parses one decklist line into {quantity, name, number}, or returns null if it doesn't look like
 * one at all. Rather than a fixed list of exact line shapes (quantity+name+number, quantity+
 * number+name, etc. -- which grows a new regex every time a new site's export format shows up, and
 * is easy to get the ordering of wrong), this identifies the quantity, then checks only the two
 * positions a card number can ever really appear: the token immediately after the quantity, or the
 * token at the very end of the line (optionally wrapped in parens). Whatever's left over is the
 * name. This covers every real ordering/spacing/paren variant seen so far without a new pattern per
 * format.
 *
 * The end-of-line position is checked first and wins on ambiguity, e.g. "4 Re-GZ GD05-019" --
 * "Re-GZ" is itself shaped like a card number (letters-hyphen-alnum), same as "G-Self"/"Hi-Nu" etc,
 * so if the first-token position won unconditionally it would misparse this as number=RE-GZ,
 * name=GD05-019. End-of-line wins because trailing-number is by far the dominant real-world
 * convention. The one case this can't disambiguate is a number-first line whose *name* also happens
 * to look number-shaped (e.g. a hypothetical "2 GD05-019 Re-GZ") -- not something that's come up in
 * practice, and not solvable without more context than the line itself provides.
 */
function parseLine(line) {
  const qm = line.match(/^(\d+)\s*(.*)$/);
  if (!qm) return null;
  const quantity = Number(qm[1]);
  const rest = qm[2].trim();

  // "4xST05-004", "4 x ST01-005", "4X ST01-005" -- an explicit x/X multiplier, no name. Only accepted
  // when the *entire* remainder after the x/X reduces to nothing but a bare number -- that's what
  // keeps a name starting with "X" (Xi Gundam, ...) from ever getting its leading letter eaten as a
  // multiplier, since such a line always has more text after the "X" than just a number.
  const multiplierMatch = rest.match(new RegExp(`^[xX]\\s*(${NUMBER})$`, 'i'));
  if (multiplierMatch) return { quantity, name: '', number: multiplierMatch[1].toUpperCase() };

  if (!rest) return null;
  const parts = rest.split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];

  if (NUMBER_TOKEN_RE.test(last)) {
    return { quantity, name: parts.slice(0, -1).join(' '), number: stripParens(last).toUpperCase() };
  }
  if (parts.length > 1 && NUMBER_TOKEN_RE.test(first)) {
    return { quantity, name: parts.slice(1).join(' '), number: stripParens(first).toUpperCase() };
  }
  return null;
}

/**
 * Parses a plain-text decklist. Accepts real-world quantity/name/number orderings and separators
 * (see parseLine above) -- decklists pasted from different sites/apps vary on this. `//`-prefixed
 * lines are treated as comments and ignored. There's no resource-deck line: per 6-1-1/2-4-2, a
 * resource deck is always exactly 10 colorless Resource cards with no other distinguishing property,
 * so it's never something a decklist paste needs to specify.
 */
function parseDecklistText(text) {
  const main = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const entry = parseLine(line);
    if (!entry) {
      throw new Error(`Could not parse decklist line: "${rawLine}"`);
    }
    main.push(entry);
  }

  return { main };
}

module.exports = { parseDecklistText };
