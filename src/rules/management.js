const { LIMITS } = require('./constants');

function getAP(instance) {
  let ap = instance.def.ap || 0;
  if (instance.pilot) ap += instance.pilot.def.apBonus || 0;
  if (instance.isLinkUnit) {
    ap += instance.def.duringLinkAp || 0;
    if (instance.pilot) ap += instance.pilot.def.duringLinkAp || 0;
  }
  for (const buff of instance.buffs) ap += buff.ap || 0;
  return Math.max(0, ap);
}

function getHP(instance) {
  let hp = instance.def.hp || 0;
  if (instance.pilot) hp += instance.pilot.def.hpBonus || 0;
  if (instance.isLinkUnit) {
    hp += instance.def.duringLinkHp || 0;
    if (instance.pilot) hp += instance.pilot.def.duringLinkHp || 0;
  }
  for (const buff of instance.buffs) hp += buff.hp || 0;
  return Math.max(0, hp);
}

/** Kindhearted GD04-101's "can't be destroyed by enemy effects" grant (13-2-x style immunity). */
function isImmuneToEffectDestroy(instance) {
  return instance.buffs.some((b) => b.effectDestroyImmune);
}

function getRemainingHP(instance) {
  return getHP(instance) - instance.damage;
}

/** Merges static keywords with any turn/battle-scoped keyword grants (e.g. a temporary <High-Maneuver>). */
function getKeywords(instance) {
  const granted = {};
  for (const buff of instance.buffs) {
    if (buff.keyword) granted[buff.keyword] = true;
  }
  const duringPair = instance.pilot ? instance.def.duringPairKeywords : null;
  const merged = Object.assign({}, instance.def.keywords, duringPair, instance.grantedKeywords, granted);
  // <Breach> is amount-based rather than boolean, so a temporary grant (e.g. Hoka Kyoten
  // Juzetsujin GD05-112's "gains Breach 3 during this turn") sums onto the base amount instead.
  const breachBuff = instance.buffs.reduce((sum, b) => sum + (b.breach || 0), 0);
  if (breachBuff) merged.breach = (merged.breach || 0) + breachBuff;
  return merged;
}

/**
 * Battle/effect damage to a Unit, Base, or Shield instance, honoring any <Reduce> buffs (5-21:
 * reduced to 0 is neither dealt nor received). `damageReduction` applies to all damage regardless
 * of source (e.g. Ra Cailum's "reduce damage it receives"); `effectDamageReduction` applies only
 * to damage NOT flagged `isBattleDamage` (e.g. Silver Bullet's "reduce effect damage" specifically
 * -- combat.js tags its own battle-damage calls so this narrower category can tell them apart).
 */
function dealDamage(instance, amount, opts = {}) {
  if (amount <= 0) return;
  let reduction = instance.buffs.reduce((sum, b) => sum + (b.damageReduction || 0), 0);
  // Destiny Gundam GD05-055's "Once per Turn, when this Unit receives enemy battle damage, reduce
  // it by 2" -- a static per-card cap, distinct from the buff-based reductions above.
  if (opts.isBattleDamage && instance.def.oncePerTurnBattleDamageReduction && !instance.activationsUsed.battleDamageReduced) {
    reduction += instance.def.oncePerTurnBattleDamageReduction;
    instance.activationsUsed.battleDamageReduced = true;
  }
  if (!opts.isBattleDamage) {
    reduction += instance.buffs.reduce((sum, b) => sum + (b.effectDamageReduction || 0), 0);
    if (instance.isLinkUnit && instance.pilot) {
      reduction += instance.pilot.def.duringLinkEffectDamageReduction || 0;
    }
  }
  const reduced = Math.max(0, amount - reduction);
  if (reduced <= 0) return;
  instance.damage += reduced;
}

function recoverHP(instance, amount) {
  if (amount <= 0) return;
  instance.damage = Math.max(0, instance.damage - amount);
}

/** 5-17-2-5: a token passes through its destination zone (so Destroyed/return triggers still fire)
 * but is removed from the game rather than persisting anywhere outside battle/resource/shield areas. */
function sendToZone(zoneArray, instance) {
  if (!instance.def.isToken) zoneArray.push(instance);
}

/** Moves a destroyed Unit/Base (and its paired Pilot, per 3-3-6) from wherever it is into its owner's trash. */
function destroyCard(state, player, instance) {
  const battleIdx = player.battleArea.indexOf(instance);
  if (battleIdx !== -1) player.battleArea.splice(battleIdx, 1);
  if (player.base === instance) player.base = null;

  if (instance.pilot) {
    sendToZone(player.trash, instance.pilot);
    instance.pilot = null;
  }
  sendToZone(player.trash, instance);
}

/**
 * Removes a Unit from the battle area/base slot without destroying it (e.g. bounced to hand, or
 * returned to its owner's deck). 3-3-6: its paired Pilot follows it to that same destination zone
 * rather than going to trash -- pass the zone array the Unit itself is about to enter as
 * `destinationZone` (defaults to trash, matching how a battle-area-limit bump handles pairs).
 * Caller decides where the instance itself ends up.
 */
function removeFromField(player, instance, destinationZone) {
  const battleIdx = player.battleArea.indexOf(instance);
  if (battleIdx !== -1) player.battleArea.splice(battleIdx, 1);
  if (player.base === instance) player.base = null;

  if (instance.pilot) {
    sendToZone(destinationZone || player.trash, instance.pilot);
    instance.pilot = null;
  }
}

/** Destroys the instance if its HP has been reduced to 0 or less. Returns true if destroyed. */
function destroyIfDead(state, player, instance) {
  if (getRemainingHP(instance) <= 0) {
    destroyCard(state, player, instance);
    return true;
  }
  return false;
}

/**
 * Removes the top Shield for the caller to reveal/resolve Burst on (5-10-3). Does NOT move it to
 * trash -- that only happens by default if nothing (e.g. a Burst effect) relocates it elsewhere.
 */
function destroyTopShield(player) {
  return player.shields.shift();
}

function enforceBattleAreaLimit(player, chooseToTrash) {
  while (player.battleArea.length > LIMITS.MAX_BATTLE_AREA) {
    const choice = chooseToTrash ? chooseToTrash(player.battleArea) : player.battleArea[0];
    const idx = player.battleArea.indexOf(choice);
    const [removed] = player.battleArea.splice(idx, 1);
    // Not treated as destroyed (11-4-2-1) -- goes straight to trash without triggering Destroyed effects.
    if (removed.pilot) {
      sendToZone(player.trash, removed.pilot);
      removed.pilot = null;
    }
    sendToZone(player.trash, removed);
  }
}

function enforceBaseLimit(player) {
  // Base section holds at most one Base (11-5); a new Base bumps the old one to trash untouched by "destroyed".
  if (player.base && player._pendingBase) {
    sendToZone(player.trash, player.base);
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

/**
 * Checks/applies the two defeat conditions from 11-2. Sets state.winner if exactly one player has
 * lost. 11-2-1: if *all* players fulfilling a defeat condition are defeated simultaneously, a genuine
 * double-defeat is possible -- treated as a draw (state.draw) rather than picking an arbitrary winner.
 */
function checkDefeat(state) {
  const defeatedIdxs = state.players.reduce((acc, p, i) => (p.defeated ? [...acc, i] : acc), []);
  if (defeatedIdxs.length === state.players.length && defeatedIdxs.length > 0) {
    state.draw = true;
  } else if (defeatedIdxs.length === 1) {
    state.winner = 1 - defeatedIdxs[0];
  }
  return state.winner;
}

module.exports = {
  getAP,
  getHP,
  getRemainingHP,
  getKeywords,
  isImmuneToEffectDestroy,
  dealDamage,
  recoverHP,
  sendToZone,
  destroyCard,
  removeFromField,
  destroyIfDead,
  destroyTopShield,
  enforceBattleAreaLimit,
  enforceBaseLimit,
  enforceHandLimit,
  checkDefeat
};
