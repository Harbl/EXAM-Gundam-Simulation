const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { chooseAttackTarget } = require('../src/ai/heuristic');
const { lookupCard } = require('../src/cards/index');
const registry = require('../src/effects/registry');

test('Ellis Claude EB01-061: When Paired rests a Lv.3- enemy, gated on a friendly (G Generation) Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 2, level: 3 });
  registry.ellisClaudeWhenPaired(state, player);
  assert.equal(target.rested, false, 'no friendly (G Generation) Unit: no effect');

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'] });
  registry.ellisClaudeWhenPaired(state, player);
  assert.equal(target.rested, true);
});

test('Jona Basta EB01-062: Attack offers the opponent a free draw, giving this controller 1 too, Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  opponent.deck.push(createInstance({ number: 'D2', type: 'unit' }, 1));

  registry.jonaBastaAttack(state, player, unit);
  assert.equal(player.hand.length, 1);
  assert.equal(opponent.hand.length, 1);

  player.deck.push(createInstance({ number: 'D3', type: 'unit' }, 0));
  registry.jonaBastaAttack(state, player, unit);
  assert.equal(player.hand.length, 1, 'Once per Turn: no second draw');
});

test('Io Fleming EB01-063: startOfTurn grants Repair 2 at 2+ other rested Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  registry.ioFlemingStartOfTurn(state, player, unit);
  assert.equal(unit.grantedKeywords.repair, 0);

  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 }).rested = true;
  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.ioFlemingStartOfTurn(state, player, unit);
  assert.equal(unit.grantedKeywords.repair, 2);
});

test('Rondo Gina Sahaku EB01-064: startOfTurn grants Breach 1 while the Unit has Repair', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  registry.rondoGinaSahakuStartOfTurn(state, player, unit);
  assert.equal(unit.grantedKeywords.breach, 0);

  unit.def = { ...unit.def, keywords: { repair: 1 } };
  registry.rondoGinaSahakuStartOfTurn(state, player, unit);
  assert.equal(unit.grantedKeywords.breach, 1);
});

test('Meir Siva EB01-065: When Linked grants a friendly (G Generation) Unit Breach 1 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, traits: ['G Generation'] });
  registry.meirSivaWhenLinked(state, player);
  assert.equal(target.buffs.some((b) => b.breach === 1), true);
});

test('Reiji EB01-066: When Paired lets a friendly (G Generation) Unit target an active Blocker enemy this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5, traits: ['G Generation'] });
  const activeBlocker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, keywords: { blocker: true } });

  assert.equal(chooseAttackTarget(opponent, attacker, true), null, 'active Blocker not targetable without the grant');

  registry.reijiWhenPaired(state, player);
  const result = chooseAttackTarget(opponent, attacker, true);
  assert.equal(result.type, 'unit');
  assert.equal(result.instance, activeBlocker);
});

test('Asuna Elmarit EB01-067: When Paired returns a revealed (G Generation) Unit to the top of the deck', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const match = createInstance({ number: 'D1', type: 'unit', traits: ['G Generation'] }, 0);
  player.deck.push(match, createInstance({ number: 'D2', type: 'unit' }, 0), createInstance({ number: 'D3', type: 'unit' }, 0));
  registry.asunaElmaritWhenPaired(state, player);
  assert.equal(player.deck[0], match);
  assert.equal(player.deck.length, 3);
});

test("Chall Acustica EB01-068: Destroyed returns itself from trash to the top of the deck, During Link only", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  const pilot = createInstance(lookupCard('EB01-068'), 0);
  player.trash.push(pilot);

  registry.challAcusticaDestroyed(state, player, unit, { pilot });
  assert.equal(player.deck.includes(pilot), false, 'not a Link Unit: no effect');

  unit.isLinkUnit = true;
  registry.challAcusticaDestroyed(state, player, unit, { pilot });
  assert.equal(player.deck[0], pilot);
  assert.equal(player.trash.includes(pilot), false);
});

test('Beside Pain EB01-069: Attack gives a friendly Blocker Unit AP+2 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3, keywords: { blocker: true } });
  registry.besidePainAttack(state, player);
  assert.equal(target.buffs.some((b) => b.ap === 2), true);
});

test('Daryl Lorenz EB01-070: ActivateAction grants AP+1 for the battle only during the opponent\'s turn, During Link, gated on (1) cost + Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  const target = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource', color: 'white' }, 0));

  state.activePlayerIdx = 1;
  assert.equal(registry.darylLorenzActivateAction(state, player, instance, { target }), false, 'not a Link Unit yet -- fails');

  instance.isLinkUnit = true;
  state.activePlayerIdx = 0;
  registry.darylLorenzActivateAction(state, player, instance, { target });
  assert.equal(target.buffs.length, 0, "player's own turn: no effect");

  state.activePlayerIdx = 1;
  assert.equal(registry.darylLorenzActivateAction(state, player, instance, { target }), true);
  assert.equal(target.buffs.some((b) => b.ap === 1), true);
  assert.equal(player.resourceArea[0].rested, true, 'paid the (1) cost');

  assert.equal(registry.darylLorenzActivateAction(state, player, instance, { target }), false, 'Once per Turn -- already used');
});

test('Ittou Tsurugi EB01-071: During Link AP+1 via data field, read by getAP', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, linkCondition: 'Attack' });
  pairPilot(state, player, unit, createInstance(lookupCard('EB01-071'), 0));
  assert.equal(getAP(unit), 3 + 2 + 1, 'base 3 + apBonus 2 + duringLinkAp 1');
});

test('Yuu Kajima EB01-072: When Paired rests an active friendly Blocker and a Lv.4- enemy independently', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendlyBlocker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3, keywords: { blocker: true } });
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 4 });
  registry.yuuKajimaWhenPaired(state, player);
  assert.equal(friendlyBlocker.rested, true);
  assert.equal(enemy.rested, true);
});
