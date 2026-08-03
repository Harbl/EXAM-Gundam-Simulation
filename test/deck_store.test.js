const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listDecks, saveDeck, loadDeck, deleteDeck } = require('../src/deck/store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gundam-deck-store-'));
}

test('saveDeck writes a deck and loadDeck reads it back', () => {
  const dir = tempDir();
  saveDeck(dir, 'My Blue/Green Deck', '4 Zaku II ST03-008');
  const loaded = loadDeck(dir, 'My Blue/Green Deck');
  assert.equal(loaded.name, 'My Blue/Green Deck');
  assert.equal(loaded.decklistText, '4 Zaku II ST03-008');
  assert.equal(typeof loaded.savedAt, 'number');
});

test('loadDeck returns null for a deck that was never saved', () => {
  const dir = tempDir();
  assert.equal(loadDeck(dir, 'nope'), null);
});

test('saving a deck under the same name overwrites the previous save', () => {
  const dir = tempDir();
  saveDeck(dir, 'Deck A', 'old list');
  saveDeck(dir, 'Deck A', 'new list');
  assert.equal(loadDeck(dir, 'Deck A').decklistText, 'new list');
});

test('listDecks returns every saved deck, newest first', async () => {
  const dir = tempDir();
  saveDeck(dir, 'First', 'a');
  await new Promise((r) => setTimeout(r, 5));
  saveDeck(dir, 'Second', 'b');
  const decks = listDecks(dir);
  assert.equal(decks.length, 2);
  assert.equal(decks[0].name, 'Second');
  assert.equal(decks[1].name, 'First');
});

test('listDecks on a directory that does not exist yet returns an empty list, not an error', () => {
  const dir = path.join(tempDir(), 'does-not-exist-yet');
  assert.deepEqual(listDecks(dir), []);
});

test('deleteDeck removes a saved deck', () => {
  const dir = tempDir();
  saveDeck(dir, 'Deck A', 'list');
  deleteDeck(dir, 'Deck A');
  assert.equal(loadDeck(dir, 'Deck A'), null);
});

test('two names that slugify the same way are treated as the same saved deck slot', () => {
  const dir = tempDir();
  saveDeck(dir, 'My Deck!', 'v1');
  saveDeck(dir, 'my deck', 'v2');
  assert.equal(listDecks(dir).length, 1);
});
