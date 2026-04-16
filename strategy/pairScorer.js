"use strict";

/**
 * Enhanced Pair Scorer with Pair-Specific Regime Detection
 * Uses enhancedRegimeDetector for category-aware scoring
 */

const { detectPairRegime, getBTCSentiment, adjustForBTCSentiment, getPairCategory: getCategory } = require("./enhancedRegimeDetector");

function getPairCategory(symbol) {
  return getCategory(symbol);
}

const PAIR_CATEGORIES = {
  MAJOR: ["BTCUSDT", "ETHUSDT"],
  MID: ["SOLUSDT", "BNBUSDT", "XRPUSDT", "LINKUSDT", "ADAUSDT"],
  MEME: ["PEPEUSDT", "WIFUSDT", "BONKUSDT", "DOGEUSDT", "SHIBUSDT"],
};

function getPairCategory(symbol) {
  if (PAIR_CATEGORIES.MAJOR.includes(symbol)) return "MAJOR";
  if (PAIR_CATEGORIES.MID.includes(symbol)) return "MID";
  if (PAIR_CATEGORIES.MEME.includes(symbol)) return "MEME";
  return "MID";
}

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

function scorePair({ klines, price, pairConfig, whaleSignal, btcKlines }) {
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

  const category = getPairCategory(pairConfig.symbol);
  const regime = detectPairRegime(klines, pairConfig.symbol);

  // Base scores object
  let scores = {};
  let trendDir = regime.trendDirection || "RANGING";

  // A. Trend Score (25 pts max) - adjusted by category
  let trendScore = 5;
  if (regime.regime === "TREND_UP") {
    trendScore = category === "MEME" ? 20 : 25; // Lower for memes
    trendDir = "BULLISH";
  } else if (regime.regime === "TREND_DOWN") {
    trendScore = category === "MEME" ? 20 : 25;
    trendDir = "BEARISH";
  } else if (regime.regime === "RANGE") {
    trendScore = 10;
  } else if (regime.regime === "CHOP") {
    trendScore = 0; // No trend in chop
  } else if (regime.regime === "HIGH_VOL") {
    trendScore = 5; // High vol but unclear direction
  }
  scores.trend = trendScore;

  // B. Volume Score (20 pts max) - stricter for memes
  const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
  const avg20Vol = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = avg20Vol > 0 ? last5Vol / (avg20Vol * 5) : 1;

  let volScore = 5;
  const volThreshold = category === "MEME" ? 2.0 : category === "MID" ? 1.5 : 1.2;
  if (volRatio >= volThreshold) volScore = 20;
  else if (volRatio >= volThreshold * 0.8) volScore = 15;
  else if (volRatio >= volThreshold * 0.6) volScore = 10;

  // MEME requires volume spike
  if (category === "MEME" && volRatio < volThreshold) {
    volScore = 0; // MEME without volume spike = 0
  }
  scores.volume = volScore;

  // C. ATR Score (20 pts max) - use regime ATR check
  let atrScore = 0;
  if (regime.canEnter) {
    atrScore = 20;
  } else if (regime.atrTooLow) {
    atrScore = 5;
  } else if (regime.atrTooHigh) {
    atrScore = 3;
  }
  scores.atr = atrScore;

  // D. Momentum Score (15 pts max) - reduced from 20
  const closes = klines.map(k => k.close);
  const last5Close = closes.slice(-5);
  const prev5Close = closes.slice(-10, -5);
  const lastAvg = last5Close.reduce((s, c) => s + c, 0) / 5;
  const prevAvg = prev5Close.reduce((s, c) => s + c, 0) / 5;
  const momentum = ((lastAvg - prevAvg) / prevAvg) * 100;

  let momScore = 5;
  if (Math.abs(momentum) > 0.3) momScore = 15;
  else if (Math.abs(momentum) > 0.15) momScore = 10;

  // Counter-trend penalty
  if (momentum < 0 && trendDir === "BULLISH") momScore -= 5;
  if (momentum > 0 && trendDir === "BEARISH") momScore -= 5;
  momScore = Math.max(0, momScore);
  scores.momentum = momScore;

  // E. Session Score (10 pts max) - reduced from 15
  let sessionScore = 3;
  const session = regime.session;
  const allowedSessions = pairConfig.allowedSessions || ["LONDON", "NY", "OVERLAP"];

  if (allowedSessions.includes(session)) {
    sessionScore = 10;
  } else if (session === "ASIAN" && category === "MAJOR") {
    sessionScore = 5; // Somewhat OK for majors
  }
  scores.session = sessionScore;

  // F. Regime Bonus (10 pts max)
  let regimeBonus = 0;
  if (regime.canEnter && regime.confidence >= 60) {
    regimeBonus = 10;
  } else if (regime.canEnter) {
    regimeBonus = 5;
  }
  scores.regime = regimeBonus;

  // G. Whale Bonus
  let whaleBonus = 0;
  if (whaleSignal && whaleSignal.whaleDetected && whaleSignal.confidence > 70) {
    whaleBonus = 8;
  }
  scores.whale = whaleBonus;

  // Calculate final score
  const rawScore =
    scores.trend +
    scores.volume +
    scores.atr +
    scores.momentum +
    scores.session +
    scores.regime +
    scores.whale;

  const finalScore = Math.min(100, Math.max(0, rawScore));

  // Determine if saturated
  const isSaturated = regime.isChoppy || regime.atrTooHigh || regime.atrTooLow;
  const saturationReasons = [];
  if (regime.isChoppy) saturationReasons.push("Market is choppy");
  if (regime.atrTooHigh) saturationReasons.push("ATR too high (volatile)");
  if (regime.atrTooLow) saturationReasons.push("ATR too low (dead)");
  if (!regime.sessionAllowed) saturationReasons.push("Suboptimal session");

  // Recommendation
  let recommendation = "WATCH";
  if (finalScore >= pairConfig.minScore && regime.canEnter && !isSaturated) {
    recommendation = "TRADE";
  } else if (finalScore < 40 || isSaturated) {
    recommendation = "AVOID";
  }

  // Build notes
  const notes = [
    `Regime: ${regime.regime}`,
    `Trend: ${trendDir} (${scores.trend}pts)`,
    `Vol: ${volRatio.toFixed(2)}x`,
    `ATR: ${regime.atr}%`,
    `Session: ${session}`,
    `CanEnter: ${regime.canEnter}`,
  ].join(", ");

  return {
    score: Math.round(finalScore),
    breakdown: scores,
    trend_direction: trendDir,
    isSaturated,
    saturationReasons,
    recommendation,
    notes,
    regime: regime, // Include full regime info
    canEnter: regime.canEnter,
    reasons: regime.recommendations || [],
  };
}

// Helper to score for orchestrator
function scoreForOrchestrator(klines, pairConfig) {
  return scorePair({
    klines,
    price: klines[klines.length - 1]?.close,
    pairConfig,
    whaleSignal: null,
  });
}

module.exports = { scorePair, scoreForOrchestrator, getPairCategory, PAIR_CATEGORIES };