/**
 * Known cases where MCTS plays a specific archetype's plan closer to optimal than real average ladder
 * execution achieves -- confirmed 2026-08-06 for Nu Gundam (Londo Bell value-engine deck): it wins
 * 78.1% against a 195-deck real-tournament field at full MCTS (n=1170,
 * scratchpad/nu_gundam_broad_field_check.js) vs. its real MSA archetype win rate of 56%. Downgrading
 * Nu Gundam ALONE to the older `lookahead` engine (opponents unchanged) drops that to 50.9% -- closing
 * essentially the whole gap (scratchpad/nu_gundam_broad_field_check_lookahead.log). Neither of the two
 * scoreState weights added to help the AI recognize this deck's plan (trashSynergy/activationPotential)
 * explained the gap when zeroed individually, and a symmetric (both-sides) weaker default tier only
 * partially helped and didn't generalize to other matchups (scratchpad/skill_tier_msa_calibration.js).
 *
 * This is a deliberately narrow, evidence-backed EXCEPTION LIST, not a generalized archetype
 * classifier -- two attempts at a smooth, decklist-stat-derived formula (average cost/level, then
 * effect-card density) already failed this session (see the project plan and
 * scratchpad/ai_architecture_levers.md item 4's neighbors). Only add an entry here once a deck has been
 * through the same real confirmation (broad-field sim rate vs. real MSA archetype rate, then an
 * isolated engine-downgrade test showing it actually closes the gap) -- not from a hunch.
 */
const ARCHETYPE_HANDICAPS = [
  {
    name: 'Nu Gundam (Londo Bell)',
    // Both Nu Gundam units define the archetype (GD05-017's When-Paired safe-kill snipe, GD05-020's
    // trash-synergy Deploy) -- a real deck commits multiple copies of one or both, not a single splash.
    cardNumbers: ['GD05-017', 'GD05-020'],
    minCopies: 4,
    override: { engine: 'lookahead' }
  }
];

/** Counts total copies of `cardNumbers` across a built deck's main-deck CardDefs. */
function archetypeCardCount(mainDeckDefs, cardNumbers) {
  return mainDeckDefs.filter((def) => cardNumbers.includes(def.number)).length;
}

/**
 * Given a built deck ({main, resource}, see src/deck/build.js) and an already-resolved
 * {engine, mctsConfig, valueModel}, returns a possibly-overridden config if the deck matches a known
 * AI-advantaged archetype. Only ever downgrades: if `config.engine` isn't `'mcts'` (the caller already
 * picked `'lookahead'` or something else non-default), the config is returned unchanged -- an explicit
 * user choice of an already-weaker tier is never silently strengthened back up by this.
 */
function applyArchetypeHandicap(deck, config) {
  if (config.engine !== 'mcts') return config;
  for (const archetype of ARCHETYPE_HANDICAPS) {
    if (archetypeCardCount(deck.main, archetype.cardNumbers) >= archetype.minCopies) {
      return { ...config, ...archetype.override, handicapped: archetype.name };
    }
  }
  return config;
}

module.exports = { ARCHETYPE_HANDICAPS, archetypeCardCount, applyArchetypeHandicap };
