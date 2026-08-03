const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getKeywords, getAP } = require('../src/rules/management');
const { resolveUnitBattleDamage } = require('../src/rules/combat');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('Geara Doga GD01-053 Activate·Main costs 1 Resource, Once per Turn, deals 1 to an enemy Unit with 2 or less AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gearaDoga = deployUnit(state, player, lookupCard('GD01-053'));
  player.resourceArea.push(resource());
  const tooStrong = createInstance({ number: 'TS', type: 'unit', ap: 3, hp: 5 }, 1);
  const weak = createInstance({ number: 'W', type: 'unit', ap: 2, hp: 5 }, 1);
  opponent.battleArea.push(tooStrong, weak);

  const result = gearaDoga.def.effects.activateMain(state, player, gearaDoga, {});
  assert.equal(result, true);
  assert.equal(weak.damage, 1, '2 AP or less is a legal target');
  assert.equal(tooStrong.damage, 0, '3 AP is too strong to target');
  assert.equal(player.resourceArea[0].rested, true, 'costs 1 Resource');

  const secondTry = gearaDoga.def.effects.activateMain(state, player, gearaDoga, {});
  assert.equal(secondTry, false, 'Once per Turn -- already used');
});

test('Geara Doga GD01-056 Destroyed deals 1 damage to an enemy Unit with 5 or less AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = createInstance({ number: 'T', type: 'unit', ap: 5, hp: 2 }, 1);
  opponent.battleArea.push(target);
  const gearaDoga = deployUnit(state, player, lookupCard('GD01-056'));
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 10, hp: 10 }, 1);
  opponent.battleArea.push(attacker);
  gearaDoga.damage = 3; // lethal (3 HP)
  resolveUnitBattleDamage(state, opponent, player, attacker, gearaDoga, {});

  assert.equal(target.damage, 1);
});

test('Duel Gundam GD01-054 gains Breach 3 live, only while its own current AP is 5 or higher', () => {
  const player = createPlayer(0);
  const duel = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-054'));
  assert.equal(getKeywords(duel).breach, undefined, 'base AP 3 -- below the threshold');
  duel.buffs.push({ ap: 2, scope: 'turn' });
  assert.equal(getAP(duel), 5);
  assert.equal(getKeywords(duel).breach, 3, 'now at 5+ AP -- Breach 3 kicks in live');
  duel.buffs = [];
  assert.equal(getKeywords(duel).breach, undefined, 'and drops right back out once AP falls again');
});

test("Galluss-K GD01-058 Activate·Action costs 1 Resource, Once per Turn, buffs a Lv.4+ Unit's AP for the battle", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gallussK = deployUnit(state, player, lookupCard('GD01-058'));
  player.resourceArea.push(resource());
  const lowLevel = createInstance({ number: 'LO', type: 'unit', level: 3, ap: 1, hp: 1 }, 0);
  const highLevel = createInstance({ number: 'HI', type: 'unit', level: 4, ap: 1, hp: 1 }, 0);

  assert.equal(gallussK.def.effects.activateAction(state, player, gallussK, { target: lowLevel }), false, 'Lv.3 is too low');
  assert.equal(gallussK.def.effects.activateAction(state, player, gallussK, { target: highLevel }), true);
  assert.equal(getAP(highLevel), 2);
  assert.equal(player.resourceArea[0].rested, true);
  assert.equal(gallussK.def.effects.activateAction(state, player, gallussK, { target: highLevel }), false, 'Once per Turn');
});

test('Zee Zulu GD01-059 gets AP+2 for the battle only when attacking the enemy player directly', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const zeeZulu = deployUnit(state, player, lookupCard('GD01-059'));

  zeeZulu.def.effects.attack(state, player, zeeZulu, { target: { type: 'unit', instance: {} } });
  assert.equal(getAP(zeeZulu), 2, 'attacking a Unit -- no bonus');

  zeeZulu.def.effects.attack(state, player, zeeZulu, { target: { type: 'player' } });
  assert.equal(getAP(zeeZulu), 4, 'attacking the player -- AP+2 for this battle (cleared at battle-end, not turn-end)');
});

test('ZnO GD01-063 gains First Strike for the battle only when attacking a Lv.2-or-lower enemy Unit', () => {
  const player = createPlayer(0);
  const zno = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-063'));

  const highLevelEnemy = createInstance({ number: 'HI', type: 'unit', level: 3 }, 1);
  zno.def.effects.attack({}, player, zno, { target: { type: 'unit', instance: highLevelEnemy } });
  assert.equal(getKeywords(zno).firstStrike, undefined, 'Lv.3 enemy -- no First Strike');

  const lowLevelEnemy = createInstance({ number: 'LO', type: 'unit', level: 2 }, 1);
  zno.def.effects.attack({}, player, zno, { target: { type: 'unit', instance: lowLevelEnemy } });
  assert.equal(getKeywords(zno).firstStrike, true, 'Lv.2 enemy -- First Strike granted for this battle');
});

test('Freedom Gundam GD01-065 (During Pair, Once per Turn) debuffs the strongest enemy AP-2 whenever a Pilot pairs with it or another white Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(enemy);
  const freedom = deployUnit(state, player, lookupCard('GD01-065'));
  const otherWhite = deployUnit(state, player, { number: 'OW', type: 'unit', color: 'white', ap: 1, hp: 1 });

  pairPilot(state, player, otherWhite, createInstance({ number: 'P0', type: 'pilot' }, 0));
  assert.equal(getAP(enemy), 5, "Freedom Gundam isn't paired yet -- During Pair not active");

  pairPilot(state, player, freedom, createInstance({ number: 'P1', name: 'Kira Yamato', type: 'pilot' }, 0));
  assert.equal(getAP(enemy), 3, 'pairing Freedom Gundam itself triggers the AP-2 debuff');

  const anotherWhite = deployUnit(state, player, { number: 'AW', type: 'unit', color: 'white', ap: 1, hp: 1 });
  pairPilot(state, player, anotherWhite, createInstance({ number: 'P2', type: 'pilot' }, 0));
  assert.equal(getAP(enemy), 3, 'Once per Turn already used -- no further debuff this turn');
});
