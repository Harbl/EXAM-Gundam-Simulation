/**
 * 2-9-1: a card's Level is satisfied when the number of Resources in your resource area (active or
 * rested) is >= the card's Level. 2-10-1: Cost is paid by resting that many active Resources -- any
 * of them, since Resources are colorless (2-4-2) and have no other distinguishing property.
 */
function canAfford(player, def) {
  if (player.resourceArea.length < (def.level || 0)) return false;
  const active = player.resourceArea.filter((r) => !r.rested);
  return active.length >= (def.cost || 0);
}

/** 5-17-3-2-3: an EX Resource (or any Resource token) is removed from the game the moment it's
 * spent, rather than just resting -- a one-time bonus, not a recurring one. */
function payCost(player, def) {
  const active = player.resourceArea.filter((r) => !r.rested);
  for (let i = 0; i < (def.cost || 0); i++) {
    const resource = active[i];
    if (resource.def.isToken) {
      player.resourceArea.splice(player.resourceArea.indexOf(resource), 1);
    } else {
      resource.rested = true;
    }
  }
}

module.exports = { canAfford, payCost };
