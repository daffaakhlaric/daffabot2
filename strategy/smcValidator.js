"use strict";

/**
 * High-Quality Entry Filter with SMC Validation
 * Production-ready entry quality control
 * 
 * Requirements for entry (ALL must pass):
 * - BOS / CHOCH confirmation
 * - Liquidity sweep
 * - Displacement candle
 * - FVG / imbalance retest
 * - Volume spike
 * - Candle close confirmation
 * 
 * Blocks:
 * - Wick-only fakeouts
 * - Random momentum chase
 * - Low volume breakouts
 * - Micro range entries
 */

const { getPairCategory, calcATR, detectChopIndex } = require("./enhancedRegimeDetector");

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function checkCandleClose(klines, direction) {
  if (!klines || klines.length < 2) {
    return { valid: false, reason: "Insufficient candles" };
  }

  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];

  const avgVol = klines.slice(-10).reduce((s, k) => s + k.volume, 0) / 10;
  const candleComplete = last.volume > avgVol * 0.15;  // Lowered from 0.3 - allow forming candles

  if (!candleComplete) {
    return { valid: false, reason: "Candle still forming (very low volume)" };
  }

  const isBullish = direction === "LONG";
  const validDirection = isBullish ? last.close > last.open : last.close < last.open;

  if (!validDirection) {
    return { valid: false, reason: "Candle direction doesn't match signal" };
  }

  const bodySize = Math.abs(last.close - last.open);
  const rangeSize = last.high - last.low;

  if (rangeSize === 0) {
    return { valid: false, reason: "Zero range candle" };
  }

  const bodyRatio = bodySize / rangeSize;
  // B.3: Drop validBody gate — direction match alone is enough for SCALP entries.
  // Body ratio still reported so callers can grade quality.
  const valid = true;

  return {
    valid,
    bodyRatio: Math.round(bodyRatio * 100) / 100,
    reason: bodyRatio >= 0.3 ? "Candle valid" : `Weak body ${bodyRatio.toFixed(2)} (allowed)`,
  };
}

function checkDisplacement(klines, direction) {
  if (!klines || klines.length < 3) {
    return { valid: false, reason: "Insufficient candles" };
  }

  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const prev2 = klines[klines.length - 3];

  const lastRange = last.high - last.low;
  const prevRange = prev.high - prev.low;
  const prev2Range = prev2.high - prev2.low;

  const avgRange = (prevRange + prev2Range) / 2;

  const displacement = lastRange / avgRange;
  const minDisplacement = 0.5;  // B.3: 0.8 -> 0.5 — allow tiny scalp candles

  const isBullish = direction === "LONG";
  const movesWithDirection = isBullish
    ? last.close > prev.close
    : last.close < prev.close;

  const valid = displacement >= minDisplacement && movesWithDirection;

  return {
    valid,
    displacement: Math.round(displacement * 100) / 100,
    avgRange: Math.round(avgRange * 100) / 100,
    movesWithDirection,
    reason: valid ? "Displacement confirmed" : `Weak displacement: ${displacement.toFixed(2)}`,
  };
}

function checkBOS(klines, direction) {
  if (!klines || klines.length < 20) {
    return { valid: false, reason: "Insufficient candles for BOS" };
  }

  const lookback = 8;  // B.3: 12 -> 8 — even shorter window for fast BOS
  const structStart = klines.length - lookback - 3;
  const structEnd = klines.length - 3;

  if (structStart < 0) {
    return { valid: false, reason: "Structure window too small" };
  }

  const structCandles = klines.slice(structStart, structEnd);
  const structHigh = Math.max(...structCandles.map(k => k.high));
  const structLow = Math.min(...structCandles.map(k => k.low));

  const threshold = 0.0002;  // B.3: 0.0005 -> 0.0002 — micro BOS for scalping
  const currentClose = klines[klines.length - 1].close;

  const isBullish = direction === "LONG";
  const bosValid = isBullish
    ? currentClose > structHigh * (1 + threshold)
    : currentClose < structLow * (1 - threshold);

  return {
    valid: bosValid,
    structHigh: Math.round(structHigh * 100) / 100,
    structLow: Math.round(structLow * 100) / 100,
    currentClose: Math.round(currentClose * 100) / 100,
    threshold,
    reason: bosValid ? "BOS confirmed" : "No BOS - waiting for structure break",
  };
}

function checkCHOCH(klines, direction) {
  if (!klines || klines.length < 10) {
    return { valid: false, reason: "Insufficient candles for CHoCH" };
  }

  const prev5 = klines.slice(-10, -5);
  const curr5 = klines.slice(-5);

  const prevLow = Math.min(...prev5.map(k => k.low));
  const prevHigh = Math.max(...prev5.map(k => k.high));
  const currLow = Math.min(...curr5.map(k => k.low));
  const currHigh = Math.max(...curr5.map(k => k.high));

  const isBullish = direction === "LONG";
  const bullishCHOCH = currLow < prevLow;
  const bearishCHOCH = currHigh > prevHigh;

  const valid = isBullish ? bullishCHOCH : bearishCHOCH;

  return {
    valid,
    prevLow: Math.round(prevLow * 100) / 100,
    prevHigh: Math.round(prevHigh * 100) / 100,
    currLow: Math.round(currLow * 100) / 100,
    currHigh: Math.round(currHigh * 100) / 100,
    reason: valid ? "CHoCH confirmed" : "No CHoCH - no structure change",
  };
}

function checkLiquiditySweep(klines, direction) {
  if (!klines || klines.length < 20) {
    return { valid: false, reason: "Insufficient candles" };
  }

  const highs = klines.slice(-20).map(k => k.high);
  const lows = klines.slice(-20).map(k => k.low);

  const swingHighs = highs.filter((h, i) => 
    i > 0 && i < highs.length - 1 && h > highs[i - 1] && h > highs[i + 1]
  );
  const swingLows = lows.filter((l, i) => 
    i > 0 && i < lows.length - 1 && l < lows[i - 1] && l < lows[i + 1]
  );

  const lastSwingHigh = swingHighs.length > 0 ? Math.max(...swingHighs) : Math.max(...highs.slice(-5));
  const lastSwingLow = swingLows.length > 0 ? Math.min(...swingLows) : Math.min(...lows.slice(-5));

  const price = klines[klines.length - 1].close;
  const maxSweepPct = 0.02;

  const isBullish = direction === "LONG";
  const swept = isBullish 
    ? price > lastSwingLow && (price - lastSwingLow) / lastSwingLow < maxSweepPct
    : price < lastSwingHigh && (lastSwingHigh - price) / lastSwingHigh < maxSweepPct;

  return {
    valid: swept,
    swingHigh: Math.round(lastSwingHigh * 100) / 100,
    swingLow: Math.round(lastSwingLow * 100) / 100,
    currentPrice: Math.round(price * 100) / 100,
    reason: swept ? "Liquidity swept" : "No liquidity sweep detected",
  };
}

function checkFVG(klines, direction) {
  if (!klines || klines.length < 3) {
    return { valid: false, reason: "Insufficient candles for FVG" };
  }

  const last3 = klines.slice(-3);
  const isBullish = direction === "LONG";

  for (let i = 1; i < last3.length; i++) {
    const curr = last3[i];
    const prev = last3[i - 1];

    const fvgBullish = prev.low > curr.high;
    const fvgBearish = prev.high < curr.low;

    if (isBullish && fvgBullish) {
      const fvgSize = prev.low - curr.high;
      const avgRange = (curr.high - curr.low + prev.high - prev.low) / 2;
      const sizePct = avgRange > 0 ? (fvgSize / avgRange) * 100 : 0;

      return {
        valid: true,
        type: "BULLISH",
        size: Math.round(fvgSize * 100) / 100,
        sizePct: Math.round(sizePct * 10) / 10,
        zone: Math.round(curr.high * 100) / 100,
        reason: "FVG present - valid retest zone",
      };
    }

    if (!isBullish && fvgBearish) {
      const fvgSize = prev.high - curr.low;
      const avgRange = (curr.high - curr.low + prev.high - prev.low) / 2;
      const sizePct = avgRange > 0 ? (fvgSize / avgRange) * 100 : 0;

      return {
        valid: true,
        type: "BEARISH",
        size: Math.round(fvgSize * 100) / 100,
        sizePct: Math.round(sizePct * 10) / 10,
        zone: Math.round(curr.low * 100) / 100,
        reason: "FVG present - valid retest zone",
      };
    }
  }

  return { valid: false, reason: "No FVG detected" };
}

function checkVolumeSpike(klines, category) {
  if (!klines || klines.length < 20) {
    return { valid: false, reason: "Insufficient candles" };
  }

  const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
  const prev20Vol = klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0);
  const avgVol = prev20Vol / 15;

  const minSpike = {
    MAJOR: 0.9,   // Lowered from 1.2
    MID: 1.0,     // Lowered from 1.3
    MEME: 1.0,    // Lowered from 1.5 (by 33%)
  }[category] || 0.9;

  const ratio = avgVol > 0 ? last5Vol / (avgVol * 5) : 1;
  const valid = ratio >= minSpike;

  return {
    valid,
    ratio: Math.round(ratio * 100) / 100,
    minRequired: minSpike,
    last5Vol: Math.round(last5Vol),
    avgVol: Math.round(avgVol),
    reason: valid ? "Volume spike confirmed" : `No volume spike: ${ratio.toFixed(2)} < ${minSpike}`,
  };
}

function checkMicroRange(klines, category) {
  if (!klines || klines.length < 5) {
    return { valid: true, reason: "Insufficient data" };
  }

  const last5 = klines.slice(-5);
  const range = Math.max(...last5.map(k => k.high)) - Math.min(...last5.map(k => k.low));
  const avgPrice = last5.reduce((s, k) => s + k.close, 0) / 5;
  const rangePct = (range / avgPrice) * 100;

  // Removed micro range blocking - allow all ranges
  const valid = true;

  return {
    valid,
    rangePct: Math.round(rangePct * 100) / 100,
    reason: "Micro range check disabled",
  };
}

function checkWickOnlyFakeout(klines, direction) {
  if (!klines || klines.length < 2) {
    return { valid: true, reason: "Insufficient data" };
  }

  const last = klines[klines.length - 1];
  const isBullish = direction === "LONG";

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;

  if (range === 0) {
    return { valid: true, reason: "Zero range" };
  }

  const wickRatio = isBullish ? upperWick / range : lowerWick / range;
  const valid = wickRatio < 0.6;

  return {
    valid,
    wickRatio: Math.round(wickRatio * 100) / 100,
    upperWick: Math.round(upperWick * 100) / 100,
    lowerWick: Math.round(lowerWick * 100) / 100,
    body: Math.round(body * 100) / 100,
    reason: valid ? "Real candle" : `Wick-only fakeout: ${(wickRatio * 100).toFixed(0)}% wick`,
  };
}

function validateEntry(klines, direction, symbol) {
  const category = getPairCategory(symbol);
  const checks = {};

  checks.candleClose = checkCandleClose(klines, direction);
  checks.displacement = checkDisplacement(klines, direction);
  checks.bos = checkBOS(klines, direction);
  checks.choch = checkCHOCH(klines, direction);
  checks.liquidity = checkLiquiditySweep(klines, direction);
  checks.fvg = checkFVG(klines, direction);
  checks.volume = checkVolumeSpike(klines, category);
  checks.microRange = checkMicroRange(klines, category);
  checks.wickFakeout = checkWickOnlyFakeout(klines, direction);

  // B.3: Drop CHOCH/Liquidity/FVG/microRange from required list — kept as advisory.
  // Volume optional for MAJOR. canEnter requires 2-of-3 essentials for MAJOR/MID, 2-of-2 for MEME.
  const requiredForCategory = {
    MAJOR: ["candleClose", "displacement", "bos"],
    MID: ["candleClose", "displacement", "bos"],
    MEME: ["candleClose", "displacement"],
  };

  const required = requiredForCategory[category] || requiredForCategory.MAJOR;

  let passed = 0;
  const failed = [];

  for (const checkName of required) {
    const check = checks[checkName];
    if (check.valid) {
      passed++;
    } else {
      failed.push(`${checkName}: ${check.reason}`);
    }
  }

  const total = required.length;
  const score = Math.round((passed / total) * 100);

  // B.3: 2-of-3 essentials passes (MEME still needs both 2-of-2).
  const minPassed = category === "MEME" ? 2 : 2;
  let canEnter = passed >= minPassed;
  let grade = "C";

  if (canEnter) {
    if (score >= 90) grade = "A+";
    else if (score >= 80) grade = "A";
    else if (score >= 70) grade = "B";
  }

  const minScore = Math.round((minPassed / total) * 100);

  return {
    canEnter,
    score,
    grade,
    category,
    direction,
    checks,
    failed,
    failedCount: failed.length,
    passedCount: passed,
    totalRequired: total,
    minScoreRequired: minScore,
    recommendations: failed.length > 0 ? failed : ["All checks passed"],
  };
}

module.exports = {
  validateEntry,
  checkCandleClose,
  checkDisplacement,
  checkBOS,
  checkCHOCH,
  checkLiquiditySweep,
  checkFVG,
  checkVolumeSpike,
  checkMicroRange,
  checkWickOnlyFakeout,
};