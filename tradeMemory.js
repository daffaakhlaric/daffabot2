"use strict";

/**
 * TRADE MEMORY — Self-learning light, persists setup stats to disk.
 * Survives restarts. Blocks setups with WR < 30% (min 5 trades) or -3 streak.
 */

const fs   = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "trade-memory.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}

function save(stats) {
  try { fs.writeFileSync(FILE, JSON.stringify(stats, null, 2)); } catch {}
}

function updateSetupStats(setup, pnlUSDT) {
  if (!setup) return;
  try {
    const stats = load();
    if (!stats[setup]) stats[setup] = { win: 0, loss: 0, totalPnL: 0, streak: 0 };
    const s = stats[setup];
    if (pnlUSDT > 0) { s.win++;  s.streak = Math.max(0, s.streak) + 1; }
    else              { s.loss++; s.streak = Math.min(0, s.streak) - 1; }
    s.totalPnL = +(s.totalPnL + pnlUSDT).toFixed(3);
    save(stats);
    if (global.botState) global.botState.tradeMemory = stats;
  } catch {}
}

function isSetupAllowed(setup) {
  if (!setup) return true;
  try {
    const stats = load();
    const s = stats[setup];
    if (!s) return true;
    const total = s.win + s.loss;
    if (total < 5) return true;      // belum cukup data
    const winRate = s.win / total;
    if (winRate < 0.30) return false; // WR < 30%
    if (s.streak <= -3) return false; // 3 loss streak
    return true;
  } catch { return true; }
}

function getStats() {
  try {
    const stats = load();
    return Object.entries(stats).map(([setup, s]) => ({
      setup,
      total:   s.win + s.loss,
      winRate: s.win + s.loss > 0 ? +(s.win / (s.win + s.loss) * 100).toFixed(1) : null,
      totalPnL: s.totalPnL,
      streak:  s.streak,
      allowed: isSetupAllowed(setup),
    }));
  } catch { return []; }
}

module.exports = { updateSetupStats, isSetupAllowed, getStats };
