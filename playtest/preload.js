const { contextBridge, ipcRenderer } = require('electron');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');

// Same static-data pattern as electron/preload.js's skillPresetList -- filtered to only the tiers
// aiController.js can actually drive one atomic decision at a time (see its header comment): the older
// fixed-pipeline 'beginner' engine has no equivalent entry point, so it's left off the picker entirely
// rather than offered and then erroring at start-game time.
const skillPresetList = Object.entries(SKILL_PRESETS)
  .filter(([, preset]) => preset.engine === 'mcts')
  .map(([id, preset]) => ({ id, label: preset.label }));

contextBridge.exposeInMainWorld('playtest', {
  skillPresets: skillPresetList,
  validateDecklist: (text) => ipcRenderer.invoke('playtest:validate-decklist', text),
  startGame: (decklistText, skillId, aiDecklistText) => ipcRenderer.invoke('playtest:start-game', { decklistText, skillId, aiDecklistText }),
  respond: (payload) => ipcRenderer.send('playtest:respond', payload),
  onPrompt: (callback) => ipcRenderer.on('playtest:prompt', (_event, payload) => callback(payload)),
  onStateUpdate: (callback) => ipcRenderer.on('playtest:state-update', (_event, state) => callback(state))
});

// Same shape as electron/preload.js's own 'updater' bridge.
contextBridge.exposeInMainWorld('updater', {
  download: () => ipcRenderer.invoke('download-update'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onStatus: (callback) => ipcRenderer.on('update-status', (_event, status) => callback(status))
});
