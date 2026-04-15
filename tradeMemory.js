"use strict";

/**
 * TRADE MEMORY — Self-learning light, persists setup stats to disk.
 * Survives restarts. Blocks setups with WR < 30% (min 5 trades) or -3 streak.
 * ⭐ FIXED: Now includes circuit breaker state & intraday loss tracking
 */

const fs   = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "trade-memory.json");

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // Initialize circuit breaker if missing
    if (!data._circuitBreaker) {
      data._circuitBreaker = {
        active: false,
        resumeTime: null,
        lossCount: 0,
        lossStreak: 0,
        activatedAt: null,
      };
    }
    // Initialize intraday loss tracking if missing
    if (!data._intraDayLoss) {
      data._intraDayLoss = {
        sessionStartTime: Date.now(),
        sessionLossUSDT: 0,
        sessionMaxDrawdown: 0,
        lastResetTime: Date.now(),
      };
    }
    // Initialize mandatory pair switch state if missing
    if (!data._pairRotation) {
      data._pairRotation = {
        mandatorySwitchActive: false,
        mandatorySwitchUntil: null,
        lastSwitchedFrom: null,
        lastSwitchedTo: null,
        lastSwitchTime: null,
        switchCooldownUntil: null,
      };
    }
    return data;
  } catch {
    return {
      _circuitBreaker: { active: false, resumeTime: null, lossCount: 0, lossStreak: 0, activatedAt: null },
      _intraDayLoss: { sessionStartTime: Date.now(), sessionLossUSDT: 0, sessionMaxDrawdown: 0, lastResetTime: Date.now() },
      _pairRotation: { mandatorySwitchActive: false, mandatorySwitchUntil: null, lastSwitchedFrom: null, lastSwitchedTo: null, lastSwitchTime: null, switchCooldownUntil: null },
    };
  }
}

function save(stats) {
  try { fs.writeFileSync(FILE, JSON.stringify(stats, null, 2)); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// SETUP STATS (original functionality)
// ═══════════════════════════════════════════════════════════════

function updateSetupStats(setup, pnlUSDT) {
  if (!setup) return;
  try {
    const stats = load();
    if (!stats[setup]) stats[setup] = { win: 0, loss: 0, totalPnL: 0, streak: 0 };
    const s = stats[setup];
    if (pnlUSDT > 0) { s.win++;  s.streak = Math.max(0, s.streak) + 1; }
    else              { s.loss++; s.streak = Math.min(0, s.streak) - 1; }
    s.totalPnL = +(s.totalPnL + pnlUSDT).toFixed(3);
    save(stats);
    if (global.botState) global.botState.tradeMemory = stats;
  } catch {}
}

function isSetupAllowed(setup) {
  if (!setup) return true;
  try {
    const stats = load();
    const s = stats[setup];
    if (!s) return true;
    const total = s.win + s.loss;
    if (total < 5) return true;      // belum cukup data
    const winRate = s.win / total;
    if (winRate < 0.30) return false; // WR < 30%
    if (s.streak <= -3) return false; // 3 loss streak
    return true;
  } catch { return true; }
}

function getStats() {
  try {
    const stats = load();
    return Object.entries(stats)
      .filter(([key]) => !key.startsWith("_"))
      .map(([setup, s]) => ({
        setup,
        total:   s.win + s.loss,
        winRate: s.win + s.loss > 0 ? +(s.win / (s.win + s.loss) * 100).toFixed(1) : null,
        totalPnL: s.totalPnL,
        streak:  s.streak,
        allowed: isSetupAllowed(setup),
      }));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// CIRCUIT BREAKER STATE (⭐ NEW)
// ═══════════════════════════════════════════════════════════════

function activateCircuitBreaker(lossStreak = 3) {
  try {
    const stats = load();
    const now = Date.now();
    const pauseDurationMs = lossStreak >= 3 ? (2 * 60 * 60 * 1000) : (1 * 60 * 60 * 1000); // 2h or 1h

    stats._circuitBreaker = {
      active: true,
      resumeTime: now + pauseDurationMs,
      lossCount: lossStreak,
      lossStreak: lossStreak,
      activatedAt: now,
    };
    save(stats);
    return { active: true, resumeTime: now + pauseDurationMs, reason: `${lossStreak} consecutive losses: ${pauseDurationMs / (60 * 1000)}min pause` };
  } catch { return { active: false }; }
}

function isCircuitBreakerActive() {
  try {
    const stats = load();
    const cb = stats._circuitBreaker || {};

    // Check if pause window has expired
    if (cb.active && cb.resumeTime && Date.now() >= cb.resumeTime) {
      // Auto-reset
      cb.active = false;
      cb.resumeTime = null;
      save(stats);
      return { active: false, message: "Circuit breaker pause expired" };
    }

    if (cb.active && cb.resumeTime) {
      const remainingMs = cb.resumeTime - Date.now();
      const remainingMin = Math.ceil(remainingMs / (60 * 1000));
      return {
        active: true,
        resumeTime: cb.resumeTime,
        remainingMin: remainingMin,
        reason: `Trading paused: ${cb.lossStreak} consecutive losses (${remainingMin}min remaining)`,
      };
    }

    return { active: false };
  } catch { return { active: false }; }
}

function resetCircuitBreaker() {
  try {
    const stats = load();
    stats._circuitBreaker = {
      active: false,
      resumeTime: null,
      lossCount: 0,
      lossStreak: 0,
      activatedAt: null,
    };
    save(stats);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// INTRADAY LOSS TRACKING (⭐ NEW)
// ═══════════════════════════════════════════════════════════════

function recordIntraDayLoss(lossUSDT) {
  try {
    const stats = load();
    const now = Date.now();
    const idl = stats._intraDayLoss || {};

    // Reset session if more than 24 hours have passed
    if (now - idl.lastResetTime > 24 * 60 * 60 * 1000) {
      idl.sessionStartTime = now;
      idl.sessionLossUSDT = 0;
      idl.sessionMaxDrawdown = 0;
    }

    idl.sessionLossUSDT += Math.min(0, lossUSDT); // Only add losses
    idl.sessionMaxDrawdown = Math.min(idl.sessionMaxDrawdown, idl.sessionLossUSDT);
    idl.lastResetTime = now;

    stats._intraDayLoss = idl;
    save(stats);

    return {
      sessionLossUSDT: idl.sessionLossUSDT,
      sessionMaxDrawdown: idl.sessionMaxDrawdown,
      limitExceeded: Math.abs(idl.sessionLossUSDT) >= 1.2, // -1.2% of 100 USDT equity base
    };
  } catch { return { sessionLossUSDT: 0, limitExceeded: false }; }
}

function getIntraDayLossStatus() {
  try {
    const stats = load();
    const idl = stats._intraDayLoss || {};
    return {
      sessionLossUSDT: idl.sessionLossUSDT,
      sessionMaxDrawdown: idl.sessionMaxDrawdown,
      sessionStartTime: idl.sessionStartTime,
      limitExceeded: Math.abs(idl.sessionLossUSDT) >= 1.2,
    };
  } catch { return { sessionLossUSDT: 0, limitExceeded: false }; }
}

function resetIntraDayLoss() {
  try {
    const stats = load();
    stats._intraDayLoss = {
      sessionStartTime: Date.now(),
      sessionLossUSDT: 0,
      sessionMaxDrawdown: 0,
      lastResetTime: Date.now(),
    };
    save(stats);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// PAIR ROTATION STATE (⭐ NEW)
// ═══════════════════════════════════════════════════════════════

function setMandatorySwitchState(fromPair, toPair, durationMs = 60 * 60 * 1000) {
  try {
    const stats = load();
    const now = Date.now();

    stats._pairRotation = {
      mandatorySwitchActive: true,
      mandatorySwitchUntil: now + durationMs,
      lastSwitchedFrom: fromPair,
      lastSwitchedTo: toPair,
      lastSwitchTime: now,
      switchCooldownUntil: now + durationMs, // Can't switch back for 1 hour
    };
    save(stats);
    return { switched: true, from: fromPair, to: toPair, duration: durationMs };
  } catch { return { switched: false }; }
}

function isMandatorySwitchActive() {
  try {
    const stats = load();
    const ps = stats._pairRotation || {};

    // Check if cooldown has expired
    if (ps.mandatorySwitchActive && ps.mandatorySwitchUntil && Date.now() >= ps.mandatorySwitchUntil) {
      ps.mandatorySwitchActive = false;
      ps.mandatorySwitchUntil = null;
      save(stats);
      return { active: false };
    }

    if (ps.mandatorySwitchActive && ps.mandatorySwitchUntil) {
      const remainingMs = ps.mandatorySwitchUntil - Date.now();
      const remainingMin = Math.ceil(remainingMs / (60 * 1000));
      return {
        active: true,
        mandatorySwitchUntil: ps.mandatorySwitchUntil,
        lastSwitchedFrom: ps.lastSwitchedFrom,
        lastSwitchedTo: ps.lastSwitchedTo,
        switchCooldownActive: ps.lastSwitchedFrom && Date.now() < (ps.switchCooldownUntil || 0),
        remainingMin: remainingMin,
      };
    }

    return { active: false };
  } catch { return { active: false }; }
}

function canSwitchToPair(pair) {
  try {
    const stats = load();
    const ps = stats._pairRotation || {};

    // Can't switch back to previously switched-from pair during cooldown
    if (ps.switchCooldownUntil && Date.now() < ps.switchCooldownUntil && pair === ps.lastSwitchedFrom) {
      const remainingMin = Math.ceil((ps.switchCooldownUntil - Date.now()) / (60 * 1000));
      return { allowed: false, reason: `Can't switch to ${pair} for ${remainingMin}min (recent switch)` };
    }

    return { allowed: true };
  } catch { return { allowed: true }; }
}

module.exports = {
  // Original
  updateSetupStats,
  isSetupAllowed,
  getStats,
  // Circuit breaker (⭐ NEW)
  activateCircuitBreaker,
  isCircuitBreakerActive,
  resetCircuitBreaker,
  // Intraday loss (⭐ NEW)
  recordIntraDayLoss,
  getIntraDayLossStatus,
  resetIntraDayLoss,
  // Pair rotation (⭐ NEW)
  setMandatorySwitchState,
  isMandatorySwitchActive,
  canSwitchToPair,
};
