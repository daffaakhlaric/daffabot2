"use strict";

/**
 * PAIR ROTATION — Automatic pair switching based on loss streaks
 * After 1 loss: Scan for better pairs
 * After 2 consecutive losses: MANDATORY switch
 *
 * Goal: Prevent stuck trades on bad pairs (like 7 straight losses on BTCUSDT)
 */

/**
 * Calculate pair score based on recent performance
 * @param {Array} tradeHistory - All trades
 * @param {string} pair - Pair to evaluate
 * @returns {Object} { pair, score, reason, recentTrades, winRate }
 */
function calculatePairScore(tradeHistory = [], pair = "BTCUSDT") {
  if (!tradeHistory || tradeHistory.length === 0) {
    return {
      pair,
      score: 50,  // Neutral for untraded pairs
      reason: "No history",
      recentTrades: 0,
      winRate: 0,
    };
  }

  // Get last 10 trades on this pair
  const pairTrades = tradeHistory
    .filter(t => t.symbol === pair)
    .slice(-10);

  if (pairTrades.length === 0) {
    return {
      pair,
      score: 60,  // Slightly positive for untested pairs (fresh start)
      reason: "No trades on this pair",
      recentTrades: 0,
      winRate: 0,
    };
  }

  // Calculate win rate
  const wins = pairTrades.filter(t => t.pnlPercent > 0).length;
  const winRate = (wins / pairTrades.length) * 100;

  // Score formula: 50 + (winRate - 50) + extra for recent performance
  const baseScore = 50 + (winRate - 50);

  // Bonus if last trade was win, penalty if loss
  let bonus = 0;
  if (pairTrades.length > 0) {
    const lastTrade = pairTrades[pairTrades.length - 1];
    if (lastTrade.pnlPercent > 0) bonus = 10;
    else bonus = -20;
  }

  const score = Math.max(0, Math.min(100, baseScore + bonus));

  return {
    pair,
    score: score.toFixed(1),
    reason: `${wins}/${pairTrades.length} wins (${winRate.toFixed(1)}%)`,
    recentTrades: pairTrades.length,
    winRate: winRate.toFixed(1),
  };
}

/**
 * Get consecutive losses on current pair
 * @param {Array} tradeHistory - All trades
 * @param {string} currentPair - Current trading pair
 * @returns {number} Consecutive losses (0 if last trade was win)
 */
function getConsecutiveLossesOnPair(tradeHistory = [], currentPair = "BTCUSDT") {
  if (!tradeHistory || tradeHistory.length === 0) return 0;

  let losses = 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    const trade = tradeHistory[i];

    // Stop counting when we hit a different pair
    if (trade.symbol !== currentPair) break;

    // Count losses
    if (trade.pnlPercent < 0) {
      losses++;
    } else {
      break;  // Stop at first win
    }
  }

  return losses;
}

/**
 * Scan all pairs and find best setup
 * @param {Array} enabledPairs - List of trading pairs
 * @param {Array} tradeHistory - All trades
 * @returns {Object} { bestPair, bestScore, allScores, recommendation }
 */
function scanAllPairs(enabledPairs = [], tradeHistory = []) {
  if (!enabledPairs || enabledPairs.length === 0) {
    return {
      bestPair: null,
      bestScore: 0,
      allScores: [],
      recommendation: "No pairs enabled",
    };
  }

  // Score all pairs
  const scores = enabledPairs
    .map(pair => calculatePairScore(tradeHistory, pair))
    .sort((a, b) => parseFloat(b.score) - parseFloat(a.score));

  const bestPair = scores[0]?.pair;
  const bestScore = scores[0]?.score;

  return {
    bestPair,
    bestScore,
    allScores: scores,
    recommendation: scores.length > 0
      ? `Switch to ${bestPair} (score ${bestScore})`
      : "No recommendation",
  };
}

/**
 * Check if pair rotation is needed
 * @param {Object} params - { currentPair, tradeHistory, enabledPairs }
 * @returns {Object} { rotate, lossStreak, newPair, reason }
 */
function checkPairRotation(params = {}) {
  const {
    currentPair = "BTCUSDT",
    tradeHistory = [],
    enabledPairs = ["BTCUSDT"],
  } = params;

  // Get consecutive losses on current pair
  const lossStreak = getConsecutiveLossesOnPair(tradeHistory, currentPair);

  // After 2 consecutive losses: MANDATORY switch
  if (lossStreak >= 2) {
    const scan = scanAllPairs(enabledPairs, tradeHistory);
    return {
      rotate: true,
      mandatory: true,
      lossStreak,
      currentPair,
      newPair: scan.bestPair,
      newScore: scan.bestScore,
      reason: `${lossStreak} consecutive losses on ${currentPair}: MANDATORY switch to ${scan.bestPair}`,
    };
  }

  // After 1 loss: SCAN and switch if significant improvement
  if (lossStreak === 1) {
    const scan = scanAllPairs(enabledPairs, tradeHistory);
    const currentScore = calculatePairScore(tradeHistory, currentPair);
    const improvement = parseFloat(scan.bestScore) - parseFloat(currentScore.score);

    // Switch if new pair is significantly better (>15 points)
    if (improvement > 15 && scan.bestPair !== currentPair) {
      return {
        rotate: true,
        mandatory: false,
        lossStreak,
        currentPair,
        newPair: scan.bestPair,
        currentScore: currentScore.score,
        newScore: scan.bestScore,
        improvement: improvement.toFixed(1),
        reason: `1 loss on ${currentPair}: Better pair found (${scan.bestPair}, +${improvement.toFixed(1)} score)`,
      };
    }

    // No rotation but flag for monitoring
    return {
      rotate: false,
      mandatory: false,
      lossStreak,
      currentPair,
      reason: `1 loss on ${currentPair}: Monitoring, no better pair yet`,
    };
  }

  // No losses: Stay on current pair
  return {
    rotate: false,
    mandatory: false,
    lossStreak: 0,
    currentPair,
    reason: `${currentPair}: Winning or first trade, hold position`,
  };
}

/**
 * Get pair rotation status for dashboard
 * @returns {Object}
 */
function getPairRotationStatus(currentPair = "BTCUSDT", tradeHistory = []) {
  const lossStreak = getConsecutiveLossesOnPair(tradeHistory, currentPair);
  const pairScore = calculatePairScore(tradeHistory, currentPair);

  return {
    currentPair,
    lossStreak,
    pairScore: pairScore.score,
    winRate: pairScore.winRate,
    recentTrades: pairScore.recentTrades,
    status: lossStreak >= 2 ? "🔴 SWITCH REQUIRED" : lossStreak === 1 ? "🟡 MONITORING" : "🟢 HOLDING",
  };
}

module.exports = {
  calculatePairScore,
  getConsecutiveLossesOnPair,
  scanAllPairs,
  checkPairRotation,
  getPairRotationStatus,
};
