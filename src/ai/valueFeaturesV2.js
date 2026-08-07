const { getAP, getRemainingHP, getKeywords } = require('../rules/management');
const { extractFeatures } = require('./valueFeatures');

// Reasoned caps, same "generous headroom above observed printed max" style as valueFeatures.js's
// BASE_HP_CAP/BOARD_STAT_CAP -- printed AP/HP tops out at 7 across the card pool, level at 9.
const UNIT_AP_CAP = 10;
const UNIT_HP_CAP = 10;
const LEVEL_CAP = 10;
const SUPPORT_CAP = 3;
const REPAIR_CAP = 3;
const BREACH_CAP = 5; // stacks via buffs on top of a printed base, so above the usual single-digit printed max
const BUFF_COUNT_CAP = 4;
const COLORS = ['white', 'blue', 'green', 'red', 'purple'];

const UNIT_FEATURE_COUNT = 19; // see extractUnitVector's field order below

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Per-unit feature vector for the DeepSets-style net (deepSetValueNet.js) -- deliberately raw
 * per-unit data (AP/HP/keywords/etc.), not a hand-derived relational signal like valueFeatures.js's
 * vulnerableUnitCount. The point of this representation is to let the net learn cross-unit
 * comparisons itself instead of us hand-deriving them one scalar at a time.
 *
 * Deliberately excludes `def.traits`: an unbounded-cardinality set of distinct strings across the
 * card pool that wouldn't generalize from a one-hot encoding at this net's scale -- the existing
 * trait/color-aware `trashSynergyValue` scalar (already in the `scalars` block) stays the trait
 * signal for now.
 */
function extractUnitVector(u) {
  const keywords = getKeywords(u);
  const colorOneHot = COLORS.map((c) => (u.def.color === c ? 1 : 0));
  return [
    clamp01(getAP(u) / UNIT_AP_CAP),
    clamp01(getRemainingHP(u) / UNIT_HP_CAP),
    u.rested ? 1 : 0,
    u.isLinkUnit ? 1 : 0,
    u.pilot ? 1 : 0,
    u.damage > 0 ? 1 : 0,
    clamp01((u.def.level || 0) / LEVEL_CAP),
    keywords.blocker ? 1 : 0,
    keywords.firstStrike ? 1 : 0,
    keywords.highManeuver ? 1 : 0,
    clamp01((keywords.support || 0) / SUPPORT_CAP),
    clamp01((keywords.repair || 0) / REPAIR_CAP),
    clamp01((keywords.breach || 0) / BREACH_CAP),
    ...colorOneHot,
    clamp01(u.buffs.length / BUFF_COUNT_CAP)
  ];
}

/**
 * The DeepSets counterpart to valueFeatures.js's extractFeatures: reuses it unchanged for the
 * `scalars` segment (single source of truth for the aggregate-stat block), and adds per-unit vectors
 * for every battleArea unit on each side. Variable-length arrays (0-6 per side, LIMITS.MAX_BATTLE_AREA)
 * -- no fixed-slot padding/masking, since mean/max pooling (deepSetValueNet.js) handle variable counts
 * natively and this project's training loop is per-example, not batched, so padding would only add a
 * new bug class for no benefit.
 */
function extractDeepSetFeatures(state, playerIdx) {
  const self = state.players[playerIdx];
  const enemy = state.players[1 - playerIdx];
  return {
    scalars: extractFeatures(state, playerIdx),
    selfUnits: self.battleArea.map(extractUnitVector),
    enemyUnits: enemy.battleArea.map(extractUnitVector)
  };
}

module.exports = { extractUnitVector, extractDeepSetFeatures, UNIT_FEATURE_COUNT };
