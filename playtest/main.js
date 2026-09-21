const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { listAllCards } = require('../src/cards/index');
const banlist = require('../data/banlist.json');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');
const { playInteractiveGame } = require('./engine/turnDriver');
const { makeAIController } = require('./engine/aiController');
const { makeHumanController } = require('./engine/humanController');
const { serializeStateFor } = require('./engine/serialize');

// The interactive playtest app: a separate, much smaller Electron shell from electron/main.js's batch
// simulator, reusing the same core rules/deck/AI modules. Saved decks/results are still out of scope
// (see moonlit-hugging-shannon.md's "explicitly deferred" section) -- packaging + auto-update shipped in
// Phase 3, publishing to Harbl/EXAM-Playtest (a dedicated private repo, kept separate from the batch
// app's own EXAM-Gundam-Simulation releases so the two products' versions/update channels never collide).

let mainWindow;
let gameInProgress = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1000,
    minWidth: 1100,
    minHeight: 760,
    useContentSize: true,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload.js requires local project files (skillPresets.js) -- see electron/main.js's own comment on this same setting
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Piped to the terminal for dev visibility -- this app has no devtools workflow set up yet, so a
  // renderer-side JS error would otherwise be silent.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
}

// Same shape as electron/main.js's own autoUpdater wiring: autoDownload off (only tells the renderer a
// new version exists; downloads/installs on the user's own click, never mid-game), only active in a
// packaged build (npm run playtest has no app-update.yml for electron-updater to read).
autoUpdater.autoDownload = false;
autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-status', { status: 'available', version: info.version });
});
autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) mainWindow.webContents.send('update-status', { status: 'downloading', percent: progress.percent });
});
autoUpdater.on('update-downloaded', () => {
  if (mainWindow) mainWindow.webContents.send('update-status', { status: 'downloaded' });
});
autoUpdater.on('error', (err) => {
  if (mainWindow) mainWindow.webContents.send('update-status', { status: 'error', message: err.message });
});

ipcMain.handle('download-update', () => autoUpdater.downloadUpdate());
ipcMain.handle('quit-and-install', () => autoUpdater.quitAndInstall());

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('playtest:validate-decklist', (event, text) => {
  try {
    const parsed = parseDecklistText(text);
    const byNumber = new Map(listAllCards().map((c) => [c.number, c]));
    const result = validateDeck(parsed, (number) => byNumber.get(number), banlist);
    return { parsed: parsed.main, ...result };
  } catch (err) {
    return { parsed: [], valid: false, errors: [err.message], missingCards: [] };
  }
});

/**
 * Plays one full game: the human's own pasted decklist, against either that same deck mirrored back
 * (aiDecklistText omitted/falsy -- the default) or a separate AI decklist the player chose to paste in
 * the setup screen. `skillId` must be a tier the AI controller actually supports (see skillPresets.js's
 * SKILL_PRESETS) -- 'beginner' (the old fixed-pipeline lookahead engine) has no single-atomic-action
 * entry point yet (see aiController.js's header comment) so the renderer's skill picker never offers it.
 */
ipcMain.handle('playtest:start-game', async (event, { decklistText, skillId, aiDecklistText }) => {
  if (gameInProgress) return { error: 'A game is already in progress.' };
  const byNumber = new Map(listAllCards().map((c) => [c.number, c]));
  const parsed = parseDecklistText(decklistText);
  const validation = validateDeck(parsed, (number) => byNumber.get(number), banlist);
  if (!validation.valid) return { error: validation.errors.join('; ') };

  let aiParsed = parsed;
  if (aiDecklistText) {
    aiParsed = parseDecklistText(aiDecklistText);
    const aiValidation = validateDeck(aiParsed, (number) => byNumber.get(number), banlist);
    if (!aiValidation.valid) return { error: aiValidation.errors.join('; ') };
  }

  const preset = SKILL_PRESETS[skillId] || SKILL_PRESETS.casual;
  if (preset.engine !== 'mcts') return { error: `Skill tier "${skillId}" isn't supported by the interactive AI controller yet.` };

  const deck = buildGameDeck({ main: parsed.main }, (number) => byNumber.get(number));
  const aiDeck = aiDecklistText ? buildGameDeck({ main: aiParsed.main }, (number) => byNumber.get(number)) : deck;
  const humanIdx = 0;
  const aiIdx = 1;
  const aiController = makeAIController(preset.mctsConfig);
  const controllers = [makeHumanController(mainWindow, humanIdx), aiController];

  gameInProgress = true;
  try {
    const state = await playInteractiveGame(deck, aiDeck, controllers, {
      [aiIdx === 0 ? 'valueModelA' : 'valueModelB']: preset.valueModel,
      onUpdate: (s) => mainWindow.webContents.send('playtest:state-update', serializeStateFor(s, humanIdx))
    });
    return { winner: state.winner, draw: state.draw, humanIdx };
  } finally {
    gameInProgress = false;
    aiController.dispose(); // tears down the persistent search worker (see aiController.js) -- otherwise it keeps the process alive
  }
});
