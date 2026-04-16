"use strict";

/**
 * Pair-Specific TP & Exit Manager
 * Fix: too many small wins / quick stopouts
 * 
 * TP Strategy:
 * - 50% at 1R (partial)
 * - 30% at 1.5R (partial)
 * - Runner to 2.5-3R
 * - Break even after +0.8R
 * - Trail only after structure confirmation
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

function getTPConfig(symbol) {
  const category = getPairCategory(symbol);

  const configs = {
    MAJOR: {
      tp1Percent: 0.5, // 0.5R
      tp1Size: 50, // 50%
      tp2Percent: 1.0, // 1R
      tp2Size: 30, // 30%
      runnerTarget: 2.5, // 2.5R
      breakEvenPercent: 0.6, // Move to BE at +0.6R
      trailActivate: 1.2, // Trail starts at +1.2R
      trailDrop: 0.4, // Trail drops 0.4%
      minHoldMinutes: 2,
    },
    MID: {
      tp1Percent: 0.6,
      tp1Size: 50,
      tp2Percent: 1.2,
      tp2Size: 30,
      runnerTarget: 2.0,
      breakEvenPercent: 0.7,
      trailActivate: 1.5,
      trailDrop: 0.5,
      minHoldMinutes: 2.5,
    },
    MEME: {
      tp1Percent: 0.8, // Wider for memes
      tp1Size: 40, // Smaller first TP
      tp2Percent: 1.5,
      tp2Size: 30,
      runnerTarget: 3.0, // Let runner ride
      breakEvenPercent: 1.0, // Wait longer for BE
      trailActivate: 2.0,
      trailDrop: 0.6,
      minHoldMinutes: 3,
    },
  };

  return configs[category] || configs.MID;
}

function shouldTakeTP(position, currentPrice, entryPrice, side) {
  const config = getTPConfig(position.symbol);
  const risk = Math.abs(entryPrice - position.slPrice);
  const currentR = side === "LONG"
    ? (currentPrice - entryPrice) / risk
    : (entryPrice - currentPrice) / risk;

  const result = {
    action: "HOLD",
    reason: "No TP triggered",
    tpLevel: null,
    partialClose: 0,
    newSL: null,
  };

  // TP1: 50% at configured R
  if (!position.tp1Done && currentR >= config.tp1Percent) {
    result.action = "PARTIAL_CLOSE";
    result.tpLevel = "TP1";
    result.partialClose = config.tp1Size;
    result.reason = `TP1 hit at ${currentR.toFixed(2)}R (${config.tp1Size}% closed)`;

    // Move SL to break even
    result.newSL = entryPrice;
    return result;
  }

  // TP2: 30% at configured R
  if (!position.tp2Done && position.tp1Done && currentR >= config.tp2Percent) {
    result.action = "PARTIAL_CLOSE";
    result.tpLevel = "TP2";
    result.partialClose = config.tp2Size;
    result.reason = `TP2 hit at ${currentR.toFixed(2)}R (${config.tp2Size}% closed)`;
    return result;
  }

  // Runner: close remaining at target
  if (position.tp2Done && currentR >= config.runnerTarget) {
    result.action = "CLOSE";
    result.tpLevel = "RUNNER";
    result.reason = `Runner target hit at ${currentR.toFixed(2)}R`;
    return result;
  }

  return result;
}

function shouldMoveToBreakEven(position, currentPrice, entryPrice, side) {
  const config = getTPConfig(position.symbol);
  const risk = Math.abs(entryPrice - position.slPrice);
  const currentR = side === "LONG"
    ? (currentPrice - entryPrice) / risk
    : (entryPrice - currentPrice) / risk;

  // Only move to BE if TP1 not done yet and we've hit the threshold
  if (!position.tp1Done && currentR >= config.breakEvenPercent) {
    return {
      shouldMove: true,
      newSL: entryPrice,
      reason: `Break even at ${currentR.toFixed(2)}R`,
    };
  }

  return { shouldMove: false };
}

function shouldActivateTrail(position, currentPrice, entryPrice, side) {
  const config = getTPConfig(position.symbol);
  const risk = Math.abs(entryPrice - position.slPrice);
  const currentR = side === "LONG"
    ? (currentPrice - entryPrice) / risk
    : (entryPrice - currentPrice) / risk;

  // Trail only after TP1 and above threshold
  if (position.tp1Done && currentR >= config.trailActivate) {
    const trailDistance = currentR - config.trailDrop;

    if (trailDistance > 0) {
      const newSL = side === "LONG"
        ? entryPrice + (risk * trailDistance)
        : entryPrice - (risk * trailDistance);

      return {
        shouldTrail: true,
        newSL: newSL,
        reason: `Trail activated at ${currentR.toFixed(2)}R`,
      };
    }
  }

  return { shouldTrail: false };
}

function getMaxHoldTime(symbol, setup) {
  const config = getTPConfig(symbol);
  const baseMs = config.minHoldMinutes * 60 * 1000;

  // Adjust by setup type
  if (setup?.includes("SNIPER")) return baseMs * 1.5;
  if (setup?.includes("ULTRA")) return baseMs * 0.75;
  if (setup?.includes("JUDAS")) return baseMs * 2;

  return baseMs;
}

function shouldForceClose(position, currentPrice, entryPrice, side, openedAt) {
  const config = getTPConfig(position.symbol);
  const holdMs = Date.now() - openedAt;
  const minHoldMs = config.minHoldMinutes * 60 * 1000;

  const risk = Math.abs(entryPrice - position.slPrice);
  const currentR = side === "LONG"
    ? (currentPrice - entryPrice) / risk
    : (entryPrice - currentPrice) / risk;

  // Minimum hold time check - don't force close before min hold
  if (holdMs < minHoldMs) {
    return { shouldClose: false, reason: "Below min hold time" };
  }

  // Timeout with no profit - force close
  const maxHoldMs = getMaxHoldTime(position.symbol, position.setup);
  if (holdMs > maxHoldMs && currentR <= 0) {
    return {
      shouldClose: true,
      reason: `Timeout: held ${Math.round(holdMs / 60000)}min with no profit`,
    };
  }

  // Still in profit but held too long - move to BE and let run
  if (holdMs > maxHoldMs && currentR > 0) {
    return {
      shouldClose: false,
      shouldMoveToBE: true,
      reason: `Profit but timeout - move to BE`,
    };
  }

  return { shouldClose: false };
}

module.exports = {
  getTPConfig,
  shouldTakeTP,
  shouldMoveToBreakEven,
  shouldActivateTrail,
  getMaxHoldTime,
  shouldForceClose,
  getPairCategory,
  PAIR_CATEGORIES,
};