const { canAfford, payCost } = require('../rules/cost');
const { deployUnit, deployBase, pairPilot, matchesLinkCondition } = require('../rules/actions');
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

/** Prefers a rested enemy Unit it kills without dying itself; otherwise swings at the player. */
function chooseAttackTarget(opponent, attacker) {
  const attackerAP = getAP(attacker);
  const goodTrade = opponent.battleArea.find(
    (u) => u.rested && attackerAP >= getRemainingHP(u) && getAP(u) < getRemainingHP(attacker)
  );
  return goodTrade ? { type: 'unit', instance: goodTrade } : { type: 'player' };
}

function runAttacks(state, playerIdx, hooks) {
  const player = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];
  const attackers = player.battleArea.filter(
    (u) => u.def.type === 'unit' && !u.rested && (u.isLinkUnit || u.turnDeployed !== state.turnNumber)
  );

  for (const attacker of attackers) {
    if (state.winner !== null || attacker.rested) continue;
    resolveAttack(state, playerIdx, attacker, chooseAttackTarget(opponent, attacker), hooks);
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
  runDeploys(state, player);
  runPairings(state, player);
  runAttacks(state, playerIdx, hooks);
}

module.exports = { decideMulligan, runMainPhase, defaultHooks };
