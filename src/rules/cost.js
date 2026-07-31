/** A card's Level is a minimum-resources-in-play threshold; its Cost is paid by resting that many active Resources matching its color. */
function canAfford(player, def) {
  if (player.resourceArea.length < (def.level || 0)) return false;
  const activeMatching = player.resourceArea.filter((r) => !r.rested && r.def.color === def.color);
  return activeMatching.length >= (def.cost || 0);
}

function payCost(player, def) {
  const activeMatching = player.resourceArea.filter((r) => !r.rested && r.def.color === def.color);
  for (let i = 0; i < (def.cost || 0); i++) activeMatching[i].rested = true;
}

module.exports = { canAfford, payCost };
