const { app, BrowserWindow, ipcMain } = require('electron');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

let mainWindow;
let activeWorker = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('run-batch', (event, { deckAText, deckBText, games }) => {
  if (activeWorker) activeWorker.terminate();

  activeWorker = new Worker(path.join(__dirname, 'worker', 'batchWorker.js'), {
    workerData: { deckAText, deckBText, games }
  });

  activeWorker.on('message', (msg) => {
    if (msg.type === 'progress') mainWindow.webContents.send('batch-progress', msg);
    if (msg.type === 'done') {
      mainWindow.webContents.send('batch-result', msg.stats);
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
