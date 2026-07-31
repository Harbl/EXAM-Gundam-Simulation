const { dealDamage, getAP, getHP, getRemainingHP, getKeywords, recoverHP, removeFromField, destroyCard } = require('../rules/management');
const { deployUnit, becomeBase } = require('../rules/actions');
const { drawCard } = require('../rules/phases');
const { resolveUnitBattleDamage, applyBreach } = require('../rules/combat');
const { fireCardEffect } = require('../rules/effects');
const { createInstance, shuffle } = require('../rules/state');
const { EX_RESOURCE_DEF } = require('../rules/setup');

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
    const toDestroy = p.battleArea.filter((u) => (u.def.level || 0) <= 4);
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
  if (getRemainingHP(target) <= 0) {
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
  const enemyCandidates = opponent.battleArea.filter((u) => u !== targetInstance);
  if (enemyCandidates.length === 0) return;

  const toSacrifice = [...ownCandidates].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  const enemyTarget = [...enemyCandidates].sort((a, b) => getAP(b) - getAP(a))[0];
  if (getAP(toSacrifice) + getRemainingHP(toSacrifice) >= getAP(enemyTarget) + getRemainingHP(enemyTarget)) return;

  destroyCard(state, player, toSacrifice);
  fireCardEffect(state, player, toSacrifice, 'destroyed', { wasPaired: !!toSacrifice.pilot });
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
  closeCombatBurst
};
