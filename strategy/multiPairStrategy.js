"use strict";

/**
 * Multi-Pair Strategy - Pair-Specific Trading Logic
 * Replaces BTC-centric logic with pair-aware analysis
 * 
 * Key improvements:
 * - Pair-specific regime detection
 * - Category-based filters (MAJOR/MID/MEME)
 * - Anti-fakeout protection
 * - Session optimization
 * - BTC sentiment as secondary filter only
 */

const { detectPairRegime, getBTCSentiment, adjustForBTCSentiment, getCurrentSession, getPairCategory } = require("./pairRegimeDetector");
const { validateEntry, checkMicroChop, checkTickNoise } = require("./antiFakeout");
const { getTPConfig } = require("./tpExitManager");
const { getPairBySymbol } = require("../config");

// EMA calculation
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

// ATR calculation
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

// Extract local swing highs/lows
function extractSwings(klines, lookback = 15) {
  const highs = [], lows = [];
  const k = klines.slice(-lookback * 2);
  for (let i = 2; i < k.length - 2; i++) {
    if (k[i].high >= k[i - 1].high && k[i].high >= k[i + 1].high &&
        k[i].high >= k[i - 2].high && k[i].high >= k[i + 2].high) {
      highs.push(k[i].high);
    }
    if (k[i].low <= k[i - 1].low && k[i].low <= k[i + 1].low &&
        k[i].low <= k[i - 2].low && k[i].low <= k[i + 2].low) {
      lows.push(k[i].low);
    }
  }
  return { highs: highs.slice(-3), lows: lows.slice(-3) };
}

// Calculate HTF confidence
function calculateHTFConfidence(klines, price, pairConfig) {
  if (!klines || klines.length < 50) return null;

  const emaPeriod = pairConfig?.botEMAPeriod || 50;
  const closes = klines.map(k => k.close);
  const emaVal = ema(closes, emaPeriod);

  if (!emaVal) return null;

  const isBullish = price > emaVal;
  const distFromEMA = Math.abs(price - emaVal) / emaVal * 100;
  let confidence = 100 - Math.min(distFromEMA * 2, 50);
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    bias: isBullish ? "BULLISH" : "BEARISH",
    confidence: Math.round(confidence),
    ema: emaVal,
  };
}

// SMC Checklist validation
function validateSMCChecklist(klines, price, pairConfig) {
  const category = getPairCategory(pairConfig?.symbol || "BTCUSDT");
  const checks = {
    htf_bias_clear: false,
    liquidity_swept: false,
    structure_break: false,
    mitigation_zone: false,
    choch_confirmed: false,
    entry_candle_valid: false,
    rr_minimum_met: false,
    no_htf_resistance: false,
    volume_spike: false,
  };

  try {
    const htf = calculateHTFConfidence(klines, price, pairConfig);
    const minHTFConf = pairConfig?.aiMinHTFConfidence || 65;
    checks.htf_bias_clear = htf && htf.confidence >= minHTFConf;

    const swings = extractSwings(klines);
    if (htf?.bias === "BULLISH" && swings.lows.length > 0) {
      const lastLow = Math.min(...swings.lows);
      checks.liquidity_swept = price > lastLow && (price - lastLow) / lastLow * 100 < 2;
    } else if (htf?.bias === "BEARISH" && swings.highs.length > 0) {
      const lastHigh = Math.max(...swings.highs);
      checks.liquidity_swept = price < lastHigh && (lastHigh - price) / lastHigh * 100 < 2;
    }

    // BOS - adjust threshold by category
    const bosThreshold = category === "MEME" ? 0.002 : category === "MID" ? 0.0015 : 0.001;
    const structureCandles = klines.slice(-15);
    const prevHigh = Math.max(...structureCandles.slice(0, -3).map(k => k.high));
    const prevLow = Math.min(...structureCandles.slice(0, -3).map(k => k.low));
    const lastClose = klines[klines.length - 1].close;
    checks.structure_break = lastClose > prevHigh * (1 + bosThreshold) || lastClose < prevLow * (1 - bosThreshold);

    // Mitigation zone
    if (htf?.ema) {
      const distFromEMA = Math.abs(price - htf.ema) / htf.ema * 100;
      const pullbackThresh = category === "MEME" ? 0.8 : 0.5;
      checks.mitigation_zone = distFromEMA < pullbackThresh;
    }

    // CHoCH
    if (klines.length >= 10) {
      const prev = klines.slice(-10, -5);
      const curr = klines.slice(-5);
      const prevLow = Math.min(...prev.map(k => k.low));
      const currLow = Math.min(...curr.map(k => k.low));
      const prevHigh = Math.max(...prev.map(k => k.high));
      const currHigh = Math.max(...curr.map(k => k.high));
      checks.choch_confirmed = (currLow < prevLow) || (currHigh > prevHigh);
    }

    // Entry candle
    const curr = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    if (curr && prev) {
      const bullishEngulf = curr.open <= prev.close && curr.close > prev.open;
      const bearishEngulf = curr.open >= prev.close && curr.close < prev.open;
      const strongBullish = curr.close > curr.open && (curr.close - curr.open) > (prev.high - prev.low) * 0.5;
      const strongBearish = curr.close < curr.open && (curr.open - curr.close) > (prev.high - prev.low) * 0.5;
      checks.entry_candle_valid = bullishEngulf || bearishEngulf || strongBullish || strongBearish;
    }

    // RR minimum
    const slPct = pairConfig?.botSLPct || 0.7;
    if (htf?.ema) {
      const sl = price * (1 - slPct / 100);
      const risk = Math.abs(price - sl);
      const tp = price + (risk * 2);
      checks.rr_minimum_met = risk > 0 && tp > price;
    }

    // Volume spike check - mandatory for MEME
    const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
    const avg20Vol = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
    const volRatio = avg20Vol > 0 ? last5Vol / (avg20Vol * 5) : 1;
    const minVolSpike = pairConfig?.minVolumeSpike || 1.2;
    checks.volume_spike = volRatio >= minVolSpike || category !== "MEME";

  } catch {}

  return checks;
}

// Calculate confluence score
function calculateConfluenceScore(checks, category) {
  if (!checks) return 0;
  
  let passed = Object.values(checks).filter(v => v === true).length;
  
  // MEME requires volume spike - if not, confluence = 0
  if (category === "MEME" && !checks.volume_spike) {
    return 0;
  }
  
  return Math.round((passed / 8) * 100);
}

// Main analysis function
function analyze({ klines, position, pairConfig, btcKlines }) {
  try {
    if (!Array.isArray(klines) || klines.length < 60) {
      return { action: "HOLD", reason: `Insufficient klines (${klines?.length || 0} < 60)`, source: "DATA_CHECK" };
    }

    const current = klines[klines.length - 1];
    const price = current?.close;
    if (!price) {
      return { action: "HOLD", reason: "No price data", source: "DATA_CHECK" };
    }

    const pairCfg = pairConfig || getPairBySymbol("BTCUSDT") || {};
    const category = getPairCategory(pairCfg.symbol || "BTCUSDT");
    const session = getCurrentSession();

    // === REGIME CHECK FIRST ===
    const regime = detectPairRegime(klines, pairCfg.symbol || "BTCUSDT");
    
    // Log regime for debugging
    if (global.botState) {
      global.botState.pairRegime = regime;
    }

    // Block if regime says no entry
    if (!regime.canEnter) {
      return {
        action: "HOLD",
        reason: `Regime: ${regime.regime} - ${regime.recommendations?.[0] || "Entry not allowed"}`,
        source: "REGIME_BLOCK",
        regime,
      };
    }

    // === POSITION MANAGEMENT ===
    if (position) {
      return managePosition(position, price, klines, pairCfg);
    }

    // === HTF ANALYSIS ===
    const htf = calculateHTFConfidence(klines, price, pairCfg);

    // === SMC CHECKLIST ===
    const checks = validateSMCChecklist(klines, price, pairCfg);
    const confluenceScore = calculateConfluenceScore(checks, category);

    // Minimum score by category
    const minScore = pairCfg.minScore || 65;
    if (confluenceScore < minScore) {
      return {
        action: "HOLD",
        reason: `Confluence ${confluenceScore}% < ${minScore}% (${category})`,
        source: "SMC_FILTER",
        regime,
      };
    }

    // === ANTI-FAKEOUT CHECK ===
    const signal = htf?.bias === "BULLISH" ? "LONG" : htf?.bias === "BEARISH" ? "SHORT" : "HOLD";
    const antiFakeout = validateEntry({
      symbol: pairCfg.symbol || "BTCUSDT",
      klines,
      signal,
      htfBias: htf?.bias,
      smcChecks: checks,
      momentum: null,
      session,
      positionOpenedAt: null,
    });

    if (!antiFakeout.allowed) {
      return {
        action: "HOLD",
        reason: antiFakeout.reasons.join("; "),
        source: "ANTI_FAKEOUT",
        regime,
      };
    }

    // === BTC SENTIMENT (secondary filter only) ===
    let btcSentiment = null;
    if (category !== "MAJOR" && btcKlines && btcKlines.length > 20) {
      btcSentiment = getBTCSentiment(btcKlines);
    }

    // === ENTRY SIGNAL GENERATION ===
    let entrySignal = null;

    // TREND entry: HTF aligned + BOS + valid candle
    if (htf?.bias === "BULLISH" && checks.structure_break && checks.entry_candle_valid) {
      // Check BTC sentiment for altcoins
      if (category !== "MAJOR" && btcSentiment) {
        const adj = adjustForBTCSentiment(regime, btcSentiment, "LONG");
        if (!adj.adjusted) {
          return {
            action: "HOLD",
            reason: adj.reason,
            source: "BTC_FILTER",
            regime,
          };
        }
      }
      entrySignal = buildEntry("LONG", price, "TREND", klines, pairCfg);
    }
    else if (htf?.bias === "BEARISH" && checks.structure_break && checks.entry_candle_valid) {
      if (category !== "MAJOR" && btcSentiment) {
        const adj = adjustForBTCSentiment(regime, btcSentiment, "SHORT");
        if (!adj.adjusted) {
          return {
            action: "HOLD",
            reason: adj.reason,
            source: "BTC_FILTER",
            regime,
          };
        }
      }
      entrySignal = buildEntry("SHORT", price, "TREND", klines, pairCfg);
    }

    // SNIPER entry: mitigation zone + momentum + strong candle
    if (!entrySignal && checks.mitigation_zone && checks.entry_candle_valid) {
      const momentumScore = calcMomentumScore(klines);
      const hasPositiveMomentum = momentumScore >= 55;
      const hasNegativeMomentum = momentumScore <= 45;

      if (htf?.bias === "BULLISH" && hasPositiveMomentum) {
        entrySignal = buildEntry("LONG", price, "SNIPER", klines, pairCfg);
      }
      if (htf?.bias === "BEARISH" && hasNegativeMomentum) {
        entrySignal = buildEntry("SHORT", price, "SNIPER", klines, pairCfg);
      }
    }

    // RELAXED entry: high confluence + strong HTF
    if (!entrySignal) {
      const hasGoodConfluence = confluenceScore >= (category === "MEME" ? 70 : 60);
      const hasStrongHTF = htf && htf.confidence >= (category === "MEME" ? 80 : 75);

      if (hasGoodConfluence && hasStrongHTF && htf?.bias) {
        const side = htf.bias === "BULLISH" ? "LONG" : "SHORT";
        entrySignal = buildEntry(side, price, "RELAXED", klines, pairCfg);
      }
    }

    if (entrySignal) {
      // Add anti-fakeout score to entry
      entrySignal.antiFakeoutScore = antiFakeout.score;
      entrySignal.antiFakeoutGrade = antiFakeout.grade;
      entrySignal.regime = regime;
      return entrySignal;
    }

    // Hold with reasons
    const unmet = [];
    if (!checks.structure_break) unmet.push("awaiting_BOS");
    if (!checks.entry_candle_valid) unmet.push("weak_candle");
    if (!checks.mitigation_zone) unmet.push("no_pullback");
    if (!checks.volume_spike && category === "MEME") unmet.push("no_vol_spike");

    return {
      action: "HOLD",
      reason: `Setup not ready: ${unmet.join(", ")} | Conf: ${confluenceScore}%`,
      source: "AWAITING_SETUP",
      regime,
    };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

// Momentum score calculation
function calcMomentumScore(klines) {
  if (klines.length < 10) return 50;
  const last5 = klines.slice(-5);
  const prev5 = klines.slice(-10, -5);
  const lastAvgClose = last5.reduce((s, k) => s + k.close, 0) / 5;
  const prevAvgClose = prev5.reduce((s, k) => s + k.close, 0) / 5;
  const lastAvgVol = last5.reduce((s, k) => s + k.volume, 0) / 5;
  const prevAvgVol = prev5.reduce((s, k) => s + k.volume, 0) / 5;
  const priceMom = (lastAvgClose - prevAvgClose) / prevAvgClose * 100;
  const volRatio = prevAvgVol > 0 ? lastAvgVol / prevAvgVol : 1;
  const score = 50 + (priceMom * 10) + ((volRatio - 1) * 15);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Build entry with TP/SL
function buildEntry(side, price, setup, klines, pairConfig) {
  const category = getPairCategory(pairConfig?.symbol || "BTCUSDT");
  const slPct = pairConfig?.botSLPct || (category === "MEME" ? 1.0 : category === "MID" ? 0.8 : 0.6);

  // ATR-based SL
  let slPctFinal = slPct;
  if (klines.length >= 15) {
    const atrPct = calcATR(klines, 14);
    const atrMultiplier = category === "MEME" ? 2.0 : 1.5;
    slPctFinal = Math.max(slPct, Math.min(slPct * 2, atrPct * atrMultiplier));
  }

  const sl = side === "LONG" ? price * (1 - slPctFinal / 100) : price * (1 + slPctFinal / 100);
  const risk = Math.abs(price - sl);

  // TP levels by category
  const tpConfig = getTPConfig(pairConfig?.symbol || "BTCUSDT");
  const tp1 = side === "LONG" ? price + risk * tpConfig.tp1Percent : price - risk * tpConfig.tp1Percent;
  const tp2 = side === "LONG" ? price + risk * tpConfig.tp2Percent : price - risk * tpConfig.tp2Percent;
  const tp3 = side === "LONG" ? price + risk * tpConfig.runnerTarget : price - risk * tpConfig.runnerTarget;

  return {
    action: side,
    setup,
    entry: {
      price,
      sl: slPctFinal,
      sl_price: +sl.toFixed(6),
      tp1: +tp1.toFixed(6),
      tp2: +tp2.toFixed(6),
      tp3: +tp3.toFixed(6),
      maxHoldMs: getMaxHoldMs(setup, pairConfig?.symbol || "BTCUSDT"),
      trailActivate: tpConfig.trailActivate,
      trailDrop: tpConfig.trailDrop,
    },
    confidence: 65,
    reason: `${setup}: ${side} SL=${slPctFinal.toFixed(1)}%`,
    source: "MULTI_PAIR_STRATEGY",
  };
}

function getMaxHoldMs(setup, symbol) {
  const category = getPairCategory(symbol);
  const baseMin = {
    MAJOR: 120 * 60 * 1000,
    MID: 150 * 60 * 1000,
    MEME: 180 * 60 * 1000,
  }[category] || 120 * 60 * 1000;

  if (/SNIPER|ULTRA/.test(setup)) return baseMin * 0.75;
  if (/JUDAS/.test(setup)) return baseMin * 1.5;
  return baseMin;
}

// Position management with pair-specific TP
function managePosition(pos, price, klines, pairConfig) {
  try {
    if (!pos || typeof pos.entry !== "number") {
      return { action: "HOLD" };
    }

    const pnl = pos.side === "LONG"
      ? (price - pos.entry) / pos.entry * 100
      : (pos.entry - price) / pos.entry * 100;

    if (typeof pos.peak !== "number") pos.peak = 0;
    pos.peak = Math.max(pos.peak, pnl);
    pos.peakPnl = Math.max(pos.peakPnl || 0, pnl);

    // SL check
    if (pnl <= -pos.sl) {
      return { action: "CLOSE", reason: "STOP LOSS" };
    }

    // TP logic from tpExitManager
    const tpCheck = require("./tpExitManager");
    const tpResult = tpCheck.shouldTakeTP(pos, price, pos.entry, pos.side);
    if (tpResult.action !== "HOLD") {
      return tpResult;
    }

    // Break even move
    const beResult = tpCheck.shouldMoveToBreakEven(pos, price, pos.entry, pos.side);
    if (beResult.shouldMove) {
      return { action: "UPDATE_SL", new_sl: beResult.newSL, reason: beResult.reason };
    }

    // Trail activation
    const trailResult = tpCheck.shouldActivateTrail(pos, price, pos.entry, pos.side);
    if (trailResult.shouldTrail) {
      return { action: "UPDATE_SL", new_sl: trailResult.newSL, reason: trailResult.reason };
    }

    // Max hold safety
    const holdMs = pos.openedAt ? (Date.now() - pos.openedAt) : 0;
    const maxHold = pos.maxHoldMs || getMaxHoldMs(pos.setup || "TREND", pos.symbol);
    if (holdMs > maxHold) {
      if (pnl <= 0) {
        return { action: "CLOSE", reason: `TIMEOUT_SAFETY` };
      }
      if (pos.slPrice !== pos.entry) {
        return { action: "UPDATE_SL", new_sl: pos.entry, reason: "TIMEOUT_TRAIL" };
      }
    }

    return { action: "HOLD" };
  } catch {
    return { action: "HOLD" };
  }
}

module.exports = { analyze };