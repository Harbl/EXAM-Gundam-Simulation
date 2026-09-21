const { beginSetup, finishSetup } = require('../../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, passTurn } = require('../../src/rules/phases');
const { checkDefeat, getKeywords } = require('../../src/rules/management');
const { triggerEvent, applyRepairAtEndOfTurn, clearTurnBuffs } = require('../../src/rules/effects');
const { fireAttackTriggers, applyBlockDecision, resolveFromBlockDecision, predictShieldHits } = require('../../src/rules/combat');
const { LIMITS } = require('../../src/rules/constants');
const { getLegalActions, applyAction } = require('../../src/ai/mcts');
const { collectAttackCandidates, getEligibleAttackTargets } = require('../../src/ai/heuristic');
const { runActionStepPriority } = require('../../src/ai/actionStepPriority');

const MAX_TURNS = 60; // same safety cap as src/sim/singleGame.js
// Same defense-in-depth cap as mcts.js's runMainPhaseMCTS -- getLegalActions is filtered to only offer
// actions that make real progress, so this should never actually trigger.
const MAX_ATOMIC_ACTIONS_PER_TURN = LIMITS.MAX_HAND + LIMITS.MAX_BATTLE_AREA * 2 + 10;

/**
 * Plays one full interactive game (human-vs-AI or AI-vs-AI for testing) to completion, given a
 * `controllers` array of two PlayerController-shaped objects (see playtest/engine/aiController.js for
 * the AI implementation; a human/UI controller satisfies the exact same async shape). Reuses
 * src/rules wholesale for every phase that never needs to pause for a real decision (start/draw/
 * resource, end-of-turn triggers/repair); the two windows that do -- the main phase and the two real
 * occurrences of the Action Step priority window (mid-combat, end phase) -- are driven here one
 * decision at a time via `await controller.___(...)`, instead of the single synchronous hook call
 * every other AI path in this codebase uses (see actionStepPriority.js's own comment for why).
 */
async function playInteractiveGame(deckA, deckB, controllers, options = {}) {
  const notify = options.onUpdate || (() => {}); // lets a real renderer re-render at each real checkpoint, not just when it's asked a question -- see turnDriver's header comment
  const setup = beginSetup(deckA, deckB, options);
  const mulliganOrder = [setup.firstIdx, setup.secondIdx];
  const mulliganDecisions = [];
  for (const idx of mulliganOrder) {
    mulliganDecisions.push(await controllers[idx].chooseMulligan(setup.players[idx].hand));
  }
  let callCount = 0;
  const decideMulligan = () => mulliganDecisions[callCount++]; // finishSetup calls this in the exact same firstIdx-then-secondIdx order
  const state = finishSetup(setup, decideMulligan);
  // Same pattern as src/sim/singleGame.js's playGame -- scoreState (src/ai/score.js) reads the trained
  // valueNet model straight off state.players[idx].valueModel, not a function param, so it has to be
  // attached here post-creation to give the AI controller's MCTS rollouts the real trained evaluator
  // (skillPresets.js's SKILL_PRESETS[tier].valueModel) instead of silently falling back to the older,
  // weaker linear scoreState formula.
  if (options.valueModelA) state.players[0].valueModel = options.valueModelA;
  if (options.valueModelB) state.players[1].valueModel = options.valueModelB;
  notify(state);

  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    notify(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    notify(state);
    await runMainPhaseInteractive(state, state.activePlayerIdx, controllers, notify);
    if (state.winner !== null || state.draw) break;

    await runEndPhaseInteractive(state, controllers);
    notify(state);
    passTurn(state);
  }

  notify(state);
  return state;
}

async function runMainPhaseInteractive(state, playerIdx, controllers, notify = () => {}) {
  const controller = controllers[playerIdx];
  for (let i = 0; i < MAX_ATOMIC_ACTIONS_PER_TURN; i++) {
    if (state.winner !== null || state.draw) return;
    const legalActions = getLegalActions(state, playerIdx);
    const action = await controller.chooseMainAction(state, playerIdx, legalActions);
    if (!action || action.type === 'pass') return;
    if (action.type === 'attack') {
      await resolveAttackInteractive(state, playerIdx, action, controllers);
    } else {
      applyAction(state, playerIdx, action, {});
    }
    notify(state);
  }
}

/**
 * One full attack (8-2 through 8-6), with the block choice and the Action Step negotiation (8-4) each
 * awaited from the relevant controller instead of resolved by a single synchronous hook.
 * `resolveFromBlockDecision` is reused unchanged for the damage/battle-end steps -- everything before
 * it in this function is real, live rules resolution against `state`, not a preview.
 */
async function resolveAttackInteractive(state, attackerPlayerIdx, action, controllers) {
  const player = state.players[attackerPlayerIdx];
  const opponentIdx = 1 - attackerPlayerIdx;
  const opponent = state.players[opponentIdx];
  const candidate = collectAttackCandidates(state, attackerPlayerIdx).find((c) => c.attacker.id === action.attackerId);
  if (!candidate || candidate.attacker.rested) return; // state moved on since offered -- harmless no-op, same convention as applyAction
  const attacker = candidate.attacker;
  // 8-2: the attacker's own controller declares the target, not a heuristic -- getLegalActions only
  // used chooseAttackTarget internally to check *an* attack was possible at all (see mcts.js), so a
  // real choice among every eligible target is asked for here (skipped when there's only one option,
  // the common case, so a no-choice attack never needs an extra round trip).
  const targetOptions = getEligibleAttackTargets(opponent, attacker, candidate.onDeployTurn, player);
  if (targetOptions.length === 0) return;
  const declaredTarget =
    targetOptions.length === 1 ? targetOptions[0] : await controllers[attackerPlayerIdx].chooseAttackTarget(state, attackerPlayerIdx, attacker, targetOptions);
  if (!declaredTarget) return;

  fireAttackTriggers(state, player, attacker, declaredTarget);

  const attackerStillIn = () => player.battleArea.includes(attacker);
  const targetStillIn = (t) => t.type === 'player' || opponent.battleArea.includes(t.instance);

  let target = declaredTarget;
  if (attackerStillIn() && targetStillIn(target)) {
    const keywords = getKeywords(attacker);
    if (!keywords.highManeuver) {
      const chosenBlocker = await controllers[opponentIdx].chooseBlocker(state, opponent, attacker, target, player);
      if (chosenBlocker) target = applyBlockDecision(attacker, target, chosenBlocker);
    }
  }

  if (attackerStillIn() && targetStillIn(target)) {
    const battleCtx = { attacker, target, battleTarget: target };
    await runActionStepPriority(state, opponentIdx, attackerPlayerIdx, battleCtx, (s, pIdx) =>
      controllers[pIdx].respondToPriority(s, pIdx, battleCtx)
    );
    target = battleCtx.target; // a redirect-style Command (e.g. Master League Begins) may have retargeted this battle in place
  }

  // Shield Burst activation (5-10-3/13-2-5) is asked synchronously mid-damage-step by
  // resolveFromBlockDecision, deep enough inside it (resolveDamageStep -> resolveBurst) that awaiting a
  // real answer there would mean threading async through the whole combat module. Sidestepped instead
  // via predictShieldHits: since nothing can mutate the Base/battleArea/shields between here and the
  // resolveFromBlockDecision call below (block + the action step are already finished), the Shield(s)
  // about to be hit can be known and asked about *now*, then handed to resolveFromBlockDecision as a
  // synchronous hook that just looks up the already-decided answer -- same "resolve the async part
  // yourself first, then replay through a no-op/lookup hook" shape as applyBlockDecision above.
  const hitShields = target.type === 'player' && attackerStillIn() && targetStillIn(target) ? predictShieldHits(opponent, attacker) : [];
  const burstableShields = hitShields.filter((s) => s.def.effects && s.def.effects.burst);
  const burstOrder =
    hitShields.length > 1 ? await controllers[opponentIdx].chooseBurstOrder(state, opponentIdx, hitShields) : hitShields;
  const burstAnswers = new Map();
  for (const shield of burstableShields) {
    burstAnswers.set(shield.id, await controllers[opponentIdx].chooseBurst(state, opponentIdx, shield));
  }
  const hooks = {
    actionStep: () => {},
    chooseBurst: (shieldInstance) => burstAnswers.get(shieldInstance.id) || false,
    chooseBurstOrder: () => burstOrder
  };
  resolveFromBlockDecision(state, attackerPlayerIdx, attacker, target, null, hooks);
}

/**
 * End phase (7-6): the action-step window (RULES_NOTES.md section 9's second real occurrence, silently
 * a no-op before this driver existed -- see actionStepPriority.js) is awaited first, then the same
 * endOfTurn triggers/repair/hand-limit/turn-buff-clear sequence runEndPhase already runs, called
 * directly here (not via runEndPhase itself) only because the hand-limit discard choice also needs to
 * be awaited from the real controller, and a discard choice can't be pre-resolved before endOfTurn
 * triggers/repair run (they can change hand size first).
 */
async function runEndPhaseInteractive(state, controllers) {
  const playerIdx = state.activePlayerIdx;
  const opponentIdx = 1 - playerIdx;
  const player = state.players[playerIdx];

  const battleCtx = { step: 'end-phase-action' };
  await runActionStepPriority(state, opponentIdx, playerIdx, battleCtx, (s, pIdx) =>
    controllers[pIdx].respondToPriority(s, pIdx, battleCtx)
  );

  triggerEvent(state, 'endOfTurn', {});
  applyRepairAtEndOfTurn(state, player);

  while (player.hand.length > LIMITS.MAX_HAND) {
    const excess = player.hand.length - LIMITS.MAX_HAND;
    const discards = await controllers[playerIdx].chooseDiscards(state, playerIdx, excess);
    for (const card of discards) {
      const idx = player.hand.indexOf(card);
      if (idx !== -1) {
        player.hand.splice(idx, 1);
        player.trash.push(card);
      }
    }
  }

  clearTurnBuffs(player);
}

module.exports = { playInteractiveGame, resolveAttackInteractive, runEndPhaseInteractive };
