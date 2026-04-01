/**
 * PHASE INDICATOR MODULE
 * Evaluates bot performance over rolling 20-trade window and returns
 * the current operational phase: TRAINING | STABLE | PROFIT | MARKET_BAD
 *
 * Used to dynamically scale position risk without touching trade logic.
 */

"use strict";

const PHASES = {
  TRAINING:   "TRAINING",
  STABLE:     "STABLE",
  PROFIT:     "PROFIT",
  MARKET_BAD: "MARKET_BAD",
};

/**
 * Evaluate current phase from tradeLog (CLOSE entries only).
 * @param {Array}  tradeLog  - full trade log array
 * @param {Object} stats     - bot stats object (for lossStreak)
 * @returns {Object} phaseResult
 */
function evaluatePhase(tradeLog, stats = {}) {
  // Filter CLOSE entries only and take last 20
  const closed = tradeLog
    .filter(t => t.type === "CLOSE")
    .slice(-20);

  const tradeCount = closed.length;

  // ── PHASE 1: TRAINING ────────────────────────────────────────
  if (tradeCount < 20) {
    return {
      phase:           PHASES.TRAINING,
      description:     "Insufficient data, bot learning market behavior",
      tradeCount,
      winRate:         0,
      profitFactor:    0,
      lossStreak:      stats.lossStreak || 0,
      last5Profit:     0,
      riskMultiplier:  0.8,
      cooldownTrades:  0,
    };
  }

  // ── Compute metrics ──────────────────────────────────────────
  let wins = 0, losses = 0;
  let totalWin = 0, totalLoss = 0;

  for (const t of closed) {
    const pnl = t.pnlUSDT || 0;
    if (pnl >= 0) {
      wins++;
      totalWin += pnl;
    } else {
      losses++;
      totalLoss += Math.abs(pnl);
    }
  }

  const winRate      = (wins / tradeCount) * 100;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0;
  const lossStreak   = stats.lossStreak || 0;

  // last 5 closed trades net profit
  const last5 = closed.slice(-5);
  const last5Profit = last5.reduce((s, t) => s + (t.pnlUSDT || 0), 0);

  // ── PHASE 4: MARKET_BAD (checked first — highest priority) ──
  if (lossStreak >= 4 || profitFactor < 0.8) {
    return {
      phase:           PHASES.MARKET_BAD,
      description:     "Market unfavorable, defensive mode",
      tradeCount,
      winRate:         parseFloat(winRate.toFixed(1)),
      profitFactor:    parseFloat(profitFactor.toFixed(2)),
      lossStreak,
      last5Profit:     parseFloat(last5Profit.toFixed(4)),
      riskMultiplier:  0.5,
      cooldownTrades:  3,
    };
  }

  // ── PHASE 3: PROFIT ──────────────────────────────────────────
  if (winRate >= 55 && profitFactor >= 1.5 && last5Profit > 0) {
    return {
      phase:           PHASES.PROFIT,
      description:     "High edge detected, market aligned",
      tradeCount,
      winRate:         parseFloat(winRate.toFixed(1)),
      profitFactor:    parseFloat(profitFactor.toFixed(2)),
      lossStreak,
      last5Profit:     parseFloat(last5Profit.toFixed(4)),
      riskMultiplier:  1.2,
      cooldownTrades:  0,
    };
  }

  // ── PHASE 2: STABLE ──────────────────────────────────────────
  if (winRate >= 40 && profitFactor >= 1.1 && lossStreak <= 3) {
    return {
      phase:           PHASES.STABLE,
      description:     "Strategy validated, normal trading allowed",
      tradeCount,
      winRate:         parseFloat(winRate.toFixed(1)),
      profitFactor:    parseFloat(profitFactor.toFixed(2)),
      lossStreak,
      last5Profit:     parseFloat(last5Profit.toFixed(4)),
      riskMultiplier:  1.0,
      cooldownTrades:  0,
    };
  }

  // ── FALLBACK: treat as MARKET_BAD if nothing else matches ───
  return {
    phase:           PHASES.MARKET_BAD,
    description:     "Market unfavorable, defensive mode",
    tradeCount,
    winRate:         parseFloat(winRate.toFixed(1)),
    profitFactor:    parseFloat(profitFactor.toFixed(2)),
    lossStreak,
    last5Profit:     parseFloat(last5Profit.toFixed(4)),
    riskMultiplier:  0.5,
    cooldownTrades:  3,
  };
}

/**
 * Returns a compact one-line log string for the phase result.
 */
function phaseLogLine(p) {
  return `[PHASE] ${p.phase} | WR:${p.winRate}% PF:${p.profitFactor} Streak:${p.lossStreak} ` +
         `Risk:×${p.riskMultiplier} | ${p.description}`;
}

module.exports = { evaluatePhase, phaseLogLine, PHASES };
