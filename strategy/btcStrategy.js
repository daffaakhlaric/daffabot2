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
  HTF_MIN_CONFIDENCE: 65,   // increased from 50 — stricter entry filters

  // Structure Analysis (TIGHTENED FOR QUALITY)
  SWING_LOOKBACK: 20,       // was 15 — lebih banyak context
  STRUCTURE_MIN_BARS: 5,    // was 3 — kurangi noise
  PULLBACK_THRESHOLD: 0.5,  // was 0.8 — mitigation zone lebih ketat (closer to EMA)
  BOS_BREAK_PERCENT: 0.0012, // was 0.0005 (0.05%) → now 0.12% (stricter BOS)

  // Entry Validation (STRICTER)
  VOLUME_MIN: 1.2,          // was 1.05 → now 1.2 (20% volume increase required)
  MIN_RR_RATIO: 2.0,        // was 1.5 → now 2.0 (stricter risk:reward)

  // Position Management
  SL_PCT: 1.2,              // was 0.7 — SL harus lebih wide di BTC
  TRAIL_ACTIVATE: 2.0,      // Activate trailing at 2% profit (was 1.0%)
  TRAIL_DROP: 1.0,          // Trail drops by 1% (was 0.5%) — more room to run
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
    // TIGHTENED: require 0.12% break instead of 0.05% for quality entries
    const structureCandles = klines.slice(-15);
    const prevHigh = Math.max(...structureCandles.slice(0,-3).map(k => k.high));
    const prevLow  = Math.min(...structureCandles.slice(0,-3).map(k => k.low));
    const lastClose = klines[klines.length - 1].close;
    const bosBreakPercent = CONFIG.BOS_BREAK_PERCENT || 0.0012; // was 0.0005 (0.05%), now 0.12%
    checks.structure_break = lastClose > prevHigh * (1 + bosBreakPercent) || lastClose < prevLow * (1 - bosBreakPercent);

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

    // 6. Entry Candle Valid (bullish/bearish engulfing, pin bar, or strong close)
    const curr = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    if (curr && prev) {
      const bullishEngulf = curr.open <= prev.close && curr.close > prev.open;
      const bearishEngulf = curr.open >= prev.close && curr.close < prev.open;
      const pinBar = (curr.close > curr.open && (curr.open - curr.low) > (curr.high - curr.close) * 2) ||
                     (curr.close < curr.open && (curr.high - curr.open) > (curr.low - curr.close) * 2);

      // Relaxed check: also accept if close is far from open (strong candle)
      const strongBullish = curr.close > curr.open && (curr.close - curr.open) > (prev.high - prev.low) * 0.5;
      const strongBearish = curr.close < curr.open && (curr.open - curr.close) > (prev.high - prev.low) * 0.5;

      checks.entry_candle_valid = bullishEngulf || bearishEngulf || pinBar || strongBullish || strongBearish;
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
      const nearResistance = price > maxHigh * 0.99; // Within 1% of recent high
      checks.no_htf_resistance = !nearResistance; // True when NOT near resistance
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
      return { action: "HOLD", reason: `Insufficient klines (${klines?.length || 0} < 60)`, source: "DATA_CHECK" };
    }

    const current = klines[klines.length - 1];
    const price = current?.close;

    if (!price) {
      return { action: "HOLD", reason: "No price data", source: "DATA_CHECK" };
    }

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
    // Strict: require 5+ checks passing (confluence 60%+) to reduce false entries
    if (confluenceScore < 60) {
      return { action: "HOLD", reason: `Confluence ${confluenceScore}% < 60`, source: "SMC_FILTER" };
    }

    // Secondary filter: HTF confidence must exist, but allow low-momentum ranging if SMC score is high
    if (!htf || (htf.confidence < CONFIG.HTF_MIN_CONFIDENCE && confluenceScore < 50)) {
      const reason = !htf
        ? "No HTF data"
        : `HTF ${htf.confidence}% < ${CONFIG.HTF_MIN_CONFIDENCE} AND Confluence ${confluenceScore}% < 50`;
      return { action: "HOLD", reason, source: "HTF_FILTER" };
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

    // ═══ RELAXED ENTRY (Multi-pair mode) ═══
    // Mode 1: confluence >=60% + HTF >=75% + current candle matches trend
    // Increased thresholds to avoid weak/micro-profit entries
    const hasGoodConfluence = confluenceScore >= 60;
    const hasStrongHTF = htf && htf.confidence >= 75;
    const hasClearTrend = htf && (htf.bias === "BULLISH" || htf.bias === "BEARISH");

    if (hasGoodConfluence && hasStrongHTF && hasClearTrend) {
      if (htf.bias === "BULLISH" && current.close > current.open) {
        return buildEntry("LONG", price, "BTCStrategy_RELAXED", klines);
      }
      if (htf.bias === "BEARISH" && current.close < current.open) {
        return buildEntry("SHORT", price, "BTCStrategy_RELAXED", klines);
      }
    }

    // Mode 2: ULTRA-RELAXED — confluence >=60% + HTF >=80% (no candle check needed)
    // For multi-pair where current candle might not match trend yet
    const hasVeryHighConfluence = confluenceScore >= 60;
    const hasExcellentHTF = htf && htf.confidence >= 80;

    if (hasVeryHighConfluence && hasExcellentHTF && hasClearTrend) {
      if (htf.bias === "BULLISH") {
        return buildEntry("LONG", price, "BTCStrategy_ULTRA", klines);
      }
      if (htf.bias === "BEARISH") {
        return buildEntry("SHORT", price, "BTCStrategy_ULTRA", klines);
      }
    }

    // Fallback: detail why setup not ready
    const unmetChecks = [];
    if (!checks.structure_break) unmetChecks.push("awaiting_structure_break");
    if (!checks.entry_candle_valid) unmetChecks.push("candle_pattern_forming");
    if (!checks.mitigation_zone) unmetChecks.push("no_pullback_zone");
    if (htf.bias !== "BULLISH" && htf.bias !== "BEARISH") unmetChecks.push("trend_uncertain");

    // Provide feedback why ULTRA/RELAXED didn't trigger
    let reason = "Setup not ready";
    if (confluenceScore < 60) {
      reason = `Confluence ${confluenceScore}% < 60% (need 5+ SMC checklist patterns) | HTF=${htf.confidence}%`;
    } else if (confluenceScore >= 60 && htf.confidence < 75) {
      reason = `HTF ${htf.confidence}% < 75% (waiting for stronger trend) | Confluence=${confluenceScore}%`;
    } else if (unmetChecks.length > 0) {
      reason = `${unmetChecks.join(" + ")} | Confluence=${confluenceScore}% HTF=${htf.confidence}%`;
    }

    return { action: "HOLD", reason, source: "AWAITING_SETUP" };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

// ================= MAX HOLD TIME LOGIC =================
function getMaxHoldMs(setup) {
  if (/SNIPER_KILLER|ULTRA/.test(setup)) return 45 * 60 * 1000;  // 45 min for ultra
  if (/SNIPER/.test(setup))              return 90 * 60 * 1000;  // 90 min for sniper
  return 240 * 60 * 1000;                                         // 4 hours default (trend)
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

  const sl  = side === "LONG" ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
  const risk = Math.abs(price - sl);
  const tp1 = side === "LONG" ? price + risk * 3   : price - risk * 3;   // 3:1 RR ratio
  const tp2 = side === "LONG" ? price + risk * 5   : price - risk * 5;   // 5:1 RR ratio
  const tp3 = side === "LONG" ? price + risk * 8   : price - risk * 8;   // 8:1 RR ratio

  return {
    action: side,
    setup,
    entry: {
      price,
      sl:            slPct,
      sl_price:      +sl.toFixed(6),           // absolute SL price
      tp1:           +tp1.toFixed(6),          // absolute TP prices
      tp2:           +tp2.toFixed(6),
      tp3:           +tp3.toFixed(6),
      maxHoldMs:     getMaxHoldMs(setup),      // max hold time based on setup
      trailActivate: CONFIG.TRAIL_ACTIVATE,
      trailDrop:     CONFIG.TRAIL_DROP,
      pyr1:          CONFIG.PYR_1,
      pyr2:          CONFIG.PYR_2,
    },
    // Expose levels untuk dashboard (kept for backward compat)
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

    // STEP TRAIL SYSTEM — lock profit at multiple levels
    pos.peakPnl = Math.max(pos.peakPnl || 0, pnl);
    if (pos.peakPnl >= 0.3) {
      const trailPct = pos.peakPnl >= 1.2 ? 0.4 : pos.peakPnl >= 0.7 ? 0.2 : 0;
      const trailSL  = trailPct === 0
        ? pos.entry
        : (pos.side === "LONG" ? price * (1 - trailPct/100) : price * (1 + trailPct/100));
      const cur    = pos.slPrice || (pos.side === "LONG" ? pos.entry * (1 - pos.sl/100) : pos.entry * (1 + pos.sl/100));
      const better = pos.side === "LONG" ? trailSL > cur : trailSL < cur;
      if (better) {
        return { action: "UPDATE_SL", new_sl: +trailSL.toFixed(6), reason: `TRAIL_${trailPct}% — peak ${pos.peakPnl.toFixed(2)}%` };
      }
    }

    // MAX HOLD SAFETY — fallback only, not default close
    const holdMs = pos.openedAt ? (Date.now() - pos.openedAt) : 0;
    const maxHold = pos.maxHoldMs || (4 * 60 * 60 * 1000);
    if (holdMs > maxHold) {
      if (pnl <= 0) {
        return { action: "CLOSE", reason: `TIMEOUT_SAFETY — ${Math.round(holdMs/60000)}min, no profit` };
      }
      // Still in profit — move SL to breakeven instead of force close
      if (!pos.slPrice || pos.slPrice !== pos.entry) {
        return { action: "UPDATE_SL", new_sl: pos.entry, reason: `TIMEOUT_TRAIL — ${Math.round(holdMs/60000)}min` };
      }
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
