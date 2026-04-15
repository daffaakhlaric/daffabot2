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
 * Check if a pair has sufficient liquidity (5m volume check)
 * ⭐ NEW: Prevents switching to dormant pairs
 * @param {string} pair - Trading pair
 * @param {Array} klines_5m - Recent 5m candles for pair
 * @param {number} minVolume - Minimum volume threshold
 * @returns {Object} { hasLiquidity, volume, reason }
 */
function checkPairLiquidity(pair = "BTCUSDT", klines_5m = [], minVolume = 100000) {
  try {
    if (!klines_5m || klines_5m.length < 5) {
      return { hasLiquidity: false, volume: 0, reason: "Insufficient kline data" };
    }

    // Get average volume from last 5 candles
    const recentVolumes = klines_5m.slice(-5).map(k => parseFloat(k.quote_asset_volume || k.volume || 0));
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

    const hasLiquidity = avgVolume >= minVolume;
    return {
      hasLiquidity,
      volume: avgVolume,
      reason: hasLiquidity ? `Good liquidity: ${avgVolume.toFixed(0)}` : `Low liquidity: ${avgVolume.toFixed(0)} < ${minVolume}`,
    };
  } catch {
    return { hasLiquidity: false, volume: 0, reason: "Volume check failed" };
  }
}

/**
 * Scan all pairs and find best setup
 * ⭐ FIXED: Now checks liquidity before recommending switch
 * @param {Array} enabledPairs - List of trading pairs
 * @param {Array} tradeHistory - All trades
 * @param {Object} klinesByPair - { pairSymbol: klines_5m[] }
 * @returns {Object} { bestPair, bestScore, allScores, recommendation }
 */
function scanAllPairs(enabledPairs = [], tradeHistory = [], klinesByPair = {}) {
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
    .map(pair => {
      const scoreData = calculatePairScore(tradeHistory, pair);
      // Check liquidity
      const klines = klinesByPair[pair] || [];
      const liquidityCheck = checkPairLiquidity(pair, klines, 100000);
      return {
        ...scoreData,
        hasLiquidity: liquidityCheck.hasLiquidity,
        liquidity: liquidityCheck.volume,
        liquidityReason: liquidityCheck.reason,
      };
    })
    // ⭐ FIXED: Prioritize pairs with good liquidity, then by score
    .sort((a, b) => {
      // Prefer liquid pairs first
      if (a.hasLiquidity !== b.hasLiquidity) {
        return a.hasLiquidity ? -1 : 1;
      }
      // Then by score
      return parseFloat(b.score) - parseFloat(a.score);
    });

  const bestPair = scores[0]?.pair;
  const bestScore = scores[0]?.score;

  return {
    bestPair,
    bestScore,
    allScores: scores,
    recommendation: scores.length > 0
      ? `Switch to ${bestPair} (score ${bestScore}, ${scores[0]?.liquidityReason || ""})`
      : "No recommendation",
  };
}

/**
 * Check if pair rotation is needed
 * ⭐ FIXED: Adjusted thresholds (2 losses scan, 3 mandatory; 20+ pts improvement)
 * @param {Object} params - { currentPair, tradeHistory, enabledPairs, klinesByPair }
 * @returns {Object} { rotate, lossStreak, newPair, reason }
 */
function checkPairRotation(params = {}) {
  const {
    currentPair = "BTCUSDT",
    tradeHistory = [],
    enabledPairs = ["BTCUSDT"],
    klinesByPair = {},  // ⭐ NEW: For liquidity checks
  } = params;

  // Get consecutive losses on current pair
  const lossStreak = getConsecutiveLossesOnPair(tradeHistory, currentPair);

  // After 3+ consecutive losses: MANDATORY switch
  if (lossStreak >= 3) {
    const scan = scanAllPairs(enabledPairs, tradeHistory, klinesByPair);
    return {
      rotate: true,
      mandatory: true,
      lossStreak,
      currentPair,
      newPair: scan.bestPair,
      newScore: scan.bestScore,
      reason: `⚠️ ${lossStreak} CONSECUTIVE LOSSES on ${currentPair}: MANDATORY switch to ${scan.bestPair} (ACTIVATE CIRCUIT BREAKER)`,
    };
  }

  // After 2 consecutive losses: SCAN and switch if >20 pt improvement
  if (lossStreak === 2) {
    const scan = scanAllPairs(enabledPairs, tradeHistory, klinesByPair);
    const currentScore = calculatePairScore(tradeHistory, currentPair);
    const improvement = parseFloat(scan.bestScore) - parseFloat(currentScore.score);

    // ⭐ FIXED: Require >20 points improvement (was 15, too loose)
    if (improvement > 20 && scan.bestPair !== currentPair) {
      return {
        rotate: true,
        mandatory: false,
        lossStreak,
        currentPair,
        newPair: scan.bestPair,
        currentScore: currentScore.score,
        newScore: scan.bestScore,
        improvement: improvement.toFixed(1),
        reason: `2 consecutive losses on ${currentPair}: Better pair found (${scan.bestPair}, +${improvement.toFixed(1)} score)`,
      };
    }

    // No rotation but flag for monitoring
    return {
      rotate: false,
      mandatory: false,
      lossStreak,
      currentPair,
      reason: `2 losses on ${currentPair}: No significantly better pair found (need >20pt improvement)`,
    };
  }

  // After 1 loss: Just monitor, don't switch
  if (lossStreak === 1) {
    const scan = scanAllPairs(enabledPairs, tradeHistory, klinesByPair);
    const currentScore = calculatePairScore(tradeHistory, currentPair);
    const improvement = parseFloat(scan.bestScore) - parseFloat(currentScore.score);

    return {
      rotate: false,
      mandatory: false,
      lossStreak,
      currentPair,
      bestAlternative: scan.bestPair,
      bestAlternativeScore: scan.bestScore,
      improvement: improvement.toFixed(1),
      reason: `1 loss on ${currentPair}: Monitoring (best alt: ${scan.bestPair} +${improvement.toFixed(1)}pts)`,
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
  checkPairLiquidity,        // ⭐ NEW EXPORT
  scanAllPairs,
  checkPairRotation,
  getPairRotationStatus,
};
