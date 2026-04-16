"use strict";

/**
 * Pair-Specific Market Regime Detector
 * Enhanced regime detection with pair classification
 * A. Major: BTC, ETH - smoother moves, allow trend following
 * B. Mid: SOL, BNB, LINK - moderate volatility, stricter pullback
 * C. High-risk: PEPE, WIF, BONK - high noise, stricter filters
 */

const PAIR_CATEGORIES = {
  MAJOR: ["BTCUSDT", "ETHUSDT"],
  MID: ["SOLUSDT", "BNBUSDT", "XRPUSDT", "LINKUSDT", "ADAUSDT"],
  MEME: ["PEPEUSDT", "WIFUSDT", "BONKUSDT", "DOGEUSDT", "SHIBUSDT"],
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

function getPairCategory(symbol) {
  if (PAIR_CATEGORIES.MAJOR.includes(symbol)) return "MAJOR";
  if (PAIR_CATEGORIES.MID.includes(symbol)) return "MID";
  if (PAIR_CATEGORIES.MEME.includes(symbol)) return "MEME";
  return "MID";
}

function getPairThresholds(category) {
  const thresholds = {
    MAJOR: {
      minTrendStrength: 0.5,
      minATR: 0.3,
      maxATR: 2.0,
      minVolumeSpike: 1.2,
      chopThreshold: 0.4,
      volatilityMultiplier: 1.0,
      minHoldSeconds: 120, // 2 min
      allowedSessions: ["LONDON", "NY", "OVERLAP"],
    },
    MID: {
      minTrendStrength: 0.55,
      minATR: 0.5,
      maxATR: 3.0,
      minVolumeSpike: 1.3,
      chopThreshold: 0.45,
      volatilityMultiplier: 0.8,
      minHoldSeconds: 150, // 2.5 min
      allowedSessions: ["NY", "OVERLAP"],
    },
    MEME: {
      minTrendStrength: 0.6,
      minATR: 0.8,
      maxATR: 5.0,
      minVolumeSpike: 1.5,
      chopThreshold: 0.5,
      volatilityMultiplier: 0.5,
      minHoldSeconds: 180, // 3 min
      allowedSessions: ["NY"], // Only NY for memes
    },
  };
  return thresholds[category] || thresholds.MID;
}

function detectTrendDirection(klines) {
  if (!klines || klines.length < 10) return { direction: "UNKNOWN", strength: 0 };

  const recent = klines.slice(-10);
  const closes = recent.map(k => k.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  if (!ema20 || !ema50) return { direction: "UNKNOWN", strength: 0 };

  // Count higher highs / lower highs
  const highs = recent.map(k => k.high);
  const lows = recent.map(k => k.low);
  const hhCount = highs.filter((h, i) => i > 0 && h > highs[i - 1]).length;
  const llCount = lows.filter((l, i) => i > 0 && l < lows[i - 1]).length;

  let direction = "RANGING";
  if (closes[closes.length - 1] > ema20 && ema20 > ema50 && hhCount >= 6) {
    direction = "BULLISH";
  } else if (closes[closes.length - 1] < ema20 && ema20 < ema50 && llCount >= 6) {
    direction = "BEARISH";
  }

  const strength = Math.max(hhCount, llCount) / 9;
  return { direction, strength };
}

function detectChop(klines, threshold = 0.4) {
  if (!klines || klines.length < 20) return { isChoppy: false, chopIndex: 0 };

  const recent = klines.slice(-20);
  const closes = recent.map(k => k.close);
  const ema20 = ema(closes, 20);

  if (!ema20) return { isChoppy: false, chopIndex: 0 };

  // Calculate how much price deviates from EMA
  const deviations = closes.map(c => Math.abs(c - ema20) / ema20);
  const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;

  // Choppy if price keeps crossing EMA frequently
  let emaCrosses = 0;
  for (let i = 1; i < closes.length; i++) {
    if ((closes[i - 1] > ema20 && closes[i] < ema20) || (closes[i - 1] < ema20 && closes[i] > ema20)) {
      emaCrosses++;
    }
  }

  // Chop index: high crosses + low deviation = choppy
  const chopIndex = (emaCrosses / 20) * 0.6 + (avgDeviation * 100) * 0.4;

  return {
    isChoppy: chopIndex > threshold,
    chopIndex: Math.round(chopIndex * 100) / 100,
    emaCrosses,
    avgDeviation: Math.round(avgDeviation * 10000) / 100,
  };
}

function detectVolumeSpike(klines) {
  if (!klines || klines.length < 20) return { isSpike: false, ratio: 1 };

  const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
  const prev20Vol = klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0);
  const avgVol = prev20Vol / 15;

  const ratio = avgVol > 0 ? last5Vol / (avgVol * 5) : 1;
  return { isSpike: ratio >= 1.5, ratio: Math.round(ratio * 100) / 100 };
}

function getCurrentSession() {
  const utcHour = new Date().getUTCHours();
  const utcMin = new Date().getUTCMinutes();

  // Asian: 00:00-06:00 UTC
  if (utcHour >= 0 && utcHour < 6) return "ASIAN";
  // London: 07:00-11:00 UTC
  if (utcHour >= 7 && utcHour < 12) return "LONDON";
  // Overlap: 12:00-16:00 UTC
  if (utcHour >= 12 && utcHour < 17) return "OVERLAP";
  // NY: 13:00-21:00 UTC (overlaps with overlap)
  if (utcHour >= 13 && utcHour < 22) return "NY";
  // NY PM: 21:00-00:00 UTC
  if (utcHour >= 21 || utcHour < 1) return "NY_PM";

  return "UNKNOWN";
}

function detectPairRegime(klines, symbol) {
  const category = getPairCategory(symbol);
  const thresholds = getPairThresholds(category);

  const atr = calcATR(klines, 14);
  const trend = detectTrendDirection(klines);
  const chop = detectChop(klines, thresholds.chopThreshold);
  const volSpike = detectVolumeSpike(klines);
  const session = getCurrentSession();

  // Check ATR bounds
  const atrTooLow = atr < thresholds.minATR;
  const atrTooHigh = atr > thresholds.maxATR;

  // Determine regime
  let regime = "UNKNOWN";
  let confidence = 0;
  let recommendations = [];

  // VOLATILE spike - disable entries
  if (atrTooHigh) {
    regime = "HIGH_VOL";
    confidence = Math.min(100, Math.round((atr / thresholds.maxATR) * 80));
    recommendations.push("Disable entries - volatility too high");
  }
  // CHOP - disable entries
  else if (chop.isChoppy) {
    regime = "CHOP";
    confidence = Math.min(100, Math.round(chop.chopIndex * 150));
    recommendations.push("Disable entries - market is choppy");
  }
  // Low ATR (dead market)
  else if (atrTooLow) {
    regime = "DEAD";
    confidence = 70;
    recommendations.push("Avoid - insufficient movement");
  }
  // TRENDING - allow entries
  else if (trend.strength >= thresholds.minTrendStrength) {
    regime = trend.direction === "BULLISH" ? "TREND_UP" : "TREND_DOWN";
    confidence = Math.round(trend.strength * 100);
    recommendations.push(`Allow ${regime} entries`);
  }
  // RANGING - be selective
  else {
    regime = "RANGE";
    confidence = 50;
    recommendations.push("Selective entries only");
  }

  // Session check
  const sessionAllowed = thresholds.allowedSessions.includes(session);
  if (!sessionAllowed && regime !== "DEAD") {
    recommendations.push(`Session ${session} not optimal for ${category}`);
  }

  // Volume spike bonus for MEME
  if (category === "MEME" && !volSpike.isSpike && regime !== "DEAD") {
    recommendations.push("MEME requires volume spike confirmation");
  }

  return {
    regime,
    confidence,
    category,
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    atr: Math.round(atr * 100) / 100,
    isChoppy: chop.isChoppy,
    chopIndex: chop.chopIndex,
    volumeSpike: volSpike.isSpike,
    volumeRatio: volSpike.ratio,
    session,
    sessionAllowed,
    atrTooLow,
    atrTooHigh,
    thresholds,
    recommendations,
    canEnter:
      !atrTooHigh &&
      !chop.isChoppy &&
      !atrTooLow &&
      sessionAllowed &&
      (category !== "MEME" || volSpike.isSpike),
  };
}

// BTC sentiment filter - used only as secondary filter for altcoins
async function getBTCSentiment(klines) {
  if (!klines || klines.length < 20) return { sentiment: "NEUTRAL", strength: 0 };

  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];
  const price1hAgo = closes[closes.length - 60] || closes[0];
  const price4hAgo = closes[closes.length - 240] || closes[0];

  const change1h = ((currentPrice - price1hAgo) / price1hAgo) * 100;
  const change4h = ((currentPrice - price4hAgo) / price4hAgo) * 100;

  let sentiment = "NEUTRAL";
  let strength = 0;

  if (change1h > 1.5 || change4h > 3) {
    sentiment = "STRONG_BULL";
    strength = Math.min(100, Math.abs(change4h) * 20);
  } else if (change1h > 0.5) {
    sentiment = "BULL";
    strength = Math.min(100, Math.abs(change1h) * 50);
  } else if (change1h < -1.5 || change4h < -3) {
    sentiment = "STRONG_BEAR";
    strength = Math.min(100, Math.abs(change4h) * 20);
  } else if (change1h < -0.5) {
    sentiment = "BEAR";
    strength = Math.min(100, Math.abs(change1h) * 50);
  }

  return { sentiment, strength, change1h, change4h };
}

// Altcoin entry adjustment based on BTC sentiment
function adjustForBTCSentiment(pairRegime, btcSentiment, signal) {
  if (!btcSentiment || btcSentiment.sentiment === "NEUTRAL") {
    return { adjusted: true, reason: "BTC neutral" };
  }

  const isAltcoin = pairRegime.category !== "MAJOR";

  // If BTC dumping hard, block alt longs
  if (isAltcoin && signal === "LONG" && btcSentiment.sentiment.includes("BEAR")) {
    return {
      adjusted: false,
      reason: `BTC ${btcSentiment.sentiment} - blocking alt LONG`,
    };
  }

  // If BTC pumping, allow more confidence for alt longs
  if (isAltcoin && signal === "LONG" && btcSentiment.sentiment.includes("BULL")) {
    return {
      adjusted: true,
      reason: `BTC ${btcSentiment.sentiment} - allowing alt LONG`,
      confidenceBonus: Math.min(15, btcSentiment.strength * 0.2),
    };
  }

  return { adjusted: true, reason: "No BTC adjustment needed" };
}

module.exports = {
  PAIR_CATEGORIES,
  getPairCategory,
  getPairThresholds,
  detectPairRegime,
  getCurrentSession,
  getBTCSentiment,
  adjustForBTCSentiment,
  detectChop,
  detectVolumeSpike,
  calcATR,
};