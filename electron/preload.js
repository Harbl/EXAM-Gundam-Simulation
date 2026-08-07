const { contextBridge, ipcRenderer } = require('electron');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');
const { ARCHETYPE_HANDICAPS } = require('../src/ai/archetypeHandicaps');

// Static reference data, not a live IPC round-trip -- just the preset names/labels the renderer's
// skill dropdowns need, so the definitions stay in one place (src/ai/skillPresets.js) instead of
// being duplicated in index.html.
const skillPresetList = Object.entries(SKILL_PRESETS).map(([id, preset]) => ({ id, label: preset.label }));

// Same "static data, no live round-trip" pattern -- lets the renderer detect a known AI-advantaged
// archetype (for the Newtype Awakening warning banner) by summing card quantities itself against
// `cardNumbers`/`minCopies`, without a new IPC call per keystroke. Only inert data crosses the bridge
// (no `override`/functions) -- the actual handicap decision still only ever happens in the worker via
// applyArchetypeHandicap, this is purely for the renderer's own warning-display judgment call.
const archetypeHandicapList = ARCHETYPE_HANDICAPS.map(({ name, cardNumbers, minCopies }) => ({ name, cardNumbers, minCopies }));

contextBridge.exposeInMainWorld('sim', {
  run: (deckAText, deckBText, games, skillA, skillB, bypassHandicaps) =>
    ipcRenderer.invoke('run-batch', { deckAText, deckBText, games, skillA, skillB, bypassHandicaps }),
  cancel: () => ipcRenderer.invoke('cancel-batch'),
  skillPresets: skillPresetList,
  archetypeHandicaps: archetypeHandicapList,
  onProgress: (callback) => ipcRenderer.on('batch-progress', (_event, msg) => callback(msg)),
  // Payload is {stats, context} -- context (deck texts + engine/mctsConfig) rides along so the
  // renderer can hand it straight to resultsStore.save without a separate round trip.
  onResult: (callback) => ipcRenderer.on('batch-result', (_event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on('batch-error', (_event, message) => callback(message)),
  replayGame: (seed, context) => ipcRenderer.invoke('replay-game', { seed, context })
});

contextBridge.exposeInMainWorld('deckStore', {
  list: () => ipcRenderer.invoke('list-decks'),
  save: (name, decklistText) => ipcRenderer.invoke('save-deck', { name, decklistText }),
  load: (name) => ipcRenderer.invoke('load-deck', name),
  delete: (name) => ipcRenderer.invoke('delete-deck', name)
});

contextBridge.exposeInMainWorld('resultsStore', {
  list: () => ipcRenderer.invoke('list-batches'),
  save: (name, stats, context) => ipcRenderer.invoke('save-batch', { name, stats, context }),
  delete: (name) => ipcRenderer.invoke('delete-batch', name)
});

contextBridge.exposeInMainWorld('cards', {
  list: () => ipcRenderer.invoke('list-cards'),
  validate: (decklistText) => ipcRenderer.invoke('validate-decklist', decklistText)
});

contextBridge.exposeInMainWorld('exporter', {
  saveImage: (dataUrl, suggestedName) => ipcRenderer.invoke('save-image', { dataUrl, suggestedName })
});

contextBridge.exposeInMainWorld('tournament', {
  run: (entrants, bestOf, skill, format, bypassHandicaps) =>
    ipcRenderer.invoke('run-tournament', { entrants, bestOf, skill, format, bypassHandicaps }),
  cancel: () => ipcRenderer.invoke('cancel-batch'), // shares the batch worker's cancel channel, see main.js
  onProgress: (callback) => ipcRenderer.on('tournament-progress', (_event, msg) => callback(msg)),
  // Payload is {result, context} -- context (each entrant's decklist + resolved engine/mctsConfig)
  // rides along so the renderer can hand it straight to tournamentStore.save, or use it to replay any
  // individual match's game, without a separate round trip.
  onResult: (callback) => ipcRenderer.on('tournament-result', (_event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on('tournament-error', (_event, message) => callback(message))
});

contextBridge.exposeInMainWorld('tournamentStore', {
  list: () => ipcRenderer.invoke('list-tournaments'),
  save: (name, result, context) => ipcRenderer.invoke('save-tournament', { name, result, context }),
  delete: (name) => ipcRenderer.invoke('delete-tournament', name)
});

contextBridge.exposeInMainWorld('backup', {
  run: (selection) => ipcRenderer.invoke('backup-selected', selection)
});

contextBridge.exposeInMainWorld('changelog', {
  check: () => ipcRenderer.invoke('check-changelog')
});

contextBridge.exposeInMainWorld('updater', {
  download: () => ipcRenderer.invoke('download-update'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onStatus: (callback) => ipcRenderer.on('update-status', (_event, status) => callback(status))
});
