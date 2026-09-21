// Interactive playtest renderer: Pixi board for the actual play table (click-to-select,
// click-to-target -- see moonlit-hugging-shannon.md's Phase 2 plan) plus a DOM sidebar for prompt
// text/buttons. The sidebar's button list is the *authoritative* way to answer every prompt (always
// fully populated, never ambiguous); board-piece clicks are an unambiguous shortcut layered on top
// (see cardOptsFor below) -- if a card has more than one legal action at once (e.g. it can both
// attack and Activate), clicking it does nothing and the sidebar list is what resolves the choice,
// rather than guessing which action a click meant.

// ---------- Auto-update banner (same pattern as electron/renderer's own) ----------

if (window.updater) {
  const banner = document.getElementById('update-banner');
  let updateStage = null;
  banner.addEventListener('click', () => {
    if (updateStage === 'available') window.updater.download();
    else if (updateStage === 'downloaded') window.updater.quitAndInstall();
  });
  window.updater.onStatus((status) => {
    updateStage = status.status;
    if (status.status === 'available') {
      banner.textContent = `Update available (v${status.version}) — click to download`;
      banner.disabled = false;
      banner.style.display = 'block';
    } else if (status.status === 'downloading') {
      banner.textContent = `Downloading update... ${Math.round(status.percent)}%`;
      banner.disabled = true;
      banner.style.display = 'block';
    } else if (status.status === 'downloaded') {
      banner.textContent = 'Update ready — click to restart & install';
      banner.disabled = false;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  });
}

const HUMAN_IDX = 0; // fixed by playtest/main.js's start-game handler
const CARD_W = 86;
const CARD_H = 118;
const GAP = 8;

let pixiApp = null;
let stage = null;
let currentPrompt = null;
let selectedDiscardIds = new Set();

// ---------- Setup screen ----------

const skillSelect = document.getElementById('skill-select');
for (const preset of window.playtest.skillPresets) {
  const opt = document.createElement('option');
  opt.value = preset.id;
  opt.textContent = preset.label;
  skillSelect.appendChild(opt);
}

const decklistInput = document.getElementById('decklist-input');
const aiDeckToggle = document.getElementById('ai-deck-toggle');
const aiDeckWrap = document.getElementById('ai-deck-wrap');
const aiDecklistInput = document.getElementById('ai-decklist-input');
const validationMsg = document.getElementById('validation-msg');
const startBtn = document.getElementById('start-btn');
let validDecklistText = null;
let validAiDecklistText = null; // null = AI mirrors the player's own deck (default)

aiDeckToggle.addEventListener('change', () => {
  aiDeckWrap.classList.toggle('hidden', !aiDeckToggle.checked);
  startBtn.disabled = true; // toggling changes what "valid" means -- force a re-validate
});

document.getElementById('validate-btn').addEventListener('click', async () => {
  const result = await window.playtest.validateDecklist(decklistInput.value);
  const aiResult = aiDeckToggle.checked ? await window.playtest.validateDecklist(aiDecklistInput.value) : null;
  const bothValid = result.valid && (!aiResult || aiResult.valid);

  if (bothValid) {
    validDecklistText = decklistInput.value;
    validAiDecklistText = aiDeckToggle.checked ? aiDecklistInput.value : null;
    const count = result.parsed.reduce((sum, c) => sum + c.quantity, 0);
    validationMsg.textContent = aiResult
      ? `Both decks valid (yours: ${count} cards, AI's: ${aiResult.parsed.reduce((sum, c) => sum + c.quantity, 0)} cards).`
      : `Deck valid (${count} cards).`;
    validationMsg.className = 'ok';
    startBtn.disabled = false;
  } else {
    validDecklistText = null;
    validAiDecklistText = null;
    validationMsg.textContent = [...(result.valid ? [] : result.errors), ...(aiResult && !aiResult.valid ? aiResult.errors : [])].join('; ');
    validationMsg.className = 'error';
    startBtn.disabled = true;
  }
});

startBtn.addEventListener('click', async () => {
  if (!validDecklistText) return;
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  await initBoard();
  const result = await window.playtest.startGame(validDecklistText, skillSelect.value, validAiDecklistText);
  showGameOver(result);
});

document.getElementById('play-again-btn').addEventListener('click', () => {
  document.getElementById('game-over-banner').classList.add('hidden');
  document.getElementById('game-screen').classList.add('hidden');
  document.getElementById('setup-screen').classList.remove('hidden');
  currentPrompt = null;
});

function showGameOver(result) {
  const text = document.getElementById('game-over-text');
  if (result && result.error) text.textContent = 'Error: ' + result.error;
  else if (result && result.draw) text.textContent = "It's a draw.";
  else if (result && result.winner === HUMAN_IDX) text.textContent = 'You win!';
  else if (result) text.textContent = 'The AI wins.';
  else text.textContent = 'Game ended.';
  document.getElementById('game-over-banner').classList.remove('hidden');
}

// ---------- Pixi board ----------

async function initBoard() {
  if (pixiApp) return;
  pixiApp = new PIXI.Application();
  await pixiApp.init({ width: 1000, height: 800, backgroundColor: 0x0b0d12, antialias: true });
  document.getElementById('board-wrap').appendChild(pixiApp.canvas);
  stage = pixiApp.stage;
}

window.playtest.onStateUpdate((state) => renderBoard(state));
window.playtest.onPrompt((prompt) => {
  currentPrompt = prompt;
  selectedDiscardIds = new Set();
  // The mulligan prompt fires before setup finishes (see turnDriver.js), so there's no board state
  // yet to serialize -- show the actual dealt hand instead of leaving the board blank, otherwise the
  // mulligan decision would be made blind (the DOM panel only shows a card count).
  if (prompt.state) renderBoard(prompt.state);
  else if (prompt.kind === 'mulligan') renderMulliganHand(prompt.hand);
  renderPromptPanel(prompt);
});

function renderMulliganHand(hand) {
  if (!stage) return;
  stage.removeChildren();
  drawText('Your opening hand:', 20, 10, { fontSize: 15, fill: 0xffffff, fontWeight: '700' });
  let x = 20;
  for (const card of hand) {
    place(makeCardSprite(card, {}), x, 40);
    x += CARD_W + GAP;
  }
}

const COLOR_HEX = { blue: 0x2f6fd6, white: 0xd8d8d8, green: 0x3f9c4c, red: 0xc0473f, colorless: 0x555a68 };

function colorFor(card) {
  if (!card) return 0x2a2e3a;
  return COLOR_HEX[card.color] || 0x2a2e3a;
}

function findAnywhere(state, id) {
  for (const p of state.players) {
    if (p.base && p.base.id === id) return p.base;
    const u = p.battleArea.find((c) => c.id === id);
    if (u) return u;
    const h = p.hand.find((c) => c.id === id);
    if (h) return h;
  }
  return null;
}

/** Every legal action in prompt.legalActions that this specific card id would trigger -- 1 match is a
 * safe click shortcut, 2+ is a genuine ambiguity (e.g. a Unit that can both attack and Activate) left
 * to the sidebar's explicit button list instead of guessed at. */
function matchingActions(prompt, cardId) {
  if (!prompt || prompt.kind !== 'mainAction') return [];
  return prompt.legalActions.filter((a) => a.attackerId === cardId || a.sourceId === cardId || a.cardId === cardId);
}

function cardOptsFor(card, own) {
  const p = currentPrompt;
  if (!p || p.playerIdx !== HUMAN_IDX) return {};
  if (p.kind === 'mainAction' && own) {
    const matches = matchingActions(p, card.id);
    if (matches.length === 1) return { highlight: true, onClick: () => respond({ action: matches[0] }) };
    return {};
  }
  if (p.kind === 'attackTarget' && !own) {
    if (p.options.some((o) => o.type === 'unit' && o.id === card.id)) {
      return { highlight: true, onClick: () => respond({ target: { type: 'unit', id: card.id } }) };
    }
    return {};
  }
  if (p.kind === 'blocker' && own) {
    if (p.candidateIds.includes(card.id)) return { highlight: true, onClick: () => respond({ blockerId: card.id }) };
    return {};
  }
  if (p.kind === 'discards' && own) {
    return { highlight: selectedDiscardIds.has(card.id), onClick: () => toggleDiscard(card.id) };
  }
  return {};
}

function toggleDiscard(cardId) {
  if (selectedDiscardIds.has(cardId)) selectedDiscardIds.delete(cardId);
  else if (selectedDiscardIds.size < currentPrompt.excess) selectedDiscardIds.add(cardId);
  if (currentPrompt.state) renderBoard(currentPrompt.state);
  updateDiscardConfirmLabel();
}

function makeCardSprite(card, opts = {}) {
  const c = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.roundRect(0, 0, CARD_W, CARD_H, 8).fill(colorFor(card));
  g.stroke({ width: opts.highlight ? 3 : 1, color: opts.highlight ? 0xffd23f : 0x3a3f4d });
  c.addChild(g);

  const name = new PIXI.Text({
    text: card.name || '',
    style: { fontSize: 10, fill: 0xffffff, wordWrap: true, wordWrapWidth: CARD_W - 8, fontWeight: '600' }
  });
  name.x = 4;
  name.y = 4;
  c.addChild(name);

  if (card.type === 'unit' || card.type === 'base') {
    const parts = [];
    if (card.type === 'unit') parts.push('AP ' + card.ap);
    parts.push('HP ' + card.hp + '/' + card.maxHp);
    const stats = new PIXI.Text({ text: parts.join('  '), style: { fontSize: 10, fill: 0xc9d6ff } });
    stats.x = 4;
    stats.y = CARD_H - 16;
    c.addChild(stats);
  }
  if (card.pilot) {
    const pilotTag = new PIXI.Text({ text: '✈ ' + card.pilot.name, style: { fontSize: 9, fill: 0xffe08a } });
    pilotTag.x = 4;
    pilotTag.y = CARD_H - 30;
    c.addChild(pilotTag);
  }
  if (card.rested) c.rotation = 0.3; // quick visual tell for a rested card, not a separate icon asset

  if (opts.onClick) {
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointertap', opts.onClick);
  }
  return c;
}

function makeFaceDownSprite() {
  const c = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.roundRect(0, 0, CARD_W, CARD_H, 8).fill(0x1a1c24);
  g.stroke({ width: 1, color: 0x3a3f4d });
  c.addChild(g);
  return c;
}

function makeLabelChip(label, onClick, color = 0x2c5cc4) {
  const c = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.roundRect(0, 0, CARD_W, CARD_H, 8).fill(color);
  g.stroke({ width: 2, color: 0xffd23f });
  c.addChild(g);
  const text = new PIXI.Text({
    text: label,
    style: { fontSize: 11, fill: 0xffffff, wordWrap: true, wordWrapWidth: CARD_W - 8, align: 'center', fontWeight: '600' }
  });
  text.x = 4;
  text.y = CARD_H / 2 - 12;
  c.addChild(text);
  if (onClick) {
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointertap', onClick);
  }
  return c;
}

function place(container, x, y) {
  container.x = x;
  container.y = y;
  stage.addChild(container);
  return container;
}

function drawText(str, x, y, opts = {}) {
  const t = new PIXI.Text({ text: str, style: Object.assign({ fontSize: 13, fill: 0xb7bbc9 }, opts) });
  t.x = x;
  t.y = y;
  stage.addChild(t);
  return t;
}

function drawBattleRow(state, player, own, y) {
  let x = 20;
  if (player.base) {
    place(makeCardSprite(player.base, cardOptsFor(player.base, own)), x, y);
    x += CARD_W + GAP;
  }
  for (const unit of player.battleArea) {
    place(makeCardSprite(unit, cardOptsFor(unit, own)), x, y);
    x += CARD_W + GAP;
  }
  const p = currentPrompt;
  if (!own && p && p.playerIdx === HUMAN_IDX && p.kind === 'attackTarget' && p.options.some((o) => o.type === 'player')) {
    place(makeLabelChip('Attack\nPlayer', () => respond({ target: { type: 'player' } }), 0x8a2f2f), x, y);
    x += CARD_W + GAP;
  }
  return y + CARD_H + 12;
}

function drawHandRow(state, player, own, y) {
  if (own) {
    let x = 20;
    for (const card of player.hand) {
      place(makeCardSprite(card, cardOptsFor(card, true)), x, y);
      x += CARD_W + GAP;
    }
    drawText(`Your hand: ${player.hand.length}`, 20, y - 16);
  } else {
    let x = 20;
    for (let i = 0; i < player.handCount; i++) {
      place(makeFaceDownSprite(), x, y);
      x += CARD_W * 0.55 + 3; // overlap opponent's hidden hand tighter, it's just a count indicator
    }
    drawText(`Opponent hand: ${player.handCount}`, 20, y - 16);
  }
  return y + CARD_H + 12;
}

function drawInfoRow(player, y) {
  const restedResources = player.resourceArea.filter((c) => c.rested).length;
  const text =
    `Deck: ${player.deckCount}   Resources: ${player.resourceArea.length} (${restedResources} rested)` +
    `   Shields: ${player.shieldCount}   Trash: ${player.trash.length}${player.defeated ? '   [DEFEATED]' : ''}`;
  drawText(text, 20, y);
  return y + 22;
}

function renderBoard(state) {
  if (!stage) return;
  stage.removeChildren();
  const opp = state.players[1 - HUMAN_IDX];
  const me = state.players[HUMAN_IDX];

  let y = 10;
  y = drawHandRow(state, opp, false, y);
  y = drawInfoRow(opp, y);
  y += 8;
  y = drawBattleRow(state, opp, false, y);

  y += 10;
  const activeName = state.activePlayerIdx === HUMAN_IDX ? 'Your turn' : "Opponent's turn";
  drawText(`Turn ${state.turnNumber} — ${activeName}`, 20, y, { fontSize: 15, fill: 0xffffff, fontWeight: '700' });
  y += 30;

  y = drawBattleRow(state, me, true, y);
  y = drawInfoRow(me, y);
  y += 10;
  drawHandRow(state, me, true, y);
}

// ---------- Prompt sidebar ----------

function respond(payload) {
  window.playtest.respond(payload);
  currentPrompt = null;
  renderPromptPanel(null);
}

function addBtn(container, label, onClick, cls) {
  const b = document.createElement('button');
  b.className = 'action-btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.onclick = onClick;
  container.appendChild(b);
  return b;
}

function describeAction(action, state) {
  switch (action.type) {
    case 'pass':
      return 'Pass';
    case 'deploy':
      return 'Deploy ' + (findAnywhere(state, action.cardId)?.name || '?');
    case 'pair':
      return 'Pair ' + (findAnywhere(state, action.cardId)?.name || '?');
    case 'command':
      return 'Play Command: ' + (findAnywhere(state, action.cardId)?.name || '?');
    case 'attack':
      return 'Attack with ' + (findAnywhere(state, action.attackerId)?.name || '?');
    case 'activate':
      return 'Activate: ' + (findAnywhere(state, action.sourceId)?.name || '?');
    default:
      return action.type;
  }
}

function updateDiscardConfirmLabel() {
  const btn = document.getElementById('discard-confirm-btn');
  if (!btn) return;
  btn.textContent = `Confirm Discard (${selectedDiscardIds.size}/${currentPrompt.excess})`;
  btn.disabled = selectedDiscardIds.size !== currentPrompt.excess;
}

function renderPromptPanel(prompt) {
  const title = document.getElementById('prompt-title');
  const body = document.getElementById('prompt-body');
  const actions = document.getElementById('prompt-actions');
  actions.innerHTML = '';

  if (!prompt || prompt.playerIdx !== HUMAN_IDX) {
    title.textContent = prompt ? "Opponent is thinking..." : 'Waiting...';
    body.textContent = '';
    return;
  }

  switch (prompt.kind) {
    case 'mulligan':
      title.textContent = 'Mulligan?';
      body.textContent = `Your opening hand has ${prompt.hand.length} cards. Keep it, or mulligan for a fresh hand?`;
      addBtn(actions, 'Keep hand', () => respond({ mulligan: false }), 'confirm');
      addBtn(actions, 'Mulligan', () => respond({ mulligan: true }));
      break;

    case 'mainAction':
      title.textContent = 'Your move';
      body.textContent = 'Choose an action below, or click a highlighted card on the board.';
      for (const action of prompt.legalActions) {
        addBtn(actions, describeAction(action, prompt.state), () => respond({ action }), action.type === 'pass' ? 'pass' : '');
      }
      break;

    case 'attackTarget':
      title.textContent = 'Choose attack target';
      body.textContent = 'Click a highlighted target on the board, or pick one below.';
      for (const opt of prompt.options) {
        const label = opt.type === 'player' ? "Attack the opponent directly" : 'Attack ' + (findAnywhere(prompt.state, opt.id)?.name || 'target');
        addBtn(actions, label, () => respond({ target: opt.type === 'player' ? { type: 'player' } : { type: 'unit', id: opt.id } }));
      }
      break;

    case 'blocker':
      title.textContent = 'Block the incoming attack?';
      body.textContent = 'Click a highlighted Unit of yours on the board to block with it.';
      addBtn(actions, "Don't block", () => respond({ blockerId: null }), 'pass');
      break;

    case 'priority':
      title.textContent = 'Respond?';
      body.textContent = 'Play a reactive Command or ability now, or pass.';
      for (const c of prompt.commandOptions) addBtn(actions, 'Play: ' + c.name, () => respond({ action: { type: 'command', cardId: c.cardId } }));
      for (const a of prompt.activateOptions) addBtn(actions, 'Activate: ' + a.sourceName, () => respond({ action: { type: 'activate', sourceId: a.sourceId } }));
      addBtn(actions, 'Pass', () => respond({ action: { type: 'pass' } }), 'pass');
      break;

    case 'discards': {
      title.textContent = `Discard ${prompt.excess} card(s)`;
      body.textContent = 'Click cards in your hand on the board to select them, then confirm.';
      const btn = addBtn(actions, `Confirm Discard (0/${prompt.excess})`, () => {
        if (selectedDiscardIds.size === prompt.excess) respond({ cardIds: [...selectedDiscardIds] });
      }, 'confirm');
      btn.id = 'discard-confirm-btn';
      btn.disabled = prompt.excess > 0;
      break;
    }

    case 'burst':
      title.textContent = 'Shield destroyed — activate Burst?';
      body.textContent = `${prompt.shield.name} has a Burst effect. Activate it before it goes to the trash?`;
      addBtn(actions, 'Activate Burst', () => respond({ activate: true }), 'confirm');
      addBtn(actions, "Don't activate", () => respond({ activate: false }), 'pass');
      break;

    case 'burstOrder':
      title.textContent = 'Choose Burst resolution order';
      body.textContent = '<Suppression> hit 2 Shields at once — pick which one resolves first.';
      for (const shield of prompt.shields) {
        const rest = prompt.shields.filter((s) => s.id !== shield.id).map((s) => s.id);
        addBtn(actions, 'Resolve ' + shield.name + ' first', () => respond({ orderedIds: [shield.id, ...rest] }));
      }
      break;

    default:
      title.textContent = prompt.kind;
      body.textContent = '';
  }
}
