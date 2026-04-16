"use strict";

/**
 * Multi-Timeframe (HTF + LTF) Entry Engine
 * Production-ready MTF system for high-quality entries
 * 
 * HTF (1H/4H): Trend direction, structure, EMA bias
 * LTF (1m/5m): Entry timing, confirmation, FVG retests
 * 
 * Rules:
 * - Only trade with HTF alignment
 * - Block countertrend low quality setups
 * - Require LTF confirmation before entry
 */

const { detectPairRegime, getPairCategory, getCurrentSession } = require("./enhancedRegimeDetector");

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

function analyzeHTF(klinesHTF, symbol) {
  const category = getPairCategory(symbol);
  const closes = klinesHTF.map(k => k.close);
  
  if (closes.length < 20) {
    return { 
      bias: "NEUTRAL", 
      strength: 0, 
      aligned: false,
      ema20: null, 
      ema50: null,
    };
  }

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes.slice(-100), 200);
  
  const lastClose = closes[closes.length - 1];
  const lastEma = ema20;
  
  let bias = "NEUTRAL";
  let aligned = false;
  
  if (lastClose > ema20 && ema20 > ema50) {
    bias = "BULLISH";
    aligned = true;
  } else if (lastClose < ema20 && ema20 < ema50) {
    bias = "BEARISH";
    aligned = true;
  }
  
  const distFromEMA = lastEma ? Math.abs(lastClose - lastEma) / lastEma * 100 : 0;
  const strength = Math.max(0, 100 - distFromEMA * 2);
  
  return {
    bias,
    strength: Math.round(strength),
    aligned,
    ema20,
    ema50,
    ema200,
    close: lastClose,
    trendStrength: aligned ? strength : 0,
  };
}

function analyzeLTF(klinesLTF, htfBias) {
  if (!klinesLTF || klinesLTF.length < 10) {
    return {
      ready: false,
      reasons: ["Insufficient LTF data"],
    };
  }

  const reasons = [];
  let ready = true;
  let score = 0;

  const last = klinesLTF[klinesLTF.length - 1];
  const prev = klinesLTF[klinesLTF.length - 2];

  if (!last || !prev) {
    return { ready: false, reasons: ["No candle data"] };
  }

  const currBody = Math.abs(last.close - last.open);
  const prevRange = last.high - last.low;
  const bodyRatio = prevRange > 0 ? currBody / prevRange : 0;

  if (bodyRatio > 0.5) {
    score += 30;
  } else {
    reasons.push("Weak candle body");
    ready = false;
  }

  const direction = last.close > last.open ? "BULLISH" : "BEARISH";
  const alignedWithHTF = 
    (htfBias === "BULLISH" && direction === "BULLISH") ||
    (htfBias === "BEARISH" && direction === "BEARISH");

  if (alignedWithHTF) {
    score += 40;
  } else {
    reasons.push("Counter to HTF");
    ready = false;
  }

  const last5 = klinesLTF.slice(-5);
  const vol5 = last5.reduce((s, k) => s + k.volume, 0);
  const prev20Vol = klinesLTF.slice(-20, -5).reduce((s, k) => s + k.volume, 0) / 15;
  const volSpike = prev20Vol > 0 ? vol5 / (prev20Vol * 5) : 1;

  if (volSpike >= 1.2) {
    score += 20;
  } else {
    reasons.push("No volume spike");
  }

  const range5 = Math.max(...last5.map(k => k.high)) - Math.min(...last5.map(k => k.low));
  const avgPrice = last5.reduce((s, k) => s + k.close, 0) / 5;
  const rangePct = (range5 / avgPrice) * 100;

  if (rangePct > 0.5) {
    score += 10;
  }

  return {
    ready: ready && score >= 60,
    score,
    direction,
    alignedWithHTF,
    bodyRatio: Math.round(bodyRatio * 100) / 100,
    volumeSpike: volSpike >= 1.2,
    reasons,
  };
}

function detectBOS(klines, direction) {
  if (!klines || klines.length < 20) return { hasBOS: false };

  const lookback = 10;
  const structStart = klines.length - lookback - 5;
  const structEnd = klines.length - 5;

  const structRange = klines.slice(structStart, structEnd);
  const structHigh = Math.max(...structRange.map(k => k.high));
  const structLow = Math.min(...structRange.map(k => k.low));

  const lastCandle = klines[klines.length - 1];
  const currentClose = lastCandle.close;

  const threshold = 0.001;
  const hasBullishBOS = currentClose > structHigh * (1 + threshold);
  const hasBearishBOS = currentClose < structLow * (1 - threshold);

  const hasBOS = direction === "BULLISH" ? hasBullishBOS : hasBearishBOS;

  return {
    hasBOS,
    structHigh,
    structLow,
    currentClose,
    threshold,
  };
}

function detectFVG(klines, direction) {
  if (!klines || klines.length < 3) return { hasFVG: false };

  const last3 = klines.slice(-3);
  
  for (let i = 1; i < last3.length; i++) {
    const curr = last3[i];
    const prev = last3[i - 1];
    
    const fvgBullish = prev.low > curr.high;
    const fvgBearish = prev.high < curr.low;

    if (direction === "BULLISH" && fvgBullish) {
      const fvgSize = prev.low - curr.high;
      const avgRange = (curr.high - curr.low + prev.high - prev.low) / 2;
      return {
        hasFVG: true,
        type: "BULLISH",
        size: fvgSize,
        sizePct: avgRange > 0 ? (fvgSize / avgRange) * 100 : 0,
        retestZone: curr.high,
      };
    }

    if (direction === "BEARISH" && fvgBearish) {
      const fvgSize = prev.high - curr.low;
      const avgRange = (curr.high - curr.low + prev.high - prev.low) / 2;
      return {
        hasFVG: true,
        type: "BEARISH",
        size: fvgSize,
        sizePct: avgRange > 0 ? (fvgSize / avgRange) * 100 : 0,
        retestZone: curr.low,
      };
    }
  }

  return { hasFVG: false };
}

function detectLiquiditySweep(klines, direction) {
  if (!klines || klines.length < 20) return { swept: false };

  const highs = klines.slice(-20).map(k => k.high);
  const lows = klines.slice(-20).map(k => k.low);

  const recentHigh = highs[highs.length - 1];
  const recentLow = lows[lows.length - 1];

  const swingHighs = highs.filter((h, i) => i > 0 && h > highs[i - 1] && h > highs[i + 1]);
  const swingLows = lows.filter((l, i) => i > 0 && l < lows[i - 1] && l < lows[i + 1]);

  const lastHigh = swingHighs.length > 0 ? Math.max(...swingHighs) : recentHigh;
  const lastLow = swingLows.length > 0 ? Math.min(...swingLows) : recentLow;

  const price = klines[klines.length - 1].close;

  if (direction === "BULLISH") {
    const swept = price > lastLow && (price - lastLow) / lastLow < 0.02;
    return { swept, lastLow, currentPrice: price };
  } else {
    const swept = price < lastHigh && (lastHigh - price) / lastHigh < 0.02;
    return { swept, lastHigh, currentPrice: price };
  }
}

function analyzeEntry({
  klinesHTF,
  klinesLTF,
  symbol,
  direction,
}) {
  const category = getPairCategory(symbol);
  const htf = analyzeHTF(klinesHTF, symbol);
  const ltf = analyzeLTF(klinesLTF, htf.bias);
  const bos = detectBOS(klinesLTF, direction);
  const fvg = detectFVG(klinesLTF, direction);
  const liquidity = detectLiquiditySweep(klinesLTF, direction);
  const session = getCurrentSession();

  const checks = {
    htf_aligned: htf.aligned && (htf.bias === direction || htf.bias === "NEUTRAL"),
    htf_strong: htf.strength >= 60,
    ltf_ready: ltf.ready,
    bos_confirmed: bos.hasBOS,
    fvg_present: fvg.hasFVG,
    liquidity_swept: liquidity.swept,
    good_session: ["LONDON", "NY", "OVERLAP"].includes(session),
  };

  const passed = Object.values(checks).filter(v => v === true).length;
  const total = Object.keys(checks).length;
  const confidence = Math.round((passed / total) * 100);

  let grade = "C";
  let canEnter = false;

  const minScoreByCategory = {
    MAJOR: 60,
    MID: 70,
    MEME: 80,
  };
  
  const minScore = minScoreByCategory[category] || 60;

  if (confidence >= minScore && checks.htf_aligned && checks.ltf_ready) {
    canEnter = true;
    if (confidence >= 85) grade = "A+";
    else if (confidence >= 75) grade = "A";
    else if (confidence >= 65) grade = "B";
  }

  const recommendations = [];
  if (!checks.htf_aligned) recommendations.push("HTF not aligned with direction");
  if (!checks.htf_strong) recommendations.push("HTF strength too low");
  if (!checks.ltf_ready) recommendations.push("LTF not ready");
  if (!checks.bos_confirmed) recommendations.push("No BOS confirmed");
  if (!checks.fvg_present) recommendations.push("No FVG present");
  if (!checks.liquidity_swept) recommendations.push("Liquidity not swept");
  if (!checks.good_session) recommendations.push(`Session ${session} not optimal`);

  return {
    canEnter,
    confidence,
    grade,
    htf,
    ltf,
    bos,
    fvg,
    liquidity,
    session,
    checks,
    recommendations: recommendations.length > 0 ? recommendations : ["All checks passed"],
    atr: calcATR(klinesLTF, 14),
  };
}

function getHTFTimeframes() {
  return {
    primary: "1H",
    secondary: "4H",
    tertiary: "15m",
  };
}

function getLTFTimeframes() {
  return {
    primary: "1m",
    secondary: "5m",
  };
}

function shouldTradeHTF({
  klinesHTF,
  klines1H,
  klines4H,
  symbol,
}) {
  const htf1h = klines1H && klines1H.length >= 20 
    ? analyzeHTF(klines1H, symbol) 
    : { aligned: false, strength: 0, bias: "NEUTRAL" };
  
  const htf4h = klines4H && klines4H.length >= 20 
    ? analyzeHTF(klines4H, symbol) 
    : { aligned: false, strength: 0, bias: "NEUTRAL" };

  const bothAligned = htf1h.aligned && htf4h.aligned;
  const sameDirection = htf1h.bias === htf4h.bias && htf1h.bias !== "NEUTRAL";
  const strongHTF = htf1h.strength >= 60 || htf4h.strength >= 60;

  return {
    canTrade: bothAligned && sameDirection && strongHTF,
    htf1h,
    htf4h,
    aligned: bothAligned,
    sameDirection,
    strong: strongHTF,
    primaryBias: htf1h.bias,
    secondaryBias: htf4h.bias,
  };
}

module.exports = {
  analyzeHTF,
  analyzeLTF,
  analyzeEntry,
  detectBOS,
  detectFVG,
  detectLiquiditySweep,
  getHTFTimeframes,
  getLTFTimeframes,
  shouldTradeHTF,
  ema,
  calcATR,
};