const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { dealDamage } = require('../src/rules/management');
const { lookupCard } = require('../src/cards/index');
const registry = require('../src/effects/registry');

test('Gundam Astray Red Frame Custom (EX) EB01-001: ActivateMain exiles 2 Commands, rests+freezes a damaged Lv.7- enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 4 });
  player.trash.push(createInstance({ number: 'C1', type: 'command' }, 0));
  player.trash.push(createInstance({ number: 'C2', type: 'command' }, 0));
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 8 });
  dealDamage(tooHigh, 1);
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 2, level: 5 });
  dealDamage(eligible, 1);

  registry.gundamAstrayRedFrameCustomEXActivateMain(state, player, instance);
  assert.equal(player.trash.length, 0, 'both Commands exiled');
  assert.equal(eligible.rested, true);
  assert.equal(eligible.skipNextUntap, true);
  assert.equal(tooHigh.rested, false, 'Lv.8 never eligible');

  instance.activationsUsed.exileCommandsRest = false;
  eligible.damage = 0;
  player.trash.push(createInstance({ number: 'C3', type: 'command' }, 0));
  player.trash.push(createInstance({ number: 'C4', type: 'command' }, 0));
  registry.gundamAstrayRedFrameCustomEXActivateMain(state, player, instance);
  assert.equal(player.trash.length, 2, 'no further damaged eligible target: cost not paid');
});

test('Hi-Nu Gundam (EX) EB01-002: Deploy rests an enemy Unit only with another friendly (G Generation) present; During Link Attack sets active at 3+ rested elsewhere', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });
  const hiNu = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 6, hp: 5 });

  registry.hiNuGundamEXDeploy(state, player, hiNu);
  assert.equal(enemy.rested, false, 'no other (G Generation) Unit yet');

  deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'] });
  registry.hiNuGundamEXDeploy(state, player, hiNu);
  assert.equal(enemy.rested, true);
});

test('Hi-Nu Gundam (EX) EB01-002: During Link Attack sets active at 3+ other rested Units in play, Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hiNu = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 6, hp: 5 });
  hiNu.isLinkUnit = true;
  hiNu.rested = true;
  deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 1 }).rested = true;
  deployUnit(state, player, { number: 'U4', type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.hiNuGundamEXAttack(state, player, hiNu);
  assert.equal(hiNu.rested, true, '2 rested elsewhere is not enough');

  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.hiNuGundamEXAttack(state, player, hiNu);
  assert.equal(hiNu.rested, false, '3 rested elsewhere sets it active');
});

test('Narrative Gundam A-Packs (EX) EB01-003: rested-self endOfTurn rests all Units, draws if 3+ rested by the effect', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 4 });
  instance.rested = true;
  const ally = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  const enemy1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  const enemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });

  registry.narrativeGundamAPacksEXEndOfTurn(state, player, instance);
  assert.equal(ally.rested, true);
  assert.equal(enemy1.rested, true);
  assert.equal(enemy2.rested, true);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true, 'rested 3+ Units: drew 1');
});

test('Gundam Barbatos Lupus Rex (EX) EB01-004: recoversHP deals 1 to a rested enemy, Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 5 });
  const rested = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 2 });
  rested.rested = true;

  registry.gundamBarbatosLupusRexEXRecoversHP(state, player, unit);
  assert.equal(rested.damage, 1);
  registry.gundamBarbatosLupusRexEXRecoversHP(state, player, unit);
  assert.equal(rested.damage, 1, 'Once per Turn: no second hit');
});

test('Zeta Gundam III P2 Type EB01-005: Deploy sets a rested enemy Unit active and draws regardless', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const rested = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 2 });
  rested.rested = true;

  registry.zetaGundamIIIP2TypeDeploy(state, player);
  assert.equal(rested.rested, false);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true);
});

test('Gundam Astray Gold Frame Amatsu EB01-006: Deploy grants the most-damaged friendly Repair 1 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const low = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 5 });
  dealDamage(low, 3);
  const high = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 4, hp: 5 });
  dealDamage(high, 1);

  registry.gundamAstrayGoldFrameAmatsuDeploy(state, player);
  assert.equal(low.buffs.some((b) => b.repair === 1), true);
  assert.equal(high.buffs.some((b) => b.repair === 1), false);
});

test('Gundam Delta Kai EB01-008: Deploy exiles 1 (G Generation) trash card to heal 2, only if there is a damaged friendly', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const damaged = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 5 });
  dealDamage(damaged, 3);
  registry.gundamDeltaKaiDeploy(state, player);
  assert.equal(damaged.damage, 3, 'no (G Generation) trash card yet: no heal');

  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['G Generation'] }, 0));
  registry.gundamDeltaKaiDeploy(state, player);
  assert.equal(damaged.damage, 1);
  assert.equal(player.trash.length, 0);
});

test('Gundam Full Armor (Thunderbolt) (EX) EB01-009: Deploy rests one active enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const active = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });
  registry.gundamFullArmorThunderboltEXDeploy(state, player);
  assert.equal(active.rested, true);
});

test('Gundam Barbatos 6th Form EB01-010: Deploy exiles 3 (G Generation) trash cards to deal 2 to a rested enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const rested = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 4 });
  rested.rested = true;
  for (let i = 0; i < 2; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit', traits: ['G Generation'] }, 0));
  registry.gundamBarbatos6thFormDeploy(state, player);
  assert.equal(rested.damage, 0, 'only 2 exilable: cost not paid');

  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['G Generation'] }, 0));
  registry.gundamBarbatos6thFormDeploy(state, player);
  assert.equal(rested.damage, 2);
  assert.equal(player.trash.length, 0);
});

test('Red Gundam(0085) EB01-013: Attack gets AP+2 only if the enemy player has 6+ cards in hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 0, hp: 4 });
  registry.redGundam0085Attack(state, player, unit);
  assert.equal(unit.buffs.length, 0);

  for (let i = 0; i < 6; i++) opponent.hand.push(createInstance({ number: 'H' + i, type: 'unit' }, 1));
  registry.redGundam0085Attack(state, player, unit);
  assert.equal(unit.buffs.some((b) => b.ap === 2), true);
});

test('Prototype Asshimar TR-3 "Kehaar" EB01-015: Destroyed deals 1 to a rested enemy with 2+ other rested Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 4 });
  const rested = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 2 });
  rested.rested = true;
  registry.prototypeAsshimarTR3Destroyed(state, player, instance);
  assert.equal(rested.damage, 0, 'only 1 rested elsewhere');

  deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.prototypeAsshimarTR3Destroyed(state, player, instance);
  assert.equal(rested.damage, 1);
});

test("Haro EB01-017: Destroyed draws both players' controllers 1 only when destroyed with battle damage", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  opponent.deck.push(createInstance({ number: 'D2', type: 'unit' }, 1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });

  registry.haroDestroyed(state, player, instance, {});
  assert.equal(player.hand.length, 0, 'not battle damage: no draw');

  registry.haroDestroyed(state, player, instance, { viaBattleDamage: true });
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true);
  assert.equal(opponent.hand.some((c) => c.def.number === 'D2'), true);
});

test('Gundam Astray Blue Frame Second L EB01-018: Attack heals the most-damaged friendly Unit 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 5 });
  dealDamage(target, 3);
  registry.gundamAstrayBlueFrameSecondLAttack(state, player);
  assert.equal(target.damage, 2);
});

test('Gundam Pixy EB01-019: Attack gains High-Maneuver for the battle at 2+ other rested Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 4 });
  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.gundamPixyAttack(state, player, unit);
  assert.equal(unit.buffs.length, 0, 'only 1 rested elsewhere');

  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.gundamPixyAttack(state, player, unit);
  assert.equal(unit.buffs.some((b) => b.keyword === 'highManeuver' && b.scope === 'battle'), true);
});

test('Gundam Mk-III EB01-020: reuses G-Sky Easy GD01-014\'s byte-identical Activate-Action handler', () => {
  const def = lookupCard('EB01-020');
  assert.equal(def.effects.activateAction, registry.gSkyEasyActivateAction);
});
