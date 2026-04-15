"use strict";

/**
 * STRATEGY MODULE — Entry/Exit decision logic
 * Central export point for all strategy modules
 */

const btcStrategy = require("./btcStrategy");
const entryQualityFilter = require("./entryQualityFilter");
const sessionFilter = require("./sessionFilter");
const pairRotation = require("./pairRotation");
const entryProtocol = require("./entryProtocol");

module.exports = {
  btcStrategy,
  entryQualityFilter,
  sessionFilter,
  pairRotation,
  entryProtocol,

  // For backward compatibility
  ...btcStrategy,
  ...entryQualityFilter,
};
