const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { canAfford } = require('../src/rules/cost');
const { runStartPhase, runEndPhase } = require('../src/rules/phases');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');
const { collectAttackCandidates } = require('../src/ai/heuristic');

// GD06 "Stardust Trails" -- Purple Units (GD06-049 through GD06-063). Covers a new
// triggerEvent-side grantedEffect resolution for an end-of-turn-scoped granted ability (GFreD), and
// confirms Blast Impulse Gundam's deploy-turn attack exception reuses the existing
// attackOnDeployRestedOnly field with zero new code, plus a spot-check of the rest of this slice.

test("Gundam GP02A GD06-049: When Paired destroys the enemy's Base with 10+ (Zeon) Units in trash, and Destroyed digs 3 to hand (or trash)", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.base = createInstance({ number: 'B', type: 'base', hp: 5 }, 1);
  const gp02a = deployUnit(state, player, lookupCard('GD06-049'));

  registry.gundamGP02AGD06049WhenPaired(state, player);
  assert.ok(opponent.base, 'fewer than 10 (Zeon) Units in trash -- Base survives');

  for (let i = 0; i < 10; i++) player.trash.push(createInstance({ number: 'Z' + i, type: 'unit', traits: ['Zeon'] }, 0));
  registry.gundamGP02AGD06049WhenPaired(state, player);
  assert.equal(opponent.base, null, "10+ -- opponent's Base destroyed");

  player.deck.push(createInstance({ number: 'D1', type: 'unit', traits: ['Delaz Fleet'] }, 0), createInstance({ number: 'D2', type: 'unit' }, 0), createInstance({ number: 'D3', type: 'unit' }, 0));
  registry.gundamGP02AGD06049Destroyed(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true, '(Delaz Fleet) match goes to hand');
  assert.equal(player.trash.some((c) => c.def.number === 'D2'), true, 'the rest go to trash, not back to the deck');
});

test('Legend Gundam GD06-050: Deploy destroys 1 Lv.3-or-lower enemy normally, or 1-2 when deployed from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weak1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 2, ap: 1, hp: 1 });
  const weak2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 3, ap: 1, hp: 1 });

  registry.legendGundamGD06050Deploy(state, player, createInstance(lookupCard('GD06-050'), 0), {});
  assert.equal(opponent.battleArea.length, 1, 'a normal deploy only destroys 1');

  deployUnit(state, opponent, { number: 'E3', type: 'unit', level: 1, ap: 1, hp: 1 });
  registry.legendGundamGD06050Deploy(state, player, createInstance(lookupCard('GD06-050'), 0), { fromTrash: true });
  assert.equal(opponent.battleArea.length, 0, 'deployed from trash -- destroys up to 2');
});

test('Legend Gundam GD06-050: this card in trash gets Lv.-3/cost-3 only while a (ZAFT) Link Unit is in play, and only when paying its cost from trash', () => {
  const player = createPlayer(0);
  const legendGundam = lookupCard('GD06-050');
  assert.equal(legendGundam.level, 6);
  assert.equal(legendGundam.cost, 5);
  // 3 total Resources: fails the unreduced Lv.6 check outright, regardless of cost.
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  const nonZaftLink = { isLinkUnit: true, def: { traits: ['Zeon'] } };
  const zaftLink = { isLinkUnit: true, def: { traits: ['ZAFT'] } };

  assert.equal(canAfford(player, legendGundam, { fromTrash: true }), false, 'no (ZAFT) Link Unit -- unreduced Lv.6 fails with only 3 Resources');

  player.battleArea.push(nonZaftLink);
  assert.equal(canAfford(player, legendGundam, { fromTrash: true }), false, 'a non-(ZAFT) Link Unit does not qualify');

  player.battleArea.push(zaftLink);
  assert.equal(canAfford(player, legendGundam, {}), false, 'not gated on opts.fromTrash -- a normal hand-deploy check gets no reduction');
  assert.equal(canAfford(player, legendGundam, { fromTrash: true }), true, '(ZAFT) Link Unit in play + paying from trash -- reduced to Lv.3/cost 2');
});

test("Legend Gundam GD06-050: deploying it from trash via Destiny Gundam GD04-050's trash-deploy (also (Minerva Squad)) destroys 2 enemies, and the (ZAFT) Link discount makes it affordable", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  const legend = createInstance(lookupCard('GD06-050'), 0);
  player.trash.push(legend);
  deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 2, ap: 1, hp: 1 });
  deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 3, ap: 1, hp: 1 });

  const destiny = deployUnit(state, player, lookupCard('GD04-050'));
  destiny.pilot = createInstance({ number: 'X', type: 'pilot' }, 0);
  lookupCard('GD04-050').effects.attack(state, player, destiny, {});
  assert.equal(player.battleArea.includes(legend), false, 'no (ZAFT) Link Unit yet -- Lv.6 unaffordable with only 3 Resources');

  const zaftLink = deployUnit(state, player, { number: 'Z', type: 'unit', ap: 1, hp: 1, traits: ['ZAFT'] });
  zaftLink.isLinkUnit = true;
  lookupCard('GD04-050').effects.attack(state, player, destiny, {});
  assert.equal(player.battleArea.some((u) => u.def.number === 'GD06-050'), true, 'now affordable at Lv.3/cost 2 -- deployed from trash');
  assert.equal(opponent.battleArea.length, 0, "deployed from trash -- Legend Gundam's own Deploy destroys both Lv.3-or-lower enemies");
});

test('GFreD GD06-051: Activate*Main pays (2) + rests itself to redeploy a cheap trashed (Alphacide) Unit, once per turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const gfred = deployUnit(state, player, lookupCard('GD06-051'));
  for (let i = 0; i < 2; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  const cheapAlphacide = createInstance({ number: 'A1', type: 'unit', cost: 2, traits: ['Alphacide'], level: 3 }, 0);
  const pricierAlphacide = createInstance({ number: 'A2', type: 'unit', cost: 4, traits: ['Alphacide'], level: 3 }, 0);
  player.trash.push(cheapAlphacide, pricierAlphacide);

  const result = registry.gfredGD06051ActivateMain(state, player, gfred);
  assert.equal(result, true);
  assert.equal(gfred.rested, true);
  assert.equal(player.resourceArea.every((r) => r.rested), true);
  assert.equal(player.battleArea.some((u) => u.def.number === 'A2'), true, 'redeployed the pricier (higher-value) match');
  assert.equal(player.trash.includes(pricierAlphacide), false);

  gfred.rested = false;
  assert.equal(registry.gfredGD06051ActivateMain(state, player, gfred), false, 'once per turn -- no second activation');
});

test('GFreD GD06-051 Deploy: grants a one-turn end-of-turn "activate 2 Resources" effect only with another (Alphacide) ally in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const gfred = deployUnit(state, player, lookupCard('GD06-051'));
  for (let i = 0; i < 2; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource', rested: true }, 0));
  player.resourceArea.forEach((r) => (r.rested = true));

  registry.gfredGD06051Deploy(state, player, gfred);
  assert.equal(player.resourceArea.every((r) => r.rested), true, 'no (Alphacide) ally -- no grant');

  deployUnit(state, player, { number: 'ALLY', type: 'unit', ap: 1, hp: 1, traits: ['Alphacide'] });
  registry.gfredGD06051Deploy(state, player, gfred);
  runEndPhase(state, {});
  assert.equal(player.resourceArea.filter((r) => !r.rested).length, 2, 'both Resources set active at end of turn');
});

test("Val Walo GD06-052 gains High-Maneuver only with 5+ (Zeon) Units in trash, and Deploy mills 1, resting a low-AP enemy only off a (Zeon) mill", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const valWalo = deployUnit(state, player, lookupCard('GD06-052'));
  const { getKeywords } = require('../src/rules/management');
  runStartPhase(state);
  assert.equal(getKeywords(valWalo).highManeuver, undefined);

  for (let i = 0; i < 5; i++) player.trash.push(createInstance({ number: 'Z' + i, type: 'unit', traits: ['Zeon'] }, 0));
  runStartPhase(state);
  assert.equal(getKeywords(valWalo).highManeuver, true);

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 3 });
  player.deck.push(createInstance({ number: 'NOTZEON', type: 'unit' }, 0));
  registry.valWaloGD06052Deploy(state, player);
  assert.equal(enemy.rested, false, 'milled a non-(Zeon) card -- no Rest');

  player.deck.push(createInstance({ number: 'ZEONCARD', type: 'unit', traits: ['Zeon'] }, 0));
  registry.valWaloGD06052Deploy(state, player);
  assert.equal(enemy.rested, true, 'milled a (Zeon) card -- Rest applied');
});

test("Xavier's Gyan Hakuji-Packs (GQ) GD06-053 Destroyed: sets one of its own rested Resources active", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const resource = createInstance({ number: 'R', type: 'resource' }, 0);
  resource.rested = true;
  player.resourceArea.push(resource);

  registry.xaviersGyanHakujiPacksGD06053Destroyed(state, player);
  assert.equal(resource.rested, false);
});

test('GFreD GD06-054 Deploy: deals 1 damage to a friendly and 1 to an enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gfred = deployUnit(state, player, lookupCard('GD06-054'));
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 5 });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });

  registry.gfredGD06054Deploy(state, player, gfred);
  assert.equal(ally.damage, 1);
  assert.equal(enemy.damage, 1);
});

test('Gundam GP02A GD06-055: During Pair Attack, may self-damage 1 for Breach 2 this battle', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const gp02a = deployUnit(state, player, lookupCard('GD06-055'));
  const { getKeywords } = require('../src/rules/management');
  registry.gundamGP02A055Attack(state, player, gp02a);
  assert.equal(gp02a.damage, 0, 'not paired -- no effect');

  pairPilot(state, player, gp02a, createInstance({ number: 'P', type: 'pilot' }, 0));
  registry.gundamGP02A055Attack(state, player, gp02a);
  assert.equal(gp02a.damage, 1);
  assert.equal(getKeywords(gp02a).breach, 2);
});

test('Blast Impulse Gundam GD06-058 can attack on its own deploy turn (attackOnDeployRestedOnly)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const blastImpulse = deployUnit(state, player, lookupCard('GD06-058'));
  assert.equal(blastImpulse.turnDeployed, state.turnNumber);

  const candidates = collectAttackCandidates(state, 0);
  const entry = candidates.find((c) => c.attacker === blastImpulse);
  assert.ok(entry, 'eligible to attack the turn it was deployed');
  assert.equal(entry.forcedUnitOnly, true, 'but only against a Unit, never the player directly');
});

test('Zaku II F2 GD06-060 gets AP+1 only with 4+ (Zeon) Units in trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const zakuII = deployUnit(state, player, lookupCard('GD06-060'));
  runStartPhase(state);
  assert.equal(getAP(zakuII), 2);

  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: 'Z' + i, type: 'unit', traits: ['Zeon'] }, 0));
  runStartPhase(state);
  assert.equal(getAP(zakuII), 3);
});
