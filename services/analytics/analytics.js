"use strict";

/**
 * QUANT ANALYTICS ENGINE
 * Pure, stateless calculation functions — no side effects
 */

// ────────────────────────────────────────────────────────
// EQUITY CURVE
// ────────────────────────────────────────────────────────
function calcEquityCurve(trades, initialEquity = 1000) {
  if (!trades.length) return [{ time: Date.now(), equity: initialEquity }];

  let equity = initialEquity;
  const curve = [{ time: trades[0].timestamp, equity }];

  for (const t of trades) {
    equity += t.pnlUSDT || 0;
    curve.push({ time: t.exitTime || t.timestamp, equity: Math.max(0, equity) });
  }

  // Downsample to max 600 points for WS performance
  if (curve.length > 600) {
    const step = Math.floor(curve.length / 600);
    return curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  }

  return curve;
}

// ────────────────────────────────────────────────────────
// DRAWDOWN
// ────────────────────────────────────────────────────────
function calcDrawdownSeries(equityCurve) {
  let peak = equityCurve[0]?.equity || 0;

  return equityCurve.map(point => {
    if (point.equity > peak) peak = point.equity;
    const dd = peak > 0 ? -((peak - point.equity) / peak) * 100 : 0;
    return { time: point.time, drawdown: +dd.toFixed(2), equity: point.equity };
  });
}

function calcMaxDrawdown(equityCurve) {
  const series = calcDrawdownSeries(equityCurve);
  return +Math.max(0, ...series.map(s => Math.abs(s.drawdown))).toFixed(2);
}

function calcCurrentDrawdown(equityCurve) {
  if (!equityCurve.length) return 0;
  const series = calcDrawdownSeries(equityCurve);
  return Math.abs(series[series.length - 1]?.drawdown || 0);
}

function calcRecoveryTime(equityCurve) {
  let peak = 0, peakIdx = 0, inDD = false, maxDDDuration = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const { equity, time } = equityCurve[i];
    if (equity >= peak) {
      if (inDD) {
        const duration = time - equityCurve[peakIdx].time;
        if (duration > maxDDDuration) maxDDDuration = duration;
        inDD = false;
      }
      peak = equity;
      peakIdx = i;
    } else {
      inDD = true;
    }
  }

  return maxDDDuration; // ms
}

// ────────────────────────────────────────────────────────
// WIN / LOSS METRICS
// ────────────────────────────────────────────────────────
function calcWinRate(trades) {
  if (!trades.length) return 0;
  return +((trades.filter(t => t.pnl > 0).length / trades.length) * 100).toFixed(1);
}

function calcProfitFactor(trades) {
  const grossProfit = trades.filter(t => t.pnlUSDT > 0).reduce((s, t) => s + t.pnlUSDT, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnlUSDT < 0).reduce((s, t) => s + t.pnlUSDT, 0));
  if (!grossLoss) return grossProfit > 0 ? 99.99 : 0;
  return +(grossProfit / grossLoss).toFixed(2);
}

function calcExpectancy(trades) {
  if (!trades.length) return 0;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnlUSDT || 0), 0) / wins.length : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((s, t) => s + (t.pnlUSDT || 0), 0) / losses.length)
    : 0;
  return +((winRate * avgWin) - ((1 - winRate) * avgLoss)).toFixed(2);
}

function calcAvgWin(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  return wins.length ? +(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : 0;
}

function calcAvgLoss(trades) {
  const losses = trades.filter(t => t.pnl < 0);
  return losses.length ? +(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : 0;
}

function calcRiskReward(trades) {
  const avgWin = calcAvgWin(trades);
  const avgLoss = Math.abs(calcAvgLoss(trades));
  if (!avgLoss) return 0;
  return +(avgWin / avgLoss).toFixed(2);
}

// ────────────────────────────────────────────────────────
// ROLLING PnL
// ────────────────────────────────────────────────────────
function calcRollingPnL(trades, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return +trades
    .filter(t => (t.exitTime || t.timestamp) >= cutoff)
    .reduce((s, t) => s + (t.pnlUSDT || 0), 0)
    .toFixed(2);
}

// ────────────────────────────────────────────────────────
// BEHAVIORAL SPLITS
// ────────────────────────────────────────────────────────
function summarizeGroup(arr) {
  if (!arr.length) return { count: 0, winRate: 0, avgPnL: 0, totalPnL: 0 };
  return {
    count: arr.length,
    winRate: +calcWinRate(arr).toFixed(1),
    avgPnL: +(arr.reduce((s, t) => s + t.pnl, 0) / arr.length).toFixed(2),
    totalPnL: +arr.reduce((s, t) => s + (t.pnlUSDT || 0), 0).toFixed(2),
  };
}

function calcSideSplit(trades) {
  return {
    long: summarizeGroup(trades.filter(t => t.side === "LONG")),
    short: summarizeGroup(trades.filter(t => t.side === "SHORT")),
  };
}

function getSession(timestamp) {
  const h = new Date(timestamp).getUTCHours();
  if (h >= 0 && h < 8) return "Asia";
  if (h >= 8 && h < 14) return "London";
  return "New York";
}

function calcSessionSplit(trades) {
  const buckets = { Asia: [], London: [], "New York": [] };
  for (const t of trades) buckets[getSession(t.timestamp)].push(t);
  return Object.fromEntries(
    Object.entries(buckets).map(([k, arr]) => [k, summarizeGroup(arr)])
  );
}

function calcSetupSplit(trades) {
  const setups = {};
  for (const t of trades) {
    const s = t.setup || "UNKNOWN";
    if (!setups[s]) setups[s] = [];
    setups[s].push(t);
  }
  return Object.fromEntries(
    Object.entries(setups).map(([k, arr]) => [k, summarizeGroup(arr)])
  );
}

// ────────────────────────────────────────────────────────
// DISTRIBUTION
// ────────────────────────────────────────────────────────
function calcPnLHistogram(trades, bins = 16) {
  if (!trades.length) return [];
  const pnls = trades.map(t => t.pnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const step = (max - min) / bins || 1;

  const buckets = Array.from({ length: bins }, (_, i) => ({
    label: (min + i * step + step / 2).toFixed(1) + "%",
    midpoint: min + i * step + step / 2,
    count: 0,
  }));

  for (const pnl of pnls) {
    const i = Math.min(Math.floor((pnl - min) / step), bins - 1);
    if (i >= 0) buckets[i].count++;
  }

  return buckets;
}

// ────────────────────────────────────────────────────────
// HEATMAP
// ────────────────────────────────────────────────────────
function calcDailyHeatmap(trades, days = 91) {
  const map = {};
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  for (const t of trades) {
    const ts = t.exitTime || t.timestamp;
    if (ts < cutoff) continue;
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    map[key] = +((map[key] || 0) + (t.pnlUSDT || 0)).toFixed(2);
  }

  return map;
}

// ────────────────────────────────────────────────────────
// RISK
// ────────────────────────────────────────────────────────
function calcConsecutiveLosses(trades) {
  let current = 0, max = 0;
  for (const t of [...trades].reverse()) {
    if (t.pnl < 0) { current++; max = Math.max(max, current); }
    else break;
  }
  return { current, max: Math.max(max, current) };
}

function calcTradesPerDay(trades, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = trades.filter(t => (t.exitTime || t.timestamp) >= cutoff);
  return +(recent.length / days).toFixed(1);
}

function calcAvgHoldTime(trades) {
  const durations = trades.filter(t => t.duration > 0).map(t => t.duration);
  if (!durations.length) return 0;
  return Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
}

// ────────────────────────────────────────────────────────
// STRATEGY INTELLIGENCE
// ────────────────────────────────────────────────────────
function calcBestSetup(trades) {
  const setups = calcSetupSplit(trades);
  let best = null, bestScore = -Infinity;
  for (const [name, data] of Object.entries(setups)) {
    if (data.count < 3) continue;
    const score = data.winRate * 0.6 + data.avgPnL * 15;
    if (score > bestScore) { bestScore = score; best = { name, ...data }; }
  }
  return best;
}

function calcWorstSetup(trades) {
  const setups = calcSetupSplit(trades);
  let worst = null, worstScore = Infinity;
  for (const [name, data] of Object.entries(setups)) {
    if (data.count < 3) continue;
    const score = data.winRate * 0.6 + data.avgPnL * 15;
    if (score < worstScore) { worstScore = score; worst = { name, ...data }; }
  }
  return worst;
}

// ────────────────────────────────────────────────────────
// FULL BUNDLE
// ────────────────────────────────────────────────────────
function buildAnalytics(trades, initialEquity = 1000) {
  const equityCurve = calcEquityCurve(trades, initialEquity);
  const drawdownSeries = calcDrawdownSeries(equityCurve);

  return {
    equityCurve,
    drawdownSeries,
    maxDrawdown: calcMaxDrawdown(equityCurve),
    currentDrawdown: +calcCurrentDrawdown(equityCurve).toFixed(2),
    recoveryTimeMs: calcRecoveryTime(equityCurve),

    totalTrades: trades.length,
    winRate: calcWinRate(trades),
    profitFactor: calcProfitFactor(trades),
    expectancy: calcExpectancy(trades),
    avgWin: calcAvgWin(trades),
    avgLoss: calcAvgLoss(trades),
    riskReward: calcRiskReward(trades),

    dailyPnL: calcRollingPnL(trades, 1),
    weeklyPnL: calcRollingPnL(trades, 7),
    monthlyPnL: calcRollingPnL(trades, 30),

    sideSplit: calcSideSplit(trades),
    sessionSplit: calcSessionSplit(trades),
    setupSplit: calcSetupSplit(trades),

    pnlHistogram: calcPnLHistogram(trades),
    dailyHeatmap: calcDailyHeatmap(trades),

    consecutiveLosses: calcConsecutiveLosses(trades),
    tradesPerDay: calcTradesPerDay(trades),
    avgHoldTime: calcAvgHoldTime(trades),

    bestSetup: calcBestSetup(trades),
    worstSetup: calcWorstSetup(trades),

    currentEquity: equityCurve[equityCurve.length - 1]?.equity || initialEquity,
  };
}

// ────────────────────────────────────────────────────────
// DEMO DATA GENERATOR (for testing without live bot)
// ────────────────────────────────────────────────────────
function generateDemoTrades(days = 60) {
  const trades = [];
  let price = 65000;
  const now = Date.now();
  const POSITION_USDT = 15;
  const LEVERAGE = 7;
  const setups = ["TREND", "SNIPER", "BREAKOUT"];
  const sides = ["LONG", "SHORT"];

  for (let d = 0; d < days; d++) {
    const numTrades = Math.floor(Math.random() * 4) + 1;

    for (let t = 0; t < numTrades; t++) {
      const timestamp = now - (days - d) * 86400000 + t * 4 * 3600000 + Math.random() * 3600000;
      const side = sides[Math.floor(Math.random() * 2)];
      // Slight positive skew for realistic demo data
      const raw = Math.random();
      const pnl = raw > 0.4
        ? +(Math.random() * 2.5 + 0.3).toFixed(3)  // win: +0.3 to +2.8%
        : -(Math.random() * 1.2 + 0.2).toFixed(3);  // loss: -0.2 to -1.4%
      const duration = Math.floor(Math.random() * 180) + 10;
      const pnlUSDT = +(POSITION_USDT * LEVERAGE * (pnl / 100)).toFixed(3);

      trades.push({
        id: `DEMO-${d}-${t}`,
        side,
        entry: +price.toFixed(2),
        exit: +(price * (1 + (side === "LONG" ? 1 : -1) * pnl / 100)).toFixed(2),
        pnl,
        pnlUSDT,
        duration,
        timestamp,
        exitTime: timestamp + duration * 60000,
        setup: setups[Math.floor(Math.random() * setups.length)],
        demo: true,
      });

      price = price * (1 + (Math.random() * 0.015 - 0.006));
    }
  }

  return trades.sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = {
  calcEquityCurve,
  calcDrawdownSeries,
  calcMaxDrawdown,
  calcCurrentDrawdown,
  calcRecoveryTime,
  calcWinRate,
  calcProfitFactor,
  calcExpectancy,
  calcAvgWin,
  calcAvgLoss,
  calcRiskReward,
  calcRollingPnL,
  calcSideSplit,
  calcSessionSplit,
  calcSetupSplit,
  calcPnLHistogram,
  calcDailyHeatmap,
  calcConsecutiveLosses,
  calcTradesPerDay,
  calcAvgHoldTime,
  calcBestSetup,
  calcWorstSetup,
  buildAnalytics,
  generateDemoTrades,
};
