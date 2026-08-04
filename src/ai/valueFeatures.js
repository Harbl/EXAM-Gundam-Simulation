const { getAP, getRemainingHP, getKeywords, trashSynergyValue } = require('../rules/management');
const { collectActivateCandidates } = require('./activations');
const { LIMITS } = require('../rules/constants');

// Reasoned caps for stats that have no fixed rules maximum (unlike shields/hand/battle area/resources,
// which are hard rules limits from LIMITS) -- picked generously above what a real game state reaches,
// same "reasoned starting point" style as score.js's hand-picked weights.
const BASE_HP_CAP = 20;
const BOARD_STAT_CAP = 30; // per side, for summed AP or summed remaining HP across the battle area
const MAX_UNIT_STAT_CAP = 15; // per side, for a single unit's AP or remaining HP (well under the sum cap)
const ACTIVATION_POTENTIAL_CAP = 5;
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
 * Phase 7b (2026-08-04): added 6 more per-side stats the original 21-feature/24-hidden-unit champion
 * plateaued without -- neither it nor the linear scoreState formula represents Blocker/First Strike
 * keyword presence, single-unit AP/HP concentration (boardAP/boardHP are pure sums, so one 10-AP unit
 * and five 2-AP units score identically), or how much of the board can actually act this turn
 * (rested/Link status). maxUnitAP/maxUnitHP, blockerCount/firstStrikeCount, and restedCount/
 * linkUnitCount close those gaps, reusing getKeywords (rules/management.js) the same way combat
 * resolution already does -- no new helpers needed.
 */
function extractFeatures(state, playerIdx) {
  const self = state.players[playerIdx];
  const enemy = state.players[1 - playerIdx];

  const f = [];
  pushSide(f, self, state, playerIdx);
  pushSide(f, enemy, state, 1 - playerIdx);
  f.push(clamp01(state.turnNumber / TURN_CAP));
  return f;
}

function pushSide(f, player, state, playerIdxForActivations) {
  const baseHP = player.base ? getRemainingHP(player.base) : 0;
  const boardAP = player.battleArea.reduce((sum, u) => sum + getAP(u), 0);
  const boardHP = player.battleArea.reduce((sum, u) => sum + getRemainingHP(u), 0);
  const maxUnitAP = player.battleArea.reduce((max, u) => Math.max(max, getAP(u)), 0);
  const maxUnitHP = player.battleArea.reduce((max, u) => Math.max(max, getRemainingHP(u)), 0);
  const blockerCount = player.battleArea.filter((u) => getKeywords(u).blocker).length;
  const firstStrikeCount = player.battleArea.filter((u) => getKeywords(u).firstStrike).length;
  const restedCount = player.battleArea.filter((u) => u.rested).length;
  const linkUnitCount = player.battleArea.filter((u) => u.isLinkUnit).length;
  const normalResources = player.resourceArea.filter((r) => !r.def.isToken).length;
  const exResourceHeld = player.resourceArea.some((r) => r.def.isToken) ? 1 : 0;
  const activationPotential = collectActivateCandidates(state, playerIdxForActivations).length;

  f.push(
    clamp01(player.shields.length / LIMITS.SHIELD_COUNT),
    clamp01(baseHP / BASE_HP_CAP),
    clamp01(boardAP / BOARD_STAT_CAP),
    clamp01(boardHP / BOARD_STAT_CAP),
    clamp01(maxUnitAP / MAX_UNIT_STAT_CAP),
    clamp01(maxUnitHP / MAX_UNIT_STAT_CAP),
    clamp01(blockerCount / LIMITS.MAX_BATTLE_AREA),
    clamp01(firstStrikeCount / LIMITS.MAX_BATTLE_AREA),
    clamp01(restedCount / LIMITS.MAX_BATTLE_AREA),
    clamp01(linkUnitCount / LIMITS.MAX_BATTLE_AREA),
    clamp01(player.battleArea.length / LIMITS.MAX_BATTLE_AREA),
    clamp01(player.hand.length / LIMITS.MAX_HAND),
    clamp01(normalResources / LIMITS.RESOURCE_DECK_SIZE),
    exResourceHeld,
    clamp01(activationPotential / ACTIVATION_POTENTIAL_CAP),
    clamp01(trashSynergyValue(player))
  );
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const FEATURE_COUNT = 33; // 16 per side x 2 + turnNumber

module.exports = { extractFeatures, FEATURE_COUNT };
