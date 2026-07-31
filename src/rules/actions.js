const { createInstance } = require('./state');
const { enforceBattleAreaLimit } = require('./management');
const { fireCardEffect } = require('./effects');

function matchesLinkCondition(pilotDef, linkCondition) {
  if (!linkCondition) return false;
  const name = pilotDef.name || '';
  const traits = pilotDef.traits || [];
  return name.includes(linkCondition) || traits.includes(linkCondition);
}

/** Deploys a Unit from a card def (3-2), firing its Deploy effect. Cost payment happens upstream. */
function deployUnit(state, player, def, chooseToTrash) {
  const unit = createInstance(def, player.id);
  unit.turnDeployed = state.turnNumber;
  player.battleArea.push(unit);
  enforceBattleAreaLimit(player, chooseToTrash);
  fireCardEffect(state, player, unit, 'deploy', {});
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

/** Plays a Command card (3-4): fires its effect, then trashes it once activation finishes (4-9-1). */
function playCommand(state, player, def) {
  const instance = createInstance(def, player.id);
  fireCardEffect(state, player, instance, 'command', {});
  player.trash.push(instance);
  return instance;
}

/** Pairs a Pilot with a Unit (3-3, 3-2-6), firing When Paired and, if linked, When Linked (13-2-9/11). */
function pairPilot(state, player, unit, pilotInstance) {
  if (unit.def.cannotBePaired) return unit;
  unit.pilot = pilotInstance;
  const idx = player.hand.indexOf(pilotInstance);
  if (idx !== -1) player.hand.splice(idx, 1);

  const linked = matchesLinkCondition(pilotInstance.def, unit.def.linkCondition);
  if (linked) unit.isLinkUnit = true;

  fireCardEffect(state, player, unit, 'whenPaired', { pilot: pilotInstance });
  if (linked) fireCardEffect(state, player, unit, 'whenLinked', { pilot: pilotInstance });

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

module.exports = { deployUnit, deployBase, becomeBase, playCommand, pairPilot, pairPilotFromTrash, matchesLinkCondition };
