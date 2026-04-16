"use strict";

/**
 * SESSION FILTER — Time-based entry quality control
 * Reduces false breakouts during low-liquidity sessions
 *
 * WIB Timezone (UTC+7):
 * - London Open: 14:00-18:00 WIB (07:00-11:00 UTC) → BEST
 * - New York Open: 20:00-00:00 WIB (13:00-17:00 UTC) → BEST
 * - Asia Morning: 07:00-11:00 WIB (00:00-04:00 UTC) → Only A+ setups
 * - Off Hours: Everything else → HOLD
 */

const { getSessionByUTCHour } = require("../utils/time");

/**
 * Get current session with detailed info
 * @returns {Object} { session, quality, minScore, whaleMustConfirm, allowedSetups }
 */
function getCurrentSession() {
  const utcNow = new Date().getUTCHours();

  // London Open: 07:00-11:00 UTC
  if (utcNow >= 7 && utcNow < 11) {
    return {
      session: "LONDON_OPEN",
      utcRange: "07:00-11:00",
      wibRange: "14:00-18:00",
      quality: "BEST",
      minScore: 60,  // Normal mode
      whaleMustConfirm: false,
      allowedSetups: ["LONG", "SHORT"],
      volatility: "HIGH",
      liquidity: "HIGH",
      blocked: false,
      reason: "London session — prime trading time"
    };
  }

  // New York Open: 13:00-17:00 UTC
  if (utcNow >= 13 && utcNow < 17) {
    return {
      session: "NY_OPEN",
      utcRange: "13:00-17:00",
      wibRange: "20:00-00:00",
      quality: "BEST",
      minScore: 60,  // Normal mode
      whaleMustConfirm: false,
      allowedSetups: ["LONG", "SHORT"],
      volatility: "HIGH",
      liquidity: "HIGH",
      blocked: false,
      reason: "New York session — prime trading time"
    };
  }

  // Asia Morning: 00:00-04:00 UTC
  if (utcNow >= 0 && utcNow < 4) {
    return {
      session: "ASIA_MORNING",
      utcRange: "00:00-04:00",
      wibRange: "07:00-11:00",
      quality: "POOR",
      minScore: 80,  // Require A+ setups
      whaleMustConfirm: true,
      allowedSetups: [],  // No setups allowed
      volatility: "LOW",
      liquidity: "LOW",
      blocked: true,  // ⭐ BLOCKED — Asia session disabled
      reason: "Asia morning — BLOCKED (low liquidity, poor trade quality)"
    };
  }

  // Off Hours: Everything else
  return {
    session: "OFF_HOURS",
    utcRange: "other",
    wibRange: "other",
    quality: "POOR",
    minScore: 85,  // Very strict
    whaleMustConfirm: true,
    allowedSetups: ["SNIPER"],  // Only sniper
    volatility: "UNKNOWN",
    liquidity: "UNKNOWN",
    blocked: true,
    reason: "Off hours — restricted trading, score >= 85 + HTF clear required"
  };
}

/**
 * Check if session allows entry
 * @param {Object} params - { score, setupType, htfClear, whaleDetected, atrHigh, volumeHigh }
 * @returns {Object} { approved, reason, minScore }
 */
function checkSessionFilter(params = {}) {
  const {
    score = 0,
    setupType = "SAFE",
    htfClear = false,
    whaleDetected = false,
    atrHigh = false,
    volumeHigh = false
  } = params;

  const session = getCurrentSession();
  const blocks = [];
  let approved = true;

  // 1. Check minimum score for session
  if (score < session.minScore) {
    approved = false;
    blocks.push(`Score ${score} < session min ${session.minScore}`);
  }

  // 2. Asia: require whale confirmation
  if (session.session === "ASIA_MORNING" && !whaleDetected) {
    approved = false;
    blocks.push("Asia session: whale confirmation required");
  }

  // 3. Off-hours: require HTF clear + high score
  if (session.session === "OFF_HOURS") {
    if (!htfClear) {
      approved = false;
      blocks.push("Off-hours: HTF must be clear");
    }
    if (score < 85) {
      approved = false;
      blocks.push("Off-hours: score must be >= 85");
    }
  }

  // 4. Anti-fake breakout: skip if ATR low OR volume low
  if (!atrHigh || !volumeHigh) {
    approved = false;
    blocks.push("Anti-fake breakout: ATR or volume too low");
  }

  // 5. Setup type check for session
  if (!session.allowedSetups.includes(setupType)) {
    if (session.session === "ASIA_MORNING" || session.session === "OFF_HOURS") {
      approved = false;
      blocks.push(`Setup ${setupType} not allowed in ${session.session}`);
    }
  }

  return {
    approved,
    session: session.session,
    sessionQuality: session.quality,
    minScore: session.minScore,
    currentScore: score,
    blocks: blocks.length > 0 ? blocks : null,
    details: session,
    reason: approved ? "Session OK" : blocks[0]
  };
}

/**
 * Get session quality multiplier for position sizing
 * @returns {number} 1.0 = normal, 0.5 = reduced, 0.0 = no trade
 */
function getSessionQualityMultiplier() {
  const session = getCurrentSession();

  if (session.quality === "BEST") return 1.0;
  if (session.quality === "POOR") return 0.5;
  return 0.75;
}

/**
 * Format session info for display
 * @returns {string}
 */
function getSessionStatus() {
  const session = getCurrentSession();
  return `${session.session} (${session.wibRange} WIB) - Quality: ${session.quality}`;
}

module.exports = {
  getCurrentSession,
  checkSessionFilter,
  getSessionQualityMultiplier,
  getSessionStatus,
};
