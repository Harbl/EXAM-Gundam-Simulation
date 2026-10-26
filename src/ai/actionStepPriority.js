const { canAfford, payCost } = require('../rules/cost');
const { playCommand, pairPilotFromTrash } = require('../rules/actions');
const { collectActivateActionCandidates, ACTION_RESOLVERS, ATTACKER_ACTION_RESOLVERS } = require('./activations');

/**
 * The real Action Step rule (RULES_NOTES.md section 9): standby player chooses first each round
 * (play an Action-timed Command, activate an [Activate·Action] ability, or pass), then active player
 * does the same, alternating until BOTH consecutively pass. Today's heuristic.js `actionStep` is a
 * single one-shot AI hook standing in for this (its own comment admits as much) -- this is the real
 * back-and-forth, built once and meant to be reused for both real occurrences of the window (mid-combat,
 * end phase), not a combat-only mechanic.
 *
 * `respond(state, playerIdx, battleCtx)` is an async callback (an AI controller resolves synchronously
 * and wraps the result in Promise.resolve; a human controller awaits a real UI event) returning one of:
 *   - null / {type: 'pass'}
 *   - {type: 'command', cardId}
 *   - {type: 'activate', sourceId}
 * A non-pass response is applied for real, directly on `state` (never a clone), via the same
 * playCommand/activation-handler primitives the existing AI-only actionStep already uses -- this
 * function only owns the alternation/stopping logic and re-resolving a response into a real
 * application, not any new game-effect logic.
 *
 * `battleCtx` is whatever a Command/ability handler needs: {attacker, target, battleTarget} for the
 * combat window (mirrors what combat.js already threads through resolveFromBlockDecision's hook today),
 * or a shape with no `attacker` (e.g. {step: 'end-phase-action'}) for the end-phase window -- the two
 * real occurrences of this rule, per RULES_NOTES.md section 9's "End phase: action step" line.
 */
async function runActionStepPriority(state, standbyPlayerIdx, activePlayerIdx, battleCtx, respond) {
  let turnIdx = standbyPlayerIdx;
  let consecutivePasses = 0;

  while (consecutivePasses < 2) {
    const response = await respond(state, turnIdx, battleCtx);
    if (!response || response.type === 'pass') {
      consecutivePasses += 1;
    } else {
      applyActionStepResponse(state, turnIdx, battleCtx, response);
      consecutivePasses = 0;
    }
    turnIdx = turnIdx === standbyPlayerIdx ? activePlayerIdx : standbyPlayerIdx;
  }
}

function applyActionStepResponse(state, playerIdx, battleCtx, response) {
  const player = state.players[playerIdx];

  if (response.type === 'command') {
    const card = player.hand.find((c) => c.id === response.cardId);
    if (!card) return; // state moved on since the response was chosen -- a harmless no-op, same defensive convention as mcts.js's applyAction
    if (card.def.type !== 'command') return;
    if (card.def.actionTiming !== 'action' && card.def.actionTiming !== 'both') return;
    if (!canAfford(player, card.def, { state })) return;
    const usedExResource = payCost(player, card.def, { state });
    player.hand.splice(player.hand.indexOf(card), 1);
    const trashed = playCommand(state, player, card.def, { usedExResource, extraContext: commandContextFor(state, battleCtx) });
    // Sturm und Drang GD06-119: "After activating this card's [Action], you may pair this card from
    // your trash with one of your (MF) Units" -- same pairableFromTrash follow-up heuristic.js's
    // runCommands/resolveCommandSubset/actionStep already use for a Main-phase or reactive-window play.
    if (trashed.def.pairableFromTrash) {
      const pairTarget = player.battleArea.find(
        (u) => !u.pilot && !u.def.cannotBePaired && (u.def.traits || []).includes(trashed.def.pairableFromTrash)
      );
      if (pairTarget) pairPilotFromTrash(state, player, pairTarget, trashed);
    }
    return;
  }

  if (response.type === 'activate') {
    const resolverTable = resolverTableFor(state, playerIdx, battleCtx);
    const candidate = collectActivateActionCandidates(state, playerIdx, battleCtx, resolverTable).find(
      (c) => c.source.id === response.sourceId
    );
    if (!candidate) return;
    const prevSource = state.resolvingSource;
    state.resolvingSource = candidate.source;
    try {
      candidate.handler(state, player, candidate.source, candidate.args);
    } finally {
      state.resolvingSource = prevSource;
    }
  }
}

/** Mirrors heuristic.js's existing actionStep: underAttack is the friendly Unit/Base actually under
 * attack, attackingUnit is the attacker -- both undefined outside the combat window (e.g. end phase),
 * which every Command handler reading them already tolerates via its own `if (!target) return;`-style
 * guard (see registry.js). */
function commandContextFor(state, battleCtx) {
  if (!battleCtx || !battleCtx.attacker || !battleCtx.target) {
    return { battleTarget: undefined, underAttack: undefined, attackingUnit: undefined };
  }
  const defendingPlayer = state.players.find((p) => !p.battleArea.includes(battleCtx.attacker));
  const underAttack = battleCtx.target.type === 'unit' ? battleCtx.target.instance : defendingPlayer?.base;
  return { battleTarget: battleCtx.battleTarget, underAttack, attackingUnit: battleCtx.attacker };
}

/** Same defender-shaped-vs-attacker-shaped resolver split heuristic.js's actionStep already encodes
 * (ACTION_RESOLVERS' handlers assume `player` is the defending side; ATTACKER_ACTION_RESOLVERS' assume
 * the attacking side) -- generalized here so whichever side currently holds priority gets the resolver
 * table that actually matches its role in this battle, not just "the defender" as heuristic.js assumes.
 * Outside the combat window (no `battleCtx.attacker`, e.g. the end-phase window) there's no attacker/
 * defender distinction at all, so ACTION_RESOLVERS is used unconditionally -- the only table with any
 * content today; nothing currently registered there is attacker/defender-specific in a way that breaks
 * outside combat. */
function resolverTableFor(state, playerIdx, battleCtx) {
  if (!battleCtx || !battleCtx.attacker) return ACTION_RESOLVERS;
  const attackingPlayer = state.players.find((p) => p.battleArea.includes(battleCtx.attacker));
  const attackingPlayerIdx = state.players.indexOf(attackingPlayer);
  return playerIdx === attackingPlayerIdx ? ATTACKER_ACTION_RESOLVERS : ACTION_RESOLVERS;
}

module.exports = { runActionStepPriority, resolverTableFor };
