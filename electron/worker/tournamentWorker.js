const { parentPort, workerData } = require('node:worker_threads');
const { parseDecklistText } = require('../../src/deck/parser');
const { validateDeck } = require('../../src/deck/validator');
const { buildGameDeck } = require('../../src/deck/build');
const { lookupCard } = require('../../src/cards/index');
const { runTournament } = require('../../src/sim/tournament');
const { SKILL_PRESETS } = require('../../src/ai/skillPresets');
const banlist = require('../../data/banlist.json');

function loadDeck(text, label) {
  const parsed = parseDecklistText(text);
  const validation = validateDeck(parsed, lookupCard, banlist);
  if (!validation.valid) {
    throw new Error(`${label} is not a legal deck:\n${validation.errors.join('\n')}`);
  }
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

async function main() {
  const { entrants, bestOf, skill } = workerData;
  const preset = SKILL_PRESETS[skill] || SKILL_PRESETS.casual;
  const built = entrants.map((e) => ({ id: e.id, name: e.name, deck: loadDeck(e.deckText, e.name) }));

  const result = runTournament(
    built,
    bestOf,
    (progress) => parentPort.postMessage({ type: 'progress', ...progress }),
    { engineA: preset.engine, engineB: preset.engine, mctsConfigA: preset.mctsConfig, mctsConfigB: preset.mctsConfig }
  );

  // Handed back alongside result so main.js can cache exactly what produced this bracket (each
  // entrant's decklist text + the resolved engine/mctsConfig) -- the renderer needs it both to offer
  // "Save Tournament" and to replay any individual game from any match's seed later, same reasoning
  // as batchWorker.js's own `context` field.
  const context = {
    entrants: entrants.map((e) => ({ id: e.id, name: e.name, deckText: e.deckText })),
    bestOf,
    engine: preset.engine,
    mctsConfig: preset.mctsConfig
  };
  parentPort.postMessage({ type: 'done', result, context });
}

main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
