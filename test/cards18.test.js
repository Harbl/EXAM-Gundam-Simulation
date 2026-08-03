const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getKeywords, getRemainingHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { chooseAttackTarget } = require('../src/ai/heuristic');

test('Adzam GD01-038 Deploy only wipes all enemy Units for 1 damage once 5+ enemy Units are in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 4; i++) opponent.battleArea.push(createInstance({ number: `E${i}`, type: 'unit', hp: 2 }, 1));
  deployUnit(state, player, lookupCard('GD01-038'));
  assert.equal(opponent.battleArea.every((u) => u.damage === 0), true, 'only 4 enemy Units -- condition not met yet');

  opponent.battleArea.push(createInstance({ number: 'E4', type: 'unit', hp: 2 }, 1));
  deployUnit(state, player, lookupCard('GD01-038'));
  assert.equal(opponent.battleArea.every((u) => u.damage === 1), true, '5 enemy Units in play -- all take 1 damage');
});

test('Dopp GD01-039 reuses the Kayra\'s Re-GZ scry (keep a Unit/Base on top, bury anything else)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'CMD', type: 'command' }, 0));
  deployUnit(state, player, lookupCard('GD01-039'));
  assert.equal(player.deck[player.deck.length - 1].def.number, 'CMD', 'a non-Unit/Base is buried to the bottom');
});

test("Duo's Leo GD01-042 may target an active enemy Unit at Lv.2 or lower via the shared activeTargetLevelCap mechanism", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const leo = createInstance(lookupCard('GD01-042'), 0);
  const activeLowLevel = createInstance({ number: 'LOW', type: 'unit', level: 2, ap: 1, hp: 2 }, 1);
  opponent.battleArea.push(activeLowLevel);
  const target = chooseAttackTarget(opponent, leo);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, activeLowLevel, 'an active Lv.2 enemy is a legal, favorable-trade target thanks to the level cap');
});

test("Rasid's Maganac GD01-043 Deploy grants a friendly green Unit a fixed AP<=4 active-target threshold for the turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const otherGreen = deployUnit(state, player, { number: 'OG', type: 'unit', color: 'green', ap: 5, hp: 5 });
  deployUnit(state, player, lookupCard('GD01-043'));
  assert.equal(otherGreen.buffs.some((b) => b.activeTargetAPThreshold === 4), true, 'the highest-AP green Unit is granted the buff');
});

test('Duel Gundam GD01-045 When Paired may deploy a Lv.4-or-lower (ZAFT) Unit found among the top 3 cards, for free', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(
    createInstance({ number: 'ZAFT4', type: 'unit', traits: ['ZAFT'], level: 4 }, 0),
    createInstance({ number: 'ZAFT6', type: 'unit', traits: ['ZAFT'], level: 6 }, 0),
    createInstance({ number: 'X', type: 'command' }, 0)
  );
  const duel = deployUnit(state, player, lookupCard('GD01-045'));
  pairPilot(state, player, duel, createInstance({ number: 'P', name: 'Yzak Jule', type: 'pilot' }, 0));

  assert.equal(player.battleArea.some((u) => u.def.number === 'ZAFT4'), true, 'the Lv.4 (ZAFT) Unit was deployed for free');
  assert.equal(player.deck.length, 2, 'the other 2 top-3 cards were buried, not the deployed one');
});

test('Shamblo GD01-047 Attack deals 3 to an enemy Unit only with 2+ other rested friendly Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', hp: 10 }, 1);
  opponent.battleArea.push(enemy);
  const shamblo = deployUnit(state, player, lookupCard('GD01-047'));
  shamblo.turnDeployed = 0;
  resolveAttack(state, 0, shamblo, { type: 'player' });
  assert.equal(enemy.damage, 0, 'no other rested friendly Units yet -- no bonus damage');

  const ally1 = deployUnit(state, player, { number: 'A1', type: 'unit', ap: 1, hp: 1 });
  const ally2 = deployUnit(state, player, { number: 'A2', type: 'unit', ap: 1, hp: 1 });
  ally1.rested = true;
  ally2.rested = true;
  shamblo.rested = false;
  resolveAttack(state, 0, shamblo, { type: 'player' });
  assert.equal(enemy.damage, 3, '2 other rested friendly Units -- deals 3 bonus damage to the chosen enemy Unit');
});

test('Zaku I Sniper Type GD01-048 Deploy adds a (Zeon)/(Neo Zeon) Unit off the top of the deck to hand, or buries a non-match', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'ZU', type: 'unit', traits: ['Zeon'] }, 0));
  deployUnit(state, player, lookupCard('GD01-048'));
  assert.equal(player.hand.some((c) => c.def.number === 'ZU'), true);

  const player2 = createPlayer(0);
  const state2 = createGame(player2, createPlayer(1));
  player2.deck.push(createInstance({ number: 'NONMATCH', type: 'command' }, 0));
  deployUnit(state2, player2, lookupCard('GD01-048'));
  assert.equal(player2.hand.length, 0, 'a non-(Zeon)/(Neo Zeon) card is not added to hand');
  assert.equal(player2.deck.some((c) => c.def.number === 'NONMATCH'), true, 'and is returned to the deck instead');
});

test('Blitz Gundam GD01-049 Deploy grants First Strike this turn only to a (ZAFT) Unit with 5+ AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weakZaft = deployUnit(state, player, { number: 'WZ', type: 'unit', traits: ['ZAFT'], ap: 3, hp: 3 });
  const strongZaft = deployUnit(state, player, { number: 'SZ', type: 'unit', traits: ['ZAFT'], ap: 5, hp: 3 });
  deployUnit(state, player, lookupCard('GD01-049'));
  assert.equal(getKeywords(strongZaft).firstStrike, true);
  assert.equal(getKeywords(weakZaft).firstStrike, undefined);
});

test('LaGOWE GD01-050 Attack deals 2 bonus damage to a chosen enemy Unit only at 5+ AP and only when attacking a Unit (not the player)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lagowe = deployUnit(state, player, lookupCard('GD01-050'));
  lagowe.turnDeployed = 0;
  const attackTarget = createInstance({ number: 'T', type: 'unit', hp: 10 }, 1);
  const otherEnemy = createInstance({ number: 'O', type: 'unit', hp: 3 }, 1);
  opponent.battleArea.push(attackTarget, otherEnemy);
  attackTarget.rested = true;

  resolveAttack(state, 0, lagowe, { type: 'unit', instance: attackTarget });
  assert.equal(otherEnemy.damage, 0, 'base AP 2 is below the 5 AP threshold -- no bonus damage');

  lagowe.buffs.push({ ap: 3, scope: 'battle' });
  lagowe.rested = false;
  attackTarget.rested = true;
  resolveAttack(state, 0, lagowe, { type: 'unit', instance: attackTarget });
  assert.equal(otherEnemy.damage, 2, '5+ AP attacking a Unit -- 2 bonus damage lands on the chosen enemy Unit');
});

test('Geara Zulu GD01-052 Deploy deals 1 damage to any enemy Unit, active or rested', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const activeEnemy = createInstance({ number: 'A', type: 'unit', hp: 1 }, 1);
  opponent.battleArea.push(activeEnemy);
  deployUnit(state, player, lookupCard('GD01-052'));
  assert.equal(opponent.battleArea.includes(activeEnemy), false, '1 HP active enemy Unit takes lethal 1 damage and is destroyed');
});
