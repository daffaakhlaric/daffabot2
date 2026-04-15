"use strict";

/**
 * ENTRY QUALITY FILTER — Stop false breakouts & chop trades
 * Pure module, zero API calls.
 *
 * Features:
 * 1. STRICT DECISION SCORE — SAFE 70, SNIPER 80, TREND 75
 * 2. SMC CHECKLIST TIGHTENING — BOS 0.12%, volume 1.2, RR 2.0
 * 3. CHOP FILTER — Block during choppy conditions
 * 4. CANDLE CONFIRMATION — Wait 40-50% candle before entry
 * 5. ATR-BASED SL — More realistic stop losses
 * 6. PAIR PRIORITY — BTC > ETH > SOL > BNB
 * 7. LOSS STREAK DEFENSE — Raise quality after losses
 */

// ── STRICT MINIMUM DECISION SCORES ──────────────────────────
/**
 * Get minimum required score based on setup type & current conditions
 * @param {string} setupType - 'SAFE', 'SNIPER', 'TREND', etc.
 * @param {number} lossStreak - Number of consecutive losses
 * @returns { min_score, reason }
 */
function getMinimumDecisionScore(setupType = "SAFE", lossStreak = 0) {
  let minScore = 55; // Default fallback
  let reason = "Default fallback";

  // Base scores by setup type (STRICT)
  if (setupType === "SNIPER") {
    minScore = 80;
    reason = "SNIPER setup requires 80+ (very high conviction)";
  } else if (setupType === "TREND") {
    minScore = 75;
    reason = "TREND setup requires 75+ (high conviction)";
  } else if (setupType === "SAFE") {
    minScore = 70;
    reason = "SAFE mode requires 70+ (good confluence)";
  } else if (setupType === "KILLER") {
    minScore = 75;
    reason = "KILLER setup requires 75+ (need confirmation)";
  }

  // LOSS STREAK PENALTY — Raise requirement after consecutive losses
  if (lossStreak >= 2) {
    minScore += 10;
    reason += ` + LOSS_STREAK_${lossStreak} penalty (+10)`;
  }
  if (lossStreak >= 3) {
    minScore = 999; // Block all (pause trading)
    reason = `LOSS_STREAK_${lossStreak}: PAUSE ALL TRADING for 4 hours`;
  }

  return {
    min_score: minScore,
    reason,
    approved: minScore < 999,
  };
}

// ── CHOP FILTER ─────────────────────────────────────────────
/**
 * Detect choppy market conditions
 * - High/low overlap on last 10 candles
 * - Small ATR (low volatility)
 * - Small candle bodies
 */
function checkChopConditions(klines) {
  if (!klines || klines.length < 10) {
    return { is_chop: false, reason: null, chop_signals: 0 };
  }

  const recent = klines.slice(-10);
  let chopSignals = 0;
  const signals = [];

  // Signal 1: High/low overlap (indication of choppy market)
  const highs = recent.map(k => k.high);
  const lows = recent.map(k => k.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const range = maxHigh - minLow;
  const avgHigh = highs.reduce((a, b) => a + b) / highs.length;
  const avgLow = lows.reduce((a, b) => a + b) / lows.length;
  const overlapRatio = (avgHigh - avgLow) / range;

  if (overlapRatio < 0.4) {
    chopSignals++;
    signals.push("High/low overlap > 60% (choppy)");
  }

  // Signal 2: Small ATR (low volatility)
  const atrValues = recent.map((k, i) => {
    if (i === 0) return 0;
    const tr = Math.max(
      k.high - k.low,
      Math.abs(k.high - recent[i-1].close),
      Math.abs(k.low - recent[i-1].close)
    );
    return tr;
  });
  const atr = atrValues.slice(1).reduce((a, b) => a + b) / (atrValues.length - 1);
  const atrPct = recent[recent.length - 1].close > 0
    ? (atr / recent[recent.length - 1].close) * 100
    : 0;

  if (atrPct < 0.3) {
    chopSignals++;
    signals.push(`ATR very small ${atrPct.toFixed(3)}% (low volatility)`);
  }

  // Signal 3: Small candle bodies
  const smallBodies = recent.filter(k => {
    const body = Math.abs(k.close - k.open);
    const range = k.high - k.low;
    return body < range * 0.2; // Body < 20% of range
  }).length;

  if (smallBodies >= 7) {
    chopSignals++;
    signals.push(`${smallBodies}/10 candles have small bodies`);
  }

  const isChop = chopSignals >= 2;

  return {
    is_chop: isChop,
    reason: isChop ? `CHOP conditions detected (${chopSignals} signals)` : null,
    chop_signals: chopSignals,
    signal_details: signals,
    atr_pct: +atrPct.toFixed(3),
    high_low_overlap_pct: +(overlapRatio * 100).toFixed(1),
  };
}

// ── CANDLE CONFIRMATION WAIT ────────────────────────────────
/**
 * Check if we've waited enough time into the candle
 * For 1m candle: wait 40-50 seconds (default 40% minimum)
 * Prevents entry on wick traps at candle start
 */
function checkCandleConfirmation(candleStartTime, currentTime, candlePeriodMs = 60000) {
  const elapsedMs = currentTime - candleStartTime;
  const confirmationThresholdMs = candlePeriodMs * 0.4; // 40% into candle

  const confirmed = elapsedMs >= confirmationThresholdMs;
  const remainingMs = Math.max(0, confirmationThresholdMs - elapsedMs);

  return {
    confirmed,
    reason: !confirmed
      ? `Candle confirmation: wait ${Math.ceil(remainingMs / 1000)}s more (${Math.round((elapsedMs / confirmationThresholdMs) * 100)}% in)`
      : null,
    elapsed_ms: elapsedMs,
    required_ms: confirmationThresholdMs,
    candle_progress_pct: +(elapsedMs / candlePeriodMs * 100).toFixed(1),
  };
}

// ── ATR-BASED STOP LOSS ─────────────────────────────────────
/**
 * Calculate realistic SL based on ATR instead of fixed %
 * SL = ATR × 1.2 (gives room for noise)
 */
function calculateATRBasedSL(klines, side = "LONG") {
  if (!klines || klines.length < 14) {
    return { sl_pct: null, sl_points: null, reason: "Not enough data" };
  }

  // Calculate ATR (14 period standard)
  const recent = klines.slice(-14);
  const atrValues = [];

  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i-1].close),
      Math.abs(recent[i].low - recent[i-1].close)
    );
    atrValues.push(tr);
  }

  const atr = atrValues.reduce((a, b) => a + b) / atrValues.length;
  const price = recent[recent.length - 1].close;

  // SL = ATR × 1.2
  const slPoints = atr * 1.2;
  const slPct = (slPoints / price) * 100;

  return {
    sl_pct: +slPct.toFixed(2),
    sl_points: +slPoints.toFixed(2),
    atr: +atr.toFixed(2),
    price,
    reason: `ATR ${atr.toFixed(2)} × 1.2 = SL ${slPct.toFixed(2)}%`,
  };
}

// ── PAIR PRIORITY FILTER ────────────────────────────────────
/**
 * Don't force alt entries if BTC condition is unclear
 * Priority: BTC > ETH > SOL > BNB
 */
function checkPairPriority(currentSymbol, btcScore, altScore, btcStatus = "UNCLEAR") {
  const pairPriority = {
    "BTCUSDT": 1,
    "ETHUSDT": 2,
    "SOLUSDT": 3,
    "BNBUSDT": 4,
    "XRPUSDT": 4,
    "PEPEUSDT": 5,
  };

  const currentPriority = pairPriority[currentSymbol] || 999;
  const btcPriority = 1;

  let blocked = false;
  let reason = null;

  // Rule 1: Don't force alt entry if BTC is unclear
  if (currentSymbol !== "BTCUSDT" && btcStatus === "UNCLEAR") {
    blocked = true;
    reason = `ALT_SKIP: BTC market unclear, skip ${currentSymbol} entry`;
  }

  // Rule 2: If alt score < BTC score significantly, skip
  if (currentSymbol !== "BTCUSDT" && altScore < btcScore - 5) {
    blocked = true;
    reason = `ALT_SKIP: ${currentSymbol} score ${altScore} << BTC ${btcScore}`;
  }

  return {
    blocked,
    reason,
    current_pair: currentSymbol,
    current_priority: currentPriority,
    btc_priority: btcPriority,
    btc_score: btcScore,
    alt_score: altScore,
    score_gap: btcScore - altScore,
  };
}

// ── LOSS STREAK DEFENSE ─────────────────────────────────────
/**
 * After consecutive losses, increase quality requirements
 * 2 losses: +10 to min score, disable sniper 2 hours
 * 3 losses: PAUSE all trading 4 hours
 */
function checkLossStreakDefense(tradeHistory) {
  const trades = tradeHistory || [];
  let lossStreak = 0;

  // Count consecutive losses from end
  for (let i = trades.length - 1; i >= 0; i--) {
    if ((trades[i].pnlUSDT || 0) < 0) {
      lossStreak++;
    } else {
      break;
    }
  }

  let blocked = false;
  let minScoreBoost = 0;
  let sniperDisabled = false;
  let blockReason = null;

  if (lossStreak >= 3) {
    blocked = true;
    blockReason = `LOSS_STREAK_3: PAUSE all trading 4 hours`;
  } else if (lossStreak === 2) {
    minScoreBoost = 10;
    sniperDisabled = true;
    blockReason = `LOSS_STREAK_2: Min score +10, sniper disabled 2h`;
  }

  return {
    blocked,
    consecutive_losses: lossStreak,
    min_score_boost: minScoreBoost,
    sniper_disabled: sniperDisabled,
    reason: blockReason,
    trading_allowed: !blocked,
  };
}

// ── RUN ALL ENTRY QUALITY CHECKS ────────────────────────────
/**
 * Master entry quality check function
 */
function runEntryQualityChecks({
  setupType = "SAFE",
  decisionScore = 55,
  klines = [],
  candleStartTime = 0,
  currentTime = Date.now(),
  tradeHistory = [],
  currentSymbol = "BTCUSDT",
  btcScore = 55,
  btcStatus = "UNKNOWN",
  candlePeriodMs = 60000,
} = {}) {
  const blocks = [];
  const warnings = [];
  const details = {};

  // 1. STRICT MINIMUM SCORE CHECK
  const lossStreak = getConsecutiveLosses(tradeHistory);
  const minScoreReq = getMinimumDecisionScore(setupType, lossStreak);
  if (!minScoreReq.approved) {
    blocks.push({ type: "LOSS_STREAK_PAUSE", reason: minScoreReq.reason });
  } else if (decisionScore < minScoreReq.min_score) {
    blocks.push({ type: "LOW_DECISION_SCORE", reason: `Score ${decisionScore} < required ${minScoreReq.min_score} (${setupType})` });
  }
  details.minScore = minScoreReq;

  // 2. CHOP FILTER
  const chop = checkChopConditions(klines);
  if (chop.is_chop) {
    blocks.push({ type: "CHOP_CONDITIONS", reason: chop.reason });
  }
  details.chop = chop;

  // 3. CANDLE CONFIRMATION
  const candleConf = checkCandleConfirmation(candleStartTime, currentTime, candlePeriodMs);
  if (!candleConf.confirmed) {
    blocks.push({ type: "CANDLE_NOT_CONFIRMED", reason: candleConf.reason });
  }
  details.candleConfirmation = candleConf;

  // 4. ATR-BASED SL
  const atrSL = calculateATRBasedSL(klines);
  if (atrSL.sl_pct) {
    warnings.push({ type: "ATR_SL", message: `Use ATR-based SL: ${atrSL.sl_pct}% (${atrSL.sl_points} pts)` });
  }
  details.atrSL = atrSL;

  // 5. PAIR PRIORITY
  const pairCheck = checkPairPriority(currentSymbol, btcScore, decisionScore, btcStatus);
  if (pairCheck.blocked) {
    blocks.push({ type: "PAIR_PRIORITY", reason: pairCheck.reason });
  }
  details.pairPriority = pairCheck;

  // 6. LOSS STREAK DEFENSE
  const lossDefense = checkLossStreakDefense(tradeHistory);
  if (lossDefense.blocked) {
    blocks.push({ type: "LOSS_STREAK_PAUSE", reason: lossDefense.reason });
  } else if (lossDefense.min_score_boost > 0) {
    warnings.push({ type: "LOSS_STREAK_BOOST", message: `Min score +${lossDefense.min_score_boost}, sniper disabled` });
  }
  details.lossDefense = lossDefense;

  // Count passing checks
  const checksNeeded = ["minScore", "candleConfirmation"]; // Critical
  const numChecksPassed = checksNeeded.filter(c => {
    if (c === "minScore") return minScoreReq.approved && decisionScore >= minScoreReq.min_score;
    if (c === "candleConfirmation") return candleConf.confirmed;
    return false;
  }).length;

  return {
    approved: blocks.length === 0,
    blocks,
    warnings,
    checks_passed: numChecksPassed,
    checks_required: checksNeeded.length,
    details,
  };
}

// ── HELPER: Get consecutive losses ──────────────────────────
function getConsecutiveLosses(tradeHistory) {
  const trades = tradeHistory || [];
  let count = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if ((trades[i].pnlUSDT || 0) < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

module.exports = {
  getMinimumDecisionScore,
  checkChopConditions,
  checkCandleConfirmation,
  calculateATRBasedSL,
  checkPairPriority,
  checkLossStreakDefense,
  runEntryQualityChecks,
};
