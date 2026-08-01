const { dealDamage, getAP, getHP, getRemainingHP, getKeywords, isImmuneToEffectDestroy, recoverHP, removeFromField, destroyCard } = require('../rules/management');
const { deployUnit, deployBase, becomeBase } = require('../rules/actions');
const { drawCard } = require('../rules/phases');
const { resolveUnitBattleDamage, applyBreach } = require('../rules/combat');
const { fireCardEffect } = require('../rules/effects');
const { createInstance, shuffle } = require('../rules/state');
const { EX_RESOURCE_DEF } = require('../rules/setup');
const { canAfford, payCost } = require('../rules/cost');

function opponentOf(state, player) {
  return state.players.find((p) => p !== player);
}

// --- Guntank GD01-008 ---------------------------------------------------
// [Deploy] Choose 1 rested enemy Unit. Deal 1 damage to it.
// (Heuristic default: the lowest-remaining-HP candidate, for the best shot at a kill/chip value.)
function guntankDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
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
// (Heuristic default: the highest-AP eligible candidate -- neutralize the biggest threat.)
function amuroRayBurst(state, player, instance) {
  player.hand.push(instance);
}
function amuroRayWhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 5);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
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
// (Heuristic: only worth burning 3 trashed cards for a favorable/safe kill, same bar as a normal
// attack decision -- picks the best such kill if a hook is given, else finds one unassisted.)
function nuGundam017WhenPaired(state, player, unit, context) {
  const londoBellCards = player.trash.filter((c) => (c.def.traits || []).includes('Londo Bell'));
  if (londoBellCards.length < 3) return;
  const opponent = opponentOf(state, player);

  const unitAP = getAP(unit);
  const isFavorableKill = (u) => unitAP >= getRemainingHP(u) && getAP(u) < getRemainingHP(unit);
  const target =
    context.hooks && context.hooks.chooseUnit
      ? context.hooks.chooseUnit(opponent.battleArea.filter(isFavorableKill))
      : opponent.battleArea.find(isFavorableKill);
  if (!target) return;

  for (const card of londoBellCards.slice(0, 3)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
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

// --- Overflowing Affection GD01-118 (Command) ---
// [Main] Draw 2. Then, discard 1.
function overflowingAffectionCommand(state, player) {
  drawCard(state, player);
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    player.hand.splice(player.hand.indexOf(toDiscard), 1);
    player.trash.push(toDiscard);
  }
}

// --- Aile Strike Gundam ST04-001 ---
// <Blocker> (data). [When Paired][Lv.4 or Higher Pilot] Choose 1 enemy Unit with 4 or less HP.
// Return it to its owner's hand.
function aileStrikeGundamWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || (pilot.def.level || 0) < 4) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target);
  opponent.hand.push(target);
}

// --- Strike Freedom Gundam GD05-002 ---
// [Deploy] Choose 1 to 2 of your Units. During this turn, when they destroy an enemy card with
// battle damage, draw 1. [During Pair][Attack] You may discard 2. If you do, choose 1 enemy Unit
// with the lowest Lv. Return it to the bottom of its owner's deck.
function strikeFreedomDeploy(state, player) {
  const targets = player.battleArea.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const u of targets) u.buffs.push({ onKillDraw: 1, scope: 'turn' });
}
function strikeFreedomAttack(state, player, unit) {
  if (!unit.pilot || player.hand.length < 2) return;
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => (a.def.level || 0) - (b.def.level || 0))[0];
  if (!target) return;
  const discards = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0)).slice(0, 2);
  for (const c of discards) {
    player.hand.splice(player.hand.indexOf(c), 1);
    player.trash.push(c);
  }
  removeFromField(opponent, target);
  opponent.deck.push(target);
}

// --- Kira Yamato ST04-010 (Pilot) ---
// [Burst] Add this card to your hand. [Attack] Choose 1 enemy Unit. It gets AP-2 during this battle.
function kiraYamatoST04010Burst(state, player, instance) {
  player.hand.push(instance);
}
function kiraYamatoST04010Attack(state, player, unit, context) {
  if (!context.target || context.target.type !== 'unit') return;
  context.target.instance.buffs.push({ ap: -2, scope: 'battle' });
}

// --- Kira Yamato GD05-081 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] If this is an (Orb)/(Triple Ship Alliance)
// Unit, draw 1.
function kiraYamatoGD05081Burst(state, player, instance) {
  player.hand.push(instance);
}
function kiraYamatoGD05081WhenLinked(state, player, unit) {
  const traits = unit.def.traits || [];
  if (traits.includes('Orb') || traits.includes('Triple Ship Alliance')) drawCard(state, player);
}

// --- Victory Gundam GD04-003 ---
// [Attack] If you have 3 or more (League Militaire) Units in play, draw 1.
function victoryGundamGD04003Attack(state, player) {
  const count = player.battleArea.filter((u) => (u.def.traits || []).includes('League Militaire')).length;
  if (count >= 3) drawCard(state, player);
}

// --- V-Dash Gundam GD04-006 ---
// <Breach 3> (data). [Activate*Main][Once per Turn] Rest 1 of your other (League Militaire) Units:
// Choose 1 enemy Unit with 4 or less HP. Rest it.
function vDashGundamActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.restEnemy) return false;
  const { restUnit, target } = context;
  if (!restUnit || restUnit.rested || !(restUnit.def.traits || []).includes('League Militaire')) return false;
  if (!target || getRemainingHP(target) > 4) return false;
  restUnit.rested = true;
  target.rested = true;
  instance.activationsUsed.restEnemy = true;
  return true;
}

// --- Üso Ewin GD04-081 (Pilot) & Reineforce Jr. GD04-121 (Base) share the [Parts] token ---
// Üso Ewin: [Burst] Add this card to hand. [When Paired] If this is a (League Militaire) Unit,
// deploy 1 [Parts] token. Reineforce Jr.: [Burst] Deploy this card. [Deploy] Add 1 of your Shields
// to your hand. Then, during your turn, if a friendly (League Militaire) Unit is in play, deploy
// 1 [Parts] token.
const PARTS_TOKEN = Object.freeze({
  number: 'TOKEN-PARTS',
  name: 'Parts',
  type: 'unit',
  color: 'blue',
  traits: ['League Militaire'],
  ap: 1,
  hp: 1,
  isToken: true,
  keywords: {},
  cannotAttackPlayer: true
});
function usoEwinBurst(state, player, instance) {
  player.hand.push(instance);
}
function usoEwinWhenPaired(state, player, unit) {
  if (!(unit.def.traits || []).includes('League Militaire')) return;
  deployUnit(state, player, PARTS_TOKEN);
}
function reineforceJrBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function reineforceJrDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  if (!isOwnTurn) return;
  const hasLeagueMilitaire = player.battleArea.some((u) => (u.def.traits || []).includes('League Militaire'));
  if (hasLeagueMilitaire) deployUnit(state, player, PARTS_TOKEN);
}

// --- Airframe Seizure GD05-111 (Command) ---
// [Main] Discard 1. If you do, draw 2.
function airframeSeizureCommand(state, player) {
  if (player.hand.length === 0) return;
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.hand.splice(player.hand.indexOf(toDiscard), 1);
  player.trash.push(toDiscard);
  drawCard(state, player);
  drawCard(state, player);
}

// --- Darkness Finger GD05-110 (Command, Special Move) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit. Deal 2 damage to it. Then,
// if you have a Unit with "Master Gundam" in its card name in play, draw 1.
function darknessFingerCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
  if (player.battleArea.some((u) => (u.def.name || '').includes('Master Gundam'))) drawCard(state, player);
}
function darknessFingerBurst(state, player, instance) {
  darknessFingerCommand(state, player, instance, {});
}

// --- Gundam Maxter GD05-069 ---
// [Destroyed-on-kill] During your turn, when this Unit destroys an enemy Unit with battle damage,
// look at the top 4 cards of your deck. You may reveal 1 (Special Move) Command card among them
// and add it to your hand. Return the rest randomly to the bottom of your deck. [During Link]
// [Attack] Activate Main on the card paired with this Unit (currently a no-op until a Pilot with
// its own Activate-Main ability exists, since none do yet).
function gundamMaxterDestroysEnemy(state, player) {
  const top4 = player.deck.splice(0, 4);
  const matchIdx = top4.findIndex((c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move'));
  if (matchIdx !== -1) {
    const [chosen] = top4.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top4));
}
function gundamMaxterAttack(state, player, unit) {
  if (!unit.isLinkUnit || !unit.pilot) return;
  const pilotActivateMain = unit.pilot.def.effects && unit.pilot.def.effects.activateMain;
  if (pilotActivateMain) pilotActivateMain(state, player, unit.pilot, {});
}

// --- Rising Gundam GD05-072 ---
// [When Linked] Choose 1 enemy Unit with 4 or less HP. Rest it.
function risingGundamWhenLinked(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.rested = true;
}

// --- Shining Gundam GD05-066 ---
// [Deploy] You may choose 2 (MF) Unit cards from your trash. Exile them. If you do, choose 1
// (Special Move) Command card from your trash. Add it to your hand. [Attack][Once per Turn]
// Choose 1 of your rested Resources. Set it as active.
function shiningGundam066Deploy(state, player, instance) {
  const mfUnits = player.trash.filter((c) => c.def.type === 'unit' && (c.def.traits || []).includes('MF'));
  if (mfUnits.length < 2) return;
  const specialMoveCommand = player.trash.find(
    (c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move')
  );
  if (!specialMoveCommand) return;
  for (const card of mfUnits.slice(0, 2)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  player.trash.splice(player.trash.indexOf(specialMoveCommand), 1);
  player.hand.push(specialMoveCommand);
}
function shiningGundam066Attack(state, player, unit) {
  if (unit.activationsUsed.untapResource) return;
  const restedResource = player.resourceArea.find((r) => r.rested);
  if (!restedResource) return;
  restedResource.rested = false;
  unit.activationsUsed.untapResource = true;
}

// --- Master Gundam GD05-033 ---
// [Attack] You may choose 2 (Special Move) Command cards from your trash. Exile them. If you do,
// deal 5 damage to the first card in your opponent's shield area.
function masterGundamAttack(state, player, unit, context) {
  const specialMoveCards = player.trash.filter(
    (c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move')
  );
  if (specialMoveCards.length < 2) return;
  for (const card of specialMoveCards.slice(0, 2)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  applyBreach(state, opponentOf(state, player), 5, context.hooks || {});
}

// --- Domon Kasshu GD05-097 (Pilot) ---
// [Burst] Add this card to your hand. [When Paired] Draw 1. Then, discard 1. If you discard a
// (Special Move) Command card with this effect, you may activate its Main.
function domonKasshuBurst(state, player, instance) {
  player.hand.push(instance);
}
function domonKasshuWhenPaired(state, player) {
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (!toDiscard) return;
  player.hand.splice(player.hand.indexOf(toDiscard), 1);
  player.trash.push(toDiscard);

  const isSpecialMoveCommand = toDiscard.def.type === 'command' && (toDiscard.def.traits || []).includes('Special Move');
  if (isSpecialMoveCommand && toDiscard.def.effects && toDiscard.def.effects.command) {
    toDiscard.def.effects.command(state, player, toDiscard, {});
  }
}

// --- Victory Gundam GD04-011 ---
// [Destroyed] If another friendly (League Militaire) Unit is in play, deploy 1 [Parts] token
// (shares the same token as Üso Ewin/Reineforce Jr., defined further below).
function victoryGundamGD04011Destroyed(state, player) {
  const hasOtherLeagueMilitaire = player.battleArea.some((u) => (u.def.traits || []).includes('League Militaire'));
  if (!hasOtherLeagueMilitaire) return;
  deployUnit(state, player, PARTS_TOKEN);
}

// --- Unforeseen Incident ST01-014 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit. It gets AP-3 during this turn.
function unforeseenIncidentCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ ap: -3, scope: 'turn' });
}
function unforeseenIncidentBurst(state, player, instance, context) {
  unforeseenIncidentCommand(state, player, instance, context);
}

// --- Master Asia GD05-089 (Pilot) ---
// [Burst] Add this card to your hand. If there are 3+ (MF) cards in your trash, you may deploy it
// as an AP3/HP3 Unit instead (don't treat it as a Pilot). [During Link][Attack] If you have
// activated a (Special Move) Command card's Main/Action this turn, choose 1 enemy Unit, deal 2.
function masterAsiaBurst(state, player, instance) {
  const mfInTrash = player.trash.filter((c) => (c.def.traits || []).includes('MF')).length;
  if (mfInTrash < 3) {
    player.hand.push(instance);
    return;
  }
  instance.def = Object.assign({}, instance.def, { type: 'unit', ap: 3, hp: 3 });
  instance.turnDeployed = state.turnNumber;
  player.battleArea.push(instance);
}
function masterAsiaAttack(state, player, unit, context) {
  if (!unit.isLinkUnit || !player.specialMoveActivatedThisTurn) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 2);
}

// --- Cyclone Punch GD05-121 (Command, Special Move; pairable from trash as a Pilot) ---
// [Main] Choose 1 enemy Unit. It gets AP-2 during this turn. After activating this card's Main,
// you may pair this card from your trash with one of your (MF) Units (the +1/+1 Chibodee Crocket
// pairing itself is handled by the AI's runCommands via the shared `pairPilotFromTrash` helper).
function cyclonePunchCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Shining Finger GD05-120 (Command, Special Move) ---
// [Burst] Add this card to your hand. [Main/Action] Choose 1 enemy Unit with 4 or less HP. Rest it.
// Then, you may choose 1 of your Units with "Shining Gundam" in its card name; it gets First Strike.
function shiningFingerBurst(state, player, instance) {
  player.hand.push(instance);
}
function shiningFingerCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
  const shiningGundam = player.battleArea.find((u) => (u.def.name || '').includes('Shining Gundam'));
  if (shiningGundam) shiningGundam.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- Gundam Fight GD05-128 (Base, Stronghold) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate*Main] Rest this
// Base: if a friendly (MF) Link Unit is in play, choose 1 friendly Unit. It gets AP+2 this turn.
function gundamFightBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function gundamFightDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function gundamFightActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const hasMfLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('MF'));
  if (!hasMfLink) return false;
  const target = context.target;
  if (!target) return false;
  instance.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Gundam Exia Repair GD05-050 ---
// When this Unit deals battle damage to an enemy Unit that is Lv.4 or lower with no paired Pilot,
// destroy that enemy Unit outright (modeled as topping up its damage to lethal, so the engine's
// normal destroy/Breach/destroysEnemy chain still fires exactly as any other kill would).
// [Destroyed] Place the top 2 cards of your deck into your trash.
function gundamExiaRepairDealsBattleDamage(state, player, unit, context) {
  const defender = context.defender;
  if (!defender || defender.pilot) return;
  if ((defender.def.level || 0) > 4) return;
  defender.damage = getHP(defender);
}
function gundamExiaRepairDestroyed(state, player) {
  player.trash.push(...player.deck.splice(0, 2));
}

// --- Gundam Barbatos 1st Form GD02-054 ---
// [Attack] If this Unit is damaged, draw 1.
function gundamBarbatos1stFormAttack(state, player, unit) {
  if (unit.damage > 0) drawCard(state, player);
}

// --- Gundam Barbatos Adapt GD03-056 (Deploy) & Mikazuki Augus ST05-010 (When Paired) share text ---
// Choose 1 of your Units and 1 enemy Unit. Deal 1 damage to them.
function gundamBarbatosAdaptDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const friendlyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  const enemyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (friendlyTarget) dealDamage(friendlyTarget, 1);
  if (enemyTarget) dealDamage(enemyTarget, 1);
}
function mikazukiAugusBurst(state, player, instance) {
  player.hand.push(instance);
}
function mikazukiAugusWhenPaired(state, player, unit, context) {
  gundamBarbatosAdaptDeploy(state, player, unit, context);
}

// --- Widespread Annihilation GD05-114 (Command) ---
// [Main] Destroy all Units that are Lv.4 or lower (both players' -- an outright destroy regardless
// of remaining HP, so it can't reuse the HP-check-gated combat destroy helper; still fires each
// Unit's own Destroyed trigger, same as any other kill).
function widespreadAnnihilationCommand(state, player) {
  for (const p of state.players) {
    const toDestroy = p.battleArea.filter(
      (u) => (u.def.level || 0) <= 4 && !(p !== player && isImmuneToEffectDestroy(u))
    );
    for (const unit of toDestroy) {
      const wasPaired = !!unit.pilot;
      destroyCard(state, p, unit);
      fireCardEffect(state, p, unit, 'destroyed', { wasPaired });
    }
  }
}

// --- Sword Strike Gundam GD01-073 ---
// [During Link][Attack] Choose 1 enemy Unit with 2 or less HP. Return it to its owner's hand.
// (No link condition is legible on this print's scan, so it stays a plain vanilla body unless/until
// some other effect grants it Link status -- flagged as a research gap, not guessed at.)
function swordStrikeGundamAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target);
  opponent.hand.push(target);
}

// --- Underground Desert Base GD01-126 & Mining Asteroid Palau GD01-128 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. (Shared with several other
// simple Stronghold Bases already in the DB -- kept as its own pair of one-liners here to match the
// existing per-card convention rather than retrofitting the older cards onto a shared name.)
function simpleBurstBase(state, player, instance) {
  becomeBase(state, player, instance);
}
function simpleBaseDeployAddShield(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}

// --- Gundam Gusion Rebake GD02-055 ---
// <Blocker> (data). [Deploy] Choose 1 of your Units and 1 enemy Unit. Deal 1 damage to them
// (identical text to Gundam Barbatos Adapt's Deploy, defined above -- reused directly).

// --- Gun EZ GD04-015 ---
// [Deploy] Choose 1 of your active (League Militaire) Units and 1 enemy Unit that is Lv.3 or lower.
// Rest them.
function gunEZDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const friendlyCandidates = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('League Militaire'));
  const friendlyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(friendlyCandidates)
    : friendlyCandidates.sort((a, b) => getAP(a) - getAP(b))[0];
  const enemyCandidates = opponent.battleArea.filter((u) => !u.rested && (u.def.level || 0) <= 3);
  const enemyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(enemyCandidates)
    : enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!friendlyTarget || !enemyTarget) return;
  friendlyTarget.rested = true;
  enemyTarget.rested = true;
}

// --- V2 Gundam GD05-001 ---
// <Repair 2> (data). [Activate*Main][Once per Turn] Rest 2 of your Units: set this Unit as active.
// (Engine-correct, but not yet wired into the AI's runActivations -- resting 2 other Units to untap
// this one is rarely worth it under the current heuristic and needs real judgement to use well;
// flagged rather than guessed at with a shallow always-fire rule.)
function v2GundamActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.setActive) return false;
  const { restUnits } = context;
  if (!restUnits || restUnits.length < 2) return false;
  const valid = restUnits.every((u) => u !== instance && !u.rested && player.battleArea.includes(u));
  if (!valid) return false;
  for (const u of restUnits) u.rested = true;
  instance.rested = false;
  instance.activationsUsed.setActive = true;
  return true;
}

// --- Graceful Demeanor GD04-117 (Command) ---
// [Burst] Activate this card's Action. [Action] Choose 1 to 2 enemy Units that are Lv.3 or lower.
// Return them to their owners' hands.
function gracefulDemeanorCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) {
    removeFromField(opponent, t);
    opponent.hand.push(t);
  }
}
function gracefulDemeanorBurst(state, player, instance, context) {
  gracefulDemeanorCommand(state, player, instance, context);
}

// --- Rick Dias GD02-079 ---
// <Blocker> (data). No other printed ability.

// --- Silver Bullet GD04-068 ---
// <Blocker> (data). When this Unit receives effect damage from an enemy, reduce it by 3 (a
// permanent, un-scoped buff -- see `effectDamageReduction` in dealDamage).
function silverBulletDeploy(state, player, instance) {
  instance.buffs.push({ effectDamageReduction: 3 });
}

// --- Freedom Gundam ST09-004 ---
// <Blocker> (data). While a friendly Base is in play, this Unit gains <Suppression>. Re-evaluated
// at the start of every turn (a turn-granularity approximation of an otherwise fully dynamic
// board-state check, matching how <During Pair> keyword grants are already handled elsewhere).
function freedomGundamStartOfTurn(state, player, instance) {
  instance.grantedKeywords.suppression = !!player.base;
}

// --- Striker Pack ST04-012 (Command) ---
// [Burst] If you have no (Earth Alliance) Unit tokens in play, deploy 1 [Aile Strike Gundam]
// ((Earth Alliance)AP3HP3Blocker) Unit token. [Main] If you have no (Earth Alliance) Unit tokens in
// play, deploy 1 [Sword Strike Gundam] (AP4HP2Blocker) or 1 [Launcher Strike Gundam] (AP2HP4Blocker)
// Unit token.
const AILE_STRIKE_TOKEN = Object.freeze({
  number: 'TOKEN-AILE-STRIKE', name: 'Aile Strike Gundam', type: 'unit', color: 'white',
  traits: ['Earth Alliance'], ap: 3, hp: 3, isToken: true, keywords: { blocker: true }
});
const SWORD_STRIKE_TOKEN = Object.freeze({
  number: 'TOKEN-SWORD-STRIKE', name: 'Sword Strike Gundam', type: 'unit', color: 'white',
  traits: ['Earth Alliance'], ap: 4, hp: 2, isToken: true, keywords: { blocker: true }
});
const LAUNCHER_STRIKE_TOKEN = Object.freeze({
  number: 'TOKEN-LAUNCHER-STRIKE', name: 'Launcher Strike Gundam', type: 'unit', color: 'white',
  traits: ['Earth Alliance'], ap: 2, hp: 4, isToken: true, keywords: { blocker: true }
});
function hasEarthAllianceToken(player) {
  return player.battleArea.some((u) => u.def.isToken && (u.def.traits || []).includes('Earth Alliance'));
}
function strikerPackBurst(state, player) {
  if (hasEarthAllianceToken(player)) return;
  deployUnit(state, player, AILE_STRIKE_TOKEN);
}
function strikerPackCommand(state, player, instance, context) {
  if (hasEarthAllianceToken(player)) return;
  const choice = context.hooks && context.hooks.chooseToken
    ? context.hooks.chooseToken([SWORD_STRIKE_TOKEN, LAUNCHER_STRIKE_TOKEN])
    : SWORD_STRIKE_TOKEN;
  deployUnit(state, player, choice);
}

// --- Archangel ST04-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (both shared with
// simpleBurstBase/simpleBaseDeployAddShield). [Activate*Main][Once per Turn] 2: Choose 1 friendly
// Unit with <Blocker>. Set it as active. It can't attack during this turn. (Engine-correct, but
// not wired into the AI's runActivations -- spending 2 resources to untap a Blocker mid-turn needs
// real judgement about the board state, same reasoning as V2 Gundam's setActive ability above.)
function archangelActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.setActive) return false;
  const activeMatching = player.resourceArea.filter((r) => !r.rested);
  if (activeMatching.length < 2) return false;
  const target = context.target;
  if (!target || !getKeywords(target).blocker) return false;
  activeMatching[0].rested = true;
  activeMatching[1].rested = true;
  target.rested = false;
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
  instance.activationsUsed.setActive = true;
  return true;
}

// --- Gundam NT-1 GD03-001 ---
// <Repair 2> (data). [When Paired] Choose 1 rested enemy Unit. Deal 1 damage to it. When this
// effect destroys an enemy Unit, draw 1.
function gundamNT1WhenPaired(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
  if (getRemainingHP(target) <= 0 && !isImmuneToEffectDestroy(target)) {
    const wasPaired = !!target.pilot;
    destroyCard(state, opponent, target);
    fireCardEffect(state, opponent, target, 'destroyed', { wasPaired });
    drawCard(state, player);
  }
}

// --- Penelope (Flight Form) GD04-002 ---
// [Static] During your turn, all your (Earth Federation) Units get AP+1 (same turn-refreshed
// pattern as Gundam ST01-001's During-Pair aura above, trait-filtered instead of paired-gated).
// [Deploy] During this turn, when one of your (Earth Federation) Units destroys an enemy Unit with
// battle damage, choose 1 enemy Unit with 5 or less HP and rest it. The grant lives as a turn-scoped
// buff on Penelope's own instance (a "team trait" trigger, `teamOnKillRestEnemy: <trait>`) rather
// than being stamped onto every current Unit, so it still covers Units deployed later the same turn
// -- combat.js's fireDestroysEnemy checks for it generically.
function penelopeFlightFormStartOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  for (const u of player.battleArea) {
    if ((u.def.traits || []).includes('Earth Federation')) u.buffs.push({ ap: 1, scope: 'turn' });
  }
}
function penelopeFlightFormDeploy(state, player, instance) {
  instance.buffs.push({ teamOnKillRestEnemy: 'Earth Federation', scope: 'turn' });
}

// --- Shining Gundam (Super Mode) GD05-068 ---
// If you've activated a (Special Move) Command's Main/Action this turn, this Unit gains
// <Suppression> during this turn -- checked when it attacks, since that's the only point
// Suppression is ever observable, so this reuses the existing specialMoveActivatedThisTurn flag
// rather than building a full broadcast trigger for a single card. [During Link][Attack] AP+2
// during this battle.
function shiningGundamSuperModeAttack(state, player, unit) {
  if (player.specialMoveActivatedThisTurn) unit.buffs.push({ keyword: 'suppression', scope: 'turn' });
  if (unit.isLinkUnit) unit.buffs.push({ ap: 2, scope: 'battle' });
}

// --- Sazabi GD05-049 ---
// <Suppression> (data). [Attack] You may choose 1 of your Units. Destroy it. If you do, your
// opponent chooses 1 of their non-battling Units and destroys it. (Heuristic default: only worth
// it when your weakest spare Unit is a worse loss than the opponent's biggest non-battling threat.)
function sazabiAttack(state, player, unit, context) {
  const ownCandidates = player.battleArea.filter((u) => u !== unit);
  if (ownCandidates.length === 0) return;
  const opponent = opponentOf(state, player);
  const targetInstance = context.target && context.target.type === 'unit' ? context.target.instance : null;
  const enemyCandidates = opponent.battleArea.filter((u) => u !== targetInstance && !isImmuneToEffectDestroy(u));
  if (enemyCandidates.length === 0) return;

  const toSacrifice = [...ownCandidates].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  const enemyTarget = [...enemyCandidates].sort((a, b) => getAP(b) - getAP(a))[0];
  if (getAP(toSacrifice) + getRemainingHP(toSacrifice) >= getAP(enemyTarget) + getRemainingHP(enemyTarget)) return;

  destroyCard(state, player, toSacrifice);
  fireCardEffect(state, player, toSacrifice, 'destroyed', { wasPaired: !!toSacrifice.pilot });
  if ((unit.def.traits || []).includes('Neo Zeon')) player.neoZeonSelfDestroyThisTurn = true; // Axis GD05-129's Activate*Main condition
  destroyCard(state, opponent, enemyTarget);
  fireCardEffect(state, opponent, enemyTarget, 'destroyed', { wasPaired: !!enemyTarget.pilot });
}

// --- Char Aznable GD05-093 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] You may choose 1 (Neo Zeon) Base card from
// your trash. Deploy it.
function charAznableGD05093Burst(state, player, instance) {
  player.hand.push(instance);
}
function charAznableGD05093WhenLinked(state, player, unit, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'base' && (c.def.traits || []).includes('Neo Zeon'));
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  becomeBase(state, player, chosen);
}

// --- Ryusei-Go (Graze Custom II) GD02-058 ---
// [Deploy] Choose 1 of your Units. Deal 1 damage to it. If you do, draw 1. Then, discard 1.
function ryuseiGoDeploy(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  if (!target) return;
  dealDamage(target, 1);
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    player.hand.splice(player.hand.indexOf(toDiscard), 1);
    player.trash.push(toDiscard);
  }
}

// --- Gundam Barbatos Lupus GD03-050 ---
// [Activate*Main] Choose 3 (Tekkadan)/(Teiwaz) Unit cards from your trash. Exile them. If you do,
// choose 1 enemy Unit. Deal 2 damage to it. (Not once-per-turn per the card's own text, but not
// wired into the AI's runActivations -- permanently exiling 3 trash Units is a real cost that needs
// judgement, same reasoning as V2 Gundam/Gundam Barbatos Lupus-style abilities above.)
function gundamBarbatosLupusActivateMain(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Tekkadan') || (c.def.traits || []).includes('Teiwaz'))
  );
  if (candidates.length < 3) return false;
  const opponent = opponentOf(state, player);
  const target = context.target || (opponent.battleArea.length
    ? [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0]
    : null);
  if (!target) return false;
  for (const c of candidates.slice(0, 3)) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.removal.push(c);
  }
  dealDamage(target, 2);
  return true;
}

// --- Kshatriya GD01-044 ---
// [When Paired] (Cyber-Newtype)/(Newtype) Pilot: Choose 1 to 2 enemy Units. Deal 1 damage to them.
function kshatriyaWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  const traits = pilot ? pilot.def.traits || [] : [];
  if (!traits.includes('Cyber-Newtype') && !traits.includes('Newtype')) return;
  const opponent = opponentOf(state, player);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b)).slice(0, 2);
  for (const t of targets) dealDamage(t, 1);
}

// --- Unicorn Gundam 02 Banshee (Destroy Mode) GD01-003 ---
// Link Condition [Christina Mackenzie]/[Amuro Ray]. [During Link][Attack] Choose 12 cards from your
// trash. Return them to your deck and shuffle it. If you do, set this Unit as active. It gains
// <First Strike> during this turn.
function unicornBansheeDestroyModeAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  if (player.trash.length < 12) return;
  const chosen = context.hooks && context.hooks.chooseCards
    ? context.hooks.chooseCards(player.trash, 12)
    : player.trash.slice(0, 12);
  for (const c of chosen) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.deck.push(c);
  }
  shuffle(player.deck);
  unit.rested = false;
  unit.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- Marida Cruz GD01-093 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Attack] Choose 1 enemy Unit whose Lv. is equal
// to or lower than this Unit's Lv. Deal 1 damage to it.
function maridaCruzBurst(state, player, instance) {
  player.hand.push(instance);
}
function maridaCruzAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const level = unit.def.level || 0;
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= level);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 1);
}

// --- Close Combat ST03-013 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit. Deal 2 damage to it.
function closeCombatCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
}
function closeCombatBurst(state, player, instance, context) {
  closeCombatCommand(state, player, instance, context);
}

// --- Wing Gundam ST02-001 ---
// <Breach 5> (data). This Unit may choose an active enemy Unit that is Lv.4 or lower as its attack
// target (see `activeTargetLevelCap` in its card data, read by the AI's `chooseAttackTarget`
// instead of a dedicated effect function -- there's no separate "declare attack" hook to attach to).

// --- Wing Gundam (Bird Mode) ST02-002 ---
// [Deploy] Place 1 EX Resource (same one-liner as Nu Gundam GD05-020's Deploy, just unconditional).
function wingGundamBirdModeDeploy(state, player) {
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));
}

// --- Wing Gundam Zero GD01-024 ---
// <High-Maneuver> (data). [Deploy] Deal 3 damage to all Units that are Lv.5 or lower (both players').
function wingGundamZeroGD01024Deploy(state, player) {
  for (const p of [player, opponentOf(state, player)]) {
    for (const u of p.battleArea) {
      if ((u.def.level || 0) <= 5) dealDamage(u, 3);
    }
  }
}

// --- Wing Gundam Zero (EW) GD05-067 ---
// While a rested enemy Unit is in play, this Unit gains <Suppression> (re-evaluated each start of
// turn, the same turn-granularity approximation as Freedom Gundam ST09-004's Base-gated version).
// [Attack] Choose 1 enemy Unit. Rest it.
function wingGundamZeroEWStartOfTurn(state, player, instance) {
  const opponent = opponentOf(state, player);
  instance.grantedKeywords.suppression = opponent.battleArea.some((u) => u.rested);
}
function wingGundamZeroEWAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Heero Yuy GD05-098 (Pilot) ---
// [Burst] Add this card to your hand. [When this Unit destroys an enemy shield area card with
// damage, choose 1 enemy Unit. It gets AP-2 during this turn.]
function heeroYuy098Burst(state, player, instance) {
  player.hand.push(instance);
}
function heeroYuy098DestroysShield(state, player, unit) {
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Heero Yuy ST02-010 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] This Unit gets AP+1 and HP+1 (see
// `duringLinkAp`/`duringLinkHp` on its card data -- getAP/getHP already read those off a Pilot,
// same fields a Unit's own card data can carry).
function heeroYuy010Burst(state, player, instance) {
  player.hand.push(instance);
}

// --- Naval Bombardment GD01-120 (Command) ---
// [Burst] Choose 1 enemy Unit. It gets AP-3 during this turn. [Action] Choose 1 friendly Unit with
// <Blocker>. It gets AP+3 during this turn. (Two genuinely different abilities on one card, unlike
// the usual "Burst just activates Main" shorthand used elsewhere.)
function navalBombardmentBurst(state, player) {
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -3, scope: 'turn' });
}
function navalBombardmentCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => getKeywords(u).blocker);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- Peacemillion GD03-125 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Once per Turn] During your turn, when a friendly (Operation Meteor)/(G Team) Unit that is Lv.6
// or higher destroys an enemy Unit with battle damage, that friendly Unit may recover 2 HP. (Reacts
// to ANY qualifying friendly Unit's kill, not just its own -- combat.js's fireDestroysEnemy
// broadcasts a `friendlyUnitDestroysEnemy` event to the attacking player's whole field for exactly
// this kind of Base-wide reactive text.)
function peacemillionBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function peacemillionDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
}
function peacemillionFriendlyUnitDestroysEnemy(state, player, instance, context) {
  if (instance.activationsUsed.recoverOnKill) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const attacker = context.attacker;
  const traits = attacker.def.traits || [];
  if ((attacker.def.level || 0) < 6) return;
  if (!traits.includes('Operation Meteor') && !traits.includes('G Team')) return;
  recoverHP(attacker, 2);
  instance.activationsUsed.recoverOnKill = true;
}

// --- Kindhearted GD04-101 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] During this turn, friendly Units can't be
// destroyed by enemy effects. Then, draw 1. (New `effectDestroyImmune` turn-buff, checked at the
// handful of spots where an effect destroys an opponent's Unit outright: Widespread Annihilation's
// board wipe, Gundam NT-1's When-Paired kill, and Sazabi's Attack sacrifice.)
function kindheartedCommand(state, player) {
  for (const u of player.battleArea) u.buffs.push({ effectDestroyImmune: true, scope: 'turn' });
  drawCard(state, player);
}
function kindheartedBurst(state, player) {
  kindheartedCommand(state, player);
}

// --- M1 Astray Shrike GD05-015 ---
// [Deploy] Choose 1 rested enemy Unit. Deal 1 damage to it.
function m1AstrayShrikeDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
}

// --- Isaribi ST05-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Activate*Main] Rest this Base: Choose 1 of your damaged Units. It gets AP+2 during this turn.
function isaribiBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function isaribiDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
}
function isaribiActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const damaged = player.battleArea.filter((u) => u.damage > 0);
  if (damaged.length === 0) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(damaged)
    : damaged.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  instance.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Haow Gundam GD05-036 ---
// Link Condition [Master Asia]. [When Paired] You may choose 1 of your other active (MF) Units.
// Rest it. If you do, deal 2 damage to all enemy Units whose Lv. is equal to or lower than that
// Unit's Lv.
function haowGundamWhenPaired(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => u !== unit && !u.rested && (u.def.traits || []).includes('MF'));
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!chosen) return;
  chosen.rested = true;
  const level = chosen.def.level || 0;
  const opponent = opponentOf(state, player);
  for (const u of opponent.battleArea) {
    if ((u.def.level || 0) <= level) dealDamage(u, 2);
  }
}

// --- White Base ST01-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Activate*Main][Once per Turn] 2: Deploy 1 [Gundam] Unit token if you have no Units in play,
// deploy 1 [Guncannon] token if you have only 1 Unit in play, or deploy 1 [Guntank] token if you
// have 2 or more (all (White Base Team)). Engine-correct but not wired into the AI's
// runActivations -- spending 2 real resources needs judgement the heuristic doesn't have yet,
// same reasoning as Archangel/V2 Gundam's Activate*Main abilities above.
const WHITE_BASE_GUNDAM_TOKEN = Object.freeze({
  number: 'TOKEN-WB-GUNDAM', name: 'Gundam', type: 'unit', color: 'blue',
  traits: ['White Base Team'], ap: 3, hp: 3, isToken: true
});
const WHITE_BASE_GUNCANNON_TOKEN = Object.freeze({
  number: 'TOKEN-WB-GUNCANNON', name: 'Guncannon', type: 'unit', color: 'blue',
  traits: ['White Base Team'], ap: 2, hp: 2, isToken: true
});
const WHITE_BASE_GUNTANK_TOKEN = Object.freeze({
  number: 'TOKEN-WB-GUNTANK', name: 'Guntank', type: 'unit', color: 'blue',
  traits: ['White Base Team'], ap: 1, hp: 1, isToken: true
});
function whiteBaseActivateMain(state, player, instance) {
  if (instance.activationsUsed.deployToken) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 2) return false;
  activeResources[0].rested = true;
  activeResources[1].rested = true;
  instance.activationsUsed.deployToken = true;
  const unitCount = player.battleArea.length;
  const token = unitCount === 0 ? WHITE_BASE_GUNDAM_TOKEN : unitCount === 1 ? WHITE_BASE_GUNCANNON_TOKEN : WHITE_BASE_GUNTANK_TOKEN;
  deployUnit(state, player, token);
  return true;
}

// --- Battle of Aces GD01-111 (Command) ---
// [Burst] Choose 1 enemy Unit. Deal 2 damage to it. [Main/Action] Choose 1 damaged enemy Unit.
// Deal 3 damage to it.
function battleOfAcesBurst(state, player) {
  const target = opponentOf(state, player).battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 2);
}
function battleOfAcesCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.damage > 0);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}

// --- Improved Technique GD03-109 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit that is Lv.4 or lower. Deal
// 3 damage to it. If there are 2 or more cards with "Improved Technique" in their card name in your
// trash, choose 1 enemy Unit instead (no level restriction).
function improvedTechniqueCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const copiesInTrash = player.trash.filter((c) => (c.def.name || '').includes('Improved Technique')).length;
  const candidates = copiesInTrash >= 2
    ? opponent.battleArea
    : opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}
function improvedTechniqueBurst(state, player) {
  improvedTechniqueCommand(state, player, null, {});
}

// --- Rewloola ST03-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 enemy Unit
// with 5 or less AP. Deal 1 damage to it.
function rewloolaDeploy(state, player, instance, context) {
  simpleBaseDeployAddShield(state, player);
  const candidates = opponentOf(state, player).battleArea.filter((u) => getAP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 1);
}

// --- Axis GD05-129 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Activate*Main] Rest this Base: If one of your Units has been destroyed by one of your (Neo
// Zeon) card's effects during this turn, deploy 1 (Neo Zeon) Unit card that is Lv.3 or lower from
// your hand. Gated on the new `player.neoZeonSelfDestroyThisTurn` flag (reset each start phase,
// same convention as the pre-existing `specialMoveActivatedThisTurn`), set wherever a friendly Neo
// Zeon card's own effect destroys a friendly Unit -- currently just Sazabi's Attack sacrifice, the
// only such interaction that exists in the DB so far.
function axisActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  if (!player.neoZeonSelfDestroyThisTurn) return false;
  const candidates = player.hand.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Neo Zeon') && (c.def.level || 0) <= 3
  );
  const choice = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!choice) return false;
  instance.rested = true;
  player.hand.splice(player.hand.indexOf(choice), 1);
  deployUnit(state, player, choice.def);
  return true;
}

// --- Waldfeld's Murasame GD05-003 ---
// Link Condition [Andrew Waldfeld]. [Destroyed] If you have an (Orb) Pilot in play, draw 1.
function waldfeldsMurasameDestroyed(state, player) {
  const hasOrbPilot = player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes('Orb'));
  if (hasOrbPilot) drawCard(state, player);
}

// --- Hashmal GD05-006 ---
// [Once per Turn] During your turn, when this Unit destroys an enemy card with battle damage,
// deploy 1 [Pluma] ((Calamity War) AP2/HP1) Unit token. This Unit gains the same number of
// <Repair 1> as the number of (Calamity War) Unit tokens in play (implemented as a `repair` buff,
// a one-line generalization to `applyRepairAtEndOfTurn` mirroring the existing ap/hp buff pattern).
const PLUMA_TOKEN = Object.freeze({
  number: 'TOKEN-PLUMA', name: 'Pluma', type: 'unit', color: 'blue', traits: ['Calamity War'], ap: 2, hp: 1, isToken: true
});
function hashmalDestroysEnemy(state, player, instance) {
  if (!instance.activationsUsed.deployPluma) {
    deployUnit(state, player, PLUMA_TOKEN);
    instance.activationsUsed.deployPluma = true;
  }
  const tokenCount = player.battleArea.filter((u) => u.def.isToken && (u.def.traits || []).includes('Calamity War')).length;
  instance.buffs = instance.buffs.filter((b) => !b.hashmalRepair);
  instance.buffs.push({ repair: tokenCount, hashmalRepair: true });
}

// --- Andrew Waldfeld GD05-082 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] This Unit gains <Repair 2> (data field
// `duringLinkRepair`, read by `applyRepairAtEndOfTurn` -- mirrors the pilot-side
// duringLinkAp/duringLinkHp pattern from Heero Yuy ST02-010).
function andrewWaldfeldBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Rouei GD03-067 ---
// [Deploy] You may choose 1 of your Units. Deal 1 damage to it. It gets AP+1 during this turn.
function roueiDeploy(state, player, instance, context) {
  if (player.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  dealDamage(target, 1);
  target.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Gundam Flauros (Ryusei-Go) GD05-060 ---
// [Deploy][Attack] Choose 1 enemy Unit that is Lv.2 or lower. Destroy it.
function gundamFlaurosRyuseiGoDestroy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  const wasPaired = !!target.pilot;
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', { wasPaired });
}

// --- Akihiro Altland ST05-011 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] During your turn, when this Unit destroys an
// enemy Unit with battle damage, choose 1 (Tekkadan) Unit card that is Lv.2 or lower from your
// trash. Add it to your hand.
function akihiroAltlandDestroysEnemy(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Tekkadan') && (c.def.level || 0) <= 2
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- Shenlong Gundam GD01-029 ---
// <Breach 4> (data). [Attack] Choose 1 enemy Unit with <Blocker> that is Lv.3 or lower. Destroy it.
function shenlongGundamAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter(
    (u) => getKeywords(u).blocker && (u.def.level || 0) <= 3 && !isImmuneToEffectDestroy(u)
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  const wasPaired = !!target.pilot;
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', { wasPaired });
}

// --- Altron Gundam GD03-018 ---
// <Breach 5> (data). [Attack] Choose 1 enemy Unit with <Blocker>. Deal 5 damage to it.
function altronGundamAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getKeywords(u).blocker);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 5);
}

// --- Riddhe Marcenas GD04-098 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] When this Unit receives effect damage from an
// enemy, reduce it by 2 (new pilot-side `duringLinkEffectDamageReduction` field, checked directly
// in `dealDamage` alongside the existing permanent `effectDamageReduction` buff category).
function riddheMarcenasBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Unicorn Gundam 02 Banshee Norn (Destroy Mode) GD04-065 ---
// Link Condition [Riddhe Marcenas]. [During Link][Activate*Main] Exile 3 blue cards from your
// trash: set this Unit as active. It can't choose the enemy player as its attack target during
// this turn. Engine-correct but not wired into the AI's runActivations -- spending a real trash
// cost needs judgement the heuristic doesn't have, same reasoning as Archangel/White Base above.
// [Attack] All enemy Units get AP-1 during this turn.
function unicornBansheeNormActivateMain(state, player, instance) {
  if (!instance.isLinkUnit || !instance.rested) return false;
  const blueCards = player.trash.filter((c) => c.def.color === 'blue').slice(0, 3);
  if (blueCards.length < 3) return false;
  for (const c of blueCards) player.trash.splice(player.trash.indexOf(c), 1);
  instance.rested = false;
  instance.buffs.push({ cannotAttackPlayer: true, scope: 'turn' });
  return true;
}
function unicornBansheeNormAttack(state, player) {
  for (const u of opponentOf(state, player).battleArea) u.buffs.push({ ap: -1, scope: 'turn' });
}

// --- Presidential Office GD05-130 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Destroyed] You may exile this card from your trash. If you do, deploy 1 Base card with
// "Presidential Office" in its card name from your hand.
function presidentialOfficeDestroyed(state, player, instance) {
  const idx = player.trash.indexOf(instance);
  if (idx === -1) return;
  const replacement = player.hand.find(
    (c) => c.def.type === 'base' && (c.def.name || '').includes('Presidential Office')
  );
  if (!replacement) return;
  player.trash.splice(idx, 1);
  player.hand.splice(player.hand.indexOf(replacement), 1);
  deployBase(state, player, replacement.def);
}

// --- Argama GD02-129 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. This Base can't receive
// enemy effect damage (a permanent, un-scoped `effectDamageReduction: Infinity` buff -- same
// mechanism as Silver Bullet's Reduce 3, just uncapped).
function argamaDeploy(state, player, instance) {
  simpleBaseDeployAddShield(state, player);
  instance.buffs.push({ effectDamageReduction: Infinity });
}

// --- Hoka Kyoten Juzetsujin GD05-112 (Command, Special Move; pairable from trash as a Pilot) ---
// [Main] Choose 1 of your (MF) Units without <Breach>. It gains <Breach 3> during this turn.
function hokaKyotenJuzetsujinCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('MF') && !getKeywords(u).breach
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates[0];
  if (target) target.buffs.push({ breach: 3, scope: 'turn' });
}

// --- Graviton Hammer GD05-122 (Command, Special Move; pairable from trash as a Pilot) ---
// [Main] Choose 1 enemy Unit that is Lv.4 or lower. Rest it.
function gravitonHammerCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Dragon Gundam GD05-035 ---
// Link Condition [Sai Saici]. [Once per Turn] When this Unit destroys an enemy shield-area card
// with damage, choose 1 enemy Unit with 3 or less AP. Deal 2 damage to it.
function dragonGundamDestroysShield(state, player, instance, context) {
  if (instance.activationsUsed.dragonShieldTrigger) return;
  instance.activationsUsed.dragonShieldTrigger = true;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 2);
}

// --- Aegis Gundam ST04-006 ---
// [Attack] If this Unit has 5 or more AP, choose 1 enemy Unit that is Lv.5 or higher. Deal 3 damage to it.
function aegisGundamAttack(state, player, instance, context) {
  if (getAP(instance) < 5) return;
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) >= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}

// --- GFreD GD03-035 ---
// [Activate*Main][Once per Turn] 1, exile 1 Pilot card from your trash: Deal 1 damage to all enemy
// Units. (Engine-correct, not wired into runActivations -- exiling a specific trashed Pilot is a
// real resource cost needing judgement, same reasoning as Archangel/V2 Gundam above.)
// [When Linked] During this turn, this Unit may choose an active enemy Unit with AP equal to or
// less than this Unit as its attack target.
function gfredActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.trashDamage) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const pilotCard = context.exilePilot;
  if (!pilotCard || pilotCard.def.type !== 'pilot' || !player.trash.includes(pilotCard)) return false;
  activeResources[0].rested = true;
  player.trash.splice(player.trash.indexOf(pilotCard), 1);
  for (const u of opponentOf(state, player).battleArea) dealDamage(u, 1);
  instance.activationsUsed.trashDamage = true;
  return true;
}
function gfredWhenLinked(state, player, unit) {
  unit.buffs.push({ activeTargetAPCap: true, scope: 'turn' });
}

// --- Justice Gundam GD01-066 ---
// [Deploy] Deploy 1 [Fatum-00] ((Triple Ship Alliance)*AP2*HP2*<Blocker>) Unit token.
// [During Pair][Attack] Choose 1 of your (Triple Ship Alliance) Unit tokens; it may attack on the
// turn it is deployed.
const FATUM00_TOKEN = Object.freeze({
  number: 'TOKEN-FATUM00', name: 'Fatum-00', type: 'unit', color: 'white',
  traits: ['Triple Ship Alliance'], ap: 2, hp: 2, isToken: true, keywords: { blocker: true }
});
function justiceGundamDeploy(state, player) {
  deployUnit(state, player, FATUM00_TOKEN);
}
function justiceGundamAttack(state, player, instance, context) {
  if (!instance.pilot) return;
  const candidates = player.battleArea.filter(
    (u) => u.def.isToken && (u.def.traits || []).includes('Triple Ship Alliance') && u.turnDeployed === state.turnNumber
  );
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.buffs.push({ canAttackOnDeployTurn: true, scope: 'turn' });
}

// --- GQuuuuuuX (Omega Psycommu) GD03-034 ---
// <Suppression> (data). [Deploy] Choose 1 enemy Unit. Deal 3 damage to it.
function gquuuuuuxOmegaPsycommuDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}

// --- Athrun Zala ST04-011 ---
// [Burst] Add this card to your hand. [When Linked] During this turn, this Unit may choose an
// active enemy Unit that is Lv.5 or lower as its attack target.
function athrunZalaST04011Burst(state, player, instance) {
  player.hand.push(instance);
}
function athrunZalaST04011WhenLinked(state, player, unit) {
  unit.buffs.push({ activeTargetLevelCap: 5, scope: 'turn' });
}

// --- Nyaan GD03-092 ---
// [Burst] Add this card to your hand. [When Linked] Place the top card of your deck into your
// trash. If you placed a (Zeon)/(Clan) card with this effect, choose 1 enemy Unit. Deal 1 damage to it.
function nyaanBurst(state, player, instance) {
  player.hand.push(instance);
}
function nyaanWhenLinked(state, player, unit, context) {
  if (player.deck.length === 0) return;
  const milled = player.deck.shift();
  player.trash.push(milled);
  const traits = milled.def.traits || [];
  if (!traits.includes('Zeon') && !traits.includes('Clan')) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 1);
}

// --- Chang Wufei GD01-091 ---
// [Burst] Add this card to your hand.
function changWufeiBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Hy-Gogg GD03-024 ---
// [When Linked] If you have another (Cyclops Team) Unit in play, deploy 1 rested [Hy-Gogg]
// ((Cyclops Team)*AP2*HP1) Unit token.
const HYGOGG_TOKEN = Object.freeze({
  number: 'TOKEN-HYGOGG', name: 'Hy-Gogg', type: 'unit', color: 'green',
  traits: ['Cyclops Team'], ap: 2, hp: 1, isToken: true
});
function hyGoggWhenLinked(state, player, unit) {
  const hasOtherCyclops = player.battleArea.some((u) => u !== unit && (u.def.traits || []).includes('Cyclops Team'));
  if (!hasOtherCyclops) return;
  const token = deployUnit(state, player, HYGOGG_TOKEN);
  token.rested = true;
}

// --- Kämpfer GD03-017 ---
// [Burst] Choose 1 (Cyclops Team) Pilot card from your trash. Add it to your hand.
// [When Paired]*(Cyclops Team) Pilot] All your (Cyclops Team) Units may choose an active enemy
// Unit with 5 or less AP as their attack target during this turn.
function kampferBurst(state, player, instance, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'pilot' && (c.def.traits || []).includes('Cyclops Team'));
  const target = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}
function kampferWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Cyclops Team')) return;
  for (const u of player.battleArea) {
    if ((u.def.traits || []).includes('Cyclops Team')) u.buffs.push({ activeTargetAPThreshold: 5, scope: 'turn' });
  }
}

// --- Mikhail Kaminsky GD03-090 ---
// [Burst] Add this card to your hand. [Attack] Choose 1 of your (Cyclops Team) Units. It gains
// <Breach 1> during this turn.
function mikhailKaminskyBurst(state, player, instance) {
  player.hand.push(instance);
}
function mikhailKaminskyAttack(state, player, unit, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('Cyclops Team') && !getKeywords(u).breach
  );
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Tokwan GD04-088 ---
// [Burst] Add this card to your hand. (Static: "when this Unit is blocked by an enemy Unit that is
// Lv.4 or lower, it can't receive battle damage during this battle" lives on the card def as
// blockedByLowLevelImmuneCap, read directly by combat.js's isImmuneToBlockerReturnDamage.)
function tokwanBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Impulse Gundam ST09-001 ---
// [Activate*Main] 2, return this Unit to the bottom of its owner's deck: choose 1 Unit card with
// "Impulse Gundam" in its card name that is Lv.4 or higher from your trash. Deploy it. (Engine-
// correct, not wired into runActivations -- trading this Unit away for a specific bigger trash
// card needs real judgement, same reasoning as Archangel/V2 Gundam above.)
function impulseGundamActivateMain(state, player, instance, context) {
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 2) return false;
  const target = context.target;
  const valid = target && player.trash.includes(target) && (target.def.name || '').includes('Impulse Gundam')
    && (target.def.level || 0) >= 4;
  if (!valid) return false;
  activeResources[0].rested = true;
  activeResources[1].rested = true;
  const idx = player.battleArea.indexOf(instance);
  if (idx !== -1) player.battleArea.splice(idx, 1);
  player.deck.push(instance);
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
  return true;
}

// --- Sword Impulse Gundam ST09-006 ---
// [Deploy] If you deploy this Unit from your trash, choose 1 enemy Unit that is Lv.3 or lower.
// Destroy it.
function swordImpulseGundamDeploy(state, player, instance, context) {
  if (!context.fromTrash) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  const wasPaired = !!target.pilot;
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', { wasPaired });
}

// --- Force Impulse Gundam ST09-002 ---
// [Destroyed] Choose 1 (Minerva Squad) Unit card without "Force Impulse Gundam" in its card name
// from your trash. Add it to your hand.
function forceImpulseGundamDestroyed(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Minerva Squad')
      && !(c.def.name || '').includes('Force Impulse Gundam')
  );
  const target = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- Destiny Gundam GD04-050 ---
// <High-Maneuver> (data). [During Pair][Attack] You may choose 1 (Minerva Squad) Unit card from
// your trash. Pay its cost to deploy it.
function destinyGundamGD04050Attack(state, player, instance, context) {
  if (!instance.pilot) return;
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Minerva Squad') && canAfford(player, c.def)
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def);
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Destiny Gundam GD05-055 ---
// <First Strike> (data). (Static: "Once per Turn, when this Unit receives enemy battle damage,
// reduce it by 2" lives on the card def as oncePerTurnBattleDamageReduction, read directly by
// management.js's dealDamage.)

// --- Shinn Asuka ST09-008 ---
// [Burst] Add this card to your hand. [Attack] If this is a (Minerva Squad) Unit, choose 1 of your
// Resources. Set it as active.
function shinnAsukaST09008Burst(state, player, instance) {
  player.hand.push(instance);
}
function shinnAsukaST09008Attack(state, player, unit) {
  if (!(unit.def.traits || []).includes('Minerva Squad')) return;
  const restedResource = player.resourceArea.find((r) => r.rested);
  if (restedResource) restedResource.rested = false;
}

// --- Zeheart Galette GD03-094 ---
// [Burst] Add this card to your hand. [When Paired] Place the top 2 cards of your deck into your
// trash. If you placed a (Vagan) card with this effect, choose 1 enemy Unit. It gets AP-2 during
// this turn.
function zeheartGaletteBurst(state, player, instance) {
  player.hand.push(instance);
}
function zeheartGaletteWhenPaired(state, player, unit, context) {
  const milled = player.deck.splice(0, 2);
  for (const c of milled) player.trash.push(c);
  if (!milled.some((c) => (c.def.traits || []).includes('Vagan'))) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Awakened Power GD02-110 (Command) ---
// [Main] Choose 1 Unit card that is Lv.5 or lower from your trash. Pay its cost to deploy it.
function awakenedPowerCommand(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.level || 0) <= 5 && canAfford(player, c.def)
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def);
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Minerva ST09-010 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// look at the top 2 cards of your deck and return 1 to the top. Place the remaining card into your
// trash. (Heuristic: keep a Unit/Base on top for the immediate board play, same as Kayra's Re-GZ.)
function minervaBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function minervaDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  if (!isOwnTurn || player.deck.length === 0) return;
  const top2 = player.deck.splice(0, 2);
  const keepIdx = top2.findIndex((c) => c.def.type === 'unit' || c.def.type === 'base');
  const keep = top2.splice(keepIdx === -1 ? 0 : keepIdx, 1)[0];
  player.deck.unshift(keep);
  for (const c of top2) player.trash.push(c);
}

// --- Gundam Exia ST07-001 ---
// [When Paired] Place the top 2 cards of your deck into your trash. If you place a (CB) card with
// this effect, draw 1. [End of turn] If there are 7+ (CB) cards in your trash, untap 1 of your
// Resources.
function gundamExiaST07001WhenPaired(state, player) {
  const milled = player.deck.splice(0, 2);
  for (const c of milled) player.trash.push(c);
  if (milled.some((c) => (c.def.traits || []).includes('CB'))) drawCard(state, player);
}
function gundamExiaST07001EndOfTurn(state, player) {
  if (state.players[state.activePlayerIdx] !== player) return;
  const cbInTrash = player.trash.filter((c) => (c.def.traits || []).includes('CB')).length;
  if (cbInTrash < 7) return;
  const rested = player.resourceArea.find((r) => r.rested);
  if (rested) rested.rested = false;
}

// --- Gundam Virtue ST07-004 ---
// While you have a (CB) Pilot in play, this Unit gains <Blocker> -- re-evaluated each start of
// turn like the other conditional-keyword grants above (freedomGundamStartOfTurn etc).
function gundamVirtueStartOfTurn(state, player, instance) {
  instance.grantedKeywords.blocker = player.battleArea.some(
    (u) => u.pilot && (u.pilot.def.traits || []).includes('CB')
  );
}

// --- Setsuna F. Seiei ST07-009 (Pilot) ---
// [Burst] Add this card to your hand. [Attack] This Unit gets AP+1 during this turn. If there are
// 7+ (CB) cards in your trash, all your (CB) Units get AP+1 instead.
function setsunaFSeieiST07009Burst(state, player, instance) {
  player.hand.push(instance);
}
function setsunaFSeieiST07009Attack(state, player, unit) {
  const cbInTrash = player.trash.filter((c) => (c.def.traits || []).includes('CB')).length;
  if (cbInTrash >= 7) {
    for (const u of player.battleArea) {
      if ((u.def.traits || []).includes('CB')) u.buffs.push({ ap: 1, scope: 'turn' });
    }
  } else {
    unit.buffs.push({ ap: 1, scope: 'turn' });
  }
}

// --- Gundam Exia (Trans-Am) GD03-049 ---
// <Suppression> (data). [When this Unit destroys an enemy shield-area card with battle damage] If
// there are 10+ (CB) cards in your trash, choose 1 enemy Unit with the lowest HP. Destroy it.
function gundamExiaTransAmDestroysShield(state, player, unit, context) {
  const cbInTrash = player.trash.filter((c) => (c.def.traits || []).includes('CB')).length;
  if (cbInTrash < 10) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', {});
}

// --- Gundam Kyrios GD04-034 ---
// <First Strike> (data). [During Link] This Unit gets AP+2 for each of your rested (CB) Units --
// computed at the Attack step (the only point this Unit's own AP actually matters), since getAP
// has no access to the owner's battle area to recompute it live.
function gundamKyriosAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  const restedCB = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('CB')).length;
  if (restedCB > 0) unit.buffs.push({ ap: restedCB * 2, scope: 'battle' });
}

// --- Nena Trinity GD04-089 (Pilot) ---
// [Burst] Add this card to your hand. [Activate*Main] <Support 2> (Rest this Unit: 1 other
// friendly Unit gets AP+2 during this turn) -- the generic Support keyword (rules/effects.js
// activateSupport) is Unit-sided; this is a fixed amount granted by a Pilot instead, so it's
// simpler to inline than to force the paired Unit's def.keywords.support to read 2.
function nenaTrinityBurst(state, player, instance) {
  player.hand.push(instance);
}
function nenaTrinityActivateMain(state, player, unit, context) {
  const target = context.target;
  if (!target || target === unit || unit.rested) return false;
  unit.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Hallelujah Haptism GD04-090 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Once per Turn] During your turn, when this
// Unit destroys an enemy Unit with battle damage, look at the top card of your deck. If it's a
// (CB) card, you may reveal it and add it to your hand. Return any remaining card to the bottom
// of your deck.
function hallelujahHaptismBurst(state, player, instance) {
  player.hand.push(instance);
}
function hallelujahHaptismDestroysEnemy(state, player, unit) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (unit.activationsUsed.hallelujahDeckPeek) return;
  unit.activationsUsed.hallelujahDeckPeek = true;
  const top = player.deck.shift();
  if (!top) return;
  if ((top.def.traits || []).includes('CB')) player.hand.push(top);
  else player.deck.push(top);
}

// --- Overwhelming Pressure GD04-109 (Command) ---
// [Main/Action] Choose 1 enemy Unit that is Lv.6 or lower. Deal 4 damage to it.
function overwhelmingPressureCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 6);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 4);
}

// --- Gundam Throne Eins (GN High Mega Launcher) GD05-038 ---
// [During Link] This Unit gains <Suppression> -- isLinkUnit only ever flips false to true (never
// back), and that transition is exactly when [When Linked] fires (actions.js pairPilot), so a
// one-time grant there covers the rest of the instance's lifetime with no per-turn recheck needed.
// [Activate*Main][Once per Turn] Rest 3 of your (CB) Units: choose 1 enemy Unit, deal 4 damage to
// it. Requires judgement on which 3 Units to tap and which enemy to hit, so (like GFreD/Impulse
// Gundam before it) this is engine-correct and tested directly but not wired into the AI's
// runActivations whitelist.
function gundamThroneEinsWhenLinked(state, player, unit) {
  unit.grantedKeywords.suppression = true;
}
function gundamThroneEinsActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.throneEinsBarrage) return false;
  const candidates = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('CB'));
  if (candidates.length < 3) return false;
  const target = context.target;
  if (!target) return false;
  instance.activationsUsed.throneEinsBarrage = true;
  const toRest = context.toRest || candidates.slice(0, 3);
  for (const u of toRest) u.rested = true;
  dealDamage(target, 4);
  return true;
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
  corsicaBaseDeploy,
  overflowingAffectionCommand,
  aileStrikeGundamWhenPaired,
  strikeFreedomDeploy,
  strikeFreedomAttack,
  kiraYamatoST04010Burst,
  kiraYamatoST04010Attack,
  kiraYamatoGD05081Burst,
  kiraYamatoGD05081WhenLinked,
  victoryGundamGD04003Attack,
  vDashGundamActivateMain,
  usoEwinBurst,
  usoEwinWhenPaired,
  reineforceJrBurst,
  reineforceJrDeploy,
  airframeSeizureCommand,
  darknessFingerCommand,
  darknessFingerBurst,
  gundamMaxterDestroysEnemy,
  gundamMaxterAttack,
  risingGundamWhenLinked,
  shiningGundam066Deploy,
  shiningGundam066Attack,
  masterGundamAttack,
  domonKasshuBurst,
  domonKasshuWhenPaired,
  victoryGundamGD04011Destroyed,
  unforeseenIncidentCommand,
  unforeseenIncidentBurst,
  masterAsiaBurst,
  masterAsiaAttack,
  cyclonePunchCommand,
  shiningFingerBurst,
  shiningFingerCommand,
  gundamFightBurst,
  gundamFightDeploy,
  gundamFightActivateMain,
  gundamExiaRepairDealsBattleDamage,
  gundamExiaRepairDestroyed,
  gundamBarbatos1stFormAttack,
  gundamBarbatosAdaptDeploy,
  mikazukiAugusBurst,
  mikazukiAugusWhenPaired,
  widespreadAnnihilationCommand,
  swordStrikeGundamAttack,
  simpleBurstBase,
  simpleBaseDeployAddShield,
  gunEZDeploy,
  v2GundamActivateMain,
  gracefulDemeanorCommand,
  gracefulDemeanorBurst,
  silverBulletDeploy,
  freedomGundamStartOfTurn,
  strikerPackBurst,
  strikerPackCommand,
  archangelActivateMain,
  gundamNT1WhenPaired,
  penelopeFlightFormStartOfTurn,
  penelopeFlightFormDeploy,
  shiningGundamSuperModeAttack,
  sazabiAttack,
  charAznableGD05093Burst,
  charAznableGD05093WhenLinked,
  ryuseiGoDeploy,
  gundamBarbatosLupusActivateMain,
  kshatriyaWhenPaired,
  unicornBansheeDestroyModeAttack,
  maridaCruzBurst,
  maridaCruzAttack,
  closeCombatCommand,
  closeCombatBurst,
  wingGundamBirdModeDeploy,
  wingGundamZeroGD01024Deploy,
  wingGundamZeroEWStartOfTurn,
  wingGundamZeroEWAttack,
  heeroYuy098Burst,
  heeroYuy098DestroysShield,
  heeroYuy010Burst,
  navalBombardmentBurst,
  navalBombardmentCommand,
  peacemillionBurst,
  peacemillionDeploy,
  peacemillionFriendlyUnitDestroysEnemy,
  kindheartedCommand,
  kindheartedBurst,
  m1AstrayShrikeDeploy,
  isaribiBurst,
  isaribiDeploy,
  isaribiActivateMain,
  haowGundamWhenPaired,
  whiteBaseActivateMain,
  battleOfAcesBurst,
  battleOfAcesCommand,
  improvedTechniqueCommand,
  improvedTechniqueBurst,
  rewloolaDeploy,
  axisActivateMain,
  waldfeldsMurasameDestroyed,
  hashmalDestroysEnemy,
  andrewWaldfeldBurst,
  roueiDeploy,
  gundamFlaurosRyuseiGoDestroy,
  akihiroAltlandDestroysEnemy,
  shenlongGundamAttack,
  altronGundamAttack,
  riddheMarcenasBurst,
  unicornBansheeNormActivateMain,
  unicornBansheeNormAttack,
  presidentialOfficeDestroyed,
  argamaDeploy,
  hokaKyotenJuzetsujinCommand,
  gravitonHammerCommand,
  dragonGundamDestroysShield,
  aegisGundamAttack,
  gfredActivateMain,
  gfredWhenLinked,
  justiceGundamDeploy,
  justiceGundamAttack,
  gquuuuuuxOmegaPsycommuDeploy,
  athrunZalaST04011Burst,
  athrunZalaST04011WhenLinked,
  nyaanBurst,
  nyaanWhenLinked,
  changWufeiBurst,
  hyGoggWhenLinked,
  kampferBurst,
  kampferWhenPaired,
  mikhailKaminskyBurst,
  mikhailKaminskyAttack,
  tokwanBurst,
  impulseGundamActivateMain,
  swordImpulseGundamDeploy,
  forceImpulseGundamDestroyed,
  destinyGundamGD04050Attack,
  shinnAsukaST09008Burst,
  shinnAsukaST09008Attack,
  zeheartGaletteBurst,
  zeheartGaletteWhenPaired,
  awakenedPowerCommand,
  minervaBurst,
  minervaDeploy,
  gundamExiaST07001WhenPaired,
  gundamExiaST07001EndOfTurn,
  gundamVirtueStartOfTurn,
  setsunaFSeieiST07009Burst,
  setsunaFSeieiST07009Attack,
  gundamExiaTransAmDestroysShield,
  gundamKyriosAttack,
  nenaTrinityBurst,
  nenaTrinityActivateMain,
  hallelujahHaptismBurst,
  hallelujahHaptismDestroysEnemy,
  overwhelmingPressureCommand,
  gundamThroneEinsWhenLinked,
  gundamThroneEinsActivateMain
};
