// Follow-up to barbatos_ai_asymmetry_test.js: scoreState has zero term for trash-pile contents, so
// Barbatos Lupus's 3-in-trash Activate-Main gate and Saviour Gundam's 5-in-trash whenLinked board
// wipe get no credit from the search until (Lupus) or even at (Saviour, not an activateMain at all)
// the moment they'd fire. Measures how often these two payoffs actually trigger in real games to
// confirm this is a real, not just theoretical, gap.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, lookaheadHooks } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const registry = require('../src/effects/registry');

let saviourLinkedFired = 0;
let saviourLinkedTriggeredWipe = 0;
const origSaviour = registry.saviourGundamWhenLinked;
registry.saviourGundamWhenLinked = function (state, player) {
  saviourLinkedFired++;
  const purpleInTrash = player.trash.filter((c) => c.def.color === 'purple').length;
  if (purpleInTrash >= 5) saviourLinkedTriggeredWipe++;
  return origSaviour.call(this, state, player);
};

let lupusOffered = 0;
const origLupus = registry.gundamBarbatosLupusActivateMain;
registry.gundamBarbatosLupusActivateMain = function (state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Tekkadan') || (c.def.traits || []).includes('Teiwaz'))
  );
  if (candidates.length >= 3) lupusOffered++;
  return origLupus.call(this, state, player, instance, context);
};

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

const N = Number(process.argv[2] || 40);
let lupusDeployedGames = 0;
let saviourDeployedGames = 0;
let saviourLinkedGames = 0;

for (let i = 0; i < N; i++) {
  const barbatosIsA = i % 2 === 0;
  const state = barbatosIsA
    ? initializeGame(barbatos, nuGundam, { decideMulligan })
    : initializeGame(nuGundam, barbatos, { decideMulligan });
  const barbatosIdx = barbatosIsA ? 0 : 1;
  const hooks = lookaheadHooks(state);
  let lupusOut = false, saviourOut = false, saviourLinked = false;

  while (state.winner === null && !state.draw && state.turnNumber <= 60) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);
    runMainPhaseMCTS(state, state.activePlayerIdx, hooks, DEFAULT_MCTS_CONFIG);

    const bp = state.players[barbatosIdx];
    if (bp.battleArea.some((u) => u.def.number === 'GD03-050')) lupusOut = true;
    if (bp.battleArea.some((u) => u.def.number === 'ST09-003')) {
      saviourOut = true;
      const linked = bp.battleArea.find((u) => u.def.number === 'ST09-003' && u.isLinkUnit);
      if (linked) saviourLinked = true;
    }

    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
  if (lupusOut) lupusDeployedGames++;
  if (saviourOut) saviourDeployedGames++;
  if (saviourLinked) saviourLinkedGames++;
}

console.log(`${N} games, Barbatos Rush vs Nu Gundam, MCTS both sides\n`);
console.log(`Gundam Barbatos Lupus deployed: ${lupusDeployedGames}/${N} games; its Activate-Main was legal (3+ trash) ${lupusOffered} times total`);
console.log(`Saviour Gundam deployed: ${saviourDeployedGames}/${N} games (Linked at some point: ${saviourLinkedGames})`);
console.log(`Saviour's whenLinked fired ${saviourLinkedFired} times total, of which ${saviourLinkedTriggeredWipe} had 5+ purple in trash (actually wiped board)`);
