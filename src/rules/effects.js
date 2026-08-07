const { recoverHP, dealDamage, getRemainingHP } = require('./management');
const { createInstance } = require('./state');
const { EX_RESOURCE_DEF } = require('./setup');

/**
 * Dispatches a broadcast trigger (e.g. "at the start/end of turn") to every card on the field
 * with a matching handler, using the same (state, player, instance, context) signature as
 * fireCardEffect so effect authors only need one calling convention. Resolution order per
 * 10-1-6-6: the active player's triggers resolve first, then the standby player's.
 */
function triggerEvent(state, eventName, context) {
  // Many single-card unit tests call pairPilot/unpairPilot with a deliberately minimal state stand-in
  // (e.g. `{ turnNumber: 1 }`) that has no `players` array at all -- harmless there since those tests
  // only assert on the paired unit's own live-computed getAP/getKeywords, not on a broadcast re-sync.
  // Real games always build `state` via createGame, so this never skips anything in actual play.
  if (!Array.isArray(state.players)) return;
  const order = [state.players[state.activePlayerIdx], state.players[1 - state.activePlayerIdx]];
  for (const player of order) {
    const cardsOnField = [...player.battleArea, player.base].filter(Boolean);
    for (const instance of cardsOnField) {
      const handler = instance.def.effects && instance.def.effects[eventName];
      // Gouf Vijayanta EB01-014: dealEffectDamage needs to know which Unit's ability is currently
      // resolving to check that source's own Level -- resolvingSource is set/restored around every
      // handler invocation here and in fireCardEffect below, the two chokepoints all card-ability
      // handlers are actually called through.
      const prevSource = state.resolvingSource;
      state.resolvingSource = instance;
      try {
        if (handler) handler(state, player, instance, context);
        // Jerid Messa GD02-086 / Challia Bull (GQ) GD02-090: a Pilot's own board-state-conditional
        // stat text needs to re-evaluate at startOfTurn same as a Unit's -- mirrors fireCardEffect's
        // existing pilot-forwarding for self-scoped triggers (13-2-x). No pre-GD02 Pilot has a
        // broadcast-event handler, so this is purely additive.
        if (instance.pilot) {
          const pilotHandler = instance.pilot.def.effects && instance.pilot.def.effects[eventName];
          if (pilotHandler) pilotHandler(state, player, instance, context);
        }
      } finally {
        state.resolvingSource = prevSource;
      }
    }
  }
}

/**
 * Fires a card's own printed ability for a self-scoped trigger (Deploy/Attack/Destroyed/When
 * Paired/When Linked -- 13-2-6..13-2-12): these activate on the specific card itself, not as a
 * broadcast to everything on the field the way "at the start/end of turn" effects do.
 * Per 2-11-3/3-3-9-2, a paired Pilot's printed text is gained by the Unit it's paired with, so a
 * paired Pilot's matching handler fires too (with the Unit, not the Pilot, as the instance).
 */
function fireCardEffect(state, player, instance, eventName, context = {}) {
  const handler = instance.def.effects && instance.def.effects[eventName];
  // See triggerEvent's matching comment above: resolvingSource is what lets dealEffectDamage check
  // the source Unit's own Level (Gouf Vijayanta EB01-014).
  const prevSource = state.resolvingSource;
  state.resolvingSource = instance;
  try {
    if (handler) handler(state, player, instance, context);
    if (instance.pilot) {
      const pilotHandler = instance.pilot.def.effects && instance.pilot.def.effects[eventName];
      if (pilotHandler) pilotHandler(state, player, instance, context);
    }
    // At the Risk of One's Life GD05-104: "This Unit gains [an ability] during this turn" -- a
    // Command-granted, turn-scoped triggered ability. Stored as a buff carrying the actual handler
    // function (grantedEffect: {eventName, fn}) so it resolves generically here for any future
    // "gains the following ability" text, not just this one card.
    for (const buff of instance.buffs) {
      if (buff.grantedEffect && buff.grantedEffect.eventName === eventName) {
        buff.grantedEffect.fn(state, player, instance, context);
      }
    }
  } finally {
    state.resolvingSource = prevSource;
  }
}

/**
 * Gundam RX-78-2 GD01-001: "All your (White Base Team) Units gain <Repair 1>" -- a constant
 * team-wide aura, live-computed here (Repair only ever matters at this one point) rather than
 * tracked as granted state, so it can't go stale/duplicate across turns.
 */
function teamRepairAuraBonus(player, instance) {
  let bonus = 0;
  for (const source of player.battleArea) {
    const aura = source.def.teamRepairAura;
    if (aura && (instance.def.traits || []).includes(aura.trait)) bonus += aura.amount;
  }
  return bonus;
}

/** <Repair(amount)>: at the end of your turn, this Unit recovers `amount` HP (13-1-1). */
function applyRepairAtEndOfTurn(state, player) {
  for (const instance of player.battleArea) {
    let amount = (instance.def.keywords && instance.def.keywords.repair) || 0;
    if (instance.isLinkUnit && instance.pilot) amount += instance.pilot.def.duringLinkRepair || 0;
    amount += instance.buffs.reduce((sum, b) => sum + (b.repair || 0), 0);
    amount += teamRepairAuraBonus(player, instance);
    // Sayla Mass GD01-087: "While this Unit is blue, it gains <Repair 1>" -- a Pilot-granted Repair
    // conditioned on the paired Unit's own color.
    if (instance.pilot) {
      const conditional = instance.pilot.def.duringPairRepairIfColor;
      if (conditional && instance.def.color === conditional.color) amount += conditional.amount;
    }
    // Hyaku-Shiki (R+) GD02-072: "While a friendly white Base is in play, this Unit gains <Repair 1>."
    if (instance.def.repairIfFriendlyBase && player.base) amount += instance.def.repairIfFriendlyBase;
    // Hizack GD03-013: grantedKeywords.repair (live board-state Repair grants) was previously never
    // read here, so it had no actual effect -- fixed as part of wiring up Gundam Barbatos 6th Form
    // GD03-061's own conditional Repair below.
    amount += instance.grantedKeywords.repair || 0;
    // Gundam Barbatos 6th Form GD03-061: "While this Unit has 1 HP, it gains <Repair 3>" -- checked
    // live at the moment Repair resolves (not snapshotted at startOfTurn) since HP can change mid-turn.
    if (instance.def.repairIfHPExactly && getRemainingHP(instance) === instance.def.repairIfHPExactly.hp) {
      amount += instance.def.repairIfHPExactly.amount;
    }
    if (amount) {
      recoverHP(instance, amount);
      // Four Murasame (R+) GD02-085: "[During Link] when this Unit recovers HP..." -- fired here
      // since end-of-turn Repair is the only realistic HP-recovery source for a paired Unit.
      fireCardEffect(state, player, instance, 'recoversHP', {});
    }
  }
  if (player.base) {
    const amount = (player.base.def.keywords && player.base.def.keywords.repair) || 0;
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

/**
 * Deals effect damage (not battle damage) to a card and, if the source is an opponent of its
 * owner, fires a "receives enemy effect damage" reactive trigger on it (e.g. Raider Gundam
 * GD02-010's "[Once per Turn] When this Unit receives enemy effect damage, draw 1"). Scoped to
 * effects written from GD02 onward rather than swept into every pre-existing damage-dealing
 * effect -- same deliberate, documented scoping as destroyAndFireEffect (combat.js).
 */
function dealEffectDamage(state, sourcePlayer, targetOwner, target, amount) {
  // Gundam Leopard GD02-064: "During your turn, while there are 7 or more cards in your trash, this
  // Unit can't receive effect damage from enemy Commands" -- state.resolvingCommand is set for the
  // duration of a Command's effect (playCommand in actions.js) so this can tell an enemy Command's
  // damage apart from any other effect-damage source.
  if (
    state.resolvingCommand &&
    sourcePlayer !== targetOwner &&
    target.def.commandDamageImmuneWithTrash !== undefined &&
    state.players[state.activePlayerIdx] === targetOwner &&
    targetOwner.trash.length >= target.def.commandDamageImmuneWithTrash
  ) {
    return;
  }
  // Fighting Alone GD04-119: "can't receive effect damage from enemy Units during this turn" -- this
  // engine doesn't tag effect-damage sources by card type beyond the existing Command-vs-other split
  // above (state.resolvingCommand, used there for the inverse "immune to enemy Commands" case), so
  // "enemy Units" is read as "enemy, while not resolving a Command" using that same distinction.
  if (
    sourcePlayer !== targetOwner &&
    !state.resolvingCommand &&
    target.buffs.some((b) => b.immuneToNonCommandEnemyEffectDamage)
  ) {
    return;
  }
  // Archangel GD05-123: "During your opponent's turn, friendly (Orb) Units can't receive 2 or less
  // enemy effect damage" -- a Base-granted low-damage immunity, scoped (like Gundam Leopard/Fighting
  // Alone above) to effects routed through this shared dealEffectDamage entry point.
  if (
    sourcePlayer !== targetOwner &&
    state.players[state.activePlayerIdx] !== targetOwner &&
    targetOwner.base &&
    targetOwner.base.def.orbEffectDamageImmuneThreshold !== undefined &&
    amount <= targetOwner.base.def.orbEffectDamageImmuneThreshold &&
    (target.def.traits || []).includes('Orb')
  ) {
    return;
  }
  // Gouf Vijayanta EB01-014: "During your opponent's turn, this Unit can't receive effect damage
  // from enemy Units that are Lv.5 or lower." state.resolvingSource (set by fireCardEffect/
  // triggerEvent above) is the Unit instance whose ability is currently resolving; !resolvingCommand
  // narrows "enemy Units" the same way Fighting Alone's check above does, since this engine doesn't
  // separately tag Pilot-granted text (resolvingSource is still the paired Unit for those, which is
  // correct -- 2-11-3, a paired Pilot's text is gained by the Unit).
  if (
    sourcePlayer !== targetOwner &&
    !state.resolvingCommand &&
    target.def.effectDamageImmuneFromUnitsLevelAtMost !== undefined &&
    state.players[state.activePlayerIdx] === sourcePlayer &&
    state.resolvingSource &&
    (state.resolvingSource.def.level || 0) <= target.def.effectDamageImmuneFromUnitsLevelAtMost
  ) {
    return;
  }
  dealDamage(target, amount, { isEnemyDamage: sourcePlayer !== targetOwner, player: targetOwner });
  // CGS Mobile Worker (Commander Type) GD03-060: "when this Unit receives effect damage" -- unlike
  // the enemy-only trigger below, this reacts regardless of source, so it needs its own broadcast.
  fireCardEffect(state, targetOwner, target, 'receivesEffectDamage', {});
  if (sourcePlayer !== targetOwner) {
    fireCardEffect(state, targetOwner, target, 'receivesEnemyEffectDamage', {});
    // Gundam Pharact (LR+) GD04-018: "receives damage from an enemy" (unqualified) -- fired here too
    // so the same friendlyUnitReceivesEnemyDamage broadcast combat.js's fireDealsBattleDamage uses
    // for battle damage also covers effect damage, matching the card's unqualified wording.
    for (const c of [...targetOwner.battleArea, targetOwner.base].filter(Boolean)) {
      const handler = c.def.effects && c.def.effects.friendlyUnitReceivesEnemyDamage;
      if (handler) handler(state, targetOwner, c, { target });
    }
  }
  // Gundam Gusion Rebake Full City (R+) GD03-053: "[During Pair][Once per Turn] During your turn,
  // when one of your (Tekkadan)/(Teiwaz) Units receives effect damage, ..." -- reacts to ANY
  // qualifying friendly Unit's damage, not just its own, so broadcast to the whole field the same
  // way fireDestroysEnemy (combat.js) broadcasts friendlyUnitDestroysEnemy. Hotarubi GD03-129 needs
  // this on a Base, so the broadcast target list includes player.base like restEnemyByEffect's does.
  for (const c of [...targetOwner.battleArea, targetOwner.base].filter(Boolean)) {
    const handler = c.def.effects && c.def.effects.friendlyUnitReceivesEffectDamage;
    if (handler) handler(state, targetOwner, c, { target });
  }
}

/**
 * Applies an AP debuff to an enemy Unit and, if the source is an opponent of its owner, fires an
 * "AP reduced by enemy" reactive trigger (e.g. Calamity Gundam GD02-009). Same forward-only scoping
 * as dealEffectDamage above -- existing GD01 debuff effects push buffs directly and aren't swept.
 */
function reduceEnemyAP(state, sourcePlayer, targetOwner, target, amount, scope = 'turn') {
  target.buffs.push({ ap: -amount, scope });
  if (sourcePlayer !== targetOwner) fireCardEffect(state, targetOwner, target, 'apReducedByEnemy', {});
}

/**
 * Places an EX Resource (5-17-3-2-3) and fires a "placed EX Resource" reactive trigger on the
 * player's own field (e.g. G-Exes GD02-022's "[Once per Turn] When you place an EX Resource,
 * choose 1 of your (AGE System) Units..."). Scoped forward-only like dealEffectDamage/reduceEnemyAP
 * above -- the many pre-existing EX-Resource-placing effects push directly and aren't swept.
 */
function placeExResource(state, player) {
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));
  // 9th Tactical Testing Sector GD04-124: "When you place an EX Resource, choose 1 friendly
  // (Academy) Unit..." -- a Base-granted version of this reaction, so the broadcast target list
  // includes player.base like other broadcasts (playCommand's friendlyPlaysCommand, etc.) already do.
  for (const u of [...player.battleArea, player.base].filter(Boolean)) {
    const handler = u.def.effects && u.def.effects.placesExResource;
    if (handler) handler(state, player, u, {});
  }
}

/**
 * Sets a Unit active via a card effect (not the normal start-of-turn active step) and fires a
 * "set active by effect" reactive trigger (e.g. Graham Aker (R+) GD03-098's "[During Link] When
 * this rested Unit is set as active by an effect..."). Only fires if the Unit was actually rested,
 * matching the card text's "this rested Unit."
 */
function setActiveByEffect(state, player, instance) {
  const wasRested = instance.rested;
  instance.rested = false;
  if (wasRested) fireCardEffect(state, player, instance, 'setActiveByEffect', {});
}

/**
 * Doritea GD03-128: "[Once per Turn] During your opponent's turn, when one of your Units is rested
 * by one of your opponent's effects, ..." -- rests a Unit via a card effect (not combat) and, if the
 * source is an opponent of its owner, fires a "rested by enemy effect" trigger plus a field-wide
 * broadcast, same enemy-only + broadcast shape as dealEffectDamage above. Scoped forward-only (only
 * new enemy-rest effects from here on call it) like every other trigger in this file.
 */
function restEnemyByEffect(state, sourcePlayer, targetOwner, target) {
  target.rested = true;
  if (sourcePlayer === targetOwner) return;
  fireCardEffect(state, targetOwner, target, 'restedByEnemyEffect', {});
  for (const c of [...targetOwner.battleArea, targetOwner.base].filter(Boolean)) {
    const handler = c.def.effects && c.def.effects.friendlyUnitRestedByEnemyEffect;
    if (handler) handler(state, targetOwner, c, { target });
  }
}

/**
 * Turn A Gundam GD04-069: "[During Link] At the end of a turn where you have paid (1) or more for
 * one of your other (Militia)/(Dianna Counter) Units' effects, choose 1 of your (Militia) Units.
 * Set it as active." Records a resource-cost payment made for a specific Unit's own Activate
 * ability (not a card's deploy/play cost, which payCost in cost.js already handles) so a reactive
 * effect like this can observe it. Forward-scoped like every other trigger in this file: only new
 * Activate abilities that need to be observable this way call it going forward. Reset each turn in
 * runStartPhase (src/rules/phases.js), mirroring player.specialMoveActivatedThisTurn.
 */
function payAbilityCost(state, player, source, amount) {
  player.abilityCostsPaidThisTurn = player.abilityCostsPaidThisTurn || [];
  player.abilityCostsPaidThisTurn.push({ source, amount });
  // Sochie Heim GD04-100: "[Once per Turn] When you pay (1) or more cost for one of your Units'
  // effects, you may increase this Unit's AP during this turn by an amount equal to the cost paid"
  // -- a live reactive broadcast, unlike the end-of-turn abilityCostsPaidThisTurn scan above (Turn A
  // Gundam GD04-069). Wired into this shared mutator so every existing/future payAbilityCost caller
  // is observable, per the forward-only scoping convention.
  // Willgem GD04-129: "when you pay (1) or more for a friendly Unit's effect, this Base recovers 2
  // HP" -- a Base-granted consumer of this same broadcast, so player.base is included alongside the
  // battleArea, matching the shape other broadcasts (placeExResource above, playCommand's
  // friendlyPlaysCommand) already use.
  for (const c of [...player.battleArea, player.base].filter(Boolean)) {
    // Same Unit-own-or-paired-Pilot fallback as playCommand's friendlyPlaysCommand broadcast in
    // actions.js (fixed this batch after discovering it there first) -- Sochie Heim's own ability
    // lives on her Pilot card, not on whatever Unit she ends up paired to.
    const handler =
      (c.def.effects && c.def.effects.friendlyPaysAbilityCost) ||
      (c.pilot && c.pilot.def.effects && c.pilot.def.effects.friendlyPaysAbilityCost);
    if (handler) handler(state, player, c, { source, amount });
  }
}

/**
 * Idempotent turn-scoped buff grant for "During Pair"/"During Link"/other continuously-live static
 * auras that are re-evaluated via a startOfTurn handler (e.g. Gundam ST01-001's "all your Units get
 * AP+1 while paired"). Those handlers now fire more than once in a real turn -- once from the actual
 * start phase, and again any time pairPilot/unpairPilot fires mid-turn (see actions.js's pairPilot),
 * so the source's real pairing status is reflected immediately instead of only from next turn's start
 * phase. A plain `buffs.push` would double up on the second firing; this instead removes whatever this
 * exact source previously granted before adding the new grant, so re-invoking within the same turn
 * replaces rather than stacks. `clearTurnBuffs` below still wipes it (and everything else `scope:
 * 'turn'`) at the real turn boundary regardless of source. Pass a falsy `buff` to just clear this
 * source's prior grant without adding a new one (the condition-false case).
 */
function grantTurnBuff(unit, sourceId, buff) {
  unit.buffs = unit.buffs.filter((b) => b.source !== sourceId);
  if (buff) unit.buffs.push({ ...buff, scope: 'turn', source: sourceId });
}

/** Clears "during this turn" and "during this battle" buffs (7-6-6-1 / 8-6-1). */
function clearTurnBuffs(player) {
  for (const instance of player.battleArea) {
    instance.buffs = instance.buffs.filter((b) => b.scope !== 'turn');
  }
  // Immortal Colasour GD03-120: player-level "during this turn" flag, cleared alongside every
  // other turn-scoped grant.
  player.onKillSetActiveTraits = undefined;
  // Gaia Gundam (LR+)/(MA Mode) GD05-034/041: player-level "during this turn" flag set by
  // forceEnemyDiscard (src/effects/registry.js), cleared the same way.
  player.enemyDiscardedByEffectThisTurn = undefined;
}

function clearBattleBuffs(player) {
  for (const instance of player.battleArea) {
    instance.buffs = instance.buffs.filter((b) => b.scope !== 'battle');
  }
  // White Wolf GD02-106: "During this battle, your shield area can't receive damage from enemy
  // Units that are Lv.3 or lower" -- a player-level (not Unit-level) battle-scoped condition, so it
  // can't live in a Unit's own buffs array; cleared here alongside every other battle-scope buff.
  player.shieldDamageImmuneLevelCap = undefined;
}

module.exports = {
  triggerEvent,
  fireCardEffect,
  applyRepairAtEndOfTurn,
  activateSupport,
  dealEffectDamage,
  reduceEnemyAP,
  placeExResource,
  clearTurnBuffs,
  clearBattleBuffs,
  setActiveByEffect,
  restEnemyByEffect,
  payAbilityCost,
  grantTurnBuff
};
