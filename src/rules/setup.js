const { createInstance, createPlayer, createGame, shuffle } = require('./state');
const { LIMITS } = require('./constants');

// Fixed rules tokens (5-17-3), not researched card data -- these come straight from the rules text.
const EX_BASE_DEF = Object.freeze({
  number: 'EX-BASE',
  name: 'EX Base',
  type: 'base',
  ap: 0,
  hp: 3,
  isToken: true,
  keywords: {}
});
const EX_RESOURCE_DEF = Object.freeze({
  number: 'EX-RESOURCE',
  name: 'EX Resource',
  type: 'resource',
  cost: 0,
  level: 0,
  isToken: true
});

function buildPlayer(id, mainDeckDefs, resourceDeckDefs, rng) {
  const player = createPlayer(id);
  player.deck = shuffle(mainDeckDefs.map((def) => createInstance(def, id)), rng);
  player.resourceDeck = shuffle(resourceDeckDefs.map((def) => createInstance(def, id)), rng);
  return player;
}

function draw(player, count) {
  for (let i = 0; i < count; i++) {
    if (player.deck.length === 0) return;
    player.hand.push(player.deck.shift());
  }
}

/** 6-2-1-6: an optional one-time full mulligan -- entire hand to the bottom, draw 5, then shuffle. */
function mulligan(player, decideMulligan, rng) {
  const shouldMulligan = decideMulligan ? decideMulligan(player.hand) : false;
  if (!shouldMulligan) return;
  player.deck.push(...player.hand);
  player.hand = [];
  draw(player, LIMITS.STARTING_HAND);
  shuffle(player.deck, rng);
}

function dealShields(player) {
  for (let i = 0; i < LIMITS.SHIELD_COUNT; i++) {
    if (player.deck.length === 0) break;
    player.shields.push(player.deck.shift());
  }
}

/**
 * `deckA`/`deckB` are {main: CardDef[], resource: CardDef[]} with duplicates already expanded
 * (deck-list parsing/validation happens in src/deck, upstream of this).
 */
function initializeGame(deckA, deckB, options = {}) {
  // Seeded via options.rng (see src/rules/rng.js's mulberry32) for exact game reproducibility --
  // the replay viewer feature re-runs a past game from just its seed. Defaults to Math.random, the
  // only two call sites of which (both shuffles, plus this file's own coin flip below) this rng
  // now covers, so a seeded game is fully deterministic end to end.
  const rng = options.rng || Math.random;
  const playerA = buildPlayer(0, deckA.main, deckA.resource, rng);
  const playerB = buildPlayer(1, deckB.main, deckB.resource, rng);
  const players = [playerA, playerB];

  draw(playerA, LIMITS.STARTING_HAND);
  draw(playerB, LIMITS.STARTING_HAND);

  const firstIdx = options.decideFirstPlayerIdx ? options.decideFirstPlayerIdx() : rng() < 0.5 ? 0 : 1;
  const secondIdx = 1 - firstIdx;

  // 6-2-1-6/7: Player One decides on their mulligan before Player Two does.
  mulligan(players[firstIdx], options.decideMulligan, rng);
  mulligan(players[secondIdx], options.decideMulligan, rng);

  dealShields(players[firstIdx]);
  dealShields(players[secondIdx]);

  players[firstIdx].base = createInstance(EX_BASE_DEF, players[firstIdx].id);
  players[secondIdx].base = createInstance(EX_BASE_DEF, players[secondIdx].id);

  // 6-2-4: only Player Two starts with an EX Resource.
  players[secondIdx].resourceArea.push(createInstance(EX_RESOURCE_DEF, players[secondIdx].id));

  const state = createGame(playerA, playerB);
  state.activePlayerIdx = firstIdx;
  state.phase = 'start';
  return state;
}

module.exports = { initializeGame, draw, mulligan, dealShields, EX_BASE_DEF, EX_RESOURCE_DEF };
