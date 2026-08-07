const { parentPort, workerData } = require('node:worker_threads');

// traceGame MUST be required before anything that touches src/rules/actions.js or src/rules/
// combat.js (directly, or transitively via src/effects/registry.js) -- see the big comment at the
// top of src/sim/traceGame.js. A worker_thread gets its own fresh module registry each time it's
// spawned (electron/main.js spins up a brand new one per replay request, never reused), so as long
// as this is the first require in this file, the patch reaches every call site correctly.
const { traceGame } = require('../../src/sim/traceGame');

const { parseDecklistText } = require('../../src/deck/parser');
const { validateDeck } = require('../../src/deck/validator');
const { buildGameDeck } = require('../../src/deck/build');
const { lookupCard } = require('../../src/cards/index');
const banlist = require('../../data/banlist.json');

function loadDeck(text, label) {
  const parsed = parseDecklistText(text);
  const validation = validateDeck(parsed, lookupCard, banlist);
  if (!validation.valid) {
    throw new Error(`${label} is not a legal deck:\n${validation.errors.join('\n')}`);
  }
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

try {
  const { deckAText, deckBText, seed, engineA, engineB, mctsConfigA, mctsConfigB, valueModelA, valueModelB } = workerData;
  const deckA = loadDeck(deckAText, 'Deck A');
  const deckB = loadDeck(deckBText, 'Deck B');
  const events = traceGame(deckA, deckB, seed, { engineA, engineB, mctsConfigA, mctsConfigB, valueModelA, valueModelB });
  parentPort.postMessage({ type: 'done', events });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err.message });
}
