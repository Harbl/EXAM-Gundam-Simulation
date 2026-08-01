const { LIMITS } = require('../rules/constants');

/**
 * Validates a parsed main deck against card data and the banlist.
 * `lookupCard(number)` should return a card def or undefined if unresearched.
 */
function validateDeck(parsed, lookupCard, banlist) {
  const errors = [];
  const missingCards = [];
  const quantities = new Map();
  const colorCounts = new Map();

  let total = 0;
  for (const entry of parsed.main) {
    total += entry.quantity;
    quantities.set(entry.number, (quantities.get(entry.number) || 0) + entry.quantity);
    const def = lookupCard(entry.number);
    if (!def) {
      missingCards.push(entry.number);
      continue;
    }
    if (def.color) colorCounts.set(def.color, (colorCounts.get(def.color) || 0) + entry.quantity);
  }

  if (missingCards.length > 0) {
    errors.push(
      `Unresearched card(s), cannot simulate until added to the card database: ${missingCards.join(', ')}`
    );
  }

  if (total !== LIMITS.DECK_SIZE) {
    errors.push(`Main deck has ${total} cards, must be exactly ${LIMITS.DECK_SIZE}.`);
  }

  for (const [number, qty] of quantities) {
    const banned = banlist.banned.includes(number);
    const cap = banned ? 0 : banlist.restricted[number] !== undefined ? banlist.restricted[number] : LIMITS.MAX_COPIES;
    if (qty > cap) {
      errors.push(`${number}: ${qty} cop${qty === 1 ? 'y' : 'ies'} exceeds its limit of ${cap}${banned ? ' (banned)' : ''}.`);
    }
  }

  for (const [a, b] of banlist.bannedPairs) {
    if ((quantities.get(a) || 0) > 0 && (quantities.get(b) || 0) > 0) {
      errors.push(`${a} and ${b} cannot both be in the same deck (banned pair).`);
    }
  }

  const vanillaUsed = banlist.vanillaGroup.filter((n) => (quantities.get(n) || 0) > 0);
  if (vanillaUsed.length > 1) {
    errors.push(`Only one card number from the vanilla stat-twin group may be used; found ${vanillaUsed.join(', ')}.`);
  }

  if (colorCounts.size > 2) {
    errors.push(`Deck uses ${colorCounts.size} colors (${[...colorCounts.keys()].join(', ')}); a deck may use at most 2.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    missingCards,
    colors: [...colorCounts.keys()],
    colorCounts: Object.fromEntries(colorCounts)
  };
}

/**
 * Resource decks aren't derivable from card text (7-6-1: it's a deckbuilding choice), so if none
 * was pasted alongside the main deck, default to a split proportional to each color's actual share
 * of the main deck (not just an even split across however many colors it uses -- a 62/38 red/blue
 * deck should draw resources at roughly that ratio, not 50/50).
 */
function resolveResourceDeck(providedResourceEntries, mainDeckColorCounts) {
  const total = providedResourceEntries.reduce((sum, e) => sum + e.quantity, 0);
  if (total > 0) {
    if (total !== LIMITS.RESOURCE_DECK_SIZE) {
      throw new Error(`Resource deck has ${total} cards, must be exactly ${LIMITS.RESOURCE_DECK_SIZE}.`);
    }
    return providedResourceEntries;
  }
  const colors = Object.keys(mainDeckColorCounts);
  if (colors.length === 0) {
    throw new Error('Cannot build a default resource deck with no known main-deck colors.');
  }
  const mainDeckTotal = colors.reduce((sum, c) => sum + mainDeckColorCounts[c], 0);
  // Largest-remainder method: exact proportional share per color, rounded to sum to exactly 10.
  const shares = colors.map((color) => {
    const exact = (LIMITS.RESOURCE_DECK_SIZE * mainDeckColorCounts[color]) / mainDeckTotal;
    return { color, base: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const deficit = LIMITS.RESOURCE_DECK_SIZE - shares.reduce((sum, s) => sum + s.base, 0);
  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < deficit; i++) shares[i].base += 1;
  return shares.map((s) => ({ quantity: s.base, color: s.color }));
}

module.exports = { validateDeck, resolveResourceDeck };
