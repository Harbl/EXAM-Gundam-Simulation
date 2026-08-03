#!/usr/bin/env node
// Thin CLI for exercising src/sim directly, without the Electron UI.
// Usage: node bin/simulate.js <deckA.txt> [deckB.txt] [games] [--mcts=fast|balanced|strong]
//   If deckB is omitted, deckA is mirrored against itself (a quick self-consistency sanity check).
//   --mcts picks the MCTS_PRESETS tier for BOTH sides (default: fast, same as DEFAULT_MCTS_CONFIG) --
//   lets a single/small-batch run opt into a deliberately stronger game from the terminal today,
//   without waiting on the Phase 3 settings-window UI (see src/ai/mcts.js's MCTS_PRESETS).

const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { MCTS_PRESETS } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

function loadDeck(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = parseDecklistText(text);
  const validation = validateDeck(parsed, lookupCard, banlist);
  if (!validation.valid) {
    throw new Error(`${filePath} is not a legal deck:\n${validation.errors.join('\n')}`);
  }
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

function main() {
  const rawArgs = process.argv.slice(2);
  const mctsFlag = rawArgs.find((a) => a.startsWith('--mcts='));
  const positional = rawArgs.filter((a) => !a.startsWith('--mcts='));
  const [deckAPath, arg2, arg3] = positional;
  if (!deckAPath) {
    console.error('Usage: node bin/simulate.js <deckA.txt> [deckB.txt] [games] [--mcts=fast|balanced|strong]');
    process.exit(1);
  }
  const presetName = mctsFlag ? mctsFlag.slice('--mcts='.length) : 'fast';
  const mctsConfig = MCTS_PRESETS[presetName];
  if (!mctsConfig) {
    console.error(`Unknown --mcts preset "${presetName}" -- choices: ${Object.keys(MCTS_PRESETS).join(', ')}`);
    process.exit(1);
  }
  const deckBPath = arg2 && Number.isNaN(Number(arg2)) ? arg2 : deckAPath;
  const games = Number(arg3 || (Number.isNaN(Number(arg2)) ? undefined : arg2)) || 100;

  const deckA = loadDeck(path.resolve(deckAPath));
  const deckB = loadDeck(path.resolve(deckBPath));

  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let timeouts = 0;
  let turnsTotal = 0;

  for (let i = 0; i < games; i++) {
    const result = playGame(deckA, deckB, { mctsConfigA: mctsConfig, mctsConfigB: mctsConfig });
    if (result.draw) draws++;
    else if (result.timedOut) timeouts++;
    else if (result.winner === 0) winsA++;
    else winsB++;
    // state.turnNumber increments once per individual player's turn, not once per round -- convert to
    // a "full turn" count (both players' turn 1 = 1 full turn) before averaging.
    turnsTotal += Math.ceil(result.turns / 2);
  }

  console.log(`Games: ${games} (--mcts=${presetName}: ${JSON.stringify(mctsConfig)})`);
  console.log(`Deck A (${deckAPath}) wins: ${winsA} (${((winsA / games) * 100).toFixed(1)}%)`);
  console.log(`Deck B (${deckBPath}) wins: ${winsB} (${((winsB / games) * 100).toFixed(1)}%)`);
  console.log(`Draws: ${draws}`);
  console.log(`Timeouts: ${timeouts}`);
  console.log(`Average game length: ${(turnsTotal / games).toFixed(1)} turns`);
}

main();
