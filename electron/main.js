const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const AdmZip = require('adm-zip');
const { listDecks, saveDeck, loadDeck, deleteDeck, filePathFor: deckFilePathFor } = require('../src/deck/store');
const { listBatches, saveBatch, deleteBatch, filePathFor: batchFilePathFor } = require('../src/sim/resultsStore');
const {
  listTournaments,
  saveTournament,
  deleteTournament,
  filePathFor: tournamentFilePathFor
} = require('../src/sim/tournamentStore');
const { listAllCards } = require('../src/cards/index');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const banlist = require('../data/banlist.json');
const changelog = require('../data/changelog.json');

let mainWindow;
let activeWorker = null;
const DECKS_DIR = () => path.join(app.getPath('userData'), 'decks');
const BATCHES_DIR = () => path.join(app.getPath('userData'), 'batches');
const TOURNAMENTS_DIR = () => path.join(app.getPath('userData'), 'tournaments');
const APP_STATE_FILE = () => path.join(app.getPath('userData'), 'app-state.json');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1357,
    height: 1040,
    minWidth: 1050,
    minHeight: 720,
    useContentSize: true, // width/height above are the page's content area, not the outer frame --
    // otherwise the OS window chrome (title bar/borders) eats into it and the page renders too small
    // to show everything without the user manually resizing.
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20+ defaults sandbox:true, which restricts preload scripts to a small built-in
      // require allow-list -- preload.js's `require('../src/ai/skillPresets')` (a local project
      // file, not a bundled dependency) silently fails under that default, so contextBridge's whole
      // exposeInMainWorld call never runs and window.sim ends up undefined in the renderer. Safe to
      // disable here since this app only ever loads its own local, trusted index.html -- never
      // remote or untrusted content -- and contextIsolation/nodeIntegration above still firewall the
      // renderer itself from Node; this only restores full require() inside the preload script.
      sandbox: false
    }
  });

  // Previously started maximized (to guarantee nothing got cut off), but Jake didn't want a
  // maximized launch -- and confirmed that un-maximizing back to windowed mode landed at exactly
  // the right size, which is just the width/height set above. So: launch windowed at that size
  // directly, no maximize() call.
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Update checking (electron-updater, reading package.json's build.publish -- the GitHub repo
// releases already get uploaded to manually). autoDownload is off on purpose: this only tells the
// renderer a new version exists (a small dismissible banner) and downloads/installs on the user's
// own click, never silently in the background -- surprising someone mid-batch-run with a relaunch
// would be a bad experience for a simulator that can run for minutes. Only wired up in a packaged
// build: an unpackaged `npm start` has no app-update.yml for electron-updater to read and would just
// throw on every check.
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
  // A few seconds after launch, not immediately -- lets the window paint and the batch-runner UI
  // become usable first, so an update check (a network call) never feels like it's blocking startup.
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('run-batch', (event, { deckAText, deckBText, games, skillA, skillB, bypassHandicaps }) => {
  if (activeWorker) activeWorker.terminate();

  activeWorker = new Worker(path.join(__dirname, 'worker', 'batchWorker.js'), {
    workerData: { deckAText, deckBText, games, skillA, skillB, bypassHandicaps }
  });

  activeWorker.on('message', (msg) => {
    if (msg.type === 'progress') mainWindow.webContents.send('batch-progress', msg);
    if (msg.type === 'done') {
      // context (deck texts + engine/mctsConfig) is sent alongside stats, not just cached here, so
      // the renderer can hand it straight to save-batch -- a saved batch needs to carry its own
      // context to replay from later, not rely on "whatever the last live run happened to be".
      mainWindow.webContents.send('batch-result', { stats: msg.stats, context: msg.context });
      activeWorker = null;
    }
    if (msg.type === 'error') {
      mainWindow.webContents.send('batch-error', msg.message);
      activeWorker = null;
    }
  });
  activeWorker.on('error', (err) => {
    mainWindow.webContents.send('batch-error', err.message);
    activeWorker = null;
  });
});

ipcMain.handle('cancel-batch', () => {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
});

// Same activeWorker slot / cancel-batch channel as a batch run -- only one of either can usefully run
// at a time anyway (both are CPU-bound simulation work), so reusing the single-worker-slot cancellation
// path needs no new IPC channel.
ipcMain.handle('run-tournament', (event, { entrants, bestOf, skill, format, bypassHandicaps }) => {
  if (activeWorker) activeWorker.terminate();

  activeWorker = new Worker(path.join(__dirname, 'worker', 'tournamentWorker.js'), {
    workerData: { entrants, bestOf, skill, format, bypassHandicaps }
  });

  activeWorker.on('message', (msg) => {
    if (msg.type === 'progress') mainWindow.webContents.send('tournament-progress', msg);
    if (msg.type === 'done') {
      mainWindow.webContents.send('tournament-result', { result: msg.result, context: msg.context });
      activeWorker = null;
    }
    if (msg.type === 'error') {
      mainWindow.webContents.send('tournament-error', msg.message);
      activeWorker = null;
    }
  });
  activeWorker.on('error', (err) => {
    mainWindow.webContents.send('tournament-error', err.message);
    activeWorker = null;
  });
});

// Plain-data fields only -- a card def's `effects` object holds live function references (resolved
// by cards/index.js from src/effects/registry.js), which the IPC structured-clone boundary can't
// serialize, so the deck builder's browse screen only ever needs this subset anyway.
ipcMain.handle('list-cards', () =>
  listAllCards().map(({ number, name, type, color, level, cost, ap, hp, traits }) => ({
    number,
    name,
    type,
    color,
    level,
    cost,
    ap,
    hp,
    traits
  }))
);

/** "What's new" splash gate: shows the newest changelog entry once per version, on the first launch
 * after an update -- never on a brand-new install (nothing to catch a new user up on), since app-state
 * only exists once a version has actually been recorded. A missing/corrupt state file is treated the
 * same as a fresh install (write current version, stay silent) rather than erroring the app open. */
ipcMain.handle('check-changelog', () => {
  const stateFile = APP_STATE_FILE();
  let lastSeenVersion = null;
  try {
    lastSeenVersion = JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSeenVersion;
  } catch {
    // no state file yet (fresh install) or unreadable -- treated as "nothing seen yet" below
  }
  const currentVersion = app.getVersion();
  const isFreshInstall = lastSeenVersion === null;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ lastSeenVersion: currentVersion }));
  if (isFreshInstall || lastSeenVersion === currentVersion) return { show: false };
  const entry = changelog[0];
  return entry ? { show: true, version: entry.version, date: entry.date, notes: entry.notes } : { show: false };
});

ipcMain.handle('validate-decklist', (event, text) => {
  try {
    const parsed = parseDecklistText(text);
    const byNumber = new Map(listAllCards().map((c) => [c.number, c]));
    const result = validateDeck(parsed, (number) => byNumber.get(number), banlist);
    return { parsed: parsed.main, ...result };
  } catch (err) {
    return { parsed: [], valid: false, errors: [err.message], missingCards: [] };
  }
});

/** Saves a renderer-generated PNG (a data URL from a <canvas>.toDataURL()) to disk, via a native
 * Save dialog -- backs the deck-image and stats-infographic export features. */
ipcMain.handle('save-image', async (event, { dataUrl, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Image',
    defaultPath: suggestedName || 'export.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  });
  if (canceled || !filePath) return { saved: false };
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { saved: true, filePath };
});

ipcMain.handle('list-decks', () => listDecks(DECKS_DIR()));
ipcMain.handle('save-deck', (event, { name, decklistText }) => saveDeck(DECKS_DIR(), name, decklistText));
ipcMain.handle('load-deck', (event, name) => loadDeck(DECKS_DIR(), name));
ipcMain.handle('delete-deck', (event, name) => deleteDeck(DECKS_DIR(), name));

ipcMain.handle('list-batches', () => listBatches(BATCHES_DIR()));
ipcMain.handle('save-batch', (event, { name, stats, context }) => saveBatch(BATCHES_DIR(), name, stats, context));
ipcMain.handle('delete-batch', (event, name) => deleteBatch(BATCHES_DIR(), name));

ipcMain.handle('list-tournaments', () => listTournaments(TOURNAMENTS_DIR()));
ipcMain.handle('save-tournament', (event, { name, result, context }) =>
  saveTournament(TOURNAMENTS_DIR(), name, result, context)
);
ipcMain.handle('delete-tournament', (event, name) => deleteTournament(TOURNAMENTS_DIR(), name));

/** Zips a user-selected subset of saved decks/batches/tournaments into a single archive, saved
 * wherever the user picks via a native Save dialog -- same dialog.showSaveDialog pattern as
 * save-image above, just producing a zip (via adm-zip) instead of writing a raw buffer. `selection`
 * is `{decks: [name], batches: [name], tournaments: [name]}`; each name is resolved to its real file
 * on disk via the same store module's own filePathFor (never reimplemented here), and archived under
 * a same-named top-level folder (decks/, batches/, tournaments/) so an extracted backup is
 * self-explanatory. Silently skips a name whose file no longer exists (deleted between listing and
 * backing up) rather than failing the whole export over one stale entry. */
ipcMain.handle('backup-selected', async (event, selection) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Back Up Selected Data',
    defaultPath: `exam-backup-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
  });
  if (canceled || !filePath) return { saved: false };

  const zip = new AdmZip();
  let fileCount = 0;
  const groups = [
    { names: selection.decks || [], dir: DECKS_DIR(), zipFolder: 'decks', pathFor: deckFilePathFor },
    { names: selection.batches || [], dir: BATCHES_DIR(), zipFolder: 'batches', pathFor: batchFilePathFor },
    { names: selection.tournaments || [], dir: TOURNAMENTS_DIR(), zipFolder: 'tournaments', pathFor: tournamentFilePathFor }
  ];
  for (const { names, dir, zipFolder, pathFor } of groups) {
    for (const name of names) {
      const sourcePath = pathFor(dir, name);
      if (!fs.existsSync(sourcePath)) continue;
      zip.addLocalFile(sourcePath, zipFolder);
      fileCount++;
    }
  }
  await zip.writeZipPromise(filePath);
  return { saved: true, filePath, fileCount };
});

/** Re-simulates one past game (by seed), given the deck/AI context it was originally run with -- a
 * batch (this session's or saved), or one match from a tournament (this session's or saved, with the
 * matchup's two entrants' decklists substituted in as deckAText/deckBText) -- all shaped the same
 * (deckAText, deckBText, engineA/B, mctsConfigA/B) -- returning a structured turn-by-turn event
 * log for the replay viewer. Runs in its own fresh worker_thread every time (never reused) --
 * src/sim/traceGame.js's function-patching approach needs a clean module registry, see its header
 * comment. */
ipcMain.handle('replay-game', (event, { seed, context }) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker', 'replayWorker.js'), {
      workerData: { ...context, seed }
    });
    worker.on('message', (msg) => {
      if (msg.type === 'done') resolve(msg.events);
      else reject(new Error(msg.message));
      worker.terminate();
    });
    worker.on('error', (err) => {
      reject(err);
      worker.terminate();
    });
  });
});
