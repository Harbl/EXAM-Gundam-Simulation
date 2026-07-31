const PHASE = Object.freeze({ START: 'start', DRAW: 'draw', RESOURCE: 'resource', MAIN: 'main', END: 'end' });

const LIMITS = Object.freeze({
  DECK_SIZE: 50,
  RESOURCE_DECK_SIZE: 10,
  MAX_COPIES: 4,
  MAX_BATTLE_AREA: 6,
  MAX_BASE: 1,
  MAX_HAND: 10,
  MAX_RESOURCE_AREA: 15,
  MAX_EX_RESOURCE: 5,
  SHIELD_COUNT: 6,
  STARTING_HAND: 5
});

module.exports = { PHASE, LIMITS };
