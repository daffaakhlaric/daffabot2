"use strict";

/**
 * CORE MODULE — Fundamental trading engine
 * Exchange client, position management, basic analysis
 */

// These will be created/refactored during implementation
let exchangeClient;
let positionManager;

try {
  exchangeClient = require("./exchangeClient");
} catch (e) {
  // Will be created during refactoring
}

try {
  positionManager = require("./positionManager");
} catch (e) {
  // Will be created during refactoring
}

module.exports = {
  exchangeClient,
  positionManager,
};
