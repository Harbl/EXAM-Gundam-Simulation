const { getAP, getRemainingHP, getKeywords, trashSynergyValue, reactiveReserveValue } = require('../rules/management');
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
const REACTIVE_RESERVE_CAP = 6; // reactiveReserveValue is capped by a held card's own cost, and real Command costs top out around here

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
 *
 * vulnerableUnitCount (added 2026-08-05, appended at the end -- see FEATURE_COUNT's comment on why the
 * position matters): `trashSynergyValue` already credits progress toward a trash-gated payoff like Nu
 * Gundam GD05-017's [When Paired] safe-kill snipe, but only as a generic "some payoff is getting
 * closer" scalar -- it has no idea whether a specific unit on the board is actually the free kill that
 * payoff would take. This counts units in a genuinely unsafe spot right now: the same
 * remaining-HP-vs-attacker-AP / own-AP-vs-attacker-remaining-HP shape `chooseBlocker`'s own badTrade
 * check already uses (src/ai/heuristic.js), just aggregated across the whole board instead of one
 * declared attack. Not Nu-Gundam-specific by construction -- it's "how exposed is this board to a free
 * kill, period," which is the actual thing worth knowing regardless of which specific card would cash
 * it in.
 *
 * reactiveReserve (added 2026-08-07, appended at the end for the same old-net-compatibility reason as
 * vulnerableUnitCount above): `normalResources` below counts total Resources, active or rested,
 * identically -- no signal anywhere for whether a player tapped out or is holding Resources open for a
 * real `[Action]`-timing Command in hand. See management.js's reactiveReserveValue for the full
 * reasoning (deploy-timing/board-flooding investigation).
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

  // Appended last, not interspersed -- keeps every existing net's first 29 inputs byte-identical to
  // before (forward()'s loop bound is the net's own stored inputSize, not this file's live
  // FEATURE_COUNT, so an old net just ignores these two tail entries until it's retrained; see
  // valueNet.js's forwardWithCache). A currently-shipped net's predictions are unaffected by this
  // change on their own -- it only starts mattering once a net is trained with the wider vector.
  f.push(clamp01(vulnerableUnitCount(self, enemy) / LIMITS.MAX_BATTLE_AREA));
  f.push(clamp01(vulnerableUnitCount(enemy, self) / LIMITS.MAX_BATTLE_AREA));

  f.push(clamp01(reactiveReserveValue(self) / REACTIVE_RESERVE_CAP));
  f.push(clamp01(reactiveReserveValue(enemy) / REACTIVE_RESERVE_CAP));

  return f;
}

/** Counts `defender`'s battleArea units that at least one of `attacker`'s units could kill in a
 * straight fight without dying back -- same two-sided check chooseBlocker's badTrade gate already
 * uses, just asking "does ANY enemy unit threaten this" per friendly unit instead of one declared
 * attacker. */
function vulnerableUnitCount(defender, attacker) {
  return defender.battleArea.filter((u) =>
    attacker.battleArea.some((e) => getAP(e) >= getRemainingHP(u) && getAP(u) < getRemainingHP(e))
  ).length;
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

const FEATURE_COUNT = 33; // 13 per side x 2 + turnNumber + 2 threatRatio + 2 vulnerableUnitCount + 2 reactiveReserve

module.exports = { extractFeatures, FEATURE_COUNT };
