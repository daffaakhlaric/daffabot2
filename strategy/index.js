"use strict";

/**
 * STRATEGY MODULE — Entry/Exit decision logic
 * Central export point for all strategy modules
 * 
 * Multi-pair system:
 * - multiPairStrategy: Primary strategy (pair-specific regime detection)
 * - btcStrategy: Fallback/legacy strategy
 * - pairRegimeDetector: Regime detection per pair category
 * - antiFakeout: Anti-whipsaw protection
 * - tpExitManager: Pair-specific TP/Exit logic
 */

const multiPairStrategy = require("./multiPairStrategy");
const btcStrategy = require("./btcStrategy");
const pairRegimeDetector = require("./pairRegimeDetector");
const antiFakeout = require("./antiFakeout");
const tpExitManager = require("./tpExitManager");
const pairScorer = require("./pairScorer");

module.exports = {
  // Primary strategy
  multiPairStrategy,
  
  // Fallback strategy
  btcStrategy,
  
  // Utilities
  pairRegimeDetector,
  antiFakeout,
  tpExitManager,
  pairScorer,
  
  // Legacy exports
  analyze: multiPairStrategy.analyze,
};