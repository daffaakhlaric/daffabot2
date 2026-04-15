"use strict";

/**
 * GUARDS MODULE — Risk & Psychological Protection
 * Central export point for all guard modules
 */

const riskGuard = require("./riskGuard");
const psychGuard = require("./psychGuard");
const profitProtector = require("./profitProtector");

module.exports = {
  riskGuard,
  psychGuard,
  profitProtector,

  // For backward compatibility
  ...riskGuard,
  ...psychGuard,
  ...profitProtector,
};
