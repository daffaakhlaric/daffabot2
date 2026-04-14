"use strict";

/**
 * Pair Scoring Engine — Pure technical analysis, zero side effects
 * Scores pairs 0-100 based on trend, volume, ATR, momentum, session
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

function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0;
  const k = klines.slice(-period - 1);
  let total = 0;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(
      k[i].high - k[i].low,
      Math.abs(k[i].high - k[i-1].close),
      Math.abs(k[i].low - k[i-1].close)
    );
    total += tr;
  }
  const atr = total / period;
  const price = k[k.length - 1].close;
  return (atr / price) * 100;
}

function calcSlope(klines, period, lookback = 5) {
  if (!klines || klines.length < period + lookback) return 0;
  const closes = klines.map(k => k.close);
  const emaNow = ema(closes, period);
  const emaAgo = ema(closes.slice(0, -lookback), period);
  if (!emaNow || !emaAgo) return 0;
  return ((emaNow - emaAgo) / emaAgo) * 100;
}

function detectSaturation(klines) {
  if (!klines || klines.length < 20) return false;

  const last20 = klines.slice(-20);
  const minLow = Math.min(...last20.map(k => k.low));
  const maxHigh = Math.max(...last20.map(k => k.high));
  const moveRatio = ((maxHigh - minLow) / minLow) * 100;

  // >3% move in 20min = saturated
  if (moveRatio > 3) return true;

  // Count doji (small body relative to range)
  let dojiCount = 0;
  for (let i = 0; i < last20.length; i++) {
    const k = last20[i];
    const range = k.high - k.low;
    const body = Math.abs(k.close - k.open);
    if (range > 0 && body < range * 0.2) dojiCount++;
  }
  if (dojiCount >= 7) return true;

  // Volume declining 3 consecutive
  const lastVol = last20.slice(-3);
  if (lastVol[0].volume > lastVol[1].volume &&
      lastVol[1].volume > lastVol[2].volume) {
    const lastClose = last20.slice(-3);
    if (lastClose[0].close > lastClose[1].close &&
        lastClose[1].close > lastClose[2].close) {
      return true;
    }
  }

  return false;
}

function scorePair({ klines, price, pairConfig, whaleSignal }) {
  if (!klines || klines.length < 50) {
    return {
      score: 0,
      breakdown: { trend: 0, volume: 0, atr: 0, momentum: 0, session: 0, bonus: 0 },
      trend_direction: "RANGING",
      isSaturated: false,
      saturationReasons: [],
      recommendation: "AVOID",
      notes: "Insufficient data",
    };
  }

  const closes = klines.map(k => k.close);
  const ema50 = ema(closes, 50);
  const ema20 = ema(closes, 20);
  const slope = calcSlope(klines, 50);

  let scores = {};
  let trendDir = "RANGING";

  // A. Trend Strength (25 pts max)
  let trendScore = 5;
  const emaCrosses = countEMACrosses(closes, ema50, 20);

  if (price > ema20 && ema20 > ema50 && slope > 0.05 && emaCrosses < 2) {
    trendScore = 25;
    trendDir = "BULLISH";
  } else if (price < ema20 && ema20 < ema50 && slope < -0.05 && emaCrosses < 2) {
    trendScore = 25;
    trendDir = "BEARISH";
  } else if ((price > ema20 && ema20 > ema50) || (price < ema20 && ema20 < ema50)) {
    trendScore = 15;
    trendDir = emaCrosses < 2 ? "BULLISH" : "BEARISH";
  } else if (emaCrosses >= 2 && emaCrosses <= 3) {
    trendScore = 10;
    trendDir = "RANGING";
  } else if (emaCrosses >= 4) {
    trendScore = 5;
    trendDir = "RANGING";
  }
  scores.trend = trendScore;

  // B. Volume Anomaly (20 pts max)
  const avgVol = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = klines[klines.length - 1].volume / avgVol;
  let volScore = 5;
  if (volRatio >= 2.0) volScore = 20;
  else if (volRatio >= 1.5) volScore = 15;
  else if (volRatio >= 1.2) volScore = 10;
  scores.volume = volScore;

  // C. ATR Quality (20 pts max)
  const atrPct = calcATR(klines, 14);
  let atrScore = 3;
  if (atrPct >= pairConfig.atrOptimalMin && atrPct <= pairConfig.atrOptimalMax) {
    atrScore = 20;
  } else if (atrPct >= pairConfig.atrOptimalMin * 0.8 && atrPct <= pairConfig.atrOptimalMax * 1.2) {
    atrScore = 12;
  } else if (atrPct < pairConfig.atrOptimalMin) {
    atrScore = 5;
  }
  scores.atr = atrScore;

  // D. Momentum (20 pts max)
  const last5Close = closes.slice(-5);
  const prev5Close = closes.slice(-10, -5);
  const lastAvg = last5Close.reduce((s, c) => s + c, 0) / 5;
  const prevAvg = prev5Close.reduce((s, c) => s + c, 0) / 5;
  const momentum = ((lastAvg - prevAvg) / prevAvg) * 100;

  const last5Vol = klines.slice(-5);
  const prev5Vol = klines.slice(-10, -5);
  const lastAvgVol = last5Vol.reduce((s, k) => s + k.volume, 0) / 5;
  const prevAvgVol = prev5Vol.reduce((s, k) => s + k.volume, 0) / 5;
  const volIncreasing = lastAvgVol >= prevAvgVol;

  let momScore = 6;
  if (Math.abs(momentum) > 0.3 && volIncreasing) {
    momScore = 20;
  } else if (Math.abs(momentum) > 0.1 && volIncreasing) {
    momScore = 14;
  }
  if (momentum < 0 && trendDir === "BULLISH") momScore -= 5;
  if (momentum > 0 && trendDir === "BEARISH") momScore -= 5;
  momScore = Math.max(0, momScore);
  scores.momentum = momScore;

  // E. Session Alignment (15 pts max)
  const utcHour = new Date().getUTCHours();
  const utcMin = new Date().getUTCMinutes();
  let sessionScore = 3;
  if ((utcHour === 7 || utcHour === 8) && utcMin < 60) sessionScore = 15; // London Open
  else if ((utcHour === 13 || utcHour === 14 || utcHour === 15) && utcMin < 60) sessionScore = 15; // NY Open
  else if (utcHour === 11 || utcHour === 12) sessionScore = 10; // London Close
  else if (utcHour === 0 || utcHour === 1) sessionScore = 12; // Asian KZ
  else if (utcHour === 17 || utcHour === 18) sessionScore = 8; // NY PM
  scores.session = sessionScore;

  // Bonus Points
  let bonusScore = 0;

  // Whale signal bonus
  if (whaleSignal && whaleSignal.whaleDetected && whaleSignal.confidence > 70) {
    bonusScore += 8;
  }

  // BOS detection
  const last10High = Math.max(...klines.slice(-10, -1).map(k => k.high));
  const last10Low = Math.min(...klines.slice(-10, -1).map(k => k.low));
  if (closes[closes.length - 1] > last10High * 1.001) bonusScore += 7;
  if (closes[closes.length - 1] < last10Low * 0.999) bonusScore += 7;

  scores.bonus = bonusScore;

  // Calculate final score (max 100)
  const rawScore = scores.trend + scores.volume + scores.atr + scores.momentum + scores.session + scores.bonus;
  const finalScore = Math.min(100, Math.max(0, rawScore));

  // Saturation detection
  const isSaturated = detectSaturation(klines);
  const saturationReasons = isSaturated ? ["High volatility or price moved >3% in 20 candles"] : [];

  // Recommendation
  let recommendation = "WATCH";
  if (finalScore >= pairConfig.minScore && !isSaturated) recommendation = "TRADE";
  else if (finalScore < 40 || isSaturated) recommendation = "AVOID";

  const notes = `Trend: ${trendDir} (${trendScore}pts), ATR: ${atrPct.toFixed(2)}%, Vol: ${volRatio.toFixed(2)}x`;

  return {
    score: Math.round(finalScore),
    breakdown: scores,
    trend_direction: trendDir,
    isSaturated,
    saturationReasons,
    recommendation,
    notes,
  };
}

function countEMACrosses(closes, ema, lookback) {
  if (!ema) return 999;
  let crosses = 0;
  const recentCloses = closes.slice(-lookback - 1);
  for (let i = 1; i < recentCloses.length; i++) {
    const prevCross = (recentCloses[i - 1] > ema) !== (recentCloses[i] > ema);
    if (prevCross) crosses++;
  }
  return crosses;
}

module.exports = { scorePair, calcATR, calcEMA: ema, calcSlope, detectSaturation };
