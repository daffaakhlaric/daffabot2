"use strict";

/**
 * STRATEGY MODULE — Entry/Exit decision logic
 * Central export point for all strategy modules
 * 
 * Multi-pair system (v2.0):
 * - multiPairStrategy: Primary strategy
 * - enhancedRegimeDetector: Pair-specific regime detection (NEW)
 * - smcValidator: SMC validation (NEW)
 * - signalScoringEngine: A/A+ scoring (NEW)
 * - fastTradeFix: Min hold enforcement (NEW)
 * - cooldownManager: Reentry protection (NEW)
 * - enhancedSessionFilter: Session optimization (NEW)
 * - mtfEngine: Multi-timeframe analysis (NEW)
 */

const multiPairStrategy = require("./multiPairStrategy");
const btcStrategy = require("./btcStrategy");
const enhancedRegimeDetector = require("./enhancedRegimeDetector");
const smcValidator = require("./smcValidator");
const signalScoringEngine = require("./signalScoringEngine");
const fastTradeFix = require("./fastTradeFix");
const cooldownManager = require("./cooldownManager");
const enhancedSessionFilter = require("./enhancedSessionFilter");
const mtfEngine = require("./mtfEngine");
const tpExitManager = require("./tpExitManager");
const pairScorer = require("./pairScorer");

module.exports = {
  multiPairStrategy,
  btcStrategy,
  
  // New modules (v2.0)
  enhancedRegimeDetector,
  smcValidator,
  signalScoringEngine,
  fastTradeFix,
  cooldownManager,
  enhancedSessionFilter,
  mtfEngine,
  
  // Utilities
  tpExitManager,
  pairScorer,
  
  // Legacy export
  analyze: multiPairStrategy.analyze,
};