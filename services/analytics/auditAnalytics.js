"use strict";

/**
 * AUDIT ANALYTICS — Deep trade analysis for strategy tuning
 * Analyzes last N trades and generates actionable recommendations
 */

/**
 * Build comprehensive audit report for last N trades
 */
function buildAuditReport(trades = [], n = 50) {
  if (!trades || trades.length === 0) {
    return { error: "No trades available", meta: { n: 0 } };
  }

  const sample = trades.slice(-Math.min(n, trades.length));
  const meta = {
    n: sample.length,
    period: {
      from: sample.length > 0 ? new Date(sample[0].entryTime).toISOString().split("T")[0] : null,
      to: sample.length > 0 ? new Date(sample[sample.length - 1].exitTime).toISOString().split("T")[0] : null,
      generatedAt: new Date().toISOString(),
    },
  };

  return {
    meta,
    summary: buildSummary(sample),
    exitAnalysis: buildExitAnalysis(sample),
    slAnalysis: buildSLAnalysis(sample),
    tpAnalysis: buildTPAnalysis(sample),
    holdTimeDistribution: buildHoldTimeDistribution(sample),
    setupPerformance: buildSetupPerformance(sample),
    pairAnalysis: buildPairAnalysis(sample),
    sideSplit: buildSideSplit(sample),
    sessionAnalysis: buildSessionAnalysis(sample),
    streakAnalysis: buildStreakAnalysis(sample),
    dailyBreakdown: buildDailyBreakdown(sample),
    tuningRecommendations: generateTuningRecommendations(sample),
  };
}

/**
 * Summary metrics
 */
function buildSummary(trades) {
  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");

  const totalPnL = trades.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0);
  const avgWinPnL = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0) / wins.length : 0;
  const avgLossPnL = losses.length > 0 ? losses.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0) / losses.length : 0;

  const winRate = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 0;
  const profitFactor = Math.abs(avgLossPnL) > 0 ? (avgWinPnL / Math.abs(avgLossPnL)).toFixed(2) : 0;

  const rrs = trades
    .filter(t => Math.abs(t.entry - (t.exit || 0)) > 0)
    .map(t => {
      const risk = Math.abs(t.entry - (t.sl || t.entry * 0.99));
      const reward = Math.abs((t.exit || t.entry) - t.entry);
      return risk > 0 ? reward / risk : 0;
    });
  const avgRR = rrs.length > 0 ? (rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(2) : 0;

  const expectancy = wins.length > 0 && losses.length > 0
    ? (winRate / 100 * avgWinPnL - (1 - winRate / 100) * Math.abs(avgLossPnL)).toFixed(2)
    : 0;

  const avgHoldMs = trades.length > 0 ? trades.reduce((sum, t) => sum + (t.duration || 0), 0) / trades.length : 0;
  const avgHoldMin = (avgHoldMs / 60000).toFixed(1);

  const bestSetup = findBestSetup(trades);

  return {
    totalTrades: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: parseFloat(winRate),
    expectancy: parseFloat(expectancy),
    profitFactor: parseFloat(profitFactor),
    avgRR: parseFloat(avgRR),
    totalPnLUSDT: parseFloat(totalPnL.toFixed(2)),
    avgWinPnLUSDT: parseFloat(avgWinPnL.toFixed(2)),
    avgLossPnLUSDT: parseFloat(avgLossPnL.toFixed(2)),
    avgHoldMin: parseFloat(avgHoldMin),
    bestSetup: bestSetup.setup,
    bestSetupWR: bestSetup.winRate,
  };
}

/**
 * Exit breakdown by reason
 */
function buildExitAnalysis(trades) {
  const reasons = {};
  trades.forEach(t => {
    const reason = t.reason || "UNKNOWN";
    if (!reasons[reason]) reasons[reason] = { count: 0, pnlUSDT: 0, avgPnL: 0 };
    reasons[reason].count += 1;
    reasons[reason].pnlUSDT += t.pnlUSDT || 0;
  });

  const total = trades.length;
  Object.keys(reasons).forEach(r => {
    reasons[r].avgPnL = (reasons[r].pnlUSDT / reasons[r].count).toFixed(2);
    reasons[r].pct = ((reasons[r].count / total) * 100).toFixed(1);
  });

  // Categorize
  const slHitCount = (reasons["STOP_LOSS"]?.count || 0);
  const tpExits = (reasons["TP1_HIT"]?.count || 0) + (reasons["TP2_HIT"]?.count || 0) + (reasons["TP3_HIT_RUNNER"]?.count || 0);

  const winTrades = trades.filter(t => t.result === "WIN");
  const lossTrades = trades.filter(t => t.result === "LOSS");

  const avgWinHoldMin = winTrades.length > 0 ? (winTrades.reduce((sum, t) => sum + (t.duration || 0), 0) / winTrades.length / 60000).toFixed(1) : 0;
  const avgLossHoldMin = lossTrades.length > 0 ? (lossTrades.reduce((sum, t) => sum + (t.duration || 0), 0) / lossTrades.length / 60000).toFixed(1) : 0;

  const fastExitCount = trades.filter(t => (t.duration || 0) < 2 * 60 * 1000).length;
  const longHoldCount = trades.filter(t => (t.duration || 0) > 60 * 60 * 1000).length;

  return {
    byReason: reasons,
    summary: {
      slHitCount,
      slHitPct: ((slHitCount / total) * 100).toFixed(1),
      tpExitCount: tpExits,
      tpExitPct: ((tpExits / total) * 100).toFixed(1),
    },
    holdTime: {
      avgWinHoldMin: parseFloat(avgWinHoldMin),
      avgLossHoldMin: parseFloat(avgLossHoldMin),
      fastExitCount: fastExitCount,
      fastExitPct: ((fastExitCount / total) * 100).toFixed(1),
      longHoldCount: longHoldCount,
      longHoldPct: ((longHoldCount / total) * 100).toFixed(1),
    },
  };
}

/**
 * SL analysis
 */
function buildSLAnalysis(trades) {
  const slHits = trades.filter(t => t.reason === "STOP_LOSS");
  const slHitPct = trades.length > 0 ? ((slHits.length / trades.length) * 100).toFixed(1) : 0;

  const avgLossOnSL = slHits.length > 0 ? (slHits.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0) / slHits.length).toFixed(2) : 0;

  return {
    slHitCount: slHits.length,
    slHitPct: parseFloat(slHitPct),
    avgLossOnSL: parseFloat(avgLossOnSL),
    assessment: parseFloat(slHitPct) > 60 ? "⚠️ SL HIT RATE VERY HIGH" : parseFloat(slHitPct) > 40 ? "⚠️ SL hit rate elevated" : "✓ SL hit rate acceptable",
  };
}

/**
 * TP analysis
 */
function buildTPAnalysis(trades) {
  const tp1Hits = trades.filter(t => t.reason === "TP1_HIT").length;
  const tp2Hits = trades.filter(t => t.reason === "TP2_HIT").length;
  const tp3Hits = trades.filter(t => t.reason === "TP3_HIT_RUNNER").length;

  const total = trades.length;

  return {
    tp1HitCount: tp1Hits,
    tp1HitPct: ((tp1Hits / total) * 100).toFixed(1),
    tp2HitCount: tp2Hits,
    tp2HitPct: ((tp2Hits / total) * 100).toFixed(1),
    tp3HitCount: tp3Hits,
    tp3HitPct: ((tp3Hits / total) * 100).toFixed(1),
    summary: {
      tp1: parseFloat(((tp1Hits / total) * 100).toFixed(1)),
      tp2: parseFloat(((tp2Hits / total) * 100).toFixed(1)),
      tp3: parseFloat(((tp3Hits / total) * 100).toFixed(1)),
    },
  };
}

/**
 * Hold time buckets
 */
function buildHoldTimeDistribution(trades) {
  const buckets = {
    "<2min": trades.filter(t => (t.duration || 0) < 2 * 60 * 1000).length,
    "2-10min": trades.filter(t => (t.duration || 0) >= 2 * 60 * 1000 && (t.duration || 0) < 10 * 60 * 1000).length,
    "10-30min": trades.filter(t => (t.duration || 0) >= 10 * 60 * 1000 && (t.duration || 0) < 30 * 60 * 1000).length,
    "30-60min": trades.filter(t => (t.duration || 0) >= 30 * 60 * 1000 && (t.duration || 0) < 60 * 60 * 1000).length,
    ">60min": trades.filter(t => (t.duration || 0) >= 60 * 60 * 1000).length,
  };

  return Object.entries(buckets).map(([bucket, count]) => ({
    bucket,
    count,
    pct: ((count / trades.length) * 100).toFixed(1),
  }));
}

/**
 * Setup performance
 */
function buildSetupPerformance(trades) {
  const setups = {};
  trades.forEach(t => {
    const setup = t.setup || "UNKNOWN";
    if (!setups[setup]) setups[setup] = { trades: [], winRate: 0, count: 0, wins: 0, totalPnL: 0, avgPnL: 0 };
    setups[setup].trades.push(t);
    setups[setup].count += 1;
    if (t.result === "WIN") setups[setup].wins += 1;
    setups[setup].totalPnL += t.pnlUSDT || 0;
  });

  const result = {};
  Object.entries(setups).forEach(([setup, data]) => {
    const wr = ((data.wins / data.count) * 100).toFixed(1);
    result[setup] = {
      count: data.count,
      wins: data.wins,
      winRate: parseFloat(wr),
      totalPnLUSDT: parseFloat(data.totalPnL.toFixed(2)),
      avgPnLUSDT: parseFloat((data.totalPnL / data.count).toFixed(2)),
    };
  });

  return result;
}

/**
 * Pair analysis
 */
function buildPairAnalysis(trades) {
  const pairs = {};
  trades.forEach(t => {
    const pair = t.symbol || "UNKNOWN";
    if (!pairs[pair]) pairs[pair] = { count: 0, wins: 0, totalPnL: 0 };
    pairs[pair].count += 1;
    if (t.result === "WIN") pairs[pair].wins += 1;
    pairs[pair].totalPnL += t.pnlUSDT || 0;
  });

  const result = {};
  Object.entries(pairs).forEach(([pair, data]) => {
    const wr = ((data.wins / data.count) * 100).toFixed(1);
    result[pair] = {
      count: data.count,
      wins: data.wins,
      winRate: parseFloat(wr),
      totalPnLUSDT: parseFloat(data.totalPnL.toFixed(2)),
      avgPnLUSDT: parseFloat((data.totalPnL / data.count).toFixed(2)),
    };
  });

  return result;
}

/**
 * Long vs Short
 */
function buildSideSplit(trades) {
  const longs = trades.filter(t => t.side === "LONG");
  const shorts = trades.filter(t => t.side === "SHORT");

  const calcStats = arr => {
    const wins = arr.filter(t => t.result === "WIN").length;
    const wr = arr.length > 0 ? ((wins / arr.length) * 100).toFixed(1) : 0;
    const totalPnL = arr.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0);
    const avgPnL = arr.length > 0 ? (totalPnL / arr.length).toFixed(2) : 0;
    return {
      count: arr.length,
      wins,
      winRate: parseFloat(wr),
      totalPnLUSDT: parseFloat(totalPnL.toFixed(2)),
      avgPnLUSDT: parseFloat(avgPnL),
    };
  };

  return {
    long: calcStats(longs),
    short: calcStats(shorts),
    bias: longs.length > shorts.length ? "LONG-biased" : shorts.length > longs.length ? "SHORT-biased" : "Balanced",
  };
}

/**
 * Session breakdown (UTC hours)
 */
function buildSessionAnalysis(trades) {
  const sessions = {
    LONDON: { times: [8, 9, 10, 11, 12, 13], trades: [] },
    NEW_YORK: { times: [13, 14, 15, 16, 17, 18], trades: [] },
    ASIA: { times: [0, 1, 2, 3, 4, 5, 6, 7], trades: [] },
  };

  trades.forEach(t => {
    const hour = new Date(t.entryTime).getUTCHours();
    Object.entries(sessions).forEach(([session, data]) => {
      if (data.times.includes(hour)) data.trades.push(t);
    });
  });

  const result = {};
  Object.entries(sessions).forEach(([session, data]) => {
    const wins = data.trades.filter(t => t.result === "WIN").length;
    const wr = data.trades.length > 0 ? ((wins / data.trades.length) * 100).toFixed(1) : 0;
    const totalPnL = data.trades.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0);
    result[session] = {
      count: data.trades.length,
      wins,
      winRate: parseFloat(wr),
      totalPnLUSDT: parseFloat(totalPnL.toFixed(2)),
    };
  });

  return result;
}

/**
 * Win/Loss streaks
 */
function buildStreakAnalysis(trades) {
  let maxWinStreak = 0,
    maxLossStreak = 0;
  let currentWinStreak = 0,
    currentLossStreak = 0;
  let currentStreak = 0;

  trades.forEach(t => {
    if (t.result === "WIN") {
      currentWinStreak += 1;
      currentLossStreak = 0;
      currentStreak += 1;
    } else {
      currentLossStreak += 1;
      currentWinStreak = 0;
      currentStreak -= 1;
    }
    maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
  });

  return {
    maxWinStreak,
    maxLossStreak,
    currentStreak: trades.length > 0 ? currentStreak : 0,
    currentStreakType: currentStreak > 0 ? "WIN" : currentStreak < 0 ? "LOSS" : "UNKNOWN",
    assessment: maxLossStreak >= 5 ? "⚠️ High loss streak observed" : maxLossStreak >= 3 ? "Elevated loss streak" : "✓ Streak control good",
  };
}

/**
 * Daily P&L breakdown
 */
function buildDailyBreakdown(trades) {
  const daily = {};
  trades.forEach(t => {
    const date = new Date(t.exitTime).toISOString().split("T")[0];
    if (!daily[date]) daily[date] = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0 };
    daily[date].trades += 1;
    if (t.result === "WIN") daily[date].wins += 1;
    else daily[date].losses += 1;
    daily[date].pnlUSDT += t.pnlUSDT || 0;
  });

  return Object.entries(daily)
    .map(([date, data]) => ({
      date,
      trades: data.trades,
      wins: data.wins,
      losses: data.losses,
      pnlUSDT: parseFloat(data.pnlUSDT.toFixed(2)),
      winRate: parseFloat(((data.wins / data.trades) * 100).toFixed(1)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Generate actionable tuning recommendations
 */
function generateTuningRecommendations(trades) {
  const recs = [];
  const summary = buildSummary(trades);
  const exitAnalysis = buildExitAnalysis(trades);
  const slAnalysis = buildSLAnalysis(trades);
  const setupPerf = buildSetupPerformance(trades);
  const pairAnalysis = buildPairAnalysis(trades);
  const sideAnalysis = buildSideSplit(trades);
  const sessionAnalysis = buildSessionAnalysis(trades);

  // Check 1: SL hit rate too high
  if (parseFloat(slAnalysis.slHitPct) > 60) {
    recs.push({
      priority: "CRITICAL",
      issue: "🔴 SL hit rate extremely high",
      detail: `${slAnalysis.slHitPct}% of trades closed on SL — entries are premature or SL too tight`,
      action: "Increase SL width OR improve entry timing (wait for setup confirmation)",
    });
  } else if (parseFloat(slAnalysis.slHitPct) > 40) {
    recs.push({
      priority: "HIGH",
      issue: "🟠 SL hit rate elevated",
      detail: `${slAnalysis.slHitPct}% of trades hit SL`,
      action: "Review entry quality — verify HTF alignment before entering",
    });
  }

  // Check 2: Win rate too low
  if (parseFloat(summary.winRate) < 35) {
    recs.push({
      priority: "CRITICAL",
      issue: "🔴 Win rate critically low",
      detail: `Only ${summary.winRate}% win rate — significantly below 40% target`,
      action: "Disable low-quality setups, enable HTF filter enforcement, reduce trade frequency",
    });
  } else if (parseFloat(summary.winRate) < 40) {
    recs.push({
      priority: "HIGH",
      issue: "🟠 Win rate below target",
      detail: `${summary.winRate}% win rate — below 40% target`,
      action: "Increase entry quality filters (SMC validation, HTF alignment, volume confirmation)",
    });
  }

  // Check 3: Low profit factor
  if (parseFloat(summary.profitFactor) < 1.5) {
    recs.push({
      priority: "HIGH",
      issue: "🟠 Low profit factor",
      detail: `${summary.profitFactor} profit factor — profits not significantly exceeding losses`,
      action: "Improve entry quality OR widen take profit targets",
    });
  }

  // Check 4: Directional bias issue
  const longWR = parseFloat(sideAnalysis.long.winRate || 0);
  const shortWR = parseFloat(sideAnalysis.short.winRate || 0);
  if (Math.abs(longWR - shortWR) > 20) {
    const worstSide = longWR < shortWR ? "LONG" : "SHORT";
    recs.push({
      priority: "HIGH",
      issue: `🟠 Directional bias detected`,
      detail: `${worstSide} has ${Math.abs(longWR - shortWR).toFixed(1)}% lower win rate than opposite`,
      action: `Review ${worstSide} entry criteria — may be trading against trend on this direction`,
    });
  }

  // Check 5: Specific setup performing poorly
  Object.entries(setupPerf).forEach(([setup, data]) => {
    if (data.count >= 5 && parseFloat(data.winRate) < 30) {
      recs.push({
        priority: "MEDIUM",
        issue: `🟡 Setup "${setup}" underperforming`,
        detail: `${data.count} trades, ${data.winRate}% win rate`,
        action: `Consider disabling or retuning ${setup} setup`,
      });
    }
  });

  // Check 6: Pair performing poorly
  Object.entries(pairAnalysis).forEach(([pair, data]) => {
    if (data.count >= 5 && parseFloat(data.winRate) < 30) {
      recs.push({
        priority: "MEDIUM",
        issue: `🟡 Pair "${pair}" underperforming`,
        detail: `${data.count} trades, ${data.winRate}% win rate`,
        action: `Reduce priority or disable ${pair} trading`,
      });
    }
  });

  // Check 7: Session underperforming
  Object.entries(sessionAnalysis).forEach(([session, data]) => {
    if (data.count >= 5 && parseFloat(data.winRate) < 30) {
      recs.push({
        priority: "MEDIUM",
        issue: `🟡 "${session}" session underperforming`,
        detail: `${data.count} trades, ${data.winRate}% win rate`,
        action: `Reduce trading or disable trades during ${session} session hours`,
      });
    }
  });

  // Check 8: Fast exits
  const fastExitPct = parseFloat(exitAnalysis.holdTime.fastExitPct || 0);
  if (fastExitPct > 40) {
    recs.push({
      priority: "MEDIUM",
      issue: "🟡 Many fast exits (<2min)",
      detail: `${fastExitPct}% of trades close within 2 minutes — likely whipsaws`,
      action: "Enforce minimum 2-minute hold time before TP exits (already implemented)",
    });
  }

  // Check 9: TP distribution issue
  const tp1Pct = parseFloat(summary.totalPnLUSDT) > 0 ?
    parseFloat(exitAnalysis.byReason["TP1_HIT"]?.pct || 0) : 0;
  if (tp1Pct > 60) {
    recs.push({
      priority: "LOW",
      issue: "💡 Most wins at TP1",
      detail: `${tp1Pct}% of exits hit TP1 — could widen TP targets for larger wins`,
      action: "Review TP1 level — consider moving higher if market allows",
    });
  }

  // Check 10: Good performance indicator
  if (parseFloat(summary.winRate) >= 45 && parseFloat(summary.expectancy) > 0) {
    recs.push({
      priority: "GREEN",
      issue: "✅ Performance solid",
      detail: `${summary.winRate}% win rate and positive expectancy — system is profitable`,
      action: "Monitor closely, maintain current settings, scale position size cautiously",
    });
  }

  return recs;
}

/**
 * Helper: Find best setup by composite score
 */
function findBestSetup(trades) {
  const setups = {};
  trades.forEach(t => {
    const setup = t.setup || "UNKNOWN";
    if (!setups[setup]) setups[setup] = { trades: [] };
    setups[setup].trades.push(t);
  });

  let best = { setup: "N/A", winRate: 0 };
  Object.entries(setups).forEach(([setup, data]) => {
    if (data.trades.length >= 3) {
      const wins = data.trades.filter(t => t.result === "WIN").length;
      const wr = (wins / data.trades.length) * 100;
      if (wr > best.winRate) best = { setup, winRate: parseFloat(wr.toFixed(1)) };
    }
  });

  return best;
}

module.exports = {
  buildAuditReport,
  buildSummary,
  buildExitAnalysis,
  buildSLAnalysis,
  buildTPAnalysis,
  buildSetupPerformance,
  buildPairAnalysis,
  buildSideSplit,
  buildSessionAnalysis,
  buildStreakAnalysis,
  buildDailyBreakdown,
  generateTuningRecommendations,
};
