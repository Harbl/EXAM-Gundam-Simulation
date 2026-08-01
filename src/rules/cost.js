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

function payCost(player, def) {
  const active = player.resourceArea.filter((r) => !r.rested);
  for (let i = 0; i < (def.cost || 0); i++) active[i].rested = true;
}

module.exports = { canAfford, payCost };
