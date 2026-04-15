"use strict";

/**
 * UTILS MODULE — Helper functions & utilities
 */

const helpers = require("./helpers");
const logger = require("./logger");
const time = require("./time");
const validation = require("./validation");
const marketRegimeDetector = require("./marketRegimeDetector");
const tpCalculator = require("./tpCalculator");

module.exports = {
  helpers,
  logger,
  time,
  validation,
  marketRegimeDetector,
  tpCalculator,

  // Direct exports
  ...helpers,
  ...logger,
  ...time,
  ...validation,
  ...marketRegimeDetector,
  ...tpCalculator,
};
