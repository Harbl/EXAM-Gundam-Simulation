const { parentPort, workerData } = require('node:worker_threads');
const { parseDecklistText } = require('../../src/deck/parser');
const { validateDeck } = require('../../src/deck/validator');
const { buildGameDeck } = require('../../src/deck/build');
const { lookupCard } = require('../../src/cards/index');
const { runBatch } = require('../../src/sim/batch');
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

function resolveSkill(skillName) {
  const preset = SKILL_PRESETS[skillName] || SKILL_PRESETS.casual;
  return { engine: preset.engine, mctsConfig: preset.mctsConfig };
}

async function main() {
  const { deckAText, deckBText, games, skillA, skillB } = workerData;
  const deckA = loadDeck(deckAText, 'Deck A');
  const deckB = loadDeck(deckBText, 'Deck B');
  const presetA = resolveSkill(skillA);
  const presetB = resolveSkill(skillB);

  const startedAt = Date.now();
  const stats = await runBatch(
    deckA,
    deckB,
    games,
    ({ completed, games: total, live }) => {
      parentPort.postMessage({ type: 'progress', completed, games: total, elapsedMs: Date.now() - startedAt, live });
    },
    { engineA: presetA.engine, engineB: presetB.engine, mctsConfigA: presetA.mctsConfig, mctsConfigB: presetB.mctsConfig }
  );

  // Handed back alongside stats so main.js can cache exactly what produced this batch (deck texts +
  // resolved AI settings) -- the replay viewer needs it to re-run any single game's seed later with
  // the *same* engine/mctsConfig, not just the same decks.
  const context = {
    deckAText,
    deckBText,
    engineA: presetA.engine,
    engineB: presetB.engine,
    mctsConfigA: presetA.mctsConfig,
    mctsConfigB: presetB.mctsConfig
  };
  parentPort.postMessage({ type: 'done', stats, context });
}

main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
