const { activePlayer } = require('./state');
const { triggerEvent, applyRepairAtEndOfTurn, clearTurnBuffs, fireCardEffect } = require('./effects');
const { enforceHandLimit } = require('./management');

function runStartPhase(state) {
  const player = activePlayer(state);
  for (const instance of player.battleArea) {
    // Byarlant GD02-004: "It won't be set as active during the start phase of your opponent's next
    // turn" -- a one-shot skip flag rather than an untap-immune duration, so it only blocks the
    // very next start phase this instance's controller would otherwise untap it in.
    // Zaku II FZ (R+) GD03-020's Ad Balloon tokens: "can't be set as active" -- permanently rested.
    if (instance.def.cannotBeSetActive) {
      // stays rested forever
    } else if (instance.skipNextUntap) {
      instance.skipNextUntap = false;
    } else {
      instance.rested = false;
    }
    instance.activationsUsed = {}; // clears "Once per Turn" activated-ability tracking (13-2-13)
  }
  if (player.base) {
    player.base.rested = false;
    player.base.activationsUsed = {};
  }
  for (const resource of player.resourceArea) resource.rested = false;
  player.specialMoveActivatedThisTurn = false; // Master Asia GD05-089's "activated a (Special Move) Command this turn" check
  player.neoZeonSelfDestroyThisTurn = false; // Axis GD05-129's "your Unit destroyed by your (Neo Zeon) card's effect this turn" check
  player.abilityCostsPaidThisTurn = []; // Turn A Gundam GD04-069's "paid (1)+ for one of your other Units' effects this turn" check
  triggerEvent(state, 'startOfTurn', {});
}

/** 7-3-1-1: drawing your last card is itself lethal, not just being unable to draw. Shared by the draw phase and card effects that draw. */
function drawCard(state, player, opts = {}) {
  if (player.deck.length === 0) {
    player.defeated = true;
    return;
  }
  player.hand.push(player.deck.shift());
  if (player.deck.length === 0) {
    player.defeated = true;
  }
  // Lane Aim ST08-011: "When you draw with an effect, if this is a blue Unit, it gains
  // [High Maneuver] during this turn" -- distinguishes an effect draw from the once-per-turn
  // phase draw via this opts flag, so only the single runDrawPhase call site below opts out.
  if (!opts.isPhaseDraw) {
    for (const u of player.battleArea) fireCardEffect(state, player, u, 'drawnByEffect', {});
  }
}

function runDrawPhase(state) {
  drawCard(state, activePlayer(state), { isPhaseDraw: true });
}

function runResourcePhase(state) {
  const player = activePlayer(state);
  if (player.resourceDeck.length !== 0) {
    const resource = player.resourceDeck.shift();
    resource.rested = false;
    player.resourceArea.push(resource);
  }
  // Gundam AGE-1 Titus GD02-031: "While you are Lv.7 or higher, this Unit gets AP+2" -- player Lv
  // (2-9-1) only ever changes here, so this is the exact point to re-evaluate it (unlike the
  // turn-granularity startOfTurn approximation used for board/trash-state grants elsewhere).
  triggerEvent(state, 'resourcePhase', {});
}

function runEndPhase(state, hooks = {}) {
  const player = activePlayer(state);
  if (hooks.actionStep) hooks.actionStep(state, { step: 'end-phase-action' });
  triggerEvent(state, 'endOfTurn', {});
  applyRepairAtEndOfTurn(state, player);
  enforceHandLimit(player, hooks.chooseDiscards);
  clearTurnBuffs(player);
}

function passTurn(state) {
  state.activePlayerIdx = 1 - state.activePlayerIdx;
  state.turnNumber += 1;
}

module.exports = { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn, drawCard };
