"use strict";

/**
 * CONFIG MODULE — All configuration & constants
 * Centralized configuration management
 */

const pairConfig = require("./pairConfig");

// Constants for the trading bot
const CONSTANTS = {
  // Trading modes
  MODE: {
    SAFE: "SAFE",
    FAST: "FAST",
    DRY_RUN: "DRY_RUN",
  },

  // Position sides
  SIDE: {
    LONG: "LONG",
    SHORT: "SHORT",
  },

  // Trade statuses
  STATUS: {
    PENDING: "PENDING",
    OPEN: "OPEN",
    CLOSED: "CLOSED",
    FAILED: "FAILED",
  },

  // Market conditions
  MARKET_STATE: {
    TRENDING_BULL: "TRENDING_BULL",
    TRENDING_BEAR: "TRENDING_BEAR",
    RANGING: "RANGING",
    VOLATILE: "VOLATILE",
    UNKNOWN: "UNKNOWN",
  },

  // Psychological states
  PSYCH_STATE: {
    NORMAL: "NORMAL",
    TILT_RISK: "TILT_RISK",
    ON_TILT: "ON_TILT",
    EUPHORIA: "EUPHORIA",
    BOT_EUPHORIA: "BOT_EUPHORIA",
    FEAR_MODE: "FEAR_MODE",
  },

  // Time periods (ms)
  TIME: {
    MINUTE_1: 60 * 1000,
    MINUTE_5: 5 * 60 * 1000,
    MINUTE_15: 15 * 60 * 1000,
    HOUR_1: 60 * 60 * 1000,
    HOUR_4: 4 * 60 * 60 * 1000,
    DAY_1: 24 * 60 * 60 * 1000,
  },
};

module.exports = {
  pairConfig,
  CONSTANTS,

  // For backward compatibility
  ...pairConfig,
};
