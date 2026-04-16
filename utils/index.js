"use strict";

/**
 * UTILS MODULE — Helper functions & utilities
 */

const time = require("./time");
const tpCalculator = require("./tpCalculator");

module.exports = {
  time,
  tpCalculator,

  // Direct exports
  ...time,
  ...tpCalculator,
};