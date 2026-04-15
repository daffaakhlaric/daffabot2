"use strict";

/**
 * ENTRY PROTOCOL — Institutional-grade entry quality & risk management
 *
 * 6 Core Rules:
 * 1. HTF Trend Alignment (1H + 4H must align)
 * 2. Minimum Hold Time Filter (< 10 min = reject)
 * 3. Pair Concentration Limit (max 40%, pause BTC after 2 losses)
 * 4. Consecutive Loss Circuit Breaker (3 losses = 2hr stop)
 * 5. Entry Quality Scoring (0-100, min 65)
 * 6. JSON Output Format (structured decisions)
 */

const { time } = require("../utils");

// ═══════════════════════════════════════════════════════════════
// RULE 1: HTF TREND ALIGNMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Analyze HTF trend structure
 * @param {Array} klines_1h - 1H klines
 * @param {Array} klines_4h - 4H klines
 * @returns {Object} { trend_1h, trend_4h, aligned, reason }
 */
function analyzeHTFTrend(klines_1h = [], klines_4h = []) {
  if (!klines_1h || klines_1h.length < 5 || !klines_4h || klines_4h.length < 5) {
    return {
      trend_1h: "UNKNOWN",
      trend_4h: "UNKNOWN",
      aligned: false,
      reason: "Insufficient kline data",
    };
  }

  // Analyze 1H trend: HH/HL = bullish, LH/LL = bearish
  const h1_recent = klines_1h.slice(-3);
  const h1_trend = detectTrendStructure(h1_recent);

  // Analyze 4H trend
  const h4_recent = klines_4h.slice(-3);
  const h4_trend = detectTrendStructure(h4_recent);

  // Check alignment
  const aligned =
    (h1_trend === "bullish" && h4_trend === "bullish") ||
    (h1_trend === "bearish" && h4_trend === "bearish");

  return {
    trend_1h: h1_trend,
    trend_4h: h4_trend,
    aligned,
    reason: aligned ? "HTF aligned" : `HTF misaligned: 1H=${h1_trend}, 4H=${h4_trend}`,
  };
}

/**
 * Detect trend structure from 3 recent candles
 * HH/HL = bullish, LH/LL = bearish, else choppy
 */
function detectTrendStructure(recentCandles) {
  if (recentCandles.length < 3) return "UNKNOWN";

  const c1 = recentCandles[0];
  const c2 = recentCandles[1];
  const c3 = recentCandles[2];

  const h1 = parseFloat(c1.high);
  const h2 = parseFloat(c2.high);
  const h3 = parseFloat(c3.high);
  const l1 = parseFloat(c1.low);
  const l2 = parseFloat(c2.low);
  const l3 = parseFloat(c3.low);

  // Bullish: HH + HL (higher highs, higher lows)
  if ((h2 > h1 && h3 > h2) && (l2 > l1 && l3 > l2)) {
    return "bullish";
  }

  // Bearish: LH + LL (lower highs, lower lows)
  if ((h2 < h1 && h3 < h2) && (l2 < l1 && l3 < l2)) {
    return "bearish";
  }

  return "choppy";
}

// ═══════════════════════════════════════════════════════════════
// RULE 2: MINIMUM HOLD TIME FILTER
// ═══════════════════════════════════════════════════════════════

/**
 * Check if entry is too tight (not worth trading)
 * ⭐ FIXED: Uses ATR to estimate realistic hold time, not simple risk %
 * @param {number} entry - Entry price
 * @param {number} sl - Stop loss price
 * @param {number} tp - Take profit price
 * @param {string} side - LONG or SHORT
 * @param {Array} klines_5m - Recent 5m candles (for ATR calculation)
 * @param {number} minHoldMinutes - Minimum hold time (default 10)
 * @returns {Object} { valid, estimated_hold_min, reason }
 */
function checkMinimumHoldTime(entry, sl, tp, side = "LONG", klines_5m = [], minHoldMinutes = 10) {
  if (!entry || !sl || !tp) {
    return {
      valid: false,
      estimated_hold_min: 0,
      reason: "Invalid entry/SL/TP prices",
    };
  }

  // Calculate risk distance
  const riskDistance = side === "LONG" ? entry - sl : sl - entry;
  const riskPercent = (riskDistance / entry) * 100;

  // Rule: SL < 0.1% from entry = micro trade = reject (too small)
  if (riskPercent < 0.1) {
    return {
      valid: false,
      estimated_hold_min: 0,
      riskPercent: riskPercent.toFixed(4),
      reason: `SL too close: ${riskPercent.toFixed(4)}% risk (< 0.1% min)`,
    };
  }

  // ⭐ FIXED: Use ATR to estimate realistic hold time
  let estimatedHoldMin = minHoldMinutes; // Default fallback

  if (klines_5m && klines_5m.length >= 20) {
    try {
      // Calculate ATR from recent 5m candles
      const tr = [];
      for (let i = 1; i < klines_5m.length; i++) {
        const h = klines_5m[i].high;
        const l = klines_5m[i].low;
        const pc = klines_5m[i - 1].close;
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      const atrVal = tr.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, tr.length);
      const atrPercent = (atrVal / entry) * 100;

      // Estimate: How many 5m candles needed to move from entry to TP?
      // Assuming average candle move ≈ ATR/2 (realistic)
      const tpDistance = Math.abs(tp - entry);
      const tpDistancePercent = (tpDistance / entry) * 100;

      // If ATR is 0.15%, and TP is 0.5% away, need ~3-4 candles (15-20m)
      if (atrPercent > 0) {
        const candlesNeeded = Math.ceil(tpDistancePercent / (atrPercent / 2));
        estimatedHoldMin = candlesNeeded * 5; // Each candle = 5m
      }
    } catch {
      // Fallback to risk-based estimate if ATR calculation fails
      estimatedHoldMin = Math.max(minHoldMinutes, riskPercent * 50);
    }
  } else {
    // Fallback: No klines available, use risk-based estimate
    estimatedHoldMin = Math.max(minHoldMinutes, riskPercent * 50);
  }

  return {
    valid: estimatedHoldMin >= minHoldMinutes,
    estimated_hold_min: Math.round(estimatedHoldMin),
    riskPercent: riskPercent.toFixed(4),
    tpDistancePercent: ((Math.abs(tp - entry) / entry) * 100).toFixed(4),
    reason: estimatedHoldMin >= minHoldMinutes
      ? `Hold time sufficient (~${Math.round(estimatedHoldMin)}min)`
      : `Estimated hold ${estimatedHoldMin.toFixed(0)}m < ${minHoldMinutes}m`,
  };
}

// ═══════════════════════════════════════════════════════════════
// RULE 3: PAIR CONCENTRATION LIMIT
// ═══════════════════════════════════════════════════════════════

/**
 * Check pair concentration and BTC pause rules
 * @param {string} pair - Current pair
 * @param {Array} tradeHistory - All trades
 * @returns {Object} { allowed, concentration_pct, btc_paused, reason }
 */
function checkPairConcentration(pair = "BTCUSDT", tradeHistory = []) {
  // Get today's trades
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  const todayTrades = tradeHistory.filter(t => t.closeTime && t.closeTime > todayStart);

  if (todayTrades.length === 0) {
    return {
      allowed: true,
      concentration_pct: 0,
      btc_paused: false,
      reason: "No trades today yet",
    };
  }

  // Calculate pair concentration
  const pairCount = todayTrades.filter(t => t.symbol === pair).length;
  const concentrationPct = (pairCount / todayTrades.length) * 100;

  // Rule 3a: Max 40% from same pair
  if (concentrationPct >= 40) {
    return {
      allowed: false,
      concentration_pct: concentrationPct.toFixed(1),
      pair_trades: pairCount,
      total_trades: todayTrades.length,
      btc_paused: false,
      reason: `Pair concentration ${concentrationPct.toFixed(1)}% >= 40% limit`,
    };
  }

  // Rule 3b: Pause BTC after 2 consecutive losses
  let btc_paused = false;
  let btc_pause_reason = null;

  if (pair === "BTCUSDT") {
    const btcTrades = todayTrades.filter(t => t.symbol === "BTCUSDT").slice(-2);
    if (btcTrades.length === 2) {
      const both_loss = btcTrades.every(t => t.pnlPercent < 0);
      if (both_loss) {
        btc_paused = true;
        btc_pause_reason = "BTC: 2 consecutive losses, pause 1 hour";
      }
    }
  }

  return {
    allowed: !btc_paused,
    concentration_pct: concentrationPct.toFixed(1),
    pair_trades: pairCount,
    total_trades: todayTrades.length,
    btc_paused,
    reason: btc_pause_reason || `Concentration ${concentrationPct.toFixed(1)}% OK`,
  };
}

// ═══════════════════════════════════════════════════════════════
// RULE 4: CONSECUTIVE LOSS CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════

/**
 * Check for 3+ consecutive losses
 * @param {Array} tradeHistory - All trades
 * @returns {Object} { trading_blocked, loss_streak, pause_reason }
 */
function checkConsecutiveLossCircuit(tradeHistory = []) {
  if (!tradeHistory || tradeHistory.length < 3) {
    return {
      trading_blocked: false,
      loss_streak: 0,
    };
  }

  let lossStreak = 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    if (tradeHistory[i].pnlPercent < 0) {
      lossStreak++;
    } else {
      break;
    }
  }

  const blocked = lossStreak >= 3;

  return {
    trading_blocked: blocked,
    loss_streak: lossStreak,
    pause_reason: blocked ? `${lossStreak} consecutive losses: 2-hour trading pause` : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// RULE 5: ENTRY QUALITY SCORING (0-100) with Fee Adjustment (⭐ FIXED)
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate fee-adjusted risk:reward ratio
 * ⭐ FIXED: Accounts for Bitget maker/taker fees (0.05% each way)
 * @param {number} entry - Entry price
 * @param {number} sl - Stop loss price
 * @param {number} tp - Take profit price
 * @param {number} makerFeePercent - Maker fee % (default 0.05%)
 * @returns {number} Fee-adjusted RR
 */
function calculateFeeAdjustedRR(entry, sl, tp, makerFeePercent = 0.05) {
  if (!entry || !sl || !tp) return 0;

  // Add fee to SL distance (makes risk wider), subtract from TP distance (reduces reward)
  const riskDistance = Math.abs(entry - sl) + (entry * makerFeePercent / 100);
  const rewardDistance = Math.abs(tp - entry) - (entry * makerFeePercent / 100);

  // Prevent division by zero or negative reward
  if (riskDistance <= 0 || rewardDistance <= 0) return 0;

  return rewardDistance / riskDistance;
}

/**
 * Calculate entry quality score (0-100)
 * ⭐ FIXED: Now uses fee-adjusted RR for more realistic scoring
 * Components:
 *   [+30] HTF trend alignment
 *   [+20] SMC structure valid
 *   [+15] Volume confirmation
 *   [+15] No major news in 30m
 *   [+10] Risk:Reward >= 1:1.5 (fee-adjusted)
 *   [+10] Entry near POI/OB/FVG
 */
function calculateEntryScore(params = {}) {
  const {
    htf_aligned = false,
    smc_valid = false,
    volume_confirmed = false,
    no_news_30m = true,
    risk_reward = 1.0, // Fee-adjusted RR
    entry_at_poi = false,
  } = params;

  let score = 0;
  const components = [];

  // [+30] HTF trend alignment
  if (htf_aligned) {
    score += 30;
    components.push({ item: "HTF aligned (1H+4H)", points: 30 });
  } else {
    components.push({ item: "HTF aligned (1H+4H)", points: 0 });
  }

  // [+20] SMC structure
  if (smc_valid) {
    score += 20;
    components.push({ item: "SMC valid (BOS+CHoCH)", points: 20 });
  } else {
    components.push({ item: "SMC valid (BOS+CHoCH)", points: 0 });
  }

  // [+15] Volume confirmation
  if (volume_confirmed) {
    score += 15;
    components.push({ item: "Volume confirmed", points: 15 });
  } else {
    components.push({ item: "Volume confirmed", points: 0 });
  }

  // [+15] No major news
  if (no_news_30m) {
    score += 15;
    components.push({ item: "No news in 30m", points: 15 });
  } else {
    components.push({ item: "No news in 30m", points: 0 });
  }

  // [+10] Risk:Reward >= 1:1.5 (fee-adjusted)
  if (risk_reward >= 1.5) {
    score += 10;
    components.push({ item: "RR >= 1.5 (fee-adjusted)", points: 10 });
  } else {
    components.push({ item: "RR >= 1.5 (fee-adjusted)", points: 0 });
  }

  // [+10] Entry at POI/OB/FVG
  if (entry_at_poi) {
    score += 10;
    components.push({ item: "Entry at POI/OB/FVG", points: 10 });
  } else {
    components.push({ item: "Entry at POI/OB/FVG", points: 0 });
  }

  return {
    total_score: Math.min(100, score),
    approved: score >= 65,
    components,
    reasons: {
      htf_aligned,
      smc_valid,
      volume_confirmed,
      no_news_30m,
      risk_reward: risk_reward.toFixed(2),
      entry_at_poi,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// RULE 6: STRUCTURED ENTRY DECISION (JSON OUTPUT)
// ═══════════════════════════════════════════════════════════════

/**
 * MASTER: Evaluate entry signal and return structured decision
 * ⭐ FIXED: Now uses ATR-based hold time, fee-adjusted RR, and klines_5m
 * @returns {Object} Structured decision JSON
 */
function evaluateEntrySignal(params = {}) {
  const {
    pair = "BTCUSDT",
    direction = "LONG",
    entry = 0,
    sl = 0,
    tp = 0,
    klines_1h = [],
    klines_4h = [],
    klines_5m = [],  // ⭐ NEW: For ATR-based hold time
    tradeHistory = [],
    smc_valid = false,
    volume_confirmed = false,
    no_news_30m = true,
    entry_at_poi = false,
  } = params;

  // 1. HTF Trend Alignment
  const htf = analyzeHTFTrend(klines_1h, klines_4h);

  // 2. Minimum Hold Time (⭐ FIXED: Now with ATR-based calculation)
  const holdTime = checkMinimumHoldTime(entry, sl, tp, direction, klines_5m, 10);

  // 3. Pair Concentration
  const concentration = checkPairConcentration(pair, tradeHistory);

  // 4. Consecutive Loss Circuit
  const circuit = checkConsecutiveLossCircuit(tradeHistory);

  // 5. Entry Quality Score (⭐ FIXED: Now fee-adjusted RR)
  const feeAdjustedRR = calculateFeeAdjustedRR(entry, sl, tp, 0.05); // 0.05% maker fee
  const scoreResult = calculateEntryScore({
    htf_aligned: htf.aligned,
    smc_valid,
    volume_confirmed,
    no_news_30m,
    risk_reward: feeAdjustedRR,
    entry_at_poi,
  });

  // Determine approval
  const blocks = [];
  if (!htf.aligned) blocks.push("HTF not aligned");
  if (!holdTime.valid) blocks.push(`Hold time insufficient (${holdTime.estimated_hold_min}m < 10m)`);
  if (!concentration.allowed) blocks.push(concentration.reason);
  if (circuit.trading_blocked) blocks.push(circuit.pause_reason);
  if (!scoreResult.approved) blocks.push(`Score ${scoreResult.total_score} < 65 minimum`);

  const entry_approved = blocks.length === 0;

  // Return structured JSON
  return {
    timestamp: Date.now(),
    pair,
    direction,
    entry_price: entry,
    stop_loss: sl,
    take_profit: tp,

    // HTF Analysis
    htf_trend_1h: htf.trend_1h,
    htf_trend_4h: htf.trend_4h,
    htf_aligned: htf.aligned,

    // Hold Time
    estimated_hold_min: holdTime.estimated_hold_min,
    hold_time_valid: holdTime.valid,

    // Pair Concentration
    pair_concentration_pct: parseFloat(concentration.concentration_pct),
    btc_paused: concentration.btc_paused,

    // Loss Circuit
    loss_streak: circuit.loss_streak,
    trading_blocked_by_circuit: circuit.trading_blocked,

    // Entry Quality Score
    entry_score: scoreResult.total_score,
    score_components: scoreResult.components,

    // Risk:Reward (⭐ FIXED: Fee-adjusted)
    risk_reward_raw: ((Math.abs((tp - entry) / (entry - sl))).toFixed(2)), // Before fees
    risk_reward_fee_adjusted: feeAdjustedRR.toFixed(2), // After 0.05% fees
    used_for_score: feeAdjustedRR.toFixed(2), // Which RR was used for scoring

    // FINAL DECISION
    entry_approved,
    rejection_reasons: blocks.length > 0 ? blocks : null,

    // Summary
    summary: entry_approved
      ? `✅ APPROVED: ${pair} ${direction} at ${entry}`
      : `❌ REJECTED: ${blocks.join("; ")}`,
  };
}

module.exports = {
  analyzeHTFTrend,
  detectTrendStructure,
  checkMinimumHoldTime,
  checkPairConcentration,
  checkConsecutiveLossCircuit,
  calculateEntryScore,
  calculateFeeAdjustedRR,  // ⭐ NEW EXPORT
  evaluateEntrySignal,
};
