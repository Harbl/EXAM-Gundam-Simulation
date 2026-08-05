const { createInstance } = require('./state');
const { enforceBattleAreaLimit, destroyCard, effectivePilotDef } = require('./management');
const { fireCardEffect } = require('./effects');

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

/** Plays a Command card (3-4): fires its effect, then trashes it once activation finishes (4-9-1). */
function playCommand(state, player, def, opts = {}) {
  const instance = createInstance(def, player.id);
  state.resolvingCommand = true;
  // Indiscriminate Violence GD04-106 / Witches from Earth GD04-108: "If you use an EX Resource to
  // play this card, ..." -- a self-referential check the card's own `command` handler needs,
  // distinct from the friendlyPlaysCommand broadcast below (which tells OTHER cards about this).
  fireCardEffect(state, player, instance, 'command', { usedExResource: opts.usedExResource });
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
  findEvolveTarget,
  deployByEvolve
};
