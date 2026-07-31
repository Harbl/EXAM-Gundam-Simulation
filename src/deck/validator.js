const { LIMITS } = require('../rules/constants');

/**
 * Validates a parsed main deck against card data and the banlist.
 * `lookupCard(number)` should return a card def or undefined if unresearched.
 */
function validateDeck(parsed, lookupCard, banlist) {
  const errors = [];
  const missingCards = [];
  const quantities = new Map();
  const colors = new Set();

  let total = 0;
  for (const entry of parsed.main) {
    total += entry.quantity;
    quantities.set(entry.number, (quantities.get(entry.number) || 0) + entry.quantity);
    const def = lookupCard(entry.number);
    if (!def) {
      missingCards.push(entry.number);
      continue;
    }
    if (def.color) colors.add(def.color);
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

  if (colors.size > 2) {
    errors.push(`Deck uses ${colors.size} colors (${[...colors].join(', ')}); a deck may use at most 2.`);
  }

  return { valid: errors.length === 0, errors, missingCards, colors: [...colors] };
}

/**
 * Resource decks aren't derivable from card text (7-6-1: it's a deckbuilding choice), so if none
 * was pasted alongside the main deck, default to a proportional split across the main deck's colors.
 */
function resolveResourceDeck(providedResourceEntries, mainDeckColors) {
  const total = providedResourceEntries.reduce((sum, e) => sum + e.quantity, 0);
  if (total > 0) {
    if (total !== LIMITS.RESOURCE_DECK_SIZE) {
      throw new Error(`Resource deck has ${total} cards, must be exactly ${LIMITS.RESOURCE_DECK_SIZE}.`);
    }
    return providedResourceEntries;
  }
  if (mainDeckColors.length === 0) {
    throw new Error('Cannot build a default resource deck with no known main-deck colors.');
  }
  const base = Math.floor(LIMITS.RESOURCE_DECK_SIZE / mainDeckColors.length);
  const remainder = LIMITS.RESOURCE_DECK_SIZE - base * mainDeckColors.length;
  return mainDeckColors.map((color, i) => ({ quantity: base + (i < remainder ? 1 : 0), color }));
}

module.exports = { validateDeck, resolveResourceDeck };
