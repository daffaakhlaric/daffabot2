"use strict";

/**
 * ENHANCED BTC STRATEGY — Mirror AI Logic (No Claude)
 * Implements SMC checklist via pure technical analysis
 */

const CONFIG = {
  // HTF Analysis (4H)
  HTF_EMA_PERIOD: 50,
  HTF_MIN_CONFIDENCE: 55,  // Mirror AI: 55% (was 70)

  // Structure Analysis
  SWING_LOOKBACK: 15,
  STRUCTURE_MIN_BARS: 3,
  PULLBACK_THRESHOLD: 0.5,  // <0.5% from EMA = pullback zone

  // Entry Validation
  VOLUME_MIN: 1.2,
  MIN_RR_RATIO: 2.0,  // 1:2 minimum risk/reward

  // Position Management
  SL_PCT: 0.7,
  TRAIL_ACTIVATE: 1.5,
  TRAIL_DROP: 0.3,
  PYR_1: 1.5,
  PYR_2: 3.0,
};

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

    // 3. Structure Break (BOS)
    const recent = klines.slice(-5);
    const highest = Math.max(...recent.map(k => k.high));
    const lowest = Math.min(...recent.map(k => k.low));
    checks.structure_break = (price > highest || price < lowest) && recent.length >= 3;

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

// ================= MAIN ANALYZE =================
function analyze({ klines, position }) {
  try {
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

    // ================= SMC CHECKLIST ANALYSIS =================
    const checks = validateSMCChecklist(klines, price);
    const confluenceScore = calculateConfluenceScore(checks);
    const htf = calculateHTFConfidence(klines, price);

    // Score threshold: relaxed to 50 (mirror AI: was 65, now 50)
    if (confluenceScore < 50) {
      return { action: "HOLD", reason: `Confluence ${confluenceScore}% < 50`, source: "SMC_FILTER" };
    }

    // ================= HTF VALIDATION =================
    if (!htf || htf.confidence < CONFIG.HTF_MIN_CONFIDENCE) {
      return { action: "HOLD", reason: "HTF confidence too low", source: "HTF_FILTER" };
    }

    // ================= ENTRY SIGNAL =================
    const swings = extractSwings(klines);
    const prev = klines[klines.length - 2];

    // BULLISH: HTF bullish + structure valid
    if (htf.bias === "BULLISH" && checks.structure_break && checks.entry_candle_valid) {
      return buildEntry("LONG", price, "SMC");
    }

    // BEARISH: HTF bearish + structure valid
    if (htf.bias === "BEARISH" && checks.structure_break && checks.entry_candle_valid) {
      return buildEntry("SHORT", price, "SMC");
    }

    // SNIPER: pullback entry
    if (checks.mitigation_zone && checks.entry_candle_valid) {
      if (htf.bias === "BULLISH" && current.close > current.open) {
        return buildEntry("LONG", price, "SNIPER");
      }
      if (htf.bias === "BEARISH" && current.close < current.open) {
        return buildEntry("SHORT", price, "SNIPER");
      }
    }

    return { action: "HOLD" };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

// ================= ENTRY BUILDER =================
function buildEntry(side, price, setup = "SMC") {
  const sl = price * (1 - CONFIG.SL_PCT / 100);
  const r = Math.abs(price - sl);

  return {
    action: side,
    setup,
    entry: {
      price,
      sl: CONFIG.SL_PCT,
      trailActivate: CONFIG.TRAIL_ACTIVATE,
      trailDrop: CONFIG.TRAIL_DROP,
      pyr1: CONFIG.PYR_1,
      pyr2: CONFIG.PYR_2,
    },
    confidence: 70,  // Fallback confidence
    reason: `${setup} entry: ${side} at ${price.toFixed(2)}`,
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
