"use strict";

/**
 * RISK GUARD — Pure module, zero API calls.
 * Integrates psychGuard for psychological risk checks.
 * Includes whale trap and spoof detection cooldowns.
 */

const psychGuard = require("./psychGuard");
const profitProtector = require("./profitProtector");
const { smcValidator, enhancedSessionFilter } = require("../strategy");

// ── WHALE TRAP & SPOOF COOLDOWN STATE ─────────────────────
let _whaleTrapCooldownUntil = 0;
let _spoofHistory = [];  // [{ side: "BID"|"ASK", ts: number }, ...]
const WHALE_TRAP_COOLDOWN_MS = 10 * 60 * 1000;   // 10 minutes
const SPOOF_COOLDOWN_MS      = 15 * 60 * 1000;   // 15 minutes
const SPOOF_CONSEC_LIMIT     = 2;

// ── DAILY LOSS LIMIT ─────────────────────────────────────
function checkDailyLossLimit(tradeHistory, equity, limitPct = 0.03) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  const todayTrades = (tradeHistory || []).filter(
    t => (t.exitTime || t.timestamp || 0) >= todayTs
  );

  const dailyPnL = todayTrades.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0);
  const current_pct = equity > 0 ? Math.abs(Math.min(0, dailyPnL)) / equity : 0;
  const blocked = dailyPnL < 0 && current_pct >= limitPct;

  return {
    blocked,
    reason: blocked
      ? `Daily loss limit hit: ${(current_pct * 100).toFixed(2)}% >= ${(limitPct * 100).toFixed(1)}%`
      : null,
    current_pct: +current_pct.toFixed(4),
    limit_pct: limitPct,
    daily_pnl_usdt: +dailyPnL.toFixed(2),
    trades_today: todayTrades.length,
  };
}

// ── CONSECUTIVE LOSSES ────────────────────────────────────
function checkConsecLosses(tradeHistory, maxConsec = 3) {
  const trades = tradeHistory || [];
  let current_count = 0;
  let lastLossTime = null;

  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if ((t.pnlUSDT || 0) < 0) {
      current_count++;
      if (!lastLossTime) lastLossTime = t.exitTime || t.timestamp || Date.now();
    } else {
      break;
    }
  }

  const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
  const cooldown_until =
    current_count >= maxConsec && lastLossTime
      ? lastLossTime + COOLDOWN_MS
      : null;

  const blocked = cooldown_until !== null && Date.now() < cooldown_until;

  return {
    blocked,
    reason: blocked
      ? `${current_count} consecutive losses — cooldown until ${new Date(cooldown_until).toLocaleTimeString()}`
      : null,
    current_count,
    cooldown_until,
    remaining_ms: blocked ? cooldown_until - Date.now() : 0,
  };
}

// ── MAX DRAWDOWN ──────────────────────────────────────────
function checkMaxDrawdown(equityCurve, maxDD = 0.10) {
  if (!equityCurve || !equityCurve.length) {
    return { blocked: false, current_dd: 0, peak_equity: 0, pause_required: false };
  }

  let peak = equityCurve[0].equity || 0;
  for (const p of equityCurve) {
    if ((p.equity || 0) > peak) peak = p.equity;
  }

  const last = equityCurve[equityCurve.length - 1].equity || 0;
  const current_dd = peak > 0 ? (peak - last) / peak : 0;
  const blocked = current_dd >= maxDD;

  return {
    blocked,
    reason: blocked
      ? `Max drawdown exceeded: ${(current_dd * 100).toFixed(2)}% >= ${(maxDD * 100).toFixed(1)}%`
      : null,
    current_dd: +current_dd.toFixed(4),
    peak_equity: +peak.toFixed(2),
    pause_required: current_dd >= maxDD * 0.8,
  };
}

// ── COOLDOWN ─────────────────────────────────────────────
function checkCooldown(lastTradeTime, cooldownMs) {
  const elapsed = Date.now() - (lastTradeTime || 0);
  const remaining_ms = Math.max(0, cooldownMs - elapsed);
  const blocked = remaining_ms > 0;

  return {
    blocked,
    reason: blocked
      ? `Cooldown: ${Math.ceil(remaining_ms / 60000)}m remaining`
      : null,
    remaining_ms,
    elapsed_ms: elapsed,
  };
}

// ── MINIMUM R:R ───────────────────────────────────────────
function checkMinRR(entry, sl, tp1, side) {
  if (!entry || !sl || !tp1 || !side) {
    return { valid: false, rr: 0, minimum: 2.0, reason: "Missing parameters" };
  }

  const risk =
    side === "LONG" ? entry - sl : sl - entry;
  const reward =
    side === "LONG" ? tp1 - entry : entry - tp1;

  const rr = risk > 0 ? reward / risk : 0;
  const valid = rr >= 2.0;

  return {
    valid,
    rr: +rr.toFixed(2),
    minimum: 2.0,
    reason: valid ? null : `R:R ${rr.toFixed(2)} below minimum 2.0`,
  };
}

// ── FOMO CHECK ────────────────────────────────────────────
function checkFOMO(price, entryZone, maxMovePct = 0.015) {
  if (!entryZone || !Array.isArray(entryZone) || entryZone.length < 2) {
    return { blocked: false, pct_moved: 0 };
  }

  const midpoint = (entryZone[0] + entryZone[1]) / 2;
  const pct_moved = midpoint > 0 ? Math.abs(price - midpoint) / midpoint : 0;
  const blocked = pct_moved > maxMovePct;

  return {
    blocked,
    reason: blocked
      ? `FOMO detected: price moved ${(pct_moved * 100).toFixed(2)}% from entry zone`
      : null,
    pct_moved: +pct_moved.toFixed(4),
    max_allowed: maxMovePct,
  };
}

// ── LEVERAGE CAP ──────────────────────────────────────────
function checkLeverageCap(requestedLeverage, atrPct) {
  let maxAllowed = 20;
  let reason = "ATR < 0.8% — max 20x";

  if (atrPct >= 1.5) {
    maxAllowed = 5;
    reason = `ATR ${atrPct.toFixed(2)}% > 1.5% — max 5x`;
  } else if (atrPct >= 0.8) {
    maxAllowed = 10;
    reason = `ATR ${atrPct.toFixed(2)}% 0.8-1.5% — max 10x`;
  }

  const approved_leverage = Math.min(requestedLeverage, maxAllowed);
  const was_capped = approved_leverage < requestedLeverage;

  return {
    approved_leverage,
    reason: was_capped
      ? `Leverage capped from ${requestedLeverage}x to ${approved_leverage}x. ${reason}`
      : reason,
    was_capped,
    max_allowed: maxAllowed,
  };
}

// ── NO REVENGE TRADE ──────────────────────────────────────
function checkNoRevengeTrade(tradeHistory, cooldownMs = 4 * 60 * 60 * 1000) {
  const trades = tradeHistory || [];
  if (!trades.length) return { blocked: false, last_loss_time: null, remaining_ms: 0 };

  const lastTrade = trades[trades.length - 1];
  const isLoss = (lastTrade.pnlUSDT || 0) < 0;

  if (!isLoss) return { blocked: false, last_loss_time: null, remaining_ms: 0 };

  const lastLossTime = lastTrade.exitTime || lastTrade.timestamp || 0;
  const elapsed = Date.now() - lastLossTime;
  const remaining_ms = Math.max(0, cooldownMs - elapsed);
  const blocked = remaining_ms > 0;

  return {
    blocked,
    reason: blocked
      ? `Revenge trade prevention: ${Math.ceil(remaining_ms / 60000)}m cooldown after loss`
      : null,
    last_loss_time: lastLossTime,
    remaining_ms,
  };
}

// ── WHALE TRAP DETECTION ─────────────────────────────────
function checkWhaleTrap(whaleResult, whaleTrapCooldownUntil) {
  const cooldownUntil = whaleTrapCooldownUntil || _whaleTrapCooldownUntil;
  const now = Date.now();

  // If cooldown active, block
  if (now < cooldownUntil) {
    return {
      blocked: true,
      blockMsg: `Whale trap cooldown: ${Math.ceil((cooldownUntil - now) / 60000)}m remaining`,
      newCooldownUntil: cooldownUntil,
    };
  }

  // Check trap risk from AI whale analyzer
  const trapRisk = whaleResult?.trap_risk || 0;
  const sweepNoConfirm =
    whaleResult?.liquidity_sweep === true &&
    whaleResult?.recommendation !== "ENTER";

  if (trapRisk > 70 || sweepNoConfirm) {
    const newCooldown = now + WHALE_TRAP_COOLDOWN_MS;
    _whaleTrapCooldownUntil = newCooldown;
    return {
      blocked: true,
      blockMsg: trapRisk > 70
        ? `Whale trap risk ${trapRisk}/100 — cooling down 10m`
        : "Liquidity sweep detected without confirmation — waiting",
      newCooldownUntil: newCooldown,
    };
  }

  return { blocked: false, blockMsg: null, newCooldownUntil: cooldownUntil };
}

// ── SPOOF CONSECUTIVE CHECK ───────────────────────────────
function checkSpoofConsecutive(spoofHistory) {
  const history = spoofHistory || _spoofHistory;
  if (history.length < SPOOF_CONSEC_LIMIT) {
    return { blocked: false, blockMsg: null, newCooldownUntil: 0 };
  }

  const last2 = history.slice(-SPOOF_CONSEC_LIMIT);
  const sameSide = last2.every(s => s.side === last2[0].side);
  const recent   = last2.every(s => Date.now() - s.ts < 30 * 60 * 1000); // within 30min

  if (sameSide && recent) {
    const newCooldown = Date.now() + SPOOF_COOLDOWN_MS;
    return {
      blocked: true,
      blockMsg: `Consecutive spoof on ${last2[0].side} side — cooldown 15m`,
      newCooldownUntil: newCooldown,
    };
  }

  return { blocked: false, blockMsg: null, newCooldownUntil: 0 };
}

// ── RUN ALL CHECKS ────────────────────────────────────────
function runAllChecks({
  tradeHistory = [],
  equityCurve = [],
  equity = 0,
  peakEquity = 0,
  sessionStartEquity = 0,
  lastTradeTime = 0,
  cooldownMs = 5 * 60 * 1000,
  entry = null,
  sl = null,
  tp1 = null,
  side = null,
  price = null,
  entryZone = null,
  requestedLeverage = 7,
  atrPct = 1.0,
  proposedTrade = null,
  htfBias = "RANGING",
  regime = "RANGING",
  whaleResult = null,  // ← Optional whale analyzer result
} = {}) {
  const now = Date.now();
  const blocks = [];
  const warnings = [];

  // 1. Daily loss limit
  const daily = checkDailyLossLimit(tradeHistory, equity);
  if (daily.blocked) blocks.push({ type: "DAILY_LIMIT", reason: daily.reason });

  // 2. Consecutive losses
  const consec = checkConsecLosses(tradeHistory);
  if (consec.blocked) blocks.push({ type: "CONSEC_LOSSES", reason: consec.reason });
  else if (consec.current_count >= 2) {
    warnings.push({ type: "CONSEC_WARNING", message: `${consec.current_count} consecutive losses` });
  }

  // 3. Max drawdown
  if (equityCurve.length) {
    const dd = checkMaxDrawdown(equityCurve);
    if (dd.blocked) blocks.push({ type: "MAX_DRAWDOWN", reason: dd.reason });
    else if (dd.pause_required) warnings.push({ type: "DD_WARNING", message: `Drawdown at ${(dd.current_dd * 100).toFixed(1)}%` });
  }

  // 4. Cooldown
  const cool = checkCooldown(lastTradeTime, cooldownMs);
  if (cool.blocked) blocks.push({ type: "COOLDOWN", reason: cool.reason });

  // 5. Min R:R
  if (entry && sl && tp1 && side) {
    const rr = checkMinRR(entry, sl, tp1, side);
    if (!rr.valid) blocks.push({ type: "LOW_RR", reason: rr.reason });
  }

  // 6. FOMO
  if (price && entryZone) {
    const fomo = checkFOMO(price, entryZone);
    if (fomo.blocked) blocks.push({ type: "FOMO", reason: fomo.reason });
  }

  // 7. Leverage cap
  const lev = checkLeverageCap(requestedLeverage, atrPct);
  if (lev.was_capped) {
    warnings.push({ type: "LEVERAGE_CAPPED", message: lev.reason });
  }

  // 8. Psychological risk (psychGuard)
  const psych = psychGuard.runPsychChecks({
    tradeHistory,
    proposedTrade,
    htfBias,
    regime,
    equity,
    peakEquity,
    sessionStartEquity,
  });

  for (const b of psych.blocks) {
    blocks.push({ type: "PSYCH_" + b.type, reason: b.reason });
  }
  for (const w of psych.warnings) {
    warnings.push({ type: "PSYCH_" + w.type, message: w.message });
  }

  // Expose psych state to dashboard
  if (typeof global !== "undefined" && global.botState) {
    global.botState.psychState = {
      state:            psych.psych_state,
      size_multiplier:  psych.size_multiplier,
      dashboard_alert:  psych.dashboard_alert,
      wait_ms:          psych.wait_ms,
    };
  }

  // 9. Whale guard (optional — only if whaleResult provided)
  if (whaleResult) {
    // Check for whale trap or unconfirmed sweep
    const whaleTrap = checkWhaleTrap(whaleResult);
    if (whaleTrap.blocked) {
      blocks.push({ type: "WHALE_TRAP", reason: whaleTrap.blockMsg });
    }

    // Track spoof detections for consecutive spoof checking
    if (whaleResult.spoof_detected) {
      const spoofSide = whaleResult.spoof_side || "UNKNOWN";
      _spoofHistory.push({ side: spoofSide, ts: Date.now() });
      // Keep rolling window of last 10 spoofs
      if (_spoofHistory.length > 10) {
        _spoofHistory.shift();
      }

      // Check for consecutive spoofs
      const spoofCheck = checkSpoofConsecutive(_spoofHistory);
      if (spoofCheck.blocked) {
        blocks.push({ type: "SPOOF_CONSEC", reason: spoofCheck.blockMsg });
      }
    }
  }

  // 10. Profit Protector — Session profit lock, win cooldown, trade limits
  const profitCheck = profitProtector.runProfitProtectionChecks({
    tradeHistory,
    equity,
    proposedScore: proposedTrade?.confluenceScore || 65,
    currentTime: now,
    profitThresholds: { green: 1.5, lockout: 2.5 },
  });

  for (const b of profitCheck.blocks) {
    blocks.push({ type: "PROFIT_" + b.type, reason: b.reason });
  }
  for (const w of profitCheck.warnings) {
    warnings.push({ type: "PROFIT_" + w.type, message: w.message });
  }

  // Expose profit protection state to dashboard
  if (typeof global !== "undefined" && global.botState) {
    global.botState.profitProtection = {
      approved: profitCheck.approved,
      daily_pnl_pct: profitCheck.details?.profitLock?.daily_pnl_pct || 0,
      win_streak: profitCheck.details?.winStreak?.consecutive_wins || 0,
      cooldown_remaining_ms: profitCheck.details?.cooldown?.remaining_ms || 0,
      session_locked: profitCheck.details?.profitLock?.locked || false,
    };
  }

  // 11. Entry Quality Filter — Prevent false breakouts & chop trades
  // Using new SMC validator and session filter
  const smcCheck = smcValidator.validateEntry(
    proposedTrade?.klines || [],
    proposedTrade?.side === "LONG" ? "LONG" : "SHORT",
    proposedTrade?.symbol || "BTCUSDT"
  );
  const sessionCheck = enhancedSessionFilter.checkSession(
    proposedTrade?.symbol || "BTCUSDT",
    proposedTrade?.confluenceScore || 50
  );

  if (!smcCheck.canEnter) {
    blocks.push({ type: "SMC_VALIDATION", reason: smcCheck.failed?.join("; ") || "SMC checks failed" });
  }
  if (!sessionCheck.canTrade) {
    blocks.push({ type: "SESSION_FILTER", reason: sessionCheck.reasons?.join("; ") || "Session blocked" });
  }

  // Expose entry quality state to dashboard
  if (typeof global !== "undefined" && global.botState) {
    global.botState.entryQuality = {
      approved: smcCheck.canEnter && sessionCheck.canTrade,
      smcScore: smcCheck.score,
      smcGrade: smcCheck.grade,
      sessionQuality: sessionCheck.quality,
    };
  }

  return {
    approved: blocks.length === 0,
    blocks,
    warnings,
    approved_leverage: lev.approved_leverage,
    size_multiplier:   psych.size_multiplier,
    psych_state:       psych.psych_state,
    checks: { daily, consec, lev, psych, profitCheck, qualityCheck },
  };
}

module.exports = {
  checkDailyLossLimit,
  checkConsecLosses,
  checkMaxDrawdown,
  checkCooldown,
  checkMinRR,
  checkFOMO,
  checkLeverageCap,
  checkNoRevengeTrade,
  checkWhaleTrap,
  checkSpoofConsecutive,
  runAllChecks,
};
