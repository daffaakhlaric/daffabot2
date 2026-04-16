"use strict";

/**
 * Anti-Fakeout Module - Prevents noise trading and micro-consolidation entries
 * Key fixes:
 * - Minimum hold time enforcement
 * - Candle close confirmation
 * - Micro chop filter
 * - Spread/slippage protection
 * - Re-entry cooldown
 * - Signal strength scoring
 * - Tick noise protection
 */

const PAIR_CATEGORIES = {
  MAJOR: ["BTCUSDT", "ETHUSDT"],
  MID: ["SOLUSDT", "BNBUSDT", "XRPUSDT", "LINKUSDT", "ADAUSDT"],
  MEME: ["PEPEUSDT", "WIFUSDT", "BONKUSDT", "DOGEUSDT", "SHIBUSDT"],
};

function getPairCategory(symbol) {
  if (PAIR_CATEGORIES.MAJOR.includes(symbol)) return "MAJOR";
  if (PAIR_CATEGORIES.MID.includes(symbol)) return "MID";
  if (PAIR_CATEGORIES.MEME.includes(symbol)) return "MEME";
  return "MID";
}

// State for anti-fakeout
const FAKEOUT_STATE = {};
const RECENT_EXITS = {}; // Track recent exits for cooldown

function initFakeoutState(symbol) {
  if (!FAKEOUT_STATE[symbol]) {
    FAKEOUT_STATE[symbol] = {
      lastEntryTime: 0,
      lastExitTime: 0,
      lastExitReason: null,
      consecutiveFastLosses: 0,
      entryHoldTime: 0,
    };
  }
  return FAKEOUT_STATE[symbol];
}

// A. Minimum Hold Filter - enforce minimum hold time
function checkMinimumHold(symbol, positionOpenedAt) {
  const state = initFakeoutState(symbol);
  const category = getPairCategory(symbol);

  const minHoldMs = {
    MAJOR: 2 * 60 * 1000, // 2 min
    MID: 2.5 * 60 * 1000, // 2.5 min
    MEME: 3 * 60 * 1000, // 3 min
  }[category] || 2 * 60 * 1000;

  if (!positionOpenedAt) return { allowed: true, reason: "No position" };

  const holdTime = Date.now() - positionOpenedAt;

  if (holdTime < minHoldMs) {
    // Only allow emergency exit
    return {
      allowed: false,
      emergencyOnly: true,
      reason: `Min hold ${Math.ceil(minHoldMs / 60000)}min not met (${Math.ceil(holdTime / 60000)}min)`,
    };
  }

  state.entryHoldTime = holdTime;
  return { allowed: true, holdTimeMs: holdTime };
}

// B. Candle Close Confirmation - require signal candle to fully close
function checkCandleConfirmation(klines, signal) {
  if (!klines || klines.length < 3) {
    return { confirmed: false, reason: "Insufficient candles" };
  }

  const lastCandle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];

  // Check if last candle is still forming (use volume as proxy)
  // If volume is very low, candle might not be complete
  const avgVolume = klines.slice(-10).reduce((s, k) => s + k.volume, 0) / 10;
  const candleComplete = lastCandle.volume > avgVolume * 0.3;

  if (!candleComplete) {
    return { confirmed: false, reason: "Candle still forming" };
  }

  // Check for displacement - signal must have strong candle
  const bodySize = Math.abs(lastCandle.close - lastCandle.open);
  const rangeSize = lastCandle.high - lastCandle.low;

  if (rangeSize > 0) {
    const bodyRatio = bodySize / rangeSize;
    const signalDirection = signal === "LONG" ? lastCandle.close > lastCandle.open : lastCandle.close < lastCandle.open;

    if (bodyRatio > 0.5 && signalDirection) {
      return { confirmed: true, bodyRatio: Math.round(bodyRatio * 100) / 100 };
    }
  }

  return { confirmed: false, reason: "Weak candle - no clear displacement" };
}

// C. Micro Chop Filter - block entry if market is in micro consolidation
function checkMicroChop(klines) {
  if (!klines || klines.length < 5) return { isChop: false, reason: "Insufficient data" };

  const last5 = klines.slice(-5);
  const range = Math.max(...last5.map(k => k.high)) - Math.min(...last5.map(k => k.low));
  const avgPrice = last5.reduce((s, k) => s + k.close, 0) / 5;
  const rangePct = (range / avgPrice) * 100;

  // Calculate ATR
  let atr = 0;
  if (klines.length >= 14) {
    const recent14 = klines.slice(-14);
    for (let i = 1; i < recent14.length; i++) {
      const tr = Math.max(
        recent14[i].high - recent14[i].low,
        Math.abs(recent14[i].high - recent14[i - 1].close),
        Math.abs(recent14[i].low - recent14[i - 1].close)
      );
      atr += tr;
    }
    atr = (atr / 13) / avgPrice * 100;
  }

  // Micro chop: tight range + low ATR
  const isMicroChop = rangePct < 0.3 && (atr === 0 || atr < 0.4);

  if (isMicroChop) {
    return {
      isChop: true,
      rangePct: Math.round(rangePct * 100) / 100,
      atr: Math.round(atr * 100) / 100,
      reason: `Micro consolidation: range ${rangePct.toFixed(2)}%, ATR ${atr.toFixed(2)}%`,
    };
  }

  return { isChop: false, rangePct: rangePct, atr: atr };
}

// D. Spread/Slippage Protection
async function checkSpread(symbol, price) {
  // Use mock spread data - in production would fetch real spread
  // For now, use category-based thresholds
  const category = getPairCategory(symbol);

  const maxSpreadPct = {
    MAJOR: 0.05, // 0.05% for BTC/ETH
    MID: 0.08, // 0.08% for SOL/BNB
    MEME: 0.15, // 0.15% for PEPE (higher due to wider spread)
  }[category] || 0.1;

  // In production: fetch real spread from orderbook
  // For now, simulate spread check
  // Assume spread is acceptable unless price is extreme
  const mockSpread = category === "MEME" ? 0.12 : category === "MID" ? 0.06 : 0.03;

  if (mockSpread > maxSpreadPct) {
    return {
      acceptable: false,
      spreadPct: mockSpread,
      maxAllowed: maxSpreadPct,
      reason: `Spread ${mockSpread}% > max ${maxSpreadPct}%`,
    };
  }

  return { acceptable: true, spreadPct: mockSpread };
}

// E. Re-entry Cooldown - prevent fast re-entry after SL/scratch
function checkReentryCooldown(symbol, side) {
  const state = initFakeoutState(symbol);
  const now = Date.now();

  // Same pair cooldown
  const minCooldownMs = 10 * 60 * 1000; // 10 min

  if (state.lastExitTime > 0) {
    const timeSinceExit = now - state.lastExitTime;
    if (timeSinceExit < minCooldownMs) {
      const remainMin = Math.ceil((minCooldownMs - timeSinceExit) / 60000);
      return {
        blocked: true,
        reason: `Same pair cooldown: ${remainMin}min remaining`,
        waitMs: minCooldownMs - timeSinceExit,
      };
    }
  }

  // Same direction stricter cooldown
  const directionCooldownMs = 15 * 60 * 1000; // 15 min
  const lastDirection = RECENT_EXITS[symbol]?.direction;
  if (lastDirection === side) {
    const timeSinceDirExit = RECENT_EXITS[symbol]?.time || 0;
    if (now - timeSinceDirExit < directionCooldownMs) {
      return {
        blocked: true,
        reason: `Same direction cooldown active`,
        waitMs: directionCooldownMs - (now - timeSinceDirExit),
      };
    }
  }

  return { blocked: false };
}

function recordExit(symbol, reason, pnl, side) {
  const state = initFakeoutState(symbol);
  state.lastExitTime = Date.now();
  state.lastExitReason = reason;

  // Track for same-direction cooldown
  if (!RECENT_EXITS[symbol]) RECENT_EXITS[symbol] = {};
  RECENT_EXITS[symbol].direction = side;
  RECENT_EXITS[symbol].time = Date.now();

  // Track fast losses
  if (pnl < 0) {
    const holdMs = state.entryHoldTime || 0;
    if (holdMs < 3 * 60 * 1000) {
      state.consecutiveFastLosses++;
    } else {
      state.consecutiveFastLosses = 0;
    }
  }
}

// F. Signal Strength Scoring - only trade A/A+ setups
function scoreSignal(klines, htfBias, smcChecks, momentum, volumeSpike, session) {
  let score = 0;
  const maxScore = 100;
  const reasons = [];

  // HTF alignment (30 pts max)
  if (htfBias === "BULLISH" || htfBias === "BEARISH") {
    score += 30;
    reasons.push("HTF aligned");
  } else {
    reasons.push("HTF not aligned");
  }

  // BOS/CHOCH confirmation (20 pts max)
  if (smcChecks?.structure_break && smcChecks?.choch_confirmed) {
    score += 20;
    reasons.push("BOS+CHoCH confirmed");
  } else if (smcChecks?.structure_break) {
    score += 10;
    reasons.push("BOS confirmed only");
  } else {
    reasons.push("No BOS/CHoCH");
  }

  // Liquidity sweep (15 pts max)
  if (smcChecks?.liquidity_swept) {
    score += 15;
    reasons.push("Liquidity swept");
  }

  // Displacement candle (15 pts max)
  const lastCandle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  if (lastCandle && prevCandle) {
    const currBody = Math.abs(lastCandle.close - lastCandle.open);
    const prevRange = lastCandle.high - lastCandle.low;
    if (currBody / prevRange > 0.6) {
      score += 15;
      reasons.push("Strong displacement");
    }
  }

  // Volume spike (10 pts max)
  if (volumeSpike) {
    score += 10;
    reasons.push("Volume spike");
  }

  // Session quality (10 pts max)
  const goodSessions = ["LONDON", "NY", "OVERLAP"];
  if (goodSessions.includes(session)) {
    score += 10;
    reasons.push(`Good session: ${session}`);
  }

  // Grade assignment
  let grade = "C";
  if (score >= 80) grade = "A+";
  else if (score >= 65) grade = "A";
  else if (score >= 50) grade = "B";

  return { score, grade, reasons: reasons.join(", ") };
}

// Minimum scores by category
function getMinScore(category) {
  return {
    MAJOR: 65, // Allow B+ setups
    MID: 70, // Require A- setups
    MEME: 80, // Only A/A+ for memes
  }[category] || 65;
}

// G. Tick Noise Protection - ignore micro movements
function checkTickNoise(klines) {
  if (!klines || klines.length < 3) return { isNoise: false };

  const last3 = klines.slice(-3);

  // Check for single wick spikes (likely noise)
  const wickSpikes = last3.filter(c => {
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    return (upperWick > body * 2 || lowerWick > body * 2);
  });

  if (wickSpikes.length >= 2) {
    return {
      isNoise: true,
      reason: "Multiple wick spikes detected",
      spikeCount: wickSpikes.length,
    };
  }

  // Check for fake candle breaks (break high/low but close back inside)
  for (let i = 1; i < last3.length; i++) {
    const curr = last3[i];
    const prev = last3[i - 1];

    // Break high but close lower = fake
    if (curr.high > prev.high && curr.close < prev.high) {
      return { isNoise: true, reason: "Fake breakout detected", type: "fake_break" };
    }
    // Break low but close higher = fake
    if (curr.low < prev.low && curr.close > prev.low) {
      return { isNoise: true, reason: "Fake breakdown detected", type: "fake_break" };
    }
  }

  return { isNoise: false };
}

// Main anti-fakeout check
function validateEntry({
  symbol,
  klines,
  signal,
  htfBias,
  smcChecks,
  momentum,
  session,
  positionOpenedAt,
}) {
  const state = initFakeoutState(symbol);
  const category = getPairCategory(symbol);

  const results = {
    allowed: true,
    reasons: [],
    warnings: [],
    score: 0,
    grade: "C",
  };

  // 1. Minimum hold check (for existing position exits)
  if (positionOpenedAt) {
    const holdCheck = checkMinimumHold(symbol, positionOpenedAt);
    if (!holdCheck.allowed && !holdCheck.emergencyOnly) {
      results.allowed = false;
      results.reasons.push(holdCheck.reason);
      return results;
    }
  }

  // 2. Candle confirmation
  const candleCheck = checkCandleConfirmation(klines, signal);
  if (!candleCheck.confirmed) {
    results.reasons.push(candleCheck.reason);
    // Don't block, just warn
    results.warnings.push(candleCheck.reason);
  }

  // 3. Micro chop filter
  const chopCheck = checkMicroChop(klines);
  if (chopCheck.isChop) {
    results.allowed = false;
    results.reasons.push(chopCheck.reason);
    return results;
  }

  // 4. Tick noise protection
  const noiseCheck = checkTickNoise(klines);
  if (noiseCheck.isNoise) {
    results.allowed = false;
    results.reasons.push(noiseCheck.reason);
    return results;
  }

  // 5. Re-entry cooldown
  const cooldownCheck = checkReentryCooldown(symbol, signal);
  if (cooldownCheck.blocked) {
    results.allowed = false;
    results.reasons.push(cooldownCheck.reason);
    return results;
  }

  // 6. Volume spike check for MEME
  if (category === "MEME") {
    const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
    const avgVol = klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0) / 15;
    if (avgVol > 0 && last5Vol / (avgVol * 5) < 1.5) {
      results.allowed = false;
      results.reasons.push("MEME requires 1.5x volume spike");
      return results;
    }
  }

  // 7. Signal strength scoring
  const volSpike = category === "MEME"
    ? true // Already checked above
    : klines.slice(-5).reduce((s, k) => s + k.volume, 0) > klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0) * 1.2;

  const signalScore = scoreSignal(
    klines,
    htfBias,
    smcChecks,
    momentum,
    volSpike,
    session
  );

  results.score = signalScore.score;
  results.grade = signalScore.grade;

  const minScore = getMinScore(category);
  if (signalScore.score < minScore) {
    results.allowed = false;
    results.reasons.push(`Signal score ${signalScore.score} < min ${minScore} (${signalScore.grade})`);
    return results;
  }

  results.reasons.push(signalScore.reasons);

  return results;
}

module.exports = {
  validateEntry,
  checkMinimumHold,
  checkCandleConfirmation,
  checkMicroChop,
  checkReentryCooldown,
  checkTickNoise,
  scoreSignal,
  recordExit,
  getPairCategory,
  PAIR_CATEGORIES,
};