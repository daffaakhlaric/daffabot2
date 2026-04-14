"use strict";

/**
 * PROFIT PROTECTOR — Safeguard against profit giveback
 * Pure module, zero API calls.
 *
 * Features:
 * 1. SESSION PROFIT LOCK — Stop trading if daily profit >= 2.5%
 * 2. POST-WIN COOLDOWN — Cooldown 3-15 min based on win profit size
 * 3. WIN STREAK PROTECTOR — Tighter rules after 2+ consecutive wins
 * 4. MAX TRADES PER HOUR — Cap at 2 trades/hour
 * 5. MAX SESSION TRADES — Session-based limits (London 3, NY 3, Asia 1)
 */

// ── SESSION PROFIT LOCK ──────────────────────────────────────
/**
 * Calculate daily profit percentage and lock trades if too high
 * @param {Array} tradeHistory - Trade history with pnlUSDT
 * @param {number} equity - Current account equity
 * @param {Object} thresholds - { green: 1.5, lockout: 2.5 } as percentages
 * @returns { locked, daily_pnl_usd, daily_pnl_pct, reason }
 */
function checkSessionProfitLock(tradeHistory, equity, thresholds = {}) {
  const green_pct = thresholds.green || 1.5;      // Mode konservatif
  const lockout_pct = thresholds.lockout || 2.5;  // Auto stop semua trade

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  const todayTrades = (tradeHistory || []).filter(
    t => (t.exitTime || t.timestamp || 0) >= todayTs
  );

  const dailyPnL = todayTrades.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0);
  const dailyPnLPct = equity > 0 ? (dailyPnL / equity) * 100 : 0;

  let locked = false;
  let lockReason = null;

  // Lockout: daily profit >= 2.5% — STOP ALL TRADE
  if (dailyPnLPct >= lockout_pct) {
    locked = true;
    lockReason = `SESSION_LOCKED: Daily profit ${dailyPnLPct.toFixed(2)}% >= ${lockout_pct}% — protecting gains`;
  }

  return {
    locked,
    reason: lockReason,
    daily_pnl_usd: +dailyPnL.toFixed(2),
    daily_pnl_pct: +dailyPnLPct.toFixed(2),
    green_threshold: green_pct,
    lockout_threshold: lockout_pct,
    trades_today: todayTrades.length,
  };
}

// ── POST-WIN COOLDOWN ────────────────────────────────────────
/**
 * Implement cooldown after wins to prevent FOMO/impulsive trades
 * Cooldown duration depends on win profit size:
 * - Small win (<0.5%) → 3 min
 * - Medium win (0.5-1%) → 5 min
 * - Large win (>1%) → 10-15 min
 */
function checkPostWinCooldown(tradeHistory, currentTime = Date.now()) {
  const trades = tradeHistory || [];
  if (!trades.length) {
    return { blocked: false, reason: null, cooldown_ms: 0, remaining_ms: 0 };
  }

  const lastTrade = trades[trades.length - 1];
  const isWin = (lastTrade.pnlUSDT || 0) > 0;

  if (!isWin) {
    return { blocked: false, reason: null, cooldown_ms: 0, remaining_ms: 0 };
  }

  const exitTime = lastTrade.exitTime || lastTrade.timestamp || 0;
  const timeSinceWin = currentTime - exitTime;

  // Determine cooldown based on profit size
  let cooldownMs = 0;
  let profitReason = "";

  const winProfitUsd = lastTrade.pnlUSDT || 0;
  const winProfitPct = lastTrade.sizeUsdt && lastTrade.sizeUsdt > 0
    ? (winProfitUsd / lastTrade.sizeUsdt) * 100
    : 0;

  if (winProfitPct < 0.5) {
    cooldownMs = 3 * 60 * 1000;  // 3 min
    profitReason = "small win";
  } else if (winProfitPct < 1.0) {
    cooldownMs = 5 * 60 * 1000;  // 5 min
    profitReason = "medium win";
  } else {
    cooldownMs = 15 * 60 * 1000; // 15 min
    profitReason = "large win";
  }

  const remainingMs = Math.max(0, cooldownMs - timeSinceWin);
  const blocked = remainingMs > 0;

  return {
    blocked,
    reason: blocked
      ? `POST_WIN_COOLDOWN: ${profitReason} (${winProfitPct.toFixed(2)}%) — wait ${Math.ceil(remainingMs / 60000)}m`
      : null,
    cooldown_ms: cooldownMs,
    remaining_ms: remainingMs,
    time_since_win_ms: timeSinceWin,
    win_profit_usd: +winProfitUsd.toFixed(2),
    win_profit_pct: +winProfitPct.toFixed(2),
  };
}

// ── WIN STREAK PROTECTOR ─────────────────────────────────────
/**
 * Tighten requirements after consecutive wins
 * - 2 wins → min score +10 (55 → 65)
 * - 3+ wins → only A+ setups (75+ score)
 */
function checkWinStreakProtection(tradeHistory, proposedScore = 65) {
  const trades = tradeHistory || [];
  let consecutiveWins = 0;

  // Count from end
  for (let i = trades.length - 1; i >= 0; i--) {
    if ((trades[i].pnlUSDT || 0) > 0) {
      consecutiveWins++;
    } else {
      break;
    }
  }

  let minScoreRequired = 55; // Default
  let strictness = "NORMAL";
  let blocked = false;
  let reason = null;

  if (consecutiveWins >= 3) {
    minScoreRequired = 75;  // A+ only
    strictness = "A_PLUS_ONLY";
    if (proposedScore < minScoreRequired) {
      blocked = true;
      reason = `WIN_STREAK_3+: Only A+ setups allowed (${proposedScore} < ${minScoreRequired})`;
    }
  } else if (consecutiveWins === 2) {
    minScoreRequired = 65;  // +10 from default
    strictness = "ELEVATED";
    if (proposedScore < minScoreRequired) {
      blocked = true;
      reason = `WIN_STREAK_2: Score must be ${minScoreRequired}+ (got ${proposedScore})`;
    }
  }

  return {
    blocked,
    reason,
    consecutive_wins: consecutiveWins,
    strictness,
    min_score_required: minScoreRequired,
    proposed_score: proposedScore,
    score_gap: proposedScore - minScoreRequired,
  };
}

// ── MAX TRADES PER HOUR ──────────────────────────────────────
/**
 * Cap trades at 2 per hour to prevent overtrading/chop
 */
function checkMaxTradesPerHour(tradeHistory, currentTime = Date.now(), maxPerHour = 2) {
  const trades = tradeHistory || [];
  const oneHourAgo = currentTime - 60 * 60 * 1000;

  const tradesThisHour = trades.filter(t =>
    (t.exitTime || t.timestamp || 0) >= oneHourAgo
  ).length;

  const blocked = tradesThisHour >= maxPerHour;
  const remaining = Math.max(0, maxPerHour - tradesThisHour);

  return {
    blocked,
    reason: blocked
      ? `MAX_TRADES_PER_HOUR: Already ${tradesThisHour}/${maxPerHour} this hour — cooldown 60m`
      : null,
    trades_this_hour: tradesThisHour,
    max_per_hour: maxPerHour,
    trades_remaining_this_hour: remaining,
  };
}

// ── MAX TRADES PER SESSION ────────────────────────────────────
/**
 * Cap trades per session type:
 * - London (7:00-16:00 UTC) → 3 trades
 * - New York (12:00-21:00 UTC) → 3 trades
 * - Asia (22:00-7:00 UTC) → 1 trade (quiet session)
 */
function checkMaxTradesPerSession(tradeHistory, currentTime = Date.now()) {
  const trades = tradeHistory || [];

  // Determine current session (UTC)
  const utcHour = new Date(currentTime).getUTCHours();
  let currentSession = "ASIA";
  let sessionStart = 22; // Default Asia
  let maxTradesInSession = 1;

  // London session: 7:00-16:00 UTC
  if (utcHour >= 7 && utcHour < 16) {
    currentSession = "LONDON";
    sessionStart = 7;
    maxTradesInSession = 3;
  }
  // New York session: 12:00-21:00 UTC
  else if (utcHour >= 12 && utcHour < 21) {
    currentSession = "NEW_YORK";
    sessionStart = 12;
    maxTradesInSession = 3;
  }

  // Find session start timestamp (today at sessionStart hour UTC)
  const sessionStartTime = new Date(currentTime);
  sessionStartTime.setUTCHours(sessionStart, 0, 0, 0);

  // If we've gone past the session end, sessionStart is from previous cycle
  // Adjust accordingly
  if (currentTime < sessionStartTime.getTime()) {
    sessionStartTime.setUTCDate(sessionStartTime.getUTCDate() - 1);
  }

  const sessionTradesCount = trades.filter(t =>
    (t.exitTime || t.timestamp || 0) >= sessionStartTime.getTime()
  ).length;

  const blocked = sessionTradesCount >= maxTradesInSession;
  const remaining = Math.max(0, maxTradesInSession - sessionTradesCount);

  return {
    blocked,
    reason: blocked
      ? `SESSION_LIMIT: ${currentSession} session ${sessionTradesCount}/${maxTradesInSession} trades reached`
      : null,
    current_session: currentSession,
    session_trades_count: sessionTradesCount,
    max_in_session: maxTradesInSession,
    trades_remaining: remaining,
  };
}

// ── QUALITY FILTER BOOST (Session Green) ─────────────────────
/**
 * When session is profitable, boost minimum score requirement
 * Normal: 55 → Green: 70
 */
function checkQualityFilterBoost(tradeHistory, equity, proposedScore = 55) {
  const trades = tradeHistory || [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  const todayTrades = trades.filter(t => (t.exitTime || t.timestamp || 0) >= todayTs);
  const dailyPnL = todayTrades.reduce((s, t) => s + (t.pnlUSDT || 0), 0);
  const sessionGreen = dailyPnL > 0;

  let requiredScore = 55; // Default
  let reason = null;

  if (sessionGreen) {
    requiredScore = 70; // Boost when profitable
    if (proposedScore < requiredScore) {
      reason = `SESSION_GREEN: Score boosted from 55 to 70 (got ${proposedScore})`;
    }
  }

  const blocked = sessionGreen && proposedScore < requiredScore;

  return {
    blocked,
    reason,
    session_green: sessionGreen,
    required_score: requiredScore,
    proposed_score: proposedScore,
    score_gap: proposedScore - requiredScore,
  };
}

// ── RUN ALL PROFIT PROTECTION CHECKS ─────────────────────────
/**
 * Master profit protection check
 */
function runProfitProtectionChecks({
  tradeHistory = [],
  equity = 0,
  proposedScore = 65,
  currentTime = Date.now(),
  profitThresholds = { green: 1.5, lockout: 2.5 },
} = {}) {
  const blocks = [];
  const warnings = [];
  const details = {};

  // 1. SESSION PROFIT LOCK
  const profitLock = checkSessionProfitLock(tradeHistory, equity, profitThresholds);
  if (profitLock.locked) {
    blocks.push({ type: "PROFIT_LOCK", reason: profitLock.reason });
  }
  if (profitLock.daily_pnl_pct >= (profitThresholds.green || 1.5)) {
    warnings.push({ type: "PROFIT_GREEN", message: `Session +${profitLock.daily_pnl_pct.toFixed(2)}% — quality filter raised` });
  }
  details.profitLock = profitLock;

  // 2. POST-WIN COOLDOWN
  const cooldown = checkPostWinCooldown(tradeHistory, currentTime);
  if (cooldown.blocked) {
    blocks.push({ type: "POST_WIN_COOLDOWN", reason: cooldown.reason });
  }
  details.cooldown = cooldown;

  // 3. WIN STREAK PROTECTOR
  const winStreak = checkWinStreakProtection(tradeHistory, proposedScore);
  if (winStreak.blocked) {
    blocks.push({ type: "WIN_STREAK", reason: winStreak.reason });
  } else if (winStreak.consecutive_wins >= 2) {
    warnings.push({ type: "WIN_STREAK_WARNING", message: `${winStreak.consecutive_wins} wins — score minimum ${winStreak.min_score_required}` });
  }
  details.winStreak = winStreak;

  // 4. MAX TRADES PER HOUR
  const hourlyLimit = checkMaxTradesPerHour(tradeHistory, currentTime);
  if (hourlyLimit.blocked) {
    blocks.push({ type: "HOURLY_LIMIT", reason: hourlyLimit.reason });
  }
  if (hourlyLimit.trades_remaining_this_hour <= 1) {
    warnings.push({ type: "HOUR_WARN", message: `${hourlyLimit.trades_this_hour}/${hourlyLimit.max_per_hour} trades this hour` });
  }
  details.hourlyLimit = hourlyLimit;

  // 5. MAX TRADES PER SESSION
  const sessionLimit = checkMaxTradesPerSession(tradeHistory, currentTime);
  if (sessionLimit.blocked) {
    blocks.push({ type: "SESSION_LIMIT", reason: sessionLimit.reason });
  }
  if (sessionLimit.trades_remaining <= 1) {
    warnings.push({ type: "SESSION_WARN", message: `${sessionLimit.session_trades_count}/${sessionLimit.max_in_session} trades in ${sessionLimit.current_session}` });
  }
  details.sessionLimit = sessionLimit;

  // 6. QUALITY FILTER BOOST (when green)
  const qualityBoost = checkQualityFilterBoost(tradeHistory, equity, proposedScore);
  if (qualityBoost.blocked) {
    blocks.push({ type: "QUALITY_BOOST", reason: qualityBoost.reason });
  }
  details.qualityBoost = qualityBoost;

  // Determine min score override
  let minScoreOverride = null;
  if (winStreak.min_score_required > 55) {
    minScoreOverride = Math.max(minScoreOverride || 55, winStreak.min_score_required);
  }
  if (qualityBoost.required_score > 55) {
    minScoreOverride = Math.max(minScoreOverride || 55, qualityBoost.required_score);
  }

  return {
    approved: blocks.length === 0,
    blocks,
    warnings,
    min_score_override: minScoreOverride,
    details,
  };
}

module.exports = {
  checkSessionProfitLock,
  checkPostWinCooldown,
  checkWinStreakProtection,
  checkMaxTradesPerHour,
  checkMaxTradesPerSession,
  checkQualityFilterBoost,
  runProfitProtectionChecks,
};
