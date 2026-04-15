"use strict";

/**
 * Market Regime Detector — Identifies ranging, trending, volatile market conditions
 * Helps bot avoid taking trades during choppy/ranging markets
 */

/**
 * Calculate ATR (Average True Range) from klines
 */
function calculateATR(klines, period = 14) {
  if (!klines || klines.length < period) return null;

  const tr = [];
  for (let i = 1; i < klines.length; i++) {
    const high = parseFloat(klines[i].high);
    const low = parseFloat(klines[i].low);
    const prevClose = parseFloat(klines[i - 1].close);
    const trueRange = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    tr.push(trueRange);
  }

  const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

/**
 * Calculate ATR as percentage of price
 */
function calculateATRPercent(klines, period = 14) {
  const atr = calculateATR(klines, period);
  if (!atr || klines.length === 0) return null;
  const price = parseFloat(klines[klines.length - 1].close);
  return (atr / price) * 100;
}

/**
 * Detect trend direction and strength from recent candles
 */
function detectTrendDirection(klines) {
  if (!klines || klines.length < 10) return { direction: "UNKNOWN", strength: 0 };

  const recent = klines.slice(-10);
  const highs = recent.map(k => parseFloat(k.high));
  const lows = recent.map(k => parseFloat(k.low));

  // Count higher highs / lower highs
  const hhCount = highs.filter((h, i) => i > 0 && h > highs[i - 1]).length;
  const llCount = lows.filter((l, i) => i > 0 && l < lows[i - 1]).length;

  const direction = hhCount >= 6 ? "BULLISH" : llCount >= 6 ? "BEARISH" : "CHOPPY";
  const strength = Math.max(hhCount, llCount) / 9; // 0-1 scale

  return { direction, strength };
}

/**
 * Detect ranging market — price oscillating between support/resistance
 */
function detectRangingMarket(klines) {
  if (!klines || klines.length < 20) return { isRanging: false, range: null, confidence: 0 };

  const recent = klines.slice(-20);
  const highs = recent.map(k => parseFloat(k.high));
  const lows = recent.map(k => parseFloat(k.low));

  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const rangeSize = highestHigh - lowestLow;
  const rangePercent = (rangeSize / lowestLow) * 100;

  // Range too wide = not ranging (volatile trending)
  if (rangePercent > 4) {
    return { isRanging: false, range: rangePercent, confidence: 0 };
  }

  // Count bounces off support/resistance (close to high/low multiple times)
  let bounceCount = 0;
  for (let i = 0; i < recent.length; i++) {
    const distFromHigh = (highestHigh - parseFloat(recent[i].close)) / rangeSize;
    const distFromLow = (parseFloat(recent[i].close) - lowestLow) / rangeSize;
    if (distFromHigh < 0.1 || distFromLow < 0.1) bounceCount++;
  }

  const isRanging = bounceCount >= 8; // 8+ touches of high/low = ranging
  const confidence = isRanging ? Math.min(100, bounceCount * 10) : 0;

  return {
    isRanging,
    range: rangePercent,
    supportLevel: lowestLow,
    resistanceLevel: highestHigh,
    confidence: Math.round(confidence),
  };
}

/**
 * Detect volatile spike — large ATR compared to recent average
 */
function detectVolatileSpike(klines) {
  if (!klines || klines.length < 30) return { isVolatile: false, spikeRatio: 1, confidence: 0 };

  const atrRecent = calculateATR(klines.slice(-15), 5);
  const atrHistorical = calculateATR(klines.slice(-30, -15), 5);

  if (!atrRecent || !atrHistorical || atrHistorical === 0) {
    return { isVolatile: false, spikeRatio: 1, confidence: 0 };
  }

  const ratio = atrRecent / atrHistorical;
  const isVolatile = ratio > 2.0; // 2x spike = volatile
  const confidence = isVolatile ? Math.min(100, (ratio - 1) * 25) : 0;

  return {
    isVolatile,
    spikeRatio: ratio.toFixed(2),
    confidence: Math.round(confidence),
  };
}

/**
 * MASTER: Detect overall market regime
 * Returns: TRENDING_BULL | TRENDING_BEAR | RANGING | VOLATILE | UNKNOWN
 */
function detectMarketRegime(klines) {
  if (!klines || klines.length < 20) {
    return { regime: "UNKNOWN", confidence: 0, details: {} };
  }

  const trend = detectTrendDirection(klines);
  const ranging = detectRangingMarket(klines);
  const volatile = detectVolatileSpike(klines);
  const atrPct = calculateATRPercent(klines);

  let regime = "UNKNOWN";
  let confidence = 0;

  // Priority: Volatile > Ranging > Trending
  if (volatile.isVolatile && volatile.confidence >= 60) {
    regime = "VOLATILE";
    confidence = volatile.confidence;
  } else if (ranging.isRanging && ranging.confidence >= 70) {
    regime = "RANGING";
    confidence = ranging.confidence;
  } else if (trend.direction === "BULLISH" && trend.strength >= 0.6) {
    regime = "TRENDING_BULL";
    confidence = Math.round(trend.strength * 100);
  } else if (trend.direction === "BEARISH" && trend.strength >= 0.6) {
    regime = "TRENDING_BEAR";
    confidence = Math.round(trend.strength * 100);
  }

  return {
    regime,
    confidence: Math.min(100, confidence),
    atrPercent: atrPct ? atrPct.toFixed(2) : null,
    trendDirection: trend.direction,
    trendStrength: trend.strength.toFixed(2),
    isRanging: ranging.isRanging,
    rangePercent: ranging.range.toFixed(2),
    isVolatile: volatile.isVolatile,
    volatilitySpike: volatile.spikeRatio,
    details: {
      support: ranging.supportLevel?.toFixed(2),
      resistance: ranging.resistanceLevel?.toFixed(2),
    },
  };
}

module.exports = {
  calculateATR,
  calculateATRPercent,
  detectTrendDirection,
  detectRangingMarket,
  detectVolatileSpike,
  detectMarketRegime,
};
