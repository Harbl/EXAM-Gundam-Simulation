const { getAP, getRemainingHP, trashSynergyValue, damagedSynergyValue, reactiveReserveValue } = require('../rules/management');
const { collectActivateCandidates } = require('./activations');
const { extractFeatures } = require('./valueFeatures');
const { forward } = require('./valueNet');
const { extractDeepSetFeatures } = require('./valueFeaturesV2');
const { forward: deepSetForward } = require('./deepSetValueNet');

/**
 * Weights tuned via large-sample (n=5000/variant) self-play coordinate descent -- see
 * scratchpad/weight_tune.js. resources:2 beat the original resources:1 (z=2.72); a further probe
 * around this champion (resources 1.5/3, shields 11/12, boardStats 1.5, baseHP 1.5/5) found nothing
 * that beats it, confirming a local optimum. A 2026-08-03 automated coordinate-descent pass over all
 * 8 weights at once (scratchpad/weight_coordinate_descent.js, +/-30% nudges, n=600/nudge) confirmed
 * the same: every weight, including the two below that had never been empirically checked, is already
 * a local optimum at that step size. See scoreState for how to A/B alternatives via player.aiWeights.
 *
 * damagedSynergy added 2026-08-06 (Barbatos Rush vs. Nu Gundam benchmark investigation, continued --
 * see trashSynergy below for the same investigation's earlier fix on Nu Gundam's side): boardStats
 * (AP + remainingHP) scores any damage taken as pure loss, with zero credit for cards flagged
 * `benefitsFromSelfDamage` (Gundam Barbatos 1st Form GD02-054 draws on Attack while damaged; 4th Form
 * ST05-001 gains <Suppression> while damaged; Barbatos Lupus Rex (LR+) GD05-051 gains AP equal to its
 * own damage) -- see management.js's damagedSynergyValue for the full reasoning. A reasoned starting
 * weight (same order of magnitude as trashSynergy, since it's the same "one unlocked payoff" shape) --
 * not yet coordinate-descent-tuned; see scratchpad/damaged_synergy_barbatos_check.js for the direct
 * A/B validation this weight was introduced to test before any tuning pass.
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
 * A reasoned starting weight -- coordinate-descent tuning (scratchpad/weight_coordinate_descent.js,
 * 2026-08-03, +/-30% nudges, n=600/nudge) found no significant improvement in either direction,
 * confirming this value as a local optimum at that resolution.
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
 * reasoned starting weight (same order of magnitude as one legal activation) -- same coordinate-descent
 * check as activationPotential above found no significant improvement either, confirming this value too.
 *
 * exResourceHeld added 2026-08-03 (after fixing payCost to prefer normal Resources over the EX
 * Resource token, see src/rules/cost.js): the generic `resources` weight already counts a still-in-
 * play token the same as any normal Resource, but that undersells it -- a normal Resource merely
 * being rested to pay a cost is free (still counts toward Level, 2-9-1), while spending a token
 * Resource removes it from the game *permanently* (5-17-3-2-3), costing a Level point for the rest
 * of the game. Real players hold an EX Resource for exactly this reason (often several turns, until
 * around Level 3-4, per Jake) rather than spending it the instant it would help. This weight adds an
 * *extra* premium specifically for a token still being in play (on top of the generic `resources`
 * credit it already gets), so the search has a real incentive to prefer a cheaper play/pass over one
 * that would force spending it, not just to stop wasting it when unnecessary (payCost's fix already
 * covers that part). A reasoned starting weight (same order of magnitude as activationPotential,
 * deliberately not so large it would stop the AI from ever making a genuinely strong play that's
 * worth the Level point) -- empirically checked via scratchpad/weight_tune.js and
 * scratchpad/check_ex_resource_timing.js before landing on this value, same precedent as
 * activationPotential/trashSynergy's initial tuning.
 *
 * reactiveReserve added 2026-08-07, tested negative TWICE, weight zeroed (deploy-timing/board-flooding
 * investigation): the generic `resources` weight counts total Resources (active + rested) identically,
 * so boardValue had zero signal that spending every active Resource in a Main Phase leaves nothing
 * payable for the entire following opponent turn -- see management.js's reactiveReserveValue for the
 * full reasoning (only pays off when a real `[Action]`-timing Command in hand is actually being held
 * up for, not a flat "hoard Resources" reward). First validated via scratchpad/reactive_reserve_check.js
 * (SPRT, mirror self-play on deck121.txt -- the highest [Action]-Command-density single real deck in
 * the pool): REJECT at n=2543, 51.3%, llr=-2.95. Per Jake's standing methodology correction (see
 * feedback_gundam_ai_validate_full_deck_pool.md memory -- a single curated deck isn't enough sample to
 * trust a reject on), re-validated across the WHOLE real pool
 * (scratchpad/reactive_reserve_check_broadfield.js, a fresh random deck from all 197 pool decks per
 * trial instead of one fixed deck): **REJECT again, this time even more decisively -- n=393, 47.3%,
 * llr=-2.95**, resolving faster and slightly below break-even rather than just flat. The broader,
 * methodologically-corrected test confirms the original single-deck result rather than overturning it.
 * Weight zeroed rather than kept at a reasoned nonzero value (unlike damagedSynergy's narrow-matchup
 * reject, where the underlying flag is still obviously correct outside the one gap it was tested
 * against -- this WAS the general validation for the mechanism itself, twice over now).
 * `reactiveReserveValue` stays wired into boardValue (harmless at weight 0, easy to resurrect) and the
 * trained-net feature vector (valueFeatures.js) is untouched, in case the trained net's own
 * feature-learning finds signal a hand-picked linear weight didn't.
 */
const DEFAULT_WEIGHTS = {
  shields: 10,
  baseHP: 3,
  boardStats: 1,
  hand: 2,
  resources: 2,
  activationPotential: 4,
  trashSynergy: 3,
  exResourceHeld: 5,
  damagedSynergy: 3,
  reactiveReserve: 0
};

/**
 * Board-evaluation function for AI lookahead: how good is this state for `playerIdx`, relative to
 * their opponent. Reads its weights from `state.players[playerIdx].aiWeights` if set (falling back to
 * DEFAULT_WEIGHTS), so a scratch A/B harness can give each side of a self-play match a different
 * weight set without threading a weights param through every lookahead function.
 *
 * Phase 7 (2026-08-03): `state.players[playerIdx].valueModel`, if set, bypasses the linear formula
 * below entirely in favor of a trained valueNet.js forward pass over valueFeatures.js's feature
 * vector -- same per-side opt-in override shape as aiWeights, so nothing existing changes behavior
 * unless a valueModel is explicitly attached (see bin/train_value_net.js). Every AI path (the old
 * lookahead heuristic in ai/heuristic.js, MCTS's search/rollout scoring in ai/mcts.js) already calls
 * through this one shared scoreState and nowhere else, so this is the only place that dispatch needs
 * to live.
 *
 * data/valueNet.json (last retrained 2026-08-05, bin/train_value_net.js, 29-feature/full-deck-pool
 * run) is a trained champion that beat this linear formula 54.1% in a large-sample self-play
 * confirmation (39,200 games, z=11.59). It's the real default now: src/ai/skillPresets.js loads it
 * once and attaches it as `valueModel` on every skill tier's preset, so this linear formula only
 * still runs when something explicitly opts out (no `valueModel` set at all -- e.g. bin/train_value_net.js's
 * own baseline comparisons, or a scratch script built directly on playGame/scoreState without going
 * through skillPresets.js).
 *
 * A second, structurally different valueModel kind (2026-08-06): `deepSetValueNet.js`, a DeepSets-style
 * net fed per-unit board data (`valueFeaturesV2.js`) instead of only hand-engineered aggregate scalars.
 * Discriminated by `self.valueModel.kind === 'deepset'` -- a plain flat-net model (old saved JSON,
 * `kind` undefined) still routes to `forward`/`extractFeatures` exactly as before, byte-for-byte
 * unchanged. Branching here rather than inside either `forward()` keeps both hot paths simple and
 * independently testable -- see the project plan for why.
 */
function scoreState(state, playerIdx) {
  if (state.winner === playerIdx) return Infinity;
  if (state.winner === 1 - playerIdx) return -Infinity;
  if (state.draw) return 0;

  const self = state.players[playerIdx];
  if (self.valueModel) {
    return self.valueModel.kind === 'deepset'
      ? deepSetForward(self.valueModel, extractDeepSetFeatures(state, playerIdx))
      : forward(self.valueModel, extractFeatures(state, playerIdx));
  }

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

  const exResourcesHeld = player.resourceArea.filter((r) => r.def.isToken).length;

  return (
    player.shields.length * weights.shields +
    baseHP * weights.baseHP +
    boardStats * weights.boardStats +
    player.hand.length * weights.hand +
    player.resourceArea.length * weights.resources +
    trashSynergyValue(player) * weights.trashSynergy +
    exResourcesHeld * weights.exResourceHeld +
    damagedSynergyValue(player) * weights.damagedSynergy +
    reactiveReserveValue(player) * weights.reactiveReserve
  );
}

module.exports = { scoreState, DEFAULT_WEIGHTS, trashSynergyValue, damagedSynergyValue, reactiveReserveValue };
