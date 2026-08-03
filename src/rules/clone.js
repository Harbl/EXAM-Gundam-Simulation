/**
 * Identity-preserving deep clone of a game state, for AI lookahead (try an action on a clone, score
 * the result, discard it). Deliberately generic rather than a maintained field allowlist: recurses
 * into every array/plain-object property so any new ad-hoc field registry.js adds later (there are
 * many -- specialMoveActivatedThisTurn, shieldDamageImmuneLevelCap, onKillSetActiveTraits, etc.) is
 * cloned automatically without this function needing to track it.
 *
 * The one special case: a property literally named `def` is copied by reference, never recursed
 * into. Card defs are shared, frozen templates carrying live effect functions (src/cards/index.js's
 * resolveEffects) that can't and shouldn't be cloned -- confirmed via audit that this is the only
 * place a function reference lives in the state graph, and the one runtime def-rebuild (Isaribi mode
 * change, effects/registry.js) still stores its result under `instance.def`, so this single key-based
 * case covers it too.
 */
function cloneState(state) {
  const seen = new Map();

  function cloneValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (Array.isArray(value)) {
      const clone = [];
      seen.set(value, clone);
      for (const item of value) clone.push(cloneValue(item));
      return clone;
    }

    const clone = {};
    seen.set(value, clone);
    for (const key of Object.keys(value)) {
      clone[key] = key === 'def' ? value[key] : cloneValue(value[key]);
    }
    return clone;
  }

  return cloneValue(state);
}

module.exports = { cloneState };
