const {
  getAP,
  getRemainingHP,
  getKeywords,
  dealDamage,
  destroyIfDead,
  destroyTopShield,
  checkDefeat
} = require('./management');
const { fireCardEffect, clearBattleBuffs } = require('./effects');
const { isCardTracked } = require('./state');
const { drawCard } = require('./phases');

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
  fireCardEffect(state, attackingPlayer, attacker, 'attack', { target });

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

/** Destroys a card if its HP has hit 0, firing its own Destroyed effect (13-2-8) if so. */
function destroyAndFireEffect(state, player, instance) {
  const wasPaired = !!instance.pilot;
  const destroyed = destroyIfDead(state, player, instance);
  if (destroyed) fireCardEffect(state, player, instance, 'destroyed', { wasPaired });
  return destroyed;
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
      dealDamage(defendingPlayer.base, attackerAP, { isBattleDamage: true });
      const destroyed = destroyAndFireEffect(state, defendingPlayer, defendingPlayer.base);
      if (destroyed && keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks);
      return;
    }
    // Shield(s) -- <Suppression> (13-1-7) hits the first two simultaneously.
    const hitCount = keywords.suppression ? Math.min(2, defendingPlayer.shields.length) : 1;
    const destroyedShields = [];
    for (let i = 0; i < hitCount; i++) destroyedShields.push(destroyTopShield(defendingPlayer));
    for (const shield of destroyedShields) resolveBurst(state, defendingPlayer, shield, hooks);
    if (destroyedShields.length > 0) fireCardEffect(state, attackingPlayer, attacker, 'destroysShield', {});
    return;
  }

  // target.type === 'unit'
  resolveUnitBattleDamage(state, attackingPlayer, defendingPlayer, attacker, target.instance, hooks);
}

/**
 * The 8-5-3 Unit-vs-Unit damage exchange (First Strike pre-empting return damage, Breach on a
 * defender kill). Factored out so effects like Nu Gundam GD05-017's "begin a battle ... only
 * perform the damage step" can reuse the same rules instead of re-declaring an attack.
 */
/**
 * Chang Wufei GD01-091's "during your turn, while this Unit has Breach, it can't receive battle
 * damage from enemy Units with 3 or less AP" -- a Pilot-side static condition on return damage,
 * checked only for the attacker side since that's the only battle-damage a Unit can take on its
 * controller's own turn.
 */
function isImmuneToLowAPReturnDamage(attacker, incomingAP) {
  const cap = attacker.pilot && attacker.pilot.def.breachDamageImmuneAPCap;
  if (cap === undefined || !getKeywords(attacker).breach) return false;
  return incomingAP <= cap;
}

function resolveUnitBattleDamage(state, attackingPlayer, defendingPlayer, attacker, defender, hooks) {
  const attackerAP = getAP(attacker);
  const defenderAP = getAP(defender);
  const keywords = getKeywords(attacker);

  if (keywords.firstStrike) {
    dealDamage(defender, attackerAP, { isBattleDamage: true });
    fireCardEffect(state, attackingPlayer, attacker, 'dealsBattleDamage', { defender });
    const defenderDied = destroyAndFireEffect(state, defendingPlayer, defender);
    if (defenderDied) {
      if (keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks);
      fireDestroysEnemy(state, attackingPlayer, attacker);
      return; // 13-1-5-2: a Unit destroyed by First Strike deals no return damage.
    }
    if (!isImmuneToLowAPReturnDamage(attacker, defenderAP)) {
      dealDamage(attacker, defenderAP, { isBattleDamage: true });
    }
    destroyAndFireEffect(state, attackingPlayer, attacker);
    return;
  }

  // Simultaneous mutual damage (8-5-3-2).
  dealDamage(defender, attackerAP, { isBattleDamage: true });
  fireCardEffect(state, attackingPlayer, attacker, 'dealsBattleDamage', { defender });
  if (!isImmuneToLowAPReturnDamage(attacker, defenderAP)) {
    dealDamage(attacker, defenderAP, { isBattleDamage: true });
  }
  const defenderDied = destroyAndFireEffect(state, defendingPlayer, defender);
  destroyAndFireEffect(state, attackingPlayer, attacker);
  if (defenderDied) {
    if (keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks);
    fireDestroysEnemy(state, attackingPlayer, attacker);
  }
}

/**
 * Fires a "this Unit destroys an enemy Unit with battle damage" trigger (e.g. Amuro Ray GD05-085),
 * skipped if the attacker didn't survive to receive it. Also resolves any temporary "draw on kill"
 * grant (e.g. Strike Freedom GD05-002's Deploy) and "rest an enemy on kill" grant (e.g. Penelope
 * (Flight Form) GD04-002's Deploy), since those aren't tied to any one card's own text.
 */
function fireDestroysEnemy(state, attackingPlayer, attacker) {
  if (!attackingPlayer.battleArea.includes(attacker)) return;
  fireCardEffect(state, attackingPlayer, attacker, 'destroysEnemy', {});
  const onKillDraw = attacker.buffs.reduce((sum, b) => sum + (b.onKillDraw || 0), 0);
  for (let i = 0; i < onKillDraw; i++) drawCard(state, attackingPlayer);
  const attackerTraits = attacker.def.traits || [];
  const hasTeamOnKillRestEnemy = attackingPlayer.battleArea.some((u) =>
    u.buffs.some((b) => b.teamOnKillRestEnemy && attackerTraits.includes(b.teamOnKillRestEnemy))
  );
  if (hasTeamOnKillRestEnemy) {
    const opponent = state.players.find((p) => p !== attackingPlayer);
    const target = opponent.battleArea
      .filter((u) => getRemainingHP(u) <= 5)
      .sort((a, b) => getAP(b) - getAP(a))[0];
    if (target) target.rested = true;
  }
  // Broadcast to the attacking player's own field (e.g. Peacemillion GD03-125's Base ability),
  // distinct from the attacker's own "destroysEnemy" text fired just above.
  for (const c of [...attackingPlayer.battleArea, attackingPlayer.base].filter(Boolean)) {
    const handler = c.def.effects && c.def.effects.friendlyUnitDestroysEnemy;
    if (handler) handler(state, attackingPlayer, c, { attacker });
  }
}

/** <Breach(amount)> (13-1-2): damages the enemy Base, or top Shield if there's no Base. */
function applyBreach(state, defendingPlayer, amount, hooks) {
  if (defendingPlayer.base) {
    dealDamage(defendingPlayer.base, amount, { isBattleDamage: true });
    destroyAndFireEffect(state, defendingPlayer, defendingPlayer.base);
  } else if (defendingPlayer.shields.length > 0) {
    const shield = destroyTopShield(defendingPlayer);
    resolveBurst(state, defendingPlayer, shield, hooks);
  }
}

/**
 * Reveals a destroyed Shield and, if it has a Burst effect, lets its owner choose to activate it
 * (5-10-3, 13-2-5). The effect fully controls the card's fate (e.g. "add this card to your hand");
 * it only falls through to the trash by default if nothing relocated it.
 */
function resolveBurst(state, defendingPlayer, shieldInstance, hooks) {
  const burstEffect = shieldInstance.def.effects && shieldInstance.def.effects.burst;
  const activate = burstEffect && hooks && hooks.chooseBurst ? hooks.chooseBurst(shieldInstance) : false;
  if (activate) burstEffect(state, defendingPlayer, shieldInstance);
  if (!isCardTracked(defendingPlayer, shieldInstance)) {
    defendingPlayer.trash.push(shieldInstance);
  }
}

module.exports = { resolveAttack, resolveUnitBattleDamage, applyBreach };
