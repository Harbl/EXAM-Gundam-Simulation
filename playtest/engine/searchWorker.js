const { parentPort } = require('node:worker_threads');
const { runSearch, bestAction } = require('../../src/ai/mcts');
const { rehydrateDefs } = require('./stateTransfer');

// One persistent worker per game (spawned by aiController.js, terminated when the game ends) -- avoids
// paying Node's module-load cost (card JSON, effects registry) on every single atomic MCTS decision the
// way a fresh Worker per call would. Only ever one search in flight at a time (turnDriver.js awaits one
// controller call at once), so no request-id bookkeeping is needed -- one message in, one message out.
parentPort.on('message', ({ stateData, playerIdx, mctsConfig }) => {
  const state = rehydrateDefs(stateData);
  const root = runSearch(state, playerIdx, mctsConfig);
  parentPort.postMessage(bestAction(root));
});
