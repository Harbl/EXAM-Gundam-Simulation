const { canAfford, payCost } = require('../rules/cost');
const { deployUnit, deployBase, playCommand, pairPilot, pairPilotFromTrash, matchesLinkCondition, hasBetterLinkTargetInDeck, bestLinkMatch, findEvolveTarget, deployByEvolve, comboSearchOdds } = require('../rules/actions');
const { effectivePilotDef } = require('../rules/management');
const { resolveAttack } = require('../rules/combat');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../rules/phases');
const { cloneState } = require('../rules/clone');
const { LIMITS } = require('../rules/constants');
const { scoreState } = require('./score');
const {
  collectCommandCandidates,
  collectDeployCandidates,
  collectAttackCandidates,
  chooseAttackTarget,
  canDeployBase,
  runMainPhaseSimple,
  runMainPhase,
  defaultHooks,
  lookaheadHooks,
  COMBO_SEARCH_WEIGHT
} = require('./heuristic');
const { RESOLVERS, collectActivateCandidates, activateMainSource, REQUIRES_RESTED } = require('./activations');

/**
 * MCTS AI: searches the whole main phase as one interleaved sequence of atomic actions (deploy one
 * card, pair one Pilot, play one Command, attack with one Unit, or pass), rather than the fixed
 * commands->deploys->pairings->attacks pipeline in heuristic.js. This captures cross-category
 * sequencing (e.g. attacking before deploying more) the fixed pipeline can't represent -- see Phase 4
 * of the plan for the full design rationale. Additive: does not replace runMainPhase anywhere.
 *
 * Tunable via state.players[playerIdx].mctsConfig, same pattern as score.js's aiWeights -- avoids
 * threading a config param through every function.
 *
 * Measured via scratchpad/mcts_spike.js (both sides MCTS, mirrored deck) before picking these
 * defaults, per the plan's "measure, don't guess" performance safety valve: 'good' rollout is
 * ~80-90x more expensive than 'cheap' at comparable budgets (cheap/25/2turns ~180ms/game vs.
 * good/25/2turns ~14.3s/game) -- a full 191-deck batch sweep would take ~11 minutes at the cheap
 * setting vs. several hours at the good setting. DEFAULT_MCTS_CONFIG stays practical for regular
 * batch/regression use; STRONG_MCTS_CONFIG is the explicit opt-in for a single deliberately
 * higher-quality game, matching Jake's "good AI rollout, but tunable" choice.
 */
// applyComboSearchBonus: true on every tier except STRONG_MCTS_CONFIG -- Jake's call (2026-08-07):
// the no-peeking combo-search bonus (see runSearch's own comment) should apply everywhere except the
// top ('expert') tier, since expert is already the deliberately-unrealistic "how good could this deck
// theoretically be piloted" ceiling and doesn't need to be reined in toward human-shaped play.
const DEFAULT_MCTS_CONFIG = { playoutBudget: 25, rolloutTurns: 2, rolloutPolicy: 'cheap', applyComboSearchBonus: true };
const STRONG_MCTS_CONFIG = { playoutBudget: 25, rolloutTurns: 2, rolloutPolicy: 'good' };
// A middle tier: more playouts under the cheap rollout (still ~180ms/game per playout, so 4x the
// budget is still well under 1s/game) rather than paying the ~80-90x cost of the 'good' rollout
// policy -- a deliberately stronger single/small-batch game without STRONG_MCTS_CONFIG's full price.
const BALANCED_MCTS_CONFIG = { playoutBudget: 100, rolloutTurns: 2, rolloutPolicy: 'cheap', applyComboSearchBonus: true };
// A below-default tier, added 2026-08-03 for the skill-slider feature (src/ai/skillPresets.js) --
// Jake wanted a real step between "the old lookahead AI entirely" (skillPresets.js's 'beginner') and
// today's default MCTS ('casual'), rather than that being the only two rungs. This exact config was
// already measured in scratchpad/mcts_tune.js as a real, significant loss vs. DEFAULT_MCTS_CONFIG
// (44.3% win rate, z=-2.30) -- a genuine weaker tier, not a guess. Verified it still clears the old
// lookahead AI outright (scratchpad/verify_novice_tier_ordering.js: 62.5% over 120 real games, z~2.7),
// confirming beginner < weak < fast is a real strength ordering, not assumed from "it's still MCTS".
const WEAK_MCTS_CONFIG = { playoutBudget: 12, rolloutTurns: 2, rolloutPolicy: 'cheap', applyComboSearchBonus: true };

/** Named tiers for --mcts=<preset> (bin/simulate.js) and any future settings-window UI (Phase 3) to bind to. */
const MCTS_PRESETS = { weak: WEAK_MCTS_CONFIG, fast: DEFAULT_MCTS_CONFIG, balanced: BALANCED_MCTS_CONFIG, strong: STRONG_MCTS_CONFIG };

// Reasoned starting point (~sqrt(2), the standard UCB1 default for a [0,1] reward) -- but scoreState's
// raw output is nowhere near [0,1] (measured via scratchpad/score_range_spike.js: 664 real in-game
// samples had abs median 8.0, p90 46.0, p95 56.0, max 88.0), so without normalizing the reward first,
// EXPLORATION_C's exploration term (at most ~1.4*sqrt(ln(25)/1) =~ 2.5 at these budgets) is swamped by
// exploitation values in the tens, making the search close to pure-greedy regardless of this constant.
// REWARD_SCALE (below) fixes that; retune EXPLORATION_C empirically only after the scale fix, not before.
const EXPLORATION_C = 1.4;

// Chosen from the score_range_spike.js data above (~p90/p95 of observed |scoreState|): dividing the raw
// reward by this before backprop puts the typical normalized range around [-1, +1.8], so
// EXPLORATION_C's exploration term is finally a comparable order of magnitude to the exploitation term
// instead of being negligible against it.
const REWARD_SCALE = 50;

class MCTSNode {
  constructor(state, action, parent) {
    this.state = state;
    this.action = action; // the atomic action that produced this node from parent (null for root)
    this.parent = parent;
    this.children = [];
    this.untriedActions = null; // lazily populated, then popped from directly as children are expanded
    this.visits = 0;
    this.totalValue = 0;
    this.comboBonus = 0; // see runSearch's comment; nonzero only for a 'command' node that drew cards
  }
}

function isTerminal(node) {
  return node.state.winner !== null || node.state.draw;
}

function untriedActions(node, playerIdx) {
  if (node.untriedActions === null) {
    // A node whose own action was 'pass' is a true leaf for this decision sequence -- pass is not
    // reversible, so it must never be expanded further (its state is otherwise identical to its
    // parent's, so re-running getLegalActions on it would wrongly suggest more actions are still legal).
    node.untriedActions = node.action && node.action.type === 'pass' ? [] : getLegalActions(node.state, playerIdx);
  }
  return node.untriedActions;
}

function isFullyExpanded(node, playerIdx) {
  return untriedActions(node, playerIdx).length === 0;
}

function uct(child, parentVisits, explorationC = EXPLORATION_C) {
  if (child.visits === 0) return Infinity;
  return child.totalValue / child.visits + explorationC * Math.sqrt(Math.log(parentVisits) / child.visits);
}

/** explorationC defaults to the module constant but is overridable via config.explorationC (scratchpad/mcts_tune.js). */
function selectChild(node, explorationC = EXPLORATION_C) {
  let best = null;
  let bestScore = -Infinity;
  for (const child of node.children) {
    const score = uct(child, node.visits, explorationC);
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best;
}

/**
 * Same candidate filter runPairings uses (heuristic.js), plus one refinement: a Pilot is excluded here
 * (not offered as a legal 'pair' action at all) whenever its best currently-in-play Link match (if
 * any -- bestLinkMatch, actions.js) is beaten by something still undrawn in the deck
 * (hasBetterLinkTargetInDeck). Covers both "no match at all yet" and "a worse match is already in
 * play, a better one is still coming." Without this, MCTS would happily grab the small guaranteed
 * value of pairing onto whatever's available right now -- it has no way to see the payoff of waiting
 * for the intended body a few turns out, since that value only exists in a future the search's playout
 * budget rarely reaches. Excluding the action outright (rather than trusting search/eval to discover
 * holding is better) is the same kind of deliberate heuristic judgment call as the "Heuristic default"
 * choices documented throughout registry.js -- not a searched decision, but a real, targeted fix for a
 * real reported gap.
 */
function collectPairCandidates(state, playerIdx) {
  const player = state.players[playerIdx];
  const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
  if (targets.length === 0) return [];
  return player.hand.filter((c) => {
    if (!(c.def.type === 'pilot' || c.def.pilotMode) || !canAfford(player, c.def, { state })) return false;
    const best = bestLinkMatch(targets, c);
    const bestLevel = best ? (best.def.level || 0) : -1;
    return !hasBetterLinkTargetInDeck(player, c, bestLevel);
  });
}

/**
 * Every atomic action currently legal for playerIdx; 'pass' is always included. Attack candidates are
 * pre-filtered to ones chooseAttackTarget can actually find a target for -- offering an attack that
 * would resolve to a no-op is more than just wasted search: because this whole search is fully
 * deterministic (no randomness anywhere in selection/expansion), a no-op action applied for real in
 * runMainPhaseMCTS's loop leaves the state completely unchanged, so the very next search would
 * reproduce the identical tree and pick the identical no-op action again -- a genuine infinite loop,
 * not just a slow one (caught via a real hang during self-play testing).
 */
function getLegalActions(state, playerIdx) {
  const opponent = state.players[1 - playerIdx];
  const player = state.players[playerIdx];
  const actions = [{ type: 'pass' }];
  for (const c of collectCommandCandidates(state, playerIdx)) actions.push({ type: 'command', cardId: c.id });
  for (const c of collectDeployCandidates(state, playerIdx)) actions.push({ type: 'deploy', cardId: c.id });
  for (const c of collectPairCandidates(state, playerIdx)) actions.push({ type: 'pair', cardId: c.id });
  for (const { attacker, onDeployTurn } of collectAttackCandidates(state, playerIdx)) {
    if (chooseAttackTarget(opponent, attacker, onDeployTurn, player)) actions.push({ type: 'attack', attackerId: attacker.id });
  }
  // Only sourceId is stored, never the resolved args -- args reference instances from *this* clone
  // and would be stale/wrong if applyAction later runs on a different clone (or the real state).
  // applyAction re-resolves fresh, same defensive pattern 'attack' already uses for chooseAttackTarget.
  for (const { source } of collectActivateCandidates(state, playerIdx)) {
    actions.push({ type: 'activate', sourceId: source.id });
  }
  return actions;
}

/** Finds a source (Base or battleArea Unit) the owning player currently controls, by stable instance id. */
function findOwnSourceById(player, id) {
  if (player.base && player.base.id === id) return player.base;
  return player.battleArea.find((u) => u.id === id) || null;
}

/** Applies exactly one atomic action to `state` (real or a clone), reusing the same action functions the rest of the AI/engine already uses. A no-longer-legal action (state moved on since it was offered) is simply a no-op. */
function applyAction(state, playerIdx, action, hooks) {
  const player = state.players[playerIdx];
  if (action.type === 'pass') return;

  if (action.type === 'command') {
    const card = player.hand.find((c) => c.id === action.cardId);
    if (!card || !canAfford(player, card.def, { state })) return;
    const usedExResource = payCost(player, card.def, { state });
    player.hand.splice(player.hand.indexOf(card), 1);
    const trashed = playCommand(state, player, card.def, { usedExResource });
    if (trashed.def.pairableFromTrash) {
      const target = player.battleArea.find(
        (u) => !u.pilot && !u.def.cannotBePaired && (u.def.traits || []).includes(trashed.def.pairableFromTrash)
      );
      if (target) pairPilotFromTrash(state, player, target, trashed);
    }
    return;
  }

  if (action.type === 'deploy') {
    const card = player.hand.find((c) => c.id === action.cardId);
    if (!card) return;
    if (card.def.type === 'base' && !canDeployBase(player)) return;
    if (!canAfford(player, card.def, { state })) return;
    payCost(player, card.def, { state });
    player.hand.splice(player.hand.indexOf(card), 1);
    if (card.def.type === 'unit') deployUnit(state, player, card.def);
    else deployBase(state, player, card.def);
    return;
  }

  if (action.type === 'pair') {
    const targets = player.battleArea.filter((u) => u.def.type === 'unit' && !u.pilot && !u.def.cannotBePaired);
    const pilot = player.hand.find((c) => c.id === action.cardId);
    if (!pilot || targets.length === 0 || !canAfford(player, pilot.def, { state })) return;
    const unit = bestLinkMatch(targets, pilot) || targets[0];
    payCost(player, pilot.def, { pairUnit: unit, state });
    pairPilot(state, player, unit, pilot);
    return;
  }

  if (action.type === 'attack') {
    const opponent = state.players[1 - playerIdx];
    const candidate = collectAttackCandidates(state, playerIdx).find((c) => c.attacker.id === action.attackerId);
    if (!candidate || candidate.attacker.rested) return;
    const target = chooseAttackTarget(opponent, candidate.attacker, candidate.onDeployTurn, player);
    if (target) resolveAttack(state, playerIdx, candidate.attacker, target, hooks);
    return;
  }

  if (action.type === 'activate') {
    const opponent = state.players[1 - playerIdx];
    const source = findOwnSourceById(player, action.sourceId);
    if (!source) return;
    const handlerInfo = activateMainSource(source);
    if (!handlerInfo) return;
    // Same exception as collectActivateCandidates: the 5 reactivation abilities need the source
    // rested, every other resolver needs it un-rested (re-checked here, not just at offer time,
    // since state may have moved on between getLegalActions and applyAction).
    const needsRested = REQUIRES_RESTED.has(handlerInfo.number);
    if (needsRested ? !source.rested : source.rested) return;
    const resolver = RESOLVERS[handlerInfo.number];
    if (!resolver) return;
    const args = resolver(state, player, opponent, source);
    if (args) {
      // See heuristic.js's runActivations comment: resolvingSource lets dealEffectDamage check the
      // acting Unit's own Level (Gouf Vijayanta EB01-014).
      const prevSource = state.resolvingSource;
      state.resolvingSource = source;
      try {
        handlerInfo.handler(state, player, source, args);
      } finally {
        state.resolvingSource = prevSource;
      }
    }
  }
}

/** Mode Change (evolve) plays fire unconditionally first, same as runDeploys/runDeploysLookahead -- a free upgrade trade is virtually always good, not worth searching. */
function runEvolvePlays(state, playerIdx) {
  const player = state.players[playerIdx];
  for (;;) {
    const evolveCard = player.hand.find((c) => c.def.evolveCondition && findEvolveTarget(player, c.def));
    if (!evolveCard) return;
    const target = findEvolveTarget(player, evolveCard.def);
    player.hand.splice(player.hand.indexOf(evolveCard), 1);
    deployByEvolve(state, player, evolveCard.def, target);
  }
}

function clampedScore(state, playerIdx) {
  const raw = scoreState(state, playerIdx);
  if (raw === Infinity) return 1e6;
  if (raw === -Infinity) return -1e6;
  return raw / REWARD_SCALE;
}

/**
 * Finishes the acting player's (possibly partial) current turn with the cheap heuristic, then
 * simulates config.rolloutTurns further alternating turns (opponent first) using either that same
 * cheap chain or the full lookahead ("good AI"), per config.rolloutPolicy. Only ever called on
 * throwaway clones -- never recurses into another MCTS search (same recursion-guard principle
 * runAttacksLookahead already established).
 * `alreadyPassed` distinguishes "this leaf's own action was an explicit pass" (the turn is genuinely
 * over, the cheap heuristic must not tack on more actions after it) from "this leaf is mid-turn"
 * (the cheap heuristic fills in whatever's left) -- without this, a search branch that specifically
 * explored "stop here" would get silently overridden by the rollout policy continuing to act anyway,
 * defeating the point of 'pass' being in the action space at all.
 */
function rollout(state, playerIdx, config, alreadyPassed) {
  if (!alreadyPassed) {
    runMainPhaseSimple(state, playerIdx, defaultHooks());
    if (state.winner !== null || state.draw) return;
  }
  runEndPhase(state);
  passTurn(state);

  let idx = 1 - playerIdx;
  for (let i = 0; i < config.rolloutTurns; i++) {
    runStartPhase(state);
    runDrawPhase(state);
    if (state.winner !== null || state.draw) return;
    runResourcePhase(state);
    if (config.rolloutPolicy === 'good') {
      runMainPhase(state, idx, lookaheadHooks(state));
    } else {
      runMainPhaseSimple(state, idx, defaultHooks());
    }
    if (state.winner !== null || state.draw) return;
    runEndPhase(state);
    passTurn(state);
    idx = 1 - idx;
  }
}

/**
 * One MCTS search from `rootState` (not mutated) for a single atomic decision, returning the built tree.
 *
 * `applyComboSearchBonus` (per-tier, see MCTS_PRESETS above) extends heuristic.js's no-peeking
 * combo-search bonus into this search: `comboSearchOdds` is snapshotted ONCE from the real, untouched
 * `rootState` before any playout runs (never recomputed from a resolved clone -- that would peek at
 * whether a specific simulated draw happened to hit), then a 'command' node that draws cards gets a
 * fixed `comboBonus` (a bare drawn-card COUNT times the frozen odds, never card identity) computed once
 * at its own creation. Backprop adds that node's own comboBonus on every visit through it, on top of the
 * normal leaf reward -- since it's a constant added once per pass-through, this converges the node's
 * mean value (totalValue/visits, what uct()'s exploitation term reads) to `mean(leaf reward) +
 * comboBonus`, i.e. a flat bump to this one decision's estimated value, same effect as
 * runCommandsLookahead's additive bonus, just expressed per-node instead of per-subset since MCTS
 * decides one atomic action at a time rather than searching whole subsets.
 */
function runSearch(rootState, playerIdx, config) {
  const root = new MCTSNode(cloneState(rootState), null, null);
  const searchOdds = config.applyComboSearchBonus ? comboSearchOdds(rootState.players[playerIdx]) : 0;
  const comboWeight = rootState.players[playerIdx].aiWeights?.comboSearch ?? COMBO_SEARCH_WEIGHT;

  for (let i = 0; i < config.playoutBudget; i++) {
    let node = root;

    // Selection
    while (!isTerminal(node) && node.children.length > 0 && isFullyExpanded(node, playerIdx)) {
      node = selectChild(node, config.explorationC);
    }

    // Expansion
    if (!isTerminal(node) && !isFullyExpanded(node, playerIdx)) {
      const action = untriedActions(node, playerIdx).pop();
      const childState = cloneState(node.state);
      applyAction(childState, playerIdx, action, defaultHooks());
      const child = new MCTSNode(childState, action, node);
      if (searchOdds > 0 && action.type === 'command') {
        const before = node.state.players[playerIdx];
        const after = childState.players[playerIdx];
        const actuallyPlayed = after.trash.length - before.trash.length;
        if (actuallyPlayed > 0) {
          const cardsDrawn = Math.max(0, after.hand.length - (before.hand.length - actuallyPlayed));
          child.comboBonus = cardsDrawn * searchOdds * comboWeight;
        }
      }
      node.children.push(child);
      node = child;
    }

    // Rollout
    const rolloutState = cloneState(node.state);
    const alreadyPassed = !!(node.action && node.action.type === 'pass');
    if (rolloutState.winner === null && !rolloutState.draw) rollout(rolloutState, playerIdx, config, alreadyPassed);
    const reward = clampedScore(rolloutState, playerIdx);

    // Backpropagate
    for (let cur = node; cur; cur = cur.parent) {
      cur.visits += 1;
      cur.totalValue += reward + cur.comboBonus;
    }
  }

  return root;
}

/** Root child with the most visits ("robust child" selection -- more stable than raw average value at low budgets). */
function bestAction(root) {
  let best = null;
  let bestVisits = -1;
  for (const child of root.children) {
    if (child.visits > bestVisits) {
      bestVisits = child.visits;
      best = child;
    }
  }
  return best ? best.action : { type: 'pass' };
}

/**
 * MCTS-driven main phase: repeatedly searches the current real state for the best next atomic
 * action, applies it for real, and loops until 'pass' is chosen or no actions remain. New, separate
 * entry point alongside runMainPhase/runMainPhaseSimple -- does not replace either.
 */
// Generous upper bound on real atomic actions in a single main phase (hand + battle area, with
// margin) -- a defense-in-depth safety cap, not an expected code path. getLegalActions is filtered to
// only offer actions that make real progress when applied (see its own comment), so this should never
// actually trigger; it exists so an unforeseen no-op action can't hang a real game forever the way one
// concretely did during self-play testing before that filter was added.
const MAX_ATOMIC_ACTIONS_PER_TURN = LIMITS.MAX_HAND + LIMITS.MAX_BATTLE_AREA * 2 + 10;

function runMainPhaseMCTS(state, playerIdx, hooks = lookaheadHooks(state), config) {
  const cfg = config || state.players[playerIdx].mctsConfig || DEFAULT_MCTS_CONFIG;

  runEvolvePlays(state, playerIdx);

  for (let iterations = 0; ; iterations++) {
    if (state.winner !== null || state.draw) return;
    if (iterations >= MAX_ATOMIC_ACTIONS_PER_TURN) return;
    const root = runSearch(state, playerIdx, cfg);
    const action = bestAction(root);
    // Activate-Main abilities are now a first-class searched action type (see activations.js) --
    // whether/when to use one is the search's own decision, not force-fired afterward. Force-firing
    // every usable ability at pass time (the old Phase 4 behavior) would override a legitimate search
    // decision to skip a situationally-bad ability (e.g. resting a Unit that trades away its own
    // attack this turn for restEnemyByTradingArgs' trade).
    if (action.type === 'pass') return;
    applyAction(state, playerIdx, action, hooks);
  }
}

module.exports = {
  runMainPhaseMCTS,
  getLegalActions,
  applyAction,
  runSearch,
  uct,
  selectChild,
  clampedScore,
  DEFAULT_MCTS_CONFIG,
  STRONG_MCTS_CONFIG,
  BALANCED_MCTS_CONFIG,
  WEAK_MCTS_CONFIG,
  MCTS_PRESETS,
  EXPLORATION_C,
  MCTSNode
};
