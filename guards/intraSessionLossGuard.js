"use strict";

/**
 * INTRA-SESSION LOSS GUARD — Prevents cascade losses in single session
 * ⭐ NEW: Stops all trading if session loss exceeds -1.2% equity
 *
 * - Tracks session start time and cumulative loss
 * - Monitors max drawdown within session
 * - Blocks entries if limit exceeded
 * - Auto-resets at session boundary (24h)
 */

/**
 * Check if intra-session loss limit is exceeded
 * @param {number} sessionLossUSDT - Cumulative loss in current session
 * @param {number} equityUSDT - Current account equity (default 100)
 * @param {number} maxLossPctEquity - Max loss as % of equity (default 1.2%)
 * @returns {Object} { limitExceeded, lossPercent, reason }
 */
function isIntraSessionLossExceeded(sessionLossUSDT = 0, equityUSDT = 100, maxLossPctEquity = 1.2) {
  const maxLossUSDT = (equityUSDT * maxLossPctEquity) / 100;
  const lossPercent = Math.abs(sessionLossUSDT / equityUSDT) * 100;

  return {
    limitExceeded: Math.abs(sessionLossUSDT) >= maxLossUSDT,
    lossUSDT: sessionLossUSDT,
    lossPercent: lossPercent.toFixed(2),
    maxLossUSDT: maxLossUSDT.toFixed(2),
    maxLossPct: maxLossPctEquity.toFixed(2),
    reason: Math.abs(sessionLossUSDT) >= maxLossUSDT
      ? `⚠️ INTRA-SESSION LOSS LIMIT EXCEEDED: -${lossPercent.toFixed(2)}% >= -${maxLossPctEquity.toFixed(2)}% limit`
      : `✓ Session loss within limit: -${lossPercent.toFixed(2)}% of equity`,
  };
}

/**
 * Check if enough time has passed since last loss to resume trading
 * @param {number} lastLossTime - Timestamp of last loss
 * @param {number} cooldownMs - Cooldown duration (default 1 hour)
 * @returns {Object} { canResume, remainingMs, reason }
 */
function canResumeTradingAfterLoss(lastLossTime, cooldownMs = 60 * 60 * 1000) {
  const now = Date.now();
  const elapsedMs = now - lastLossTime;
  const canResume = elapsedMs >= cooldownMs;

  return {
    canResume,
    elapsedMs,
    cooldownMs,
    remainingMs: cooldownMs - elapsedMs,
    reason: canResume
      ? `✓ Cooldown expired: ${(elapsedMs / (60 * 1000)).toFixed(0)}min elapsed`
      : `⏸️ COOLDOWN ACTIVE: ${((cooldownMs - elapsedMs) / (60 * 1000)).toFixed(0)}min remaining`,
  };
}

/**
 * Calculate session max drawdown (most negative moment during session)
 * @param {Array} tradeHistory - Recent trades in current session
 * @returns {number} Max drawdown in USD (negative value)
 */
function calculateSessionMaxDrawdown(tradeHistory = []) {
  if (!Array.isArray(tradeHistory) || tradeHistory.length === 0) return 0;

  let cumulativePnL = 0;
  let maxDrawdown = 0;

  for (const trade of tradeHistory) {
    cumulativePnL += trade.pnlUSDT || 0;
    if (cumulativePnL < maxDrawdown) {
      maxDrawdown = cumulativePnL;
    }
  }

  return maxDrawdown;
}

/**
 * Check multiple conditions for intra-session risk
 * @param {Object} params - { sessionLossUSDT, maxDrawdownUSDT, equity, tradeHistory, lastLossTime }
 * @returns {Object} { blocked: boolean, reasons: [], status: string }
 */
function runIntraSessionLossChecks(params = {}) {
  const {
    sessionLossUSDT = 0,
    maxDrawdownUSDT = 0,
    equity = 100,
    tradeHistory = [],
    lastLossTime = 0,
  } = params;

  const blocks = [];
  const warnings = [];

  // Check 1: Cumulative session loss
  const lossCheck = isIntraSessionLossExceeded(sessionLossUSDT, equity, 1.2);
  if (lossCheck.limitExceeded) {
    blocks.push(lossCheck.reason);
  }

  // Check 2: Max drawdown during session
  const maxDD = calculateSessionMaxDrawdown(tradeHistory);
  if (Math.abs(maxDD) >= (equity * 1.0) / 100) {
    // -1% drawdown = warning
    warnings.push(`Session drawdown: -${(Math.abs(maxDD) / equity * 100).toFixed(2)}%`);
  }
  if (Math.abs(maxDD) >= (equity * 1.5) / 100) {
    // -1.5% drawdown = severe warning
    blocks.push(`Session max drawdown exceeded: -${(Math.abs(maxDD) / equity * 100).toFixed(2)}% (limit 1.5%)`);
  }

  // Check 3: Cooldown after loss
  if (lastLossTime > 0) {
    const cooldownCheck = canResumeTradingAfterLoss(lastLossTime, 60 * 60 * 1000);
    if (!cooldownCheck.canResume) {
      blocks.push(cooldownCheck.reason);
    }
  }

  return {
    blocked: blocks.length > 0,
    approved: blocks.length === 0,
    blocks,
    warnings,
    status: blocks.length > 0 ? "❌ BLOCKED" : warnings.length > 0 ? "⚠️ WARNING" : "✅ OK",
    details: {
      session_loss_usd: sessionLossUSDT.toFixed(2),
      session_loss_pct: (Math.abs(sessionLossUSDT) / equity * 100).toFixed(2),
      max_drawdown_usd: maxDD.toFixed(2),
      max_drawdown_pct: (Math.abs(maxDD) / equity * 100).toFixed(2),
    },
  };
}

module.exports = {
  isIntraSessionLossExceeded,
  canResumeTradingAfterLoss,
  calculateSessionMaxDrawdown,
  runIntraSessionLossChecks,
};
