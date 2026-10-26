const {
  getAP,
  getHP,
  getRemainingHP,
  getKeywords,
  dealDamage,
  destroyIfDead,
  destroyCard,
  destroyTopShield,
  checkDefeat
} = require('./management');
const { fireCardEffect, clearBattleBuffs, setActiveByEffect } = require('./effects');
const { isCardTracked } = require('./state');
const { drawCard } = require('./phases');

/**
 * Resolves one full attack (8-1 through 8-6): attack, block, action, damage, battle-end steps.
 * `declaredTarget` is {type:'player'} or {type:'unit', instance}.
 * `hooks` (all optional): chooseBlocker(defendingPlayer, attacker, target) => blockerInstance|null,
 * actionStep(state, {attacker, target, battleTarget}) -- battleTarget is `target` itself, mutable in
 * place for a redirect-style reactive Command to retarget this battle -- chooseBurst(shieldInstance,
 * state) => boolean.
 */
/**
 * The attack step (8-2) alone: rests the attacker and fires the 'attack'/'allyAttack' triggers.
 * Split out from resolveAttack so a caller that needs to run its own block/action-step negotiation
 * before handing off to resolveFromBlockDecision (e.g. an interactive turn driver awaiting a real
 * player's blocker choice) can still fire these triggers exactly once, via the same code path
 * resolveAttack itself uses -- not a reimplementation.
 */
function fireAttackTriggers(state, attackingPlayer, attacker, target) {
  attacker.rested = true;
  // A Miracle GD06-102: "If it is your opponent's turn and no enemy Units have attacked this turn"
  // -- a persistent per-turn flag, the attack-step equivalent of player.drewWithEffectThisTurn.
  // Cleared each start phase (phases.js's runStartPhase).
  attackingPlayer.attackedThisTurn = true;
  fireCardEffect(state, attackingPlayer, attacker, 'attack', { target });
  // The-O (LR+) GD03-002: "[During Pair] When one of your other Units with <Repair> attacks..." --
  // the only card so far reacting to an ally's attack rather than its own, so broadcast a new
  // 'allyAttack' event to every other friendly instance (mirrors triggerEvent's pilot-forwarding).
  for (const ally of attackingPlayer.battleArea) {
    if (ally === attacker) continue;
    fireCardEffect(state, attackingPlayer, ally, 'allyAttack', { attacker, target });
  }
  // Gundam GP01Fb GD06-001: "[Once per Turn] When this Unit is attacked, draw 1." -- the first card
  // needing a defender-side "this Unit was declared as an attack's target" reaction, fired here (the
  // declare-attack step, before block) rather than at the damage step, since the card text triggers
  // off being targeted, not off actually taking damage.
  if (target.type === 'unit') {
    const defendingPlayer = state.players.find((p) => p !== attackingPlayer);
    fireCardEffect(state, defendingPlayer, target.instance, 'attacked', { attacker });
  }
}

function resolveAttack(state, attackerPlayerIdx, attacker, declaredTarget, hooks = {}) {
  const attackingPlayer = state.players[attackerPlayerIdx];
  const defendingPlayer = state.players[1 - attackerPlayerIdx];

  // --- Attack step (8-2) ---
  let target = declaredTarget;
  fireAttackTriggers(state, attackingPlayer, attacker, target);

  const attackerStillIn = () => attackingPlayer.battleArea.includes(attacker);
  const targetStillIn = () =>
    target.type === 'player' || defendingPlayer.battleArea.includes(target.instance);

  // --- Block step (8-3) ---
  let chosenBlocker = null;
  if (attackerStillIn() && targetStillIn()) {
    const attackerKeywords = getKeywords(attacker);
    if (!attackerKeywords.highManeuver && hooks.chooseBlocker) {
      chosenBlocker = hooks.chooseBlocker(defendingPlayer, attacker, target, attackingPlayer);
    }
  }

  resolveFromBlockDecision(state, attackerPlayerIdx, attacker, target, chosenBlocker, hooks);
}

/**
 * The action/damage/battle-end steps (8-4 through 8-6), given a block decision that's already been
 * made. Split out from resolveAttack so AI lookahead can simulate "what if I picked blocker X" (or
 * no block) on a clone without re-running the attack step above -- re-invoking resolveAttack itself
 * on a clone would double-fire 'attack'/'allyAttack' triggers, which is a real correctness bug for
 * any card that reacts to its own attack (e.g. "[Attack] deal 1 damage" would deal 2 in the trial).
 */
/**
 * Applies an already-decided block (13-1-4/8-3-3): rests the blocker, redirects `declaredTarget` to
 * it, and flags the attacker as blocked-this-battle. Split out of resolveFromBlockDecision so a caller
 * that needs to know the real post-block target *before* running its own action-step negotiation (the
 * interactive turn driver -- action step 8-4 happens after block step 8-3, so Command/ability context
 * like "the Unit under attack" must already reflect the block) can apply it once, directly, then hand
 * the resulting target to resolveFromBlockDecision as `declaredTarget` with `chosenBlocker: null` so it
 * isn't reapplied.
 */
function applyBlockDecision(state, defendingPlayer, attacker, declaredTarget, chosenBlocker) {
  if (chosenBlocker.rested) throw new Error('Blocker must be active (13-1-4)');
  if (declaredTarget.type === 'unit' && declaredTarget.instance === chosenBlocker) {
    throw new Error("The original attack target can't activate its own Blocker (8-3-3)");
  }
  chosenBlocker.rested = true;
  // Harry Ord GD06-097: "[Once per Turn] When this Unit activates <Blocker>, set it as active" --
  // the first card reacting to this specific moment, so it's a new chokepoint.
  fireCardEffect(state, defendingPlayer, chosenBlocker, 'activatesBlocker', {});
  attacker.buffs.push({ wasBlockedThisBattle: true, scope: 'battle' });
  return { type: 'unit', instance: chosenBlocker };
}

function resolveFromBlockDecision(state, attackerPlayerIdx, attacker, declaredTarget, chosenBlocker, hooks = {}) {
  const attackingPlayer = state.players[attackerPlayerIdx];
  const defendingPlayer = state.players[1 - attackerPlayerIdx];
  let target = declaredTarget;

  const attackerStillIn = () => attackingPlayer.battleArea.includes(attacker);
  const targetStillIn = () =>
    target.type === 'player' || defendingPlayer.battleArea.includes(target.instance);

  if (attackerStillIn() && targetStillIn() && chosenBlocker) {
    target = applyBlockDecision(state, defendingPlayer, attacker, target, chosenBlocker);
  }

  // --- Action step (8-4) ---
  // `target` is passed as `battleTarget` too (same object, not a copy) so a redirect-style command
  // (e.g. Master League Begins EB01-077) can retarget this battle in place by mutating its
  // type/instance fields -- everything downstream (targetStillIn, resolveDamageStep) reads `target`
  // by reference, so the mutation takes effect immediately without reassigning this local variable.
  if (attackerStillIn() && targetStillIn() && hooks.actionStep) {
    hooks.actionStep(state, { attacker, target, battleTarget: target });
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

/**
 * Destroys a card if its HP has hit 0, firing its own Destroyed effect (13-2-8) if so. Captures
 * the paired Pilot before destruction (destroyCard nulls `instance.pilot` and trashes it) so a
 * handler that redirects the Pilot elsewhere -- e.g. Unicorn Gundam GD01-005's "return this Unit's
 * paired Pilot to hand" -- still has a reference to it.
 */
function destroyAndFireEffect(state, player, instance, extraContext = {}) {
  const pilot = instance.pilot;
  const destroyed = destroyIfDead(state, player, instance);
  if (destroyed) {
    fireCardEffect(state, player, instance, 'destroyed', { wasPaired: !!pilot, pilot, ...extraContext });
    // Garma Zabi GD04-086: a paired Pilot's own [Destroyed] ability can't fire through
    // fireCardEffect's usual instance.pilot forwarding, since destroyCard (called by destroyIfDead
    // above) already nulls instance.pilot before this point -- captured as `pilot` above for
    // exactly this reason, so fire it explicitly here instead.
    if (pilot) {
      const pilotHandler = pilot.def.effects && pilot.def.effects.destroyed;
      if (pilotHandler) pilotHandler(state, player, instance, { wasPaired: true, pilot, ...extraContext });
    }
  }
  return destroyed;
}

/**
 * Sibling of destroyAndFireEffect for an outright destroy that isn't conditioned on HP (e.g.
 * Widespread Annihilation GD05-114 "destroy all Lv.4 or lower Units", Gundam Flauros (Ryusei-Go)
 * GD05-060's targeted destroy) -- same pilot-capture-before-nulling + explicit pilot-handler-firing
 * shape as destroyAndFireEffect, just always destroying rather than checking getRemainingHP first.
 */
function destroyOutrightAndFireEffect(state, player, instance, extraContext = {}) {
  const pilot = instance.pilot;
  destroyCard(state, player, instance);
  fireCardEffect(state, player, instance, 'destroyed', { wasPaired: !!pilot, pilot, ...extraContext });
  if (pilot) {
    const pilotHandler = pilot.def.effects && pilot.def.effects.destroyed;
    if (pilotHandler) pilotHandler(state, player, instance, { wasPaired: true, pilot, ...extraContext });
  }
}

/**
 * Ptolemaios ST07-015's "while a rested friendly (CB) Unit is in play, this Base can't receive
 * damage from enemy Units that are Lv.3 or lower, other than Unit tokens" (a static field on the
 * Base's own card data, mirroring the attacker-side immunity helpers below). A Baoa Qu GD04-123
 * has the same shape but for a rested (Zeon) Unit instead, with no Unit-token exclusion in its
 * text -- so the trait and the token exclusion are both read from the Base's own def rather than
 * hardcoded, defaulting to Ptolemaios's original CB/exclude-tokens values.
 */
function isBaseImmuneToLowLevelDamage(defendingPlayer, attacker) {
  const base = defendingPlayer.base;
  if (!base) return false;
  // Duo Maxwell GD06-098: "[During Link] While this Unit is rested, friendly Bases can't receive
  // damage from enemy Units whose Lv. is equal to or lower than this Unit" -- a Pilot-granted
  // immunity keyed off that specific Unit's own live Lv. (not a fixed cap like the Base-data shape
  // below), so it's checked as its own independent branch rather than folded into lowLevelDamageImmuneCap.
  const linkGuard = defendingPlayer.battleArea.find(
    (u) => u.isLinkUnit && u.rested && u.pilot && u.pilot.def.duringLinkBaseDamageImmuneIfRestedSelf
  );
  if (linkGuard && (attacker.def.level || 0) <= (linkGuard.def.level || 0)) return true;
  const cap = base.def.lowLevelDamageImmuneCap;
  if (cap === undefined) return false;
  if (attacker.def.isToken && !base.def.lowLevelDamageImmuneIncludesTokens) return false;
  if ((attacker.def.level || 0) > cap) return false;
  const trait = base.def.lowLevelDamageImmuneTrait || 'CB';
  return defendingPlayer.battleArea.some((u) => u.rested && (u.def.traits || []).includes(trait));
}

/**
 * Fires a "this Unit destroys an enemy shield area card with damage" trigger on the attacker
 * itself, then broadcasts it team-wide (e.g. Psycho Gundam GD02-001's "During Pair: (Cyber-
 * Newtype) Pilot, when one of your (Titans) Units destroys an enemy shield area card with damage,
 * this Unit recovers 2 HP" -- reacts to ANY friendly Unit's shield kill, not just its own).
 */
function fireDestroysShield(state, attackingPlayer, attacker) {
  fireCardEffect(state, attackingPlayer, attacker, 'destroysShield', {});
  for (const c of [...attackingPlayer.battleArea, attackingPlayer.base].filter(Boolean)) {
    const handler = c.def.effects && c.def.effects.friendlyUnitDestroysShield;
    if (handler) handler(state, attackingPlayer, c, { attacker });
  }
}

/**
 * Predicts which Shield(s), if any, an attack on the player would hit right now -- without mutating
 * state -- by mirroring resolveDamageStep's own player-target branch below exactly (Base-first, then
 * the same three immunity checks, then <Suppression>'s hit count). Lets a caller (the interactive turn
 * driver) ask a real chooseBurst question *before* resolveFromBlockDecision actually destroys the
 * Shield(s) a moment later, since resolveBurst's hook is called synchronously deep inside that call and
 * can't itself be awaited without threading async through the whole combat module. Safe as long as
 * nothing mutates the Base/battleArea/shields between this call and the resolveFromBlockDecision call
 * that follows it -- true for the turn driver, which calls this only after block + the action step are
 * already finished.
 */
function predictShieldHits(defendingPlayer, attacker) {
  if (defendingPlayer.base) return [];
  if (
    defendingPlayer.shieldDamageImmuneLevelCap !== undefined &&
    (attacker.def.level || 0) <= defendingPlayer.shieldDamageImmuneLevelCap
  ) {
    return [];
  }
  // Presence Detected GD06-106: "During this battle, your shield area cards can't receive damage
  // from enemy Units with 6 or less AP" -- same battle-scoped player-level shape as
  // shieldDamageImmuneLevelCap above, just keyed on AP instead of Lv.
  if (
    defendingPlayer.shieldDamageImmuneAPCap !== undefined &&
    getAP(attacker) <= defendingPlayer.shieldDamageImmuneAPCap
  ) {
    return [];
  }
  if (defendingPlayer.battleArea.some((u) => u.rested && u.def.shieldDamageImmuneWhileRested)) return [];
  const hitCount = getKeywords(attacker).suppression ? Math.min(2, defendingPlayer.shields.length) : Math.min(1, defendingPlayer.shields.length);
  return defendingPlayer.shields.slice(0, hitCount);
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
      if (!isBaseImmuneToLowLevelDamage(defendingPlayer, attacker)) {
        dealDamage(defendingPlayer.base, attackerAP, { isBattleDamage: true });
        // Izuma Colony GD04-126: "When this Base receives battle damage from an enemy Unit with 3
        // or less AP, deal 1 damage to that Unit" -- no prior Base had a reaction to receiving its
        // own battle damage, so this is a new chokepoint, gated the same way the damage itself was
        // (skipped if the Base was immune and thus never actually hit).
        fireCardEffect(state, defendingPlayer, defendingPlayer.base, 'receivesBattleDamageFromEnemy', { attacker, attackerAP });
      }
      const destroyed = destroyAndFireEffect(state, defendingPlayer, defendingPlayer.base, { viaBattleDamage: true });
      if (destroyed && keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks, attacker);
      return;
    }
    // White Wolf GD02-106: "your shield area can't receive damage from enemy Units that are Lv.3
    // or lower" for the rest of this battle.
    if (
      defendingPlayer.shieldDamageImmuneLevelCap !== undefined &&
      (attacker.def.level || 0) <= defendingPlayer.shieldDamageImmuneLevelCap
    ) {
      return;
    }
    // Presence Detected GD06-106: see predictShieldHits above.
    if (
      defendingPlayer.shieldDamageImmuneAPCap !== undefined &&
      attackerAP <= defendingPlayer.shieldDamageImmuneAPCap
    ) {
      return;
    }
    // Freedom Gundam GD03-070: "While this Unit is rested, friendly Shields can't receive battle
    // damage from enemy Units" -- a static per-card condition, same inline board-state shape as
    // isBaseImmuneToLowLevelDamage above but gated on the source Unit being rested, not the attacker.
    if (defendingPlayer.battleArea.some((u) => u.rested && u.def.shieldDamageImmuneWhileRested)) {
      return;
    }
    // Shield(s) -- <Suppression> (13-1-7) hits the first two simultaneously.
    const hitCount = keywords.suppression ? Math.min(2, defendingPlayer.shields.length) : 1;
    const destroyedShields = [];
    for (let i = 0; i < hitCount; i++) destroyedShields.push(destroyTopShield(defendingPlayer));
    // 13-1-7-4: when both hit Shields have Burst effects, the defender (their owner) chooses
    // the resolution order -- defaults to the fixed top-then-next order if no hook is given.
    const burstOrder =
      destroyedShields.length > 1 && hooks && hooks.chooseBurstOrder
        ? hooks.chooseBurstOrder(destroyedShields)
        : destroyedShields;
    for (const shield of burstOrder) resolveBurst(state, defendingPlayer, shield, hooks);
    if (destroyedShields.length > 0) fireDestroysShield(state, attackingPlayer, attacker);
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

/**
 * Tokwan GD04-088's "when this Unit is blocked by an enemy Unit that is Lv.4 or lower, it can't
 * receive battle damage during this battle" -- a Pilot-side static field mirroring
 * breachDamageImmuneAPCap above, gated on the wasBlockedThisBattle flag the Block step sets.
 */
function isImmuneToBlockerReturnDamage(attacker, blockerLevel) {
  const cap = attacker.pilot && attacker.pilot.def.blockedByLowLevelImmuneCap;
  if (cap === undefined) return false;
  return attacker.buffs.some((b) => b.wasBlockedThisBattle) && blockerLevel <= cap;
}

/**
 * Forbidden Gundam GD02-006: "[Blocker] During your turn, this Unit can't receive battle damage
 * from enemy Units that are Lv.2 or lower" -- a Unit-side static cap (unlike the two Pilot-side
 * helpers above), unconditional on Breach/being-blocked, checked against whichever enemy Unit it's
 * exchanging return damage with while it's the one attacking.
 */
function isImmuneToLowLevelReturnDamage(attacker, defenderLevel) {
  const cap = attacker.def.lowLevelReturnDamageImmuneCap;
  if (cap === undefined) return false;
  return defenderLevel <= cap;
}

/**
 * Zudah Unit 1 EB01-037: "During your turn, while this Unit is battling an enemy Unit with
 * <Blocker>, this Unit can't receive battle damage" -- unconditional (no level cap), reusing the
 * wasBlockedThisBattle flag the Block step already sets, same signal as
 * isImmuneToBlockerReturnDamage above but as a plain Unit-side field, not Pilot-gated/level-capped.
 * "During your turn" collapses to a flat grant (a Unit only ever attacks on its own controller's
 * turn), same reasoning as Carta's Graze Ritter's attackerGainsFirstStrike above.
 */
function isImmuneWhileBattlingBlocker(attacker) {
  return !!attacker.def.immuneToBattleDamageWhileBattlingBlocker && attacker.buffs.some((b) => b.wasBlockedThisBattle);
}

/**
 * Tallgeese II EB01-025: "[During Pair] While your opponent has an EX Resource, this Unit can't
 * receive battle damage from enemy Units that are Lv.5 or lower" -- a Pilot-gated (During Pair),
 * board-state-conditional defender-side immunity, mirroring isImmuneToLowLevelReturnDamage's cap
 * shape but checked against the incoming attacker's level and the defender's own paired/opponent
 * state instead.
 */
function isImmuneToLowLevelEnemyDamageWhilePaired(defender, defendingPlayer, attackingPlayer, attackerLevel) {
  const cap = defender.def.duringPairLowLevelEnemyDamageImmuneCapIfOpponentEX;
  if (cap === undefined || !defender.pilot) return false;
  if (!attackingPlayer.resourceArea.some((r) => r.def.isToken)) return false;
  return attackerLevel <= cap;
}

/**
 * Gundam Ashtaron (R+) GD02-040 Deploy: "Choose 1 of your other (New UNE) Units. It can't receive
 * battle damage from enemy Units with 2 or less HP during this turn" -- unlike the three
 * attacker-only helpers above, the source text doesn't restrict which role the protected Unit is
 * playing, so this is checked on both sides of resolveUnitBattleDamage below.
 */
function isImmuneToLowHPEnemyDamage(instance, enemyHP) {
  const cap = instance.buffs.reduce((max, b) => Math.max(max, b.lowHPEnemyDamageImmuneCap ?? -1), -1);
  return cap >= 0 && enemyHP <= cap;
}

/**
 * Zaku II FZ (R+) GD03-020: "While you have a Unit with 'Ad Balloon' in its card name in play,
 * this Unit can't receive enemy battle damage" -- unconditional (unlike the HP/level/AP-gated
 * helpers above), checked against whichever player controls the instance.
 */
function isImmuneViaNamedToken(player, instance) {
  const frag = instance.def.immuneWhileUnitNameInPlay;
  return !!frag && player.battleArea.some((u) => (u.def.name || '').includes(frag));
}

/**
 * Yurin L'Ciel GD03-115: "Choose 1 friendly Unit paired with an (X-Rounder) Pilot. It can't receive
 * battle damage from enemy Units with 2 or less AP during this battle" -- an AP-capped sibling of
 * isImmuneToLowHPEnemyDamage above, same buff-array shape (lowAPEnemyDamageImmuneCap), checked on
 * both sides of resolveUnitBattleDamage since the source text doesn't restrict which role applies.
 */
function isImmuneToLowAPEnemyDamage(instance, enemyAP) {
  const cap = instance.buffs.reduce((max, b) => Math.max(max, b.lowAPEnemyDamageImmuneCap ?? -1), -1);
  return cap >= 0 && enemyAP <= cap;
}

/**
 * Full Armor Unicorn Gundam (Destroy Mode) ST14-006: "[During Pair][Once per Turn] When this Unit
 * would receive battle damage from an enemy Unit with AP equal to or less than it, it doesn't
 * receive that damage." Unlike the buff-based cap above, the cap here is this Unit's own current AP
 * (live-computed, not fixed), and it's stateful -- consumes a once-per-turn flag on success -- so it's
 * checked and consumed together rather than as a pure predicate. Checked at the same 4 call sites as
 * isImmuneToLowAPEnemyDamage above, since the source text doesn't restrict which role applies either.
 */
function isImmuneToLowAPEnemyDamageOncePerTurnWhilePaired(instance, enemyAP) {
  if (!instance.def.lowAPEnemyDamageImmuneOncePerTurnWhilePaired) return false;
  if (!instance.pilot || instance.activationsUsed.lowAPDamageImmune) return false;
  if (enemyAP > getAP(instance)) return false;
  instance.activationsUsed.lowAPDamageImmune = true;
  return true;
}

/**
 * ZZ Gundam GD06-033: "When your (AEUG) cards deal damage to enemy Units, increase the damage
 * dealt by 1." A team-wide damage amplifier read from a static aura flag on any friendly card
 * (mirrors the teamRepairAura shape in effects.js), applied here for the battle-damage path and in
 * effects.js's dealEffectDamage for the effect-damage path -- the two chokepoints all damage to an
 * enemy Unit already funnels through. `sourceTraits` is the actual dealing card's own traits (the
 * attacker in combat, or state.resolvingSource in dealEffectDamage), not the aura holder's.
 */
function teamDamageAmpAgainstUnits(player, sourceTraits) {
  const auraHolder = player.battleArea.find((u) => u.def.teamDamageAmpAgainstUnitsIfTrait);
  if (!auraHolder) return 0;
  const cfg = auraHolder.def.teamDamageAmpAgainstUnitsIfTrait;
  return (sourceTraits || []).includes(cfg.trait) ? cfg.amount : 0;
}

/**
 * Modification EB01-079: "Choose 1 friendly (G Generation) Unit. It can't receive battle damage
 * from enemy Units that are Lv.3 or lower during this turn" -- a turn-scoped buff, same
 * lowAPEnemyDamageImmuneCap shape as above but keyed on the enemy's level and checked on both sides
 * of resolveUnitBattleDamage since the source text doesn't restrict which role applies.
 */
function isImmuneToLowLevelEnemyDamage(instance, enemyLevel) {
  const cap = instance.buffs.reduce((max, b) => Math.max(max, b.lowLevelEnemyDamageImmuneCap ?? -1), -1);
  return cap >= 0 && enemyLevel <= cap;
}

/**
 * Elan Ceres (Enhanced Person Number 5) GD04-087: "[During Link][Attack] You may choose 1 of your
 * (Academy) Units. During this battle, battle damage this Unit would receive is dealt to that Unit
 * instead" -- a redirectDamageTarget buff (battle- or turn-scoped depending on the granting card)
 * read wherever a Unit's battle damage is about to be dealt/checked-for-destruction, on both the
 * attacker side (this card) and the defender side (Lunamaria Hawke (U+) GD04-095 below).
 */
function getBattleDamageRecipient(instance) {
  const redirect = instance.buffs.find((b) => b.redirectDamageTarget);
  return redirect ? redirect.redirectDamageTarget : instance;
}

function resolveUnitBattleDamage(state, attackingPlayer, defendingPlayer, attacker, defender, hooks) {
  const attackerAP = getAP(attacker);
  const defenderAP = getAP(defender);
  const keywords = getKeywords(attacker);
  // Lunamaria Hawke (U+) GD04-095: "[When Linked] Choose 1 of your (Minerva Squad) Units. During
  // this turn, battle damage it would receive is dealt to this Unit instead" -- unlike Elan Ceres
  // above (attacker-only), this redirect can apply to the defender's role too, so the defender side
  // of damage/destruction below is resolved against the substituted recipient, mirroring the
  // attacker side's existing getBattleDamageRecipient(attacker) calls. Immunity checks (which are
  // properties of the originally-targeted defender itself) still read `defender` directly.
  const defenderRecipient = getBattleDamageRecipient(defender);
  // Olba Frost GD02-093 needs the destroyed enemy's paired Pilot after destroyCard has already
  // nulled its pilot, so it's captured here before either destruction branch below runs.
  const defenderPilot = defenderRecipient.pilot;
  // ZZ Gundam GD06-033: see teamDamageAmpAgainstUnits above -- only amplifies the attacker's own
  // outgoing damage to the enemy Unit, never the return damage dealt back to the attacker.
  const ampToDefender = teamDamageAmpAgainstUnits(attackingPlayer, attacker.def.traits);
  // Carta's Graze Ritter (Ground Type) (R+) GD02-073: "During your opponent's turn, the enemy Unit
  // battling this Unit gains <First Strike>" -- since a Unit is only ever the defender during its
  // own controller's opponent's turn (attacks only happen on the attacking player's turn), the "your
  // opponent's turn" clause is always true whenever this fires, so it collapses to a flat grant.
  if (defender.def.attackerGainsFirstStrike) keywords.firstStrike = true;
  // Reginlaze Julia GD06-037: "During your turn, while this Unit is battling a damaged enemy Unit,
  // it gains <First Strike>" -- an attacker-own static condition on the DEFENDER's damage, mirroring
  // attackerGainsFirstStrike above but keyed on the attacker's own def and the defender's live
  // damage instead. "During your turn" collapses to a flat grant (a Unit only ever attacks on its
  // own controller's turn), same reasoning as attackerGainsFirstStrike's own doc comment.
  if (attacker.def.firstStrikeIfDefenderDamaged && defender.damage > 0) keywords.firstStrike = true;

  if (keywords.firstStrike) {
    if (
      !isImmuneToLowHPEnemyDamage(defender, getHP(attacker)) &&
      !isImmuneToLowAPEnemyDamage(defender, attackerAP) &&
      !isImmuneToLowAPEnemyDamageOncePerTurnWhilePaired(defender, attackerAP) &&
      !isImmuneToLowLevelEnemyDamage(defender, attacker.def.level || 0) &&
      !isImmuneViaNamedToken(defendingPlayer, defender) &&
      !isImmuneToLowLevelEnemyDamageWhilePaired(defender, defendingPlayer, attackingPlayer, attacker.def.level || 0)
    ) {
      dealDamage(defenderRecipient, attackerAP + ampToDefender, { isBattleDamage: true, isEnemyDamage: true, player: defendingPlayer });
    }
    fireDealsBattleDamage(state, attackingPlayer, defendingPlayer, attacker, defender);
    const defenderDied = destroyAndFireEffect(state, defendingPlayer, defenderRecipient, { viaBattleDamage: true });
    if (defenderDied) {
      if (keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks, attacker);
      fireDestroysEnemy(state, attackingPlayer, attacker, defenderRecipient, defenderPilot);
      return; // 13-1-5-2: a Unit destroyed by First Strike deals no return damage.
    }
    if (
      !isImmuneToLowAPReturnDamage(attacker, defenderAP) &&
      !isImmuneToBlockerReturnDamage(attacker, defender.def.level || 0) &&
      !isImmuneToLowLevelReturnDamage(attacker, defender.def.level || 0) &&
      !isImmuneToLowHPEnemyDamage(attacker, getHP(defender)) &&
      !isImmuneToLowAPEnemyDamage(attacker, defenderAP) &&
      !isImmuneToLowAPEnemyDamageOncePerTurnWhilePaired(attacker, defenderAP) &&
      !isImmuneToLowLevelEnemyDamage(attacker, defender.def.level || 0) &&
      !isImmuneViaNamedToken(attackingPlayer, attacker) &&
      !isImmuneWhileBattlingBlocker(attacker)
    ) {
      dealDamage(getBattleDamageRecipient(attacker), defenderAP, { isBattleDamage: true, isEnemyDamage: true, player: attackingPlayer });
    }
    destroyAndFireEffect(state, attackingPlayer, getBattleDamageRecipient(attacker), { viaBattleDamage: true });
    return;
  }

  // Simultaneous mutual damage (8-5-3-2).
  if (
    !isImmuneToLowHPEnemyDamage(defender, getHP(attacker)) &&
    !isImmuneToLowAPEnemyDamage(defender, attackerAP) &&
    !isImmuneToLowAPEnemyDamageOncePerTurnWhilePaired(defender, attackerAP) &&
    !isImmuneToLowLevelEnemyDamage(defender, attacker.def.level || 0) &&
    !isImmuneViaNamedToken(defendingPlayer, defender) &&
    !isImmuneToLowLevelEnemyDamageWhilePaired(defender, defendingPlayer, attackingPlayer, attacker.def.level || 0)
  ) {
    dealDamage(defenderRecipient, attackerAP + ampToDefender, { isBattleDamage: true });
  }
  fireDealsBattleDamage(state, attackingPlayer, defendingPlayer, attacker, defender);
  if (
    !isImmuneToLowAPReturnDamage(attacker, defenderAP) &&
    !isImmuneToBlockerReturnDamage(attacker, defender.def.level || 0) &&
    !isImmuneToLowLevelReturnDamage(attacker, defender.def.level || 0) &&
    !isImmuneToLowHPEnemyDamage(attacker, getHP(defender)) &&
    !isImmuneToLowAPEnemyDamage(attacker, defenderAP) &&
    !isImmuneToLowAPEnemyDamageOncePerTurnWhilePaired(attacker, defenderAP) &&
    !isImmuneToLowLevelEnemyDamage(attacker, defender.def.level || 0) &&
    !isImmuneViaNamedToken(attackingPlayer, attacker) &&
    !isImmuneWhileBattlingBlocker(attacker)
  ) {
    dealDamage(getBattleDamageRecipient(attacker), defenderAP, { isBattleDamage: true });
  }
  // 10-1-6-6/Q108: simultaneous triggers resolve as the active player's full batch, then the standby
  // player's -- never interleaved. This only governs when each side's [Destroyed] card-text reaction
  // *fires*, not when a dead unit leaves the battle area -- removal happens immediately for both units
  // the instant their HP hits 0 (8-5-3-2), same timing as before, so anything reading board state (e.g.
  // a "rest 1 other enemy with <=5 HP" effect) still sees a dead unit as already gone. The attacker is
  // always the active player here (attacks only ever happen on your own turn), so their own [Destroyed],
  // Breach, and destroysEnemy all belong to the first batch and must resolve before the defender's
  // (standby player's) [Destroyed].
  const attackerRecipient = getBattleDamageRecipient(attacker);
  const attackerPilotBeforeDestroy = attackerRecipient.pilot;
  const attackerDied = destroyIfDead(state, attackingPlayer, attackerRecipient);
  const defenderDied = destroyIfDead(state, defendingPlayer, defenderRecipient);
  if (attackerDied) fireDestroyedTrigger(state, attackingPlayer, attackerRecipient, attackerPilotBeforeDestroy, { viaBattleDamage: true });
  if (defenderDied) {
    if (keywords.breach) applyBreach(state, defendingPlayer, keywords.breach, hooks, attacker);
    fireDestroysEnemy(state, attackingPlayer, attacker, defenderRecipient, defenderPilot);
    fireDestroyedTrigger(state, defendingPlayer, defenderRecipient, defenderPilot, { viaBattleDamage: true });
  }
}

/** Fires a destroyed Unit's own [Destroyed] card text plus its paired Pilot's, if it had one -- split
 * out of destroyAndFireEffect (which bundles this with the destroy itself) so mutual-destruction combat
 * can destroy both units immediately (8-5-3-2) while still sequencing *which side's reaction fires
 * first* per 10-1-6-6/Q108 (see resolveUnitBattleDamage above). `pilot` must be captured by the caller
 * before destroying, since destroyCard already nulls instance.pilot by the time this runs. */
function fireDestroyedTrigger(state, player, instance, pilot, extraContext = {}) {
  fireCardEffect(state, player, instance, 'destroyed', { wasPaired: !!pilot, pilot, ...extraContext });
  const pilotHandler = pilot && pilot.def.effects && pilot.def.effects.destroyed;
  if (pilotHandler) pilotHandler(state, player, instance, { wasPaired: true, pilot, ...extraContext });
}

/**
 * Fires a Unit's own "deals battle damage" trigger, then broadcasts to the rest of the attacking
 * player's field for reactive effects that watch ANY friendly Unit deal battle damage (e.g. Freedom
 * Gundam (Meteor) GD03-076's "when your (Triple Ship Alliance) Unit deal battle damage to an enemy
 * Unit..."), the same broadcast shape as fireDestroysEnemy's friendlyUnitDestroysEnemy below.
 */
function fireDealsBattleDamage(state, attackingPlayer, defendingPlayer, attacker, defender) {
  fireCardEffect(state, attackingPlayer, attacker, 'dealsBattleDamage', { defender });
  // Backup GD04-115: "[Main] Choose 1 of your Units. When it deals battle damage to an enemy Unit
  // that is Lv.5 or lower during this turn, destroy that enemy Unit" -- a one-shot execute grant to
  // an arbitrary chosen Unit (not the card's own fixed ability), so it's read as a buff here rather
  // than a def.effects.dealsBattleDamage handler like Ennil El GD04-096's version of this same
  // "fires before the destroy check" timing.
  const executeBuff = attacker.buffs.find((b) => b.executeEnemyLevelCap !== undefined);
  if (executeBuff && (defender.def.level || 0) <= executeBuff.executeEnemyLevelCap) {
    defender.damage = getHP(defender);
  }
  for (const c of attackingPlayer.battleArea) {
    const handler = c.def.effects && c.def.effects.friendlyUnitDealsBattleDamage;
    if (handler) handler(state, attackingPlayer, c, { attacker, defender });
  }
  // Gundam Pharact (LR+) GD04-018: "when one of your other (Academy) Units receives damage from an
  // enemy" -- unqualified "damage" (not "battle damage"), so it needs to react to battle damage here
  // AND effect damage (effects.js's dealEffectDamage fires the same friendlyUnitReceivesEnemyDamage
  // event), unlike friendlyUnitReceivesEffectDamage (Hotarubi GD03-129) which is effect-damage-only.
  for (const c of defendingPlayer.battleArea) {
    const handler = c.def.effects && c.def.effects.friendlyUnitReceivesEnemyDamage;
    if (handler) handler(state, defendingPlayer, c, { target: defender });
  }
}

/**
 * Fires a "this Unit destroys an enemy Unit with battle damage" trigger (e.g. Amuro Ray GD05-085),
 * skipped if the attacker didn't survive to receive it. Also resolves any temporary "draw on kill"
 * grant (e.g. Strike Freedom GD05-002's Deploy) and "rest an enemy on kill" grant (e.g. Penelope
 * (Flight Form) GD04-002's Deploy), since those aren't tied to any one card's own text.
 */
function fireDestroysEnemy(state, attackingPlayer, attacker, defender, defenderPilot) {
  if (!attackingPlayer.battleArea.includes(attacker)) return;
  fireCardEffect(state, attackingPlayer, attacker, 'destroysEnemy', { defender, defenderPilot });
  const onKillDraw = attacker.buffs.reduce((sum, b) => sum + (b.onKillDraw || 0), 0);
  for (let i = 0; i < onKillDraw; i++) drawCard(state, attackingPlayer);
  // Xi Gundam GD04-035: "...if you have 3 or less cards in your hand, draw 1" -- same onKillDraw
  // shape but gated on hand size at the moment of the kill.
  if (attacker.buffs.some((b) => b.onKillDrawIfHandAtMost !== undefined && attackingPlayer.hand.length <= b.onKillDrawIfHandAtMost)) {
    drawCard(state, attackingPlayer);
  }
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
  // Immortal Colasour GD03-120: "During this turn, if a friendly (Superpower Bloc)/(UN) Unit
  // destroys an enemy Unit with battle damage, choose 1 rested friendly (Superpower Bloc)/(UN)
  // Unit. Set it as active. It can't attack during this turn." A player-level turn-scoped flag
  // (not Unit-bound, since the source Command is trashed the instant it resolves) -- same
  // shieldDamageImmuneLevelCap precedent clearBattleBuffs already uses for player-level state,
  // just cleared by clearTurnBuffs instead since the card text says "during this turn."
  if (
    attackingPlayer.onKillSetActiveTraits &&
    attackerTraits.some((t) => attackingPlayer.onKillSetActiveTraits.includes(t))
  ) {
    const candidates = attackingPlayer.battleArea.filter(
      (u) => u.rested && (u.def.traits || []).some((t) => attackingPlayer.onKillSetActiveTraits.includes(t))
    );
    const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
    if (target) {
      setActiveByEffect(state, attackingPlayer, target);
      target.buffs.push({ cannotAttack: true, scope: 'turn' });
    }
  }
  // Broadcast to the attacking player's own field (e.g. Peacemillion GD03-125's Base ability),
  // distinct from the attacker's own "destroysEnemy" text fired just above.
  for (const c of [...attackingPlayer.battleArea, attackingPlayer.base].filter(Boolean)) {
    const handler = c.def.effects && c.def.effects.friendlyUnitDestroysEnemy;
    if (handler) handler(state, attackingPlayer, c, { attacker });
  }
  // Wise Leader's Pride ST12-014: "It gains the following effect during this battle: When this Unit
  // destroys an enemy Unit with battle damage, choose 1 enemy Unit with 2 or less AP. Destroy it" --
  // a this-battle-scoped onKill grant, same buff-sourced shape as the onKillDraw family above.
  const onKillDestroyCap = attacker.buffs.find((b) => b.onKillDestroyIfAPAtMost !== undefined);
  if (onKillDestroyCap) {
    const opp = state.players.find((p) => p !== attackingPlayer);
    const dTarget = opp.battleArea
      .filter((u) => getAP(u) <= onKillDestroyCap.onKillDestroyIfAPAtMost)
      .sort((a, b) => getAP(b) - getAP(a))[0];
    if (dTarget) destroyOutrightAndFireEffect(state, opp, dTarget);
  }
  // Libra ST12-016: "[ActivateMain] ... If a friendly Unit paired with a Pilot has destroyed an enemy
  // Unit with battle damage this turn, ..." -- a simple per-turn tracking flag, cleared by
  // clearTurnBuffs (src/rules/effects.js) the same way the other player-level "this turn" flags are.
  if (attacker.pilot) attackingPlayer.pairedUnitDestroyedEnemyThisTurn = true;
}

/**
 * <Breach(amount)> (13-1-2): damages the enemy Base, or top Shield if there's no Base. `attacker`
 * is optional (only combat-sourced Breach has one) -- when given, a destroyed Shield also fires
 * the "destroys shield" trigger/broadcast, same as a direct Shield hit.
 */
function applyBreach(state, defendingPlayer, amount, hooks, attacker) {
  if (defendingPlayer.base) {
    dealDamage(defendingPlayer.base, amount, { isBattleDamage: true });
    destroyAndFireEffect(state, defendingPlayer, defendingPlayer.base, { viaBattleDamage: true });
  } else if (defendingPlayer.shields.length > 0) {
    // Shamblo ST11-006: "If another friendly (Marine) Unit is in play at the start of your
    // opponent's turn, during this turn, when a friendly shield area card receives enemy effect
    // damage, reduce it by 5" -- Shields are always destroyed outright by any positive damage
    // (11-3-1-1, no partial-HP tracking), so a reduction bringing this hit to 0 or less is a real
    // prevention, not a partial no-op. Applied to any Breach-shaped shield hit through this shared
    // entry point (this engine doesn't separately tag "real battle Breach" vs. "an effect emulating
    // Breach," e.g. Master Gundam GD05-033's Attack, at this specific call site). Self-expiring via
    // a turnNumber comparison (set by shambloST11006StartOfTurn, registry.js) rather than a
    // clearTurnBuffs hook, since the flag lives on the defender while the *opponent's* turn is
    // active -- clearTurnBuffs only ever clears the turn-ending player's own state.
    const reduction =
      defendingPlayer.shieldEffectDamageReductionUntilTurn === state.turnNumber
        ? defendingPlayer.shieldEffectDamageReductionAmount || 0
        : 0;
    if (reduction > 0 && amount - reduction <= 0) return;
    const shield = destroyTopShield(defendingPlayer);
    resolveBurst(state, defendingPlayer, shield, hooks);
    if (attacker) {
      const attackingPlayer = state.players.find((p) => p !== defendingPlayer);
      fireDestroysShield(state, attackingPlayer, attacker);
    }
  }
}

/**
 * Reveals a destroyed Shield and, if it has a Burst effect, lets its owner choose to activate it
 * (5-10-3, 13-2-5). The effect fully controls the card's fate (e.g. "add this card to your hand");
 * it only falls through to the trash by default if nothing relocated it.
 */
function resolveBurst(state, defendingPlayer, shieldInstance, hooks) {
  const burstEffect = shieldInstance.def.effects && shieldInstance.def.effects.burst;
  const activate = burstEffect && hooks && hooks.chooseBurst ? hooks.chooseBurst(shieldInstance, state) : false;
  if (activate) burstEffect(state, defendingPlayer, shieldInstance, {});
  if (!isCardTracked(defendingPlayer, shieldInstance)) {
    defendingPlayer.trash.push(shieldInstance);
  }
}

module.exports = { resolveAttack, resolveFromBlockDecision, fireAttackTriggers, applyBlockDecision, resolveUnitBattleDamage, applyBreach, destroyAndFireEffect, destroyOutrightAndFireEffect, fireDestroysShield, fireDealsBattleDamage, resolveBurst, predictShieldHits, teamDamageAmpAgainstUnits, isBaseImmuneToLowLevelDamage };
