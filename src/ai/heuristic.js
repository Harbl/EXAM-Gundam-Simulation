const { canAfford, payCost } = require('../rules/cost');
const {
  deployUnit,
  deployBase,
  playCommand,
  pairPilot,
  pairPilotFromTrash,
  matchesLinkCondition,
  hasBetterLinkTargetInDeck,
  bestLinkMatch,
  comboSearchOdds,
  findEvolveTarget,
  deployByEvolve
} = require('../rules/actions');
const { getAP, getKeywords, getRemainingHP, effectivePilotDef, checkDefeat } = require('../rules/management');
const { resolveAttack, resolveFromBlockDecision } = require('../rules/combat');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../rules/phases');
const { cloneState } = require('../rules/clone');
const { scoreState } = require('./score');
const { collectActivateCandidates, collectActivateActionCandidates, ATTACKER_ACTION_RESOLVERS } = require('./activations');

/**
 * A simple heuristic bot for relative deck comparison, not tournament-strength play: mulligan
 * without an early play, curve out highest-cost-first, pair Pilots for the link bonus when one's
 * available, attack for face or a favorable/even trade, and block only to avoid lethal or a bad trade.
 */

function decideMulligan(hand) {
  const nonResource = hand.filter((c) => c.def.type !== 'resource');
  const hasEarlyPlay = nonResource.some((c) => (c.def.cost || 0) <= 2);
  // A single cheap card isn't enough on its own -- the resource pool only grows by 1/turn, so a hand
  // that's otherwise all 5+ cost stalls out by turn 3-4 even with one early play.
  const onCurveCount = nonResource.filter((c) => (c.def.cost || 0) <= 3).length;
  return !hasEarlyPlay || onCurveCount < 2;
}

/**
 * Whether deploying a Base right now would be a real upgrade, not the wasteful "bump my own paid-for
 * Base to trash for nothing" case (11-5). Every player starts the game with the free EX_BASE_DEF token
 * already in the base slot (src/rules/setup.js) -- replacing THAT is virtually always correct (it's a
 * 0AP/3HP placeholder with no ability), unlike replacing a real Base card you already committed to.
 * Found via the MSA benchmark investigation: the old `!player.base` check treated the starting EX Base
 * as already occupying the slot, so no deck's real Base (Ra Cailum, Gundam Fight, Isaribi, ...) was
 * EVER deployed in an entire game -- a significant, silent handicap on every Base-based archetype.
 */
function canDeployBase(player) {
  return !player.base || player.base.def.isToken;
}

function runDeploys(state, player) {
  for (;;) {
    // "Mode Change" evolve-play (e.g. Unicorn Gundam (Destroy Mode) GD01-002): the real card makes
    // this optional, but trading a spent Link Unit for a much bigger one for free is virtually
    // always a good trade, so the heuristic default takes it whenever available.
    const evolveCard = player.hand.find((c) => c.def.evolveCondition && findEvolveTarget(player, c.def));
    if (evolveCard) {
      const target = findEvolveTarget(player, evolveCard.def);
      player.hand.splice(player.hand.indexOf(evolveCard), 1);
      deployByEvolve(state, player, evolveCard.def, target);
      continue;
    }

    const playable = player.hand
      .filter((c) => (c.def.type === 'unit' || (c.def.type === 'base' && canDeployBase(player))) && canAfford(player, c.def, { state }))
      .sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0));
    const choice = playable[0];
    if (!choice) return;

    payCost(player, choice.def, { state });
    player.hand.splice(player.hand.indexOf(choice), 1);
    if (choice.def.type === 'unit') deployUnit(state, player, choice.def);
    else deployBase(state, player, choice.def);
  }
}

/** Plays every affordable Command in hand, earliest in the main phase so any cards it draws are available for this turn's deploys/pairings too. */
function runCommands(state, player) {
  for (;;) {
    const playable = player.hand.filter((c) => c.def.type === 'command' && c.def.actionTiming !== 'action' && canAfford(player, c.def, { state }));
    const choice = playable[0];
    if (!choice) return;

    const usedExResource = payCost(player, choice.def, { state });
    player.hand.splice(player.hand.indexOf(choice), 1);
    const trashed = playCommand(state, player, choice.def, { usedExResource });

    // e.g. Cyclone Punch GD05-121: "you may pair this card from your trash with one of your (MF) Units."
    if (trashed.def.pairableFromTrash) {
      const target = player.battleArea.find(
        (u) => !u.pilot && !u.def.cannotBePaired && (u.def.traits || []).includes(trashed.def.pairableFromTrash)
      );
      if (target) pairPilotFromTrash(state, player, target, trashed);
    }
  }
}

/** Every Command in hand currently affordable and legal to play in the Main phase -- excludes
 * Action-only commands (13-2-2: `[Action]` timing is only legal during an Action Step, see
 * resolveFromBlockDecision's actionStep hook in combat.js for where those get their own chance). */
function collectCommandCandidates(state, playerIdx) {
  const player = state.players[playerIdx];
  return player.hand.filter((c) => c.def.type === 'command' && c.def.actionTiming !== 'action' && canAfford(player, c.def, { state }));
}

/** Plays exactly the hand Commands whose id is in `subsetIds`, highest-cost first; a card that's no longer affordable partway through is simply skipped. */
function resolveCommandSubset(state, playerIdx, subsetIds) {
  const player = state.players[playerIdx];
  const chosen = player.hand
    .filter((c) => subsetIds.has(c.id))
    .sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0));
  for (const card of chosen) {
    if (!canAfford(player, card.def, { state })) continue;
    const usedExResource = payCost(player, card.def, { state });
    player.hand.splice(player.hand.indexOf(card), 1);
    const trashed = playCommand(state, player, card.def, { usedExResource });
    if (trashed.def.pairableFromTrash) {
      const target = player.battleArea.find(
        (u) => !u.pilot && !u.def.cannotBePaired && (u.def.traits || []).includes(trashed.def.pairableFromTrash)
      );
      if (target) pairPilotFromTrash(state, player, target, trashed);
    }
  }
}

// Reasoned starting magnitude for runCommandsLookahead's combo-search bonus below, same order as this
// session's other bonus weights (activationPotential:4, trashSynergy:3 in score.js's DEFAULT_WEIGHTS).
// Deliberately NOT part of DEFAULT_WEIGHTS/boardValue's weighted sum -- this is a separate,
// decision-time-only mechanism (see runCommandsLookahead), not a generic post-state feature, so it
// can't live in that table. Read via player.aiWeights?.comboSearch so a scratch script can still
// override it for a direct A/B behavioral check without a whole SPRT harness.
const COMBO_SEARCH_WEIGHT = 4;

/**
 * Same subset-search pattern as runDeploysLookahead/runPairingsLookahead: tries every combination of
 * affordable hand Commands (bounded by hand size), scores each with scoreState right after playing
 * it -- no opponent-turn simulation, same reasoning as the deploy/pairing searches (a Command resolves
 * immediately at Main-phase sorcery speed, no adversarial response to react to within this decision).
 * Runs before deploys/pairings in turn order (unchanged), so a card a Command draws is still
 * available for them; the search just replaces "always take every affordable Command in hand order"
 * with "take whichever affordable combination leaves the best board," which matters once more than
 * one Command competes for the same limited resource pool.
 *
 * Also adds a real-but-strictly-non-peeking bonus for digging while a combo search is open (Jake's
 * design principle: "the AI should have the same restrictions as a real life player -- not knowing
 * what the next draw will be"). `comboSearchOdds` (actions.js) is snapshotted ONCE from the real
 * pre-decision state, before any subset is resolved -- recomputing it from a resolved clone would
 * immediately reintroduce peeking, since the post-draw copies-remaining count is itself correlated
 * with whether that specific simulated draw happened to hit. Each subset's bonus scales by a bare
 * COUNT of how many cards its Commands collectively drew (hand-size delta, adjusting for the
 * subset's own cards leaving hand when played) -- never which cards, only how many, exactly the
 * "how much I dug" information a real player would have. A drawn card's own ordinary contribution to
 * scoreState (flat hand-size credit, or an immediate on-draw trigger) still flows through normally on
 * top of this -- this bonus only adds the piece that was otherwise completely absent.
 */
function runCommandsLookahead(state, playerIdx) {
  const player = state.players[playerIdx];
  const candidates = collectCommandCandidates(state, playerIdx);
  if (candidates.length === 0) return;

  const searchOdds = comboSearchOdds(player);
  const handSizeBefore = player.hand.length;
  const trashCountBefore = player.trash.length;
  const comboWeight = player.aiWeights?.comboSearch ?? COMBO_SEARCH_WEIGHT;

  let bestScore = -Infinity;
  let bestSubset = new Set();

  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const subsetIds = new Set();
    for (let i = 0; i < candidates.length; i++) {
      if (mask & (1 << i)) subsetIds.add(candidates[i].id);
    }

    const clone = cloneState(state);
    resolveCommandSubset(clone, playerIdx, subsetIds);
    let score = scoreState(clone, playerIdx);
    if (searchOdds > 0) {
      // subsetIds.size isn't always how many commands actually resolved -- resolveCommandSubset skips
      // one partway through if resources run out (e.g. two same-cost Commands both requested but only
      // one affordable), so the "how many actually got played" baseline has to come from the real
      // outcome (a trash-count delta, itself just a COUNT, not card identity) rather than the request.
      const actuallyPlayed = clone.players[playerIdx].trash.length - trashCountBefore;
      const cardsDrawn = Math.max(0, clone.players[playerIdx].hand.length - (handSizeBefore - actuallyPlayed));
      score += cardsDrawn * searchOdds * comboWeight;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSubset = subsetIds;
    }
  }

  resolveCommandSubset(state, playerIdx, bestSubset);
}

/** Every Unit/Base in hand currently affordable and legally deployable (same filter runDeploys uses). */
function collectDeployCandidates(state, playerIdx) {
  const player = state.players[playerIdx];
  return player.hand.filter(
    (c) => (c.def.type === 'unit' || (c.def.type === 'base' && canDeployBase(player))) && canAfford(player, c.def, { state })
  );
}

/** Deploys exactly the hand cards whose id is in `subsetIds`, highest-cost first; a card that's no longer affordable partway through (e.g. a second Base candidate in the same subset) is simply skipped. */
function resolveDeploySubset(state, playerIdx, subsetIds) {
  const player = state.players[playerIdx];
  const chosen = player.hand
    .filter((c) => subsetIds.has(c.id))
    .sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0));
  for (const card of chosen) {
    if (card.def.type === 'base' && !canDeployBase(player)) continue;
    if (!canAfford(player, card.def, { state })) continue;
    payCost(player, card.def, { state });
    player.hand.splice(player.hand.indexOf(card), 1);
    if (card.def.type === 'unit') deployUnit(state, player, card.def);
    else deployBase(state, player, card.def);
  }
}

/**
 * Mode Change (evolve) plays are fired unconditionally first -- trading a spent Link Unit for a much
 * bigger one for free is virtually always good (established default), not worth searching. Then
 * tries every subset of the remaining affordable Unit/Base hand cards (bounded by hand size),
 * scoring each resulting board with scoreState right after deploying it -- no opponent-turn
 * simulation here, unlike runAttacksLookahead: a deploy has no adversarial response to react to
 * within the same turn, and the attack phase later this same turn already runs its own opponent-turn
 * lookahead, so simulating it again here would just be redundant cost. This is what lets the bot
 * notice "two mid-cost Units add up to more total board value than one big one" instead of always
 * greedily taking the single highest-cost affordable card and possibly stranding leftover resources.
 */
function runDeploysLookahead(state, playerIdx) {
  const player = state.players[playerIdx];

  for (;;) {
    const evolveCard = player.hand.find((c) => c.def.evolveCondition && findEvolveTarget(player, c.def));
    if (!evolveCard) break;
    const target = findEvolveTarget(player, evolveCard.def);
    player.hand.splice(player.hand.indexOf(evolveCard), 1);
    deployByEvolve(state, player, evolveCard.def, target);
  }

  const candidates = collectDeployCandidates(state, playerIdx);
  if (candidates.length === 0) return;

  let bestScore = -Infinity;
  let bestSubset = new Set();

  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const subsetIds = new Set();
    for (let i = 0; i < candidates.length; i++) {
      if (mask & (1 << i)) subsetIds.add(candidates[i].id);
    }

    const clone = cloneState(state);
    resolveDeploySubset(clone, playerIdx, subsetIds);
    const score = scoreState(clone, playerIdx);
    if (score > bestScore) {
      bestScore = score;
      bestSubset = subsetIds;
    }
  }

  resolveDeploySubset(state, playerIdx, bestSubset);
}

function runPairings(state, player) {
  for (;;) {
    // A "Pilot Command" (e.g. Deep Devotion GD01-101) is a Command card that can alternatively be
    // paired as a Pilot -- in practice runCommands() (which runs first each main phase) will
    // already have greedily played any affordable one for its printed text before this ever sees
    // it, so this mostly matters for direct/manual pairing rather than the AI's default behavior.
    const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
    // Christina Mackenzie GD03-085 can afford to pair for 0 cost against a matching Unit even when
    // otherwise unaffordable, so the affordability filter needs to know the best-case pair target.
    const pilots = player.hand.filter((c) => {
      if (c.def.type !== 'pilot' && !c.def.pilotMode) return false;
      const pairUnit = c.def.freeCostIfPairUnitNameIncludes
        ? targets.find((u) => (u.def.name || '').includes(c.def.freeCostIfPairUnitNameIncludes))
        : undefined;
      return canAfford(player, c.def, { pairUnit, state });
    });
    if (pilots.length === 0 || targets.length === 0) return;

    // For each hand Pilot, find the best Link match already in play (if any) and check whether the
    // deck still holds something better for it -- a real player wouldn't commit a Pilot to a lesser
    // body while its real target is one draw away. Take the first Pilot whose best available in-play
    // match ISN'T beaten by anything left in the deck.
    let pilot = null;
    let unit = null;
    for (const p of pilots) {
      const best = bestLinkMatch(targets, p);
      const bestLevel = best ? (best.def.level || 0) : -1;
      if (best && !hasBetterLinkTargetInDeck(player, p, bestLevel)) {
        pilot = p;
        unit = best;
        break;
      }
    }
    if (!pilot) {
      // No hand Pilot has a good-enough Link match already on board (either no match at all, or the
      // best one available is worse than what's still coming). Rather than dumping the first
      // affordable Pilot onto the first open Unit (the old behavior -- burns a Pilot's real combo body
      // on a lesser one, or the moment it's drawn if that body just hasn't shown up yet), only take a
      // Pilot that has no better target left anywhere in the deck. If every hand Pilot still has a
      // real target coming, hold them all rather than force a bad pairing.
      pilot = pilots.find((p) => !hasBetterLinkTargetInDeck(player, p));
      if (!pilot) return;
      unit = targets[0];
    }

    payCost(player, pilot.def, { pairUnit: unit, state });
    pairPilot(state, player, unit, pilot);
  }
}

/** Pairs exactly the hand Pilot/pilotMode cards whose id is in `subsetIds`, same target-selection rule as runPairings (prefer the best Link-condition match not beaten by the deck). */
function resolvePairingSubset(state, playerIdx, subsetIds) {
  const player = state.players[playerIdx];
  for (;;) {
    const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
    const pilots = player.hand.filter((c) => {
      if (!subsetIds.has(c.id)) return false;
      if (c.def.type !== 'pilot' && !c.def.pilotMode) return false;
      const pairUnit = c.def.freeCostIfPairUnitNameIncludes
        ? targets.find((u) => (u.def.name || '').includes(c.def.freeCostIfPairUnitNameIncludes))
        : undefined;
      return canAfford(player, c.def, { pairUnit, state });
    });
    if (pilots.length === 0 || targets.length === 0) return;

    // Same reasoning as runPairings above: don't burn a Pilot on a lesser Unit (or a mismatched one)
    // while its real, better target is still sitting undrawn in the deck.
    let pilot = null;
    let unit = null;
    for (const p of pilots) {
      const best = bestLinkMatch(targets, p);
      const bestLevel = best ? (best.def.level || 0) : -1;
      if (best && !hasBetterLinkTargetInDeck(player, p, bestLevel)) {
        pilot = p;
        unit = best;
        break;
      }
    }
    if (!pilot) {
      pilot = pilots.find((p) => !hasBetterLinkTargetInDeck(player, p));
      if (!pilot) return;
      unit = targets[0];
    }

    payCost(player, pilot.def, { pairUnit: unit, state });
    pairPilot(state, player, unit, pilot);
  }
}

/**
 * Tries every subset of affordable hand Pilots (bounded by hand size) for whether to pair them this
 * turn at all -- target selection within a chosen subset keeps the existing link-condition-preferred
 * rule rather than also searching assignments, since that's already close to optimal and searching
 * pilot subsets alone already captures the real trade-off (several pilots competing for the same
 * limited resource pool). No opponent-turn simulation, same reasoning as runDeploysLookahead.
 */
function runPairingsLookahead(state, playerIdx) {
  const player = state.players[playerIdx];
  const candidates = player.hand.filter(
    (c) => (c.def.type === 'pilot' || c.def.pilotMode) && canAfford(player, c.def, { state })
  );
  if (candidates.length === 0) return;

  let bestScore = -Infinity;
  let bestSubset = new Set();

  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const subsetIds = new Set();
    for (let i = 0; i < candidates.length; i++) {
      if (mask & (1 << i)) subsetIds.add(candidates[i].id);
    }

    const clone = cloneState(state);
    resolvePairingSubset(clone, playerIdx, subsetIds);
    const score = scoreState(clone, playerIdx);
    if (score > bestScore) {
      bestScore = score;
      bestSubset = subsetIds;
    }
  }

  resolvePairingSubset(state, playerIdx, bestSubset);
}

/**
 * Uses every Activate-Main ability the player controls (Base or Unit) once per turn when it's
 * currently usable, per the shared resolver table in activations.js (see that file for why it's a
 * data-driven table rather than this function's own if/else chain -- kept that way so the MCTS search
 * reads the exact same per-card resolution logic instead of a second, possibly-drifting copy).
 */
function runActivations(state, playerIdx) {
  const player = state.players[playerIdx];
  for (const { source, args, handler } of collectActivateCandidates(state, playerIdx)) {
    // See src/rules/effects.js's fireCardEffect/triggerEvent comment: resolvingSource lets
    // dealEffectDamage check the acting Unit's own Level (Gouf Vijayanta EB01-014), and a couple of
    // real Activate*Main abilities (GD02-047, GD04-125) deal effect damage.
    const prevSource = state.resolvingSource;
    state.resolvingSource = source;
    try {
      handler(state, player, source, args);
    } finally {
      state.resolvingSource = prevSource;
    }
  }
}

/**
 * Prefers the scariest rested enemy Unit it can kill without dying itself; otherwise swings at the
 * player -- unless this Unit can't legally attack the player at all (e.g. Zoloat, [Parts] tokens),
 * in which case it only ever takes a favorable trade, or simply doesn't attack this turn.
 */
/**
 * "Enemy Units choose [this Unit / one of your rested (Trait) Units] as their attack target if
 * possible when attacking" (Gundam AGE-2 Normal (LR+) GD03-019 during-pair self-taunt, Gundam
 * Sandrock Custom GD03-025's static trait-wide taunt) -- collects every rested Unit on the
 * defending side that some taunt source currently forces enemies to prefer.
 */
function getForcedAttackTargets(defendingPlayer, attacker = null) {
  const tauntTraits = defendingPlayer.battleArea.filter((u) => u.def.tauntTrait).map((u) => u.def.tauntTrait);
  return defendingPlayer.battleArea.filter(
    (u) =>
      u.rested &&
      // Destined Battle GD04-107: "[Action] Choose 1 of your rested Units. During this turn, all
      // enemy Units must choose that Unit as their attack target when attacking" -- a one-shot
      // targeted taunt buff, distinct from the pilot-driven/trait-wide taunt sources above.
      (u.buffs.some((b) => b.forcedAttackTarget) ||
        (u.def.duringPairTaunt && u.pilot) ||
        tauntTraits.some((t) => (u.def.traits || []).includes(t)) ||
        // Tieren Taozi GD03-074: "[During Pair] While you have another (Superpower Bloc) Unit in
        // play, enemy Units choose this rested Unit as their attack target if possible" -- unlike
        // duringPairTaunt above, this self-taunt is further gated on another matching-trait ally.
        (u.def.duringPairTauntIfTrait &&
          u.pilot &&
          defendingPlayer.battleArea.some((o) => o !== u && (o.def.traits || []).includes(u.def.duringPairTauntIfTrait))) ||
        // Kayra Su GD05-086: "[During Link] Enemy Units other than Link Units choose this rested
        // Unit as their attack target if possible when attacking" -- Pilot-granted like
        // duringPairTaunt above but gated on isLinkUnit instead of any pairing, and exempts an
        // attacking Link Unit from the compulsion.
        (u.isLinkUnit &&
          u.pilot &&
          u.pilot.def.duringLinkTaunt &&
          !(u.pilot.def.duringLinkTaunt.exceptEnemyLinkUnits && attacker && attacker.isLinkUnit)))
  );
}

function chooseAttackTarget(opponent, attacker, unitOnly = false, player = null) {
  const forcedTargets = getForcedAttackTargets(opponent, attacker);
  if (forcedTargets.length > 0) {
    return { type: 'unit', instance: forcedTargets.sort((a, b) => getAP(b) - getAP(a))[0] };
  }
  const attackerAP = getAP(attacker);
  // Wing Gundam ST02-001 (static) / Athrun Zala ST04-011 (When Linked buff): "may choose an active
  // enemy Unit that is Lv.X or lower as its attack target" -- normally only rested enemies are
  // legal targets, so this widens the candidate pool.
  let activeCap = attacker.def.activeTargetLevelCap;
  if (activeCap === undefined) {
    const capBuff = attacker.buffs.find((b) => b.activeTargetLevelCap !== undefined);
    if (capBuff) activeCap = capBuff.activeTargetLevelCap;
  }
  // Duel Gundam (Assault Shroud) GD03-042: "While this Unit has 5+ AP, it may choose an active enemy
  // Unit that is Lv.5 or lower as its attack target" -- same AP-threshold live-compute shape as
  // management.js's blockerWhileAPAtLeast, just for this cap instead of a boolean keyword.
  if (activeCap === undefined && attacker.def.activeTargetLevelCapWhileAPAtLeast) {
    const threshold = attacker.def.activeTargetLevelCapWhileAPAtLeast;
    if (attackerAP >= threshold.ap) activeCap = threshold.cap;
  }
  // GFreD GD03-035's When Linked grant: may target an active enemy Unit with AP <= this Unit's own.
  const activeAPCap = attacker.buffs.some((b) => b.activeTargetAPCap);
  // Kämpfer GD03-017's When Paired team grant: may target an active enemy Unit with AP <= a fixed threshold.
  const apThresholdBuff = attacker.buffs.find((b) => b.activeTargetAPThreshold !== undefined);
  // Bridge Crew (R+) GD03-105's Main grant: may target an active enemy Unit with no Pilot paired.
  const noPilotBuff = attacker.buffs.some((b) => b.activeTargetNoPilot);
  // Gundam Throne Zwei GD04-045's When Linked grant: may target a damaged active enemy Unit.
  const damagedBuff = attacker.buffs.some((b) => b.activeTargetIfDamaged);
  // Reiji EB01-066's When Paired grant: may target an active enemy Unit that has a specific keyword.
  const keywordBuff = attacker.buffs.find((b) => b.activeTargetIfKeyword);
  // Gundam Airmaster Burst GD04-051: "[During Pair(Vulture) Pilot] If there are 7+ cards in your
  // trash, this Unit may choose an active enemy Unit with a keyword effect as its attack target" --
  // a live During Pair condition (not a buff), so it's read straight off card data + owner's trash.
  const keywordCond = attacker.def.activeTargetIfKeywordWhilePairedTrait;
  const keywordTargetActive =
    !!keywordCond &&
    attacker.pilot &&
    (attacker.pilot.def.traits || []).includes(keywordCond.trait) &&
    player &&
    player.trash.length >= keywordCond.trashCount;
  const isEligibleTarget = (u) =>
    u.rested ||
    (activeCap !== undefined && (u.def.level || 0) <= activeCap) ||
    (activeAPCap && getAP(u) <= attackerAP) ||
    (apThresholdBuff && getAP(u) <= apThresholdBuff.activeTargetAPThreshold) ||
    (noPilotBuff && !u.pilot) ||
    (damagedBuff && u.damage > 0) ||
    (keywordBuff && getKeywords(u)[keywordBuff.activeTargetIfKeyword]) ||
    (keywordTargetActive && Object.values(getKeywords(u)).some(Boolean));
  const goodTrades = opponent.battleArea
    .filter((u) => isEligibleTarget(u) && attackerAP >= getRemainingHP(u) && getAP(u) < getRemainingHP(attacker))
    .sort((a, b) => getAP(b) - getAP(a));
  // "When this Unit deals battle damage to an enemy Unit [conditions], destroy that enemy Unit" --
  // a real kill condition independent of raw AP-vs-HP math, so the generic goodTrades filter above
  // (which requires attackerAP >= getRemainingHP(u)) never recognizes it. Declared via a def flag
  // (destroysOnBattleDamage) rather than hardcoding card numbers here, matching every other
  // buff/flag-gated special case in this function. Checked on the attacker's own def first, then a
  // paired Pilot's def (Ennil El GD04-096's version lives on the Pilot, mirroring the same
  // own-def-then-paired-Pilot-fallback shape activations.js's activateMainSource already uses for
  // Activate-Main). Four real cards share this text shape with different gating conditions:
  // Gundam Exia Repair GD05-050 (Lv.4 cap, target must have no paired Pilot), Gundam Virtue (R+)
  // GD03-052 (Lv.5 cap, controller needs a (CB) Pilot in play), Gundam Virtue (Trans-Am) GD04-054
  // (no conditions at all), Ennil El GD04-096 (Lv.5 cap, attacker must be Linked). Deliberately does
  // NOT require attacker survival for any of them -- trading a cheap/fragile source for a much bigger
  // enemy Unit is a real, good sacrifice (and for Exia Repair specifically, also self-mills 2 cards
  // via its own Destroyed trigger), not a mistake to filter out.
  const destroyRule = attacker.def.destroysOnBattleDamage || (attacker.pilot && attacker.pilot.def.destroysOnBattleDamage);
  const destroyRuleActive =
    !!destroyRule &&
    (!destroyRule.requireLinked || attacker.isLinkUnit) &&
    (!destroyRule.requireControllerPilotTrait ||
      (player && player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes(destroyRule.requireControllerPilotTrait))));
  const executionTargets = destroyRuleActive
    ? opponent.battleArea.filter(
        (u) =>
          isEligibleTarget(u) &&
          (!destroyRule.requireNoPilot || !u.pilot) &&
          (destroyRule.levelCap === undefined || (u.def.level || 0) <= destroyRule.levelCap)
      )
    : [];
  const bestTarget = [...goodTrades, ...executionTargets].sort((a, b) => getAP(b) - getAP(a))[0];
  if (bestTarget) return { type: 'unit', instance: bestTarget };
  if (unitOnly) return null;
  const cannotAttackPlayer = attacker.def.cannotAttackPlayer || attacker.buffs.some((b) => b.cannotAttackPlayer);
  return cannotAttackPlayer ? null : { type: 'player' };
}

/** Every Unit currently eligible to attack this turn, in the order they should be resolved in. */
function collectAttackCandidates(state, playerIdx) {
  const player = state.players[playerIdx];
  return player.battleArea
    .filter(
      (u) => u.def.type === 'unit' && !u.rested && !u.buffs.some((b) => b.cannotAttack)
        && (u.isLinkUnit || u.turnDeployed !== state.turnNumber || u.def.attackOnDeployRestedOnly
            || u.buffs.some((b) => b.canAttackOnDeployTurn))
        // AEU Enact Demonstration Color GD03-081: "This Unit can only attack during a turn when one
        // of your (Superpower Bloc)/(UN) Units is deployed" -- `turnDeployed` already tracks each
        // Unit's deploy turn (see the deploy-restriction check above), so this reuses it directly.
        && (!u.def.attackRequiresTraitDeployedThisTurn || player.battleArea.some(
          (o) => o.turnDeployed === state.turnNumber && (o.def.traits || []).some((t) => u.def.attackRequiresTraitDeployedThisTurn.includes(t))
        ))
        // G-Falcon GD04-061: "This Unit can't attack while there are 6 or less cards in your trash" --
        // same static-condition-ANDed-into-the-attacker-filter shape as attackRequiresTraitDeployedThisTurn.
        && (!u.def.attackRequiresTrashAtLeast || player.trash.length >= u.def.attackRequiresTrashAtLeast)
    )
    .map((attacker) => {
      // Gundam Deathscythe Hell (EW) GD05-078: normally a freshly-deployed non-Link Unit can't
      // attack this turn at all -- its own text carves out an exception, but only against a rested
      // enemy Unit, never the player directly. Justice Gundam GD01-066's token grant lifts the
      // restriction entirely instead (full normal attack, not unit-only).
      const bypassesDeployRestriction = attacker.isLinkUnit || attacker.buffs.some((b) => b.canAttackOnDeployTurn);
      const onDeployTurn = !bypassesDeployRestriction && attacker.turnDeployed === state.turnNumber;
      const cannotAttackPlayer = attacker.def.cannotAttackPlayer || attacker.buffs.some((b) => b.cannotAttackPlayer);
      return { attacker, onDeployTurn, forcedUnitOnly: onDeployTurn || cannotAttackPlayer };
    })
    // Attackers with no face-damage fallback (locked to unit-only this attack) get first pick of the
    // available good trades; among equals, weaker attackers go first so they claim just-enough kills
    // instead of a stronger attacker overkilling a small target and leaving nothing for the rest.
    .sort((a, b) => (Number(b.forcedUnitOnly) - Number(a.forcedUnitOnly)) || (getAP(a.attacker) - getAP(b.attacker)));
}

/** Resolves attacks for exactly the candidates whose `attacker.id` is in `subsetIds`, in candidate order. */
function resolveAttackSubset(state, playerIdx, subsetIds, hooks) {
  const player = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];
  for (const { attacker, onDeployTurn } of collectAttackCandidates(state, playerIdx)) {
    if (!subsetIds.has(attacker.id)) continue;
    if (state.winner !== null || attacker.rested) continue;
    const target = chooseAttackTarget(opponent, attacker, onDeployTurn, player);
    if (target) resolveAttack(state, playerIdx, attacker, target, hooks);
  }
}

/** Attacks with every eligible Unit that can find a target -- no lookahead, used as the opponent's stand-in policy during simulated trials (see runAttacksLookahead) so those trials stay cheap and never recurse into another search. */
function runAttacks(state, playerIdx, hooks) {
  const allIds = new Set(collectAttackCandidates(state, playerIdx).map((c) => c.attacker.id));
  resolveAttackSubset(state, playerIdx, allIds, hooks);
}

/**
 * Tries every subset of eligible attackers (bounded by MAX_BATTLE_AREA = 6, so <= 64 subsets): for
 * each, clones the state, resolves that subset's attacks, then simulates the opponent's entire
 * following turn and scores the result with scoreState. Picks whichever subset scores best for the
 * acting player, then replays it for real. This is what lets the bot notice "attacking with everyone
 * leaves no blockers and dies to the counter-swing" instead of always attacking greedily.
 *
 * Opponent modeling: at the real top-level call (depth 0), the simulated opponent turn uses the full
 * lookahead stack (runMainPhase, depth 1) instead of the cheap greedy policy -- a genuinely strong
 * opponent's commands/deploys/pairings/attacks are what actually threaten the acting player, and
 * modeling them with the cheap heuristic systematically underestimated that danger. The depth counter
 * is the recursion guard: once already inside a simulated trial (depth >= 1), the opponent-turn
 * simulation falls back to the plain runMainPhaseSimple, so a search can nest one extra ply of "the
 * opponent plays well" without spawning another full 64-branch search inside every one of the outer
 * 64 branches (which would spawn another 64 inside each of those, exploding combinatorially).
 */
function runAttacksLookahead(state, playerIdx, hooks, depth = 0) {
  const candidates = collectAttackCandidates(state, playerIdx);
  if (candidates.length === 0) return;

  let bestScore = -Infinity;
  let bestSubset = new Set();

  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const subsetIds = new Set();
    for (let i = 0; i < candidates.length; i++) {
      if (mask & (1 << i)) subsetIds.add(candidates[i].attacker.id);
    }

    const clone = cloneState(state);
    resolveAttackSubset(clone, playerIdx, subsetIds, defaultHooks());

    if (clone.winner === null && !clone.draw) {
      runEndPhase(clone);
      passTurn(clone);
      runStartPhase(clone);
      runDrawPhase(clone);
      checkDefeat(clone);
      if (clone.winner === null && !clone.draw) {
        runResourcePhase(clone);
        if (depth === 0) {
          runMainPhase(clone, 1 - playerIdx, lookaheadHooks(clone), depth + 1);
        } else {
          runMainPhaseSimple(clone, 1 - playerIdx, defaultHooks());
        }
      }
    }

    const score = scoreState(clone, playerIdx);
    if (score > bestScore) {
      bestScore = score;
      bestSubset = subsetIds;
    }
  }

  resolveAttackSubset(state, playerIdx, bestSubset, hooks);
}

/** Every active Unit on the defending side that's a legal Blocker for this specific attack. */
function collectBlockCandidates(defendingPlayer, attacker, target, attackingPlayer) {
  // Psycho Haro (EX) EB01-042: "While this Unit is rested, all Units gain [Blocker]" -- only
  // checked against the defending side's own field, since that's the only side whose Blocker
  // eligibility actually matters here (a rested source on the attacking side would technically also
  // qualify per the unqualified "all Units" text, but that half isn't threaded through -- this
  // heuristic has no access to the attacking player's battleArea).
  const universalBlockerActive = defendingPlayer.battleArea.some((u) => u.def.grantsBlockerToAllWhileRested && u.rested);
  return defendingPlayer.battleArea.filter(
    (u) =>
      !u.rested &&
      (getKeywords(u).blocker || universalBlockerActive ||
        // Gustav Karl Type-00 ST08-008: "While 3 or more enemy Units are in play, this Unit gains
        // [Blocker]" -- the first Blocker grant keyed off the ATTACKING side's Unit count, so
        // chooseBlocker now takes attackingPlayer as an optional 4th param (every existing 3-arg
        // caller/test still works; this is the first consumer of the new arg).
        (u.def.blockerWhileEnemyUnitCountAtLeast !== undefined && attackingPlayer &&
          attackingPlayer.battleArea.length >= u.def.blockerWhileEnemyUnitCountAtLeast)) &&
      !(target.type === 'unit' && target.instance === u) &&
      // Girty Lue GD05-127: "choose 1 enemy Unit. It can't activate [Blocker] during this turn."
      !u.buffs.some((b) => b.cannotBlock)
  );
}

/**
 * Blocks when facing lethal (8-5-2-2: no Base and no Shields left) or a trade that loses the Unit
 * for nothing in return. Among legal blockers, prefers one that survives and/or kills the attacker
 * over a bare chump -- only sacrifices the cheapest Unit when no better trade is available. No
 * lookahead -- used as the cheap policy inside every simulated trial (see chooseBlockerLookahead).
 */
function chooseBlocker(defendingPlayer, attacker, target, attackingPlayer) {
  const blockers = collectBlockCandidates(defendingPlayer, attacker, target, attackingPlayer);
  if (blockers.length === 0) return null;

  const attackerAP = getAP(attacker);
  const attackerHP = getRemainingHP(attacker);
  const facingLethal = target.type === 'player' && defendingPlayer.shields.length === 0 && !defendingPlayer.base;
  const badTrade =
    target.type === 'unit' &&
    getRemainingHP(target.instance) <= attackerAP &&
    getAP(target.instance) < attackerAP;

  if (!facingLethal && !badTrade) return null;

  const tradeScore = (b) => {
    const survives = getRemainingHP(b) > attackerAP;
    const kills = getAP(b) >= attackerHP;
    if (survives && kills) return 3;
    if (survives) return 2;
    if (kills) return 1;
    return 0;
  };
  return blockers.sort((a, b) => tradeScore(b) - tradeScore(a) || getRemainingHP(a) - getRemainingHP(b))[0];
}

function chooseBurst(shieldInstance) {
  return !!(shieldInstance.def.effects && shieldInstance.def.effects.burst);
}

/**
 * Reactively plays one Action-eligible Command from the defending player's hand, then tries one
 * [Activate·Action] ability off their board, during the Action Step (8-4) -- if either is legal,
 * affordable, and the battle is actually worth reacting to. Same facingLethal/badTrade gate as
 * chooseBlocker (13-1-4's own reactive answer), reused here since it's the same underlying question --
 * "is this attack dangerous enough to spend a card/ability stopping it" -- just answered with a
 * Command or an Activate·Action instead of a Blocker. Doesn't rank *which* eligible card/ability is
 * best for the situation (that would mean modeling all ~85 different effect shapes); picks the first
 * legal one of each and lets its own already-designed fallback targeting choose the rest, same as it
 * already does when played from the Main phase. A real first step, not a claim of optimal reactive
 * play or full priority-alternation -- see project gaps doc for the fuller picture.
 *
 * Also tries the *attacking* player's own [Activate·Action] options (Gamow GD01-127, Moebius
 * Peacemaker GD02-011 -- naturally attacker-side, via `ATTACKER_ACTION_RESOLVERS`), independent of the
 * facingLethal/badTrade gate above: those two cards are proactive value-adds while attacking, not
 * reactions to danger, so gating them on the defender's peril would skip them almost every real turn.
 */
function actionStep(state, { attacker, target, battleTarget }) {
  const attackingPlayer = state.players.find((p) => p.battleArea.includes(attacker));
  const defendingPlayer = state.players.find((p) => p !== attackingPlayer);
  if (!attackingPlayer || !defendingPlayer) return;
  const defendingPlayerIdx = state.players.indexOf(defendingPlayer);
  const attackingPlayerIdx = state.players.indexOf(attackingPlayer);

  const attackerAP = getAP(attacker);
  const facingLethal = target.type === 'player' && defendingPlayer.shields.length === 0 && !defendingPlayer.base;
  const badTrade =
    target.type === 'unit' &&
    getRemainingHP(target.instance) <= attackerAP &&
    getAP(target.instance) < attackerAP;

  // The defending player's reactive window -- only worth spending a card/ability on when the attack is
  // actually dangerous (facingLethal/badTrade), same gate chooseBlocker uses. Gated in its own block
  // (rather than an early return) so the attacking player's own options below still get a chance even
  // when the defender isn't in any danger -- those are proactive value-adds, not reactions to peril.
  if (facingLethal || badTrade) {
    const candidates = defendingPlayer.hand.filter(
      (c) =>
        c.def.type === 'command' &&
        (c.def.actionTiming === 'action' || c.def.actionTiming === 'both') &&
        canAfford(defendingPlayer, c.def, { state })
    );
    const choice = candidates[0];
    if (choice) {
      const usedExResource = payCost(defendingPlayer, choice.def, { state });
      defendingPlayer.hand.splice(defendingPlayer.hand.indexOf(choice), 1);
      const underAttack = target.type === 'unit' ? target.instance : defendingPlayer.base;
      playCommand(state, defendingPlayer, choice.def, {
        usedExResource,
        extraContext: { battleTarget, underAttack, attackingUnit: attacker }
      });
    }

    // A reactive Command above (e.g. Wings of Light bouncing the attacker) can already end this battle
    // -- re-check before trying an [Activate·Action] ability so it never targets a unit that's no
    // longer actually in the fight (same attackerStillIn/targetStillIn guard combat.js itself uses).
    const battleStillOnForDefender =
      attackingPlayer.battleArea.includes(attacker) &&
      (battleTarget.type === 'player' || defendingPlayer.battleArea.includes(battleTarget.instance));
    if (battleStillOnForDefender) {
      const activateChoice = collectActivateActionCandidates(state, defendingPlayerIdx, { attacker, target: battleTarget })[0];
      if (activateChoice) {
        const prevSource = state.resolvingSource;
        state.resolvingSource = activateChoice.source;
        try {
          activateChoice.handler(state, defendingPlayer, activateChoice.source, activateChoice.args);
        } finally {
          state.resolvingSource = prevSource;
        }
      }
    }
  }

  // The attacking player's own [Activate·Action] options (Gamow GD01-127, Moebius Peacemaker
  // GD02-011) -- naturally attacker-side (Breach/damage forward only matters while attacking), so
  // unlike the defender's reactive window above these aren't gated on facingLethal/badTrade at all.
  // Re-check the battle is still on first, since the defender's own reaction above could already have
  // ended it (e.g. bouncing the attacker away).
  const battleStillOnForAttacker =
    attackingPlayer.battleArea.includes(attacker) &&
    (battleTarget.type === 'player' || defendingPlayer.battleArea.includes(battleTarget.instance));
  if (!battleStillOnForAttacker) return;

  const attackerActivateChoice = collectActivateActionCandidates(
    state,
    attackingPlayerIdx,
    { attacker, target: battleTarget },
    ATTACKER_ACTION_RESOLVERS
  )[0];
  if (!attackerActivateChoice) return;
  const prevAttackerSource = state.resolvingSource;
  state.resolvingSource = attackerActivateChoice.source;
  try {
    attackerActivateChoice.handler(state, attackingPlayer, attackerActivateChoice.source, attackerActivateChoice.args);
  } finally {
    state.resolvingSource = prevAttackerSource;
  }
}

/**
 * End-of-turn hand-limit discard choice (7-6-3), the second real testbed for "the AI should know what
 * it's holding a card for" (after the pairing-hold fix, actions.js's hasBetterLinkTargetInDeck/
 * bestLinkMatch). Previously unimplemented -- hooks.chooseDiscards was always undefined in real play,
 * so enforceHandLimit's naive fallback (discard the first `excess` cards in raw hand order) ran every
 * game. That's a real problem specifically because of the pairing fix: a Pilot the AI just
 * deliberately held onto (because a better Link target is still in the deck) could get thrown away by
 * this completely separate code path moments later, undoing the whole point of holding it.
 *
 * Ranks every hand card by "how bad it'd be to lose this," ascending, and discards the `excess`
 * lowest-ranked:
 *   - A Pilot/pilotMode card currently being held for a real reason (its best available target, in
 *     play or not, is beaten by something still undrawn in the deck) ranks infinitely high -- never
 *     the first thing discarded while anything else could go instead.
 *   - Everything else ranks by printed cost, low to high -- a rough "how big an investment is this"
 *     proxy absent a real per-card value model, so cheap filler goes before your actual bombs. Same
 *     kind of judgment call as the "Heuristic default" choices documented throughout registry.js.
 */
function chooseDiscards(player, excess) {
  const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
  const rank = (card) => {
    if (card.def.type !== 'pilot' && !card.def.pilotMode) return card.def.cost || 0;
    const best = bestLinkMatch(targets, card);
    const bestLevel = best ? (best.def.level || 0) : -1;
    return hasBetterLinkTargetInDeck(player, card, bestLevel) ? Infinity : card.def.cost || 0;
  };
  return [...player.hand].sort((a, b) => rank(a) - rank(b)).slice(0, excess);
}

function defaultHooks() {
  return { chooseBlocker, chooseBurst, actionStep, chooseDiscards };
}

/** Finds the clone-side instance matching a real-state instance's stable id (attacker/target/blocker candidates are always currently in a battleArea). */
function findInstanceById(state, id) {
  for (const player of state.players) {
    const found = player.battleArea.find((u) => u.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Tries every legal blocker (plus "don't block") by cloning state and resolving the rest of this
 * attack (resolveFromBlockDecision, not resolveAttack -- re-running the attack step itself on a
 * clone would double-fire 'attack'-triggered effects), scoring the outcome from the defender's own
 * perspective. Unlike the plain chooseBlocker's facingLethal/badTrade gate, this always searches, so
 * it can also catch non-obvious good blocks the fixed rule would miss (e.g. blocking purely to
 * preserve board tempo when it's not lethal and not a clean trade).
 */
function chooseBlockerLookahead(state, defendingPlayer, attacker, target, attackingPlayer) {
  const defendingPlayerIdx = state.players.indexOf(defendingPlayer);
  const attackingPlayerIdx = state.players.indexOf(attackingPlayer);
  const candidates = collectBlockCandidates(defendingPlayer, attacker, target, attackingPlayer);
  if (candidates.length === 0) return null;

  let bestScore = -Infinity;
  let bestChoice = null;

  for (const choice of [null, ...candidates]) {
    const clone = cloneState(state);
    const cloneAttacker = findInstanceById(clone, attacker.id);
    const cloneTarget = target.type === 'unit' ? { type: 'unit', instance: findInstanceById(clone, target.instance.id) } : target;
    const cloneChoice = choice ? findInstanceById(clone, choice.id) : null;

    resolveFromBlockDecision(clone, attackingPlayerIdx, cloneAttacker, cloneTarget, cloneChoice, defaultHooks());

    const score = scoreState(clone, defendingPlayerIdx);
    if (score > bestScore) {
      bestScore = score;
      bestChoice = choice;
    }
  }

  return bestChoice;
}

/** Real top-level hooks: attack-target selection during blocking gets the true simulate-and-score search; everything else (Burst reveal choice) stays the same simple rule. */
function lookaheadHooks(state) {
  return {
    chooseBlocker: (defendingPlayer, attacker, target, attackingPlayer) =>
      chooseBlockerLookahead(state, defendingPlayer, attacker, target, attackingPlayer),
    chooseBurst,
    actionStep,
    chooseDiscards
  };
}

/** No lookahead anywhere -- used internally as the opponent's stand-in policy inside the *Lookahead searches' simulated trials, so a search never spawns another (much more expensive) search. */
function runPreAttackStepsSimple(state, playerIdx) {
  const player = state.players[playerIdx];
  runCommands(state, player);
  runDeploys(state, player);
  runPairings(state, player);
  runActivations(state, playerIdx);
}

function runPreAttackStepsLookahead(state, playerIdx) {
  runCommandsLookahead(state, playerIdx);
  runDeploysLookahead(state, playerIdx);
  runPairingsLookahead(state, playerIdx);
  runActivations(state, playerIdx);
}

/** Plain main phase, no lookahead -- used internally as the opponent's stand-in policy inside runAttacksLookahead's simulated trials, so a search never spawns another search. */
function runMainPhaseSimple(state, playerIdx, hooks = defaultHooks()) {
  runPreAttackStepsSimple(state, playerIdx);
  runAttacks(state, playerIdx, hooks);
}

function runMainPhase(state, playerIdx, hooks = lookaheadHooks(state), depth = 0) {
  runPreAttackStepsLookahead(state, playerIdx);
  runAttacksLookahead(state, playerIdx, hooks, depth);
}

module.exports = {
  decideMulligan,
  runMainPhase,
  runMainPhaseSimple,
  runCommands,
  runCommandsLookahead,
  runDeploys,
  runDeploysLookahead,
  runPairings,
  runPairingsLookahead,
  runActivations,
  runAttacks,
  runAttacksLookahead,
  collectAttackCandidates,
  collectDeployCandidates,
  collectCommandCandidates,
  canDeployBase,
  chooseAttackTarget,
  chooseBlocker,
  chooseBlockerLookahead,
  actionStep,
  getForcedAttackTargets,
  chooseDiscards,
  defaultHooks,
  lookaheadHooks,
  COMBO_SEARCH_WEIGHT
};
