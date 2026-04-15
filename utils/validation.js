"use strict";

/**
 * VALIDATION — Input validation & type checking
 */

/**
 * Validate trade object structure
 */
function validateTrade(trade) {
  if (!trade) return { valid: false, errors: ["Trade is null/undefined"] };

  const errors = [];

  if (typeof trade.id !== "string") errors.push("trade.id must be string");
  if (typeof trade.side !== "string" || !["LONG", "SHORT"].includes(trade.side)) {
    errors.push("trade.side must be LONG or SHORT");
  }
  if (typeof trade.entry !== "number" || trade.entry <= 0) {
    errors.push("trade.entry must be positive number");
  }
  if (typeof trade.sl !== "number") errors.push("trade.sl must be number");
  if (typeof trade.tp !== "number") errors.push("trade.tp must be number");

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate signal object
 */
function validateSignal(signal) {
  if (!signal) return { valid: false, errors: ["Signal is null/undefined"] };

  const errors = [];

  const validActions = ["LONG", "SHORT", "HOLD", "CLOSE"];
  if (!validActions.includes(signal.action)) {
    errors.push(`signal.action must be one of: ${validActions.join(", ")}`);
  }

  if (signal.reason && typeof signal.reason !== "string") {
    errors.push("signal.reason must be string");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate klines array
 */
function validateKlines(klines) {
  if (!Array.isArray(klines)) return { valid: false, errors: ["klines must be array"] };
  if (klines.length === 0) return { valid: false, errors: ["klines array is empty"] };

  const errors = [];
  const sample = klines[0];

  if (typeof sample.open !== "number") errors.push("klines must have 'open' (number)");
  if (typeof sample.high !== "number") errors.push("klines must have 'high' (number)");
  if (typeof sample.low !== "number") errors.push("klines must have 'low' (number)");
  if (typeof sample.close !== "number") errors.push("klines must have 'close' (number)");
  if (typeof sample.volume !== "number") errors.push("klines must have 'volume' (number)");

  return {
    valid: errors.length === 0,
    errors,
    kline_count: klines.length,
  };
}

/**
 * Validate configuration object
 */
function validateConfig(config) {
  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["Config must be object"] };
  }

  const errors = [];

  if (!config.API_KEY) errors.push("Config missing: API_KEY");
  if (!config.SECRET_KEY) errors.push("Config missing: SECRET_KEY");
  if (!config.PASSPHRASE) errors.push("Config missing: PASSPHRASE");

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if value is safe number
 */
function isSafeNumber(num) {
  return typeof num === "number" && isFinite(num) && !isNaN(num);
}

/**
 * Check if price move is reasonable (not pump/dump error)
 */
function isReasonablePriceMove(oldPrice, newPrice, maxChangePercent = 10) {
  if (!isSafeNumber(oldPrice) || !isSafeNumber(newPrice) || oldPrice <= 0) {
    return false;
  }

  const changePct = Math.abs((newPrice - oldPrice) / oldPrice) * 100;
  return changePct <= maxChangePercent;
}

module.exports = {
  validateTrade,
  validateSignal,
  validateKlines,
  validateConfig,
  isSafeNumber,
  isReasonablePriceMove,
};
