const {
  getAP,
  getKeywords,
  dealDamage,
  destroyIfDead,
  destroyTopShield,
  checkDefeat
} = require('./management');
const { triggerEvent, clearBattleBuffs } = require('./effects');

/**
 * Resolves one full attack (8-1 through 8-6): attack, block, action, damage, battle-end steps.
 * `declaredTarget` is {type:'player'} or {type:'unit', instance}.
 * `hooks` (all optional): chooseBlocker(defendingPlayer, attacker, target) => blockerInstance|null,
 * actionStep(state, {attacker, target}), chooseBurst(shieldInstance) => boolean.
 */
function resolveAttack(state, attackerPlayerIdx, attacker, declaredTarget, hooks = {}) {
  const attackingPlayer = state.players[attackerPlayerIdx];
  const defendingPlayer = state.players[1 - attackerPlayerIdx];

  // --- Attack step (8-2) ---
  attacker.rested = true;
  let target = declaredTarget;
  triggerEvent(state, 'attack', { attacker, target });

  const attackerStillIn = () => attackingPlayer.battleArea.includes(attacker);
  const targetStillIn = () =>
    target.type === 'player' || defendingPlayer.battleArea.includes(target.instance);

  // --- Block step (8-3) ---
  if (attackerStillIn() && targetStillIn()) {
    const attackerKeywords = getKeywords(attacker);
    if (!attackerKeywords.highManeuver && hooks.chooseBlocker) {
      const blocker = hooks.chooseBlocker(defendingPlayer, attacker, target);
      if (blocker) {
        if (blocker.rested) throw new Error('Blocker must be active (13-1-4)');
        if (target.type === 'unit' && target.instance === blocker) {
          throw new Error("The original attack target can't activate its own Blocker (8-3-3)");
        }
        blocker.rested = true;
        target = { type: 'unit', instance: blocker };
      }
    }
  }

  // --- Action step (8-4) ---
  if (attackerStillIn() && targetStillIn() && hooks.actionStep) {
    hooks.actionStep(state, { attacker, target });
  }

  // --- Damage step (8-5) ---
  if (attackerStillIn() && targetStillIn()) {
    resolveDamageStep(state, attackingPlayer, defendingPlayer, attacker, target, hooks);
  }

  // --- Battle end step (8-6) ---
  clearBattleBuffs(attackingPlayer);
  clearBattleBuffs(defendingPlayer);
  checkDefeat(state);
}

function resolveDamageStep(state, attackingPlayer, defendingPlayer, attacker, target, hooks) {
  const attackerAP = getAP(attacker);
  const keywords = getKeywords(attacker);

  if (target.type === 'player') {
    if (!defendingPlayer.base && defendingPlayer.shields.length === 0) {
      defendingPlayer.defeated = true;
      checkDefeat(state);
      return;
    }
    if (defendingPlayer.base) {
      dealDamage(defendingPlayer.base, attackerAP);
      const destroyed = destroyIfDead(state, defendingPlayer, defendingPlayer.base);
      if (destroyed && keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks);
      return;
    }
    // Shield(s) -- <Suppression> (13-1-7) hits the first two simultaneously.
    const hitCount = keywords.suppression ? Math.min(2, defendingPlayer.shields.length) : 1;
    const destroyedShields = [];
    for (let i = 0; i < hitCount; i++) destroyedShields.push(destroyTopShield(defendingPlayer));
    for (const shield of destroyedShields) resolveBurst(state, defendingPlayer, shield, hooks);
    return;
  }

  // target.type === 'unit'
  const defender = target.instance;
  const defenderAP = getAP(defender);

  if (keywords.firstStrike) {
    dealDamage(defender, attackerAP);
    const defenderDied = destroyIfDead(state, defendingPlayer, defender);
    if (defenderDied) {
      if (keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks);
      return; // 13-1-5-2: a Unit destroyed by First Strike deals no return damage.
    }
    dealDamage(attacker, defenderAP);
    destroyIfDead(state, attackingPlayer, attacker);
    return;
  }

  // Simultaneous mutual damage (8-5-3-2).
  dealDamage(defender, attackerAP);
  dealDamage(attacker, defenderAP);
  const defenderDied = destroyIfDead(state, defendingPlayer, defender);
  destroyIfDead(state, attackingPlayer, attacker);
  if (defenderDied && keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks);
}

/** <Breach(amount)> (13-1-2): damages the enemy Base, or top Shield if there's no Base. */
function applyBreach(state, defendingPlayer, amount, hooks) {
  if (defendingPlayer.base) {
    dealDamage(defendingPlayer.base, amount);
    destroyIfDead(state, defendingPlayer, defendingPlayer.base);
  } else if (defendingPlayer.shields.length > 0) {
    const shield = destroyTopShield(defendingPlayer);
    resolveBurst(state, defendingPlayer, shield, hooks);
  }
}

/** Reveals a destroyed Shield and, if it has a Burst effect, lets its owner choose to activate it (5-10-3, 13-2-5). */
function resolveBurst(state, defendingPlayer, shieldInstance, hooks) {
  const burstEffect = shieldInstance.def.effects && shieldInstance.def.effects.burst;
  if (!burstEffect) return;
  const activate = hooks && hooks.chooseBurst ? hooks.chooseBurst(shieldInstance) : false;
  if (activate) burstEffect(state, defendingPlayer, shieldInstance);
}

module.exports = { resolveAttack };
