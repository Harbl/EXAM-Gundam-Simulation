const { MCTS_PRESETS } = require('./mcts');

/**
 * Named opponent-skill tiers for the simulation UI's skill slider -- lets Jake ask "how does my
 * deck do against a sharp/loose pilot" directly, instead of separately picking an AI engine and a
 * playout budget. Added 2026-08-03 after the Barbatos Rush vs. Nu Gundam MSA investigation found a
 * real, measured skill-intensity asymmetry between archetypes (some decks reward precise piloting
 * far more than others -- see project memory), which a single "how good is the bot" dial can't
 * represent on its own; real MSA ladder data reflects a wide range of human skill, not one skill
 * level, so being able to dial an opponent down is what actually recreates that range for testing.
 *
 * 'beginner' swaps in the older, simpler lookahead AI (src/ai/heuristic.js's runMainPhase) rather
 * than a smaller MCTS budget -- proven ~65-69% weaker than MCTS in self-play (see project memory),
 * a much bigger and more human-shaped gap than any MCTS_PRESETS tier alone would give. The other
 * four tiers reuse MCTS_PRESETS directly at increasing playout budget/rollout cost.
 *
 * 'novice' added 2026-08-03, same day as the first 4 tiers, after Jake felt the beginner->casual
 * jump was too big a single step -- MCTS_PRESETS.weak (12 playouts) is a real, already-measured
 * weaker-than-default config (scratchpad/mcts_tune.js: 44.3% vs. default, z=-2.30), and confirmed
 * via a direct head-to-head (scratchpad/verify_novice_tier_ordering.js) to still beat the beginner
 * tier's lookahead AI outright (62.5%, z~2.7) -- so beginner < novice < casual is a real, verified
 * strength ordering, not assumed just because novice is "still MCTS".
 */
const SKILL_PRESETS = {
  beginner: { label: 'Beginner (fixed-order heuristic, no real lookahead)', engine: 'lookahead' },
  novice: { label: 'Novice (MCTS, very light search)', engine: 'mcts', mctsConfig: MCTS_PRESETS.weak },
  casual: { label: 'Casual (MCTS, light search)', engine: 'mcts', mctsConfig: MCTS_PRESETS.fast },
  tight: { label: 'Tight (MCTS, heavier search)', engine: 'mcts', mctsConfig: MCTS_PRESETS.balanced },
  expert: { label: 'Expert (MCTS, full-strength rollout -- much slower per game)', engine: 'mcts', mctsConfig: MCTS_PRESETS.strong }
};

module.exports = { SKILL_PRESETS };
