let nextInstanceId = 1;

/** A card definition is static data: {number, name, type, color, level, cost, ap, hp, traits, keywords, linkCondition, isToken}. */
function createInstance(def, owner) {
  return {
    id: nextInstanceId++,
    def,
    owner,
    rested: false,
    damage: 0,
    pilot: null, // paired Pilot instance, units only
    turnDeployed: null, // state.turnNumber when it entered the battle area
    isLinkUnit: false, // true if deployed with its link condition satisfied (can attack immediately)
    buffs: [], // {ap, hp, scope: 'turn' | 'battle'}
    grantedKeywords: {} // keywords gained from other cards' effects, merged over def.keywords
  };
}

function createPlayer(id) {
  return {
    id,
    deck: [],
    resourceDeck: [],
    hand: [],
    resourceArea: [],
    battleArea: [],
    base: null,
    shields: [],
    trash: [],
    removal: [],
    defeated: false
  };
}

function createGame(playerA, playerB) {
  return {
    players: [playerA, playerB],
    activePlayerIdx: 0,
    turnNumber: 1,
    phase: null,
    winner: null
  };
}

function activePlayer(state) {
  return state.players[state.activePlayerIdx];
}

function standbyPlayer(state) {
  return state.players[1 - state.activePlayerIdx];
}

function playerIndexOf(state, player) {
  return state.players.indexOf(player);
}

function isCardTracked(player, instance) {
  return (
    player.hand.includes(instance) ||
    player.battleArea.includes(instance) ||
    player.trash.includes(instance) ||
    player.shields.includes(instance) ||
    player.base === instance
  );
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

module.exports = {
  createInstance,
  createPlayer,
  createGame,
  activePlayer,
  standbyPlayer,
  playerIndexOf,
  isCardTracked,
  shuffle
};
