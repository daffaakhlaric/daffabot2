"use strict";

/**
 * ENHANCED STRATEGY — Mirror AI Logic (No Claude)
 * Implements SMC checklist via pure technical analysis
 * Supports multi-pair with dynamic parameters from pairConfig
 */

// Default CONFIG (BTC-optimized fallback)
const DEFAULT_CONFIG = {
  // HTF Analysis (4H)
  HTF_EMA_PERIOD: 50,
  HTF_MIN_CONFIDENCE: 50,   // was 55 — lebih permissive

  // Structure Analysis
  SWING_LOOKBACK: 20,       // was 15 — lebih banyak context
  STRUCTURE_MIN_BARS: 5,    // was 3 — kurangi noise
  PULLBACK_THRESHOLD: 0.8,  // was 0.5 — zone lebih lebar

  // Entry Validation
  VOLUME_MIN: 1.05,         // was 1.2 — jangan terlalu ketat
  MIN_RR_RATIO: 1.5,        // was 2.0 — lebih realistis untuk BTC

  // Position Management
  SL_PCT: 1.2,              // was 0.7 — SL harus lebih wide di BTC
  TRAIL_ACTIVATE: 1.0,      // was 1.5 — aktifkan trail lebih awal
  TRAIL_DROP: 0.5,          // was 0.3 — trail lebih longgang
  PYR_1: 1.0,               // was 1.5 — pyramid lebih cepat
  PYR_2: 2.5,               // was 3.0
};

// Module-level CONFIG — updated by analyze() based on pairConfig
let CONFIG = { ...DEFAULT_CONFIG };

// Build dynamic config from pairConfig
function buildConfigFromPair(pairConfig) {
  if (!pairConfig) return DEFAULT_CONFIG;

  return {
    ...DEFAULT_CONFIG,
    HTF_EMA_PERIOD: pairConfig.botEMAPeriod ?? 50,
    VOLUME_MIN: pairConfig.botVolumeMin ?? 1.05,
    SL_PCT: pairConfig.botSLPct ?? 1.2,
    TRAIL_ACTIVATE: pairConfig.botTrailActivate ?? 1.0,
  };
}

// ================= HELPERS =================
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function extractSwings(klines, lookback = 15) {
  const highs = [], lows = [];
  const k = klines.slice(-lookback * 3);
  for (let i = 2; i < k.length - 2; i++) {
    if (k[i].high >= k[i-1].high && k[i].high >= k[i+1].high &&
        k[i].high >= k[i-2].high && k[i].high >= k[i+2].high) {
      highs.push(k[i].high);
    }
    if (k[i].low <= k[i-1].low && k[i].low <= k[i+1].low &&
        k[i].low <= k[i-2].low && k[i].low <= k[i+2].low) {
      lows.push(k[i].low);
    }
  }
  return { highs: highs.slice(-3), lows: lows.slice(-3) };
}

function calculateHTFConfidence(klines, price) {
  if (!klines || klines.length < CONFIG.HTF_EMA_PERIOD) return null;

  const closes = klines.map(k => k.close);
  const emaVal = ema(closes, CONFIG.HTF_EMA_PERIOD);

  if (!emaVal) return null;

  const isBullish = price > emaVal;
  const distFromEMA = Math.abs(price - emaVal) / emaVal * 100;

  // Confidence based on distance from EMA
  let confidence = 100 - Math.min(distFromEMA * 2, 50);
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    bias: isBullish ? "BULLISH" : "BEARISH",
    confidence: Math.round(confidence),
    ema: emaVal,
  };
}

function validateSMCChecklist(klines, price) {
  const checks = {
    htf_bias_clear: false,
    liquidity_swept: false,
    structure_break: false,
    mitigation_zone: false,
    choch_confirmed: false,
    entry_candle_valid: false,
    rr_minimum_met: false,
    no_htf_resistance: false,
  };

  try {
    // 1. HTF Bias Clear
    const htf = calculateHTFConfidence(klines, price);
    checks.htf_bias_clear = htf && htf.confidence >= 55;

    // 2. Liquidity Swept
    const swings = extractSwings(klines);
    if (htf?.bias === "BULLISH" && swings.lows.length > 0) {
      const lastLow = Math.min(...swings.lows);
      checks.liquidity_swept = price > lastLow && (price - lastLow) / lastLow * 100 < 2;
    } else if (htf?.bias === "BEARISH" && swings.highs.length > 0) {
      const lastHigh = Math.max(...swings.highs);
      checks.liquidity_swept = price < lastHigh && (lastHigh - price) / lastHigh * 100 < 2;
    }

    // 3. Structure Break (BOS) — gunakan 15 candle + konfirmasi close
    const structureCandles = klines.slice(-15);
    const prevHigh = Math.max(...structureCandles.slice(0,-3).map(k => k.high));
    const prevLow  = Math.min(...structureCandles.slice(0,-3).map(k => k.low));
    const lastClose = klines[klines.length - 1].close;
    checks.structure_break = lastClose > prevHigh * 1.001 || lastClose < prevLow * 0.999;

    // 4. Mitigation Zone (pullback)
    if (htf?.ema) {
      const distFromEMA = Math.abs(price - htf.ema) / htf.ema * 100;
      checks.mitigation_zone = distFromEMA < CONFIG.PULLBACK_THRESHOLD;
    }

    // 5. CHoCH Confirmed (structure change)
    if (klines.length >= 10) {
      const prev = klines.slice(-10, -5);
      const curr = klines.slice(-5);
      const prevLow = Math.min(...prev.map(k => k.low));
      const currLow = Math.min(...curr.map(k => k.low));
      const prevHigh = Math.max(...prev.map(k => k.high));
      const currHigh = Math.max(...curr.map(k => k.high));
      checks.choch_confirmed = (currLow < prevLow) || (currHigh > prevHigh);
    }

    // 6. Entry Candle Valid (bullish/bearish engulfing or pin bar)
    const curr = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    if (curr && prev) {
      const bullishEngulf = curr.open <= prev.close && curr.close > prev.open;
      const bearishEngulf = curr.open >= prev.close && curr.close < prev.open;
      const pinBar = (curr.close > curr.open && (curr.open - curr.low) > (curr.high - curr.close) * 2) ||
                     (curr.close < curr.open && (curr.high - curr.open) > (curr.low - curr.close) * 2);
      checks.entry_candle_valid = bullishEngulf || bearishEngulf || pinBar;
    }

    // 7. RR Minimum (1:2)
    if (htf?.ema) {
      const sl = price * (1 - CONFIG.SL_PCT / 100);
      const risk = Math.abs(price - sl);
      const tp = price + (risk * CONFIG.MIN_RR_RATIO);
      checks.rr_minimum_met = risk > 0 && tp > price;
    }

    // 8. No HTF Resistance
    if (klines.length >= 50) {
      const allHighs = klines.map(k => k.high);
      const maxHigh = Math.max(...allHighs.slice(-50));
      checks.no_htf_resistance = price < maxHigh * 1.01; // Within 1% of recent high
    }

  } catch (err) {
    // On error, mark as incomplete
  }

  return checks;
}

function calculateConfluenceScore(checks) {
  if (!checks) return 0;
  const passed = Object.values(checks).filter(v => v === true).length;
  return Math.round((passed / 8) * 100);
}

// ================= HTF & MOMENTUM ANALYSIS =================
// Simple multi-TF bias check menggunakan EMA slope
function calcHTFBias(klines) {
  if (!klines || klines.length < 50) return "RANGING";
  const closes = klines.map(k => k.close);
  const ema50  = ema(closes, 50);
  const ema20  = ema(closes, 20);
  if (!ema50 || !ema20) return "RANGING";
  const price = closes[closes.length - 1];
  // Slope: compare current EMA vs 5 candles ago
  const closes5ago = closes.slice(0, -5);
  const ema50_5ago = ema(closes5ago, 50);
  if (!ema50_5ago) return "RANGING";
  const slope = (ema50 - ema50_5ago) / ema50_5ago * 100;
  if (price > ema50 && slope > 0.05)  return "BULLISH";
  if (price < ema50 && slope < -0.05) return "BEARISH";
  return "RANGING";
}

// Simple momentum score (0-100)
function calcMomentumScore(klines) {
  if (klines.length < 10) return 50;
  const last5 = klines.slice(-5);
  const prev5 = klines.slice(-10, -5);
  const lastAvgClose = last5.reduce((s,k) => s+k.close,0) / 5;
  const prevAvgClose = prev5.reduce((s,k) => s+k.close,0) / 5;
  const lastAvgVol   = last5.reduce((s,k) => s+k.volume,0) / 5;
  const prevAvgVol   = prev5.reduce((s,k) => s+k.volume,0) / 5;
  const priceMom = (lastAvgClose - prevAvgClose) / prevAvgClose * 100;
  const volRatio = prevAvgVol > 0 ? lastAvgVol / prevAvgVol : 1;
  // Score: momentum + volume confirmation
  const score = 50 + (priceMom * 10) + ((volRatio - 1) * 15);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Helper ATR sederhana
function calcATRSimple(klines, period = 14) {
  const k = klines.slice(-period - 1);
  if (k.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(
      k[i].high - k[i].low,
      Math.abs(k[i].high - k[i-1].close),
      Math.abs(k[i].low  - k[i-1].close)
    );
    total += tr;
  }
  return total / (k.length - 1);
}

// ================= MAIN ANALYZE =================
function analyze({ klines, position, pairConfig }) {
  try {
    // Build dynamic config from pairConfig or use defaults (sets module-level CONFIG)
    CONFIG = buildConfigFromPair(pairConfig);

    if (!Array.isArray(klines) || klines.length < 60) {
      return { action: "HOLD" };
    }

    const current = klines[klines.length - 1];
    const price = current?.close;

    if (!price) return { action: "HOLD" };

    // ================= POSITION MANAGEMENT =================
    if (position) {
      return managePosition(position, price);
    }

    // ================= HTF & MOMENTUM ANALYSIS =================
    const htfBias = calcHTFBias(klines);
    const checks = validateSMCChecklist(klines, price);
    const confluenceScore = calculateConfluenceScore(checks);
    const htf = calculateHTFConfidence(klines, price);

    // Primary filter: SMC checklist score (4-8 checks passing)
    // Relaxed: allow 3+ checks passing (confluence 37%+) for flexibility in choppy markets
    if (confluenceScore < 37) {
      return { action: "HOLD", reason: `Confluence ${confluenceScore}% < 37`, source: "SMC_FILTER" };
    }

    // Secondary filter: HTF confidence must exist, but allow low-momentum ranging if SMC score is high
    if (!htf || (htf.confidence < CONFIG.HTF_MIN_CONFIDENCE && confluenceScore < 50)) {
      return { action: "HOLD", reason: "HTF confidence + SMC score too low", source: "HTF_FILTER" };
    }

    // ================= ENTRY SIGNAL =================
    // Entry dengan HTF alignment
    if (htf.bias === "BULLISH" && htfBias !== "BEARISH" && checks.structure_break && checks.entry_candle_valid) {
      return buildEntry("LONG", price, "BTCStrategy_TREND", klines);
    }
    if (htf.bias === "BEARISH" && htfBias !== "BULLISH" && checks.structure_break && checks.entry_candle_valid) {
      return buildEntry("SHORT", price, "BTCStrategy_TREND", klines);
    }
    if (checks.mitigation_zone && checks.entry_candle_valid) {
      if (htf.bias === "BULLISH" && current.close > current.open) {
        return buildEntry("LONG", price, "BTCStrategy_SNIPER", klines);
      }
      if (htf.bias === "BEARISH" && current.close < current.open) {
        return buildEntry("SHORT", price, "BTCStrategy_SNIPER", klines);
      }
    }

    return { action: "HOLD" };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

// ================= ENTRY BUILDER =================
function buildEntry(side, price, setup = "SMC", klines = []) {
  // ATR-based SL — lebih adaptif dari % hardcoded
  let atrMultiplier = 1.5;
  let slPct = CONFIG.SL_PCT;

  if (klines.length >= 15) {
    const atrRaw = calcATRSimple(klines, 14);
    const atrPct = atrRaw / price * 100;
    // SL = 1.5x ATR, min 0.8%, max 2.5%
    slPct = Math.max(0.8, Math.min(2.5, atrPct * atrMultiplier));
  }

  const sl  = price * (1 - slPct / 100);
  const risk = Math.abs(price - sl);
  const tp1 = side === "LONG" ? price + risk * 2   : price - risk * 2;
  const tp2 = side === "LONG" ? price + risk * 4   : price - risk * 4;
  const tp3 = side === "LONG" ? price + risk * 7   : price - risk * 7;

  return {
    action: side,
    setup,
    entry: {
      price,
      sl:            slPct,
      trailActivate: CONFIG.TRAIL_ACTIVATE,
      trailDrop:     CONFIG.TRAIL_DROP,
      pyr1:          CONFIG.PYR_1,
      pyr2:          CONFIG.PYR_2,
    },
    // Expose levels untuk dashboard
    sl_price: +sl.toFixed(2),
    tp1:      +tp1.toFixed(2),
    tp2:      +tp2.toFixed(2),
    tp3:      +tp3.toFixed(2),
    confidence: 60,
    reason: `${setup}: ${side} ATR-SL=${slPct.toFixed(2)}%`,
    source: "BTCSTRATEGY",
  };
}

// ================= POSITION MANAGEMENT =================
function managePosition(pos, price) {
  try {
    if (!pos || typeof pos.entry !== "number") {
      return { action: "HOLD" };
    }

    const pnl = pos.side === "LONG"
      ? (price - pos.entry) / pos.entry * 100
      : (pos.entry - price) / pos.entry * 100;

    if (typeof pos.peak !== "number") pos.peak = 0;
    pos.peak = Math.max(pos.peak, pnl);

    // STOP LOSS
    if (pnl <= -pos.sl) {
      return { action: "CLOSE", reason: "STOP LOSS" };
    }

    // TRAILING
    if (pnl >= pos.trailActivate) {
      const drop = pos.peak * pos.trailDrop;
      if (pnl <= pos.peak - drop) {
        return { action: "CLOSE", reason: "TRAILING EXIT" };
      }
    }

    // DEAD TRADE EXIT: jika dalam 30 menit tidak ada progress
    const holdMinutes = pos.openedAt
      ? (Date.now() - pos.openedAt) / 60000
      : 0;
    if (holdMinutes > 30 && Math.abs(pnl) < 0.3) {
      return { action: "CLOSE", reason: "DEAD_TRADE_EXIT — no movement 30min" };
    }

    // PYRAMID
    if (!pos.pyr1Done && pnl >= pos.pyr1 && pos.pyr1 > 0) {
      pos.pyr1Done = true;
      return { action: "PYRAMID", level: 1 };
    }

    if (!pos.pyr2Done && pnl >= pos.pyr2 && pos.pyr2 > 0) {
      pos.pyr2Done = true;
      return { action: "PYRAMID", level: 2 };
    }

    return { action: "HOLD" };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

module.exports = { analyze };
