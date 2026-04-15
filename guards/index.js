"use strict";

/**
 * GUARDS MODULE — Risk & Psychological Protection
 * Central export point for all guard modules
 */

const riskGuard = require("./riskGuard");
const psychGuard = require("./psychGuard");
const profitProtector = require("./profitProtector");
const riskTuning = require("./riskTuning");
const intraSessionLossGuard = require("./intraSessionLossGuard");  // ⭐ NEW

module.exports = {
  riskGuard,
  psychGuard,
  profitProtector,
  riskTuning,
  intraSessionLossGuard,  // ⭐ NEW EXPORT

  // For backward compatibility
  ...riskGuard,
  ...psychGuard,
  ...profitProtector,
};
