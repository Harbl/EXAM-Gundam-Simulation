const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listBatches, saveBatch, deleteBatch } = require('../src/sim/resultsStore');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gundam-results-store-'));
}

const STATS = { games: 5, deckA: { winRate: 0.6 }, deckB: { winRate: 0.4 }, perGame: [{ seed: 1, winner: 0, turns: 10 }] };
const CONTEXT = { deckAText: '4 ST01-005', deckBText: '4 ST03-008', engineA: 'mcts', engineB: 'mcts' };

test('saveBatch writes a batch and listBatches reads it back with stats/context intact', () => {
  const dir = tempDir();
  saveBatch(dir, 'Barbatos vs Nu Gundam', STATS, CONTEXT);
  const batches = listBatches(dir);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].name, 'Barbatos vs Nu Gundam');
  assert.equal(typeof batches[0].savedAt, 'number');
  assert.deepEqual(batches[0].stats, STATS);
  assert.deepEqual(batches[0].context, CONTEXT);
});

test('saving a batch under the same name overwrites the previous save', () => {
  const dir = tempDir();
  saveBatch(dir, 'Batch A', { ...STATS, games: 1 }, CONTEXT);
  saveBatch(dir, 'Batch A', { ...STATS, games: 2 }, CONTEXT);
  const batches = listBatches(dir);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].stats.games, 2);
});

test('listBatches returns every saved batch, newest first', async () => {
  const dir = tempDir();
  saveBatch(dir, 'First', STATS, CONTEXT);
  await new Promise((r) => setTimeout(r, 5));
  saveBatch(dir, 'Second', STATS, CONTEXT);
  const batches = listBatches(dir);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].name, 'Second');
  assert.equal(batches[1].name, 'First');
});

test('listBatches on a directory that does not exist yet returns an empty list, not an error', () => {
  const dir = path.join(tempDir(), 'does-not-exist-yet');
  assert.deepEqual(listBatches(dir), []);
});

test('deleteBatch removes a saved batch', () => {
  const dir = tempDir();
  saveBatch(dir, 'Batch A', STATS, CONTEXT);
  deleteBatch(dir, 'Batch A');
  assert.deepEqual(listBatches(dir), []);
});

test('two names that slugify the same way are treated as the same saved batch slot', () => {
  const dir = tempDir();
  saveBatch(dir, 'My Batch!', STATS, CONTEXT);
  saveBatch(dir, 'my batch', STATS, CONTEXT);
  assert.equal(listBatches(dir).length, 1);
});
