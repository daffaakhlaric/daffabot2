"use strict";

/**
 * STRATEGY MODULE — Entry/Exit decision logic
 * Central export point for all strategy modules
 */

const btcStrategy = require("./btcStrategy");
const entryQualityFilter = require("./entryQualityFilter");
const sessionFilter = require("./sessionFilter");

module.exports = {
  btcStrategy,
  entryQualityFilter,
  sessionFilter,

  // For backward compatibility
  ...btcStrategy,
  ...entryQualityFilter,
};
