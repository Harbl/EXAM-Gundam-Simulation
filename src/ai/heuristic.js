const { canAfford, payCost } = require('../rules/cost');
const { deployUnit, deployBase, playCommand, pairPilot, pairPilotFromTrash, matchesLinkCondition } = require('../rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../rules/management');
const { resolveAttack } = require('../rules/combat');

/**
 * A simple heuristic bot for relative deck comparison, not tournament-strength play: mulligan
 * without an early play, curve out highest-cost-first, pair Pilots for the link bonus when one's
 * available, attack for face or a favorable/even trade, and block only to avoid lethal or a bad trade.
 */

function decideMulligan(hand) {
  return !hand.some((c) => c.def.type !== 'resource' && (c.def.cost || 0) <= 2);
}

function runDeploys(state, player) {
  for (;;) {
    const playable = player.hand
      .filter((c) => (c.def.type === 'unit' || c.def.type === 'base') && canAfford(player, c.def))
      .sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0));
    const choice = playable[0];
    if (!choice) return;

    payCost(player, choice.def);
    player.hand.splice(player.hand.indexOf(choice), 1);
    if (choice.def.type === 'unit') deployUnit(state, player, choice.def);
    else deployBase(state, player, choice.def);
  }
}

/** Plays every affordable Command in hand, earliest in the main phase so any cards it draws are available for this turn's deploys/pairings too. */
function runCommands(state, player) {
  for (;;) {
    const playable = player.hand.filter((c) => c.def.type === 'command' && canAfford(player, c.def));
    const choice = playable[0];
    if (!choice) return;

    payCost(player, choice.def);
    player.hand.splice(player.hand.indexOf(choice), 1);
    const trashed = playCommand(state, player, choice.def);

    // e.g. Cyclone Punch GD05-121: "you may pair this card from your trash with one of your (MF) Units."
    if (trashed.def.pairableFromTrash) {
      const target = player.battleArea.find(
        (u) => !u.pilot && !u.def.cannotBePaired && (u.def.traits || []).includes(trashed.def.pairableFromTrash)
      );
      if (target) pairPilotFromTrash(state, player, target, trashed);
    }
  }
}

function runPairings(state, player) {
  for (;;) {
    const pilots = player.hand.filter((c) => c.def.type === 'pilot' && canAfford(player, c.def));
    const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
    if (pilots.length === 0 || targets.length === 0) return;

    let pilot = pilots.find((p) => targets.some((u) => matchesLinkCondition(p.def, u.def.linkCondition)));
    let unit = pilot && targets.find((u) => matchesLinkCondition(pilot.def, u.def.linkCondition));
    if (!pilot) {
      pilot = pilots[0];
      unit = targets[0];
    }

    payCost(player, pilot.def);
    pairPilot(state, player, unit, pilot);
  }
}

/**
 * Uses every Activate-Main ability the player controls (Base or Unit) once per turn when it looks
 * worthwhile. Card-specific since there's no shared calling convention between abilities yet:
 * Jaburo/V-Dash Gundam trade a spare (weakest, still-active same-trait) Unit to rest a scarier
 * enemy Unit before attacks; Ra Cailum has no real downside, so it grants Reduce 1 to its biggest
 * threat whenever a friendly (Londo Bell) Unit is on the field.
 */
function runActivations(state, playerIdx) {
  const player = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];
  const activators = [player.base, ...player.battleArea].filter(
    (c) => c && !c.rested && c.def.effects && c.def.effects.activateMain
  );

  for (const source of activators) {
    if (source.def.number === 'GD04-122') {
      restEnemyByTrading(state, player, opponent, source, 'Earth Federation', (u) => (u.def.level || 0) <= 3);
    } else if (source.def.number === 'GD04-006') {
      restEnemyByTrading(state, player, opponent, source, 'League Militaire', (u) => getRemainingHP(u) <= 4);
    } else if (source.def.number === 'GD05-125') {
      const target = player.battleArea
        .filter((u) => (u.def.traits || []).includes('Londo Bell'))
        .sort((a, b) => getAP(b) - getAP(a))[0];
      if (target) source.def.effects.activateMain(state, player, source, { target });
    }
  }
}

/** Shared shape for "rest a same-trait friendly Unit as cost, rest a qualifying enemy Unit as the effect." */
function restEnemyByTrading(state, player, opponent, source, trait, enemyQualifies) {
  const restUnit = player.battleArea
    .filter((u) => u !== source && !u.rested && (u.def.traits || []).includes(trait))
    .sort((a, b) => getAP(a) - getAP(b))[0];
  if (!restUnit) return;
  const target = opponent.battleArea
    .filter((u) => !u.rested && enemyQualifies(u) && getAP(u) > getAP(restUnit))
    .sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  source.def.effects.activateMain(state, player, source, { restUnit, target });
}

/**
 * Prefers the scariest rested enemy Unit it can kill without dying itself; otherwise swings at the
 * player -- unless this Unit can't legally attack the player at all (e.g. Zoloat, [Parts] tokens),
 * in which case it only ever takes a favorable trade, or simply doesn't attack this turn.
 */
function chooseAttackTarget(opponent, attacker, unitOnly = false) {
  const attackerAP = getAP(attacker);
  // Wing Gundam ST02-001 (static) / Athrun Zala ST04-011 (When Linked buff): "may choose an active
  // enemy Unit that is Lv.X or lower as its attack target" -- normally only rested enemies are
  // legal targets, so this widens the candidate pool.
  let activeCap = attacker.def.activeTargetLevelCap;
  if (activeCap === undefined) {
    const capBuff = attacker.buffs.find((b) => b.activeTargetLevelCap !== undefined);
    if (capBuff) activeCap = capBuff.activeTargetLevelCap;
  }
  // GFreD GD03-035's When Linked grant: may target an active enemy Unit with AP <= this Unit's own.
  const activeAPCap = attacker.buffs.some((b) => b.activeTargetAPCap);
  // Kämpfer GD03-017's When Paired team grant: may target an active enemy Unit with AP <= a fixed threshold.
  const apThresholdBuff = attacker.buffs.find((b) => b.activeTargetAPThreshold !== undefined);
  const goodTrades = opponent.battleArea
    .filter(
      (u) =>
        (u.rested ||
          (activeCap !== undefined && (u.def.level || 0) <= activeCap) ||
          (activeAPCap && getAP(u) <= attackerAP) ||
          (apThresholdBuff && getAP(u) <= apThresholdBuff.activeTargetAPThreshold)) &&
        attackerAP >= getRemainingHP(u) &&
        getAP(u) < getRemainingHP(attacker)
    )
    .sort((a, b) => getAP(b) - getAP(a));
  if (goodTrades[0]) return { type: 'unit', instance: goodTrades[0] };
  if (unitOnly) return null;
  const cannotAttackPlayer = attacker.def.cannotAttackPlayer || attacker.buffs.some((b) => b.cannotAttackPlayer);
  return cannotAttackPlayer ? null : { type: 'player' };
}

function runAttacks(state, playerIdx, hooks) {
  const player = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];
  const attackers = player.battleArea.filter(
    (u) => u.def.type === 'unit' && !u.rested && !u.buffs.some((b) => b.cannotAttack)
      && (u.isLinkUnit || u.turnDeployed !== state.turnNumber || u.def.attackOnDeployRestedOnly
          || u.buffs.some((b) => b.canAttackOnDeployTurn))
  );

  for (const attacker of attackers) {
    if (state.winner !== null || attacker.rested) continue;
    // Gundam Deathscythe Hell (EW) GD05-078: normally a freshly-deployed non-Link Unit can't
    // attack this turn at all -- its own text carves out an exception, but only against a rested
    // enemy Unit, never the player directly. Justice Gundam GD01-066's token grant lifts the
    // restriction entirely instead (full normal attack, not unit-only).
    const bypassesDeployRestriction = attacker.isLinkUnit || attacker.buffs.some((b) => b.canAttackOnDeployTurn);
    const onDeployTurn = !bypassesDeployRestriction && attacker.turnDeployed === state.turnNumber;
    const target = chooseAttackTarget(opponent, attacker, onDeployTurn);
    if (target) resolveAttack(state, playerIdx, attacker, target, hooks);
  }
}

/** Blocks only when facing lethal (8-5-2-2: no Base and no Shields left) or a trade that loses the Unit for nothing in return. */
function chooseBlocker(defendingPlayer, attacker, target) {
  const blockers = defendingPlayer.battleArea.filter(
    (u) => !u.rested && getKeywords(u).blocker && !(target.type === 'unit' && target.instance === u)
  );
  if (blockers.length === 0) return null;

  const attackerAP = getAP(attacker);
  const facingLethal = target.type === 'player' && defendingPlayer.shields.length === 0 && !defendingPlayer.base;
  const badTrade =
    target.type === 'unit' &&
    getRemainingHP(target.instance) <= attackerAP &&
    getAP(target.instance) < attackerAP;

  if (!facingLethal && !badTrade) return null;
  return blockers.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
}

function chooseBurst(shieldInstance) {
  return !!(shieldInstance.def.effects && shieldInstance.def.effects.burst);
}

function defaultHooks() {
  return { chooseBlocker, chooseBurst };
}

function runMainPhase(state, playerIdx, hooks = defaultHooks()) {
  const player = state.players[playerIdx];
  runCommands(state, player);
  runDeploys(state, player);
  runPairings(state, player);
  runActivations(state, playerIdx);
  runAttacks(state, playerIdx, hooks);
}

module.exports = { decideMulligan, runMainPhase, runCommands, runActivations, runAttacks, chooseAttackTarget, defaultHooks };
