"use strict";

/**
 * BTC STRATEGY FINAL (HARDENED)
 */

const CONFIG = {
  EMA_PERIOD: 50,
  VOLUME_MIN: 1.2,
  PULLBACK_ZONE: 0.3,

  SL: 0.7,
  TRAIL_ACTIVATE: 1.5,
  TRAIL_DROP: 0.3,

  PYR_1: 1.5,
  PYR_2: 3.0,
};

// ================= EMA =================
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;

  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

// ================= ANALYZE =================
function analyze({ klines, position }) {
  try {
    if (!Array.isArray(klines) || klines.length < 60) {
      return { action: "HOLD" };
    }

    const current = klines[klines.length - 1];
    const prev = klines[klines.length - 2];

    if (!current || !prev) return { action: "HOLD" };

    const closes = klines.map(k => k.close).filter(v => !isNaN(v));
    const volumes = klines.map(k => k.volume).filter(v => !isNaN(v));

    if (closes.length < 50 || volumes.length < 20) {
      return { action: "HOLD" };
    }

    const price = current.close;
    const ema50 = ema(closes, CONFIG.EMA_PERIOD);

    if (!ema50 || isNaN(price)) return { action: "HOLD" };

    const isBull = price > ema50;
    const isBear = price < ema50;

    // ================= POSITION =================
    if (position) {
      return managePosition(position, price);
    }

    // ================= VOLUME =================
    const avgVol =
      volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

    if (!avgVol || isNaN(avgVol)) return { action: "HOLD" };

    const volRatio = current.volume / avgVol;

    // ================= TREND =================
    if (isBull && current.close > prev.high && volRatio > CONFIG.VOLUME_MIN) {
      return buildEntry("LONG", price);
    }

    if (isBear && current.close < prev.low && volRatio > CONFIG.VOLUME_MIN) {
      return buildEntry("SHORT", price);
    }

    // ================= SNIPER =================
    const dist = Math.abs(price - ema50) / ema50 * 100;

    if (isBull && dist < CONFIG.PULLBACK_ZONE && current.close > current.open) {
      return buildEntry("LONG", price);
    }

    if (isBear && dist < CONFIG.PULLBACK_ZONE && current.close < current.open) {
      return buildEntry("SHORT", price);
    }

    return { action: "HOLD" };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

// ================= ENTRY =================
function buildEntry(side, price) {
  return {
    action: side,
    entry: {
      price,
      sl: CONFIG.SL,
      trailActivate: CONFIG.TRAIL_ACTIVATE,
      trailDrop: CONFIG.TRAIL_DROP,
      pyr1: CONFIG.PYR_1,
      pyr2: CONFIG.PYR_2,
    },
  };
}

// ================= POSITION MANAGEMENT =================
function managePosition(pos, price) {
  try {
    if (!pos || typeof pos.entry !== "number") {
      return { action: "HOLD" };
    }

    const pnl =
      pos.side === "LONG"
        ? (price - pos.entry) / pos.entry * 100
        : (pos.entry - price) / pos.entry * 100;

    if (typeof pos.peak !== "number") pos.peak = 0;
    pos.peak = Math.max(pos.peak, pnl);

    // STOP LOSS
    if (pnl <= -pos.sl) {
      return { action: "CLOSE", reason: "STOP LOSS" };
    }

    // TRAILING
    if (pnl >= pos.trailActivate) {
      const drop = pos.peak * pos.trailDrop;
      if (pnl <= pos.peak - drop) {
        return { action: "CLOSE", reason: "TRAILING EXIT" };
      }
    }

    // PYRAMID
    if (!pos.pyr1Done && pnl >= pos.pyr1 && pos.pyr1 > 0) {
      pos.pyr1Done = true;
      return { action: "PYRAMID", level: 1 };
    }

    if (!pos.pyr2Done && pnl >= pos.pyr2 && pos.pyr2 > 0) {
      pos.pyr2Done = true;
      return { action: "PYRAMID", level: 2 };
    }

    return { action: "HOLD" };

  } catch (err) {
    return { action: "HOLD", error: err.message };
  }
}

module.exports = { analyze };