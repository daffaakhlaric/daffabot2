"use strict";

/**
 * Multi-Level TP Calculator
 * Ensures consistent take-profit targets across all entries
 * Default levels: 1.5%, 2.5%, 4.0%
 */

/**
 * Calculate multi-level TP prices from entry and direction
 * @param {number} entry - Entry price
 * @param {string} direction - "LONG" or "SHORT"
 * @param {Object} config - { tp1_pct, tp2_pct, tp3_pct }
 * @returns {Object} { tp1, tp2, tp3 }
 */
function calculateMultiLevelTP(entry, direction, config = {}) {
  const tp1Pct = config.tp1_pct ?? 1.5;   // 1.5% profit
  const tp2Pct = config.tp2_pct ?? 2.5;   // 2.5% profit
  const tp3Pct = config.tp3_pct ?? 4.0;   // 4.0% profit

  if (!entry || entry <= 0) {
    return { tp1: null, tp2: null, tp3: null };
  }

  if (direction === "LONG") {
    return {
      tp1: entry * (1 + tp1Pct / 100),
      tp2: entry * (1 + tp2Pct / 100),
      tp3: entry * (1 + tp3Pct / 100),
    };
  } else if (direction === "SHORT") {
    return {
      tp1: entry * (1 - tp1Pct / 100),
      tp2: entry * (1 - tp2Pct / 100),
      tp3: entry * (1 - tp3Pct / 100),
    };
  }

  return { tp1: null, tp2: null, tp3: null };
}

/**
 * Ensure position has valid TP prices (use defaults if missing)
 */
function ensureTPLevels(position, direction) {
  if (!position) return null;

  // If TPs already set, verify they're valid
  if (position.tp1Price && position.tp2Price && position.tp3Price) {
    return position; // Already has TPs
  }

  // Calculate missing TPs using defaults
  const entry = position.entry || position.price;
  if (!entry || entry <= 0) return position;

  const { tp1, tp2, tp3 } = calculateMultiLevelTP(entry, direction);

  return {
    ...position,
    tp1Price: position.tp1Price || tp1,
    tp2Price: position.tp2Price || tp2,
    tp3Price: position.tp3Price || tp3,
  };
}

/**
 * Calculate partial close percentages (40%, 30%, 30%)
 * @returns {{ tp1_close: 40, tp2_close: 30, tp3_close: 30 }}
 */
function getPartialClosePercentages() {
  return {
    tp1_close_pct: 40,  // Close 40% at TP1
    tp2_close_pct: 30,  // Close 30% at TP2
    tp3_close_pct: 30,  // Close remaining 30% at TP3
  };
}

/**
 * Validate TP levels are correctly ordered
 */
function validateTPOrder(tp1, tp2, tp3, direction) {
  if (direction === "LONG") {
    return tp1 < tp2 && tp2 < tp3;
  } else if (direction === "SHORT") {
    return tp1 > tp2 && tp2 > tp3;
  }
  return false;
}

/**
 * Calculate risk:reward for multi-level TPs
 */
function calculateMultiLevelRR(entry, sl, tp1, tp2, tp3, direction, fee = 0.05) {
  const risk = Math.abs(entry - sl) * (1 + fee / 100);

  const reward1 = Math.abs(tp1 - entry) * (1 - fee / 100);
  const reward2 = Math.abs(tp2 - entry) * (1 - fee / 100);
  const reward3 = Math.abs(tp3 - entry) * (1 - fee / 100);

  // Weighted average assuming: 40% close at TP1, 30% at TP2, 30% at TP3
  const avgReward = (reward1 * 0.4 + reward2 * 0.3 + reward3 * 0.3) / (1 - fee / 100);

  return {
    rr_tp1: risk > 0 ? (reward1 / risk).toFixed(2) : 0,
    rr_tp2: risk > 0 ? (reward2 / risk).toFixed(2) : 0,
    rr_tp3: risk > 0 ? (reward3 / risk).toFixed(2) : 0,
    rr_weighted: risk > 0 ? (avgReward / risk).toFixed(2) : 0,
  };
}

module.exports = {
  calculateMultiLevelTP,
  ensureTPLevels,
  getPartialClosePercentages,
  validateTPOrder,
  calculateMultiLevelRR,
};
