const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, dealDamage } = require('../src/rules/management');
const { dealEffectDamage } = require('../src/rules/effects');
const { getForcedAttackTargets } = require('../src/ai/heuristic');
const { lookupCard } = require('../src/cards/index');
const registry = require('../src/effects/registry');

test("Noin's Taurus GD05-074: Destroyed draws 1 then discards the highest-cost card in hand", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  player.hand.push(createInstance({ number: 'H1', type: 'unit', cost: 1 }, 0));
  player.hand.push(createInstance({ number: 'H2', type: 'unit', cost: 4 }, 0));

  registry.noinsTaurusDestroyed(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true, 'drew the deck card');
  assert.equal(player.hand.some((c) => c.def.number === 'H2'), false, 'discarded the highest-cost card');
  assert.equal(player.trash.some((c) => c.def.number === 'H2'), true);
});

test('Gundam Heavyarms Custom (EW) (C+) GD05-079: Activate Main debuffs an enemy Lv.4 or lower, gated on a (G Team)/(Preventer) ally and Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 5 });
  const enemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 2, level: 4 });
  const instance = deployUnit(state, player, { number: 'GD05-079', type: 'unit', ap: 3, hp: 3 });

  assert.equal(registry.gundamHeavyarmsCustomEWActivateMain(state, player, instance, {}), false, 'no matching ally yet');

  deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, traits: ['Preventer'] });
  assert.equal(registry.gundamHeavyarmsCustomEWActivateMain(state, player, instance, {}), true);
  assert.equal(getAP(enemy), 1, 'AP-1 applied to the Lv.4 candidate');
  assert.equal(getAP(tooHigh), 3, 'Lv.5 enemy never eligible');
  assert.equal(registry.gundamHeavyarmsCustomEWActivateMain(state, player, instance, {}), false, 'Once per Turn -- no second activation');
});

test('Cagalli Yula Athha GD05-083: When Paired bounces a chosen enemy Unit with exactly 1 remaining HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const fullHealth = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3 });
  const oneHp = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 1 });
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const pilot = createInstance(lookupCard('GD05-083'), 0);
  player.hand.push(pilot);

  pairPilot(state, player, instance, pilot);
  assert.equal(opponent.battleArea.includes(oneHp), false, 'the 1-HP enemy was bounced');
  assert.equal(opponent.hand.includes(oneHp), true);
  assert.equal(opponent.battleArea.includes(fullHealth), true, 'full-health enemy was never a candidate');
});

test('Odelo Henrik GD05-084: reduces enemy effect damage to (League Militaire) Unit tokens by 1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const pilot = createInstance(lookupCard('GD05-084'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);
  const token = deployUnit(state, player, { number: 'TOKEN1', type: 'unit', ap: 1, hp: 3, isToken: true, traits: ['League Militaire'] });
  const nonToken = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 3, traits: ['League Militaire'] });

  dealEffectDamage(state, opponent, player, token, 2);
  assert.equal(token.damage, 1, 'reduced from 2 to 1');

  dealEffectDamage(state, opponent, player, nonToken, 2);
  assert.equal(nonToken.damage, 2, 'non-token League Militaire Unit unaffected');
});

test('Kayra Su GD05-086: During Link, non-Link enemy Units must target this rested Unit if possible; Link Units are exempt', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  instance.rested = true;
  const pilot = createInstance(lookupCard('GD05-086'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);

  assert.deepEqual(getForcedAttackTargets(player), [], 'not a Link Unit yet -- no taunt');

  instance.isLinkUnit = true;
  const nonLinkAttacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 2 });
  const linkAttacker = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 2 });
  linkAttacker.isLinkUnit = true;

  assert.ok(getForcedAttackTargets(player, nonLinkAttacker).includes(instance), 'non-Link enemy is forced to target it');
  assert.deepEqual(getForcedAttackTargets(player, linkAttacker), [], 'an attacking enemy Link Unit is exempt');
});

test('Lauda Neill GD05-087: paired Unit gains High-Maneuver only while it has the (Academy) trait', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const academyUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['Academy'] });
  const otherUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2, traits: [] });
  const pilot1 = createInstance(lookupCard('GD05-087'), 0);
  const pilot2 = createInstance(lookupCard('GD05-087'), 0);
  player.hand.push(pilot1, pilot2);

  pairPilot(state, player, academyUnit, pilot1);
  pairPilot(state, player, otherUnit, pilot2);
  assert.equal(getKeywords(academyUnit).highManeuver, true);
  assert.equal(getKeywords(otherUnit).highManeuver, undefined, 'non-(Academy) paired Unit gets nothing');
});

test('Prospera Mercury GD05-088: her paired Unit and any "Gundam Lfrith"/"Gundnode"-named ally get AP+1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const paired = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const namedAlly = deployUnit(state, player, { number: 'U2', name: 'Gundam Lfrith Thorn', type: 'unit', ap: 2, hp: 2 });
  const unrelated = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 2, hp: 2 });
  const pilot = createInstance(lookupCard('GD05-088'), 0);
  player.hand.push(pilot);

  pairPilot(state, player, paired, pilot);
  registry.prosperaMercuryStartOfTurn(state, player, paired);
  assert.equal(getAP(paired), 5, 'paired Unit AP+1 (plus her own printed apBonus:1)');
  assert.equal(getAP(namedAlly), 3, 'name-matching ally AP+1');
  assert.equal(getAP(unrelated), 2, 'unrelated Unit unaffected');
});

test('Stellar Loussier (R+) GD05-090: Destroyed peeks the top deck card, keeping only a (Phantom Pain) card', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const nonMatch = createInstance({ number: 'D1', type: 'pilot', traits: [] }, 0);
  player.deck.push(nonMatch);

  registry.stellarLoussierRPlusDestroyed(state, player);
  assert.equal(player.hand.includes(nonMatch), false, 'non-(Phantom Pain) card returned to deck');
  assert.equal(player.deck.includes(nonMatch), true);

  const match = createInstance({ number: 'D2', type: 'pilot', traits: ['Phantom Pain'] }, 0);
  player.deck.length = 0;
  player.deck.push(match);
  registry.stellarLoussierRPlusDestroyed(state, player);
  assert.equal(player.hand.includes(match), true, '(Phantom Pain) card added to hand');
});

test('Sting Oakley GD05-091: gets AP+1/HP+1 only while the enemy has 7+ cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  const pilot = createInstance(lookupCard('GD05-091'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);

  registry.stingOakleyStartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 3, 'enemy trash below threshold (base 2 + her own printed apBonus:1)');

  for (let i = 0; i < 7; i++) opponent.trash.push(createInstance({ number: `T${i}`, type: 'unit' }, 1));
  registry.stingOakleyStartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 4, 'AP+1 once enemy trash hits 7');
});

test('Auel Neider GD05-092: During Link, attacking the enemy player grants AP+2 for the battle', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const pilot = createInstance(lookupCard('GD05-092'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);
  instance.isLinkUnit = true;

  const enemyUnit = deployUnit(state, createPlayer(1), { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  registry.auelNeiderAttack(state, player, instance, { target: { type: 'unit', instance: enemyUnit } });
  assert.equal(getAP(instance), 4, 'not attacking the player -- no bonus (base 3 + her own printed apBonus:1)');

  registry.auelNeiderAttack(state, player, instance, { target: { type: 'player' } });
  assert.equal(getAP(instance), 6, 'AP+2 for attacking the player');
});

test('Quess Paraya GD05-094: Destroyed grants a chosen (Neo Zeon) ally Reduce 2 against enemy battle damage this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const neoZeonUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 5, traits: ['Neo Zeon'] });
  const other = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 5, traits: [] });

  registry.quessParayaDestroyed(state, player, null, {});
  dealDamage(neoZeonUnit, 5, { isBattleDamage: true, isEnemyDamage: true, player });
  assert.equal(neoZeonUnit.damage, 3, 'reduced by 2');

  dealDamage(other, 5, { isBattleDamage: true, isEnemyDamage: true, player });
  assert.equal(other.damage, 5, 'non-(Neo Zeon) Unit unaffected');
});

test('Gyunei Guss GD05-095: paired Unit gains Blocker only while it has the (Neo Zeon) trait', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const neoZeonUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['Neo Zeon'] });
  const otherUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2, traits: [] });
  const pilot1 = createInstance(lookupCard('GD05-095'), 0);
  const pilot2 = createInstance(lookupCard('GD05-095'), 0);
  player.hand.push(pilot1, pilot2);

  pairPilot(state, player, neoZeonUnit, pilot1);
  pairPilot(state, player, otherUnit, pilot2);
  assert.equal(getKeywords(neoZeonUnit).blocker, true);
  assert.equal(getKeywords(otherUnit).blocker, undefined, 'non-(Neo Zeon) paired Unit gets nothing');
});
