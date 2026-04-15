"use strict";

/**
 * HELPERS — Mathematical & analytical helper functions
 * Extracted from btcStrategy and other modules for reusability
 */

/**
 * Calculate Exponential Moving Average
 */
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

/**
 * Calculate Simple Moving Average
 */
function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate Average True Range
 */
function atr(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < period + 1) return 0;

  const k = klines.slice(-(period + 1));
  let total = 0;

  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(
      k[i].high - k[i].low,
      Math.abs(k[i].high - k[i-1].close),
      Math.abs(k[i].low - k[i-1].close)
    );
    total += tr;
  }

  return total / period;
}

/**
 * Calculate ATR percentage of price
 */
function atrPercent(klines, price, period = 14) {
  const atrValue = atr(klines, period);
  return price > 0 ? (atrValue / price) * 100 : 0;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < values.length; i++) {
    changes.push(values[i] - values[i-1]);
  }

  const gains = changes.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = Math.abs(changes.filter(c => c < 0).reduce((a, b) => a + b, 0)) / period;

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(values) || values.length < slowPeriod) return null;

  const ema12 = ema(values, fastPeriod);
  const ema26 = ema(values, slowPeriod);

  if (!ema12 || !ema26) return null;

  const macdLine = ema12 - ema26;
  const signalLine = ema([...values], signalPeriod);

  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - (signalLine || 0),
  };
}

/**
 * Calculate Bollinger Bands
 */
function bollingerBands(values, period = 20, stdDev = 2) {
  if (!Array.isArray(values) || values.length < period) return null;

  const recentValues = values.slice(-period);
  const smaValue = recentValues.reduce((a, b) => a + b, 0) / period;
  const variance = recentValues.reduce((a, b) => a + Math.pow(b - smaValue, 2), 0) / period;
  const stdDevValue = Math.sqrt(variance);

  return {
    upper: smaValue + (stdDev * stdDevValue),
    middle: smaValue,
    lower: smaValue - (stdDev * stdDevValue),
    bandwidth: (2 * stdDev * stdDevValue) / smaValue,
  };
}

/**
 * Calculate percentage change
 */
function percentChange(oldValue, newValue) {
  if (oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Round to N decimal places
 */
function round(num, decimals = 2) {
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Find highest value in array
 */
function highest(values) {
  return Math.max(...values);
}

/**
 * Find lowest value in array
 */
function lowest(values) {
  return Math.min(...values);
}

/**
 * Get price range (high - low)
 */
function priceRange(high, low) {
  return high - low;
}

/**
 * Calculate risk to reward ratio
 */
function riskToReward(entry, stop, target, side = "LONG") {
  if (side === "LONG") {
    const risk = entry - stop;
    const reward = target - entry;
    return risk > 0 ? reward / risk : 0;
  } else {
    const risk = stop - entry;
    const reward = entry - target;
    return risk > 0 ? reward / risk : 0;
  }
}

module.exports = {
  ema,
  sma,
  atr,
  atrPercent,
  rsi,
  macd,
  bollingerBands,
  percentChange,
  round,
  highest,
  lowest,
  priceRange,
  riskToReward,
};
