const { recoverHP } = require('./management');

/**
 * Dispatches a triggered-effect event (Deploy/Attack/Destroyed/When Paired/etc.) to every
 * card on the field with a matching handler in its card definition (def.effects[eventName]).
 * Resolution order per 10-1-6-6: the active player's triggers resolve first, then the
 * standby player's.
 */
function triggerEvent(state, eventName, context) {
  const order = [state.players[state.activePlayerIdx], state.players[1 - state.activePlayerIdx]];
  for (const player of order) {
    const cardsOnField = [...player.battleArea, player.base].filter(Boolean);
    for (const instance of cardsOnField) {
      const handler = instance.def.effects && instance.def.effects[eventName];
      if (handler) handler(state, instance, context);
    }
  }
}

/**
 * Fires a card's own printed ability for a self-scoped trigger (Deploy/Attack/Destroyed/When
 * Paired/When Linked -- 13-2-6..13-2-12): these activate on the specific card itself, not as a
 * broadcast to everything on the field the way "at the start/end of turn" effects do.
 */
function fireCardEffect(state, player, instance, eventName, context = {}) {
  const handler = instance.def.effects && instance.def.effects[eventName];
  if (handler) handler(state, player, instance, context);
}

/** <Repair(amount)>: at the end of your turn, this Unit recovers `amount` HP (13-1-1). */
function applyRepairAtEndOfTurn(player) {
  for (const instance of player.battleArea) {
    const amount = instance.def.keywords && instance.def.keywords.repair;
    if (amount) recoverHP(instance, amount);
  }
  if (player.base) {
    const amount = player.base.def.keywords && player.base.def.keywords.repair;
    if (amount) recoverHP(player.base, amount);
  }
}

/** <Support(amount)>: 【Activate・Main】Rest this Unit: another friendly Unit gets AP+amount this turn (13-1-3). */
function activateSupport(supporter, target) {
  const amount = supporter.def.keywords && supporter.def.keywords.support;
  if (!amount) throw new Error('Unit does not have Support');
  if (supporter.rested) throw new Error('Support requires an active Unit');
  supporter.rested = true;
  target.buffs.push({ ap: amount, scope: 'turn' });
}

/** Clears "during this turn" and "during this battle" buffs (7-6-6-1 / 8-6-1). */
function clearTurnBuffs(player) {
  for (const instance of player.battleArea) {
    instance.buffs = instance.buffs.filter((b) => b.scope !== 'turn');
  }
}

function clearBattleBuffs(player) {
  for (const instance of player.battleArea) {
    instance.buffs = instance.buffs.filter((b) => b.scope !== 'battle');
  }
}

module.exports = {
  triggerEvent,
  fireCardEffect,
  applyRepairAtEndOfTurn,
  activateSupport,
  clearTurnBuffs,
  clearBattleBuffs
};
