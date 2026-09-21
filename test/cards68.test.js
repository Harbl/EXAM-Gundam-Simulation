const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { collectActivateCandidates, collectActivateActionCandidates, ATTACKER_ACTION_RESOLVERS } = require('../src/ai/activations');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// ST12 "Raging Onslaught" -- covers the Activate·Main/Action wiring (RESOLVERS/ACTION_RESOLVERS/
// ATTACKER_ACTION_RESOLVERS) this starter needed for the first time this session, plus the new
// onKill-during-battle grant and the paired-unit-killed-this-turn tracker, plus a spot-check of the
// more ordinary card effects.

test('Gundam Epyon ST12-001: destroysEnemy AoE only fires while paired with a Lv.5+ Pilot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const epyon = deployUnit(state, player, lookupCard('ST12-001'));
  const weakEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 3 });

  registry.gundamEpyonST12001DestroysEnemy(state, player, epyon);
  assert.equal(weakEnemy.damage, 0, 'no Pilot paired yet');

  const lowLevelPilot = createInstance({ number: 'P1', type: 'pilot', level: 2 }, 0);
  pairPilot(state, player, epyon, lowLevelPilot);
  registry.gundamEpyonST12001DestroysEnemy(state, player, epyon);
  assert.equal(weakEnemy.damage, 0, 'Pilot is under Lv.5');

  const highLevelPilot = createInstance({ number: 'P2', type: 'pilot', level: 5 }, 0);
  epyon.pilot = highLevelPilot;
  registry.gundamEpyonST12001DestroysEnemy(state, player, epyon);
  assert.equal(weakEnemy.damage, 2);
});

test('Gundam Epyon ST12-001 Deploy: deals 5 damage to the enemy Base', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.base = createInstance({ number: 'B', type: 'base', hp: 8 }, 1);

  registry.gundamEpyonST12001Deploy(state, player);
  assert.equal(opponent.base.damage, 5);
});

test('Unicorn Gundam 02 Banshee (Destroy Mode) ST12-006: [Activate·Main]/[Activate·Action] are only offered while paired, and exile 4 trash cards', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const banshee = deployUnit(state, player, lookupCard('ST12-006'));
  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit' }, 0));

  let candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.some((c) => c.source === banshee), false, 'not paired yet -- not offered');

  pairPilot(state, player, banshee, createInstance({ number: 'P', type: 'pilot' }, 0));
  candidates = collectActivateCandidates(state, 0);
  const candidate = candidates.find((c) => c.source === banshee);
  assert.ok(candidate, 'offered once paired with 4+ trash cards');
  candidate.handler(state, player, banshee, candidate.args);
  assert.equal(player.trash.length, 0, 'exiled all 4');
  assert.equal(player.removal.length, 4);
  assert.equal(banshee.buffs.some((b) => b.keyword === 'firstStrike'), true);
});

test('Unicorn Gundam 02 Banshee (Destroy Mode) ST12-006: [Activate·Action] Suppression grant is only offered to the attacking side', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const banshee = deployUnit(state, player, lookupCard('ST12-006'));
  pairPilot(state, player, banshee, createInstance({ number: 'P', type: 'pilot' }, 0));
  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit' }, 0));
  const enemyTarget = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 3 });

  const asDefender = collectActivateActionCandidates(state, 0, { attacker: enemyTarget, target: { type: 'unit', instance: banshee } });
  assert.equal(asDefender.some((c) => c.source === banshee), false, 'not offered as a reactive defender ability');

  const asAttacker = collectActivateActionCandidates(
    state, 0, { attacker: banshee, target: { type: 'unit', instance: enemyTarget } }, ATTACKER_ACTION_RESOLVERS
  );
  const candidate = asAttacker.find((c) => c.source === banshee);
  assert.ok(candidate, 'offered while actually attacking');
  candidate.handler(state, player, banshee, candidate.args);
  assert.equal(banshee.buffs.some((b) => b.keyword === 'suppression' && b.scope === 'battle'), true);
});

test('Milliardo Peacecraft ST12-011: Activate·Action deals 2 damage to a damaged enemy Unit actually battling the paired Unit, from either side of combat', () => {
  const defender = createPlayer(0);
  const attacker = createPlayer(1);
  const state = createGame(defender, attacker);
  const defendingUnit = deployUnit(state, defender, { number: 'D', type: 'unit', ap: 3, hp: 5 });
  pairPilot(state, defender, defendingUnit, createInstance(lookupCard('ST12-011'), 0));
  const attackingUnit = deployUnit(state, attacker, { number: 'A', type: 'unit', ap: 3, hp: 5 });
  attackingUnit.damage = 1;

  const asDefender = collectActivateActionCandidates(state, 0, { attacker: attackingUnit, target: { type: 'unit', instance: defendingUnit } });
  const candidate = asDefender.find((c) => c.source === defendingUnit);
  assert.ok(candidate, 'offered to the defending side against a damaged attacker');
  candidate.handler(state, defender, defendingUnit, candidate.args);
  assert.equal(attackingUnit.damage, 3);
});

test('Wise Leader\'s Pride ST12-014: grants a this-battle onKill-destroy trigger', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const myUnit = deployUnit(state, player, { number: 'M', type: 'unit', ap: 5, hp: 5 });
  const bigEnemy = deployUnit(state, opponent, { number: 'B', type: 'unit', ap: 3, hp: 1 });
  const smallEnemy = deployUnit(state, opponent, { number: 'S', type: 'unit', ap: 2, hp: 5 });

  registry.wiseLeadersPrideST12014Command(state, player);
  const { resolveUnitBattleDamage } = require('../src/rules/combat');
  resolveUnitBattleDamage(state, player, opponent, myUnit, bigEnemy, {});

  assert.equal(opponent.battleArea.includes(bigEnemy), false, 'destroyed by the battle itself');
  assert.equal(opponent.battleArea.includes(smallEnemy), false, '2-or-less-AP enemy destroyed by the onKill grant');
});

test('Libra ST12-016: Activate·Main is only offered after a friendly paired Unit destroys an enemy with battle damage this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const libra = deployUnit(state, player, lookupCard('ST12-016'));
  deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 2, hp: 2, level: 3 });
  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 5, level: 3 }); // survives to be Libra's own target

  let candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.some((c) => c.source === libra), false, 'nothing killed yet this turn');

  const myUnit = deployUnit(state, player, { number: 'M', type: 'unit', ap: 5, hp: 5 });
  pairPilot(state, player, myUnit, createInstance({ number: 'P', type: 'pilot' }, 0));
  const { resolveUnitBattleDamage } = require('../src/rules/combat');
  const enemy = opponent.battleArea[0];
  resolveUnitBattleDamage(state, player, opponent, myUnit, enemy, {});

  candidates = collectActivateCandidates(state, 0);
  const candidate = candidates.find((c) => c.source === libra);
  assert.ok(candidate, 'offered once a paired friendly Unit has killed with battle damage this turn');
});

test('The Final Victor ST12-013 Command: begins a battle between each side\'s chosen Unit, damage step only', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const myUnit = deployUnit(state, player, { number: 'M', type: 'unit', ap: 4, hp: 5 });
  const theirUnit = deployUnit(state, opponent, { number: 'T', type: 'unit', ap: 3, hp: 5 });

  registry.theFinalVictorST12013Command(state, player, null, {});
  assert.equal(theirUnit.damage, 4, 'took my Unit\'s AP as damage');
  assert.equal(myUnit.damage, 3, 'took their Unit\'s AP as return damage');
});

test('Two Unicorns ST12-015: destroys a Lv.2-or-lower enemy outright when one exists', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowLevel = deployUnit(state, opponent, { number: 'L', type: 'unit', level: 2, ap: 2, hp: 2 });

  registry.twoUnicornsST12015Command(state, player);
  assert.equal(opponent.battleArea.includes(lowLevel), false);
});
