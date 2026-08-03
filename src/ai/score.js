const { getAP, getRemainingHP } = require('../rules/management');
const { collectActivateCandidates } = require('./activations');

/**
 * Weights tuned via large-sample (n=5000/variant) self-play coordinate descent -- see
 * scratchpad/weight_tune.js. resources:2 beat the original resources:1 (z=2.72); a further probe
 * around this champion (resources 1.5/3, shields 11/12, boardStats 1.5, baseHP 1.5/5) found nothing
 * that beats it, confirming a local optimum. See scoreState for how to A/B alternatives via
 * player.aiWeights.
 *
 * activationPotential added 2026-08-03 (Phase 5 MSA benchmark investigation): without it, boardValue
 * was a pure stat tally (shields/baseHP/boardStats/hand/resources) with zero awareness that a card's
 * real value can come from a repeatable Activate-Main ability rather than raw AP/HP. Root-caused via a
 * hand-read trace: a Nu Gundam deck's AI never once deployed Ra Cailum (its archetype-defining Base,
 * Reduce-1 aura for Londo Bell Units) across multiple real games, instead preferring a generic Base
 * with 1 more raw HP -- because immediately after either deploy, their stat-lines look almost
 * identical to boardValue, and the ability's actual payoff is invisible to it. This one gap alone
 * explains a lot of why self-play win rates diverged so far from real ranked data in the MSA benchmark
 * (scratchpad/benchmark_vs_msa.js): any archetype whose real strength comes from ability synergy gets
 * flattened by the AI into "just a pile of stats that races," while pure stat-line aggro is overvalued.
 * A reasoned starting weight, not yet empirically tuned -- see scratchpad/weight_tune.js for the
 * precedent this should get the same coordinate-descent treatment once there's self-play data.
 *
 * trashSynergy added 2026-08-03 (Barbatos Rush vs. Nu Gundam MSA gap investigation, continued):
 * boardValue had zero awareness of trash-pile contents at all, so any card whose real payoff is
 * gated on "N cards of trait/color X in trash" (Gundam Barbatos Lupus GD03-050's board-clear needs
 * 3 (Tekkadan)/(Teiwaz) in trash; Saviour Gundam ST09-003's board wipe needs 5 purple; both Nu
 * Gundams GD05-020/GD05-017 need 2/3 (Londo Bell)) got no credit for progress toward that threshold
 * -- only a hard, all-or-nothing jump once (for an Activate-Main like Lupus's) the ability finally
 * became legal, and zero credit ever for a non-Activate-Main trigger like Saviour's When Linked. A
 * direct AI-asymmetry test (scratchpad/barbatos_ai_asymmetry.js) found MCTS's advantage over the
 * older/weaker AI is worth +31pt piloting Nu Gundam in this matchup but only +6pt piloting Barbatos --
 * consistent with (not proven to fully explain) search having no gradient toward Barbatos's actual
 * win condition. Declared via a trashSynergy def flag (see trashSynergyValue below) rather than
 * hardcoding card numbers, so any future card sharing this shape picks it up automatically. A
 * reasoned starting weight (same order of magnitude as one legal activation), not yet empirically
 * tuned -- same precedent as activationPotential above.
 */
const DEFAULT_WEIGHTS = { shields: 10, baseHP: 3, boardStats: 1, hand: 2, resources: 2, activationPotential: 4, trashSynergy: 3 };

/**
 * Board-evaluation function for AI lookahead: how good is this state for `playerIdx`, relative to
 * their opponent. Reads its weights from `state.players[playerIdx].aiWeights` if set (falling back to
 * DEFAULT_WEIGHTS), so a scratch A/B harness can give each side of a self-play match a different
 * weight set without threading a weights param through every lookahead function.
 */
function scoreState(state, playerIdx) {
  if (state.winner === playerIdx) return Infinity;
  if (state.winner === 1 - playerIdx) return -Infinity;
  if (state.draw) return 0;

  const self = state.players[playerIdx];
  const enemy = state.players[1 - playerIdx];
  const weights = self.aiWeights || DEFAULT_WEIGHTS;

  const selfActivations = collectActivateCandidates(state, playerIdx).length;
  const enemyActivations = collectActivateCandidates(state, 1 - playerIdx).length;

  return (
    boardValue(self, weights) -
    boardValue(enemy, weights) +
    (selfActivations - enemyActivations) * weights.activationPotential
  );
}

function boardValue(player, weights) {
  const baseHP = player.base ? getRemainingHP(player.base) : 0;
  const boardStats = player.battleArea.reduce((sum, u) => sum + getAP(u) + getRemainingHP(u), 0);

  return (
    player.shields.length * weights.shields +
    baseHP * weights.baseHP +
    boardStats * weights.boardStats +
    player.hand.length * weights.hand +
    player.resourceArea.length * weights.resources +
    trashSynergyValue(player) * weights.trashSynergy
  );
}

/**
 * Sum of "how close to usable" every distinct trashSynergy-flagged card the player controls (in
 * play or in hand) is, as a 0..1 fraction of its own threshold. Deduped by synergy signature (not
 * per-copy) so holding 2+ copies of the same payoff card doesn't inflate its value -- the trash
 * count that matters is the same single pile regardless of how many copies want it.
 */
function trashSynergyValue(player) {
  const seen = new Set();
  let value = 0;
  for (const card of [...player.battleArea, ...player.hand]) {
    const synergy = card.def.trashSynergy;
    if (!synergy) continue;
    const key = JSON.stringify(synergy);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = player.trash.filter(
      (t) =>
        (synergy.traits && (t.def.traits || []).some((trait) => synergy.traits.includes(trait))) ||
        (synergy.color && t.def.color === synergy.color)
    ).length;
    value += Math.min(count, synergy.threshold) / synergy.threshold;
  }
  return value;
}

module.exports = { scoreState, DEFAULT_WEIGHTS, trashSynergyValue };
