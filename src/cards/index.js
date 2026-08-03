const fs = require('node:fs');
const path = require('node:path');
const registry = require('../effects/registry');

const CARDS_DIR = __dirname;

/** Resolves a card's `effectRefs` (names into src/effects/registry.js) into real functions on `effects`. */
function resolveEffects(def) {
  if (!def.effectRefs) return def;
  const effects = {};
  for (const [eventName, fnName] of Object.entries(def.effectRefs)) {
    const fn = registry[fnName];
    if (!fn) throw new Error(`Card ${def.number} references unknown effect "${fnName}"`);
    effects[eventName] = fn;
  }
  return Object.assign({}, def, { effects });
}

function loadAllCards() {
  const map = new Map();
  for (const file of fs.readdirSync(CARDS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const entries = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, file), 'utf8'));
    for (const rawDef of entries) map.set(rawDef.number, resolveEffects(rawDef));
  }
  return map;
}

let cache = null;

function lookupCard(number) {
  if (!cache) cache = loadAllCards();
  return cache.get(number);
}

/** Clears the in-memory cache; call after adding new card JSON files at runtime. */
function reloadCards() {
  cache = null;
}

/** Every researched card def, for the deck builder's browse/search screen. */
function listAllCards() {
  if (!cache) cache = loadAllCards();
  return Array.from(cache.values());
}

module.exports = { lookupCard, reloadCards, listAllCards };
