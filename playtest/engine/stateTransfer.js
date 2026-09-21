const { lookupCard } = require('../../src/cards/index');

/**
 * Worker-thread transfer for game state. structured-clone (what postMessage uses) can't carry live
 * function references across the thread boundary. Only a real card-database def carries any -- see
 * src/cards/index.js's resolveEffects, which is the sole place `.effects` (live functions resolved from
 * src/effects/registry.js) ever gets attached to a def, and only for defs loaded from the JSON card
 * files. Every other `def` in the state graph -- vanilla cards with no ability text, and every one of
 * the many rules/token defs created as plain literals directly in setup.js/registry.js (EX Base, EX
 * Resource, plain Resource, Wire-Guided Arm, Pluma, ...) -- has no `.effects` and is already plain data,
 * so it crosses postMessage's structured-clone unassisted with no special handling needed, and there's
 * no need to enumerate every such token by name here.
 *
 * stripDefs swaps only a `.effects`-bearing `def` for its card number on the way out to the worker;
 * rehydrateDefs looks it back up via src/cards/index.js's own registry (loaded fresh in the worker
 * process, so still live) on the way in. Everything else passes through untouched.
 *
 * Known gap: a runtime-rebuilt def (registry.js's Isaribi ST05-015 mode change does
 * `instance.def = Object.assign({}, instance.def, {type: 'unit', ...})`, keeping the same card number)
 * still has `.effects`, so it round-trips via number -- which resolves back to the *original* def, not
 * the rebuilt one. The worker's search would see Isaribi in its original mode for that one decision, a
 * minor search-quality gap for one specific card, not a crash or a real-state corruption (the real,
 * live main-thread state is never touched by any of this).
 */
function walk(value, seen, onDef) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(walk(item, seen, onDef));
    return clone;
  }

  const clone = {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    clone[key] = key === 'def' ? onDef(value[key]) : walk(value[key], seen, onDef);
  }
  return clone;
}

function stripDefs(state) {
  return walk(state, new Map(), (def) => (def && def.effects ? { __cardNumber: def.number } : def));
}

function rehydrateDefs(data) {
  return walk(data, new Map(), (value) => (value && value.__cardNumber !== undefined ? lookupCard(value.__cardNumber) : value));
}

module.exports = { stripDefs, rehydrateDefs };
