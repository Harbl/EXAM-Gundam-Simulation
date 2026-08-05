const fs = require('node:fs');
const path = require('node:path');

// Mirrors src/sim/resultsStore.js's shape/convention exactly (one JSON file per saved record) but
// for a tournament -- {name, savedAt, result, context}. `result` is the {rounds, champion} bracket
// (small: id/name + per-game seed/winner/turns, no deck data); `context` is what's needed to replay
// any individual game later (each entrant's decklist text + the resolved engine/mctsConfig), same
// "context rides along with the record" idea resultsStore already uses for batch replays.
function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tournament';
}

function filePathFor(dir, name) {
  return path.join(dir, `${slugify(name)}.json`);
}

/** Returns [{name, savedAt, result, context}], newest first. */
function listTournaments(dir) {
  if (!fs.existsSync(dir)) return [];
  const tournaments = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    tournaments.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
  tournaments.sort((a, b) => b.savedAt - a.savedAt);
  return tournaments;
}

/** Saves (or overwrites, by name) a tournament's bracket result. Returns the saved record. */
function saveTournament(dir, name, result, context) {
  fs.mkdirSync(dir, { recursive: true });
  const record = { name, savedAt: Date.now(), result, context };
  fs.writeFileSync(filePathFor(dir, name), JSON.stringify(record));
  return record;
}

function deleteTournament(dir, name) {
  const filePath = filePathFor(dir, name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { listTournaments, saveTournament, deleteTournament };
