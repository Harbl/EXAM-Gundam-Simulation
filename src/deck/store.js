const fs = require('node:fs');
const path = require('node:path');

// One JSON file per saved deck, in a directory the caller supplies (Electron's main.js resolves
// this to app.getPath('userData') + '/decks' -- kept as a plain param here so this stays testable/
// reusable without an Electron runtime, same "no Electron dependency in the engine layer" split as
// src/sim already follows).
function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
}

function filePathFor(dir, name) {
  return path.join(dir, `${slugify(name)}.json`);
}

/** Returns [{name, decklistText, savedAt}], newest first. */
function listDecks(dir) {
  if (!fs.existsSync(dir)) return [];
  const decks = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    decks.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
  decks.sort((a, b) => b.savedAt - a.savedAt);
  return decks;
}

/** Saves (or overwrites, by name) a deck. Returns the saved record. */
function saveDeck(dir, name, decklistText) {
  fs.mkdirSync(dir, { recursive: true });
  const record = { name, decklistText, savedAt: Date.now() };
  fs.writeFileSync(filePathFor(dir, name), JSON.stringify(record, null, 2));
  return record;
}

function loadDeck(dir, name) {
  const filePath = filePathFor(dir, name);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deleteDeck(dir, name) {
  const filePath = filePathFor(dir, name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { listDecks, saveDeck, loadDeck, deleteDeck, filePathFor };
