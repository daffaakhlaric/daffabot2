"use strict";

/**
 * SCALP ENGINE — High-frequency micro-momentum entry generator (B.12)
 *
 * Purpose: Provide a fast, lightweight entry signal for 150x scalp mode on
 * MAJOR pairs (BTC/ETH). Designed to be polled every 5s by the orchestrator
 * alongside multiPairStrategy.analyze(). Produces SCALP_FAST signals tuned
 * for 0.20-0.35% targets with tight 0.25-0.40% stops.
 *
 * Decision (2-of-3 essentials):
 *   1. EMA(5) crosses / aligns with EMA(13) in HTF direction
 *   2. Last 3 candles confirm directional micro-momentum
 *   3. ATR within band (atrOptimalMin..atrOptimalMax) AND volume not dead
 *
 * Returns null on hold; entry-shaped object on signal.
 * Output shape matches multiPairStrategy.buildEntry — orchestrator can
 * dispatch identically.
 */

const { getPairCategory, calcATR } = require("./enhancedRegimeDetector");
const { getTPConfig } = require("./tpExitManager");

// Hard cap on SL distance for scalp mode — protects 150x leverage
const SCALP_SL_HARD_CAP_PCT = 0.4;
const SCALP_SL_FLOOR_PCT = 0.20;

// Micro-momentum lookback
const MICRO_LOOKBACK = 3;
const FAST_EMA = 5;
const SLOW_EMA = 13;

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// 1. EMA alignment + recent cross
function checkEmaAlignment(closes, htfBias) {
  if (closes.length < SLOW_EMA + 2) {
    return { passed: false, reason: "insufficient_data" };
  }
  const fast = emaSeries(closes, FAST_EMA);
  const slow = emaSeries(closes, SLOW_EMA);
  if (fast.length < 2 || slow.length < 2) {
    return { passed: false, reason: "ema_unavailable" };
  }
  const fastNow = fast[fast.length - 1];
  const slowNow = slow[slow.length - 1];
  const aligned = htfBias === "BULLISH" ? fastNow > slowNow : fastNow < slowNow;
  return {
    passed: aligned,
    fast: fastNow,
    slow: slowNow,
    spread: ((fastNow - slowNow) / slowNow) * 100,
  };
}

// 2. Micro-momentum: last N candles confirm direction
function checkMicroMomentum(klines, htfBias) {
  if (klines.length < MICRO_LOOKBACK + 1) {
    return { passed: false, reason: "insufficient_klines" };
  }
  const recent = klines.slice(-MICRO_LOOKBACK);
  let bullCount = 0;
  let bearCount = 0;
  for (const k of recent) {
    if (k.close > k.open) bullCount++;
    else if (k.close < k.open) bearCount++;
  }
  const wantBull = htfBias === "BULLISH";
  // Need majority directional + last candle must match
  const last = klines[klines.length - 1];
  const lastOk = wantBull ? last.close > last.open : last.close < last.open;
  const majority = wantBull ? bullCount >= 2 : bearCount >= 2;
  return {
    passed: lastOk && majority,
    bullCount,
    bearCount,
    lastDirection: last.close > last.open ? "UP" : last.close < last.open ? "DOWN" : "FLAT",
  };
}

// 3. ATR + volume sanity
function checkAtrAndVolume(klines, pairCfg) {
  const atrPct = calcATR ? calcATR(klines, 14) : 0;
  const atrMin = pairCfg?.atrOptimalMin ?? 0.08;
  const atrMax = pairCfg?.atrOptimalMax ?? 2.5;
  const atrInBand = atrPct >= atrMin && atrPct <= atrMax;

  // Volume: last candle volume vs avg of prior 10
  let volOk = true;
  if (klines.length >= 11) {
    const last = klines[klines.length - 1].volume || 0;
    const prior = klines.slice(-11, -1).map(k => k.volume || 0);
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    // Reject only fully dead volume; tolerate 0.5x average
    volOk = avg <= 0 || last >= avg * 0.5;
  }

  return {
    passed: atrInBand && volOk,
    atrPct: +atrPct.toFixed(3),
    atrInBand,
    volOk,
  };
}

// Compute HTF bias from EMA(50) vs price — same convention as multiPairStrategy
function calcHtfBias(klines, price, pairConfig) {
  if (!klines || klines.length < 50) return null;
  const period = pairConfig?.botEMAPeriod || 50;
  const closes = klines.map(k => k.close);
  const emaVal = ema(closes, period);
  if (!emaVal) return null;
  const isBull = price > emaVal;
  const distPct = Math.abs(price - emaVal) / emaVal * 100;
  const confidence = Math.max(0, Math.min(100, 100 - Math.min(distPct * 2, 50)));
  return {
    bias: isBull ? "BULLISH" : "BEARISH",
    confidence: Math.round(confidence),
    ema: emaVal,
  };
}

// Build SCALP_FAST entry — tight SL, 1R/2R/3R targets
function buildScalpEntry(side, price, klines, pairConfig, evidence) {
  const symbol = pairConfig?.symbol || "BTCUSDT";
  const tpConfig = getTPConfig(symbol);

  // SL sizing: ATR-floored, capped at SCALP_SL_HARD_CAP_PCT
  const atrPct = evidence.atr.atrPct;
  let slPct = Math.max(SCALP_SL_FLOOR_PCT, atrPct * 0.8);
  slPct = Math.min(slPct, SCALP_SL_HARD_CAP_PCT);

  const sl = side === "LONG"
    ? price * (1 - slPct / 100)
    : price * (1 + slPct / 100);
  const risk = Math.abs(price - sl);

  const tp1 = side === "LONG" ? price + risk * tpConfig.tp1Percent : price - risk * tpConfig.tp1Percent;
  const tp2 = side === "LONG" ? price + risk * tpConfig.tp2Percent : price - risk * tpConfig.tp2Percent;
  const tp3 = side === "LONG" ? price + risk * tpConfig.runnerTarget : price - risk * tpConfig.runnerTarget;

  return {
    action: side,
    setup: "SCALP_FAST",
    entry: {
      price,
      sl: slPct,
      sl_price: +sl.toFixed(6),
      tp1: +tp1.toFixed(6),
      tp2: +tp2.toFixed(6),
      tp3: +tp3.toFixed(6),
      maxHoldMs: 10 * 60 * 1000, // 10min cap for fast scalp
      trailActivate: tpConfig.trailActivate,
      trailDrop: tpConfig.trailDrop,
    },
    confidence: 60 + (evidence.essentialsPassed - 2) * 10, // 60 if 2/3, 70 if 3/3
    reason: `SCALP_FAST: ${side} essentials=${evidence.essentialsPassed}/3 ATR=${atrPct.toFixed(2)}%`,
    source: "SCALP_ENGINE",
    evidence,
  };
}

/**
 * Main entry point — generate scalp signal or null
 *
 * @param {Object} params
 * @param {String} params.symbol
 * @param {Array}  params.klines  - OHLCV (LTF, e.g. 1m or 3m)
 * @param {Number} params.price   - current price
 * @param {Object} params.pairConfig
 * @param {Object} [params.htf]   - optional pre-computed HTF bias (else derived)
 * @returns {Object|null}
 */
function generateScalpSignal({ symbol, klines, price, pairConfig, htf = null } = {}) {
  if (!symbol || !Array.isArray(klines) || klines.length < SLOW_EMA + 2) {
    return null;
  }

  const category = getPairCategory(symbol);
  // Scalp engine is MAJOR-only by default. Other categories use multiPairStrategy.
  if (category !== "MAJOR") return null;

  const htfBias = htf || calcHtfBias(klines, price, pairConfig);
  if (!htfBias || !htfBias.bias) return null;

  // HTF confidence floor — match multiPairStrategy SCALP gate
  const minHtfConf = 45;
  if (htfBias.confidence < minHtfConf) return null;

  const closes = klines.map(k => k.close);

  const emaCheck = checkEmaAlignment(closes, htfBias.bias);
  const momCheck = checkMicroMomentum(klines, htfBias.bias);
  const atrCheck = checkAtrAndVolume(klines, pairConfig);

  const passes = [emaCheck.passed, momCheck.passed, atrCheck.passed];
  const essentialsPassed = passes.filter(Boolean).length;

  // 2-of-3 essentials required; ATR-band MUST be one of them (safety)
  if (essentialsPassed < 2) return null;
  if (!atrCheck.passed) return null;

  const side = htfBias.bias === "BULLISH" ? "LONG" : "SHORT";

  return buildScalpEntry(side, price, klines, pairConfig, {
    essentialsPassed,
    htf: htfBias,
    ema: emaCheck,
    momentum: momCheck,
    atr: atrCheck,
  });
}

module.exports = {
  generateScalpSignal,
  // exported helpers (for tests / debugging)
  checkEmaAlignment,
  checkMicroMomentum,
  checkAtrAndVolume,
  calcHtfBias,
  SCALP_SL_HARD_CAP_PCT,
  SCALP_SL_FLOOR_PCT,
};
