const { parentPort, workerData } = require('node:worker_threads');
const { parseDecklistText } = require('../../src/deck/parser');
const { validateDeck } = require('../../src/deck/validator');
const { buildGameDeck } = require('../../src/deck/build');
const { lookupCard } = require('../../src/cards/index');
const { runTournament, runDoubleElimTournament } = require('../../src/sim/tournament');
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
  const { entrants, bestOf, skill, format, bypassHandicaps } = workerData;
  const preset = SKILL_PRESETS[skill] || SKILL_PRESETS.casual;
  const built = entrants.map((e) => ({ id: e.id, name: e.name, deck: loadDeck(e.deckText, e.name) }));
  const run = format === 'double' ? runDoubleElimTournament : runTournament;

  const result = run(
    built,
    bestOf,
    (progress) => parentPort.postMessage({ type: 'progress', ...progress }),
    {
      engineA: preset.engine,
      engineB: preset.engine,
      mctsConfigA: preset.mctsConfig,
      mctsConfigB: preset.mctsConfig,
      valueModelA: preset.valueModel,
      valueModelB: preset.valueModel,
      // "Newtype Awakening" opt-out (electron/renderer's Tournament screen) -- consumed per-match by
      // tournament.js's withArchetypeHandicaps, which otherwise resolves each entrant's own handicap
      // fresh every match (a tournament's `skill` is one shared choice, but the handicap is per-deck).
      bypassHandicaps: !!bypassHandicaps
    }
  );

  // Handed back alongside result so main.js can cache exactly what produced this bracket (each
  // entrant's decklist text + the resolved engine/mctsConfig/valueModel) -- the renderer needs it both
  // to offer "Save Tournament" and to replay any individual game from any match's seed later, same
  // reasoning as batchWorker.js's own `context` field.
  const context = {
    entrants: entrants.map((e) => ({ id: e.id, name: e.name, deckText: e.deckText })),
    bestOf,
    engine: preset.engine,
    mctsConfig: preset.mctsConfig,
    valueModel: preset.valueModel,
    // This top-level engine/mctsConfig/valueModel is only the tournament-wide NOMINAL preset -- a
    // per-match archetype handicap (unless bypassed) can still downgrade one side for a specific match.
    // FIXED (2026-08-07): each match's own `result` now separately carries its actually-resolved
    // per-side engineA/engineB/mctsConfigA/mctsConfigB/valueModelA/valueModelB (src/sim/tournament.js's
    // `playMatch`), so replaying an individual game prefers that over this shared context -- see
    // electron/renderer/index.html's buildMatchGameRows. This top-level context field stays as the
    // fallback for tournaments saved before this fix.
    bypassHandicaps: !!bypassHandicaps
  };
  parentPort.postMessage({ type: 'done', result, context });
}

main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
