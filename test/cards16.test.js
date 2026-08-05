const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot, findEvolveTarget, deployByEvolve } = require('../src/rules/actions');
const { getRemainingHP } = require('../src/rules/management');
const { applyRepairAtEndOfTurn } = require('../src/rules/effects');
const { canAfford, payCost } = require('../src/rules/cost');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const { runDeploys } = require('../src/ai/heuristic');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('Gundam GD01-001: teamRepairAura grants Repair 1 to every friendly (White Base Team) Unit, including itself', () => {
  const player = createPlayer(0);
  const gundam = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-001'));
  const guncannon = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-004'));
  const outsider = deployUnit({ turnNumber: 1 }, player, { number: 'X', type: 'unit', hp: 5, ap: 1, traits: [] });
  gundam.damage = 2;
  guncannon.damage = 1;
  outsider.damage = 1;
  applyRepairAtEndOfTurn({}, player);
  assert.equal(gundam.damage, 1, 'Repair 1 from its own aura');
  assert.equal(guncannon.damage, 0, 'Repair 1 (aura) + Repair 1 (its own keyword) = 2 total');
  assert.equal(outsider.damage, 1, 'not (White Base Team), unaffected by the aura');
});

test('Gundam GD01-001 When Paired draws 1 only with 2+ other Units already in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.players[0].deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const gundam = deployUnit(state, player, lookupCard('GD01-001'));
  pairPilot(state, player, gundam, createInstance({ number: 'P1', name: 'Amuro Ray', type: 'pilot' }, 0));
  assert.equal(player.hand.length, 0, 'only 0 other Units in play, no draw');

  state.players[0].deck.push(createInstance({ number: 'D2', type: 'unit' }, 0));
  deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1 });
  deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 1 });
  const gundam2 = deployUnit(state, player, lookupCard('GD01-001'));
  pairPilot(state, player, gundam2, createInstance({ number: 'P2', name: 'Amuro Ray', type: 'pilot' }, 0));
  assert.equal(player.hand.length, 1, '2 other Units in play now, draws 1');
});

test('Unicorn Gundam (Unicorn Mode) GD01-005: a Link Unit\'s Destroyed sends its paired Pilot to hand and discards 1, instead of trashing the Pilot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD01-005'));
  const pilot = createInstance({ number: 'Banagher Links', name: 'Banagher Links', type: 'pilot' }, 0);
  pairPilot(state, player, unit, pilot);
  assert.equal(unit.isLinkUnit, true);
  player.hand.push(createInstance({ number: 'H1', type: 'unit', cost: 5 }, 0));

  const attacker = createInstance({ number: 'E', type: 'unit', ap: 10, hp: 10 }, 1);
  opponent.battleArea.push(attacker);
  unit.damage = 3; // lethal (3 HP)
  resolveUnitBattleDamage(state, opponent, player, attacker, unit, {});

  assert.equal(player.battleArea.includes(unit), false);
  assert.equal(player.trash.includes(pilot), false, 'the Pilot should not have been trashed');
  assert.equal(player.hand.includes(pilot), true, 'the Pilot should be in hand instead');
  assert.equal(player.trash.includes(player.hand[0]) , false);
  assert.equal(player.hand.length, 1, 'the pre-existing hand card was discarded to trash, Pilot took its place');
});

test('Jegan GD01-016: hand cost is 2 normally, drops to 1 while 2+ (Earth Federation) Units are in play', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD01-016');
  player.resourceArea.push(resource(), resource(), resource()); // 3 total, satisfies Lv.3
  assert.equal(canAfford(player, def), true, '3 active resources covers the full cost of 2');

  player.resourceArea[0].rested = true;
  player.resourceArea[1].rested = true; // only 1 active, still 3 total (satisfies Lv.3)
  assert.equal(canAfford(player, def), false, 'only 1 active resource, full cost of 2 not payable yet');

  player.battleArea.push(
    { def: { traits: ['Earth Federation'] } },
    { def: { traits: ['Earth Federation'] } }
  );
  assert.equal(canAfford(player, def), true, '2+ (Earth Federation) Units in play drops the cost to 1');

  payCost(player, def);
  const restedCount = player.resourceArea.filter((r) => r.rested).length;
  assert.equal(restedCount, 3, 'the 2 already-rested plus 1 newly-spent, matching the reduced cost of 1');
});

test('G-Sky Easy GD01-014 Activate*Action heals a chosen Unit for 1, once per turn, only while linked', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD01-014'));
  const target = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 5 });
  target.damage = 3;

  assert.equal(unit.def.effects.activateAction(state, player, unit, { target }), false, 'not a Link Unit yet');

  pairPilot(state, player, unit, createInstance({ number: 'P', name: 'White Base Team', type: 'pilot', traits: ['White Base Team'] }, 0));
  assert.equal(unit.isLinkUnit, true);
  assert.equal(unit.def.effects.activateAction(state, player, unit, { target }), true);
  assert.equal(getRemainingHP(target), 3);
  assert.equal(unit.def.effects.activateAction(state, player, unit, { target }), false, 'Once per Turn already used');
});

test('Noin\'s Aries GD01-007 Destroyed draws 1 only if another (OZ) Unit is still in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.players[0].deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const aries = deployUnit(state, player, lookupCard('GD01-007'));
  const attacker = createInstance({ number: 'E', type: 'unit', ap: 5, hp: 10 }, 1);
  opponent.battleArea.push(attacker);
  resolveUnitBattleDamage(state, opponent, player, attacker, aries, {});
  assert.equal(player.hand.length, 0, 'no other (OZ) Unit in play, no draw');

  const aries2 = deployUnit(state, player, lookupCard('GD01-007'));
  deployUnit(state, player, { number: 'ally', type: 'unit', traits: ['OZ'], ap: 1, hp: 1 });
  const attacker2 = createInstance({ number: 'E2', type: 'unit', ap: 5, hp: 10 }, 1);
  opponent.battleArea.push(attacker2);
  resolveUnitBattleDamage(state, opponent, player, attacker2, aries2, {});
  assert.equal(player.hand.length, 1, 'another (OZ) Unit is in play, draws 1');
});

test('Unicorn Gundam (Destroy Mode) GD01-002: findEvolveTarget only matches a Link Unit with "Unicorn Mode" in its name at exactly Lv.5', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD01-002');
  assert.equal(findEvolveTarget(player, def), null, 'nothing in play yet');

  const unlinked = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-005'));
  assert.equal(findEvolveTarget(player, def), null, 'not a Link Unit (never paired)');

  pairPilot({ turnNumber: 1 }, player, unlinked, createInstance({ number: 'P', name: 'Banagher Links', type: 'pilot' }, 0));
  assert.equal(unlinked.isLinkUnit, true);
  assert.equal(findEvolveTarget(player, def), unlinked, 'now a linked "Unicorn Mode" Lv.5 Unit -- matches');

  const player2 = createPlayer(0);
  const wrongLevel = deployUnit({ turnNumber: 1 }, player2, { number: 'X', name: 'Something Unicorn Mode', type: 'unit', level: 4, ap: 1, hp: 1 });
  wrongLevel.isLinkUnit = true;
  assert.equal(findEvolveTarget(player2, def), null, 'right name, wrong Lv. -- no match');
});

test('deployByEvolve destroys the target (firing its own Destroyed trigger) and deploys the new Unit for free', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unicornMode = deployUnit(state, player, lookupCard('GD01-005'));
  const pilot = createInstance({ number: 'P', name: 'Banagher Links', type: 'pilot' }, 0);
  pairPilot(state, player, unicornMode, pilot);
  player.hand.push(createInstance({ number: 'H1', type: 'unit', cost: 9 }, 0)); // for GD01-005's own Destroyed discard

  const destroyMode = deployByEvolve(state, player, lookupCard('GD01-002'), unicornMode);

  assert.equal(player.battleArea.includes(unicornMode), false, 'the Unicorn Mode Unit was destroyed');
  assert.equal(player.battleArea.includes(destroyMode), true, 'Destroy Mode deployed for free');
  assert.equal(player.trash.includes(unicornMode), true);
  assert.equal(player.hand.includes(pilot), true, "Unicorn Mode's own Destroyed effect still fired: Pilot returned to hand");
});

test("runDeploys picks the evolve-play over paying full cost when both a target and resources are available", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unicornMode = deployUnit(state, player, lookupCard('GD01-005'));
  pairPilot(state, player, unicornMode, createInstance({ number: 'P', name: 'Banagher Links', type: 'pilot' }, 0));
  player.hand.push(createInstance(lookupCard('GD01-002'), 0));
  // No resources at all -- only the evolve path can possibly deploy this card.
  runDeploys(state, player);
  assert.equal(player.battleArea.some((u) => u.def.number === 'GD01-002'), true);
  assert.equal(player.battleArea.includes(unicornMode), false);
});
