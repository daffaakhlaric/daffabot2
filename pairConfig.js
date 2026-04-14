"use strict";

/**
 * Pair Configuration — All supported trading pairs
 * Each pair defines: leverage, margin, AI/Bot-specific parameters
 */

const PAIRS = [
  {
    symbol: "BTCUSDT",
    displayName: "BTC/USDT",
    productType: "usdt-futures",
    leverage: 50,
    positionSizeUSDT: 0.40,
    minScore: 55,
    atrOptimalMin: 0.3,
    atrOptimalMax: 2.0,
    enabled: true,
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 50,
    botVolumeMin: 1.2,
    botSLPct: 0.7,
    botTrailActivate: 1.5,
  },
  {
    symbol: "ETHUSDT",
    displayName: "ETH/USDT",
    productType: "usdt-futures",
    leverage: 30,
    positionSizeUSDT: 0.50,
    minScore: 55,
    atrOptimalMin: 0.4,
    atrOptimalMax: 2.5,
    enabled: true,
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 50,
    botVolumeMin: 1.2,
    botSLPct: 0.8,
    botTrailActivate: 1.5,
  },
  {
    symbol: "SOLUSDT",
    displayName: "SOL/USDT",
    productType: "usdt-futures",
    leverage: 20,
    positionSizeUSDT: 0.60,
    minScore: 55,
    atrOptimalMin: 0.6,
    atrOptimalMax: 3.5,
    enabled: true,
    aiMinHTFConfidence: 60,
    aiMinSMCScore: 55,
    botEMAPeriod: 20,
    botVolumeMin: 1.3,
    botSLPct: 1.0,
    botTrailActivate: 1.8,
  },
  {
    symbol: "PEPEUSDT",
    displayName: "PEPE/USDT",
    productType: "usdt-futures",
    leverage: 20,
    positionSizeUSDT: 1.00,
    minScore: 60,
    atrOptimalMin: 0.8,
    atrOptimalMax: 5.0,
    enabled: true,
    aiMinHTFConfidence: 70,
    aiMinSMCScore: 65,
    botEMAPeriod: 20,
    botVolumeMin: 1.5,
    botSLPct: 1.2,
    botTrailActivate: 2.0,
  },
  {
    symbol: "BNBUSDT",
    displayName: "BNB/USDT",
    productType: "usdt-futures",
    leverage: 20,
    positionSizeUSDT: 0.60,
    minScore: 55,
    atrOptimalMin: 0.4,
    atrOptimalMax: 2.5,
    enabled: true,
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 50,
    botVolumeMin: 1.2,
    botSLPct: 0.8,
    botTrailActivate: 1.5,
  },
  {
    symbol: "XRPUSDT",
    displayName: "XRP/USDT",
    productType: "usdt-futures",
    leverage: 20,
    positionSizeUSDT: 0.60,
    minScore: 55,
    atrOptimalMin: 0.4,
    atrOptimalMax: 3.0,
    enabled: true,
    aiMinHTFConfidence: 65,
    aiMinSMCScore: 60,
    botEMAPeriod: 20,
    botVolumeMin: 1.3,
    botSLPct: 1.0,
    botTrailActivate: 1.8,
  },
];

function getPairBySymbol(symbol) {
  return PAIRS.find(p => p.symbol === symbol) || null;
}

function getEnabledPairs() {
  return PAIRS.filter(p => p.enabled);
}

module.exports = { PAIRS, getPairBySymbol, getEnabledPairs };
