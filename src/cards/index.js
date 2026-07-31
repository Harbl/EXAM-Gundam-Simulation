const fs = require('node:fs');
const path = require('node:path');

const CARDS_DIR = __dirname;

function loadAllCards() {
  const map = new Map();
  for (const file of fs.readdirSync(CARDS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const entries = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, file), 'utf8'));
    for (const def of entries) map.set(def.number, def);
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

module.exports = { lookupCard, reloadCards };
