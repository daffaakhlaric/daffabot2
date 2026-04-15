"use strict";

/**
 * STRATEGY MODULE — Entry/Exit decision logic
 * Central export point for all strategy modules
 */

const btcStrategy = require("./btcStrategy");
const entryQualityFilter = require("./entryQualityFilter");

module.exports = {
  btcStrategy,
  entryQualityFilter,

  // For backward compatibility
  ...btcStrategy,
  ...entryQualityFilter,
};
