const { createInstance } = require('./state');
const { enforceBattleAreaLimit, destroyCard, effectivePilotDef } = require('./management');
const { fireCardEffect, triggerEvent } = require('./effects');

function matchesLinkCondition(pilotDef, linkCondition) {
  if (!linkCondition) return false;
  const name = pilotDef.name || '';
  const traits = pilotDef.traits || [];
  // Quattro Bajeena GD02-098: "This card's name is also treated as [Char Aznable]" -- an alias
  // name that also satisfies any Unit's link condition looking for the real Char Aznable.
  const alias = pilotDef.nameAlias || '';
  // Some cards link off either of two named Pilots (e.g. "Christina Mackenzie/Amuro Ray").
  return linkCondition.split('/').some((cond) => name.includes(cond) || alias.includes(cond) || traits.includes(cond));
}

/**
 * True if a still-undrawn copy of a Unit `pilot` would Link with remains in the player's own deck,
 * AND its `level` beats `currentBestLevel` (default -1, i.e. "nothing at all yet" -- so the default
 * call just asks "is there any Link target left in the deck"). A real player knows their whole
 * decklist (just not draw order, 8-1-3) -- this mirrors that knowledge so the AI can recognize "my
 * real target for this Pilot just hasn't been drawn yet," or "what I've already got isn't as good as
 * what's still coming," instead of only ever reasoning about what's already on board.
 *
 * `level` is a coarse but real proxy for "which Link target is better" -- not universally true (a
 * cheap support piece can occasionally out-value a bigger body), but a defensible default absent any
 * card-specific value model, same kind of judgment call as the "Heuristic default" choices documented
 * throughout registry.js. Used by runPairings/resolvePairingSubset (heuristic.js) and
 * collectPairCandidates/the 'pair' action executor (mcts.js) to decide whether pairing this Pilot onto
 * whatever's available right now (nothing, or an already-in-play but lesser match) is worth giving up
 * a shot at a stronger target once drawn.
 */
function hasBetterLinkTargetInDeck(player, pilot, currentBestLevel = -1) {
  const pilotDef = effectivePilotDef(pilot);
  return player.deck.some(
    (c) => c.def.type === 'unit' && matchesLinkCondition(pilotDef, c.def.linkCondition) && (c.def.level || 0) > currentBestLevel
  );
}

/**
 * Highest-`level` unpaired Unit among `targets` whose Link condition `pilot` satisfies, or null if
 * none match -- "best" by the same level proxy hasBetterLinkTargetInDeck uses, so the two stay
 * consistent (comparing an in-play candidate against what the deck could still offer).
 */
function bestLinkMatch(targets, pilot) {
  const pilotDef = effectivePilotDef(pilot);
  const matches = targets.filter((u) => matchesLinkCondition(pilotDef, u.def.linkCondition));
  if (matches.length === 0) return null;
  return matches.reduce((best, u) => ((u.def.level || 0) > (best.def.level || 0) ? u : best));
}

/**
 * Legitimate, non-peeking "how good are my odds" signal for whether digging (playing a draw-producing
 * Command) is worth prioritizing right now -- for the first unpaired hand Pilot whose best available
 * in-play Link match (if any) is still beaten by something left in the deck (the exact same "worth
 * holding out for" gate runPairings/chooseDiscards already use), returns
 * `copies of its real Link target still in the deck / total deck size`. Both are real "knows the whole
 * decklist" facts (8-1-3 draw order stays hidden) -- this deliberately never looks at which specific
 * card any particular draw would reveal, only the aggregate odds, so it can't be used to retroactively
 * credit a lucky simulated draw. Naturally rises over the course of a real game as the deck thins from
 * ordinary turn draws, without knowing anything about draw order -- see runCommandsLookahead
 * (heuristic.js) for why that distinction is the whole point of this function existing separately from
 * a simpler "is there a target left" boolean.
 */
function comboSearchOdds(player) {
  const deckSize = player.deck.length;
  if (deckSize === 0) return 0;
  const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
  const pilot = player.hand.find((c) => {
    if (c.def.type !== 'pilot' && !c.def.pilotMode) return false;
    const best = bestLinkMatch(targets, c);
    const bestLevel = best ? (best.def.level || 0) : -1;
    return hasBetterLinkTargetInDeck(player, c, bestLevel);
  });
  if (!pilot) return 0;
  const pilotDef = effectivePilotDef(pilot);
  const copies = player.deck.filter((c) => c.def.type === 'unit' && matchesLinkCondition(pilotDef, c.def.linkCondition)).length;
  return copies / deckSize;
}

/** Deploys a Unit from a card def (3-2), firing its Deploy effect. Cost payment happens upstream. */
function deployUnit(state, player, def, chooseToTrash, context = {}) {
  const unit = createInstance(def, player.id);
  unit.turnDeployed = state.turnNumber;
  // Kikeroga (MS Mode) (GQ) (R+) GD04-022: "[During Link] All Units that are Lv.3 or lower other
  // than Unit tokens are deployed rested" -- unlike every other "deploy X rested" effect (which sets
  // .rested on its own returned instance), this is a symmetric static field affecting ANY Unit either
  // player deploys, so it's checked here against both players' battle areas rather than the deploying
  // effect itself. "All Units" (no "your") matches the same both-players reading used by GD03-047's
  // and GD02-032's board wipes.
  if (!def.isToken && state.players) {
    for (const p of state.players) {
      for (const u of p.battleArea) {
        if (u.isLinkUnit && u.def.deployRestedAuraLvCap !== undefined && (def.level || 0) <= u.def.deployRestedAuraLvCap) {
          unit.rested = true;
        }
        // Gundam Aerial Rebuild GD05-026: "Count up the number of your Units with 'Gundam Lfrith'/
        // 'Gundnode' in their card name, plus this Unit. All enemy Units whose Lv. is equal to or
        // lower than that number are deployed rested" -- same "deploy rested" aura shape as Kikeroga
        // above, but not Link-gated, with a live name-substring count instead of a fixed cap, and
        // scoped to the aura owner's actual enemy (p !== player) rather than both sides.
        const nameCfg = u.def.deployRestedAuraNameIncludesAny;
        if (nameCfg && p !== player) {
          const count = 1 + p.battleArea.filter((x) => x !== u && nameCfg.some((s) => (x.def.name || '').includes(s))).length;
          if ((def.level || 0) <= count) unit.rested = true;
        }
      }
    }
  }
  player.battleArea.push(unit);
  enforceBattleAreaLimit(player, chooseToTrash);
  fireCardEffect(state, player, unit, 'deploy', context);
  // Neo Zeong (LR+) GD04-033: "When this Unit or one of your (Neo Zeon) Units is deployed..." -- a
  // team-wide reaction to ANY qualifying Unit deploy, same broadcast shape as friendlyPlaysCommand/
  // allyPaired above.
  for (const source of [...player.battleArea, player.base].filter(Boolean)) {
    const handler = source.def.effects && source.def.effects.friendlyUnitDeployed;
    if (handler) handler(state, player, source, { deployedUnit: unit });
  }
  return unit;
}

/** Deploys a Base (3-5); a Base already in the slot is bumped to trash untouched (11-5). */
function deployBase(state, player, def) {
  const base = createInstance(def, player.id);
  if (player.base) player.trash.push(player.base);
  player.base = base;
  fireCardEffect(state, player, base, 'deploy', {});
  return base;
}

/**
 * For "Burst: deploy this card" Bases (e.g. Jaburo): reuses the same card instance rather than
 * creating a new one, since it's coming from the shield area, not the hand.
 */
function becomeBase(state, player, instance) {
  if (player.base) player.trash.push(player.base);
  instance.turnDeployed = state.turnNumber;
  player.base = instance;
  fireCardEffect(state, player, instance, 'deploy', {});
  return instance;
}

/**
 * Master Asia (King of Hearts) GD05-089: once 3+ (MF) cards sit in trash, its own Burst deploys it
 * straight into the battle area as a Unit instead of going to hand -- reuses the same card instance,
 * coming from the Shield area rather than hand, same "shield transforms directly into a board
 * presence" shape as becomeBase above (just battleArea instead of the Base slot). Pulled out purely so
 * the replay trace has something to patch -- without it, the Unit would just vanish from the game
 * entirely in the replay viewer instead of appearing on the board.
 */
function becomeUnit(state, player, instance) {
  player.battleArea.push(instance);
  return instance;
}

/**
 * "Mode Change" family (e.g. Unicorn Gundam (Destroy Mode) GD01-002): "you may destroy 1 of your
 * Link Units with [nameIncludes] in its card name that is Lv.[level]. If you do, play this card as
 * if it has 0 Lv. and cost." A genuinely optional alternate deploy method, not a cost reduction --
 * bypasses normal cost payment (and its own Lv./Cost requirement) entirely rather than discounting it.
 */
function findEvolveTarget(player, def) {
  const cond = def.evolveCondition;
  if (!cond) return null;
  return (
    player.battleArea.find(
      (u) => u.isLinkUnit && (u.def.level || 0) === cond.level && (u.def.name || '').includes(cond.nameIncludes)
    ) || null
  );
}

/** Destroys `target` (firing its own Destroyed trigger, 13-2-8) to pay for deploying `def` for free. */
function deployByEvolve(state, player, def, target) {
  const pilot = target.pilot;
  destroyCard(state, player, target);
  fireCardEffect(state, player, target, 'destroyed', { wasPaired: !!pilot, pilot });
  return deployUnit(state, player, def);
}

/** Plays a Command card (3-4): fires its effect, then trashes it once activation finishes (4-9-1).
 * `opts.extraContext`, if given, is merged into the 'command' handler's context -- used by an
 * Action-step reactive play (see combat.js's actionStep hook) to pass a mutable `battleTarget`
 * {type,instance} ref and `hooks.chooseUnit` through, the same shape those cards already expect. */
function playCommand(state, player, def, opts = {}) {
  const instance = createInstance(def, player.id);
  state.resolvingCommand = true;
  // Indiscriminate Violence GD04-106 / Witches from Earth GD04-108: "If you use an EX Resource to
  // play this card, ..." -- a self-referential check the card's own `command` handler needs,
  // distinct from the friendlyPlaysCommand broadcast below (which tells OTHER cards about this).
  fireCardEffect(state, player, instance, 'command', { usedExResource: opts.usedExResource, ...opts.extraContext });
  state.resolvingCommand = false;
  player.trash.push(instance);
  // Gundam Lfrith Ur GD04-020 / Gundam Lfrith Thorn GD04-021: "when you play and activate a (Dawn of
  // Fold) Command card using an EX Resource..." -- a team-wide reaction to ANY qualifying Command the
  // controller plays, same allyPaired broadcast shape as pairPilot below.
  for (const source of [...player.battleArea, player.base].filter(Boolean)) {
    // Suletta Mercury (R+) GD04-085: a Pilot-granted friendlyPlaysCommand (as opposed to a Unit's own,
    // like Gundam Lfrith Ur above) previously never fired -- this broadcast only checked the Unit's
    // own def.effects, never its paired Pilot's, so Suletta's ability was silently dead in real play
    // (only the isolated unit test exercising the registry function directly ever "passed"). Fixed by
    // falling back to the paired Pilot's own effectRefs, same instance-as-`source` shape fireCardEffect
    // already uses for pilot forwarding elsewhere.
    const handler =
      (source.def.effects && source.def.effects.friendlyPlaysCommand) ||
      (source.pilot && source.pilot.def.effects && source.pilot.def.effects.friendlyPlaysCommand);
    if (handler) handler(state, player, source, { commandInstance: instance, usedExResource: opts.usedExResource });
  }
  return instance;
}

/** Pairs a Pilot with a Unit (3-3, 3-2-6), firing When Paired and, if linked, When Linked (13-2-9/11). */
function pairPilot(state, player, unit, pilotInstance) {
  if (unit.def.cannotBePaired) return unit;
  unit.pilot = pilotInstance;
  const idx = player.hand.indexOf(pilotInstance);
  if (idx !== -1) player.hand.splice(idx, 1);

  const linked = matchesLinkCondition(effectivePilotDef(pilotInstance), unit.def.linkCondition);
  if (linked) unit.isLinkUnit = true;

  fireCardEffect(state, player, unit, 'whenPaired', { pilot: pilotInstance });
  if (linked) fireCardEffect(state, player, unit, 'whenLinked', { pilot: pilotInstance });

  // Freedom Gundam GD01-065: "When you pair a Pilot with this Unit or one of your white Units" --
  // a team-wide reaction to ANY pairing the controller makes, distinct from the unit-scoped
  // whenPaired trigger above, so it's broadcast to every card the pairing player controls.
  for (const source of [...player.battleArea, player.base].filter(Boolean)) {
    const handler = source.def.effects && source.def.effects.allyPaired;
    if (handler) handler(state, player, source, { pairedUnit: unit, pilot: pilotInstance });
  }

  // "During Pair"/"During Link" text (e.g. Gundam ST01-001's "all your Units get AP+1") is a
  // continuous static ability, live for as long as the pairing holds -- NOT a one-time trigger like
  // When Paired above. Every card in the pool that implements one of these (grep confirms ~15+,
  // Gundam ST01-001/Freedom Gundam/Cyclops Team/etc.) does so via a `startOfTurn`-wired handler that
  // recomputes a `grantedStatBonus`/`grantedKeywords`/turn-scoped-buff value, on the assumption it
  // only needs re-checking once per turn. That's correct for triggerEvent's own real start-of-turn
  // call (phases.js), but wrong here: pairing mid-turn (as just happened above) should activate any
  // "During Pair" aura this unit (or pilot) grants immediately, for the rest of THIS turn too, not
  // just from next turn's start phase onward. Every startOfTurn handler in the pool is a pure,
  // idempotent stat/keyword recompute (verified: none of them draw/damage/destroy/place resources),
  // so re-broadcasting the same event here is safe and just re-syncs every aura to the new board
  // state -- both players', since a pairing can also flip off an opponent-facing condition (e.g. "no
  // enemy Base in play").
  triggerEvent(state, 'startOfTurn', {});

  return unit;
}

/**
 * Pairs a card sitting in the trash (e.g. Cyclone Punch GD05-121: "you may pair this card from your
 * trash with one of your (MF) Units") rather than one from hand.
 */
function pairPilotFromTrash(state, player, unit, trashInstance) {
  const idx = player.trash.indexOf(trashInstance);
  if (idx !== -1) player.trash.splice(idx, 1);
  return pairPilot(state, player, unit, trashInstance);
}

module.exports = {
  deployUnit,
  deployBase,
  becomeBase,
  becomeUnit,
  playCommand,
  pairPilot,
  pairPilotFromTrash,
  matchesLinkCondition,
  hasBetterLinkTargetInDeck,
  bestLinkMatch,
  comboSearchOdds,
  findEvolveTarget,
  deployByEvolve
};
