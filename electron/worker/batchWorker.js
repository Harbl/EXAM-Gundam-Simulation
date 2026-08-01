const { parentPort, workerData } = require('node:worker_threads');
const { parseDecklistText } = require('../../src/deck/parser');
const { validateDeck, resolveResourceDeck } = require('../../src/deck/validator');
const { buildGameDeck } = require('../../src/deck/build');
const { lookupCard } = require('../../src/cards/index');
const { runBatch } = require('../../src/sim/batch');
const banlist = require('../../data/banlist.json');

function loadDeck(text, label) {
  const parsed = parseDecklistText(text);
  const validation = validateDeck(parsed, lookupCard, banlist);
  if (!validation.valid) {
    throw new Error(`${label} is not a legal deck:\n${validation.errors.join('\n')}`);
  }
  const resourceEntries = resolveResourceDeck(parsed.resource, validation.colorCounts);
  return buildGameDeck({ main: parsed.main, resource: resourceEntries }, lookupCard);
}

async function main() {
  const { deckAText, deckBText, games } = workerData;
  const deckA = loadDeck(deckAText, 'Deck A');
  const deckB = loadDeck(deckBText, 'Deck B');

  const startedAt = Date.now();
  const stats = await runBatch(deckA, deckB, games, ({ completed, games: total }) => {
    parentPort.postMessage({ type: 'progress', completed, games: total, elapsedMs: Date.now() - startedAt });
  });

  parentPort.postMessage({ type: 'done', stats });
}

main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
