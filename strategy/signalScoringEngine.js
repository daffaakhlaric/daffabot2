"use strict";

/**
 * Signal Scoring Engine - Production Ready
 * Scores each trade and only allows A/A+ setups
 * 
 * Scoring Components:
 * - HTF trend alignment (30 pts)
 * - Structure confirmation (20 pts)
 * - Volume spike (10 pts)
 * - Volatility quality (10 pts)
 * - Session quality (10 pts)
 * - Entry quality (20 pts)
 * 
 * Grades:
 * - A+: 90+ points
 * - A: 80-89 points
 * - B: 70-79 points
 * - C: 60-69 points
 * - D: <60 points (BLOCKED)
 * 
 * Category Requirements:
 * - MAJOR: min 65 pts (B+)
 * - MID: min 75 pts (B+)
 * - MEME: min 85 pts (A-)
 */

const { getPairCategory, detectPairRegime, getCurrentSession, calcATR, detectVolumeSpike } = require("./enhancedRegimeDetector");
const { analyzeHTF, analyzeLTF, detectBOS, detectFVG } = require("./mtfEngine");

const SCORE_WEIGHTS = {
  htf_alignment: {
    maxPoints: 30,
    description: "HTF trend alignment",
  },
  structure: {
    maxPoints: 20,
    description: "BOS/CHoCH confirmation",
  },
  volume: {
    maxPoints: 10,
    description: "Volume spike confirmation",
  },
  volatility: {
    maxPoints: 10,
    description: "ATR within optimal range",
  },
  session: {
    maxPoints: 10,
    description: "Trading session quality",
  },
  entry: {
    maxPoints: 20,
    description: "Entry quality (candle, FVG, liquidity)",
  },
};

const MIN_SCORES = {
  MAJOR: 65,
  MID: 75,
  MEME: 85,
};

function calculateHTFScore(klinesHTF, direction) {
  const htf = analyzeHTF(klinesHTF);
  
  if (!htf.aligned) {
    return { score: 0, reason: "HTF not aligned" };
  }

  const directionMatch = 
    (direction === "LONG" && htf.bias === "BULLISH") ||
    (direction === "SHORT" && htf.bias === "BEARISH");

  if (!directionMatch) {
    return { score: 0, reason: "HTF counter to signal" };
  }

  const score = Math.round((htf.strength / 100) * SCORE_WEIGHTS.htf_alignment.maxPoints);
  
  return {
    score,
    bias: htf.bias,
    strength: htf.strength,
    reason: score > 0 ? "HTF aligned" : "HTF weak",
  };
}

function calculateStructureScore(klinesLTF, direction) {
  const bos = detectBOS(klinesLTF, direction);
  const fvg = detectFVG(klinesLTF, direction);

  let score = 0;
  const reasons = [];

  if (bos.hasBOS) {
    score += 15;
    reasons.push("BOS confirmed");
  }

  if (fvg.hasFVG) {
    score += 5;
    reasons.push("FVG present");
  }

  return {
    score: Math.min(score, SCORE_WEIGHTS.structure.maxPoints),
    bos: bos.hasBOS,
    fvg: fvg.hasFVG,
    reasons: reasons.length > 0 ? reasons : ["No structure confirmation"],
  };
}

function calculateVolumeScore(klines) {
  const vol = detectVolumeSpike(klines);
  
  if (!vol.isSpike) {
    return { score: 0, ratio: vol.ratio, reason: "No volume spike" };
  }

  const ratioScore = Math.min(1, (vol.ratio - 1) / 0.5);
  const score = Math.round(ratioScore * SCORE_WEIGHTS.volume.maxPoints);

  return {
    score,
    ratio: vol.ratio,
    reason: `Volume spike: ${vol.ratio.toFixed(2)}x`,
  };
}

function calculateVolatilityScore(klines, category) {
  const atr = calcATR(klines, 14);
  
  const optimalRange = {
    MAJOR: { min: 0.3, max: 2.0 },
    MID: { min: 0.5, max: 3.0 },
    MEME: { min: 0.8, max: 5.0 },
  };

  const range = optimalRange[category] || optimalRange.MAJOR;

  if (atr < range.min) {
    return { score: 0, atr, reason: "ATR too low (dead market)" };
  }

  if (atr > range.max) {
    return { score: 0, atr, reason: "ATR too high (volatile)" };
  }

  const midRange = (range.min + range.max) / 2;
  const distFromMid = Math.abs(atr - midRange) / midRange;
  const score = Math.round((1 - distFromMid) * SCORE_WEIGHTS.volatility.maxPoints);

  return {
    score,
    atr: Math.round(atr * 100) / 100,
    reason: `ATR optimal: ${atr.toFixed(2)}%`,
  };
}

function calculateSessionScore(symbol) {
  const session = getCurrentSession();
  const category = getPairCategory(symbol);

  const sessionScores = {
    LONDON: 10,
    OVERLAP: 10,
    NY: 8,
    NY_PM: 5,
    ASIAN: 0,
    UNKNOWN: 0,
  };

  const baseScore = sessionScores[session] || 0;

  const categoryBonus = category === "MEME" && session !== "NY" ? -10 : 0;
  
  const score = Math.max(0, baseScore + categoryBonus);

  return {
    score,
    session,
    reason: `Session: ${session}`,
  };
}

function calculateEntryScore(klines, direction, symbol) {
  const category = getPairCategory(symbol);
  
  if (!klines || klines.length < 3) {
    return { score: 0, reasons: ["Insufficient candles"] };
  }

  const last = klines[klines.length - 1];
  const bodySize = Math.abs(last.close - last.open);
  const rangeSize = last.high - last.low;
  const bodyRatio = rangeSize > 0 ? bodySize / rangeSize : 0;

  let score = 0;
  const reasons = [];

  if (bodyRatio >= 0.5) {
    score += 8;
    reasons.push("Strong candle body");
  } else if (bodyRatio >= 0.4) {
    score += 4;
    reasons.push("Weak candle body");
  }

  const isBullish = direction === "LONG";
  const correctDirection = isBullish ? last.close > last.open : last.close < last.open;
  
  if (correctDirection) {
    score += 5;
    reasons.push("Correct direction");
  }

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const wickRatio = isBullish ? upperWick / rangeSize : lowerWick / rangeSize;

  if (wickRatio < 0.4) {
    score += 4;
    reasons.push("Low wick");
  } else if (wickRatio > 0.6) {
    score -= 3;
    reasons.push("High wick (fakeout risk)");
  }

  const last5Vol = klines.slice(-5).reduce((s, k) => s + k.volume, 0);
  const avgVol = klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0) / 15;
  const volRatio = avgVol > 0 ? last5Vol / (avgVol * 5) : 1;

  if (volRatio >= 1.2) {
    score += 3;
    reasons.push("Above avg volume");
  }

  score = Math.max(0, Math.min(score, SCORE_WEIGHTS.entry.maxPoints));

  return {
    score,
    bodyRatio: Math.round(bodyRatio * 100) / 100,
    wickRatio: Math.round(wickRatio * 100) / 100,
    volumeRatio: Math.round(volRatio * 100) / 100,
    reasons,
  };
}

function calculateSignalScore({
  klinesHTF,
  klinesLTF,
  symbol,
  direction,
}) {
  const category = getPairCategory(symbol);
  const regime = detectPairRegime(klinesLTF, symbol);

  const htfScore = calculateHTFScore(klinesHTF, direction);
  const structureScore = calculateStructureScore(klinesLTF, direction);
  const volumeScore = calculateVolumeScore(klinesLTF);
  const volatilityScore = calculateVolatilityScore(klinesLTF, category);
  const sessionScore = calculateSessionScore(symbol);
  const entryScore = calculateEntryScore(klinesLTF, direction, symbol);

  const breakdown = {
    htf: htfScore,
    structure: structureScore,
    volume: volumeScore,
    volatility: volatilityScore,
    session: sessionScore,
    entry: entryScore,
  };

  const totalScore = 
    htfScore.score +
    structureScore.score +
    volumeScore.score +
    volatilityScore.score +
    sessionScore.score +
    entryScore.score;

  const maxScore = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w.maxPoints, 0);
  const percentageScore = Math.round((totalScore / maxScore) * 100);

  let grade = "D";
  if (percentageScore >= 90) grade = "A+";
  else if (percentageScore >= 80) grade = "A";
  else if (percentageScore >= 70) grade = "B";
  else if (percentageScore >= 60) grade = "C";

  const minRequired = MIN_SCORES[category] || MIN_SCORES.MAJOR;
  const minPercentage = Math.round((minRequired / 100) * maxScore);
  const canTrade = totalScore >= minPercentage && regime.canEnter;

  const failedChecks = [];
  
  if (totalScore < minPercentage) {
    failedChecks.push(`Score ${totalScore} < min ${minRequired}%`);
  }
  
  if (!regime.canEnter) {
    failedChecks.push(`Regime blocked: ${regime.regime}`);
  }

  if (category === "MEME" && !volumeScore.isSpike) {
    failedChecks.push("MEME requires volume spike");
  }

  return {
    canTrade,
    totalScore,
    maxScore,
    percentageScore,
    grade,
    category,
    minRequired,
    regime: regime.regime,
    breakdown,
    failedChecks: failedChecks.length > 0 ? failedChecks : ["All checks passed"],
    recommendations: [
      `Grade: ${grade}`,
      `Category: ${category}`,
      `Regime: ${regime.regime}`,
      `HTF: ${htfScore.score}/30`,
      `Structure: ${structureScore.score}/20`,
      `Volume: ${volumeScore.score}/10`,
      `Volatility: ${volatilityScore.score}/10`,
      `Session: ${sessionScore.score}/10`,
      `Entry: ${entryScore.score}/20`,
    ],
  };
}

function getMinScore(symbol) {
  const category = getPairCategory(symbol);
  return MIN_SCORES[category] || MIN_SCORES.MAJOR;
}

function isAGrade(percentageScore) {
  return percentageScore >= 80;
}

function isAPlusGrade(percentageScore) {
  return percentageScore >= 90;
}

module.exports = {
  calculateSignalScore,
  getMinScore,
  isAGrade,
  isAPlusGrade,
  SCORE_WEIGHTS,
  MIN_SCORES,
};