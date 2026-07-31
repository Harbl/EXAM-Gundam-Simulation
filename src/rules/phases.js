const { activePlayer } = require('./state');
const { triggerEvent, applyRepairAtEndOfTurn, clearTurnBuffs } = require('./effects');
const { enforceHandLimit } = require('./management');

function runStartPhase(state) {
  const player = activePlayer(state);
  for (const instance of player.battleArea) {
    instance.rested = false;
    instance.activationsUsed = {}; // clears "Once per Turn" activated-ability tracking (13-2-13)
  }
  if (player.base) {
    player.base.rested = false;
    player.base.activationsUsed = {};
  }
  for (const resource of player.resourceArea) resource.rested = false;
  player.specialMoveActivatedThisTurn = false; // Master Asia GD05-089's "activated a (Special Move) Command this turn" check
  triggerEvent(state, 'startOfTurn', {});
}

/** 7-3-1-1: drawing your last card is itself lethal, not just being unable to draw. Shared by the draw phase and card effects that draw. */
function drawCard(state, player) {
  if (player.deck.length === 0) {
    player.defeated = true;
    return;
  }
  player.hand.push(player.deck.shift());
  if (player.deck.length === 0) {
    player.defeated = true;
  }
}

function runDrawPhase(state) {
  drawCard(state, activePlayer(state));
}

function runResourcePhase(state) {
  const player = activePlayer(state);
  if (player.resourceDeck.length === 0) return;
  const resource = player.resourceDeck.shift();
  resource.rested = false;
  player.resourceArea.push(resource);
}

function runEndPhase(state, hooks = {}) {
  const player = activePlayer(state);
  if (hooks.actionStep) hooks.actionStep(state, { step: 'end-phase-action' });
  triggerEvent(state, 'endOfTurn', {});
  applyRepairAtEndOfTurn(player);
  enforceHandLimit(player, hooks.chooseDiscards);
  clearTurnBuffs(player);
}

function passTurn(state) {
  state.activePlayerIdx = 1 - state.activePlayerIdx;
  state.turnNumber += 1;
}

module.exports = { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn, drawCard };
