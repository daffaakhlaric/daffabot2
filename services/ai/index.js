"use strict";

/**
 * AI SERVICE — Claude AI integration
 */

const prompts = require("./prompts");

// Import claudeOrchestrator if it exists, otherwise create stub
let claudeOrchestrator;
try {
  claudeOrchestrator = require("./claudeOrchestrator");
} catch (e) {
  // File will be created during refactoring
  claudeOrchestrator = null;
}

module.exports = {
  prompts,
  claudeOrchestrator,
};
