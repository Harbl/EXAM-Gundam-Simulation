const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP, dealDamage } = require('../src/rules/management');
const registry = require('../src/effects/registry');

test('Gundam Barbatos Lupus Rex GD05-051: AP increases by its own current damage (data-only)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'GD05-051', type: 'unit', ap: 4, hp: 6, apBonusEqualToDamage: true });
  assert.equal(getAP(unit), 4, 'no damage yet');
  dealDamage(unit, 3);
  assert.equal(getAP(unit), 7, 'AP+3 from the 3 damage it has taken');
});

test('Gundam Barbatos Lupus Rex GD05-051: End of Turn deals 1 to a rested (Tekkadan) ally and reactivates it', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const nonMatching = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 5 });
  nonMatching.rested = true;
  const restedAlly = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 1, hp: 5, traits: ['Tekkadan'] });
  restedAlly.rested = true;
  const instance = deployUnit(state, player, { number: 'GD05-051', type: 'unit', ap: 4, hp: 6 });

  registry.gundamBarbatosLupusRexEndOfTurn(state, player, instance, {});
  assert.equal(getRemainingHP(restedAlly), 4, 'took 1 damage');
  assert.equal(restedAlly.rested, false, 'reactivated');
  assert.equal(nonMatching.rested, true, 'non-Tekkadan Unit never a candidate');
});

test('Gundam Barbatos Lupus Rex GD05-051: falls back to itself when no (Tekkadan) ally is rested', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'GD05-051', type: 'unit', ap: 4, hp: 6, traits: ['Tekkadan'] });

  registry.gundamBarbatosLupusRexEndOfTurn(state, player, instance, {});
  assert.equal(getRemainingHP(instance), 5, 'damaged itself for the AP-scaling upside');
});

test('Sazabi (R+) GD05-052: Deploy destroys a chosen Unit, mills 3, and hands back the first (Neo Zeon) Unit milled', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const sacrifice = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 5, hp: 1 });
  const instance = deployUnit(state, player, { number: 'GD05-052', type: 'unit', ap: 5, hp: 4, traits: ['Neo Zeon'] });
  const nonMatch = createInstance({ number: 'M1', type: 'unit', traits: [] }, 0);
  const neoZeonUnit = createInstance({ number: 'M2', type: 'unit', traits: ['Neo Zeon'] }, 0);
  const third = createInstance({ number: 'M3', type: 'unit', traits: [] }, 0);
  player.deck.push(nonMatch, neoZeonUnit, third);

  registry.sazabiRPlusDeploy(state, player, instance, {});
  assert.equal(player.battleArea.includes(sacrifice), false, 'the chosen Unit was destroyed');
  assert.ok(player.trash.includes(sacrifice));
  assert.equal(player.hand.includes(neoZeonUnit), true, 'the milled (Neo Zeon) Unit went to hand');
  assert.equal(player.trash.includes(nonMatch), true);
  assert.equal(player.trash.includes(third), true);
  assert.equal(player.neoZeonSelfDestroyThisTurn, true, 'flags the Axis GD05-129 tracker since Sazabi is (Neo Zeon)');
});

test('Quess\'s Jagd Doga (R+) GD05-053: Destroyed by a friendly (Neo Zeon) effect adds it back to hand from trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'GD05-053', type: 'unit', ap: 3, hp: 2 });
  player.trash.push(instance);

  registry.quessJagdDogaRPlusDestroyed(state, player, instance);
  assert.equal(player.trash.includes(instance), true, 'no Neo Zeon self-destroy flag this turn -- stays in trash');

  player.neoZeonSelfDestroyThisTurn = true;
  registry.quessJagdDogaRPlusDestroyed(state, player, instance);
  assert.equal(player.trash.includes(instance), false);
  assert.equal(player.hand.includes(instance), true);
});

test('Alpha Azieru GD05-054: Once per Turn, draws 1 when a friendly Unit is destroyed by an effect (end-to-end via Sazabi)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const sacrifice = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 5, hp: 1 });
  const alpha = deployUnit(state, player, {
    number: 'GD05-054', type: 'unit', ap: 6, hp: 5,
    effects: { friendlyUnitDestroyedByEffect: registry.alphaAzieruFriendlyUnitDestroyedByEffect }
  });
  const sazabi = deployUnit(state, player, { number: 'GD05-052', type: 'unit', ap: 5, hp: 4, traits: ['Neo Zeon'] });

  const handSizeBefore = player.hand.length;
  registry.sazabiRPlusDeploy(state, player, sazabi, { hooks: { chooseUnit: () => sacrifice } });
  assert.equal(player.hand.length, handSizeBefore + 1, 'Alpha Azieru drew off the broadcast');

  const sacrifice2 = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 5, hp: 1 });
  player.deck.push(createInstance({ number: 'D2', type: 'unit' }, 0));
  const handSizeBefore2 = player.hand.length;
  registry.sazabiRPlusDeploy(state, player, sazabi, { hooks: { chooseUnit: () => sacrifice2 } });
  assert.equal(player.hand.length, handSizeBefore2, 'Once per Turn -- no second draw');
});

test('Gyunei\'s Jagd Doga GD05-057: Activate Main destroys another Unit to reactivate itself and forbids attacking the player this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const fodder = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 5, hp: 1 });
  const instance = deployUnit(state, player, { number: 'GD05-057', type: 'unit', ap: 4, hp: 3 });
  instance.rested = true;

  assert.equal(registry.gyuneisJagdDogaGD05057ActivateMain(state, player, instance, {}), true);
  assert.equal(player.battleArea.includes(fodder), false);
  assert.equal(instance.rested, false, 'reactivated');
  assert.ok(instance.buffs.some((b) => b.cannotAttackPlayer && b.scope === 'turn'));
  assert.equal(registry.gyuneisJagdDogaGD05057ActivateMain(state, player, instance, {}), false, 'Once per Turn -- no second activation');
});

test('Gundam Barbatos Lupus (U+) GD05-059: Attack rests an active (Gjallarhorn) ally to draw, always grants High-Maneuver this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const ally = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, traits: ['Gjallarhorn'] });
  const instance = deployUnit(state, player, { number: 'GD05-059', type: 'unit', ap: 5, hp: 4 });

  registry.gundamBarbatosLupusUPlusAttack(state, player, instance);
  assert.equal(ally.rested, true);
  assert.equal(player.hand.length, 1, 'drew off resting the ally');
  assert.ok(instance.buffs.some((b) => b.keyword === 'highManeuver' && b.scope === 'turn'));
});

test('Geara Doga GD05-061: gains Blocker only while another (Neo Zeon) Unit is in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'GD05-061', type: 'unit', ap: 3, hp: 1 });
  const { getKeywords } = require('../src/rules/management');
  registry.gearaDogaGD05061StartOfTurn(state, player, instance);
  assert.equal(getKeywords(instance).blocker, false, 'alone -- no Blocker');

  deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, traits: ['Neo Zeon'] });
  registry.gearaDogaGD05061StartOfTurn(state, player, instance);
  assert.equal(getKeywords(instance).blocker, true);
});

test('Force Impulse Gundam (C+) GD05-064: Deploy from trash fetches a "Shinn Asuka" Pilot from trash to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'GD05-064', type: 'unit', ap: 3, hp: 4 });
  const wrongPilot = createInstance({ number: 'P1', type: 'pilot', name: 'Lunamaria Hawke' }, 0);
  const shinn = createInstance({ number: 'P2', type: 'pilot', name: 'Shinn Asuka' }, 0);
  player.trash.push(wrongPilot, shinn);

  registry.forceImpulseGundamGD05064Deploy(state, player, instance, {});
  assert.equal(player.hand.length, 0, 'not deployed from trash -- no-op');

  registry.forceImpulseGundamGD05064Deploy(state, player, instance, { fromTrash: true });
  assert.equal(player.hand.includes(shinn), true);
  assert.equal(player.hand.includes(wrongPilot), false);
});

test('Landman Rodi GD05-065: During Link, gets AP+2 only on its controller\'s own turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'GD05-065', type: 'unit', ap: 1, hp: 2 });
  registry.landmanRodiStartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 1, 'not a Link Unit yet');

  instance.isLinkUnit = true;
  registry.landmanRodiStartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 3);

  instance.buffs = [];
  state.activePlayerIdx = 1;
  registry.landmanRodiStartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 1, 'opponent\'s turn -- no bonus');
});

test('Tallgeese III (R+) GD05-070: Once per Turn, destroying an enemy with battle damage reactivates a rested (Preventer)/(G Team) Link Unit and locks its attack', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const notLinked = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, traits: ['Preventer'] });
  notLinked.rested = true;
  const linkedAlly = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 1, hp: 1, traits: ['G Team'] });
  linkedAlly.rested = true;
  linkedAlly.isLinkUnit = true;
  const instance = deployUnit(state, player, { number: 'GD05-070', type: 'unit', ap: 4, hp: 4 });

  registry.tallgeeseIIIDestroysEnemy(state, player, instance);
  assert.equal(linkedAlly.rested, false, 'the Link Unit was chosen');
  assert.equal(notLinked.rested, true, 'not a Link Unit -- never a candidate');
  assert.ok(linkedAlly.buffs.some((b) => b.cannotAttack && b.scope === 'turn'));

  linkedAlly.rested = true;
  registry.tallgeeseIIIDestroysEnemy(state, player, instance);
  assert.equal(linkedAlly.rested, true, 'Once per Turn -- no second reactivation');
});

test('Gundam Sandrock Custom (EW) (R+) GD05-071: Attack debuffs an enemy only while another (G Team)/(Preventer) ally is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });
  const instance = deployUnit(state, player, { number: 'GD05-071', type: 'unit', ap: 3, hp: 4 });

  registry.gundamSandrockCustomEWAttack(state, player, instance);
  assert.equal(getAP(enemy), 3, 'no matching ally -- no debuff');

  deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, traits: ['Preventer'] });
  registry.gundamSandrockCustomEWAttack(state, player, instance);
  assert.equal(getAP(enemy), 1, 'AP-2 with a matching ally in play');
});

test('Altron Gundam (EW) GD05-073: Deploy makes a chosen rested enemy skip its controller\'s next untap', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const active = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  const rested = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 5, hp: 1 });
  rested.rested = true;
  const instance = deployUnit(state, player, { number: 'GD05-073', type: 'unit', ap: 5, hp: 5 });

  registry.altronGundamEWDeploy(state, player, instance, {});
  assert.equal(rested.skipNextUntap, true);
  assert.equal(active.skipNextUntap, undefined, 'active Unit never a candidate');
});
