const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { runStartPhase } = require('../src/rules/phases');
const { resolveAttack, resolveUnitBattleDamage } = require('../src/rules/combat');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// GD06 "Stardust Trails" -- Blue + Green Units (GD06-001 through GD06-032). Covers the new
// defender-side 'attacked' broadcast (combat.js), the hand-size-scaling AP grant, a Unit-token
// taunt (tauntIfToken), and a new Activate*Action battle-damage redirect (existing
// redirectDamageTarget buff), plus a spot-check of the rest of this slice's more ordinary effects.

test('Gundam GP01Fb GD06-001: draws once, when attacked, per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const gp01fb = deployUnit(state, player, lookupCard('GD06-001'));
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 1, hp: 10 });

  resolveAttack(state, 1, attacker, { type: 'unit', instance: gp01fb }, {});
  assert.equal(player.hand.length, 1, 'drew once when attacked');

  gp01fb.rested = false;
  attacker.rested = false;
  resolveAttack(state, 1, attacker, { type: 'unit', instance: gp01fb }, {});
  assert.equal(player.hand.length, 1, 'once per turn -- no second draw');

  runStartPhase(state);
  gp01fb.rested = false;
  attacker.rested = false;
  resolveAttack(state, 1, attacker, { type: 'unit', instance: gp01fb }, {});
  assert.equal(player.hand.length, 2, 'new turn -- draws again');
});

test('Infinite Justice Gundam GD06-002: heals an (Orb) ally once per turn on a battle kill, and exiles the cheapest 3 trashed Units on Deploy to bounce an active enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const orbAlly = deployUnit(state, player, { number: 'O', type: 'unit', ap: 1, hp: 5, traits: ['Orb'] });
  orbAlly.damage = 4;
  const ij = deployUnit(state, player, { number: 'IJ', type: 'unit', ap: 5, hp: 5, effects: { destroysEnemy: registry.infiniteJusticeGundamGD06002DestroysEnemy } });
  const weakEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1 });

  resolveUnitBattleDamage(state, player, opponent, ij, weakEnemy, {});
  assert.equal(orbAlly.damage, 1, 'recovered 3 HP');

  player.trash.push(
    createInstance({ number: 'C1', type: 'unit', cost: 1 }, 0),
    createInstance({ number: 'C2', type: 'unit', cost: 2 }, 0),
    createInstance({ number: 'C3', type: 'unit', cost: 5 }, 0)
  );
  const activeEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 3 });
  registry.infiniteJusticeGundamGD06002Deploy(state, player);
  assert.equal(player.trash.length, 0, 'all 3 cheap trash Units exiled');
  assert.equal(opponent.battleArea.includes(activeEnemy), false, 'active enemy bounced');
  assert.equal(opponent.hand.length, 1);
});

test('GQuuuuuuX (Omega Psycommu Released) GD06-003: AP scales with hand size, and draws on Attack under the right conditions', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, lookupCard('GD06-003'));
  player.hand.push(createInstance({ number: 'H1', type: 'unit' }, 0), createInstance({ number: 'H2', type: 'unit' }, 0));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));

  runStartPhase(state);
  assert.equal(getAP(unit), 2 + 2, 'base AP 2 plus hand size 2');

  registry.gQuuuuuuXReleasedGD06003Attack(state, player, unit);
  assert.equal(player.hand.length, 2, 'no (Alphacide) ally in play -- no draw');

  deployUnit(state, player, { number: 'ALLY', type: 'unit', ap: 1, hp: 1, traits: ['Alphacide'] });
  registry.gQuuuuuuXReleasedGD06003Attack(state, player, unit);
  assert.equal(player.hand.length, 3, 'ally present and hand size <= 5 -- drew');
});

test('Gundam GP01 GD06-004: During Link, Destroyed on your own turn returns its Pilot and discards 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;
  const unit = deployUnit(state, player, lookupCard('GD06-004'));
  const pilot = createInstance({ number: 'Kou Uraki', type: 'pilot', name: 'Kou Uraki' }, 0);
  pairPilot(state, player, unit, pilot);
  assert.equal(unit.isLinkUnit, true);
  player.hand.push(createInstance({ number: 'EXTRA', type: 'unit', cost: 9 }, 0));

  unit.damage = 99;
  registry.gundamGP01GD06004Destroyed(state, player, unit, { pilot });
  assert.equal(player.hand.includes(pilot), true, 'paired Pilot returned to hand');
  assert.equal(player.hand.some((c) => c.def.number === 'EXTRA'), false, 'discarded a card');
});

test('GM Type C GD06-014 gains Blocker only while 3+ enemy Units are in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD06-014'));
  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  runStartPhase(state);
  assert.equal(require('../src/rules/management').getKeywords(unit).blocker, undefined);

  deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1 });
  runStartPhase(state);
  assert.equal(require('../src/rules/management').getKeywords(unit).blocker, true);
});

test("Waldfeld's Gaia Gundam GD06-015 gains Blocker only while paired with an (Orb) Pilot", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, lookupCard('GD06-015'));
  const { getKeywords } = require('../src/rules/management');
  assert.equal(getKeywords(unit).blocker, undefined);

  pairPilot(state, player, unit, createInstance({ number: 'P', type: 'pilot', traits: ['Orb'] }, 0));
  assert.equal(getKeywords(unit).blocker, true);
});

test("Elpeo Ple's Qubeley Mk-II GD06-018: redirects this battle's incoming battle damage to a chosen friendly Unit, once per turn, only while paired", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const qubeley = deployUnit(state, player, lookupCard('GD06-018'));
  const tank = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 10, traits: ['Neo Zeon'] });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 10 });

  assert.equal(registry.elpeoPlesQubeleyMkII018ActivateAction(state, player, qubeley, { target: tank }), false, 'not paired -- can\'t activate');

  pairPilot(state, player, qubeley, createInstance({ number: 'P', type: 'pilot' }, 0));
  assert.equal(registry.elpeoPlesQubeleyMkII018ActivateAction(state, player, qubeley, { target: tank }), true);
  resolveUnitBattleDamage(state, opponent, player, enemy, qubeley, {});
  assert.equal(qubeley.damage, 0, 'damage redirected away from Qubeley');
  assert.equal(tank.damage, 3, 'redirected onto the chosen ally');
});

test('Turn X GD06-019: forces enemies to attack a rested Unit token if possible, and deploys its own tokens rested when it has none yet', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const turnX = deployUnit(state, player, lookupCard('GD06-019'));

  registry.turnXGD06019Attack(state, player);
  const armsToken = player.battleArea.find((u) => u.def.name === 'Turn X (Arms)');
  const legsToken = player.battleArea.find((u) => u.def.name === 'Turn X (Legs)');
  assert.ok(armsToken && legsToken, 'deployed both tokens');
  assert.equal(armsToken.rested, true);

  const otherUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  legsToken.rested = false; // only the Arms token stays a forced target for this check
  otherUnit.rested = true;
  turnX.rested = true;
  const { getEligibleAttackTargets } = require('../src/ai/heuristic');
  const attacker = deployUnit(state, opponent, { number: 'ATK', type: 'unit', ap: 1, hp: 1 });
  const targets = getEligibleAttackTargets(player, attacker);
  assert.deepEqual(targets, [{ type: 'unit', instance: armsToken }], 'only the rested token is a legal target, not the rested non-token Units');

  registry.turnXGD06019Attack(state, player);
  assert.equal(player.battleArea.filter((u) => u.def.isToken).length, 2, 'already has a token -- no second pair deployed');
});

test("Hamma-Hamma GD06-020 recovers 1 HP when a friendly (Neo Zeon) Unit destroys an enemy with battle damage, but not off a non-(Neo Zeon) kill", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hammaHamma = deployUnit(state, player, lookupCard('GD06-020'));
  hammaHamma.damage = 2;
  const neoZeonAttacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 5, hp: 5, traits: ['Neo Zeon'] });
  const nonNeoZeonAttacker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 5, hp: 5 });
  const enemy1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  const enemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });

  resolveUnitBattleDamage(state, player, opponent, nonNeoZeonAttacker, enemy1, {});
  assert.equal(hammaHamma.damage, 2, 'non-(Neo Zeon) kill -- no heal');

  resolveUnitBattleDamage(state, player, opponent, neoZeonAttacker, enemy2, {});
  assert.equal(hammaHamma.damage, 1, '(Neo Zeon) kill -- healed 1');
});

test('Turn X (Top) GD06-021 Deploy: deploys a second, rested copy of one of its Unit tokens', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  deployUnit(state, player, lookupCard('GD06-021'));
  deployUnit(state, player, { number: 'TOKEN-TURNX-ARMS', name: 'Turn X (Arms)', type: 'unit', isToken: true, ap: 2, hp: 3 });

  registry.turnXTopGD06021Deploy(state, player);
  const copies = player.battleArea.filter((u) => u.def.name === 'Turn X (Arms)');
  assert.equal(copies.length, 2);
  assert.equal(copies[1].rested, true);
});

test("R-Jarja GD06-024 Destroyed: destroys an enemy Blocker Unit with 3 or less AP", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const blocker = deployUnit(state, opponent, { number: 'B', type: 'unit', ap: 3, hp: 5, keywords: { blocker: true } });
  const nonBlocker = deployUnit(state, opponent, { number: 'N', type: 'unit', ap: 1, hp: 5 });

  registry.rJarjaGD06024Destroyed(state, player);
  assert.equal(opponent.battleArea.includes(blocker), false, 'the Blocker Unit with <=3 AP was destroyed');
  assert.equal(opponent.battleArea.includes(nonBlocker), true, 'a non-Blocker Unit is untouched');
});

test('Mashymre\'s Zssa GD06-027 Deploy: grants a friendly (Neo Zeon) Unit a one-turn active-target threshold', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const zssa = deployUnit(state, player, lookupCard('GD06-027'));
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 2, hp: 2, traits: ['Neo Zeon'] });

  registry.mashymresZssaGD06027Deploy(state, player, zssa);
  assert.ok(ally.buffs.some((b) => b.activeTargetAPThreshold === 4));
});

test('Mahiroo GD06-030 gets AP+2 only while 3+ other (Ghingnham Fleet)/(Long-Range Weapon) Units are in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const mahiroo = deployUnit(state, player, lookupCard('GD06-030'));
  for (let i = 0; i < 2; i++) deployUnit(state, player, { number: 'G' + i, type: 'unit', ap: 1, hp: 1, traits: ['Ghingnham Fleet'] });
  runStartPhase(state);
  assert.equal(getAP(mahiroo), 2, 'only 2 others -- no buff yet');

  deployUnit(state, player, { number: 'G3', type: 'unit', ap: 1, hp: 1, traits: ['Ghingnham Fleet'] });
  runStartPhase(state);
  assert.equal(getAP(mahiroo), 4, '3+ others -- AP+2');
});

test('Bellona GD06-032 Destroyed: digs 2, adds a matching Unit to hand, returns the rest to the deck', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(
    createInstance({ number: 'D1', type: 'unit', traits: ['Ghingnham Fleet'] }, 0),
    createInstance({ number: 'D2', type: 'unit' }, 0)
  );
  registry.bellonaGD06032Destroyed(state, player);
  assert.equal(player.hand.length, 1);
  assert.equal(player.hand[0].def.number, 'D1');
  assert.equal(player.deck.length, 1);
});
