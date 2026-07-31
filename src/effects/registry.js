const { dealDamage, getRemainingHP, recoverHP } = require('../rules/management');
const { deployUnit, becomeBase } = require('../rules/actions');
const { drawCard } = require('../rules/phases');
const { resolveUnitBattleDamage } = require('../rules/combat');
const { createInstance, shuffle } = require('../rules/state');
const { EX_RESOURCE_DEF } = require('../rules/setup');

function opponentOf(state, player) {
  return state.players.find((p) => p !== player);
}

// --- Guntank GD01-008 ---------------------------------------------------
// [Deploy] Choose 1 rested enemy Unit. Deal 1 damage to it.
function guntankDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  dealDamage(target, 1);
}

// --- Zaku II ST03-008 ----------------------------------------------------
// [Attack] This Unit gets AP+2 during this turn.
function zakuIIAttackBuff(state, player, instance) {
  instance.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Char's Zaku II GD01-026 ---------------------------------------------
// [During Pair][Destroyed] Deploy 1 rested Char's Zaku II (Zeon, AP3/HP1) Unit token.
const CHARS_ZAKU_TOKEN = Object.freeze({
  number: 'TOKEN-CHARS-ZAKU',
  name: "Char's Zaku II",
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 3,
  hp: 1,
  isToken: true,
  keywords: {}
});
function charsZakuGD01026Destroyed(state, player, instance, context) {
  if (!context.wasPaired) return; // gated by [During Pair]
  const token = deployUnit(state, player, CHARS_ZAKU_TOKEN);
  token.rested = true;
}

// --- Char's Zaku II ST03-006 ---------------------------------------------
// [Destroyed] Look at the top 3 cards of your deck. You may reveal 1 (Zeon)/(Neo Zeon) Unit
// card among them and add it to your hand. (Always takes the match if one exists -- with only
// one qualifying category there's no meaningful choice among candidates to model.)
function charsZakuST03006Destroyed(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex(
    (c) => c.def.type === 'unit' && c.def.traits && (c.def.traits.includes('Zeon') || c.def.traits.includes('Neo Zeon'))
  );
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.unshift(...top3);
}

// --- Char Aznable ST03-011 (Pilot) ----------------------------------------
// [Attack] During this turn, this Unit gets AP+1 and, if it is a Link Unit, gains <High-Maneuver>.
function charAznableAttack(state, player, unit) {
  unit.buffs.push({ ap: 1, scope: 'turn' });
  if (unit.isLinkUnit) unit.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Amuro Ray ST01-010 (Pilot) --------------------------------------------
// [Burst] Add this card to your hand. [When Paired] Choose 1 enemy Unit with 5 or less HP. Rest it.
function amuroRayBurst(state, player, instance) {
  player.hand.push(instance);
}
function amuroRayWhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 5);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  target.rested = true;
}

// --- Gundam ST01-001 ---------------------------------------------------
// [Repair 2] (keyword, see card data). [During Pair] During your turn, all your Units get AP+1.
function gundamDuringPairStartOfTurn(state, player, instance) {
  if (!instance.pilot) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  for (const unit of player.battleArea) unit.buffs.push({ ap: 1, scope: 'turn' });
}

// --- A Show of Resolve GD01-100 (Command) ---------------------------------
// Draw 2.
function aShowOfResolveCommand(state, player) {
  drawCard(state, player);
  drawCard(state, player);
}

// --- Jaburo GD04-122 (Base) -----------------------------------------------
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand.
// [Activate*Main][Once per Turn] Rest 1 of your (Earth Federation) Units: choose 1 enemy Unit
// that is Lv.3 or lower. Rest it.
function jaburoBurst(state, player, instance) {
  becomeBase(state, player, instance); // fires Deploy internally
}
function jaburoDeploy(state, player, instance) {
  if (player.shields.length === 0) return;
  const shield = player.shields.shift();
  player.hand.push(shield);
}
function jaburoActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.restEnemy) return false;
  const { restUnit, target } = context;
  if (!restUnit || restUnit.rested || !(restUnit.def.traits || []).includes('Earth Federation')) return false;
  if (!target || (target.def.level || 0) > 3) return false;
  restUnit.rested = true;
  target.rested = true;
  instance.activationsUsed.restEnemy = true;
  return true;
}

// --- Zeong GD04-017 --------------------------------------------------------
// Link Condition [Char Aznable]. [When Paired (Newtype) Pilot] Deploy 2 Wire-Guided Arm ((Zeon)
// AP2/HP1, can't be paired) Unit tokens. [Destroyed] Deploy 1 rested Zeong (Head) ((Zeon) AP3/HP1)
// Unit token.
const WIRE_GUIDED_ARM_TOKEN = Object.freeze({
  number: 'TOKEN-WIRE-ARM',
  name: 'Wire-Guided Arm',
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 2,
  hp: 1,
  isToken: true,
  keywords: {},
  cannotBePaired: true
});
const ZEONG_HEAD_TOKEN = Object.freeze({
  number: 'TOKEN-ZEONG-HEAD',
  name: 'Zeong (Head)',
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 3,
  hp: 1,
  isToken: true,
  keywords: {}
});
function zeongWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Newtype')) return;
  deployUnit(state, player, WIRE_GUIDED_ARM_TOKEN);
  deployUnit(state, player, WIRE_GUIDED_ARM_TOKEN);
}
function zeongDestroyed(state, player) {
  const token = deployUnit(state, player, ZEONG_HEAD_TOKEN);
  token.rested = true;
}

// --- Kayra's Re-GZ GD05-029 ------------------------------------------------
// [Deploy] Look at the top card of your deck. Return it to the top or bottom of your deck.
// (Heuristic: keep a Unit/Base on top since it's an immediate board play; bury anything else.)
function kayrasRegzDeploy(state, player) {
  if (player.deck.length === 0) return;
  const top = player.deck[0];
  const worthKeeping = top.def.type === 'unit' || top.def.type === 'base';
  if (!worthKeeping) {
    player.deck.shift();
    player.deck.push(top);
  }
}

// --- Re-GZ GD05-019 ---------------------------------------------------------
// [Destroyed] Look at the top 3 cards of your deck. You may reveal 1 (Londo Bell) Unit card among
// them and add it to your hand. Return the remaining cards randomly to the bottom of your deck.
function regzDestroyed(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Londo Bell'));
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- Gundam AGE-2 Normal (SP Ver.) GD05-024 ---------------------------------
// [Destroyed] Choose 1 green (Earth Federation) Pilot card from your trash. Add it to your hand.
// If you do, discard 1. (Heuristic: discard whichever hand card is least immediately useful.)
function gundamAge2Destroyed(state, player) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'pilot' && c.def.color === 'green' && (c.def.traits || []).includes('Earth Federation')
  );
  if (candidates.length === 0) return;
  const chosen = candidates[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);

  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.hand.splice(player.hand.indexOf(toDiscard), 1);
  player.trash.push(toDiscard);
}

// --- Nu Gundam GD05-020 ------------------------------------------------------
// [During Pair] This Unit gains <Breach 3> (see card data). [Deploy] If there are 2 or more
// (Londo Bell) cards in your trash, place 1 EX Resource.
function nuGundam020Deploy(state, player) {
  const londoBellInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Londo Bell')).length;
  if (londoBellInTrash < 2) return;
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));
}

// --- Nu Gundam GD05-017 -------------------------------------------------------
// <Breach 5> (see card data). [When Paired] You may choose 3 (Londo Bell) cards from your trash.
// Exile them. If you do, choose 1 enemy Unit; begin a battle between this Unit and it, only
// performing the damage step (no rest/block/action -- reuses the same damage-exchange rules).
function nuGundam017WhenPaired(state, player, unit, context) {
  const londoBellCards = player.trash.filter((c) => (c.def.traits || []).includes('Londo Bell'));
  if (londoBellCards.length < 3) return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;

  for (const card of londoBellCards.slice(0, 3)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  const target =
    context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(opponent.battleArea) : opponent.battleArea[0];
  resolveUnitBattleDamage(state, player, opponent, unit, target, {});
}

// --- Amuro Ray GD05-085 (Pilot) ----------------------------------------------
// [Burst] Add this card to your hand. [During your turn, when this Unit destroys an enemy Unit
// with battle damage, this Unit recovers 2 HP] (all battles in this engine happen on the active
// player's turn, so no separate turn check is needed here).
function amuroRay085Burst(state, player, instance) {
  player.hand.push(instance);
}
function amuroRay085DestroysEnemy(state, player, unit) {
  recoverHP(unit, 2);
}

// --- Ra Cailum GD05-125 (Base) -----------------------------------------------
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate*Main] Rest this
// Base: choose 1 friendly (Londo Bell) Unit. During this turn, when it receives enemy damage,
// reduce it by 1.
function raCailumBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function raCailumDeploy(state, player) {
  if (player.shields.length === 0) return;
  player.hand.push(player.shields.shift());
}
function raCailumActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const target = context.target;
  if (!target || !(target.def.traits || []).includes('Londo Bell')) return false;
  instance.rested = true;
  target.buffs.push({ damageReduction: 1, scope: 'turn' });
  return true;
}

// --- Corsica Base ST02-016 ----------------------------------------------------
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// deploy 1 [Tallgeese] ((OZ) AP4/HP2) Unit token. If it is your turn and a card with "Corsica Base"
// in its card name is in your trash, deploy 2 [Leo] ((OZ) AP1/HP1) Unit tokens instead.
const TALLGEESE_TOKEN = Object.freeze({
  number: 'TOKEN-TALLGEESE',
  name: 'Tallgeese',
  type: 'unit',
  color: 'blue',
  traits: ['OZ'],
  ap: 4,
  hp: 2,
  isToken: true,
  keywords: {}
});
const LEO_TOKEN = Object.freeze({
  number: 'TOKEN-LEO',
  name: 'Leo',
  type: 'unit',
  color: 'blue',
  traits: ['OZ'],
  ap: 1,
  hp: 1,
  isToken: true,
  keywords: {}
});
function corsicaBaseBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function corsicaBaseDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());

  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  if (!isOwnTurn) return;

  const priorCopyTrashed = player.trash.some((c) => c.def.name === 'Corsica Base');
  if (priorCopyTrashed) {
    deployUnit(state, player, LEO_TOKEN);
    deployUnit(state, player, LEO_TOKEN);
  } else {
    deployUnit(state, player, TALLGEESE_TOKEN);
  }
}

module.exports = {
  guntankDeploy,
  zakuIIAttackBuff,
  charsZakuGD01026Destroyed,
  charsZakuST03006Destroyed,
  charAznableAttack,
  amuroRayBurst,
  amuroRayWhenPaired,
  gundamDuringPairStartOfTurn,
  aShowOfResolveCommand,
  jaburoBurst,
  jaburoDeploy,
  jaburoActivateMain,
  zeongWhenPaired,
  zeongDestroyed,
  kayrasRegzDeploy,
  regzDestroyed,
  gundamAge2Destroyed,
  nuGundam020Deploy,
  nuGundam017WhenPaired,
  amuroRay085Burst,
  amuroRay085DestroysEnemy,
  raCailumBurst,
  raCailumDeploy,
  raCailumActivateMain,
  corsicaBaseBurst,
  corsicaBaseDeploy
};
