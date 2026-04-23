"use strict";

/**
 * Enhanced Cooldown & Reentry Protection System
 * Production-ready cooldown management
 * 
 * After: SL hit, fast loss, scratch exit
 * - Same pair cooldown: 10-15 min
 * - Same direction stricter: 15 min
 * - Fast loss additional cooldown
 * - Loss streak protection
 */

const { getPairCategory } = require("./enhancedRegimeDetector");

// B.4: Aggressive scalping cooldowns. MAJOR cut hard for 150x scalp loop.
const COOLDOWN_CONFIG = {
  MAJOR: {
    afterSL: 3 * 60 * 1000,        // B.4: 10min -> 3min
    afterWIN: 30 * 1000,           // B.4: 3min -> 30s
    afterLOSS: 2 * 60 * 1000,      // B.4: 10min -> 2min
    afterSCRATCH: 30 * 1000,       // B.4: 5min -> 30s
    sameDirection: 2 * 60 * 1000,  // B.4: 15min -> 2min
  },
  MID: {
    afterSL: 5 * 60 * 1000,
    afterWIN: 60 * 1000,
    afterLOSS: 4 * 60 * 1000,
    afterSCRATCH: 60 * 1000,
    sameDirection: 4 * 60 * 1000,
  },
  MEME: {
    afterSL: 8 * 60 * 1000,
    afterWIN: 2 * 60 * 1000,
    afterLOSS: 8 * 60 * 1000,
    afterSCRATCH: 3 * 60 * 1000,
    sameDirection: 10 * 60 * 1000,
  },
};

const FAST_LOSS_THRESHOLD_MS = 10 * 1000;       // B.4: 20s -> 10s
const FAST_LOSS_COOLDOWN_MS = 5 * 60 * 1000;    // B.4: 30min -> 5min

const PAIR_COOLDOWNS = {};
const GLOBAL_STATS = {
  totalSLHits: 0,
  totalFastLosses: 0,
  consecutiveLosses: 0,
  lastResetTime: Date.now(),
};

function getCooldownConfig(symbol) {
  const category = getPairCategory(symbol);
  return COOLDOWN_CONFIG[category] || COOLDOWN_CONFIG.MAJOR;
}

function getCooldownState(symbol) {
  if (!PAIR_COOLDOWNS[symbol]) {
    PAIR_COOLDOWNS[symbol] = {
      lastExitTime: 0,
      lastExitReason: null,
      lastExitPnL: null,
      lastDirection: null,
      lastEntryTime: 0,
      consecutiveLosses: 0,
      fastLossStreak: 0,
    };
  }
  return PAIR_COOLDOWNS[symbol];
}

function checkCooldown(symbol, direction, currentTime = Date.now()) {
  const state = getCooldownState(symbol);
  const config = getCooldownConfig(symbol);
  const blocks = [];

  if (state.lastExitTime > 0) {
    const timeSinceExit = currentTime - state.lastExitTime;
    const exitType = state.lastExitPnL > 0 ? "WIN" : state.lastExitPnL === 0 ? "SCRATCH" : "LOSS";
    
    let requiredCooldown = config.afterWIN;
    
    if (exitType === "LOSS") {
      requiredCooldown = state.lastExitReason?.includes("STOP_LOSS") 
        ? config.afterSL 
        : config.afterLOSS;
    } else if (exitType === "SCRATCH") {
      requiredCooldown = config.afterSCRATCH;
    }

    if (timeSinceExit < requiredCooldown) {
      const remainMin = Math.ceil((requiredCooldown - timeSinceExit) / 60000);
      blocks.push({
        type: "EXIT_COOLDOWN",
        reason: `${exitType} cooldown: ${remainMin}min remaining`,
        remainingMs: requiredCooldown - timeSinceExit,
      });
    }
  }

  if (state.lastDirection === direction && state.lastExitTime > 0) {
    const timeSinceExit = currentTime - state.lastExitTime;
    if (timeSinceExit < config.sameDirection) {
      const remainMin = Math.ceil((config.sameDirection - timeSinceExit) / 60000);
      blocks.push({
        type: "SAME_DIRECTION",
        reason: `Same direction cooldown: ${remainMin}min remaining`,
        remainingMs: config.sameDirection - timeSinceExit,
      });
    }
  }

  if (state.fastLossStreak >= 2) {
    const fastLossCooldown = FAST_LOSS_COOLDOWN_MS;
    const timeSinceLastExit = currentTime - state.lastExitTime;
    if (timeSinceLastExit < fastLossCooldown) {
      const remainMin = Math.ceil((fastLossCooldown - timeSinceLastExit) / 60000);
      blocks.push({
        type: "FAST_LOSS_STREAK",
        reason: `Fast loss streak (${state.fastLossStreak}): blocked ${remainMin}min`,
        remainingMs: fastLossCooldown - timeSinceLastExit,
      });
    }
  }

  const dailyLossLimit = 10;  // B.4: 3 -> 10 (real cap is -4% equity in riskGuard)
  const todayLosses = PAIR_COOLDOWNS["_dailyLosses"] || 0;
  if (todayLosses >= dailyLossLimit) {
    const resetTime = new Date();
    resetTime.setHours(0, 0, 0, 0);
    resetTime.setDate(resetTime.getDate() + 1);
    const msUntilReset = resetTime - currentTime;
    
    if (msUntilReset > 0) {
      blocks.push({
        type: "DAILY_LOSS_LIMIT",
        reason: `Daily loss limit (${dailyLosses}) reached, reset in ${Math.ceil(msUntilReset / 60000)}min`,
        remainingMs: msUntilReset,
      });
    }
  }

  return {
    allowed: blocks.length === 0,
    blocks,
    canRetry: blocks.length > 0 && blocks.every(b => b.type !== "FAST_LOSS_STREAK" && b.type !== "DAILY_LOSS_LIMIT"),
  };
}

function recordExit(symbol, reason, pnl, direction, currentTime = Date.now()) {
  const state = getCooldownState(symbol);
  
  state.lastExitTime = currentTime;
  state.lastExitReason = reason;
  state.lastExitPnL = pnl;
  state.lastDirection = direction;

  if (pnl < 0) {
    state.consecutiveLosses++;
    GLOBAL_STATS.consecutiveLosses++;

    const holdTime = currentTime - state.lastEntryTime;
    if (holdTime < FAST_LOSS_THRESHOLD_MS) {
      state.fastLossStreak++;
      GLOBAL_STATS.totalFastLosses++;
    }

    if (reason?.includes("STOP_LOSS")) {
      GLOBAL_STATS.totalSLHits++;
    }

    PAIR_COOLDOWNS["_dailyLosses"] = (PAIR_COOLDOWNS["_dailyLosses"] || 0) + 1;
  } else {
    state.consecutiveLosses = 0;
    state.fastLossStreak = 0;
  }

  return {
    symbol,
    exitTime: currentTime,
    reason,
    pnl,
    direction,
    consecutiveLosses: state.consecutiveLosses,
    fastLossStreak: state.fastLossStreak,
  };
}

function recordEntry(symbol, entryTime) {
  const state = getCooldownState(symbol);
  state.lastEntryTime = entryTime;
}

function clearCooldown(symbol) {
  if (PAIR_COOLDOWNS[symbol]) {
    PAIR_COOLDOWNS[symbol].lastExitTime = 0;
    PAIR_COOLDOWNS[symbol].lastExitReason = null;
    PAIR_COOLDOWNS[symbol].lastExitPnL = null;
    PAIR_COOLDOWNS[symbol].lastDirection = null;
  }
}

function resetDailyStats() {
  PAIR_COOLDOWNS["_dailyLosses"] = 0;
  GLOBAL_STATS.consecutiveLosses = 0;
}

function getCooldownStatus(symbol, currentTime = Date.now()) {
  const state = getCooldownState(symbol);
  const config = getCooldownConfig(symbol);

  const timeSinceExit = currentTime - (state.lastExitTime || 0);
  
  let nextAllowedIn = 0;
  let cooldownType = null;

  if (state.lastExitTime > 0) {
    const exitType = state.lastExitPnL > 0 ? "WIN" : state.lastExitPnL === 0 ? "SCRATCH" : "LOSS";
    const requiredCooldown = exitType === "WIN" 
      ? config.afterWIN 
      : exitType === "SCRATCH" 
        ? config.afterSCRATCH 
        : state.lastExitReason?.includes("STOP_LOSS")
          ? config.afterSL
          : config.afterLOSS;
    
    if (timeSinceExit < requiredCooldown) {
      nextAllowedIn = requiredCooldown - timeSinceExit;
      cooldownType = `Post-${exitType}`;
    }
  }

  if (state.lastDirection && state.lastExitTime > 0) {
    const dirTimeSince = currentTime - state.lastExitTime;
    const dirRemaining = config.sameDirection - dirTimeSince;
    if (dirRemaining > nextAllowedIn) {
      nextAllowedIn = dirRemaining;
      cooldownType = "Same Direction";
    }
  }

  return {
    symbol,
    lastExitTime: state.lastExitTime,
    lastExitPnL: state.lastExitPnL,
    lastDirection: state.lastDirection,
    consecutiveLosses: state.consecutiveLosses,
    fastLossStreak: state.fastLossStreak,
    cooldownActive: nextAllowedIn > 0,
    nextAllowedInMs: nextAllowedIn,
    nextAllowedInMin: Math.ceil(nextAllowedIn / 60000),
    cooldownType,
  };
}

function getGlobalStats() {
  return {
    ...GLOBAL_STATS,
    dailyLosses: PAIR_COOLDOWNS["_dailyLosses"] || 0,
  };
}

function getAllPairStatuses(currentTime = Date.now()) {
  return Object.keys(PAIR_COOLDOWNS)
    .filter(k => k !== "_dailyLosses")
    .map(symbol => getCooldownStatus(symbol, currentTime));
}

module.exports = {
  checkCooldown,
  recordExit,
  recordEntry,
  clearCooldown,
  resetDailyStats,
  getCooldownStatus,
  getGlobalStats,
  getAllPairStatuses,
  getCooldownConfig,
  COOLDOWN_CONFIG,
  FAST_LOSS_THRESHOLD_MS,
  FAST_LOSS_COOLDOWN_MS,
};