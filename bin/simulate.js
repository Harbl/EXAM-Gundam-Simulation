#!/usr/bin/env node
// Thin CLI for exercising src/sim directly, without the Electron UI.
// Usage: node bin/simulate.js <deckA.txt> [deckB.txt] [games]
//   If deckB is omitted, deckA is mirrored against itself (a quick self-consistency sanity check).

const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck, resolveResourceDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const banlist = require('../data/banlist.json');

function loadDeck(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = parseDecklistText(text);
  const validation = validateDeck(parsed, lookupCard, banlist);
  if (!validation.valid) {
    throw new Error(`${filePath} is not a legal deck:\n${validation.errors.join('\n')}`);
  }
  const resourceEntries = resolveResourceDeck(parsed.resource, validation.colorCounts);
  return buildGameDeck({ main: parsed.main, resource: resourceEntries }, lookupCard);
}

function main() {
  const [deckAPath, arg2, arg3] = process.argv.slice(2);
  if (!deckAPath) {
    console.error('Usage: node bin/simulate.js <deckA.txt> [deckB.txt] [games]');
    process.exit(1);
  }
  const deckBPath = arg2 && Number.isNaN(Number(arg2)) ? arg2 : deckAPath;
  const games = Number(arg3 || (Number.isNaN(Number(arg2)) ? undefined : arg2)) || 100;

  const deckA = loadDeck(path.resolve(deckAPath));
  const deckB = loadDeck(path.resolve(deckBPath));

  let winsA = 0;
  let winsB = 0;
  let timeouts = 0;
  let turnsTotal = 0;

  for (let i = 0; i < games; i++) {
    const result = playGame(deckA, deckB);
    if (result.timedOut) timeouts++;
    else if (result.winner === 0) winsA++;
    else winsB++;
    turnsTotal += result.turns;
  }

  console.log(`Games: ${games}`);
  console.log(`Deck A (${deckAPath}) wins: ${winsA} (${((winsA / games) * 100).toFixed(1)}%)`);
  console.log(`Deck B (${deckBPath}) wins: ${winsB} (${((winsB / games) * 100).toFixed(1)}%)`);
  console.log(`Timeouts: ${timeouts}`);
  console.log(`Average game length: ${(turnsTotal / games).toFixed(1)} turns`);
}

main();
