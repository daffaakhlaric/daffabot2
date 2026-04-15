"use strict";

/**
 * UNIFIED SESSION-BASED SCORE THRESHOLDS
 * Dynamically adjust minimum entry quality score based on trading session
 * ⭐ FIXED: Eliminates conflict between entryProtocol (hardcoded 65) and sessionFilter (85 for Asia)
 */

/**
 * Get minimum entry score required for a given session
 * @param {string} sessionName - Session name (LONDON, NEW_YORK, ASIA_MORNING, ASIA_EVENING, OFF_HOURS)
 * @returns {number} Minimum required score (0-100)
 */
function getMinScoreForSession(sessionName) {
  const thresholds = {
    // LONDON: 14:00-18:00 WIB (07:00-11:00 UTC) — Best liquidity, trending environment
    LONDON: 70,
    LONDON_OPEN: 70,

    // NEW_YORK: 20:00-00:00 WIB (12:00-16:00 UTC) — Good liquidity, potential volatility
    NEW_YORK: 70,
    NY_OPEN: 70,
    NEW_YORK_CLOSE: 75,

    // ASIA MORNING: 07:00-11:00 WIB (22:00-02:00 UTC prev day) — Low liquidity, choppy
    ASIA_MORNING: 85, // Very strict: only pristine setups

    // ASIA EVENING: 11:00-14:00 WIB (02:00-07:00 UTC) — Transitional, improving liquidity
    ASIA_EVENING: 80, // Moderately strict

    // OFF_HOURS: Outside major sessions
    OFF_HOURS: 85, // Very strict: only perfect setups

    // Fallback
    UNKNOWN: 75,
  };

  return thresholds[sessionName] || thresholds.UNKNOWN;
}

/**
 * Get dynamic score thresholds based on volatility regime
 * High volatility = slightly relaxed score, Low volatility = stricter score
 * @param {string} volatilityRegime - LOW_ATR | NORMAL | HIGH_ATR
 * @param {string} sessionName - Current session
 * @returns {Object} { min: number, recommended: number, strict: number }
 */
function getScoreThresholdsForVolatility(volatilityRegime, sessionName = "UNKNOWN") {
  const baseScore = getMinScoreForSession(sessionName);

  const thresholds = {
    LOW_ATR: {
      // Choppy market: requires higher quality (0% more strict)
      min: baseScore + 5,
      recommended: baseScore + 10,
      strict: 85,
    },
    NORMAL: {
      // Normal market: baseline thresholds
      min: baseScore,
      recommended: baseScore + 5,
      strict: 80,
    },
    HIGH_ATR: {
      // Trending market: can be slightly more relaxed (trending = more reliable)
      min: Math.max(60, baseScore - 5),
      recommended: baseScore,
      strict: 75,
    },
  };

  return thresholds[volatilityRegime] || thresholds.NORMAL;
}

/**
 * Get quality score requirements for different bot modes
 * @param {string} mode - SAFE | SNIPER | TREND
 * @param {string} sessionName - Current session
 * @returns {Object} { min: number, recommended: number, strict: number }
 */
function getScoreThresholdsForMode(mode = "SAFE", sessionName = "UNKNOWN") {
  const baseScore = getMinScoreForSession(sessionName);

  const thresholds = {
    SAFE: {
      // Conservative mode: high quality threshold
      min: baseScore,
      recommended: baseScore + 5,
      strict: 80,
    },
    SNIPER: {
      // Aggressive mode: lower quality acceptable if confluence strong
      min: Math.max(60, baseScore - 10),
      recommended: baseScore,
      strict: 75,
    },
    TREND: {
      // Trend-following mode: moderate quality
      min: baseScore - 5,
      recommended: baseScore,
      strict: 78,
    },
  };

  return thresholds[mode] || thresholds.SAFE;
}

/**
 * Determine if an entry should be approved based on score and conditions
 * @param {Object} params - { score, session, volatility, mode, isAfterWin, consecutiveLosses }
 * @returns {Object} { approved: boolean, minRequired: number, message: string }
 */
function shouldApproveEntry({
  score = 0,
  session = "UNKNOWN",
  volatility = "NORMAL",
  mode = "SAFE",
  isAfterWin = false,
  consecutiveLosses = 0,
}) {
  const baseMin = getMinScoreForSession(session);

  let minRequired = baseMin;
  let message = "";

  // After a win: slightly stricter (avoid euphoria)
  if (isAfterWin) {
    minRequired += 5;
    message += "Post-win discipline +5pts; ";
  }

  // After consecutive losses: stricter (avoid revenge trading)
  if (consecutiveLosses >= 2) {
    minRequired += 10;
    message += `After ${consecutiveLosses} losses +10pts; `;
  } else if (consecutiveLosses === 1) {
    minRequired += 5;
    message += "After 1 loss +5pts; ";
  }

  // Apply mode-based adjustments
  const modeThresholds = getScoreThresholdsForMode(mode, session);
  minRequired = Math.max(minRequired, modeThresholds.min);

  const approved = score >= minRequired;

  if (!approved) {
    message += `Score ${score} < required ${minRequired}`;
  } else {
    message = `✅ Approved (score ${score} >= ${minRequired})`;
  }

  return {
    approved,
    minRequired,
    score,
    message,
    session,
    mode,
  };
}

/**
 * Get adaptive score boost for win streaks
 * After 2+ wins: increase quality tolerance slightly (trend is strong)
 * @param {number} winStreak - Number of consecutive wins
 * @returns {number} Score bonus (negative to reduce threshold, positive to increase it)
 */
function getWinStreakBonus(winStreak = 0) {
  if (winStreak >= 3) return -10; // 3 wins: can do 10pts lower quality
  if (winStreak === 2) return -5;  // 2 wins: can do 5pts lower quality
  if (winStreak === 1) return 5;   // 1 win: be 5pts stricter (avoid revenge)
  return 0; // No win streak: neutral
}

/**
 * Get penalty for loss streaks
 * @param {number} lossStreak - Number of consecutive losses
 * @returns {number} Score penalty (positive = stricter requirement)
 */
function getLossStreakPenalty(lossStreak = 0) {
  if (lossStreak >= 3) return 20; // Very strict after multiple losses
  if (lossStreak === 2) return 10;
  if (lossStreak === 1) return 5;
  return 0;
}

module.exports = {
  getMinScoreForSession,
  getScoreThresholdsForVolatility,
  getScoreThresholdsForMode,
  shouldApproveEntry,
  getWinStreakBonus,
  getLossStreakPenalty,
};
