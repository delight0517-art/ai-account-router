'use strict';

// Stable Node package entry point for local consumers and the macOS handoff.
// No server starts on import; applications choose explicitly when to bind.
const { AccountLibraryEngine } = require('./AccountLibraryEngine.js');
const accountChain = require('./account-chain-v1.js');
const { OpenRouterCompatibleServer } = require('./server.js');
const client = require('./client.js');

module.exports = {
  AccountLibraryEngine,
  OpenRouterCompatibleServer,
  ...client,
  ...accountChain
};
