const { LIMITS } = require('./constants');

/**
 * "Pilot Command" cards (e.g. Deep Devotion GD01-101, "[Pilot][Lucrezia Noin]") are Command cards
 * that can alternatively be paired onto a Unit as if they were a Pilot named/statted per their
 * `pilotMode` field, instead of being played for their printed Main/Burst text. This resolves the
 * effective name/apBonus/hpBonus/traits to use for pairing/link-matching purposes, falling back to
 * the card's own top-level fields for an ordinary Pilot card (no pilotMode).
 */
function effectivePilotDef(pilotInstance) {
  const def = pilotInstance.def;
  return def.pilotMode ? Object.assign({}, def, def.pilotMode) : def;
}

function getAP(instance) {
  let ap = instance.def.ap || 0;
  if (instance.pilot) ap += effectivePilotDef(instance.pilot).apBonus || 0;
  if (instance.isLinkUnit) {
    ap += instance.def.duringLinkAp || 0;
    if (instance.pilot) ap += instance.pilot.def.duringLinkAp || 0;
  }
  // Duo Maxwell GD01-090's "During Link, this Unit's AP can't be reduced by enemy effects" --
  // filters out negative AP contributions rather than tracking a separate immunity flag per buff.
  const apReduceImmune = instance.isLinkUnit && instance.pilot && instance.pilot.def.duringLinkApReduceImmune;
  for (const buff of instance.buffs) {
    const change = buff.ap || 0;
    if (apReduceImmune && change < 0) continue;
    ap += change;
  }
  // Michaelis GD01-076 / M1 Astray GD01-081: a static AP/HP grant conditioned on board/trash state,
  // re-evaluated each start of turn (grantedStatBonus) rather than tracked as a scoped buff, same
  // live-computed philosophy as the team-repair aura and the Duel Gundam AP-threshold Breach.
  ap += (instance.grantedStatBonus && instance.grantedStatBonus.ap) || 0;
  // Riddhe Marcenas GD01-089: "While this Unit has <Repair>, it gets AP+1" -- checks only the
  // Unit's own static Repair source (its printed keyword, or a Link-granted Repair from this same
  // Pilot) rather than calling getKeywords (which itself can depend back on getAP via the Duel
  // Gundam threshold above), to avoid a circular dependency.
  if (instance.pilot && instance.pilot.def.apBonusIfRepair) {
    const hasRepair = !!(
      (instance.def.keywords && instance.def.keywords.repair) ||
      (instance.isLinkUnit && instance.pilot.def.duringLinkRepair)
    );
    if (hasRepair) ap += instance.pilot.def.apBonusIfRepair;
  }
  // GQuuuuuuX GD02-034: "[During Pair: Red Pilot] This Unit gets AP+2" -- a Unit-side AP bonus
  // conditioned on its own paired Pilot's color, mirroring apBonusIfRepair's live-computed shape.
  if (instance.pilot && instance.def.duringPairApBonusIfPilotColor) {
    const cond = instance.def.duringPairApBonusIfPilotColor;
    if (instance.pilot.def.color === cond.color) ap += cond.amount;
  }
  // Asemu Asuno (R+) GD03-088: "[During Link] If this is an (AGE System) Unit, it gets AP+1" -- a
  // Link-granted AP bonus conditioned on the paired Unit's own trait, gated on isLinkUnit like
  // duringLinkAp above (unlike breachIfUnitTrait in getKeywords below, which isn't Link-gated).
  if (instance.isLinkUnit && instance.pilot) {
    const traitAp = instance.pilot.def.duringLinkApIfTrait;
    if (traitAp && (instance.def.traits || []).includes(traitAp.trait)) ap += traitAp.amount;
  }
  // Gundam Barbatos Lupus Rex (LR+) GD05-051: "Increase this Unit's AP by an amount equal to the
  // amount of damage it has received" -- live-computed off current damage like the other
  // board-state-conditional bonuses above, so it can't go stale as damage/HP change mid-turn.
  if (instance.def.apBonusEqualToDamage) ap += instance.damage;
  // Gundam Barbatos 2nd Form ST05-002: "While this Unit is damaged, it gets AP+2" -- a fixed
  // (not damage-scaling) bonus, live-computed the same way as apBonusEqualToDamage above.
  if (instance.def.apBonusWhileDamaged && instance.damage > 0) ap += instance.def.apBonusWhileDamaged;
  // Prospera Mercury GD05-088: "This Unit and all your Units with 'Gundam Lfrith' or 'Gundnode' in
  // their card name get AP+1" -- a Pilot-sourced team-wide aura by name, written onto a dedicated
  // field by her own startOfTurn handler (not the shared grantedStatBonus, which each unit's own
  // startOfTurn handler overwrites wholesale) so it can't collide with an unrelated recompute.
  ap += instance.prosperaApBonus || 0;
  return Math.max(0, ap);
}

function getHP(instance) {
  let hp = instance.def.hp || 0;
  if (instance.pilot) hp += effectivePilotDef(instance.pilot).hpBonus || 0;
  if (instance.isLinkUnit) {
    hp += instance.def.duringLinkHp || 0;
    if (instance.pilot) hp += instance.pilot.def.duringLinkHp || 0;
  }
  for (const buff of instance.buffs) hp += buff.hp || 0;
  hp += (instance.grantedStatBonus && instance.grantedStatBonus.hp) || 0;
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
  // Red Gundam (R+) GD02-024: "[During Link] This Unit gains <High-Maneuver>" -- a Unit's own
  // printed Link grant, same shape as duringPairKeywords above but gated on isLinkUnit instead of
  // having a paired Pilot.
  const duringLink = instance.isLinkUnit ? instance.def.duringLinkKeywords : null;
  const merged = Object.assign({}, instance.def.keywords, duringPair, duringLink, instance.grantedKeywords, granted);
  // Gundam Barbatos 4th Form ST05-001: "While this is damaged, it gains <Suppression>" -- live-
  // computed off current damage, same shape as the AP-threshold/trait-conditional grants below.
  if (instance.def.keywordWhileDamaged && instance.damage > 0) merged[instance.def.keywordWhileDamaged] = true;
  // <Breach> is amount-based rather than boolean, so a temporary grant (e.g. Hoka Kyoten
  // Juzetsujin GD05-112's "gains Breach 3 during this turn") sums onto the base amount instead.
  const breachBuff = instance.buffs.reduce((sum, b) => sum + (b.breach || 0), 0);
  if (breachBuff) merged.breach = (merged.breach || 0) + breachBuff;
  // Duel Gundam GD01-054: "While this Unit has 5+ AP, it gains <Breach 3>" -- live-computed off
  // current AP for the same reason as the team-repair aura: it can't go stale across turns.
  const apThreshold = instance.def.breachWhileAPAtLeast;
  if (apThreshold && getAP(instance) >= apThreshold.ap) merged.breach = (merged.breach || 0) + apThreshold.amount;
  // Buster Gundam GD02-076: "While this Unit has 5+ AP, it gains <Blocker>" -- same live-computed
  // AP-threshold shape as breachWhileAPAtLeast above, for a boolean keyword instead of an amount.
  if (instance.def.blockerWhileAPAtLeast !== undefined && getAP(instance) >= instance.def.blockerWhileAPAtLeast) {
    merged.blocker = true;
  }
  // M'Quve GD01-092 / Cagalli Yula Athha GD01-096: a Pilot-granted keyword conditioned on the
  // paired Unit's own trait/color, live-computed the same way as the AP-threshold Breach above.
  if (instance.pilot) {
    const traitBreach = instance.pilot.def.breachIfUnitTrait;
    if (traitBreach && (instance.def.traits || []).includes(traitBreach.trait)) {
      merged.breach = (merged.breach || 0) + traitBreach.amount;
    }
    const colorKeyword = instance.pilot.def.keywordIfUnitColor;
    if (colorKeyword && instance.def.color === colorKeyword.color) merged[colorKeyword.keyword] = true;
    // Lauda Neill GD05-087 / Gyunei Guss GD05-095: "While this Unit is (Academy)/(Neo Zeon), it
    // gains <High-Maneuver>/<Blocker>" -- same trait-conditional shape as keywordIfUnitColor above,
    // just keyed on a trait instead of a color.
    const traitKeyword = instance.pilot.def.keywordIfUnitTrait;
    if (traitKeyword && (instance.def.traits || []).includes(traitKeyword.trait)) merged[traitKeyword.keyword] = true;
  }
  // Asemu Asuno (R+) GD03-088: "[During Link] If this is an (AGE System) Unit, ... it gains
  // <Breach 1>" -- same trait-conditional shape as breachIfUnitTrait above, gated on isLinkUnit.
  if (instance.isLinkUnit && instance.pilot) {
    const traitBreach = instance.pilot.def.duringLinkBreachIfTrait;
    if (traitBreach && (instance.def.traits || []).includes(traitBreach.trait)) {
      merged.breach = (merged.breach || 0) + traitBreach.amount;
    }
  }
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
  // Rey Za Burrel (R+) GD04-093 / Witches from Earth GD04-108: "reduce the next damage it receives
  // by N" -- a one-shot reduction consumed by the very next damage event (any source), unlike the
  // persistent damageReduction buff above which reduces every damage instance for its whole scope.
  const nextIdx = instance.buffs.findIndex((b) => b.nextDamageReduction);
  if (nextIdx !== -1) {
    reduction += instance.buffs[nextIdx].nextDamageReduction;
    instance.buffs.splice(nextIdx, 1);
  }
  // Destiny Gundam GD05-055's "Once per Turn, when this Unit receives enemy battle damage, reduce
  // it by 2" -- a static per-card cap, distinct from the buff-based reductions above.
  if (opts.isBattleDamage && instance.def.oncePerTurnBattleDamageReduction && !instance.activationsUsed.battleDamageReduced) {
    reduction += instance.def.oncePerTurnBattleDamageReduction;
    instance.activationsUsed.battleDamageReduced = true;
  }
  // Gundam Dynames (GN Full Shield) GD04-029: "[Once per Turn] If you have a (CB) Pilot in play,
  // when this Unit receives damage from an enemy, reduce it by 1" -- unlike the battle-only
  // reduction above, this covers both battle and effect damage, so it's gated on opts.isEnemyDamage
  // (set by both combat.js and effects.js's dealEffectDamage) rather than opts.isBattleDamage.
  const enemyCond = instance.def.oncePerTurnEnemyDamageReduction;
  if (opts.isEnemyDamage && enemyCond && !instance.activationsUsed.enemyDamageReduced) {
    // Rey's Blaze Zaku Phantom GD04-053: "[During Link] [Once per Turn] When this Unit receives
    // damage from an enemy, reduce it by 1" -- same shape as Dynames above, gated on isLinkUnit
    // instead of a friendly-pilot-in-play check; both conditions are optional and ANDed.
    const conditionMet =
      (!enemyCond.pilotTraitInPlay ||
        (opts.player && opts.player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes(enemyCond.pilotTraitInPlay)))) &&
      (!enemyCond.duringLinkOnly || instance.isLinkUnit);
    if (conditionMet) {
      reduction += enemyCond.amount;
      instance.activationsUsed.enemyDamageReduced = true;
    }
  }
  if (!opts.isBattleDamage) {
    reduction += instance.buffs.reduce((sum, b) => sum + (b.effectDamageReduction || 0), 0);
    if (instance.isLinkUnit && instance.pilot) {
      reduction += instance.pilot.def.duringLinkEffectDamageReduction || 0;
    }
    // Odelo Henrik GD05-084: "When one of your (League Militaire) Unit tokens receives enemy effect
    // damage, reduce it by 1" -- a Pilot-granted, team-wide aura scoped to tokens of a given trait,
    // checked via opts.player (already threaded through for oncePerTurnEnemyDamageReduction above).
    if (opts.isEnemyDamage && instance.def.isToken && opts.player) {
      for (const u of opts.player.battleArea) {
        const aura = u.pilot && u.pilot.def.auraReduceTokenEffectDamage;
        if (aura && (instance.def.traits || []).includes(aura.trait)) {
          reduction += aura.amount;
          break;
        }
      }
    }
  } else {
    // Quess Paraya GD05-094: "[Destroyed] Choose 1 of your (Neo Zeon) Units. During this turn, when
    // it receives enemy battle damage, reduce it by 2" -- a chosen-target, turn-scoped buff, unlike
    // oncePerTurnBattleDamageReduction's static per-card cap above.
    reduction += instance.buffs.reduce((sum, b) => sum + (b.battleDamageReduction || 0), 0);
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

/**
 * G-Defenser GD03-079: "When you rest your Base with one of your Units' effects, you may rest this
 * Unit instead." A replacement effect on Base-resting caused by a card's own ability (not combat) --
 * the 2 existing effects that manually rest the Base (Zeta Gundam (LR+) GD02-069, Rick Dias (Red)
 * GD02-075) call this instead of setting `player.base.rested` directly, so the redirect applies
 * wherever it's actually relevant. Defaults to always redirecting when available (never a downside:
 * either the Base or G-Defenser itself ends up rested).
 */
function restBaseOrRedirect(player) {
  const redirect = player.battleArea.find((u) => u.def.canRestInsteadOfBase && !u.rested);
  if (redirect) {
    redirect.rested = true;
    return;
  }
  player.base.rested = true;
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

/**
 * Sum of "how close to usable" every distinct trashSynergy-flagged card the player controls (in
 * play or in hand) is, as a 0..1 fraction of its own threshold. Deduped by synergy signature (not
 * per-copy) so holding 2+ copies of the same payoff card doesn't inflate its value -- the trash
 * count that matters is the same single pile regardless of how many copies want it. Lives here
 * (rather than ai/score.js, which re-exports it for backward compatibility) so ai/valueFeatures.js
 * can use it too without creating a score.js <-> valueFeatures.js circular require.
 */
function trashSynergyValue(player) {
  const seen = new Set();
  let value = 0;
  for (const card of [...player.battleArea, ...player.hand]) {
    const synergy = card.def.trashSynergy;
    if (!synergy) continue;
    const key = JSON.stringify(synergy);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = player.trash.filter(
      (t) =>
        (synergy.traits && (t.def.traits || []).some((trait) => synergy.traits.includes(trait))) ||
        (synergy.color && t.def.color === synergy.color)
    ).length;
    value += Math.min(count, synergy.threshold) / synergy.threshold;
  }
  return value;
}

/** Discards a specific card from hand (effect-driven "draw N, discard 1"-style text), as opposed to
 * enforceHandLimit's end-of-turn discard-to-limit. Pulled out so the replay trace can observe every
 * effect discard the same way it already observes destroys/damage, rather than each registry.js
 * effect splicing hand/trash directly and leaving no hook to patch. */
function discardFromHand(player, card) {
  player.hand.splice(player.hand.indexOf(card), 1);
  player.trash.push(card);
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
  effectivePilotDef,
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
  restBaseOrRedirect,
  destroyIfDead,
  destroyTopShield,
  enforceBattleAreaLimit,
  enforceBaseLimit,
  enforceHandLimit,
  discardFromHand,
  trashSynergyValue,
  checkDefeat
};
