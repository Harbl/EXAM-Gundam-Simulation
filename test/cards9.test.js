const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { applyRepairAtEndOfTurn } = require('../src/rules/effects');
const { chooseAttackTarget } = require('../src/ai/heuristic');

test("Royal Gundam is a Blocker that can't be chosen as an attack target itself (cannotAttackPlayer)", () => {
  const opponent = createPlayer(1);
  const royalGundam = createInstance(lookupCard('GD05-075'), 0);
  const target = chooseAttackTarget(opponent, royalGundam);
  assert.equal(target, null, 'no enemy Units to trade with and it cannot attack the player directly');
});

test('White Base deploys a Gundam/Guncannon/Guntank token depending on how many friendly Units are already in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource' }, 0), createInstance({ number: 'R2', type: 'resource' }, 0));
  const whiteBase = createInstance(lookupCard('ST01-015'), 0);
  player.base = whiteBase;

  const ok = lookupCard('ST01-015').effects.activateMain(state, player, whiteBase, {});
  assert.equal(ok, true);
  assert.equal(player.battleArea[0].def.name, 'Gundam', 'no Units yet, so it deploys the Gundam token');

  const again = lookupCard('ST01-015').effects.activateMain(state, player, whiteBase, {});
  assert.equal(again, false, 'Once per Turn already used');
});

test('Battle of Aces: Burst hits the strongest enemy for 2, Main/Action hits a damaged enemy for 3', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const strong = createInstance({ number: 'E1', type: 'unit', ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(strong);
  lookupCard('GD01-111').effects.burst(state, player);
  assert.equal(strong.damage, 2);

  lookupCard('GD01-111').effects.command(state, player, createInstance(lookupCard('GD01-111'), 0), {});
  assert.equal(strong.damage, 5, 'the already-damaged enemy took 3 more');
});

test('Improved Technique is level-capped at Lv.4 normally, but ignores the cap once 2+ copies sit in the trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const bigEnemy = createInstance({ number: 'E1', type: 'unit', level: 8, ap: 1, hp: 10 }, 1);
  opponent.battleArea.push(bigEnemy);
  lookupCard('GD03-109').effects.command(state, player, null, {});
  assert.equal(bigEnemy.damage, 0, 'Lv.8 enemy is above the cap and no copies are in the trash yet');

  player.trash.push(createInstance(lookupCard('GD03-109'), 0), createInstance(lookupCard('GD03-109'), 0));
  lookupCard('GD03-109').effects.command(state, player, null, {});
  assert.equal(bigEnemy.damage, 3, '2 copies in the trash lifts the level cap');
});

test('Rewloola adds a Shield to hand and deals 1 damage to a low-AP enemy on Deploy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit', ap: 0, hp: 1 }, 0));

  const weakEnemy = createInstance({ number: 'E', type: 'unit', ap: 5, hp: 3 }, 1);
  const strongEnemy = createInstance({ number: 'E2', type: 'unit', ap: 8, hp: 5 }, 1);
  opponent.battleArea.push(weakEnemy, strongEnemy);

  lookupCard('ST03-015').effects.deploy(state, player, createInstance(lookupCard('ST03-015'), 0), {});
  assert.equal(player.hand.length, 1, 'added a Shield to hand');
  assert.equal(weakEnemy.damage, 1, 'the 5-AP-or-less enemy was hit');
  assert.equal(strongEnemy.damage, 0, 'the 8-AP enemy is above the threshold');
});

test("Axis's Activate*Main only deploys a (Neo Zeon) Unit from hand after a friendly (Neo Zeon) card's own effect destroyed a friendly Unit this turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const axis = createInstance(lookupCard('GD05-129'), 0);
  player.base = axis;
  const neoZeonUnit = { number: 'NZ', type: 'unit', level: 2, traits: ['Neo Zeon'], ap: 2, hp: 2 };
  player.hand.push(createInstance(neoZeonUnit, 0));

  const tooSoon = lookupCard('GD05-129').effects.activateMain(state, player, axis, {});
  assert.equal(tooSoon, false, 'no friendly Neo Zeon self-destroy has happened yet this turn');

  const sazabi = deployUnit(state, player, lookupCard('GD05-049'));
  const chaff = deployUnit(state, player, { number: 'C', type: 'unit', level: 1, ap: 1, hp: 1 });
  const bigTarget = createInstance({ number: 'BT', type: 'unit', level: 8, ap: 6, hp: 6 }, 1);
  opponent.battleArea.push(bigTarget);
  lookupCard('GD05-049').effects.attack(state, player, sazabi, { target: { type: 'player' } });
  assert.equal(player.battleArea.includes(chaff), false, 'Sazabi sacrificed the chaff Unit');

  const activated = lookupCard('GD05-129').effects.activateMain(state, player, axis, {});
  assert.equal(activated, true);
  assert.equal(player.battleArea.some((u) => u.def.name === 'NZ' || u.def === neoZeonUnit), true, 'deployed the Neo Zeon Unit from hand');
});

test('Waldfeld\'s Murasame draws a card on Destroyed only while an (Orb) Pilot is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D', type: 'unit', ap: 1, hp: 1 }, 0));

  const murasame = deployUnit(state, player, lookupCard('GD05-003'));
  murasame.damage = 100;
  lookupCard('GD05-003').effects.destroyed(state, player, murasame, {});
  assert.equal(player.hand.length, 0, 'no (Orb) Pilot in play yet');

  const otherUnit = deployUnit(state, player, { number: 'O', type: 'unit', ap: 2, hp: 2 });
  pairPilot(state, player, otherUnit, createInstance({ number: 'P', type: 'pilot', traits: ['Orb'] }, 0));
  lookupCard('GD05-003').effects.destroyed(state, player, murasame, {});
  assert.equal(player.hand.length, 1, 'an (Orb) Pilot is now in play, so it drew');
});

test('Hashmal deploys a Pluma token (once per turn) on a battle-damage kill and gains Repair equal to its (Calamity War) token count', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const hashmal = deployUnit(state, player, lookupCard('GD05-006'));
  const weakEnemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(weakEnemy);

  const { resolveAttack } = require('../src/rules/combat');
  resolveAttack(state, 0, hashmal, { type: 'unit', instance: weakEnemy }, {});
  assert.equal(player.battleArea.some((u) => u.def.name === 'Pluma'), true, 'a Pluma token was deployed');

  hashmal.damage = 4;
  applyRepairAtEndOfTurn(state, player);
  assert.equal(hashmal.damage, 3, 'Repair 1 (one Calamity War token in play) recovered 1 HP');
});

test('Andrew Waldfeld grants Repair 2 only while its paired Unit is a Link Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 5 });
  unit.pilot = createInstance(lookupCard('GD05-082'), 0);
  unit.damage = 4;

  applyRepairAtEndOfTurn(state, player);
  assert.equal(unit.damage, 4, 'not linked yet, so no Repair');

  unit.isLinkUnit = true;
  applyRepairAtEndOfTurn(state, player);
  assert.equal(unit.damage, 2, 'During Link grants Repair 2');
});
