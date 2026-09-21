const { ipcMain } = require('electron');
const { canAfford } = require('../../src/rules/cost');
const { collectBlockCandidates } = require('../../src/ai/heuristic');
const { collectActivateActionCandidates } = require('../../src/ai/activations');
const { resolverTableFor } = require('../../src/ai/actionStepPriority');
const { serializeStateFor, serializeInstance } = require('./serialize');

// Only one prompt is ever pending at a time -- turnDriver.js only ever awaits one controller call at
// once, so a single module-level slot is enough (same "one active thing" simplification main.js's own
// `activeWorker` already uses for batch runs). Registered once at module load, not per-game.
let pendingResolve = null;
ipcMain.on('playtest:respond', (event, payload) => {
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(payload);
  }
});

/**
 * PlayerController (see turnDriver.js) backed by real UI events instead of AI decision code. Every
 * method sends a 'playtest:prompt' message to the renderer -- {kind, state (serialized from this
 * player's own point of view, so the opponent's hand stays hidden), ...kind-specific candidate data}
 * -- and returns a Promise that resolves when the renderer answers on 'playtest:respond'. Candidate
 * lists for chooseBlocker/respondToPriority are computed here via the same src/ai functions the AI
 * controller uses (collectBlockCandidates, collectActivateActionCandidates+resolverTableFor) so the
 * human is offered exactly what's actually legal, never a hand-rolled second copy of that logic.
 */
function makeHumanController(mainWindow, playerIdx) {
  function ask(kind, extra = {}) {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      mainWindow.webContents.send('playtest:prompt', { kind, playerIdx, ...extra });
    });
  }

  return {
    async chooseMulligan(hand) {
      const response = await ask('mulligan', { hand: hand.map(serializeInstance) });
      return !!(response && response.mulligan);
    },

    async chooseMainAction(state, idx, legalActions) {
      const response = await ask('mainAction', { state: serializeStateFor(state, playerIdx), legalActions });
      return (response && response.action) || { type: 'pass' };
    },

    async chooseAttackTarget(state, idx, attacker, options) {
      const response = await ask('attackTarget', {
        state: serializeStateFor(state, playerIdx),
        attackerId: attacker.id,
        options: options.map((o) => (o.type === 'unit' ? { type: 'unit', id: o.instance.id } : { type: 'player' }))
      });
      if (!response || !response.target) return options[0];
      const picked = options.find((o) =>
        response.target.type === 'player' ? o.type === 'player' : o.type === 'unit' && o.instance.id === response.target.id
      );
      return picked || options[0];
    },

    async chooseBlocker(state, defendingPlayer, attacker, target, attackingPlayer) {
      const candidates = collectBlockCandidates(defendingPlayer, attacker, target, attackingPlayer);
      if (candidates.length === 0) return null;
      const response = await ask('blocker', {
        state: serializeStateFor(state, playerIdx),
        attackerId: attacker.id,
        candidateIds: candidates.map((c) => c.id)
      });
      if (!response || !response.blockerId) return null;
      return candidates.find((c) => c.id === response.blockerId) || null;
    },

    async respondToPriority(state, idx, battleCtx) {
      const player = state.players[playerIdx];
      const commandOptions = player.hand.filter(
        (c) =>
          c.def.type === 'command' &&
          (c.def.actionTiming === 'action' || c.def.actionTiming === 'both') &&
          canAfford(player, c.def, { state })
      );
      const resolverTable = resolverTableFor(state, playerIdx, battleCtx);
      const activateOptions = collectActivateActionCandidates(state, playerIdx, battleCtx, resolverTable);
      if (commandOptions.length === 0 && activateOptions.length === 0) return { type: 'pass' };
      const response = await ask('priority', {
        state: serializeStateFor(state, playerIdx),
        commandOptions: commandOptions.map((c) => ({ cardId: c.id, name: c.def.name })),
        activateOptions: activateOptions.map((c) => ({ sourceId: c.source.id, sourceName: c.source.def.name }))
      });
      return (response && response.action) || { type: 'pass' };
    },

    async chooseDiscards(state, idx, excess) {
      const response = await ask('discards', { state: serializeStateFor(state, playerIdx), excess });
      const player = state.players[playerIdx];
      const ids = (response && response.cardIds) || [];
      return player.hand.filter((c) => ids.includes(c.id)).slice(0, excess);
    },

    // shieldInstance is revealed to its own owner here for the first time (5-10-3) -- safe to send in
    // full even though Shields are normally hidden info, since this prompt only ever fires for this
    // player's own destroyed Shield.
    async chooseBurst(state, idx, shieldInstance) {
      const response = await ask('burst', { state: serializeStateFor(state, playerIdx), shield: serializeInstance(shieldInstance) });
      return !!(response && response.activate);
    },

    // Only asked when <Suppression> hits 2 Shields at once (13-1-7-4) -- both are already known to be
    // about to burst, so this just orders the (already-revealed) resolution.
    async chooseBurstOrder(state, idx, shields) {
      const response = await ask('burstOrder', { state: serializeStateFor(state, playerIdx), shields: shields.map(serializeInstance) });
      if (!response || !Array.isArray(response.orderedIds)) return shields;
      const byId = new Map(shields.map((s) => [s.id, s]));
      const ordered = response.orderedIds.map((id) => byId.get(id)).filter(Boolean);
      return ordered.length === shields.length ? ordered : shields;
    }
  };
}

module.exports = { makeHumanController };
