const fs = require('node:fs');
const path = require('node:path');

// One JSON file per saved batch, same shape/convention as src/deck/store.js. Only the compact
// per-game summary (seed/winner/turns, not full event traces) plus the batch's AI/deck context gets
// stored -- a saved batch's replays are regenerated on demand from a game's seed, same as an
// in-session replay already is, so this stays small (well under 1MB even at the app's own 10,000-
// game batch cap) regardless of how many games are in it.
function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'batch';
}

function filePathFor(dir, name) {
  return path.join(dir, `${slugify(name)}.json`);
}

/** Returns [{name, savedAt, stats, context}], newest first. */
function listBatches(dir) {
  if (!fs.existsSync(dir)) return [];
  const batches = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    batches.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
  batches.sort((a, b) => b.savedAt - a.savedAt);
  return batches;
}

/** Saves (or overwrites, by name) a batch's results. Returns the saved record. */
function saveBatch(dir, name, stats, context) {
  fs.mkdirSync(dir, { recursive: true });
  const record = { name, savedAt: Date.now(), stats, context };
  fs.writeFileSync(filePathFor(dir, name), JSON.stringify(record));
  return record;
}

function deleteBatch(dir, name) {
  const filePath = filePathFor(dir, name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { listBatches, saveBatch, deleteBatch, filePathFor };
