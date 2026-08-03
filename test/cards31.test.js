const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { canAfford, payCost } = require('../src/rules/cost');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('The-O (LR+) GD03-002 has <Repair 3> and, while paired, reacts to another Repair ally attacking', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const theO = deployUnit(state, player, lookupCard('GD03-002'));
  assert.equal(getKeywords(theO).repair, 3);

  const repairAlly = deployUnit(state, player, { number: 'R', type: 'unit', ap: 2, hp: 3, level: 4, keywords: { repair: 1 } });
  const plainAlly = deployUnit(state, player, { number: 'P', type: 'unit', ap: 2, hp: 3 });
  const lowLv = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 5, level: 3 });
  const highLv = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 5, level: 6 });

  resolveAttack(state, 0, repairAlly, { type: 'player' });
  assert.equal(lowLv.rested, false, 'The-O is unpaired -- During Pair ability is inactive');

  pairPilot(state, player, theO, createInstance({ number: 'PL', type: 'pilot' }, 0));
  plainAlly.rested = false;
  resolveAttack(state, 0, plainAlly, { type: 'player' });
  assert.equal(lowLv.rested, false, 'attacker has no <Repair> -- no effect');

  repairAlly.rested = false;
  resolveAttack(state, 0, repairAlly, { type: 'player' });
  assert.equal(lowLv.rested, true, 'Lv.3 enemy (<= attacker Lv.4) gets rested');
  assert.equal(highLv.rested, false, 'Lv.6 enemy is too high a Lv. to be a legal target');
});

test('Hambrabi GD03-004 Attack rests a 5-or-less-HP enemy only with 2+ other friendly (Titans) Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hambrabi = deployUnit(state, player, lookupCard('GD03-004'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });
  const { hambrabiAttack } = require('../src/effects/registry');

  hambrabiAttack(state, player, hambrabi, {});
  assert.equal(enemy.rested, false, 'fewer than 2 other Titans Units -- no effect');

  deployUnit(state, player, { number: 'T1', type: 'unit', ap: 1, hp: 1, traits: ['Titans'] });
  deployUnit(state, player, { number: 'T2', type: 'unit', ap: 1, hp: 1, traits: ['Titans'] });
  hambrabiAttack(state, player, hambrabi, {});
  assert.equal(enemy.rested, true, '2+ other Titans Units in play -- enemy gets rested');
});

test('Kshatriya Besserung GD03-005 has <Repair 1> and Deploy draws 1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));
  const before = player.hand.length;
  const unit = deployUnit(state, player, lookupCard('GD03-005'));
  assert.equal(getKeywords(unit).repair, 1);
  assert.equal(player.hand.length, before + 1, 'drew 1 card on Deploy');
});

test("Penelope (Middle Form) GD03-006 Deploy rests 1 to 2 enemy Units with 3 or less HP", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low1 = deployUnit(state, opponent, { number: 'L1', type: 'unit', ap: 3, hp: 3 });
  const low2 = deployUnit(state, opponent, { number: 'L2', type: 'unit', ap: 2, hp: 3 });
  const high = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 5 });
  deployUnit(state, player, lookupCard('GD03-006'));
  assert.equal(low1.rested, true);
  assert.equal(low2.rested, true);
  assert.equal(high.rested, false, '5 HP enemy is above the 3-HP threshold');
});

test('Gundam NT-1 Full Armor GD03-007 Destroyed rests a 3-or-less-HP enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD03-007'));
  const lowHp = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 3 });
  const highHp = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 5 });
  const { gundamNT1FullArmorDestroyed } = require('../src/effects/registry');
  gundamNT1FullArmorDestroyed(state, player, unit, {});
  assert.equal(lowHp.rested, true);
  assert.equal(highHp.rested, false);
});

test('Bolinoak Sammahn GD03-008 gains <Repair 2> only While Paired', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD03-008'));
  assert.equal(getKeywords(unit).repair, undefined, 'unpaired -- no Repair');
  pairPilot(state, player, unit, createInstance({ number: 'P', type: 'pilot' }, 0));
  assert.equal(getKeywords(unit).repair, 2, 'paired -- gains Repair 2');
});

test('Palace Athene GD03-009 Deploy may exile 2 (Titans) cards from trash to rest a Lv.4-or-lower enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowLv = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 5, level: 4 });
  const highLv = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 5, level: 5 });
  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['Titans'] }, 0));
  deployUnit(state, player, lookupCard('GD03-009'));
  assert.equal(lowLv.rested, false, 'only 1 (Titans) card in trash -- no effect');
  assert.equal(player.trash.length, 1);

  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['Titans'] }, 0));
  deployUnit(state, player, lookupCard('GD03-009'));
  assert.equal(player.trash.length, 0, 'both (Titans) cards exiled from trash');
  assert.equal(player.removal.length, 2);
  assert.equal(lowLv.rested, true, 'Lv.4 enemy gets rested');
  assert.equal(highLv.rested, false, 'Lv.5 enemy is too high a Lv. to be a legal target');
});

test('Full Armor Unicorn Gundam (Destroy Mode) (U+) GD03-010 and Messala variants carry their printed Repair/Blocker keywords', () => {
  assert.equal(getKeywords(createInstance(lookupCard('GD03-010'), 0)).repair, 3);
  const messalaRPlus = createInstance(lookupCard('GD03-003'), 0);
  assert.equal(getKeywords(messalaRPlus).blocker, true);
  assert.equal(getKeywords(messalaRPlus).repair, 1);
  assert.equal(getKeywords(createInstance(lookupCard('GD03-012'), 0)).repair, 1);
});

test('GM Sniper II GD03-011 is vanilla (Lv.2/cost2/2AP/3HP)', () => {
  const def = lookupCard('GD03-011');
  assert.equal(def.level, 2);
  assert.equal(def.cost, 2);
  assert.equal(def.ap, 2);
  assert.equal(def.hp, 3);
  assert.equal(def.effectRefs, undefined);
});

test('Hizack GD03-013 gets AP+1 and <Repair 1> only while another friendly (Jupitris) Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hizack = deployUnit(state, player, lookupCard('GD03-013'));
  const { hizackStartOfTurn } = require('../src/effects/registry');

  hizackStartOfTurn(state, player, hizack);
  assert.equal(getAP(hizack), 2, 'no other Jupitris Unit -- base AP only');
  assert.equal(getKeywords(hizack).repair, 0);

  deployUnit(state, player, { number: 'J', type: 'unit', ap: 1, hp: 1, traits: ['Jupitris'] });
  hizackStartOfTurn(state, player, hizack);
  assert.equal(getAP(hizack), 3, 'another Jupitris Unit in play -- AP+1');
  assert.equal(getKeywords(hizack).repair, 1);
});

test('Hizack Custom GD03-014: hand cost is 2 normally, drops to 1 while 2+ (Titans) Units are in play', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD03-014'); // Lv.3, cost 2
  player.resourceArea.push(resource(), resource(), resource());
  assert.equal(canAfford(player, def), true, '3 active resources satisfies Lv.3 and covers cost 2');

  player.resourceArea[1].rested = true;
  player.resourceArea[2].rested = true; // only 1 active now, but 3 total still satisfies the Lv.3 requirement
  assert.equal(canAfford(player, def), false, 'only 1 active resource, full cost of 2 not payable yet');

  player.battleArea.push(
    { def: { traits: ['Titans'] } },
    { def: { traits: ['Titans'] } }
  );
  assert.equal(canAfford(player, def), true, '2+ (Titans) Units in play drops the cost to 1, payable by the 1 active resource');

  payCost(player, def);
  const activeCount = player.resourceArea.filter((r) => !r.rested).length;
  assert.equal(activeCount, 0, 'only 1 more resource actually gets spent, matching the reduced cost');
});

test('Baund Doc GD03-015 Activate:Main exiles 3 (Titans) cards from trash for Breach 4 this turn, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD03-015'));
  const { baundDocActivateMain } = require('../src/effects/registry');

  for (let i = 0; i < 2; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit', traits: ['Titans'] }, 0));
  assert.equal(baundDocActivateMain(state, player, unit), false, 'only 2 (Titans) cards in trash -- not enough');
  assert.equal(getKeywords(unit).breach, undefined);

  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['Titans'] }, 0));
  assert.equal(baundDocActivateMain(state, player, unit), true);
  assert.equal(player.trash.length, 0);
  assert.equal(player.removal.length, 3);
  assert.equal(getKeywords(unit).breach, 4);

  player.trash.push(createInstance({ number: 'T3', type: 'unit', traits: ['Titans'] }, 0));
  player.trash.push(createInstance({ number: 'T4', type: 'unit', traits: ['Titans'] }, 0));
  player.trash.push(createInstance({ number: 'T5', type: 'unit', traits: ['Titans'] }, 0));
  assert.equal(baundDocActivateMain(state, player, unit), false, 'already activated this turn -- Once per Turn');
});
