"use strict";

/**
 * Pair Configuration — All supported trading pairs
 * Enhanced with pair-specific parameters for multi-pair trading
 * 
 * Categories:
 * - MAJOR: BTC, ETH - smoother moves, trend following
 * - MID: SOL, BNB, LINK - moderate volatility, stricter pullback
 * - MEME: PEPE, WIF - high noise, volume spike required
 */

const PAIRS = [
  // === MAJOR PAIRS ===
  {
    symbol: "BTCUSDT",
    exchangeSymbol: "BTC-USDT",
    displayName: "BTC/USDT",
    productType: "perpetual",
    category: "MAJOR",

    // === 150x CROSS — $57 CAPITAL ===
    leverage: 150,
    marginMode: "CROSSED",
    positionSizeUSDT: 2,            // $2 margin × 150 = $300 notional (3.5% equity per trade)

    // === TIGHT SL/TP FOR 150x ===
    botSLPct: 0.25,                 // 0.25% SL (liqui ~0.66%, 2.6x buffer)
    tp1Pct: 0.30,                   // TP1 → 50% close (quick profit)
    tp2Pct: 0.50,                   // TP2 → 30% close
    tp3Pct: 0.80,                   // TP3 → 20% close (runner)
    botTrailActivate: 0.35,
    trailDrop: 0.15,
    breakEvenTriggerPct: 0.20,      // Move SL to BE at +0.20%

    // === RELAXED ENTRY FILTERS (was 65/70/75) ===
    minScore: 50,                   // was 65 — allow B-grade
    minScoreTrend: 55,              // was 70
    minScoreSniper: 65,             // was 75

    // === BROADER VOLATILITY RANGE ===
    atrOptimalMin: 0.08,            // was 0.3 — allow low-vol scalps
    atrOptimalMax: 2.5,             // was 2.0

    // === ALL SESSIONS ALLOWED (was LONDON/NY only) ===
    allowedSessions: ["LONDON", "NY", "OVERLAP", "ASIAN", "PRE_LONDON"],

    // === SHORT HOLD (scalping) ===
    minHoldMinutes: 0.5,            // was 2 — allow 30s scalps
    minVolumeSpike: 1.0,            // was 1.2 — removed mandatory spike
    requireVolumeSpike: false,

    // === LOWER AI THRESHOLDS ===
    aiMinHTFConfidence: 50,         // was 60
    aiMinSMCScore: 45,              // was 55
    botEMAPeriod: 20,               // was 50 — faster signal
    botVolumeMin: 1.0,              // was 1.2

    priority: 1,
    enabled: true,
  },
  {
    symbol: "ETHUSDT",
    displayName: "ETH/USDT",
    productType: "usdt-futures",
    category: "MAJOR",
    leverage: 30,
    positionSizeUSDT: 0.50,
    
    minScore: 65,
    minScoreTrend: 70,
    minScoreSniper: 75,
    atrOptimalMin: 0.4,
    atrOptimalMax: 2.5,
    botSLPct: 0.7,
    botTrailActivate: 1.2,
    trailDrop: 0.4,
    allowedSessions: ["LONDON", "NY", "OVERLAP"],
    minHoldMinutes: 2,
    minVolumeSpike: 1.2,
    requireVolumeSpike: false,
    aiMinHTFConfidence: 60,
    aiMinSMCScore: 55,
    botEMAPeriod: 50,
    botVolumeMin: 1.2,
    
    priority: 2,
    enabled: true,
  },
  
  // === MID CAP PAIRS ===
  {
    symbol: "SOLUSDT",
    displayName: "SOL/USDT",
    productType: "usdt-futures",
    category: "MID",
    leverage: 20,
    positionSizeUSDT: 0.42, // 0.7x size reduction
    
    minScore: 70,
    minScoreTrend: 75,
    minScoreSniper: 80,
    atrOptimalMin: 0.6,
    atrOptimalMax: 3.5,
    botSLPct: 0.8, // Wider SL for volatility
    botTrailActivate: 1.5,
    trailDrop: 0.5,
    allowedSessions: ["NY", "OVERLAP"], // Exclude low liquidity London
    minHoldMinutes: 2.5,
    minVolumeSpike: 1.3,
    requireVolumeSpike: false, // Not mandatory for mid caps
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 20,
    botVolumeMin: 1.3,
    
    priority: 3,
    enabled: true,
  },
  {
    symbol: "BNBUSDT",
    displayName: "BNB/USDT",
    productType: "usdt-futures",
    category: "MID",
    leverage: 20,
    positionSizeUSDT: 0.42,
    
    minScore: 70,
    minScoreTrend: 75,
    minScoreSniper: 80,
    atrOptimalMin: 0.4,
    atrOptimalMax: 2.5,
    botSLPct: 0.7,
    botTrailActivate: 1.5,
    trailDrop: 0.5,
    allowedSessions: ["NY", "OVERLAP"],
    minHoldMinutes: 2.5,
    minVolumeSpike: 1.3,
    requireVolumeSpike: false,
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 50,
    botVolumeMin: 1.2,
    
    priority: 4,
    enabled: true,
  },
  {
    symbol: "XRPUSDT",
    displayName: "XRP/USDT",
    productType: "usdt-futures",
    category: "MID",
    leverage: 20,
    positionSizeUSDT: 0.42,
    
    minScore: 70,
    minScoreTrend: 75,
    minScoreSniper: 80,
    atrOptimalMin: 0.4,
    atrOptimalMax: 3.0,
    botSLPct: 0.8,
    botTrailActivate: 1.8,
    trailDrop: 0.5,
    allowedSessions: ["NY", "OVERLAP"],
    minHoldMinutes: 2.5,
    minVolumeSpike: 1.3,
    requireVolumeSpike: false,
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 20,
    botVolumeMin: 1.3,
    
    priority: 5,
    enabled: true,
  },
  
  // === HIGH-RISK MEME PAIRS ===
  {
    symbol: "PEPEUSDT",
    displayName: "PEPE/USDT",
    productType: "usdt-futures",
    category: "MEME",
    leverage: 15, // Lower leverage for high volatility
    positionSizeUSDT: 0.30, // 0.3x size - significantly reduced
    
    // Stricter filters for memes
    minScore: 80,      // Only A/A+ setups
    minScoreTrend: 85,
    minScoreSniper: 90,
    
    // Wider ATR range for memes
    atrOptimalMin: 0.8,
    atrOptimalMax: 5.0,
    
    // Wider SL, more patient TP
    botSLPct: 1.0,
    botTrailActivate: 2.0,
    trailDrop: 0.6,
    
    // ONLY NY session for memes
    allowedSessions: ["NY"],
    
    // Stricter anti-fakeout
    minHoldMinutes: 3,
    minVolumeSpike: 1.5,
    requireVolumeSpike: true, // MUST have volume spike
    
    aiMinHTFConfidence: 75,
    aiMinSMCScore: 70,
    botEMAPeriod: 20,
    botVolumeMin: 1.5,
    
    priority: 7, // Lowest priority
    enabled: true,
  },
  {
    symbol: "DOGEUSDT",
    displayName: "DOGE/USDT",
    productType: "usdt-futures",
    category: "MEME",
    leverage: 15,
    positionSizeUSDT: 0.30,
    
    minScore: 80,
    minScoreTrend: 85,
    minScoreSniper: 90,
    atrOptimalMin: 0.8,
    atrOptimalMax: 5.0,
    botSLPct: 1.0,
    botTrailActivate: 2.0,
    trailDrop: 0.6,
    allowedSessions: ["NY"],
    minHoldMinutes: 3,
    minVolumeSpike: 1.5,
    requireVolumeSpike: true,
    aiMinHTFConfidence: 75,
    aiMinSMCScore: 70,
    botEMAPeriod: 20,
    botVolumeMin: 1.5,
    
    priority: 7,
    enabled: true,
  },
];

function getPairBySymbol(symbol) {
  return PAIRS.find(p => p.symbol === symbol) || null;
}

function getEnabledPairs() {
  return PAIRS.filter(p => p.enabled);
}

function getPairsByCategory(category) {
  return PAIRS.filter(p => p.category === category);
}

function getPairCategory(symbol) {
  const pair = getPairBySymbol(symbol);
  return pair?.category || "MID";
}

// Size multipliers for risk management
function getSizeMultiplier(symbol) {
  const category = getPairCategory(symbol);
  return {
    MAJOR: 1.0,
    MID: 0.7,
    MEME: 0.3,
  }[category] || 1.0;
}

// Leverage adjustments
function getAdjustedLeverage(symbol, marketRegime) {
  const pair = getPairBySymbol(symbol);
  if (!pair) return 20;

  let leverage = pair.leverage;

  // Reduce leverage in chop
  if (marketRegime === "CHOP" || marketRegime === "RANGE") {
    leverage = Math.floor(leverage * 0.5);
  }
  // Reduce in high volatility
  else if (marketRegime === "HIGH_VOL") {
    leverage = Math.floor(leverage * 0.3);
  }

  return Math.max(5, leverage); // Min 5x
}

module.exports = {
  PAIRS,
  getPairBySymbol,
  getEnabledPairs,
  getPairsByCategory,
  getPairCategory,
  getSizeMultiplier,
  getAdjustedLeverage,
};