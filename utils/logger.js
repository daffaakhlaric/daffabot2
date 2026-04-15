"use strict";

/**
 * LOGGER — Centralized logging utility
 */

// Simple structured logging
function log(msg, data = null) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);

  // Store in global.botState if available
  if (typeof global !== "undefined" && global.botState) {
    global.botState.logs = global.botState.logs || [];
    global.botState.logs.push({ ts: Date.now(), msg });
    if (global.botState.logs.length > 200) {
      global.botState.logs.shift();
    }
  }

  return line;
}

function warn(msg) {
  console.warn(`⚠️  [${new Date().toLocaleTimeString()}] ${msg}`);
}

function error(msg) {
  console.error(`❌ [${new Date().toLocaleTimeString()}] ${msg}`);
}

function debug(msg) {
  if (process.env.DEBUG === "true") {
    console.log(`🐛 [${new Date().toLocaleTimeString()}] ${msg}`);
  }
}

module.exports = {
  log,
  warn,
  error,
  debug,
};
