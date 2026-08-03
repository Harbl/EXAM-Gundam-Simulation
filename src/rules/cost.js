/**
 * 2-9-1: a card's Level is satisfied when the number of Resources in your resource area (active or
 * rested) is >= the card's Level. 2-10-1: Cost is paid by resting that many active Resources -- any
 * of them, since Resources are colorless (2-4-2) and have no other distinguishing property.
 */
/**
 * Jegan GD01-016: "While you have 2 or more (Earth Federation) Units in play, this card in your
 * hand gets cost -1" -- a live board-state check on the card's cost while it's still in hand,
 * distinct from every other cost field which is static.
 */
function effectiveCost(player, def, opts = {}) {
  let cost = def.cost || 0;
  const reduction = def.handCostReduction;
  if (reduction) {
    // Gundam Kyrios (Tail Unit Flight Mode) GD03-030: "While you have a (CB) Link Unit in play,
    // this card in your hand gets cost -1" -- same shape as Jegan above, plus an optional
    // isLinkUnit requirement on the counted candidates.
    // Union Flag GD03-082: "While you have 2 or more (Superpower Bloc)/(UN) Units in play..." --
    // `traits` (plural) is an OR list, for reductions keyed off more than one trait at once.
    // Dijeh GD05-008: "While you have a non-blue (Newtype) Pilot in play, this card in your hand
    // gets cost -2" -- same threshold shape, but counting paired Pilots (by trait + excluded color)
    // instead of Units.
    const traitList = reduction.traits || [reduction.trait];
    const count = reduction.pilotTrait
      ? player.battleArea.filter(
          (u) =>
            u.pilot &&
            (u.pilot.def.traits || []).includes(reduction.pilotTrait) &&
            (!reduction.excludeColor || u.pilot.def.color !== reduction.excludeColor)
        ).length
      : player.battleArea.filter(
          (u) => (u.def.traits || []).some((t) => traitList.includes(t)) && (!reduction.linkUnitOnly || u.isLinkUnit)
        ).length;
    if (count >= reduction.count) cost = Math.max(0, cost - reduction.amount);
  }
  // Gundam Aerial GD01-070: "While there are 4+ Command cards in your trash, this card in your
  // hand gets cost -2" -- the same live-board-state-while-in-hand idea as Jegan, keyed off trash
  // card type/count instead of a battlefield trait count.
  const trashReduction = def.trashCostReduction;
  if (trashReduction) {
    // Rozen Zulu GD04-039: "If there are 8 or more (Neo Zeon) cards in your trash, this card in
    // your hand gets cost -4" -- same trashCostReduction shape as Aerial above, but keyed off a
    // trait rather than a card type (either filter is optional so old `type`-only defs still work).
    const count = player.trash.filter(
      (c) =>
        (!trashReduction.type || c.def.type === trashReduction.type) &&
        (!trashReduction.trait || (c.def.traits || []).includes(trashReduction.trait))
    ).length;
    if (count >= trashReduction.count) cost = Math.max(0, cost - trashReduction.amount);
  }
  // GN-X GD04-075: "Reduce the cost of this card in your hand by an amount equal to the number of
  // (UN)/(Superpower Bloc) Command cards in your trash" -- unlike trashCostReduction above (a fixed
  // amount once a count threshold is met), this scales 1:1 with the matching count, no threshold.
  const scalingReduction = def.costReductionPerTrashCard;
  if (scalingReduction) {
    const traitList = scalingReduction.traits || [scalingReduction.trait];
    const count = player.trash.filter(
      (c) =>
        (!scalingReduction.type || c.def.type === scalingReduction.type) &&
        (c.def.traits || []).some((t) => traitList.includes(t))
    ).length;
    cost = Math.max(0, cost - count);
  }
  // Farsia GD03-058: "This card in your trash gets cost -1" -- only relevant when something is
  // paying its cost to deploy it out of the trash zone (e.g. Gundam X Divider GD03-051), so it's
  // gated on the caller explicitly flagging that context rather than always-on.
  if (opts.fromTrash && def.costReductionInTrash) cost = Math.max(0, cost - def.costReductionInTrash);
  // Christina Mackenzie GD03-085: "When playing this card from your hand and pairing it with a
  // Unit with 'Gundam NT-1' in its card name, play this card as if it has 0 cost" -- like
  // costReductionInTrash above, gated on the caller explicitly flagging the pairing target rather
  // than always-on.
  if (def.freeCostIfPairUnitNameIncludes && opts.pairUnit && (opts.pairUnit.def.name || '').includes(def.freeCostIfPairUnitNameIncludes)) {
    cost = 0;
  }
  // Gaia Gundam (MA Mode) (U+) GD05-041: "During a turn where your opponent has discarded due to
  // one of your effects, this card in your hand gets cost -2" -- reads the player-level turn flag
  // forceEnemyDiscard (src/effects/registry.js) sets, cleared each turn by clearTurnBuffs.
  if (def.costReductionIfEnemyDiscardedByEffect && player.enemyDiscardedByEffectThisTurn) {
    cost = Math.max(0, cost - def.costReductionIfEnemyDiscardedByEffect);
  }
  cost = Math.max(0, cost - scalingLevelCostReduction(player, def, opts));
  return cost;
}

/**
 * Akatsuki (Oowashi) GD05-004: "While you have no Units that are Lv.6 or higher in play, this card
 * in your hand gets Lv.-1 and cost -1 for each of your (Orb) Units in play" -- unlike every
 * threshold reduction above (a fixed amount once a count is met), this scales 1:1 with a live count
 * and applies to BOTH Level and Cost, so it's a standalone helper shared by canAfford and
 * effectiveCost rather than folded into either one.
 */
function scalingLevelCostReduction(player, def, opts = {}) {
  const cfg = def.handLevelAndCostReductionPerTrait;
  if (cfg) {
    if (cfg.gateNoUnitLevelAtLeast !== undefined && player.battleArea.some((u) => (u.def.level || 0) >= cfg.gateNoUnitLevelAtLeast)) {
      return 0;
    }
    return player.battleArea.filter((u) => (u.def.traits || []).includes(cfg.trait)).length;
  }
  // Destroy Gundam (R+) GD05-037: "While an enemy player has 7 or more cards in their trash, this
  // card in your hand gets Lv.-3 and cost -3" -- the only reduction keyed off the OPPONENT's board
  // state rather than the controller's own, so it needs the full game state (threaded through by
  // opts.state from every canAfford/effectiveCost call site that has it) to find them.
  const enemyCfg = def.enemyTrashLevelAndCostReduction;
  if (enemyCfg && opts.state) {
    const enemy = opts.state.players.find((p) => p !== player);
    if (enemy && enemy.trash.length >= enemyCfg.count) return enemyCfg.amount;
  }
  // Xi Gundam (LR) ST08-001: "While you have no Units that are Lv.6 or higher in play, this card in
  // your hand gets Lv.-1 and cost -1 for each enemy Unit in play" -- same handLevelAndCostReductionPerTrait
  // shape as Akatsuki (Oowashi) above, but scaling with the OPPONENT's total Unit count instead of a
  // trait-filtered count of the controller's own Units.
  const enemyUnitCfg = def.handLevelAndCostReductionPerEnemyUnit;
  if (enemyUnitCfg && opts.state) {
    if (enemyUnitCfg.gateNoUnitLevelAtLeast !== undefined && player.battleArea.some((u) => (u.def.level || 0) >= enemyUnitCfg.gateNoUnitLevelAtLeast)) {
      return 0;
    }
    const enemy = opts.state.players.find((p) => p !== player);
    return enemy ? enemy.battleArea.length : 0;
  }
  return 0;
}

function canAfford(player, def, opts = {}) {
  const level = Math.max(0, (def.level || 0) - scalingLevelCostReduction(player, def, opts));
  if (player.resourceArea.length < level) return false;
  const active = player.resourceArea.filter((r) => !r.rested);
  return active.length >= effectiveCost(player, def, opts);
}

/** 5-17-3-2-3: an EX Resource (or any Resource token) is removed from the game the moment it's
 * spent, rather than just resting -- a one-time bonus, not a recurring one. Since a *rested* normal
 * Resource still counts toward Level (2-9-1: active or rested both count), but a spent token is
 * gone and never counts again, paying with normal Resources first (falling back to a token only
 * once normal Resources run out) never costs anything and preserves the Level lead a token
 * represents for as long as possible -- this is a real, well-known strategic reason to hold an EX
 * Resource, not just a minor optimization, so it isn't a heuristic tradeoff to get right, it's
 * strictly correct payment order. */
function payCost(player, def, opts = {}) {
  const active = player.resourceArea.filter((r) => !r.rested);
  const ordered = [...active.filter((r) => !r.def.isToken), ...active.filter((r) => r.def.isToken)];
  let usedExResource = false;
  for (let i = 0; i < effectiveCost(player, def, opts); i++) {
    const resource = ordered[i];
    if (resource.def.isToken) {
      player.resourceArea.splice(player.resourceArea.indexOf(resource), 1);
      usedExResource = true;
    } else {
      resource.rested = true;
    }
  }
  // Gundam Calibarn GD05-018: "When one of your EX Resources is exiled from the game, you may
  // choose 1 of your Units..." -- fired here, the one real chokepoint where an EX Resource token
  // actually leaves play, so any payCost call site can reach it by opting in with opts.state. Only
  // wired at the call sites paying a printed deploy/command/pairing cost (src/ai/heuristic.js) for
  // now, not the narrower "redeploy from trash" cost payments elsewhere in the registry, per the
  // forward-only scoping convention.
  if (usedExResource && opts.state) {
    for (const source of [...player.battleArea, player.base].filter(Boolean)) {
      const handler = source.def.effects && source.def.effects.friendlyExResourceExiled;
      if (handler) handler(opts.state, player, source, {});
    }
  }
  // Gundam Lfrith Ur GD04-020 / Gundam Lfrith Thorn GD04-021: "...using an EX Resource" -- callers
  // that need to know need the return value, since EX Resources are the only token resource type.
  return usedExResource;
}

module.exports = { canAfford, payCost, effectiveCost };
