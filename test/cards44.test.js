const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot, playCommand } = require('../src/rules/actions');
const { getRemainingHP, getAP, dealDamage } = require('../src/rules/management');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const { payAbilityCost } = require('../src/rules/effects');
const { runStartPhase } = require('../src/rules/phases');
const { getForcedAttackTargets, chooseAttackTarget } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');

test('Rey Za Burrel (R+) GD04-093: When Linked reduces the next (any-source) damage a chosen ZAFT Link Unit receives by 2, one-shot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weaker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 10, traits: ['ZAFT'] });
  weaker.isLinkUnit = true;
  const stronger = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 3, hp: 10, traits: ['ZAFT'] });
  stronger.isLinkUnit = true;

  registry.reyZaBurrelRPlusWhenLinked(state, player);
  assert.ok(stronger.buffs.some((b) => b.nextDamageReduction === 2), 'higher-AP ZAFT Link Unit chosen');

  dealDamage(stronger, 3);
  assert.equal(stronger.damage, 1, 'first hit reduced by 2 (3 - 2 = 1)');
  assert.equal(stronger.buffs.some((b) => b.nextDamageReduction), false, 'buff consumed after one use');
  dealDamage(stronger, 3);
  assert.equal(stronger.damage, 4, 'second hit takes full damage -- reduction was one-shot');
});

test('Pala Sys GD04-094: When Linked returns a purple Suppression Unit card from trash to hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const suppressionCard = createInstance({ number: 'T1', type: 'unit', color: 'purple', cost: 3, keywords: { suppression: true } }, 0);
  const wrongColor = createInstance({ number: 'T2', type: 'unit', color: 'white', cost: 5, keywords: { suppression: true } }, 0);
  const noKeyword = createInstance({ number: 'T3', type: 'unit', color: 'purple', cost: 5, keywords: {} }, 0);
  player.trash.push(wrongColor, noKeyword, suppressionCard);

  registry.palaSysWhenLinked(state, player);
  assert.ok(player.hand.includes(suppressionCard), 'the matching purple/Suppression card is added to hand');
  assert.equal(player.trash.includes(suppressionCard), false, 'removed from trash');
  assert.equal(player.trash.length, 2, 'non-matching cards left untouched');
});

test('Lunamaria Hawke (U+) GD04-095: When Linked redirects a chosen ally\'s battle damage to her paired Unit, including on the DEFENDING side', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const linkUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 10 });
  const protectedAlly = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 3, traits: ['Minerva Squad'] });
  const attacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });

  registry.lunamariaHawkeUPlusWhenLinked(state, player, linkUnit);
  assert.ok(protectedAlly.buffs.some((b) => b.redirectDamageTarget === linkUnit && b.scope === 'turn'));

  // protectedAlly is the DEFENDER this battle -- damage should land on linkUnit instead.
  resolveUnitBattleDamage(state, opponent, player, attacker, protectedAlly, {});
  assert.equal(getRemainingHP(protectedAlly), 3, 'the originally-targeted ally takes none of the redirected damage');
  assert.equal(getRemainingHP(linkUnit), 5, 'the redirect recipient takes the 5 battle damage instead');
});

test('Ennil El GD04-096: During Link, deals-battle-damage destroys an enemy Unit that is Lv.5 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 10, hp: 5, level: 4, linkCondition: 'Ennil El' });
  const pilot = createInstance(lookupCard('GD04-096'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, attacker, pilot);
  assert.equal(attacker.isLinkUnit, true, 'link condition matched by pilot name');
  const defender = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 20, level: 5 });

  resolveUnitBattleDamage(state, player, opponent, attacker, defender, {});
  assert.equal(opponent.battleArea.includes(defender), false, 'Lv.5 defender destroyed despite only 10 of 20 HP damage dealt');
});

test("chooseAttackTarget recognizes Ennil El's force-destroy via the paired Pilot's own def, not just the Unit's, and only while Linked", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 5, level: 4, linkCondition: 'Ennil El' });
  const bigUnit = createInstance({ number: 'BIG', type: 'unit', level: 5, ap: 8, hp: 20 }, 1);
  bigUnit.rested = true;
  opponent.battleArea.push(bigUnit);

  assert.equal(chooseAttackTarget(opponent, attacker, false, player).type, 'player', 'no Pilot paired yet -- not Linked, no execution target recognized');

  const pilot = createInstance(lookupCard('GD04-096'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, attacker, pilot);
  assert.equal(attacker.isLinkUnit, true);

  const target = chooseAttackTarget(opponent, attacker, false, player);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, bigUnit, 'Linked now -- Ennil El (Pilot-sourced) force-destroy recognized despite only 3 AP vs 20 HP');
});

test('Loran Cehack (R+) GD04-097: When Linked returns a 3-or-less-HP enemy Unit to its owner\'s hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowHP = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 3 });
  const highHP = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 10 });

  registry.loranCehackRPlusWhenLinked(state, player);
  assert.equal(opponent.battleArea.includes(lowHP), false, 'the 3-HP enemy is removed from the battle area');
  assert.ok(opponent.hand.includes(lowHP), 'and returned to its owner\'s hand');
  assert.ok(opponent.battleArea.includes(highHP), 'the 10-HP enemy is untouched');
});

test('Ali al-Saachez GD04-099: During Link, Attack returns an enemy Pilot to its owner\'s hand (gated on isLinkUnit)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  const enemyUnit = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const enemyPilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 1, hpBonus: 0 }, 1);
  opponent.hand.push(enemyPilot);
  pairPilot(state, opponent, enemyUnit, enemyPilot);

  registry.aliAlSaachezAttack(state, player, attacker);
  assert.equal(enemyUnit.pilot, enemyPilot, 'not During Link -- no effect, still paired');
  assert.equal(opponent.hand.includes(enemyPilot), false);

  attacker.isLinkUnit = true;
  registry.aliAlSaachezAttack(state, player, attacker);
  assert.equal(enemyUnit.pilot, null, 'the enemy Pilot is unpaired');
  assert.ok(opponent.hand.includes(enemyPilot), 'and returned to its owner\'s hand');
  assert.ok(opponent.battleArea.includes(enemyUnit), 'the Unit itself stays in play, unpaired');
});

test('Sochie Heim GD04-100: friendlyPaysAbilityCost grants AP equal to the cost paid, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const sochieUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  const other = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource' }, 0), createInstance({ number: 'R2', type: 'resource' }, 0));

  registry.sochieHeimFriendlyPaysAbilityCost(state, player, sochieUnit, { source: other, amount: 1 });
  assert.equal(getAP(sochieUnit), 3, 'AP+1 for the (1) paid');

  registry.sochieHeimFriendlyPaysAbilityCost(state, player, sochieUnit, { source: other, amount: 2 });
  assert.equal(getAP(sochieUnit), 3, 'once per turn -- second payment this turn ignored');
});

test('Sochie Heim GD04-100: the real payAbilityCost chokepoint reaches her ability through a paired Unit (not just the isolated registry call)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  // A Pilot-granted broadcast reaction (as opposed to a Unit's own, like Gundam Lfrith Ur's
  // friendlyPlaysCommand) previously never fired -- payAbilityCost's broadcast only checked the
  // Unit's own def.effects, never its paired Pilot's. Fixed alongside the identical gap found in
  // playCommand's friendlyPlaysCommand broadcast (Suletta Mercury GD04-085) this batch.
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  const pilot = createInstance(lookupCard('GD04-100'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, unit, pilot);
  const other = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });

  payAbilityCost(state, player, other, 2);
  assert.equal(getAP(unit), 4, 'AP+2 applied through the real broadcast to the paired Pilot\'s handler');
});

test('Moment of Rest (U+) GD04-102: Burst draws 1; Main skips a rested Lv.5-or-lower enemy\'s next untap', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const deckCard = createInstance({ number: 'D1', type: 'unit' }, 0);
  player.deck.push(deckCard);

  registry.momentOfRestUPlusBurst(state, player);
  assert.ok(player.hand.includes(deckCard));

  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 5 });
  target.rested = true;
  const tooHigh = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 6 });
  tooHigh.rested = true;

  registry.momentOfRestUPlusCommand(state, player);
  assert.equal(target.skipNextUntap, true);
  assert.equal(tooHigh.skipNextUntap, undefined, 'Lv.6 is not Lv.5-or-lower -- not a legal target');

  state.activePlayerIdx = 1; // opponent's next start phase
  runStartPhase(state);
  assert.equal(target.rested, true, 'skipped its untap as promised');
  runStartPhase(state); // pretend a further start phase rolls around (own future turn)
});

test('Spiritual Support GD04-103: Main grants a chosen Unit <Repair 2> for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const damaged = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });
  damaged.damage = 3;
  const fullHP = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5 });

  registry.spiritualSupportCommand(state, player);
  assert.ok(damaged.buffs.some((b) => b.repair === 2), 'the more-damaged Unit is chosen');
  assert.equal(fullHP.buffs.length, 0);
});

test("Shrike Team's Bulwark GD04-104: rests 1-2 enemy Units that are Lv.2 or lower", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 1, level: 2 });
  const low2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 1 });
  const high = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1, level: 5 });

  registry.shrikeTeamsBulwarkCommand(state, player, null, {});
  assert.equal(low1.rested, true);
  assert.equal(low2.rested, true);
  assert.equal(high.rested, false, 'Lv.5 is not a legal target');
});

test('Encounter (R+) GD04-105: Main reveals 1 Pilot from the top 5, shuffles the rest to the bottom', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const pilot = createInstance({ number: 'P1', type: 'pilot' }, 0);
  const filler = [1, 2, 3, 4].map((i) => createInstance({ number: `F${i}`, type: 'unit' }, 0));
  player.deck.push(filler[0], filler[1], pilot, filler[2], filler[3]);
  const startingDeckSize = player.deck.length;

  registry.encounterRPlusCommand(state, player);
  assert.ok(player.hand.includes(pilot), 'the Pilot card is added to hand');
  assert.equal(player.deck.length, startingDeckSize - 1, 'the other 4 cards go back to the deck');
  assert.equal(player.deck.includes(pilot), false);
});

test('Indiscriminate Violence GD04-106: grants 1 target normally, 2 when played with an EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const a = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 1, traits: ['Academy'] });
  const b = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 1, traits: ['Academy'] });
  deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 1 }); // non-Academy, never eligible

  registry.indiscriminateViolenceCommand(state, player, null, { usedExResource: false });
  assert.equal(a.buffs.filter((buf) => buf.activeTargetAPThreshold === 5).length, 1);
  assert.equal(b.buffs.some((buf) => buf.activeTargetAPThreshold === 5), false, 'only 1 target without an EX Resource');

  registry.indiscriminateViolenceCommand(state, player, null, { usedExResource: true });
  assert.ok(b.buffs.some((buf) => buf.activeTargetAPThreshold === 5), 'the 2nd target now also gets it with an EX Resource');
});

test('Destined Battle GD04-107: Burst adds to hand; Action forces enemies to target a chosen rested Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = createInstance(lookupCard('GD04-107'), 0);
  registry.destinedBattleBurst(state, player, instance);
  assert.ok(player.hand.includes(instance));

  const rested = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });
  rested.rested = true;
  const active = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5 });

  registry.destinedBattleCommand(state, player);
  const forced = getForcedAttackTargets(player);
  assert.deepEqual(forced, [rested], 'only the rested, buffed Unit is a forced target');
  assert.equal(active.buffs.length, 0);
});

test('Witches from Earth GD04-108: reduces the next damage by 2 normally, by 4 with an EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const ally = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 20, traits: ['Academy'] });

  registry.witchesFromEarthCommand(state, player, null, { usedExResource: false });
  assert.ok(ally.buffs.some((b) => b.nextDamageReduction === 2));

  ally.buffs = [];
  registry.witchesFromEarthCommand(state, player, null, { usedExResource: true });
  assert.ok(ally.buffs.some((b) => b.nextDamageReduction === 4));
});

test('Financier (U+) GD04-110: Main/Action deploys 1 EX Base, replacing whatever Base was there', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const previousBase = deployBase(state, player, { number: 'B1', type: 'base', ap: 0, hp: 3 });

  registry.financierUPlusCommand(state, player);
  assert.notEqual(player.base, previousBase, 'a fresh EX Base replaces the old one');
  assert.equal(player.base.def.number, 'EX-BASE');
  assert.ok(player.trash.includes(previousBase), 'the old Base is trashed');
});

test("Suletta Mercury (R+) GD04-085 regression: her friendlyPlaysCommand now fires through the real playCommand broadcast (previously dead code)", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, linkCondition: 'Suletta Mercury' });
  const pilot = createInstance(lookupCard('GD04-085'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, unit, pilot);
  assert.equal(unit.isLinkUnit, true, 'link condition matched by pilot name');

  playCommand(state, player, { number: 'C1', type: 'command', traits: ['Academy'], cost: 0, level: 0 }, { usedExResource: true });
  assert.equal(player.resourceArea.length, 1, "Suletta's During-Link ability placed a rested EX Resource");
  assert.equal(player.resourceArea[0].rested, true);
});
