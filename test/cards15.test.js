const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { chooseAttackTarget } = require('../src/ai/heuristic');

test('GQuuuuuuX (Omega Psycommu) ST06-001 gains First Strike When Linked only if another friendly (Clan) Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const solo = deployUnit(state, player, lookupCard('ST06-001'));
  pairPilot(state, player, solo, createInstance({ number: 'P1', name: 'Amate Yuzuriha (Machu)', type: 'pilot' }, 0));
  assert.equal(getKeywords(solo).firstStrike, undefined, 'no other (Clan) Unit in play');

  const withAlly = deployUnit(state, player, lookupCard('ST06-001'));
  deployUnit(state, player, { number: 'ally', type: 'unit', traits: ['Clan'], ap: 1, hp: 1 });
  pairPilot(state, player, withAlly, createInstance({ number: 'P2', name: 'Amate Yuzuriha (Machu)', type: 'pilot' }, 0));
  assert.equal(getKeywords(withAlly).firstStrike, true);
});

test('GQuuuuuuX (Omega Psycommu) ST06-002 Deploy only deals 1 damage if another friendly (Clan) Unit is already in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 9 }, 1);
  opponent.battleArea.push(enemy);

  deployUnit(state, player, lookupCard('ST06-002'));
  assert.equal(enemy.damage, 0, 'no other (Clan) Unit yet, no damage');

  deployUnit(state, player, { number: 'ally', type: 'unit', traits: ['Clan'], ap: 1, hp: 1 });
  deployUnit(state, player, lookupCard('ST06-002'));
  assert.equal(enemy.damage, 1);
});

test('Red Gundam ST06-005 Attack buffs up to 2 friendly (Clan) Units AP+2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const redGundam = deployUnit(state, player, lookupCard('ST06-005'));
  const clanAlly1 = deployUnit(state, player, { number: 'C1', type: 'unit', traits: ['Clan'], ap: 3, hp: 1 });
  const clanAlly2 = deployUnit(state, player, { number: 'C2', type: 'unit', traits: ['Clan'], ap: 2, hp: 1 });
  const nonClan = deployUnit(state, player, { number: 'N', type: 'unit', ap: 1, hp: 1 });

  lookupCard('ST06-005').effects.attack(state, player, redGundam, {});
  assert.equal(getAP(redGundam), 6, 'the two highest-AP (Clan) Units get picked, including itself');
  assert.equal(getAP(clanAlly1), 5);
  assert.equal(getAP(clanAlly2), 2, 'only the top 2 by AP are chosen');
  assert.equal(getAP(nonClan), 1, 'not a (Clan) Unit, unaffected');
});

test("Ortega's Rick Dom (GQ) ST06-007 Deploy grants a chosen (Clan) ally a widened active-enemy attack target this turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const ally = deployUnit(state, player, { number: 'C1', type: 'unit', traits: ['Clan'], ap: 5, hp: 5 });
  const activeWeakEnemy = createInstance({ number: 'E', type: 'unit', ap: 2, hp: 3 }, 1);
  opponent.battleArea.push(activeWeakEnemy);

  assert.equal(chooseAttackTarget(opponent, ally).type, 'player', 'an active enemy is not normally a legal target');

  deployUnit(state, player, lookupCard('ST06-007'), undefined, { target: ally });
  const target = chooseAttackTarget(opponent, ally);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, activeWeakEnemy, 'now legal thanks to the granted activeTargetAPThreshold buff');
});

test('Amate Yuzuriha (Machu) ST06-009 When Linked reveals a peeked (Clan) card to hand, else returns it to the bottom', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit', traits: ['Earth Federation'] }, 0));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, linkCondition: 'Amate Yuzuriha (Machu)' });
  pairPilot(state, player, unit, createInstance(lookupCard('ST06-009'), 0));
  assert.equal(unit.isLinkUnit, true, 'sanity check: the pairing actually linked');
  assert.equal(player.hand.length, 0, 'not a (Clan) card, sent to the bottom');
  assert.equal(player.deck.length, 1);
});

test('Shuji Itō ST06-010 Attack scries the top card only During Link and only with a (Clan) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit', traits: ['Clan'] }, 0));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, unit, createInstance({ number: 'P', name: 'Shuji Itō', type: 'pilot' }, 0));
  assert.equal(unit.isLinkUnit, false, 'no matching link condition/trait on this generic pilot');

  lookupCard('ST06-010').effects.attack(state, player, unit);
  assert.equal(player.deck.length, 1, 'not a Link Unit, no scry happened');

  deployUnit(state, player, { number: 'C1', type: 'unit', traits: ['Clan'], ap: 1, hp: 1 });
  const linkedUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, linkCondition: 'Shuji Itō' });
  pairPilot(state, player, linkedUnit, createInstance({ number: 'P2', name: 'Shuji Itō', type: 'pilot' }, 0));
  assert.equal(linkedUnit.isLinkUnit, true);
  player.deck.unshift(createInstance({ number: 'D0', type: 'unit', traits: ['Earth Federation'] }, 0));
  lookupCard('ST06-010').effects.attack(state, player, linkedUnit);
  assert.equal(player.deck.length, 2, 'a pure scry: no card leaves the deck');
  assert.equal(player.deck[player.deck.length - 1].def.number, 'D0', 'non-(Clan) card sent to the bottom');
});

test('Schoolgirl and Smuggler ST06-012 digs 3, reveals a (Clan) Unit/Pilot card to hand, shuffles the rest to the bottom', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const clanPilot = createInstance({ number: 'D2', type: 'pilot', traits: ['Clan'] }, 0);
  player.deck.push(
    createInstance({ number: 'D1', type: 'unit', traits: ['Earth Federation'] }, 0),
    clanPilot,
    createInstance({ number: 'D3', type: 'unit', traits: ['Earth Federation'] }, 0)
  );
  lookupCard('ST06-012').effects.command(state, player, createInstance(lookupCard('ST06-012'), 0), {});
  assert.equal(player.hand.includes(clanPilot), true);
  assert.equal(player.deck.length, 2);
});

test('GQuuuuuuX (Omega Psycommu) GD02-038 Deploy digs 3 and deploys a (Clan) Lv.4-or-lower Unit found among them', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(
    createInstance({ number: 'D1', type: 'unit', traits: ['Earth Federation'], level: 2 }, 0),
    createInstance({ number: 'D2', type: 'unit', traits: ['Clan'], level: 4, ap: 2, hp: 2 }, 0),
    createInstance({ number: 'D3', type: 'unit', traits: ['Earth Federation'], level: 2 }, 0)
  );
  deployUnit(state, player, lookupCard('GD02-038'));
  assert.equal(player.battleArea.some((u) => u.def.number === 'D2'), true);
  assert.equal(player.deck.length, 2);
});

test("Shuji's Hideout GD02-126 Destroyed deals 1 damage to a Lv.4-or-lower enemy Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = createInstance({ number: 'E', type: 'unit', level: 4, ap: 1, hp: 5 }, 1);
  opponent.battleArea.push(target);
  lookupCard('GD02-126').effects.destroyed(state, player, createInstance(lookupCard('GD02-126'), 0), {});
  assert.equal(target.damage, 1);
});

test('Red Gundam GD03-039 Deploy rests an active (Clan) ally, then deals 2 damage to a 2-or-less-AP enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const ally = deployUnit(state, player, { number: 'C1', type: 'unit', traits: ['Clan'], ap: 1, hp: 1 });
  const weakEnemy = createInstance({ number: 'E1', type: 'unit', ap: 2, hp: 5 }, 1);
  const strongEnemy = createInstance({ number: 'E2', type: 'unit', ap: 3, hp: 5 }, 1);
  opponent.battleArea.push(weakEnemy, strongEnemy);

  deployUnit(state, player, lookupCard('GD03-039'));
  assert.equal(ally.rested, true, 'the other active (Clan) Unit was rested as the cost');
  assert.equal(weakEnemy.damage, 2);
  assert.equal(strongEnemy.damage, 0, 'AP too high to be a legal target');
});
