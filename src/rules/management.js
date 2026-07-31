const { LIMITS } = require('./constants');

function getAP(instance) {
  let ap = instance.def.ap || 0;
  if (instance.pilot) ap += instance.pilot.def.apBonus || 0;
  for (const buff of instance.buffs) ap += buff.ap || 0;
  return Math.max(0, ap);
}

function getHP(instance) {
  let hp = instance.def.hp || 0;
  if (instance.pilot) hp += instance.pilot.def.hpBonus || 0;
  for (const buff of instance.buffs) hp += buff.hp || 0;
  return Math.max(0, hp);
}

function getRemainingHP(instance) {
  return getHP(instance) - instance.damage;
}

function getKeywords(instance) {
  return Object.assign({}, instance.def.keywords, instance.grantedKeywords);
}

/** Battle/effect damage to a Unit, Base, or Shield instance. Does not by itself move destroyed cards to trash. */
function dealDamage(instance, amount) {
  if (amount <= 0) return;
  instance.damage += amount;
}

function recoverHP(instance, amount) {
  if (amount <= 0) return;
  instance.damage = Math.max(0, instance.damage - amount);
}

/** Moves a destroyed Unit/Base (and its paired Pilot, per 3-3-6) from wherever it is into its owner's trash. */
function destroyCard(state, player, instance) {
  const battleIdx = player.battleArea.indexOf(instance);
  if (battleIdx !== -1) player.battleArea.splice(battleIdx, 1);
  if (player.base === instance) player.base = null;

  if (instance.pilot) {
    player.trash.push(instance.pilot);
    instance.pilot = null;
  }
  player.trash.push(instance);
}

/** Destroys the instance if its HP has been reduced to 0 or less. Returns true if destroyed. */
function destroyIfDead(state, player, instance) {
  if (getRemainingHP(instance) <= 0) {
    destroyCard(state, player, instance);
    return true;
  }
  return false;
}

/** Reveals and destroys the top Shield, returning it (caller handles Burst). Assumes at least one Shield is present. */
function destroyTopShield(player) {
  const shield = player.shields.shift();
  player.trash.push(shield);
  return shield;
}

function enforceBattleAreaLimit(player, chooseToTrash) {
  while (player.battleArea.length > LIMITS.MAX_BATTLE_AREA) {
    const choice = chooseToTrash ? chooseToTrash(player.battleArea) : player.battleArea[0];
    const idx = player.battleArea.indexOf(choice);
    const [removed] = player.battleArea.splice(idx, 1);
    // Not treated as destroyed (11-4-2-1) -- goes straight to trash without triggering Destroyed effects.
    if (removed.pilot) {
      player.trash.push(removed.pilot);
      removed.pilot = null;
    }
    player.trash.push(removed);
  }
}

function enforceBaseLimit(player) {
  // Base section holds at most one Base (11-5); a new Base bumps the old one to trash untouched by "destroyed".
  if (player.base && player._pendingBase) {
    player.trash.push(player.base);
    player.base = player._pendingBase;
    delete player._pendingBase;
  }
}

function enforceHandLimit(player, chooseDiscards) {
  while (player.hand.length > LIMITS.MAX_HAND) {
    const excess = player.hand.length - LIMITS.MAX_HAND;
    const discards = chooseDiscards
      ? chooseDiscards(player.hand, excess)
      : player.hand.slice(0, excess);
    for (const card of discards) {
      const idx = player.hand.indexOf(card);
      if (idx !== -1) {
        player.hand.splice(idx, 1);
        player.trash.push(card);
      }
    }
  }
}

/** Checks/applies the two defeat conditions from 11-2. Sets state.winner if a player has lost. */
function checkDefeat(state) {
  for (let i = 0; i < state.players.length; i++) {
    if (state.players[i].defeated) {
      state.winner = 1 - i;
      return state.winner;
    }
  }
  return state.winner;
}

module.exports = {
  getAP,
  getHP,
  getRemainingHP,
  getKeywords,
  dealDamage,
  recoverHP,
  destroyCard,
  destroyIfDead,
  destroyTopShield,
  enforceBattleAreaLimit,
  enforceBaseLimit,
  enforceHandLimit,
  checkDefeat
};
