"use strict";

/**
 * PSYCH GUARD — Emotional Firewall for Trading Psychology.
 * Pure module, zero dependencies, zero API calls.
 */

// ── 8A: DETECT PSYCHOLOGICAL STATE ──────────────────────
function detectPsychState(tradeHistory, sessionTrades, equity, peakEquity) {
  const trades = tradeHistory || [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const tenMinAgo  = now - 10 * 60 * 1000;

  // Consecutive losses/wins from end
  let consecLosses = 0, consecWins = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const pnl = trades[i].pnlUSDT || 0;
    if (consecLosses === 0 && pnl < 0) consecLosses++;
    else if (consecLosses > 0 && pnl < 0) consecLosses++;
    else break;
  }
  for (let i = trades.length - 1; i >= 0; i--) {
    const pnl = trades[i].pnlUSDT || 0;
    if (consecWins === 0 && pnl > 0) consecWins++;
    else if (consecWins > 0 && pnl > 0) consecWins++;
    else break;
  }

  // Trades in last hour
  const tradesLastHour = trades.filter(t => (t.exitTime || t.timestamp || 0) >= oneHourAgo);

  // Time between last two trades
  let timeBetweenLast = Infinity;
  if (trades.length >= 2) {
    const t1 = trades[trades.length - 1];
    const t2 = trades[trades.length - 2];
    timeBetweenLast = ((t1.exitTime || t1.timestamp || 0) - (t2.exitTime || t2.timestamp || 0));
  }

  // Recent large loss
  let recentLargeLoss = false;
  if (trades.length >= 2) {
    const losses = trades.filter(t => (t.pnlUSDT || 0) < 0).map(t => Math.abs(t.pnlUSDT || 0));
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const lastTrade = trades[trades.length - 1];
    if ((lastTrade.pnlUSDT || 0) < 0 && Math.abs(lastTrade.pnlUSDT) > avgLoss * 2) {
      recentLargeLoss = true;
    }
  }

  // Equity drawdown from daily peak
  const ddFromPeak = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;

  // Daily PnL swing
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayTrades = trades.filter(t => (t.exitTime || t.timestamp || 0) >= todayStart.getTime());
  const dailyPnL = todayTrades.reduce((s, t) => s + (t.pnlUSDT || 0), 0);

  // Determine state
  let state = "NORMAL";
  const reasons = [];

  if (consecLosses >= 3) {
    state = "ON_TILT";
    reasons.push(`${consecLosses} consecutive losses`);
  } else if (consecLosses >= 2) {
    state = "TILT_RISK";
    reasons.push(`${consecLosses} consecutive losses`);
  }

  if (ddFromPeak >= 0.04) {
    state = "ON_TILT";
    reasons.push(`Equity down ${(ddFromPeak * 100).toFixed(1)}% from daily peak`);
  } else if (ddFromPeak >= 0.02 && state === "NORMAL") {
    state = "TILT_RISK";
    reasons.push(`Equity down ${(ddFromPeak * 100).toFixed(1)}% from daily peak`);
  }

  if (timeBetweenLast < 10 * 60 * 1000 && state === "NORMAL") {
    state = "TILT_RISK";
    reasons.push("Trades too frequent (<10min apart)");
  }

  if (tradesLastHour.length > 3 && state === "NORMAL") {
    state = "TILT_RISK";
    reasons.push(`${tradesLastHour.length} trades in last hour`);
  }

  if (recentLargeLoss && state === "NORMAL") {
    state = "TILT_RISK";
    reasons.push("Recent loss >2x average");
  }

  if (consecWins >= 4 && (state === "NORMAL" || state === "TILT_RISK")) {
    state = "EUPHORIA";
    reasons.push(`${consecWins} consecutive wins`);
  }

  if (state === "NORMAL" && consecLosses === 0 && consecWins === 0 && trades.length > 5) {
    // Check FEAR_MODE: WR dropping significantly, skipping signals
    const last10 = trades.slice(-10);
    const recentWR = last10.filter(t => (t.pnlUSDT || 0) > 0).length / last10.length;
    if (recentWR < 0.2) {
      state = "FEAR_MODE";
      reasons.push(`Recent win rate only ${(recentWR * 100).toFixed(0)}%`);
    }
  }

  const size_multiplier = state === "ON_TILT" ? 0.5 : state === "EUPHORIA" ? 0.8 : 1.0;

  return {
    state,
    reasons,
    consecutive_losses: consecLosses,
    consecutive_wins: consecWins,
    trades_last_hour: tradesLastHour.length,
    time_between_last_ms: timeBetweenLast,
    dd_from_peak_pct: +(ddFromPeak * 100).toFixed(2),
    recommended_size_multiplier: size_multiplier,
    trading_allowed: state !== "ON_TILT",
    warnings: reasons,
  };
}

// ── 8B: REVENGE TRADE DETECTOR ───────────────────────────
function checkRevengeTrade(tradeHistory, proposedTrade) {
  const trades = tradeHistory || [];
  if (!trades.length) return { is_revenge: false, revenge_score: 0, triggers: [], cooldown_required_ms: 0, recommendation: "ALLOW" };

  const lastTrade = trades[trades.length - 1];
  const lastIsLoss = (lastTrade.pnlUSDT || 0) < 0;
  const lastExitTime = lastTrade.exitTime || lastTrade.timestamp || 0;
  const timeSinceLast = Date.now() - lastExitTime;

  const triggers = [];
  let score = 0;

  // Trigger 1: Last was LOSS and < 15 min
  if (lastIsLoss && timeSinceLast < 15 * 60 * 1000) {
    triggers.push(`Loss ${Math.round(timeSinceLast / 60000)}min ago, too soon`);
    score += 35;
  }

  // Trigger 2: Same direction as losing trade
  if (lastIsLoss && proposedTrade?.side === lastTrade.side) {
    triggers.push(`Re-entering ${proposedTrade.side} direction that just lost`);
    score += 25;
  }

  // Trigger 3: 2 consecutive losses + < 5 min from last
  const last2 = trades.slice(-2);
  const both_loss = last2.every(t => (t.pnlUSDT || 0) < 0);
  if (both_loss && timeSinceLast < 5 * 60 * 1000) {
    triggers.push("2 losses in a row + entry within 5min");
    score += 30;
  }

  // Trigger 4: Size > 1.5x base after loss
  if (lastIsLoss && proposedTrade?.size && lastTrade.sizeUsdt) {
    const sizeRatio = proposedTrade.size / lastTrade.sizeUsdt;
    if (sizeRatio > 1.5) {
      triggers.push(`Martingale: size ${sizeRatio.toFixed(1)}x larger after loss`);
      score += 25;
    }
  }

  // Trigger 5: Entry outside kill zone after loss
  const hour = new Date().getUTCHours();
  const inKz = (hour >= 7 && hour < 9) || (hour >= 13 && hour < 16) || (hour >= 20 && hour < 22);
  if (lastIsLoss && !inKz) {
    triggers.push("Entry outside Kill Zone after loss (desperation)");
    score += 15;
  }

  score = Math.min(100, score);
  const recommendation = score >= 60 ? "BLOCK" : score >= 30 ? "WARN" : "ALLOW";
  const cooldown_required_ms = score >= 60 ? Math.max(0, 15 * 60 * 1000 - timeSinceLast) : 0;

  return {
    is_revenge: score >= 60,
    revenge_score: score,
    triggers,
    cooldown_required_ms,
    recommendation,
    time_since_last_trade_ms: timeSinceLast,
  };
}

// ── 8C: COUNTER-TREND FILTER ──────────────────────────────
function checkCounterTrend(proposedSide, htfBias, regime, streakData) {
  const htf = htfBias || "RANGING";
  const reg = regime || "RANGING";

  const is_counter_trend =
    (htf === "BULLISH" && proposedSide === "SHORT") ||
    (htf === "BEARISH" && proposedSide === "LONG");

  if (!is_counter_trend) {
    return {
      is_counter_trend: false,
      allowed: true,
      reason: "Trade aligned with HTF bias",
      required_score_if_allowed: 65,
      reversal_confirmation_required: false,
    };
  }

  // Hard block in strong trending regime
  if (reg === "TRENDING_BULL" || reg === "TRENDING_BEAR") {
    return {
      is_counter_trend: true,
      allowed: false,
      reason: `Counter-trend blocked: ${reg} regime, HTF ${htf}`,
      required_score_if_allowed: 999,
      reversal_confirmation_required: true,
    };
  }

  // Allow with high score requirement
  return {
    is_counter_trend: true,
    allowed: true,
    reason: `Counter-trend: requires confluence>=80 + reversal confirmation`,
    required_score_if_allowed: 80,
    reversal_confirmation_required: true,
  };
}

// ── 8D: POST-WIN EUPHORIA GUARD ───────────────────────────
function checkPostWinEuphoria(tradeHistory, proposedTrade) {
  const trades = tradeHistory || [];
  const now = Date.now();

  let consecutive_wins = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if ((trades[i].pnlUSDT || 0) > 0) consecutive_wins++;
    else break;
  }

  const lastWin = trades.length ? trades[trades.length - 1] : null;
  const lastWinTime = lastWin && (lastWin.pnlUSDT || 0) > 0
    ? (lastWin.exitTime || lastWin.timestamp || 0)
    : null;
  const timeSinceLastWin = lastWinTime ? now - lastWinTime : Infinity;

  const flags = [];
  let euphoria_level = "NONE";
  let min_wait_ms = 0;
  let min_confluence_score = 65;
  let size_cap_multiplier = 1.5;
  let blocked = false;
  let reason = null;

  if (consecutive_wins >= 5) {
    euphoria_level = "HIGH";
    min_wait_ms = 30 * 60 * 1000;
    min_confluence_score = 78;
    size_cap_multiplier = 1.0;
  } else if (consecutive_wins >= 3) {
    euphoria_level = "WARNING";
    min_wait_ms = 10 * 60 * 1000;
    min_confluence_score = 72;
    size_cap_multiplier = 1.2;
  }

  // Impulsive flag
  if (lastWinTime && timeSinceLastWin < 5 * 60 * 1000) {
    flags.push("IMPULSIVE_FLAG");
    if (min_wait_ms < 10 * 60 * 1000) min_wait_ms = 10 * 60 * 1000;
  }

  // Aggression flag
  if (proposedTrade?.size && trades.length >= 3) {
    const baseSize = trades.slice(-5).reduce((s, t) => s + (t.sizeUsdt || 15), 0) / 5;
    if (proposedTrade.size > baseSize * 1.3 && consecutive_wins >= 3) {
      flags.push("AGGRESSION_FLAG");
    }
  }

  // Determine blocked
  const waitRemaining = lastWinTime ? Math.max(0, min_wait_ms - timeSinceLastWin) : 0;
  if (euphoria_level === "HIGH" && waitRemaining > 0) {
    blocked = true;
    reason = `Euphoria HIGH: wait ${Math.ceil(waitRemaining / 60000)}min after win streak of ${consecutive_wins}`;
  } else if (flags.includes("IMPULSIVE_FLAG") && waitRemaining > 0) {
    blocked = true;
    reason = `Impulsive entry: wait ${Math.ceil(waitRemaining / 60000)}min after win`;
  }

  return {
    euphoria_level,
    consecutive_wins,
    flags,
    min_wait_ms,
    min_confluence_score,
    size_cap_multiplier,
    blocked,
    reason,
    time_since_last_win_ms: timeSinceLastWin === Infinity ? null : timeSinceLastWin,
  };
}

// ── 8E: OVERTRADING DETECTOR ──────────────────────────────
function checkOvertrading(tradeHistory) {
  const trades = tradeHistory || [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const thirtyMinAgo = now - 30 * 60 * 1000;

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const trades_today = trades.filter(t => (t.exitTime || t.timestamp || 0) >= todayStart.getTime()).length;
  const trades_this_hour = trades.filter(t => (t.exitTime || t.timestamp || 0) >= oneHourAgo).length;

  // Last trade interval
  let last_trade_interval_ms = Infinity;
  if (trades.length >= 2) {
    const t1 = trades[trades.length - 1];
    const t2 = trades[trades.length - 2];
    last_trade_interval_ms = (t1.exitTime || t1.timestamp || 0) - (t2.exitTime || t2.timestamp || 0);
  }

  // Whipsaw: 3+ trades in 30min alternating L/S
  const recentTrades = trades.filter(t => (t.exitTime || t.timestamp || 0) >= thirtyMinAgo);
  let whipsaw_detected = false;
  if (recentTrades.length >= 3) {
    let alternations = 0;
    for (let i = 1; i < recentTrades.length; i++) {
      if (recentTrades[i].side !== recentTrades[i - 1].side) alternations++;
    }
    whipsaw_detected = alternations >= 2;
  }

  let level = "NONE";
  let reason = null;
  let cooldown_until = null;

  if (whipsaw_detected) {
    level = "BLOCK";
    reason = "Whipsaw detected: 3+ trades alternating L/S in 30min";
    cooldown_until = now + 2 * 60 * 60 * 1000;
  } else if (trades_today > 12) {
    level = "BLOCK";
    reason = `Daily trade limit: ${trades_today} trades today (max 12)`;
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    cooldown_until = endOfDay.getTime();
  } else if (trades_this_hour > 5) {
    level = "BLOCK";
    reason = `Overtrading: ${trades_this_hour} trades in 1 hour (max 5)`;
    cooldown_until = now + 60 * 60 * 1000;
  } else if (trades_today > 8 || trades_this_hour > 3) {
    level = "WARN";
    reason = `High frequency: ${trades_today} trades today, ${trades_this_hour}/hr`;
  } else if (last_trade_interval_ms < 5 * 60 * 1000 && last_trade_interval_ms !== Infinity) {
    level = "WARN";
    reason = `Rapid re-entry: ${Math.round(last_trade_interval_ms / 60000)}min since last trade`;
  }

  return {
    overtrading_detected: level !== "NONE",
    level,
    reason,
    trades_this_hour,
    trades_today,
    last_trade_interval_ms: last_trade_interval_ms === Infinity ? null : last_trade_interval_ms,
    cooldown_until,
    whipsaw_detected,
  };
}

// ── 8F: PRE-ENTRY SANITY CHECK ────────────────────────────
function preEntrySanityCheck({ psychState, revengeCheck, euphoria, overtrading, counterTrend, confluenceScore, proposedTrade }) {
  const blocks = [];
  const warnings = [];

  if (psychState?.state === "ON_TILT") {
    blocks.push({ type: "PSYCH_TILT", reason: `Psychological state: ON_TILT (${(psychState.reasons || []).join(", ")})` });
  } else if (psychState?.state === "TILT_RISK") {
    warnings.push({ type: "TILT_RISK", message: `Tilt risk: ${(psychState.reasons || []).join(", ")}` });
  }

  if (revengeCheck?.recommendation === "BLOCK") {
    blocks.push({ type: "REVENGE_TRADE", reason: `Revenge trade detected (score ${revengeCheck.revenge_score}): ${revengeCheck.triggers.join(", ")}` });
  } else if (revengeCheck?.recommendation === "WARN") {
    warnings.push({ type: "REVENGE_WARN", message: `Possible revenge trade (score ${revengeCheck.revenge_score})` });
  }

  if (euphoria?.blocked) {
    blocks.push({ type: "EUPHORIA", reason: euphoria.reason });
  }

  if (overtrading?.level === "BLOCK") {
    blocks.push({ type: "OVERTRADING", reason: overtrading.reason });
  } else if (overtrading?.level === "WARN") {
    warnings.push({ type: "OVERTRADE_WARN", message: overtrading.reason });
  }

  if (counterTrend && !counterTrend.allowed) {
    blocks.push({ type: "COUNTER_TREND", reason: counterTrend.reason });
  } else if (counterTrend?.is_counter_trend) {
    if (confluenceScore < (counterTrend.required_score_if_allowed || 80)) {
      blocks.push({ type: "COUNTER_TREND_SCORE", reason: `Counter-trend needs score ${counterTrend.required_score_if_allowed}, got ${confluenceScore}` });
    } else {
      warnings.push({ type: "COUNTER_TREND", message: counterTrend.reason });
    }
  }

  // Min confluence score check
  const minScore = euphoria?.min_confluence_score || 65;
  if (confluenceScore < minScore) {
    warnings.push({ type: "LOW_CONFLUENCE", message: `Confluence ${confluenceScore} < required ${minScore}` });
  }

  const approved = blocks.length === 0;
  const psych_score = 100 - (blocks.length * 30) - (warnings.length * 10);

  return {
    approved,
    psych_score: Math.max(0, psych_score),
    blocks,
    warnings,
    size_multiplier: approved ? (psychState?.recommended_size_multiplier || 1.0) : 0,
    summary: blocks.length
      ? `BLOCKED: ${blocks[0].reason}`
      : warnings.length
      ? `PROCEED WITH CAUTION: ${warnings.length} warning(s)`
      : "APPROVED: All psych checks passed",
  };
}

// ── 8F: PRE-ENTRY SANITY CHECK (runPsychChecks) ───────────
function runPsychChecks({
  tradeHistory = [],
  proposedTrade = null,   // { side, entry, sl, tp1, size, setup, confluenceScore }
  htfBias = "RANGING",
  regime = "RANGING",
  equity = 0,
  peakEquity = 0,
  sessionStartEquity = 0,
} = {}) {
  const now = Date.now();
  const sessionTrades = tradeHistory.filter(
    t => (t.exitTime || t.timestamp || 0) > now - 8 * 60 * 60 * 1000
  );
  const confluenceScore = proposedTrade?.confluenceScore || 0;

  // Run all 5 checks
  const psychState   = detectPsychState(tradeHistory, sessionTrades, equity, peakEquity);
  const revenge      = checkRevengeTrade(tradeHistory, proposedTrade);
  const counterTrend = proposedTrade?.side
    ? checkCounterTrend(proposedTrade.side, htfBias, regime, {})
    : null;
  const euphoria     = checkPostWinEuphoria(tradeHistory, proposedTrade);
  const overtrading  = checkOvertrading(tradeHistory);

  const blocks   = [];
  const warnings = [];
  let   wait_ms  = 0;
  let   min_confluence_override = null;

  // === Block conditions ===
  if (psychState.state === "ON_TILT") {
    blocks.push({ check: "psych_state", reason: `ON_TILT: ${(psychState.reasons || []).join("; ")}` });
  }

  if (revenge.recommendation === "BLOCK") {
    blocks.push({ check: "revenge", reason: `Revenge trade (score ${revenge.revenge_score}): ${revenge.triggers.join(", ")}` });
    wait_ms = Math.max(wait_ms, revenge.cooldown_required_ms);
  }

  if (euphoria.blocked) {
    blocks.push({ check: "euphoria", reason: euphoria.reason });
    wait_ms = Math.max(wait_ms, euphoria.min_wait_ms - (now - (euphoria.time_since_last_win_ms ? now - euphoria.time_since_last_win_ms : now)));
  }

  if (overtrading.level === "BLOCK") {
    blocks.push({ check: "overtrading", reason: overtrading.reason });
    if (overtrading.cooldown_until) wait_ms = Math.max(wait_ms, overtrading.cooldown_until - now);
  }

  if (counterTrend && !counterTrend.allowed) {
    blocks.push({ check: "counter_trend", reason: counterTrend.reason });
  } else if (counterTrend?.is_counter_trend) {
    const required = counterTrend.required_score_if_allowed || 80;
    if (confluenceScore < required) {
      blocks.push({ check: "counter_trend_score", reason: `Counter-trend needs score ${required}, got ${confluenceScore}` });
    }
  }

  // === Warning conditions ===
  if (psychState.state === "TILT_RISK") {
    warnings.push({ check: "psych_state", message: `Tilt risk: ${(psychState.reasons || []).join("; ")}` });
  }
  if (psychState.state === "FEAR_MODE") {
    warnings.push({ check: "psych_state", message: "Fear mode detected — may be skipping valid setups" });
  }
  if (revenge.recommendation === "WARN") {
    warnings.push({ check: "revenge", message: `Possible revenge (score ${revenge.revenge_score})` });
  }
  if (overtrading.level === "WARN") {
    warnings.push({ check: "overtrading", message: overtrading.reason });
  }
  if (counterTrend?.is_counter_trend && counterTrend.allowed) {
    warnings.push({ check: "counter_trend", message: counterTrend.reason });
  }
  if (euphoria.euphoria_level !== "NONE" && !euphoria.blocked) {
    warnings.push({ check: "euphoria", message: `Euphoria ${euphoria.euphoria_level}: ${euphoria.consecutive_wins} wins` });
  }

  // === Confluence override ===
  if (euphoria.min_confluence_score > 65) {
    min_confluence_override = Math.max(min_confluence_override || 65, euphoria.min_confluence_score);
  }
  if (counterTrend?.is_counter_trend && counterTrend.allowed) {
    min_confluence_override = Math.max(min_confluence_override || 65, counterTrend.required_score_if_allowed || 80);
  }

  // === Size multiplier (most conservative wins) ===
  let size_multiplier = 1.0;
  if (psychState.state === "ON_TILT")    size_multiplier = Math.min(size_multiplier, 0.5);
  if (psychState.state === "TILT_RISK") size_multiplier = Math.min(size_multiplier, 0.75);
  if (euphoria.euphoria_level === "HIGH") size_multiplier = Math.min(size_multiplier, 1.0);
  if (euphoria.size_cap_multiplier < size_multiplier) size_multiplier = euphoria.size_cap_multiplier;
  if (!blocks.length && psychState.state === "NORMAL") size_multiplier = 1.0; // compounder can go up to 1.5x

  // === Dashboard alert ===
  const stateAlerts = {
    ON_TILT:   "🛑 TILT DETECTED — size reduced 50%, cooldown active",
    EUPHORIA:  "⚠️ EUPHORIA GUARD — min score raised to 78, no compound",
    TILT_RISK: "⚠️ TILT RISK — monitor closely, 75% size",
    FEAR_MODE: "💙 FEAR MODE — may be skipping valid setups",
    NORMAL:    null,
  };
  const dashboard_alert = blocks.length > 0
    ? `🚫 BLOCKED: ${blocks[0].reason}`
    : stateAlerts[psychState.state] || null;

  const log_parts = [];
  if (psychState.state !== "NORMAL") log_parts.push(`[${psychState.state}]`);
  if (blocks.length)   log_parts.push(`BLOCKED(${blocks.length})`);
  if (warnings.length) log_parts.push(`WARN(${warnings.length})`);
  const log_message = log_parts.length
    ? `🧠 PsychGuard: ${log_parts.join(" ")} mult=${size_multiplier.toFixed(2)}x`
    : "🧠 PsychGuard: CLEAR";

  // Persist to botState
  try {
    if (global.botState) global.botState.psychState = psychState.state;
  } catch {}

  return {
    approved:               blocks.length === 0,
    psych_state:            psychState.state,
    blocks,
    warnings,
    size_multiplier:        +size_multiplier.toFixed(2),
    min_confluence_override,
    wait_ms:                Math.max(0, wait_ms),
    dashboard_alert,
    log_message,
    details: { psychState, revenge, euphoria, overtrading, counterTrend },
  };
}

// ── LEGACY ALIAS ──────────────────────────────────────────
function runAllPsychChecks({ tradeHistory, equity, peakEquity, proposedTrade, htfBias, regime, confluenceScore }) {
  return runPsychChecks({ tradeHistory, equity, peakEquity, proposedTrade, htfBias, regime });
}

module.exports = {
  detectPsychState,
  checkRevengeTrade,
  checkCounterTrend,
  checkPostWinEuphoria,
  checkOvertrading,
  preEntrySanityCheck,
  runPsychChecks,
  runAllPsychChecks,
};
