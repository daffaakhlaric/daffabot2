"use strict";

/**
 * Enhanced Session Filter - Production Ready
 * Optimizes trading based on market sessions
 * 
 * Trading Windows:
 * BTC/ETH: London (07:00-11:00 UTC) + NY (13:00-21:00 UTC) = BEST
 * SOL/BNB: NY + Overlap = BEST
 * PEPE/MEME: Only NY (13:00-17:00 UTC) = HIGH VOLUME ONLY
 * 
 * Block:
 * - Low liquidity Asia chop (00:00-06:00 UTC)
 * - Random off-hours
 */

const { getPairCategory, getCurrentSession } = require("./enhancedRegimeDetector");

const SESSION_CONFIG = {
  MAJOR: {
    allowedSessions: ["LONDON", "NY", "OVERLAP"],
    blockedSessions: ["ASIAN"],
    minScore: 60,
    minATR: 0.2,
    requireVolumeSpike: false,
  },
  MID: {
    allowedSessions: ["NY", "OVERLAP"],
    blockedSessions: ["ASIAN", "LONDON"],
    minScore: 65,
    minATR: 0.3,
    requireVolumeSpike: false,
  },
  MEME: {
    allowedSessions: ["NY"],
    blockedSessions: ["ASIAN", "LONDON", "OVERLAP"],
    minScore: 75,
    minATR: 0.5,
    requireVolumeSpike: true,
  },
};

function getEnhancedSession() {
  const utcHour = new Date().getUTCHours();
  const utcMin = new Date().getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;

  if (utcTime >= 0 && utcTime < 6) {
    return {
      session: "ASIAN",
      quality: "POOR",
      reason: "Low liquidity - Asia morning",
      minScoreBoost: 20,
    };
  }

  if (utcTime >= 6 && utcTime < 7) {
    return {
      session: "PRE_LONDON",
      quality: "LOW",
      reason: "Pre-London low liquidity",
      minScoreBoost: 15,
    };
  }

  if (utcTime >= 7 && utcTime < 11) {
    return {
      session: "LONDON",
      quality: "BEST",
      reason: "London session - high liquidity",
      minScoreBoost: 0,
    };
  }

  if (utcTime >= 11 && utcTime < 12) {
    return {
      session: "LUNCH",
      quality: "MEDIUM",
      reason: "London lunch - reduced liquidity",
      minScoreBoost: 10,
    };
  }

  if (utcTime >= 12 && utcTime < 16) {
    return {
      session: "OVERLAP",
      quality: "BEST",
      reason: "London-NY overlap - highest liquidity",
      minScoreBoost: 0,
    };
  }

  if (utcTime >= 16 && utcTime < 21) {
    return {
      session: "NY",
      quality: "BEST",
      reason: "New York session - high liquidity",
      minScoreBoost: 0,
    };
  }

  if (utcTime >= 21 && utcTime < 24) {
    return {
      session: "NY PM",
      quality: "MEDIUM",
      reason: "NY PM - declining liquidity",
      minScoreBoost: 5,
    };
  }

  return {
    session: "UNKNOWN",
    quality: "LOW",
    reason: "Off hours",
    minScoreBoost: 25,
  };
}

function checkSession(symbol, baseScore = 50) {
  const category = getPairCategory(symbol);
  const config = SESSION_CONFIG[category] || SESSION_CONFIG.MAJOR;
  const session = getEnhancedSession();

  const isSessionAllowed = config.allowedSessions.includes(session.session);
  const isSessionBlocked = config.blockedSessions.includes(session.session);

  let adjustedScore = baseScore;
  let adjustedMinScore = config.minScore;

  if (session.minScoreBoost > 0) {
    adjustedMinScore += session.minScoreBoost;
    adjustedScore = baseScore;
  }

  const scorePass = adjustedScore >= adjustedMinScore;

  const canTrade = isSessionAllowed && !isSessionBlocked && scorePass;

  const reasons = [];
  
  if (!isSessionAllowed) {
    reasons.push(`Session ${session.session} not allowed for ${category}`);
  }
  
  if (isSessionBlocked) {
    reasons.push(`Session ${session.session} blocked for ${category}`);
  }
  
  if (!scorePass) {
    reasons.push(`Score ${adjustedScore} < min ${adjustedMinScore}`);
  }

  return {
    canTrade,
    session: session.session,
    quality: session.quality,
    category,
    baseScore,
    adjustedScore,
    minScoreRequired: adjustedMinScore,
    scorePass,
    reasons: reasons.length > 0 ? reasons : ["All checks passed"],
    metadata: {
      utcHour: new Date().getUTCHours(),
      minScoreBoost: session.minScoreBoost,
      requireVolumeSpike: config.requireVolumeSpike,
    },
  };
}

function getSessionMultiplier(category) {
  const session = getEnhancedSession();
  
  const qualityMultipliers = {
    BEST: 1.0,
    MEDIUM: 0.7,
    LOW: 0.4,
    POOR: 0.0,
  };

  const categoryMultipliers = {
    MAJOR: 1.0,
    MID: 0.8,
    MEME: 0.5,
  };

  const qualityMult = qualityMultipliers[session.quality] || 0.5;
  const categoryMult = categoryMultipliers[category] || 0.8;

  return qualityMult * categoryMult;
}

function getSessionInfo() {
  const session = getEnhancedSession();
  const now = new Date();
  
  return {
    session: session.session,
    quality: session.quality,
    reason: session.reason,
    utcHour: now.getUTCHours(),
    utcMin: now.getUTCMinutes(),
    localTime: now.toLocaleTimeString(),
    tradingWindow: getTradingWindow(),
  };
}

function getTradingWindow() {
  const utcHour = new Date().getUTCHours();
  
  if (utcHour >= 7 && utcHour < 11) return "LONDON_OPEN";
  if (utcHour >= 12 && utcHour < 16) return "LONDON_NY_OVERLAP";
  if (utcHour >= 16 && utcHour < 21) return "NY_OPEN";
  if (utcHour >= 0 && utcHour < 6) return "ASIAN_CHOP";
  
  return "OFF_HOURS";
}

function validateSessionEntry(symbol, klines) {
  const category = getPairCategory(symbol);
  const sessionCheck = checkSession(symbol, 50);

  if (!sessionCheck.canTrade) {
    return {
      allowed: false,
      reason: sessionCheck.reasons.join("; "),
      sessionInfo: sessionCheck,
    };
  }

  const last5Vol = klines?.slice(-5)?.reduce((s, k) => s + k.volume, 0) || 0;
  const avgVol = klines?.slice(-20, -5)?.reduce((s, k) => s + k.volume, 0) / 15 || 1;
  const volRatio = avgVol > 0 ? last5Vol / (avgVol * 5) : 1;

  const requireVolumeSpike = SESSION_CONFIG[category]?.requireVolumeSpike || false;
  
  if (requireVolumeSpike && volRatio < 1.5) {
    return {
      allowed: false,
      reason: `MEME requires 1.5x volume spike, got ${volRatio.toFixed(2)}`,
      sessionInfo: sessionCheck,
      volumeRatio: volRatio,
    };
  }

  const multiplier = getSessionMultiplier(category);

  return {
    allowed: true,
    sessionInfo: sessionCheck,
    sizeMultiplier: multiplier,
    volumeRatio: volRatio,
    recommendations: [
      `Session quality: ${sessionCheck.quality}`,
      `Size multiplier: ${multiplier.toFixed(2)}x`,
    ],
  };
}

module.exports = {
  getEnhancedSession,
  checkSession,
  getSessionMultiplier,
  getSessionInfo,
  getTradingWindow,
  validateSessionEntry,
  SESSION_CONFIG,
};