// Throwaway tool: plays one full game with the real AI (opponent-modeling lookahead included, since
// it's the default now, no toggle needed) and prints every deploy/pair/command/attack decision as it
// happens, so we can read exactly what the bot did turn by turn. Patches actions.js/combat.js exports
// BEFORE heuristic.js is required anywhere, since require() caches the module object and heuristic.js
// destructures these functions at its own top-level the first time it's loaded.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const banlist = require('../data/banlist.json');

const actions = require('../src/rules/actions');
const combat = require('../src/rules/combat');

const name = (instance) => (instance ? `${instance.def.name} (${instance.def.number})` : '???');

// The lookahead AI calls these exact same functions on cloneState() clones dozens of times per
// decision to score candidate trials -- only the winning trial gets replayed on the real state
// object. realState is set once the real game state exists (below); every patch skips logging
// (but still calls through) unless the `state` it was invoked with is that same real object by
// reference, so only the choices that actually happened get printed, not the search's scratch work.
let realState = null;

const origDeployUnit = actions.deployUnit;
actions.deployUnit = function (state, player, def, chooseToTrash, context) {
  if (state === realState) {
    const p = state.players.indexOf(player);
    console.log(`  [Deploy] P${p} deploys ${def.name} (${def.number})`);
  }
  return origDeployUnit.call(this, state, player, def, chooseToTrash, context);
};

const origDeployBase = actions.deployBase;
actions.deployBase = function (state, player, def) {
  if (state === realState) {
    const p = state.players.indexOf(player);
    console.log(`  [Deploy Base] P${p} deploys ${def.name} (${def.number})`);
  }
  return origDeployBase.call(this, state, player, def);
};

const origPlayCommand = actions.playCommand;
actions.playCommand = function (state, player, def, opts) {
  if (state === realState) {
    const p = state.players.indexOf(player);
    console.log(`  [Command] P${p} plays ${def.name} (${def.number})`);
  }
  return origPlayCommand.call(this, state, player, def, opts);
};

const origPairPilot = actions.pairPilot;
actions.pairPilot = function (state, player, unit, pilotInstance) {
  if (state === realState) {
    const p = state.players.indexOf(player);
    console.log(`  [Pair] P${p} pairs ${name(pilotInstance)} onto ${name(unit)}`);
  }
  return origPairPilot.call(this, state, player, unit, pilotInstance);
};

const origResolveAttack = combat.resolveAttack;
combat.resolveAttack = function (state, attackerPlayerIdx, attacker, declaredTarget, hooks) {
  const isReal = state === realState;
  if (isReal) {
    const targetDesc =
      declaredTarget.type === 'player' ? `P${1 - attackerPlayerIdx} (face)` : `${name(declaredTarget.instance)}`;
    console.log(`  [Attack] P${attackerPlayerIdx}'s ${name(attacker)} attacks ${targetDesc}`);
  }
  const before = isReal && { shieldsA: state.players[0].shields.length, shieldsB: state.players[1].shields.length };
  const result = origResolveAttack.call(this, state, attackerPlayerIdx, attacker, declaredTarget, hooks);
  if (isReal) {
    const after = { shieldsA: state.players[0].shields.length, shieldsB: state.players[1].shields.length };
    if (before.shieldsA !== after.shieldsA) console.log(`    -> P0 shield destroyed (${before.shieldsA}->${after.shieldsA})`);
    if (before.shieldsB !== after.shieldsB) console.log(`    -> P1 shield destroyed (${before.shieldsB}->${after.shieldsB})`);
  }
  return result;
};

// require AFTER patching, so heuristic.js/singleGame.js pick up the wrapped functions.
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, lookaheadHooks } = require('../src/ai/heuristic');
const { runMainPhaseMCTS } = require('../src/ai/mcts');

function loadDeck(fileName) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', fileName), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${fileName}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const [deckAName, deckBName] = process.argv.slice(2);
if (!deckAName || !deckBName) {
  console.error('Usage: node scratchpad/trace_game.js deckA.txt deckB.txt');
  process.exit(1);
}

const deckA = loadDeck(deckAName);
const deckB = loadDeck(deckBName);

const MAX_TURNS = 60;
const state = initializeGame(deckA, deckB, { decideMulligan });
realState = state;
console.log(`Player 0 = ${deckAName}, Player 1 = ${deckBName}`);
console.log(`First player: P${state.activePlayerIdx}\n`);

const hooks = lookaheadHooks(state);
while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
  console.log(`=== Turn ${state.turnNumber} (P${state.activePlayerIdx}) ===`);
  runStartPhase(state);
  runDrawPhase(state);
  checkDefeat(state);
  if (state.winner !== null || state.draw) break;

  runResourcePhase(state);
  runMainPhaseMCTS(state, state.activePlayerIdx, hooks);
  if (state.winner !== null || state.draw) break;

  runEndPhase(state);
  passTurn(state);
}

console.log('\n=== GAME OVER ===');
if (state.draw) console.log('Result: DRAW');
else if (state.winner !== null) console.log(`Result: P${state.winner} wins`);
else console.log('Result: TIMED OUT');
console.log(`Turns: ${state.turnNumber}`);
console.log(`P0 shields left: ${state.players[0].shields.length}, P1 shields left: ${state.players[1].shields.length}`);
