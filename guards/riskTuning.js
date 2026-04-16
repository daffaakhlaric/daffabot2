"use strict";

/**
 * EMERGENCY RISK TUNING — Strict overtrading & loss protection
 * Prevents bot from forcing setups in low-edge markets
 *
 * Rules:
 * 1. Session filter (strict — only London/NY, Asia A+ only)
 * 2. SNIPER tightened (liquidity sweep + BOS + volume spike + score 85+)
 * 3. TREND tightened (HTF align + pullback + no chop + score 75+)
 * 4. Max trades per session (London 2, NY 2, Asia 1)
 * 5. Loss streak defense HARD (2 loss = 2hr pause, 3 loss = pause until next session)
 * 6. SHORT/LONG bias filter (no force short, check support)
 * 7. Daily stop loss (-2% = STOP)
 * 8. Dashboard: why blocked, session, score, daily DD
 */

const { getEnhancedSession: sessionFilter } = require("../strategy");
const { getSessionByUTCHour } = require("../utils/time");

/**
 * RULE 1: Session Filter (STRICT)
 * Only trade London & NY. Asia = A+ only. Off = HOLD
 */
function checkSessionRules(currentSession = null) {
  const session = currentSession || sessionFilter.getCurrentSession();

  // ONLY trade London and New York
  if (session.session === "LONDON_OPEN" || session.session === "NY_OPEN") {
    return {
      approved: true,
      session: session.session,
      reason: "Prime session",
    };
  }

  // Asia: ONLY A+ setups (score 85+)
  if (session.session === "ASIA_MORNING") {
    return {
      approved: false,  // Default HOLD unless explicitly A+
      session: "ASIA_MORNING",
      reason: "Asia session (07:00-11:00 WIB): Only A+ setups (score 85+) allowed",
      minScore: 85,
    };
  }

  // Off-hours: HOLD default
  return {
    approved: false,
    session: "OFF_HOURS",
    reason: "Off-hours session: Trading disabled",
  };
}

/**
 * RULE 2: SNIPER Mode TIGHTENED
 * Only if: liquidity sweep valid + BOS confirm + volume spike >1.5x + kill zone valid + score 85+
 */
function checkSniperRequirements(params = {}) {
  const {
    setupType = "SAFE",
    score = 0,
    hasLiquiditySweep = false,
    hasBOSConfirm = false,
    volumeSpike = 1.0,  // Volume multiplier
    killZoneValid = false,
  } = params;

  if (setupType !== "SNIPER") {
    return { approved: true, reason: "Not SNIPER mode" };
  }

  const blocks = [];

  // SNIPER minimum score: 85
  if (score < 85) {
    blocks.push(`SNIPER score too low: ${score} < 85 required`);
  }

  // Must have liquidity sweep
  if (!hasLiquiditySweep) {
    blocks.push("SNIPER: No liquidity sweep detected");
  }

  // Must have BOS confirmation
  if (!hasBOSConfirm) {
    blocks.push("SNIPER: No BOS confirmation");
  }

  // Volume spike > 1.5x
  if (volumeSpike < 1.5) {
    blocks.push(`SNIPER: Volume spike too low: ${volumeSpike.toFixed(2)}x < 1.5x`);
  }

  // Kill zone must be valid
  if (!killZoneValid) {
    blocks.push("SNIPER: Kill zone not valid");
  }

  return {
    approved: blocks.length === 0,
    blocks: blocks.length > 0 ? blocks : null,
    reason: blocks.length > 0 ? blocks[0] : "SNIPER requirements met",
  };
}

/**
 * RULE 3: TREND/ULTRA Mode TIGHTENED
 * HTF align (4H + 1H) + pullback valid + no chop + score 75+
 */
function checkTrendRequirements(params = {}) {
  const {
    setupType = "SAFE",
    score = 0,
    htf4hAlign = false,
    htf1hAlign = false,
    pullbackValid = false,
    chopDetected = false,
  } = params;

  if (setupType !== "TREND" && setupType !== "ULTRA") {
    return { approved: true, reason: "Not TREND/ULTRA mode" };
  }

  const blocks = [];

  // TREND minimum score: 75
  if (score < 75) {
    blocks.push(`TREND score too low: ${score} < 75 required`);
  }

  // HTF alignment: 4H AND 1H must align
  if (!htf4hAlign || !htf1hAlign) {
    blocks.push("TREND: HTF not aligned (need 4H + 1H alignment)");
  }

  // Pullback must be valid
  if (!pullbackValid) {
    blocks.push("TREND: Pullback not valid");
  }

  // No chop allowed
  if (chopDetected) {
    blocks.push("TREND: Choppy conditions detected");
  }

  return {
    approved: blocks.length === 0,
    blocks: blocks.length > 0 ? blocks : null,
    reason: blocks.length > 0 ? blocks[0] : "TREND requirements met",
  };
}

/**
 * RULE 4: Max Trades Per Session
 * London: 2 max, NY: 2 max, Asia: 1 max
 */
function checkMaxTradesPerSession(tradeHistory = [], session = null) {
  const currentSession = session || sessionFilter.getCurrentSession().session;

  // Filter trades from current session (last 8 hours)
  const now = Date.now();
  const sessionStart = now - (8 * 60 * 60 * 1000);
  const sessionTrades = tradeHistory.filter(t => t.closeTime && t.closeTime > sessionStart);

  let maxTrades = 0;
  if (currentSession === "LONDON_OPEN") maxTrades = 2;
  else if (currentSession === "NY_OPEN") maxTrades = 2;
  else if (currentSession === "ASIA_MORNING") maxTrades = 1;
  else return { approved: true, reason: "Session has no trade limit" };

  const tradesThisSession = sessionTrades.length;

  return {
    approved: tradesThisSession < maxTrades,
    session: currentSession,
    tradesThisSession,
    maxTrades,
    reason: tradesThisSession >= maxTrades
      ? `Max ${maxTrades} trades per ${currentSession} reached (${tradesThisSession} done)`
      : `OK (${tradesThisSession}/${maxTrades})`
  };
}

/**
 * RULE 5: Loss Streak Defense (HARD)
 * 2 consecutive loss = 2 hour pause
 * 3 consecutive loss = pause until next session
 */
function checkLossStreakDefenseHard(tradeHistory = []) {
  if (!tradeHistory || tradeHistory.length === 0) {
    return { approved: true, lossStreak: 0, reason: "No trades yet" };
  }

  // Count consecutive losses from most recent
  let lossStreak = 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    const trade = tradeHistory[i];
    if (trade.pnlPercent < 0) {
      lossStreak++;
    } else {
      break;
    }
  }

  // 3+ losses: pause until next session (8 hours)
  if (lossStreak >= 3) {
    return {
      approved: false,
      lossStreak,
      pauseDurationMs: 8 * 60 * 60 * 1000,
      reason: `${lossStreak} consecutive losses: PAUSE until next session (8 hours)`,
    };
  }

  // 2 losses: pause 2 hours
  if (lossStreak === 2) {
    return {
      approved: false,
      lossStreak,
      pauseDurationMs: 2 * 60 * 60 * 1000,
      reason: `${lossStreak} consecutive losses: PAUSE 2 hours`,
    };
  }

  return {
    approved: true,
    lossStreak,
    reason: lossStreak === 0 ? "No losses" : "Only 1 loss",
  };
}

/**
 * RULE 6: SHORT/LONG Bias Filter
 * No force SHORT. Check support before shorting.
 */
function checkDirectionBias(params = {}) {
  const {
    side = "LONG",
    htfClear = false,
    priceNearSupport = false,
    htfBias = null,
  } = params;

  const blocks = [];

  // If HTF not clear, HOLD
  if (!htfClear) {
    blocks.push("HTF not clear: direction bias unclear");
  }

  // SHORT: price near support = block SHORT
  if (side === "SHORT" && priceNearSupport) {
    blocks.push("SHORT: Price near HTF support, risky");
  }

  // LONG: ensure bias is bullish
  if (side === "LONG" && htfBias === "BEARISH") {
    blocks.push("LONG: HTF bias is bearish");
  }

  return {
    approved: blocks.length === 0,
    side,
    blocks: blocks.length > 0 ? blocks : null,
    reason: blocks.length > 0 ? blocks[0] : "Direction OK",
  };
}

/**
 * RULE 7: Daily Stop Loss (HARD)
 * -2% daily loss = STOP ALL TRADES
 */
function checkDailyStopLoss(tradeHistory = [], initialEquity = 1000) {
  if (!tradeHistory || tradeHistory.length === 0) {
    return { approved: true, dailyLoss: 0, reason: "No trades" };
  }

  // Get today's start
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  // Sum today's PnL
  let todayPnL = 0;
  tradeHistory.forEach(trade => {
    if (trade.closeTime && trade.closeTime > todayStart) {
      todayPnL += (trade.pnlUSDT || 0);
    }
  });

  const dailyLossPercent = (todayPnL / initialEquity) * 100;

  // -2% stop loss = HALT
  if (dailyLossPercent <= -2.0) {
    return {
      approved: false,
      dailyLossPercent: dailyLossPercent.toFixed(2),
      reason: `Daily loss ${dailyLossPercent.toFixed(2)}% <= -2.0%: STOP ALL TRADES`,
    };
  }

  return {
    approved: true,
    dailyLossPercent: dailyLossPercent.toFixed(2),
    reason: `Daily loss ${dailyLossPercent.toFixed(2)}% (limit: -2.0%)`,
  };
}

/**
 * MASTER CHECK: Run all risk tuning rules
 * @returns {Object} { approved, blocks, details }
 */
function runAllRiskTuningChecks(params = {}) {
  const {
    score = 0,
    setupType = "SAFE",
    tradeHistory = [],
    initialEquity = 1000,
    session = null,
    hasLiquiditySweep = false,
    hasBOSConfirm = false,
    volumeSpike = 1.0,
    killZoneValid = false,
    htf4hAlign = false,
    htf1hAlign = false,
    pullbackValid = false,
    chopDetected = false,
    side = "LONG",
    htfClear = false,
    priceNearSupport = false,
    htfBias = null,
  } = params;

  const blocks = [];
  const details = {};

  // 1. Session Rules (STRICT)
  const sessionCheck = checkSessionRules(session);
  if (!sessionCheck.approved && setupType !== "SNIPER") {
    blocks.push({ type: "SESSION_RULE", reason: sessionCheck.reason });
  }
  details.sessionRule = sessionCheck;

  // 2. SNIPER Requirements
  if (setupType === "SNIPER") {
    const sniperCheck = checkSniperRequirements({
      setupType,
      score,
      hasLiquiditySweep,
      hasBOSConfirm,
      volumeSpike,
      killZoneValid,
    });
    if (!sniperCheck.approved) {
      blocks.push({ type: "SNIPER_REQUIREMENTS", reason: sniperCheck.reason });
    }
    details.sniperCheck = sniperCheck;
  }

  // 3. TREND Requirements
  if (setupType === "TREND" || setupType === "ULTRA") {
    const trendCheck = checkTrendRequirements({
      setupType,
      score,
      htf4hAlign,
      htf1hAlign,
      pullbackValid,
      chopDetected,
    });
    if (!trendCheck.approved) {
      blocks.push({ type: "TREND_REQUIREMENTS", reason: trendCheck.reason });
    }
    details.trendCheck = trendCheck;
  }

  // 4. Max Trades Per Session
  const maxTradesCheck = checkMaxTradesPerSession(tradeHistory, session?.session);
  if (!maxTradesCheck.approved) {
    blocks.push({ type: "MAX_TRADES_SESSION", reason: maxTradesCheck.reason });
  }
  details.maxTradesCheck = maxTradesCheck;

  // 5. Loss Streak Defense (HARD)
  const lossStreakCheck = checkLossStreakDefenseHard(tradeHistory);
  if (!lossStreakCheck.approved) {
    blocks.push({ type: "LOSS_STREAK_PAUSE", reason: lossStreakCheck.reason });
  }
  details.lossStreakCheck = lossStreakCheck;

  // 6. Direction Bias Filter
  const biasCheck = checkDirectionBias({
    side,
    htfClear,
    priceNearSupport,
    htfBias,
  });
  if (!biasCheck.approved) {
    blocks.push({ type: "DIRECTION_BIAS", reason: biasCheck.reason });
  }
  details.biasCheck = biasCheck;

  // 7. Daily Stop Loss (HARD)
  const dailyStopCheck = checkDailyStopLoss(tradeHistory, initialEquity);
  if (!dailyStopCheck.approved) {
    blocks.push({ type: "DAILY_STOP_LOSS", reason: dailyStopCheck.reason });
  }
  details.dailyStopCheck = dailyStopCheck;

  return {
    approved: blocks.length === 0,
    blocks: blocks.length > 0 ? blocks : null,
    details,
    blockCount: blocks.length,
    reason: blocks.length > 0 ? blocks[0].reason : "All risk checks passed",
  };
}

module.exports = {
  checkSessionRules,
  checkSniperRequirements,
  checkTrendRequirements,
  checkMaxTradesPerSession,
  checkLossStreakDefenseHard,
  checkDirectionBias,
  checkDailyStopLoss,
  runAllRiskTuningChecks,
};
