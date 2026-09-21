const { getAP, getHP, getRemainingHP, getKeywords } = require('../../src/rules/management');

/**
 * Plain-data view of one card instance for the renderer -- getAP/getHP/etc. already fold in every
 * buff/pilot/link bonus, so the renderer never needs to reimplement any of that live-computed math
 * itself, just display these numbers. Works unmodified for every card type (getAP/getHP default to 0
 * for a type that doesn't carry ap/hp, e.g. a Base or Command) so this needs no type branching.
 */
function serializeInstance(inst) {
  if (!inst) return null;
  return {
    id: inst.id,
    number: inst.def.number,
    name: inst.def.name,
    type: inst.def.type,
    color: inst.def.color,
    level: inst.def.level,
    cost: inst.def.cost,
    ap: getAP(inst),
    hp: getRemainingHP(inst),
    maxHp: getHP(inst),
    damage: inst.damage,
    rested: inst.rested,
    traits: inst.def.traits || [],
    keywords: getKeywords(inst),
    pilot: inst.pilot ? serializeInstance(inst.pilot) : null,
    isLinkUnit: inst.isLinkUnit
  };
}

/**
 * `viewerIdx`'s own hand is sent in full; the opponent's hand is redacted to just a count (7-1: a
 * player's hand is hidden information) -- every other zone (battle area, base, resource area, trash,
 * shield/deck counts) is public per the real rules, so both sides get those in full regardless of
 * viewer.
 */
function serializePlayer(player, idx, viewerIdx) {
  const isViewer = idx === viewerIdx;
  return {
    idx,
    isViewer,
    deckCount: player.deck.length,
    resourceDeckCount: player.resourceDeck.length,
    handCount: player.hand.length,
    hand: isViewer ? player.hand.map(serializeInstance) : [],
    resourceArea: player.resourceArea.map(serializeInstance),
    battleArea: player.battleArea.map(serializeInstance),
    base: serializeInstance(player.base),
    shieldCount: player.shields.length,
    trash: player.trash.map(serializeInstance),
    defeated: player.defeated
  };
}

function serializeStateFor(state, viewerIdx) {
  return {
    turnNumber: state.turnNumber,
    activePlayerIdx: state.activePlayerIdx,
    winner: state.winner,
    draw: state.draw,
    players: state.players.map((p, idx) => serializePlayer(p, idx, viewerIdx))
  };
}

module.exports = { serializeInstance, serializeStateFor };
