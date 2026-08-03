const { contextBridge, ipcRenderer } = require('electron');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');

// Static reference data, not a live IPC round-trip -- just the preset names/labels the renderer's
// skill dropdowns need, so the definitions stay in one place (src/ai/skillPresets.js) instead of
// being duplicated in index.html.
const skillPresetList = Object.entries(SKILL_PRESETS).map(([id, preset]) => ({ id, label: preset.label }));

contextBridge.exposeInMainWorld('sim', {
  run: (deckAText, deckBText, games, skillA, skillB) =>
    ipcRenderer.invoke('run-batch', { deckAText, deckBText, games, skillA, skillB }),
  cancel: () => ipcRenderer.invoke('cancel-batch'),
  skillPresets: skillPresetList,
  onProgress: (callback) => ipcRenderer.on('batch-progress', (_event, msg) => callback(msg)),
  onResult: (callback) => ipcRenderer.on('batch-result', (_event, stats) => callback(stats)),
  onError: (callback) => ipcRenderer.on('batch-error', (_event, message) => callback(message))
});
