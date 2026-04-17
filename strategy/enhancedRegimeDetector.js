"use strict";

/**
 * Enhanced Pair-Specific Market Regime Detector
 * Production-ready regime detection with proper indicators
 * 
 * Categories:
 * - MAJOR: BTC, ETH - smoother moves, trend following, normal leverage
 * - MID: SOL, BNB, LINK - moderate volatility, stricter pullback filters
 * - MEME: PEPE, BONK, WIF - high noise, only A+ setups, lower leverage
 * 
 * Indicators:
 * - EMA 20/50/200 for trend direction
 * - ATR for volatility measurement
 * - ADX for trend strength
 * - Volatility percentile for regime classification
 * - Session liquidity for entry timing
 */

const PAIR_CATEGORIES = {
  MAJOR: ["BTCUSDT", "ETHUSDT"],
  MID: ["SOLUSDT", "BNBUSDT", "XRPUSDT", "LINKUSDT", "ADAUSDT"],
  MEME: ["PEPEUSDT", "WIFUSDT", "BONKUSDT", "DOGEUSDT", "SHIBUSDT"],
};

const PAIR_THRESHOLDS = {
  MAJOR: {
    emaPeriods: [20, 50, 200],
    minTrendStrength: 0.45,
    minATR: 0.08,  // Lowered from 0.15 - allow micro-trends
    maxATR: 3.0,
    minADX: 12,    // Lowered from 15 - reduced ADX requirement
    chopThreshold: 0.5,  // Raised from 0.4 - less aggressive
    volatilityLookback: 50,
    volatilityPercentileLow: 5,   // Lowered from 10 - don't block on vol alone
    volatilityPercentileHigh: 90,
    minVolumeSpike: 1.1,
    minHoldSeconds: 120,
    allowedSessions: ["LONDON", "NY", "OVERLAP", "ASIAN"],
    leverage: 50,
    sizeMultiplier: 1.0,
  },
  MID: {
    emaPeriods: [20, 50, 100],
    minTrendStrength: 0.50,
    minATR: 0.12,  // Lowered from 0.25
    maxATR: 5.0,
    minADX: 14,    // Lowered from 18
    chopThreshold: 0.55,  // Raised from 0.45
    volatilityLookback: 40,
    volatilityPercentileLow: 5,   // Lowered from 15
    volatilityPercentileHigh: 85,
    minVolumeSpike: 1.2,
    minHoldSeconds: 150,
    allowedSessions: ["NY", "OVERLAP", "LONDON", "ASIAN"],
    leverage: 20,
    sizeMultiplier: 0.7,
  },
  MEME: {
    emaPeriods: [20, 50, 100],
    minTrendStrength: 0.55,
    minATR: 0.15,  // Lowered from 0.4 - allow smaller moves
    maxATR: 8.0,
    minADX: 16,    // Lowered from 20
    chopThreshold: 0.60,  // Raised from 0.5 - less choppy detection
    volatilityLookback: 30,
    volatilityPercentileLow: 5,   // Lowered from 20
    volatilityPercentileHigh: 80,
    minVolumeSpike: 1.2,  // Lowered from 1.5
    minHoldSeconds: 180,
    allowedSessions: ["NY", "OVERLAP", "LONDON", "ASIAN"],
    leverage: 15,
    sizeMultiplier: 0.3,
  },
};

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0;
  const k = klines.slice(-period - 1);
  let total = 0;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(
      k[i].high - k[i].low,
      Math.abs(k[i].high - k[i - 1].close),
      Math.abs(k[i].low - k[i - 1].close)
    );
    total += tr;
  }
  const atr = total / (k.length - 1);
  const price = k[k.length - 1].close;
  return price > 0 ? (atr / price) * 100 : 0;
}

function calcADX(klines, period = 14) {
  if (!klines || klines.length < period * 2) return 0;

  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const closes = klines.map(k => k.close);

  let plusDM = [], minusDM = [];
  
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const plusDI = ema(plusDM, period);
  const minusDI = ema(minusDM, period);
  
  if (!plusDI || !minusDI || plusDI + minusDI === 0) return 0;
  
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return ema([dx], period) || dx;
}

function calcEMAAligned(closes, periods) {
  const emas = periods.map(p => ({ period: p, value: ema(closes, p) }));
  
  if (emas.some(e => e.value === null)) return null;
  
  const lastIdx = closes.length - 1;
  const allAbove = emas.every(e => closes[lastIdx] > e.value);
  const allBelow = emas.every(e => closes[lastIdx] < e.value);
  
  if (allAbove) return "BULLISH";
  if (allBelow) return "BEARISH";
  return "NEUTRAL";
}

function calcVolatilityPercentile(klines, lookback = 50) {
  if (!klines || klines.length < lookback) return 50;
  
  const recent = klines.slice(-lookback);
  const atrValues = [];
  
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    );
    const price = recent[i].close;
    atrValues.push(price > 0 ? (tr / price) * 100 : 0);
  }
  
  if (atrValues.length < 10) return 50;
  
  const sorted = [...atrValues].sort((a, b) => a - b);
  const currentATR = atrValues[atrValues.length - 1];
  
  const percentile = sorted.findIndex(v => v >= currentATR) / sorted.length * 100;
  return Math.round(percentile);
}

function detectChopIndex(klines, emaPeriod = 20) {
  if (!klines || klines.length < 20) return { isChoppy: false, chopIndex: 0 };

  const closes = klines.slice(-20).map(k => k.close);
  const emaVal = ema(closes, emaPeriod);

  if (!emaVal) return { isChoppy: false, chopIndex: 0 };

  let emaCrosses = 0;
  for (let i = 1; i < closes.length; i++) {
    if ((closes[i - 1] > emaVal && closes[i] < emaVal) || 
        (closes[i - 1] < emaVal && closes[i] > emaVal)) {
      emaCrosses++;
    }
  }

  const avgDeviation = closes.reduce((sum, c) => sum + Math.abs(c - emaVal) / emaVal, 0) / closes.length;
  const chopIndex = (emaCrosses / 20) * 0.6 + (avgDeviation * 100) * 0.4;

  return {
    isChoppy: chopIndex > 0.4,
    chopIndex: Math.round(chopIndex * 100) / 100,
    emaCrosses,
    avgDeviation: Math.round(avgDeviation * 10000) / 100,
  };
}

function detectVolumeSpike(klines) {
  if (!klines || klines.length < 20) return { isSpike: false, ratio: 1, avgVol: 0 };

  const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
  const prev20Vol = klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0);
  const avgVol = prev20Vol / 15;

  const ratio = avgVol > 0 ? last5Vol / (avgVol * 5) : 1;
  return { 
    isSpike: ratio >= 1.5, 
    ratio: Math.round(ratio * 100) / 100,
    avgVol: Math.round(avgVol),
  };
}

function getCurrentSession() {
  const utcHour = new Date().getUTCHours();
  
  if (utcHour >= 0 && utcHour < 6) return "ASIAN";
  if (utcHour >= 7 && utcHour < 12) return "LONDON";
  if (utcHour >= 12 && utcHour < 17) return "OVERLAP";
  if (utcHour >= 13 && utcHour < 22) return "NY";
  if (utcHour >= 21 || utcHour < 1) return "NY_PM";
  
  return "UNKNOWN";
}

function getPairCategory(symbol) {
  if (PAIR_CATEGORIES.MAJOR.includes(symbol)) return "MAJOR";
  if (PAIR_CATEGORIES.MID.includes(symbol)) return "MID";
  if (PAIR_CATEGORIES.MEME.includes(symbol)) return "MEME";
  return "MID";
}

function getPairThresholds(symbol) {
  const category = getPairCategory(symbol);
  return PAIR_THRESHOLDS[category] || PAIR_THRESHOLDS.MID;
}

function detectTrendDirection(klines, thresholds) {
  if (!klines || klines.length < 10) return { direction: "UNKNOWN", strength: 0 };

  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);

  const emaAligned = calcEMAAligned(closes, thresholds.emaPeriods);
  
  const recent = klines.slice(-10);
  const hhCount = recent.filter((k, i) => i > 0 && k.high > highs[i - 1]).length;
  const llCount = recent.filter((k, i) => i > 0 && k.low < lows[i - 1]).length;

  const structuralStrength = Math.max(hhCount, llCount) / 9;
  
  let direction = "RANGING";
  if (emaAligned === "BULLISH" && structuralStrength >= thresholds.minTrendStrength) {
    direction = "TREND_UP";
  } else if (emaAligned === "BEARISH" && structuralStrength >= thresholds.minTrendStrength) {
    direction = "TREND_DOWN";
  } else if (emaAligned === "NEUTRAL" && structuralStrength < 0.3) {
    direction = "SIDEWAYS";
  }

  return { 
    direction, 
    strength: structuralStrength,
    emaAlignment: emaAligned,
  };
}

function detectPairRegime(klines, symbol) {
  const category = getPairCategory(symbol);
  const thresholds = getPairThresholds(symbol);

  if (!klines || klines.length < 50) {
    return {
      regime: "INSUFFICIENT_DATA",
      confidence: 0,
      category,
      canEnter: false,
      recommendations: ["Insufficient data for analysis"],
    };
  }

  const atr = calcATR(klines, 14);
  const adx = calcADX(klines, 14);
  const trend = detectTrendDirection(klines, thresholds);
  const chop = detectChopIndex(klines, thresholds.emaPeriods[0]);
  const volSpike = detectVolumeSpike(klines);
  const volPct = calcVolatilityPercentile(klines, thresholds.volatilityLookback);
  const session = getCurrentSession();

  const atrTooLow = atr < thresholds.minATR;
  const atrTooHigh = atr > thresholds.maxATR;
  const adxWeak = adx < thresholds.minADX;
  const isChoppy = chop.isChoppy && chop.chopIndex > thresholds.chopThreshold;

  let regime = "UNKNOWN";
  let confidence = 0;
  let recommendations = [];

  if (atrTooHigh && volPct > thresholds.volatilityPercentileHigh) {
    regime = "HIGH_VOL";
    confidence = Math.min(100, Math.round((atr / thresholds.maxATR) * 80));
    recommendations.push("BLOCK: Volatility spike - reduce position or disable entries");
  } else if (isChoppy && atrTooLow && volPct < thresholds.volatilityPercentileLow) {
    regime = "CHOP";
    confidence = Math.min(100, Math.round(chop.chopIndex * 150));
    recommendations.push("WARN: Market is choppy - require stronger confirmation");
  } else if (atrTooLow && trend.direction === "SIDEWAYS") {
    regime = "DEAD";
    confidence = 50;
    recommendations.push("WARN: Low volatility - reduce size or wait for movement");
  } else if (adxWeak && !trend.direction.includes("TREND")) {
    regime = "LOW_TREND_STRENGTH";
    confidence = Math.round((adx / thresholds.minADX) * 60);
    recommendations.push("WARN: Weak trend strength - require stronger confirmation");
  } else if (trend.direction === "TREND_UP" || trend.direction === "TREND_DOWN") {
    regime = trend.direction === "TREND_UP" ? "TRENDING_UP" : "TRENDING_DOWN";
    confidence = Math.round(trend.strength * 100);
    recommendations.push(`ALLOW: ${regime} - trade with trend`);
  } else {
    regime = "SIDEWAYS";
    confidence = 50;
    recommendations.push("SELECTIVE: Range-bound - require HTF alignment");
  }

  const sessionAllowed = thresholds.allowedSessions.includes(session);
  if (!sessionAllowed && regime !== "DEAD" && regime !== "CHOP") {
    recommendations.push(`SESSION: ${session} not optimal for ${category}`);
  }

  if (category === "MEME" && !volSpike.isSpike && regime !== "DEAD") {
    recommendations.push("VOLUME: MEME requires 1.5x volume spike");
  }

  const canEnter =
    !atrTooHigh &&
    sessionAllowed &&
    adx >= thresholds.minADX * 0.7 &&
    (isChoppy === false || (trend.direction.includes("TREND"))) &&
    (category !== "MEME" || volSpike.ratio >= 1.1);

  return {
    regime,
    confidence,
    category,
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    emaAlignment: trend.emaAlignment,
    atr: Math.round(atr * 100) / 100,
    adx: Math.round(adx * 10) / 10,
    isChoppy: chop.isChoppy,
    chopIndex: chop.chopIndex,
    volumeSpike: volSpike.isSpike,
    volumeRatio: volPct.ratio,
    volatilityPercentile: volPct,
    session,
    sessionAllowed,
    atrTooLow,
    atrTooHigh,
    adxWeak,
    thresholds,
    recommendations,
    canEnter,
    leverage: thresholds.leverage,
    sizeMultiplier: thresholds.sizeMultiplier,
    minHoldMs: thresholds.minHoldSeconds * 1000,
  };
}

function getTradeDirection(regime) {
  if (regime.regime === "TRENDING_UP") return "LONG";
  if (regime.regime === "TRENDING_DOWN") return "SHORT";
  if (regime.regime === "SIDEWAYS" && regime.trendDirection === "RANGING") return "HOLD";
  return "HOLD";
}

function shouldReduceSize(regime) {
  return (
    regime.volatilityPercentile > 70 ||
    regime.session === "ASIAN" ||
    regime.isChoppy
  );
}

module.exports = {
  PAIR_CATEGORIES,
  PAIR_THRESHOLDS,
  getPairCategory,
  getPairThresholds,
  detectPairRegime,
  getCurrentSession,
  detectChopIndex,
  detectVolumeSpike,
  calcATR,
  calcADX,
  getTradeDirection,
  shouldReduceSize,
};