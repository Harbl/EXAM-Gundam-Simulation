const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sim', {
  run: (deckAText, deckBText, games) => ipcRenderer.invoke('run-batch', { deckAText, deckBText, games }),
  cancel: () => ipcRenderer.invoke('cancel-batch'),
  onProgress: (callback) => ipcRenderer.on('batch-progress', (_event, msg) => callback(msg)),
  onResult: (callback) => ipcRenderer.on('batch-result', (_event, stats) => callback(stats)),
  onError: (callback) => ipcRenderer.on('batch-error', (_event, message) => callback(message))
});
