const { getAP, getRemainingHP, getKeywords, trashSynergyValue } = require('../rules/management');
const { collectActivateCandidates } = require('./activations');
const { LIMITS } = require('../rules/constants');

// Reasoned caps for stats that have no fixed rules maximum (unlike shields/hand/battle area/resources,
// which are hard rules limits from LIMITS) -- picked generously above what a real game state reaches,
// same "reasoned starting point" style as score.js's hand-picked weights.
const BASE_HP_CAP = 20;
const BOARD_STAT_CAP = 30; // per side, for summed AP or summed remaining HP across the battle area
const ACTIVATION_POTENTIAL_CAP = 5;
const BLOCKER_CAP = 3; // generous ceiling on simultaneous untapped Blocker-keyword units
const TURN_CAP = 30;

/**
 * Converts a game state into a fixed-length array of normalized numbers for valueNet.js, symmetric
 * self ('playerIdx') vs. enemy. Reuses the exact same helpers score.js's linear boardValue already
 * uses (getAP/getRemainingHP, collectActivateCandidates, trashSynergyValue) rather than recomputing
 * anything, so this stays consistent with what the hand-tuned formula already considers meaningful.
 *
 * `resourceArea` conflates two differently-capped pools: the 10-card normal Resource deck
 * (LIMITS.RESOURCE_DECK_SIZE) and up to LIMITS.MAX_EX_RESOURCE (5) held EX Resource tokens. Counting
 * only non-token resources here (scaled by the true 10-card ceiling) avoids underselling a player who
 * has already placed all 10 normal Resources -- the EX Resource's own contribution is captured by the
 * separate exResourceHeld flag instead (see score.js's exResourceHeld weight for the same reasoning).
 *
 * Added (2026-08-05): boardAP/boardHP above sum *every* unit regardless of rested state, so a board
 * that's fully tapped out from this turn's attacks looks identical to one holding everything back --
 * a real blind spot, since "how much can still act" and "how much already couldn't" are very different
 * positions. activeUnitCount/activeBoardAP/blockerCount (untapped only) and the two threatRatio
 * features below (this side's active board AP against the *other* side's remaining life) all target
 * that gap specifically, rather than just scaling up the existing aggregate-stat shape.
 */
function extractFeatures(state, playerIdx) {
  const self = state.players[playerIdx];
  const enemy = state.players[1 - playerIdx];

  const f = [];
  const selfRaw = pushSide(f, self, state, playerIdx);
  const enemyRaw = pushSide(f, enemy, state, 1 - playerIdx);
  f.push(clamp01(state.turnNumber / TURN_CAP));

  // Coarse proxy, not a real block/lethal simulation (a much bigger lift) -- but it's information the
  // aggregate AP/HP totals above can't represent at all: two boards with identical summed AP can have
  // wildly different follow-up threat depending on whether that AP is spent or held back.
  f.push(clamp01(selfRaw.activeBoardAP / enemyRaw.remainingLife));
  f.push(clamp01(enemyRaw.activeBoardAP / selfRaw.remainingLife));

  return f;
}

function pushSide(f, player, state, playerIdxForActivations) {
  const baseHP = player.base ? getRemainingHP(player.base) : 0;
  const boardAP = player.battleArea.reduce((sum, u) => sum + getAP(u), 0);
  const boardHP = player.battleArea.reduce((sum, u) => sum + getRemainingHP(u), 0);
  const activeUnits = player.battleArea.filter((u) => !u.rested);
  const activeBoardAP = activeUnits.reduce((sum, u) => sum + getAP(u), 0);
  const blockerCount = activeUnits.filter((u) => getKeywords(u).blocker).length;
  const normalResources = player.resourceArea.filter((r) => !r.def.isToken).length;
  const exResourceHeld = player.resourceArea.some((r) => r.def.isToken) ? 1 : 0;
  const activationPotential = collectActivateCandidates(state, playerIdxForActivations).length;
  // Scaled to roughly the same order of magnitude as shields.length (SHIELD_COUNT) so the two combine
  // into one meaningful "how much life is left" denominator for the threatRatio features above. A
  // small floor avoids a 0/0 -> NaN if a side's base is already gone and it's out of shields too.
  const remainingLife = Math.max(0.01, player.shields.length + (baseHP / BASE_HP_CAP) * LIMITS.SHIELD_COUNT);

  f.push(
    clamp01(player.shields.length / LIMITS.SHIELD_COUNT),
    clamp01(baseHP / BASE_HP_CAP),
    clamp01(boardAP / BOARD_STAT_CAP),
    clamp01(boardHP / BOARD_STAT_CAP),
    clamp01(player.battleArea.length / LIMITS.MAX_BATTLE_AREA),
    clamp01(activeUnits.length / LIMITS.MAX_BATTLE_AREA),
    clamp01(activeBoardAP / BOARD_STAT_CAP),
    clamp01(blockerCount / BLOCKER_CAP),
    clamp01(player.hand.length / LIMITS.MAX_HAND),
    clamp01(normalResources / LIMITS.RESOURCE_DECK_SIZE),
    exResourceHeld,
    clamp01(activationPotential / ACTIVATION_POTENTIAL_CAP),
    clamp01(trashSynergyValue(player))
  );

  return { activeBoardAP, remainingLife };
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const FEATURE_COUNT = 29; // 13 per side x 2 + turnNumber + 2 threatRatio

module.exports = { extractFeatures, FEATURE_COUNT };
