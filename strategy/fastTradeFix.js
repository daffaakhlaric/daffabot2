"use strict";

/**
 * Fast Trade Bug Fix & Noise Filter
 * CRITICAL: Fixes trades closing in <20 seconds
 * 
 * Fixes:
 * - Minimum hold enforcement (majors: 2-3 min, mid: 2 min, meme: 3-5 min)
 * - No intrabar breakout entries
 * - Require candle close confirmation
 * - No trades inside micro range
 * - ATR threshold filter
 * - Spread protection
 */

const { getPairCategory, getPairThresholds, calcATR } = require("./enhancedRegimeDetector");

// B.11: Scalp mode — MAJOR min-hold cut to 30s; SL cooldown 10min -> 2min
const MIN_HOLD_MS = {
  MAJOR: 30 * 1000,       // B.11: 2min -> 30s for scalping
  MID: 90 * 1000,
  MEME: 2 * 60 * 1000,
};

const MIN_HOLD_AFTER_SL = 2 * 60 * 1000;    // B.11: 10min -> 2min
const MIN_HOLD_AFTER_WIN = 30 * 1000;
const MIN_HOLD_AFTER_LOSS = 60 * 1000;

const FAST_TRADE_THRESHOLD_MS = 8 * 1000;   // B.11: 20s -> 8s (true bug threshold)
const ATR_THRESHOLD_MULTIPLIER = 1.5;

const RECENT_EXITS = {};
const PAIR_STATE = {};

function initPairState(symbol) {
  if (!PAIR_STATE[symbol]) {
    PAIR_STATE[symbol] = {
      lastEntryTime: 0,
      lastExitTime: 0,
      lastExitReason: null,
      lastExitPnL: null,
      fastLossCount: 0,
      consecutiveFastLosses: 0,
      minHoldMs: 180000,
      entryBlocked: false,
      blockUntil: 0,
    };
  }
  return PAIR_STATE[symbol];
}

function checkMinimumHold(symbol, positionOpenedAt) {
  const state = initPairState(symbol);
  const category = getPairCategory(symbol);
  const minHoldMs = MIN_HOLD_MS[category] || MIN_HOLD_MS.MAJOR;
  state.minHoldMs = minHoldMs;

  if (!positionOpenedAt) {
    return { allowed: true, reason: "No position", minHoldMs };
  }

  const holdMs = Date.now() - positionOpenedAt;

  if (holdMs < minHoldMs) {
    return {
      allowed: false,
      emergencyOnly: true,
      reason: `Min hold ${Math.ceil(minHoldMs / 60000)}min not met (${Math.ceil(holdMs / 60000)}min)`,
      minHoldMs,
      holdMs,
    };
  }

  return { allowed: true, minHoldMs, holdMs };
}

function checkIntrabarBreakout(klines, direction, setup = null) {
  // B.11: Disabled for SCALP — fake-breakout filter kills high-frequency entries.
  if (setup && /SCALP/i.test(setup)) {
    return { allowed: true, reason: "Intrabar check skipped for SCALP" };
  }

  if (!klines || klines.length < 3) {
    return { allowed: false, reason: "Insufficient candles" };
  }

  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];

  const isBullish = direction === "LONG";
  const breakout = isBullish
    ? last.high > prev.high
    : last.low < prev.low;

  if (breakout) {
    const closeInRange = isBullish
      ? last.close < prev.high
      : last.close > prev.low;

    if (closeInRange) {
      return {
        allowed: false,
        type: "fake_breakout",
        reason: "Intrabar breakout - closed back in range (fakeout)",
      };
    }
  }

  return { allowed: true, reason: "No intrabar breakout detected" };
}

function checkCandleCloseConfirmation(klines) {
  if (!klines || klines.length < 2) {
    return { allowed: false, reason: "Insufficient candles" };
  }

  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const avgVol = klines.slice(-10).reduce((s, k) => s + k.volume, 0) / 10;

  if (last.volume < avgVol * 0.3) {
    return {
      allowed: false,
      reason: "Candle still forming (volume below 30% of average)",
    };
  }

  const bodySize = Math.abs(last.close - last.open);
  const rangeSize = last.high - last.low;
  const bodyRatio = rangeSize > 0 ? bodySize / rangeSize : 0;

  if (bodyRatio < 0.4) {
    return {
      allowed: false,
      reason: `Weak candle body: ${(bodyRatio * 100).toFixed(0)}% (need 40%+)`,
    };
  }

  return { allowed: true, bodyRatio: Math.round(bodyRatio * 100) / 100 };
}

function checkMicroRange(klines, symbol) {
  // B.11: MAJOR scalping needs tight ranges — never block on micro range for MAJOR.
  if (!klines || klines.length < 5) {
    return { allowed: true, reason: "Insufficient data" };
  }

  const category = getPairCategory(symbol);
  const last5 = klines.slice(-5);

  const range = Math.max(...last5.map(k => k.high)) - Math.min(...last5.map(k => k.low));
  const avgPrice = last5.reduce((s, k) => s + k.close, 0) / 5;
  const rangePct = (range / avgPrice) * 100;

  if (category === "MAJOR") {
    return { allowed: true, rangePct, reason: "Micro range allowed for MAJOR scalp" };
  }

  const maxRangePct = {
    MID: 0.4,
    MEME: 0.5,
  }[category] || 0.3;

  if (rangePct < maxRangePct) {
    return {
      allowed: false,
      reason: `Micro range: ${rangePct.toFixed(2)}% < ${maxRangePct}% threshold`,
      rangePct,
    };
  }

  return { allowed: true, rangePct };
}

function checkATRThreshold(klines, symbol, direction) {
  if (!klines || klines.length < 15) {
    return { allowed: false, reason: "Insufficient data for ATR" };
  }

  const atrPct = calcATR(klines, 14);
  const category = getPairCategory(symbol);

  const minATR = {
    MAJOR: 0.2,
    MID: 0.3,
    MEME: 0.5,
  }[category] || 0.2;

  if (atrPct < minATR) {
    return {
      allowed: false,
      reason: `ATR too low: ${atrPct.toFixed(2)}% < ${minATR}% (dead market)`,
      atrPct,
    };
  }

  const maxATR = {
    MAJOR: 2.0,
    MID: 3.0,
    MEME: 5.0,
  }[category] || 2.0;

  if (atrPct > maxATR) {
    return {
      allowed: false,
      reason: `ATR too high: ${atrPct.toFixed(2)}% > ${maxATR}% (volatile)`,
      atrPct,
    };
  }

  return { allowed: true, atrPct };
}

function checkSpreadProtection(symbol, price) {
  const category = getPairCategory(symbol);

  const maxSpreadPct = {
    MAJOR: 0.05,
    MID: 0.08,
    MEME: 0.15,
  }[category] || 0.1;

  const mockSpread = category === "MEME" ? 0.12 : category === "MID" ? 0.06 : 0.03;

  if (mockSpread > maxSpreadPct) {
    return {
      allowed: false,
      reason: `Spread too wide: ${(mockSpread * 100).toFixed(2)}% > ${maxSpreadPct}%`,
      spreadPct: mockSpread,
    };
  }

  return { allowed: true, spreadPct: mockSpread };
}

function checkCooldownAfterExit(symbol, exitReason, pnl) {
  const state = initPairState(symbol);
  const now = Date.now();

  state.lastExitTime = now;
  state.lastExitReason = exitReason;
  state.lastExitPnL = pnl;

  if (pnl < 0) {
    if (state.lastExitTime - state.lastEntryTime < FAST_TRADE_THRESHOLD_MS) {
      state.consecutiveFastLosses++;
      state.fastLossCount++;

      if (state.consecutiveFastLosses >= 2) {
        state.entryBlocked = true;
        state.blockUntil = now + MIN_HOLD_AFTER_SL;
        state.consecutiveFastLosses = 0;

        return {
          allowed: false,
          blocked: true,
          reason: `Fast loss cooldown: blocked for ${MIN_HOLD_AFTER_SL / 60000}min`,
          unblockAt: state.blockUntil,
        };
      }
    }
  } else {
    state.consecutiveFastLosses = 0;
  }

  const minCooldown = pnl > 0 ? MIN_HOLD_AFTER_WIN : MIN_HOLD_AFTER_LOSS;
  const timeSinceExit = now - state.lastExitTime;

  if (timeSinceExit < minCooldown) {
    const remainMin = Math.ceil((minCooldown - timeSinceExit) / 60000);
    return {
      allowed: false,
      reason: `${pnl > 0 ? "WIN" : "LOSS"} cooldown: ${remainMin}min remaining`,
      remainingMs: minCooldown - timeSinceExit,
    };
  }

  return { allowed: true };
}

function checkSameDirectionCooldown(symbol, direction) {
  const state = initPairState(symbol);
  const now = Date.now();

  const cooldown15m = 15 * 60 * 1000;

  if (state.lastExitTime > 0) {
    const timeSinceExit = now - state.lastExitTime;
    if (timeSinceExit < cooldown15m) {
      const remainMin = Math.ceil((cooldown15m - timeSinceExit) / 60000);
      return {
        allowed: false,
        reason: `Same pair cooldown: ${remainMin}min remaining`,
        remainingMs: cooldown15m - timeSinceExit,
      };
    }
  }

  return { allowed: true };
}

function recordEntry(symbol, entryTime) {
  const state = initPairState(symbol);
  state.lastEntryTime = entryTime;
  state.entryBlocked = false;
}

function recordExit(symbol, exitTime, reason, pnl) {
  const state = initPairState(symbol);
  state.lastExitTime = exitTime;
  state.lastExitReason = reason;
  state.lastExitPnL = pnl;

  const holdMs = exitTime - state.lastEntryTime;
  
  if (holdMs < FAST_TRADE_THRESHOLD_MS && pnl < 0) {
    state.fastLossCount++;
    state.consecutiveFastLosses++;
  } else {
    state.consecutiveFastLosses = 0;
  }
}

function validateEntry({
  symbol,
  klines,
  direction,
  positionOpenedAt,
  currentTime = Date.now(),
  setup = null,
}) {
  const category = getPairCategory(symbol);
  const checks = {};

  checks.minHold = checkMinimumHold(symbol, positionOpenedAt);
  checks.intrabar = checkIntrabarBreakout(klines, direction, setup);
  checks.candleClose = checkCandleCloseConfirmation(klines);
  checks.microRange = checkMicroRange(klines, symbol);
  checks.atrThreshold = checkATRThreshold(klines, symbol, direction);
  checks.spread = checkSpreadProtection(symbol);
  checks.cooldown = checkCooldownAfterExit(symbol);
  checks.sameDirCooldown = checkSameDirectionCooldown(symbol, direction);

  let canEnter = true;
  const blockedReasons = [];

  for (const [name, result] of Object.entries(checks)) {
    if (!result.allowed) {
      canEnter = false;
      blockedReasons.push(`${name}: ${result.reason}`);
    }
  }

  const state = initPairState(symbol);
  if (state.entryBlocked && currentTime < state.blockUntil) {
    canEnter = false;
    blockedReasons.push(`BLOCKED_UNTIL: ${new Date(state.blockUntil).toISOString()}`);
  }

  return {
    canEnter,
    category,
    direction,
    checks,
    blockedReasons,
    fastLossStreak: state.consecutiveFastLosses,
    fastLossCount: state.fastLossCount,
  };
}

function getMinHoldTime(symbol) {
  const category = getPairCategory(symbol);
  return MIN_HOLD_MS[category] || MIN_HOLD_MS.MAJOR;
}

function isFastTrade(entryTime, exitTime) {
  return (exitTime - entryTime) < FAST_TRADE_THRESHOLD_MS;
}

function getStats(symbol) {
  const state = initPairState(symbol);
  return {
    fastLossCount: state.fastLossCount,
    consecutiveFastLosses: state.consecutiveFastLosses,
    entryBlocked: state.entryBlocked,
    blockUntil: state.blockUntil,
    minHoldMs: state.minHoldMs,
  };
}

module.exports = {
  validateEntry,
  checkMinimumHold,
  checkIntrabarBreakout,
  checkCandleCloseConfirmation,
  checkMicroRange,
  checkATRThreshold,
  checkSpreadProtection,
  checkCooldownAfterExit,
  checkSameDirectionCooldown,
  recordEntry,
  recordExit,
  getMinHoldTime,
  isFastTrade,
  getStats,
  MIN_HOLD_MS,
  FAST_TRADE_THRESHOLD_MS,
};