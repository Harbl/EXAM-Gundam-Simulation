const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { applyRepairAtEndOfTurn } = require('../src/rules/effects');
const { canAfford, payCost } = require('../src/rules/cost');

test('Zeydra GD03-054 When Paired: (X-Rounder) Pilot may exile 4 (Vagan) cards from trash to destroy a Lv.4-or-lower enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zeydra = deployUnit(state, player, lookupCard('GD03-054'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3, level: 4 });
  for (let i = 0; i < 3; i++) player.trash.push({ def: { type: 'unit', traits: ['Vagan'] } });

  pairPilot(state, player, zeydra, createInstance({ number: 'P1', name: 'Non-Rounder', type: 'pilot', traits: [] }, 0));
  assert.ok(opponent.battleArea.includes(enemy), 'non-X-Rounder Pilot -- no reaction');

  const zeydra2 = deployUnit(state, player, lookupCard('GD03-054'));
  pairPilot(state, player, zeydra2, createInstance({ number: 'P2', name: 'Rounder Ace', type: 'pilot', traits: ['X-Rounder'] }, 0));
  assert.ok(opponent.battleArea.includes(enemy), 'X-Rounder Pilot, but only 3 (Vagan) cards in trash -- not enough');

  player.trash.push({ def: { type: 'unit', traits: ['Vagan'] } });
  const zeydra3 = deployUnit(state, player, lookupCard('GD03-054'));
  pairPilot(state, player, zeydra3, createInstance({ number: 'P3', name: 'Rounder Ace 2', type: 'pilot', traits: ['X-Rounder'] }, 0));
  assert.ok(!opponent.battleArea.includes(enemy), '4 (Vagan) cards in trash -- destroys the chosen Lv.4-or-lower enemy');
  assert.equal(player.trash.filter((c) => (c.def.traits || []).includes('Vagan')).length, 0, 'all 4 (Vagan) cards were exiled, not left in trash');
});

test("Gundam Hajiroboshi (2nd Form) GD03-055 When Paired: Purple Pilot destroys a Lv.2-or-lower enemy", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hajiroboshi = deployUnit(state, player, lookupCard('GD03-055'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3, level: 2 });

  pairPilot(state, player, hajiroboshi, createInstance({ number: 'P1', name: 'Red Pilot', type: 'pilot', color: 'red' }, 0));
  assert.ok(opponent.battleArea.includes(enemy), 'non-purple Pilot -- no reaction');

  const hajiroboshi2 = deployUnit(state, player, lookupCard('GD03-055'));
  pairPilot(state, player, hajiroboshi2, createInstance({ number: 'P2', name: 'Purple Pilot', type: 'pilot', color: 'purple' }, 0));
  assert.ok(!opponent.battleArea.includes(enemy), 'purple Pilot -- destroys the Lv.2-or-lower enemy');
});

test('Farsia GD03-058: this card in the trash gets cost -1 only when paid for from the trash', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD03-058');
  assert.equal(canAfford(player, def), false, 'no resources yet -- can\'t afford cost 2 or reduced cost 1');
  for (let i = 0; i < 2; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  assert.equal(canAfford(player, def), true, 'normal cost 2, 2 active resources -- affordable');
  player.resourceArea[1].rested = true;
  assert.equal(canAfford(player, def), false, 'only 1 active resource -- normal cost 2 not affordable');
  assert.equal(canAfford(player, def, { fromTrash: true }), true, 'reduced cost 1 while paying from trash -- affordable with 1 active resource');
});

test('Zedas R GD03-059 Attack may exile 1 (Vagan) card from trash to buff a friendly (Vagan) Unit AP+2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zedas = deployUnit(state, player, lookupCard('GD03-059'));
  const vaganAlly = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, traits: ['Vagan'] });

  zedas.def.effects.attack(state, player, zedas, {});
  assert.equal(getAP(vaganAlly), 1, 'no (Vagan) card in trash -- no reaction');

  player.trash.push({ def: { type: 'unit', traits: ['Vagan'] } });
  zedas.def.effects.attack(state, player, zedas, { hooks: { chooseUnit: () => vaganAlly } });
  assert.equal(getAP(vaganAlly), 3, '(Vagan) card exiled -- friendly (Vagan) Unit gets AP+2');
  assert.equal(player.trash.length, 0, 'the exiled card left the trash');
});

test('CGS Mobile Worker (Commander Type) GD03-060: Once per Turn, receiving effect damage (from either side) deploys a rested token', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { cgsMobileWorkerReceivesEffectDamage } = require('../src/effects/registry');
  const cgs = deployUnit(state, player, lookupCard('GD03-060'));

  cgsMobileWorkerReceivesEffectDamage(state, player, cgs);
  const token = player.battleArea.find((u) => u.def.name === 'CGS Mobile Worker');
  assert.ok(token && token.rested);

  const before = player.battleArea.length;
  cgsMobileWorkerReceivesEffectDamage(state, player, cgs);
  assert.equal(player.battleArea.length, before, 'Once per Turn -- already used');
});

test('Gundam Barbatos 6th Form GD03-061 gains Repair 3 only while it has exactly 1 HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const barbatos = deployUnit(state, player, lookupCard('GD03-061'));

  barbatos.damage = 2;
  applyRepairAtEndOfTurn(state, player);
  assert.equal(getRemainingHP(barbatos), 2, '2 remaining HP, not exactly 1 -- no Repair');

  barbatos.damage = 3;
  assert.equal(getRemainingHP(barbatos), 1);
  applyRepairAtEndOfTurn(state, player);
  assert.equal(getRemainingHP(barbatos), 4, 'exactly 1 remaining HP -- Repair 3 applies');
});

test('GX-Bit GD03-062 Deploy: if deployed from trash, deals 2 damage to a chosen enemy Unit with 4 or less AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const strongEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });
  const weakEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 4, hp: 5 });

  deployUnit(state, player, lookupCard('GD03-062'));
  assert.equal(weakEnemy.damage, 0, 'not deployed from trash -- no reaction');

  deployUnit(state, player, lookupCard('GD03-062'), undefined, { fromTrash: true });
  assert.equal(strongEnemy.damage, 0, '5 AP is too high -- not a valid target');
  assert.equal(weakEnemy.damage, 2, 'deployed from trash -- deals 2 damage to the 4-AP-or-less enemy');
});

test('Defurse GD03-064 Deploy: may fetch an (X-Rounder) card from trash to hand, then discards 1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const filler = { def: { type: 'unit', name: 'Filler' } };
  player.hand.push(filler);

  deployUnit(state, player, lookupCard('GD03-064'));
  assert.equal(player.hand.length, 1, 'no (X-Rounder) card in trash -- no reaction');

  const rounderCard = { def: { type: 'unit', name: 'Rounder', traits: ['X-Rounder'] } };
  player.trash.push(rounderCard);
  deployUnit(state, player, lookupCard('GD03-064'));
  assert.ok(player.hand.includes(rounderCard), 'fetched the (X-Rounder) card to hand');
  assert.equal(player.hand.length, 1, 'discarded 1 card back down, net hand size unchanged');
});

test('Gundam Hajiroboshi GD03-068 gains Blocker only while a friendly Base is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { gundamHajiroboshiStartOfTurn } = require('../src/effects/registry');
  const hajiroboshi = deployUnit(state, player, lookupCard('GD03-068'));

  gundamHajiroboshiStartOfTurn(state, player, hajiroboshi);
  assert.equal(getKeywords(hajiroboshi).blocker, false, 'no friendly Base -- no Blocker');

  player.base = createInstance({ number: 'B', type: 'base', ap: 0, hp: 3 }, 0);
  gundamHajiroboshiStartOfTurn(state, player, hajiroboshi);
  assert.equal(getKeywords(hajiroboshi).blocker, true, 'friendly Base in play -- gains Blocker');
});

test("Graham's Union Flag Custom GD03-069: During Link, set active at the end of the turn it's paired", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { grahamsUnionFlagCustomEndOfTurn } = require('../src/effects/registry');
  const graham = deployUnit(state, player, lookupCard('GD03-069'));
  graham.rested = true;

  grahamsUnionFlagCustomEndOfTurn(state, player, graham);
  assert.equal(graham.rested, true, 'never paired -- no reaction');

  pairPilot(state, player, graham, createInstance({ number: 'P', name: 'Graham Aker', type: 'pilot' }, 0));
  assert.ok(graham.isLinkUnit, 'sanity: Link Condition met');
  grahamsUnionFlagCustomEndOfTurn(state, player, graham);
  assert.equal(graham.rested, false, 'paired this turn -- set active at end of turn');

  graham.rested = true;
  grahamsUnionFlagCustomEndOfTurn(state, player, graham);
  assert.equal(graham.rested, true, 'flag was consumed -- no reaction on a later turn without re-pairing');
});

test('Freedom Gundam (GD03-070) (LR+): while rested, friendly Shields can\'t receive battle damage from enemy Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const freedom = deployUnit(state, player, lookupCard('GD03-070'));
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 2, hp: 3 });
  for (let i = 0; i < 6; i++) player.shields.push(createInstance({ number: 'SH' + i, type: 'shield' }, 0));
  const shieldCount = player.shields.length;

  freedom.rested = false;
  resolveAttack(state, 1, attacker, { type: 'player' });
  assert.equal(player.shields.length, shieldCount - 1, 'Freedom is active -- no immunity, shield hit normally');

  freedom.rested = true;
  resolveAttack(state, 1, attacker, { type: 'player' });
  assert.equal(player.shields.length, shieldCount - 1, 'Freedom is rested -- shields immune to this battle damage');
});
