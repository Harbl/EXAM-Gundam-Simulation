const { parentPort, workerData } = require('node:worker_threads');
const { parseDecklistText } = require('../../src/deck/parser');
const { validateDeck } = require('../../src/deck/validator');
const { buildGameDeck } = require('../../src/deck/build');
const { lookupCard } = require('../../src/cards/index');
const { runBatch } = require('../../src/sim/batch');
const { SKILL_PRESETS } = require('../../src/ai/skillPresets');
const { applyArchetypeHandicap } = require('../../src/ai/archetypeHandicaps');
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
  return { engine: preset.engine, mctsConfig: preset.mctsConfig, valueModel: preset.valueModel };
}

async function main() {
  const { deckAText, deckBText, games, skillA, skillB, bypassHandicaps } = workerData;
  const deckA = loadDeck(deckAText, 'Deck A');
  const deckB = loadDeck(deckBText, 'Deck B');
  // "Newtype Awakening" opt-out (electron/renderer's Simulate screen): an explicit user choice to see
  // full-strength AI even for a known-lopsided archetype, so skip the handicap check entirely.
  const presetA = bypassHandicaps ? resolveSkill(skillA) : applyArchetypeHandicap(deckA, resolveSkill(skillA));
  const presetB = bypassHandicaps ? resolveSkill(skillB) : applyArchetypeHandicap(deckB, resolveSkill(skillB));

  const startedAt = Date.now();
  const stats = await runBatch(
    deckA,
    deckB,
    games,
    ({ completed, games: total, live }) => {
      parentPort.postMessage({ type: 'progress', completed, games: total, elapsedMs: Date.now() - startedAt, live });
    },
    {
      engineA: presetA.engine,
      engineB: presetB.engine,
      mctsConfigA: presetA.mctsConfig,
      mctsConfigB: presetB.mctsConfig,
      valueModelA: presetA.valueModel,
      valueModelB: presetB.valueModel
    }
  );

  // Handed back alongside stats so main.js can cache exactly what produced this batch (deck texts +
  // resolved AI settings) -- the replay viewer needs it to re-run any single game's seed later with
  // the *same* engine/mctsConfig/valueModel, not just the same decks.
  const context = {
    deckAText,
    deckBText,
    engineA: presetA.engine,
    engineB: presetB.engine,
    mctsConfigA: presetA.mctsConfig,
    mctsConfigB: presetB.mctsConfig,
    valueModelA: presetA.valueModel,
    valueModelB: presetB.valueModel,
    // Set only when applyArchetypeHandicap actually downgraded that side -- lets the renderer disclose
    // "Deck A's engine was reduced because it's a known AI-advantaged archetype" instead of silently
    // showing a skill tier that isn't what was actually played.
    handicappedA: presetA.handicapped || null,
    handicappedB: presetB.handicapped || null,
    bypassHandicaps: !!bypassHandicaps
  };
  parentPort.postMessage({ type: 'done', stats, context });
}

main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
