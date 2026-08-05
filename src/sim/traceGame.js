// Re-simulates one seeded game (see src/rules/rng.js) and returns a structured turn-by-turn event
// log, for the replay viewer feature. Adapts the exact instrumentation scratchpad/trace_game_mcts.js
// used for manual debugging -- patches rules/actions.js + rules/combat.js's exported functions to
// push an event whenever they run against the *real* game state, so the AI's own internal
// lookahead/MCTS search (which calls these same functions against cloned scratch states while
// evaluating candidate moves) doesn't pollute the trace -- only the decisions that actually happened
// show up.
//
// IMPORTANT: this file must be the first thing required in its process/worker, before anything else
// (heuristic.js, mcts.js, phases.js, ...) touches rules/management.js, rules/actions.js, or
// rules/combat.js. Those modules destructure their functions off these exports objects at their own
// top level the first time they're required, which caches the *unpatched* function references in a
// local const -- patching afterward wouldn't reach them (Node's module cache means the exports objects
// are shared, but reassigning a property on that object doesn't rewrite an already-captured
// destructured binding elsewhere). electron/worker/replayWorker.js is the real entry point that
// guarantees this by being a fresh worker_thread (its own isolated module registry) spun up fresh per
// replay request.
// management.js must be required (and patched) BEFORE phases.js/actions.js/combat.js -- all three
// destructure functions off management.js at their own top-level require time, which captures
// whatever management.exports currently points to. If any of them were required first, their
// already-bound references would be the originals forever, and reassigning management.exports
// afterward would never reach them (same hazard this file's header comment already describes for
// actions.js/combat.js's own consumers). registry.js does the exact same destructuring, but it's only
// ever reached transitively, well after this ordering is already locked in, so it automatically picks
// up the patched versions.
//
// This patch only ever catches *effect*-triggered draws reached via registry.js's destructured
// reference (e.g. a Command's "draw 1, discard 1") -- it can NEVER catch the once-per-turn phase
// draw, because runDrawPhase (defined in this same phases.js file) calls `drawCard(...)` as a bare
// same-module reference, not through module.exports, so reassigning the exported property never
// reaches it (same "bare intra-module call" hazard as mulligan()/resolveBurst() elsewhere in this
// codebase). The phase draw is instead captured directly in traceGame()'s own loop below, via a
// before/after hand-size diff around its own `runDrawPhase(state)` call -- the same trick already
// used there for resource placement. Because these two mechanisms observe genuinely disjoint call
// sites, there's no risk of the same draw ever being logged twice.
//
// destroyCard/destroyIfDead (management.js) are BOTH patched separately, even though destroyIfDead's
// own body calls destroyCard internally -- that internal call is itself a bare same-module reference
// (bypasses whatever we reassign management.exports.destroyCard to), so a destroyIfDead-driven
// destruction (battle damage reducing HP to 0) would never reach a patch placed only on destroyCard.
// Patching destroyIfDead directly, from the outside, catches that path independently; the two patches
// observe disjoint call sites (direct destroyCard calls from actions.js/registry.js/combat.js's
// destroyOutrightAndFireEffect vs. destroyIfDead-driven ones from combat.js's destroyAndFireEffect),
// so there's no double-counting risk, same shape as the drawCard split above.
//
// dealDamage/enforceHandLimit (management.js) take no `state` argument at all, so the usual
// `state === realState` guard doesn't directly apply. Both instead check reachability from realState
// directly (does realState contain this instance/player right now?) -- reliable even without a state
// argument, since cloneState always produces new, non-reference-equal objects for every AI search
// trial.
//
// `block` events (a Blocker unit intercepting an attack) are captured the same way as `burst` --
// wrapping chooseBlocker on the one shared hooks object built in traceGame() below, not patching
// combat.js's resolveAttack/resolveFromBlockDecision (which call hooks.chooseBlocker directly, so
// there's nothing to bare-call-bypass here). Every simulated AI trial builds its own fresh
// defaultHooks()/lookaheadHooks() internally rather than reusing the hooks object passed in from
// outside, so only the real, finally-applied attack ever reaches this wrapper -- same structural
// guarantee chooseBurst already relies on, which is why this is safe even though chooseBlocker (unlike
// chooseBurst) never receives a `state` argument to compare against realState.
const management = require('../rules/management');

let realState = null;
let events = null;

function cardRef(def) {
  return def ? { name: def.name, number: def.number } : null;
}
function instanceRef(instance) {
  return instance ? { name: instance.def.name, number: instance.def.number, id: instance.id } : null;
}

const origDestroyCard = management.destroyCard;
management.destroyCard = function (state, player, instance) {
  const isReal = state === realState;
  const unitRef = isReal ? instanceRef(instance) : null;
  const playerIdx = isReal ? state.players.indexOf(player) : null;
  const result = origDestroyCard.call(this, state, player, instance);
  if (isReal) events.push({ type: 'destroy', turn: state.turnNumber, player: playerIdx, unit: unitRef });
  return result;
};

const origDestroyIfDead = management.destroyIfDead;
management.destroyIfDead = function (state, player, instance) {
  const isReal = state === realState;
  const unitRef = isReal ? instanceRef(instance) : null;
  const playerIdx = isReal ? state.players.indexOf(player) : null;
  const result = origDestroyIfDead.call(this, state, player, instance);
  if (isReal && result) events.push({ type: 'destroy', turn: state.turnNumber, player: playerIdx, unit: unitRef });
  return result;
};

function ownerIdxOf(instance) {
  return realState
    ? realState.players.findIndex((p) => p.battleArea.includes(instance) || p.base === instance || p.shields.includes(instance))
    : -1;
}

const origDealDamage = management.dealDamage;
management.dealDamage = function (instance, amount, opts = {}) {
  const playerIdx = ownerIdxOf(instance);
  const before = instance.damage;
  const result = origDealDamage.call(this, instance, amount, opts);
  if (playerIdx !== -1) {
    const dealt = instance.damage - before;
    if (dealt > 0) {
      events.push({ type: 'damage', turn: realState.turnNumber, player: playerIdx, instance: instanceRef(instance), amount: dealt });
    }
  }
  return result;
};

const origEnforceHandLimit = management.enforceHandLimit;
management.enforceHandLimit = function (player, chooseDiscards) {
  const isReal = !!realState && realState.players.includes(player);
  const handBefore = isReal ? [...player.hand] : null;
  const result = origEnforceHandLimit.call(this, player, chooseDiscards);
  if (isReal) {
    const playerIdx = realState.players.indexOf(player);
    for (const card of handBefore) {
      if (!player.hand.includes(card)) {
        events.push({ type: 'discard', turn: realState.turnNumber, player: playerIdx, card: cardRef(card.def) });
      }
    }
  }
  return result;
};

// Effect-driven discards (e.g. Overflowing Affection GD01-118's "Draw 2. Then, discard 1.") go
// through this shared helper rather than enforceHandLimit (that's specifically the end-of-turn
// discard-to-limit step) -- without this patch, ~18 registry.js effects' discards would never emit
// a trace event at all, even though they discard correctly in real game state (looked like a
// gameplay bug in the replay viewer, but was only ever a trace-visibility gap).
const origDiscardFromHand = management.discardFromHand;
management.discardFromHand = function (player, card) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const cardRefForEvent = isReal ? cardRef(card.def) : null;
  const result = origDiscardFromHand.call(this, player, card);
  if (isReal) {
    events.push({ type: 'discard', turn: realState.turnNumber, player: playerIdx, card: cardRefForEvent });
  }
  return result;
};

// Same reasoning as discardFromHand above, for "place the top N cards of your deck into your trash"
// effects (e.g. Gundam Exia Repair GD05-050's own [Destroyed] ability) -- without this patch, milling
// straight from deck to trash is invisible to the trace, which reads in the replay viewer as "this
// card isn't sending anything to the trash" even though real game state is correct.
const origMillToTrash = management.millToTrash;
management.millToTrash = function (player, count) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const result = origMillToTrash.call(this, player, count);
  if (isReal) {
    for (const card of result) {
      events.push({ type: 'mill', turn: realState.turnNumber, player: playerIdx, card: cardRef(card.def) });
    }
  }
  return result;
};

const phases = require('../rules/phases');

const origDrawCard = phases.drawCard;
phases.drawCard = function (state, player, opts = {}) {
  const before = player.deck.length;
  const result = origDrawCard.call(this, state, player, opts);
  if (state === realState && player.deck.length < before) {
    events.push({
      type: 'draw',
      turn: state.turnNumber,
      player: state.players.indexOf(player),
      card: cardRef(player.hand[player.hand.length - 1].def),
      isPhaseDraw: false
    });
  }
  return result;
};

const actions = require('../rules/actions');
const combat = require('../rules/combat');

// Every one of these action patches (deploy/deployBase/becomeBase/playCommand/pairPilot/
// pairPilotFromTrash/resolveAttack below) pushes its OWN event before delegating to the original
// function, not after -- the original functions fire the card's own trigger effects synchronously
// inside their own call (Deploy/When Paired/[Main]/Attack-timing text that can draw, discard, deal
// damage, or destroy), and those nested effects push their own trace events through the patches
// above. Pushing the parent's event afterward would land it in the array AFTER everything its own
// effect caused -- e.g. Overflowing Affection GD01-118's "Draw 2. Then, discard 1." showed up in a
// replay as two draws and a discard happening BEFORE the card was even played. Where an event needs
// data only the call's return value provides (the newly created instance's id, for deploy/deployBase
// -- deployUnit/deployBase create that instance internally, unlike becomeBase/pairPilot/playCommand
// which are only ever given an already-existing instance/def as an argument), a placeholder event is
// pushed up front and mutated in place once the call returns -- the array position (and therefore
// display order) is fixed by the push, not the mutation.
const origDeployUnit = actions.deployUnit;
actions.deployUnit = function (state, player, def, chooseToTrash, context) {
  const isReal = state === realState;
  let ev = null;
  if (isReal) {
    ev = { type: 'deploy', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(def), unit: null };
    events.push(ev);
  }
  const result = origDeployUnit.call(this, state, player, def, chooseToTrash, context);
  if (isReal) ev.unit = instanceRef(result);
  return result;
};

const origDeployBase = actions.deployBase;
actions.deployBase = function (state, player, def) {
  const isReal = state === realState;
  let ev = null;
  if (isReal) {
    ev = { type: 'deployBase', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(def), unit: null };
    events.push(ev);
  }
  const result = origDeployBase.call(this, state, player, def);
  if (isReal) ev.unit = instanceRef(result);
  return result;
};

// becomeBase (a Shield converting straight into a Base -- e.g. Jaburo, White Base, Archangel) is
// how EVERY Base card in the entire DB implements its Burst text (grep-confirmed: 68/68 Base cards
// resolve to becomeBase, the vast majority via the shared simpleBurstBase). It's a distinct exported
// function from deployBase (not called as a bare same-module reference anywhere -- registry.js is
// its only caller, via the same destructured-import pattern as every other actions.js patch here),
// so it needs its own patch rather than assuming a Burst that doesn't end up in hand went to trash.
// Reuses the 'deployBase' event shape since, from a replay's perspective, "this instance is now the
// player's Base" is exactly what that event already represents.
const origBecomeBase = actions.becomeBase;
actions.becomeBase = function (state, player, instance) {
  const isReal = state === realState;
  if (isReal) {
    events.push({ type: 'deployBase', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(instance.def), unit: instanceRef(instance) });
  }
  return origBecomeBase.call(this, state, player, instance);
};

// Master Asia's own becomeUnit (see its comment in actions.js) is the Unit-side sibling of becomeBase
// just above -- same reasoning, reusing the 'deploy' event shape instead of 'deployBase' since this
// lands in the battle area, not the Base slot.
const origBecomeUnit = actions.becomeUnit;
actions.becomeUnit = function (state, player, instance) {
  const isReal = state === realState;
  if (isReal) {
    events.push({ type: 'deploy', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(instance.def), unit: instanceRef(instance) });
  }
  return origBecomeUnit.call(this, state, player, instance);
};

const origPlayCommand = actions.playCommand;
actions.playCommand = function (state, player, def, opts) {
  if (state === realState) {
    events.push({ type: 'command', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(def) });
  }
  return origPlayCommand.call(this, state, player, def, opts);
};

const origPairPilot = actions.pairPilot;
actions.pairPilot = function (state, player, unit, pilotInstance) {
  if (state === realState) {
    events.push({
      type: 'pair',
      turn: state.turnNumber,
      player: state.players.indexOf(player),
      pilot: instanceRef(pilotInstance),
      unit: instanceRef(unit)
    });
  }
  return origPairPilot.call(this, state, player, unit, pilotInstance);
};

const origPairPilotFromTrash = actions.pairPilotFromTrash;
actions.pairPilotFromTrash = function (state, player, unit, trashInstance) {
  if (state === realState) {
    events.push({
      type: 'pairFromTrash',
      turn: state.turnNumber,
      player: state.players.indexOf(player),
      pilot: instanceRef(trashInstance),
      unit: instanceRef(unit)
    });
  }
  return origPairPilotFromTrash.call(this, state, player, unit, trashInstance);
};

const origResolveAttack = combat.resolveAttack;
combat.resolveAttack = function (state, attackerPlayerIdx, attacker, declaredTarget, hooks) {
  const isReal = state === realState;
  let ev = null;
  if (isReal) {
    ev = {
      type: 'attack',
      turn: state.turnNumber,
      player: attackerPlayerIdx,
      attacker: instanceRef(attacker),
      target:
        declaredTarget.type === 'player'
          ? { type: 'player', player: 1 - attackerPlayerIdx }
          : { type: 'unit', unit: instanceRef(declaredTarget.instance) },
      shieldsBefore: state.players.map((p) => p.shields.length),
      shieldsAfter: null
    };
    events.push(ev);
  }
  const result = origResolveAttack.call(this, state, attackerPlayerIdx, attacker, declaredTarget, hooks);
  if (isReal) ev.shieldsAfter = state.players.map((p) => p.shields.length);
  return result;
};

// Resources (electron/renderer's board replay) need to know not just that a payment happened, but
// exactly which physical Resource instances it rested (or, for a spent EX Resource token, removed
// outright) -- payCost (src/rules/cost.js) itself takes no `state` argument, unlike every other
// patched function here, so the usual `state === realState` guard reads `opts.state` instead (every
// real call site already passes `{ state }` through canAfford/payCost's opts for its own
// board-state-reduction checks, so this is never a special case to add just for tracing).
const cost = require('../rules/cost');
const origPayCost = cost.payCost;
cost.payCost = function (player, def, opts = {}) {
  const isReal = opts.state === realState;
  const restedBefore = isReal ? new Map(player.resourceArea.map((r) => [r.id, r.rested])) : null;
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const result = origPayCost.call(this, player, def, opts);
  if (isReal) {
    const restedIds = player.resourceArea.filter((r) => r.rested && restedBefore.get(r.id) === false).map((r) => r.id);
    const removedIds = [...restedBefore.keys()].filter((id) => !player.resourceArea.some((r) => r.id === id));
    if (restedIds.length || removedIds.length) {
      events.push({ type: 'payResources', turn: realState.turnNumber, player: playerIdx, restedIds, removedIds });
    }
  }
  return result;
};

// Same reasoning as discardFromHand/millToTrash above, for the rest of management.js's
// tracing-pulled-out helpers -- each is a registry.js effect's "move a specific card between zones"
// step that used to splice the zones directly, leaving nothing here to patch. Positioned here, before
// the cards/index.js require below (not after it, alongside the burst-effects loop this comment used
// to sit next to) -- that require is what pulls in registry.js, whose own `const { shieldToHand, ... }
// = require('../rules/management')` destructuring would otherwise capture these functions unpatched,
// same ordering hazard this file's own header comment warns about for every other patch here.
const origShieldToHand = management.shieldToHand;
management.shieldToHand = function (player) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const result = origShieldToHand.call(this, player);
  if (isReal && result) {
    events.push({ type: 'shieldToHand', turn: realState.turnNumber, player: playerIdx, card: cardRef(result.def) });
  }
  return result;
};

const origRecurFromTrash = management.recurFromTrash;
management.recurFromTrash = function (player, card) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const cardRefForEvent = isReal ? cardRef(card.def) : null;
  const result = origRecurFromTrash.call(this, player, card);
  if (isReal) {
    events.push({ type: 'recurFromTrash', turn: realState.turnNumber, player: playerIdx, card: cardRefForEvent });
  }
  return result;
};

// Reuses the 'draw' event shape (isPhaseDraw: false, same as an effect-driven drawCard) -- the deck
// itself is never a rendered zone in the replay viewer (only Shields/trash/hand/board are), so from
// the replay's perspective "a card pulled from a deck scan lands in hand" is observably identical to
// an effect draw: nothing else needs to change.
const origAddToHand = management.addToHand;
management.addToHand = function (player, card) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const cardRefForEvent = isReal ? cardRef(card.def) : null;
  const result = origAddToHand.call(this, player, card);
  if (isReal) {
    events.push({ type: 'draw', turn: realState.turnNumber, player: playerIdx, card: cardRefForEvent, isPhaseDraw: false });
  }
  return result;
};

const origUnpairPilot = management.unpairPilot;
management.unpairPilot = function (player, unit) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const unitRef = isReal ? instanceRef(unit) : null;
  const result = origUnpairPilot.call(this, player, unit);
  if (isReal && result) {
    events.push({ type: 'unpair', turn: realState.turnNumber, player: playerIdx, unit: unitRef, pilot: instanceRef(result) });
  }
  return result;
};

// "Destroy 1 enemy Pilot" (e.g. Eliminate Target GD03-110) -- unlike unpairPilot above, the Pilot
// doesn't just detach, it actually lands in trash, so this needs its own event/trash-count bump
// rather than reusing 'unpair'.
const origDestroyPilot = management.destroyPilot;
management.destroyPilot = function (player, unit) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const unitRef = isReal ? instanceRef(unit) : null;
  const result = origDestroyPilot.call(this, player, unit);
  if (isReal && result) {
    events.push({ type: 'destroyPilot', turn: realState.turnNumber, player: playerIdx, unit: unitRef, pilot: instanceRef(result) });
  }
  return result;
};

// By far the most common bounce text in the card pool ("return this enemy Unit to its owner's
// hand") -- captures the unit/pilot refs BEFORE the call (removeFromField nulls unit.pilot and pulls
// it off the board), then checks whether the pilot actually ended up in hand afterward (a token pilot
// wouldn't -- sendToZone excludes tokens, same isToken exclusion Burst-to-hand already accounts for).
const origReturnUnitToHand = management.returnUnitToHand;
management.returnUnitToHand = function (player, unit) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const unitRef = isReal ? instanceRef(unit) : null;
  const pilotBefore = unit.pilot;
  const result = origReturnUnitToHand.call(this, player, unit);
  if (isReal) {
    const pilotEndedUpInHand = pilotBefore && player.hand.includes(pilotBefore);
    events.push({
      type: 'returnToHand',
      turn: realState.turnNumber,
      player: playerIdx,
      unit: unitRef,
      pilot: pilotEndedUpInHand ? instanceRef(pilotBefore) : null
    });
  }
  return result;
};

// Trash-count-only bookkeeping (see management.js's own comment on removeFromTrash) -- the
// destination is traced separately (or isn't a rendered zone at all), so this only ever needs to
// decrement the count in the replay viewer, not name a card arriving anywhere.
const origRemoveFromTrash = management.removeFromTrash;
management.removeFromTrash = function (player, card) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const result = origRemoveFromTrash.call(this, player, card);
  if (isReal && result) {
    events.push({ type: 'trashRemoved', turn: realState.turnNumber, player: playerIdx, card: cardRef(result.def) });
  }
  return result;
};

// The deck itself isn't rendered, so this only ever needs to say the Unit left the board -- no
// arrival, and (unlike 'destroy') no trash-count bump.
const origReturnUnitToDeck = management.returnUnitToDeck;
management.returnUnitToDeck = function (player, unit) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const unitRef = isReal ? instanceRef(unit) : null;
  const result = origReturnUnitToDeck.call(this, player, unit);
  if (isReal) {
    events.push({ type: 'returnToDeck', turn: realState.turnNumber, player: playerIdx, unit: unitRef });
  }
  return result;
};

const origPlaceRestedResource = management.placeRestedResource;
management.placeRestedResource = function (player) {
  const isReal = !!realState && realState.players.includes(player);
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const result = origPlaceRestedResource.call(this, player);
  if (isReal && result) {
    events.push({ type: 'restedResource', turn: realState.turnNumber, player: playerIdx, resource: instanceRef(result) });
  }
  return result;
};

// Effect-granted Resources (e.g. Nu Gundam GD01-020's own [Deploy]: "place an EX Resource") go
// through this shared effects.js helper -- unlike the once-per-turn resource action (captured via the
// before/after diff in traceGame()'s own turn loop below), nothing observes this mid-effect
// resourceArea.push, so it needs the same kind of patch as everything else here. Reuses the 'resource'
// event shape (electron/renderer's board replay only cares that a new Resource instance landed in the
// area, not why) -- must be patched before requiring cards/index.js below, which is what causes
// registry.js's own `const { ..., placeExResource } = require('../rules/effects')` to run and cache
// whatever's here at that moment, same ordering hazard as every other patch in this file.
const effects = require('../rules/effects');
const origPlaceExResource = effects.placeExResource;
effects.placeExResource = function (state, player) {
  const isReal = state === realState;
  const playerIdx = isReal ? realState.players.indexOf(player) : null;
  const result = origPlaceExResource.call(this, state, player);
  if (isReal) {
    const resourceArea = player.resourceArea;
    events.push({
      type: 'resource',
      turn: realState.turnNumber,
      player: playerIdx,
      resource: instanceRef(resourceArea[resourceArea.length - 1])
    });
  }
  return result;
};

// Burst effects (e.g. "add this Shield to your hand") are looked up and invoked entirely within
// combat.js's resolveBurst -- `const burstEffect = shieldInstance.def.effects.burst` is captured
// BEFORE hooks.chooseBurst is even called, so patching def.effects.burst from inside the chooseBurst
// hook below would be one call too late (resolveBurst still fires the reference it grabbed earlier).
// Instead, every burst effect on every card def is wrapped exactly once here, permanently, at module
// load -- resolveBurst re-reads `def.effects.burst` fresh on every single call, so whichever function
// currently sits there (ours) is always what gets invoked, regardless of which of the 3 call sites
// triggered it (combat.js's 2 internal bare calls, or registry.js's external one for cards like
// Interwoven Blessings GD05-107). `state` is still one of burstEffect's real arguments, so the usual
// state === realState guard works unmodified. `pendingBurstEvents` (populated by the chooseBurst hook
// in traceGame() below, keyed by the specific shieldInstance object) lets this patch fill in
// `endedUpInHand` on the exact event that was already pushed for this reveal, checked right after the
// effect finishes -- resolveBurst's own trailing "push to trash if untracked" fallback hasn't run yet
// at that point, but nothing between here and there can move the card anywhere else, so hand
// membership measured now already matches the card's final resting place.
const { listAllCards } = require('../cards/index');
const pendingBurstEvents = new Map();
for (const def of listAllCards()) {
  const origBurst = def.effects && def.effects.burst;
  if (!origBurst) continue;
  def.effects.burst = function (state, defendingPlayer, shieldInstance, context) {
    const result = origBurst.call(this, state, defendingPlayer, shieldInstance, context);
    if (state === realState) {
      const ev = pendingBurstEvents.get(shieldInstance);
      if (ev) {
        ev.endedUpInHand = defendingPlayer.hand.includes(shieldInstance);
        pendingBurstEvents.delete(shieldInstance);
      }
    }
    return result;
  };
}

// require AFTER patching, per the module-level comment above.
const { initializeGame } = require('../rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../rules/phases');
const { checkDefeat } = require('../rules/management');
const { decideMulligan, lookaheadHooks, runMainPhase } = require('../ai/heuristic');
const { runMainPhaseMCTS } = require('../ai/mcts');
const { mulberry32 } = require('../rules/rng');

const MAX_TURNS = 60;

/**
 * `deckA`/`deckB` are {main, resource} CardDef arrays (same shape src/sim/singleGame.js takes).
 * `options` mirrors playGame's: engineA/engineB, mctsConfigA/mctsConfigB.
 */
function traceGame(deckA, deckB, seed, options = {}) {
  events = [];
  const rng = mulberry32(seed);
  // mulligan() (src/rules/setup.js) is only ever called from initializeGame's own local scope, as a
  // bare same-module function call, not through module.exports -- so it can't be monkeypatched the
  // way every other event here is. Wrapping the decideMulligan hook itself, which initializeGame
  // does invoke through the options object we control, gets the same information for free: the hand
  // it's asked to judge always belongs to the player currently on the setup path, identifiable via
  // any card instance's own .owner field (src/rules/state.js's createInstance).
  const tracedDecideMulligan = (hand) => {
    const shouldMulligan = decideMulligan(hand);
    events.push({ type: 'mulligan', player: hand[0] ? hand[0].owner : null, mulliganed: shouldMulligan });
    return shouldMulligan;
  };
  const state = initializeGame(deckA, deckB, { decideMulligan: tracedDecideMulligan, rng });
  realState = state;

  // Captured directly here rather than patched -- initializeGame's opening hand isn't behind any
  // function this file can hook, but the final post-mulligan hand is sitting right there once it
  // returns, once per player, in seat order.
  for (let i = 0; i < state.players.length; i++) {
    events.push({ type: 'openingHand', player: i, hand: state.players[i].hand.map((c) => cardRef(c.def)) });
  }

  // 5-17-3: both players start with an EX Base already in play -- initializeGame (src/rules/setup.js)
  // assigns it directly to player.base rather than going through deployBase/becomeBase, so unlike
  // every other Base a player ever has, nothing here would otherwise emit an event for it. Without
  // this, the replay viewer's board (electron/renderer/index.html's buildSnapshot, which only ever
  // populates a player's Base in response to a 'deployBase' event) never shows a player's Base at all
  // for the entire game unless they later deploy a real Base card over the EX Base.
  for (let i = 0; i < state.players.length; i++) {
    events.push({ type: 'baseSetup', player: i, base: instanceRef(state.players[i].base) });
  }

  // 6-2-4: only the second player starts with an EX Resource already in their resource area -- same
  // "assigned directly in setup.js, so nothing else would ever emit an event for it" gap as the EX
  // Base above. Iterates rather than indexing player Two specifically so this stays correct even if a
  // future rules change ever gave both players a starting Resource.
  for (let i = 0; i < state.players.length; i++) {
    for (const resource of state.players[i].resourceArea) {
      events.push({ type: 'resourceSetup', player: i, resource: instanceRef(resource) });
    }
  }

  if (options.mctsConfigA) state.players[0].mctsConfig = options.mctsConfigA;
  if (options.mctsConfigB) state.players[1].mctsConfig = options.mctsConfigB;
  const engines = [options.engineA || 'mcts', options.engineB || 'mcts'];

  events.push({ type: 'gameStart', firstPlayer: state.activePlayerIdx });

  // Wrapping chooseBurst on this one hooks object (rather than patching combat.js's resolveBurst,
  // which -- like mulligan() above -- is only ever called as a bare same-module reference and can't
  // be monkeypatched) works cleanly for a structural reason, not just a state === realState check:
  // every simulated AI trial (heuristic.js's cloned-state attack subsets, mcts.js's rollouts) always
  // builds its OWN fresh defaultHooks()/lookaheadHooks() internally rather than reusing whatever
  // hooks object was passed in from outside -- only the real, finally-applied attack ever threads
  // *this* object through (see runAttacksLookahead's last line and runMainPhaseMCTS's applyAction
  // call). The state-identity check is still here as cheap, explicit insurance matching this file's
  // existing style everywhere else, not because it's structurally required.
  const baseHooks = lookaheadHooks(state);
  const hooks = {
    ...baseHooks,
    // chooseBlocker doesn't take a `state` argument at all (unlike chooseBurst), but the same
    // structural guarantee applies: only the real, finally-applied attack ever threads *this* hooks
    // object through -- every simulated trial builds its own fresh hooks internally -- so there's no
    // real/clone ambiguity to guard against here despite the missing param.
    chooseBlocker(defendingPlayer, attacker, target, attackingPlayer) {
      const blocker = baseHooks.chooseBlocker(defendingPlayer, attacker, target, attackingPlayer);
      if (blocker) {
        events.push({
          type: 'block',
          turn: state.turnNumber,
          player: state.players.indexOf(defendingPlayer),
          blocker: instanceRef(blocker),
          attacker: instanceRef(attacker)
        });
      }
      return blocker;
    },
    chooseBurst(shieldInstance, hookState) {
      const activate = baseHooks.chooseBurst(shieldInstance, hookState);
      if (hookState === realState) {
        const ev = {
          type: 'burst',
          turn: state.turnNumber,
          player: shieldInstance.owner,
          card: cardRef(shieldInstance.def),
          activated: activate,
          endedUpInHand: false
        };
        events.push(ev);
        // Filled in by the global burst-effect patch above, right after the effect itself runs --
        // only relevant when activate is true (the effect never runs otherwise, so it's definitely
        // not in hand).
        if (activate) pendingBurstEvents.set(shieldInstance, ev);
      }
      return activate;
    }
  };
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    events.push({ type: 'turnStart', turn: state.turnNumber, player: state.activePlayerIdx });
    runStartPhase(state);
    const handBeforeDraw = state.players[state.activePlayerIdx].hand.length;
    runDrawPhase(state);
    const activeHand = state.players[state.activePlayerIdx].hand;
    if (activeHand.length > handBeforeDraw) {
      events.push({
        type: 'draw',
        turn: state.turnNumber,
        player: state.activePlayerIdx,
        card: cardRef(activeHand[activeHand.length - 1].def),
        isPhaseDraw: true
      });
    }
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    const resourcesBefore = state.players.map((p) => p.resourceArea.length);
    runResourcePhase(state);
    const resourceArea = state.players[state.activePlayerIdx].resourceArea;
    if (resourceArea.length > resourcesBefore[state.activePlayerIdx]) {
      events.push({
        type: 'resource',
        turn: state.turnNumber,
        player: state.activePlayerIdx,
        resource: instanceRef(resourceArea[resourceArea.length - 1])
      });
    }
    if (engines[state.activePlayerIdx] === 'lookahead') runMainPhase(state, state.activePlayerIdx, hooks);
    else runMainPhaseMCTS(state, state.activePlayerIdx, hooks);
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  events.push({
    type: 'gameEnd',
    winner: state.winner,
    draw: state.draw,
    timedOut: state.winner === null && !state.draw,
    turns: state.turnNumber,
    shields: state.players.map((p) => p.shields.length)
  });

  return events;
}

module.exports = { traceGame };
