const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP, dealDamage } = require('../src/rules/management');
const { fireCardEffect, dealEffectDamage, payAbilityCost } = require('../src/rules/effects');
const { chooseBlocker } = require('../src/ai/heuristic');
const { lookupCard } = require('../src/cards/index');
const registry = require('../src/effects/registry');

test('Chad Chadan GD05-096: Attack self-damages 1 and heals the lowest-HP other (Tekkadan) ally', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  const ally = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 3, traits: ['Tekkadan'] });
  dealDamage(ally, 2);

  registry.chadChadanAttack(state, player, unit);
  assert.equal(unit.damage, 1, 'self-damaged 1');
  assert.equal(ally.damage, 1, 'ally healed 1');
});

test('Trowa Barton GD05-099: destroysEnemy draws 1 then discards the highest-cost card', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  player.hand.push(createInstance({ number: 'H1', type: 'unit', cost: 5 }, 0));

  registry.trowaBartonGD05DestroysEnemy(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true);
  assert.equal(player.trash.some((c) => c.def.number === 'H1'), true);
});

test('Quatre Raberba Winner GD05-100: When Paired rests a chosen enemy Lv.5 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 6 });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 2, level: 5 });
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const pilot = createInstance(lookupCard('GD05-100'), 0);
  player.hand.push(pilot);

  pairPilot(state, player, unit, pilot);
  assert.equal(eligible.rested, true);
  assert.equal(tooHigh.rested, false, 'Lv.6 enemy never eligible');
});

test('Gavane Goonny GD05-101: friendlyPaysAbilityCost heals the (Militia) cost-paying source 2 HP, Once per Turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  const pilot = createInstance(lookupCard('GD05-101'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, unit, pilot);

  const militiaSource = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5, traits: ['Militia'] });
  dealDamage(militiaSource, 3);
  const nonMatch = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 5, traits: [] });
  dealDamage(nonMatch, 3);

  payAbilityCost(state, player, nonMatch, 1);
  assert.equal(nonMatch.damage, 3, 'non-(Militia) source unaffected');

  payAbilityCost(state, player, militiaSource, 1);
  assert.equal(militiaSource.damage, 1, 'healed 2');

  dealDamage(militiaSource, 1);
  payAbilityCost(state, player, militiaSource, 1);
  assert.equal(militiaSource.damage, 2, 'Once per Turn -- no second heal');
});

test('Wings of Light (R+) GD05-102: bounces a 5-or-less-HP enemy when one exists, else heals the most-damaged friendly 3', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const bounceable = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5 });
  registry.wingsOfLightRPlusCommand(state, player, null, {});
  assert.equal(opponent.battleArea.includes(bounceable), false, 'bounced');
  assert.equal(opponent.hand.includes(bounceable), true);

  const damaged = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 2, hp: 5 });
  dealDamage(damaged, 4);
  registry.wingsOfLightRPlusCommand(state, player, null, {});
  assert.equal(damaged.damage, 1, 'healed 3 (no enemy target this time)');
});

test('Not with Scattershot! GD05-103: heals 1 and grants AP+2 during the turn to the most-damaged friendly', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 5 });
  dealDamage(unit, 3);

  registry.notWithScattershotCommand(state, player, null, {});
  assert.equal(unit.damage, 2, 'healed 1');
  assert.equal(getAP(unit), 4, 'AP+2');
});

test("At the Risk of One's Life GD05-104: grants a chosen (Shrike Team) Unit a turn-scoped During-Link Destroyed trigger", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const shrikeUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 1, traits: ['Shrike Team'] });
  const restedAlly = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['League Militaire'] });
  restedAlly.rested = true;
  shrikeUnit.isLinkUnit = true;

  registry.atTheRiskOfOnesLifeCommand(state, player, null, {});
  dealDamage(shrikeUnit, 1);
  fireCardEffect(state, player, shrikeUnit, 'destroyed', {});
  assert.equal(restedAlly.rested, false, 'League Militaire ally set active');
});

test('Exclusively Defense-Oriented Policy GD05-105: bounces a chosen enemy Lv.3 or lower (Burst reuses Main)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 4 });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 2, level: 3 });

  registry.exclusivelyDefenseOrientedPolicyBurst(state, player, null);
  assert.equal(opponent.battleArea.includes(eligible), false);
  assert.equal(opponent.battleArea.includes(tooHigh), true);
});

test('Mutual Attraction (R+) GD05-106: retrieves a Lv.5+ Pilot from trash when one exists, else ramps a rested Resource', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const lowPilot = createInstance({ number: 'P1', type: 'pilot', level: 3 }, 0);
  const highPilot = createInstance({ number: 'P2', type: 'pilot', level: 5, apBonus: 2 }, 0);
  player.trash.push(lowPilot, highPilot);

  registry.mutualAttractionRPlusCommand(state, player, null, {});
  assert.equal(player.hand.includes(highPilot), true, 'retrieved the Lv.5+ pilot');
  assert.equal(player.trash.includes(lowPilot), true, 'Lv.3 pilot left untouched');

  player.trash.length = 0;
  player.resourceDeck.push(createInstance({ number: 'R1', type: 'resource' }, 0));
  registry.mutualAttractionRPlusCommand(state, player, null, {});
  assert.equal(player.resourceArea.length, 1, 'ramped instead');
  assert.equal(player.resourceArea[0].rested, true);
});

test('Interwoven Blessings GD05-107: Burst places an EX Resource; Main destroys the first 2 enemy shields', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) opponent.shields.push(createInstance({ number: `S${i}`, type: 'unit' }, 1));

  registry.interwovenBlessingsBurst(state, player);
  assert.equal(player.resourceArea.length, 1);

  registry.interwovenBlessingsCommand(state, player, null, {});
  assert.equal(opponent.shields.length, 1, 'first 2 shields destroyed');
});

test('Overcoming Hardships GD05-108: redirects battle damage from the given target to the chosen rested (Academy) ally', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const underAttack = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });
  const academyAlly = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5, traits: ['Academy'] });
  academyAlly.rested = true;

  registry.overcomingHardshipsCommand(state, player, null, { underAttack });
  const redirect = underAttack.buffs.find((b) => b.redirectDamageTarget);
  assert.equal(redirect && redirect.redirectDamageTarget, academyAlly, 'battle damage redirected to the rested academy ally (read by combat.js getBattleDamageRecipient)');
});

test("Felsi's Plea GD05-109: heals a chosen (Academy) Unit 2 and draws if paired with a Lv.3 or lower Pilot", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const academyUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 5, traits: ['Academy'] });
  dealDamage(academyUnit, 3);
  const pilot = createInstance({ number: 'P1', type: 'pilot', level: 2 }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, academyUnit, pilot);

  registry.felsisPleaCommand(state, player, null, {});
  assert.equal(academyUnit.damage, 1, 'healed 2');
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true, 'drew from the low-level pairing');
});

test('Rose Screamer GD05-113: buffs a chosen (MF) Unit with 4 or less AP by AP+2 during the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const tooStrong = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 3, traits: ['MF'] });
  const eligible = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 3, hp: 3, traits: ['MF'] });

  registry.roseScreamerCommand(state, player, null, {});
  assert.equal(getAP(eligible), 5, 'AP+2 applied');
  assert.equal(getAP(tooStrong), 5, 'already-5-AP Unit untouched (5+2 was never a candidate)');
  assert.equal(player.specialMoveActivatedThisTurn, true);
  assert.equal(lookupCard('GD05-113').pairableFromTrash, 'MF');
});

test('Newtype Labs Director GD05-115: Burst draws 1; Main retrieves a (Neo Zeon) Pilot from trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const neoZeonPilot = createInstance({ number: 'P1', type: 'pilot', traits: ['Neo Zeon'] }, 0);
  const otherPilot = createInstance({ number: 'P2', type: 'pilot', traits: [] }, 0);
  player.trash.push(otherPilot, neoZeonPilot);

  registry.newtypeLabsDirectorBurst(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true);

  registry.newtypeLabsDirectorCommand(state, player, null, {});
  assert.equal(player.hand.includes(neoZeonPilot), true);
  assert.equal(player.trash.includes(otherPilot), true, 'non-matching pilot left in trash');
});

test("Veteran's Pride GD05-116: destroys a chosen enemy Lv.2 or lower outright", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5, level: 3 });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5, level: 2 });

  registry.veteransPrideCommand(state, player, null, {});
  assert.equal(opponent.battleArea.includes(eligible), false, 'destroyed despite high remaining HP');
  assert.equal(opponent.battleArea.includes(tooHigh), true);
});

test('Incendiary Spark GD05-118: AP-2 always; also rests the enemy Unit only if paid with an EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });

  registry.incendiarySparkCommand(state, player, null, { usedExResource: false });
  assert.equal(getAP(enemy), 1, 'AP-2');
  assert.equal(enemy.rested, false, 'not rested without an EX Resource');

  registry.incendiarySparkCommand(state, player, null, { usedExResource: true });
  assert.equal(enemy.rested, true);
});

test('A Wind Against Fires (R+) GD05-119: AP-3 to the attacking enemy Unit, once the friendly Unit it\'s battling is confirmed Lv.5+', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });
  const friendlyUnderAttack = deployUnit(state, player, { number: 'F1', type: 'unit', level: 5, ap: 3, hp: 6 });

  registry.aWindAgainstFiresRPlusCommand(state, player, null, { attackingUnit: enemy, underAttack: friendlyUnderAttack });
  assert.equal(getAP(enemy), 2);
});

test("A Wind Against Fires (R+) GD05-119 does nothing if the friendly Unit being battled is under Lv.5 (its own printed condition)", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });
  const friendlyUnderAttack = deployUnit(state, player, { number: 'F1', type: 'unit', level: 4, ap: 3, hp: 6 });

  registry.aWindAgainstFiresRPlusCommand(state, player, null, { attackingUnit: enemy, underAttack: friendlyUnderAttack });
  assert.equal(getAP(enemy), 5, 'the friendly Unit under attack is Lv.4, below the printed Lv.5 threshold -- no debuff applied');
});

test('A Wind Against Fires (R+) GD05-119 does nothing if the friendly side under attack is a Base, not a Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });
  const base = createInstance({ number: 'B1', type: 'base', ap: 0, hp: 5 }, 0);
  player.base = base;

  registry.aWindAgainstFiresRPlusCommand(state, player, null, { attackingUnit: enemy, underAttack: base });
  assert.equal(getAP(enemy), 5, "\"one of your Units\" excludes a Base -- no debuff applied");
});

test('Archangel GD05-123: friendly (Orb) Units are immune to 2-or-less enemy effect damage during the opponent\'s turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployBase(state, player, lookupCard('GD05-123'));
  const orbUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 5, traits: ['Orb'] });
  const nonOrbUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 5, traits: [] });

  state.activePlayerIdx = 1;
  dealEffectDamage(state, opponent, player, orbUnit, 2);
  assert.equal(orbUnit.damage, 0, 'immune to 2 damage during opponent turn');
  dealEffectDamage(state, opponent, player, nonOrbUnit, 2);
  assert.equal(nonOrbUnit.damage, 2, 'non-(Orb) Unit unaffected');
  dealEffectDamage(state, opponent, player, orbUnit, 3);
  assert.equal(orbUnit.damage, 3, 'damage above the threshold still gets through');

  state.activePlayerIdx = 0;
  dealEffectDamage(state, opponent, player, orbUnit, 1);
  assert.equal(orbUnit.damage, 4, 'no immunity during friendly turn');
});

test("Quiet Zero GD05-126: Activate Main deploys a Gundnode token, gated on a Lv.5+ \"Gundam Aerial\" ally, costs 2, Once per Turn", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const base = deployBase(state, player, lookupCard('GD05-126'));
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource' }, 0));
  player.resourceArea.push(createInstance({ number: 'R2', type: 'resource' }, 0));

  assert.equal(base.def.effects.activateMain(state, player, base, {}), false, 'no qualifying Gundam Aerial ally');

  deployUnit(state, player, { number: 'U1', name: 'Gundam Aerial Rebuild', type: 'unit', ap: 3, hp: 3, level: 5 });
  assert.equal(base.def.effects.activateMain(state, player, base, {}), true);
  assert.equal(player.battleArea.some((u) => u.def.name === 'Gundnode'), true);
  assert.equal(player.resourceArea.every((r) => r.rested), true, 'both resources spent');
  assert.equal(base.def.effects.activateMain(state, player, base, {}), false, 'Once per Turn');
});

test('Girty Lue GD05-127: when a friendly (Phantom Pain) Unit links, disables Blocker on the strongest enemy for the turn, Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const base = deployBase(state, player, lookupCard('GD05-127'));
  const enemyBlocker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, keywords: { blocker: true } });

  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, linkCondition: 'Some Pilot', traits: ['Phantom Pain'] });
  const pilot = createInstance({ number: 'P1', type: 'pilot', name: 'Some Pilot' }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, unit, pilot);

  assert.equal(base.activationsUsed.disableBlocker, true);
  assert.equal(enemyBlocker.buffs.some((b) => b.cannotBlock), true);
  const attacker = deployUnit(state, player, { number: 'A1', type: 'unit', ap: 5, hp: 5 });
  assert.equal(chooseBlocker(opponent, attacker, { type: 'player' }), null, 'the only Blocker is disabled');
});
