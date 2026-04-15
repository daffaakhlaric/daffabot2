"use strict";

/**
 * TRADE TYPES — Trade object interfaces & JSDoc type definitions
 */

/**
 * @typedef {Object} Trade
 * @property {string} id - Unique trade identifier
 * @property {string} symbol - Trading pair (e.g., "BTCUSDT")
 * @property {string} side - "LONG" or "SHORT"
 * @property {number} entry - Entry price
 * @property {number} sl - Stop loss price
 * @property {number} tp1 - Take profit 1
 * @property {number} tp2 - Take profit 2 (optional)
 * @property {number} tp3 - Take profit 3 (optional)
 * @property {number} size - Position size in USDT
 * @property {number} sizeUsdt - Position size in USDT (alias)
 * @property {number} leverage - Leverage used
 * @property {string} setup - Setup type (SNIPER, TREND, KILLER, etc)
 * @property {number} confluenceScore - Entry confidence score (0-100)
 * @property {number} timestamp - Entry timestamp
 * @property {number} openTime - Order open timestamp
 * @property {number} exitTime - Order exit/close timestamp
 * @property {number} openPrice - Actual fill price at open
 * @property {number} closePrice - Actual fill price at close
 * @property {number} pnlUSDT - Profit/loss in USDT
 * @property {number} pnlPercent - Profit/loss in percentage
 * @property {string} status - OPEN, CLOSED, FAILED
 * @property {string} reason - Exit reason (TP, SL, MANUAL, etc)
 */

/**
 * @typedef {Object} Position
 * @property {string} id - Position ID
 * @property {string} symbol - Trading pair
 * @property {string} side - LONG or SHORT
 * @property {number} entry - Entry price
 * @property {number} size - Position size
 * @property {number} leverage - Leverage used
 * @property {number} openTime - When position was opened
 * @property {number} margin - Margin used
 * @property {number} liquidationPrice - Liquidation price
 * @property {Object} [sl] - Stop loss info
 * @property {number} [sl.price] - SL price
 * @property {number} [sl.percent] - SL percentage
 * @property {Object} [tp] - Take profit info
 * @property {number} [tp.price] - TP price
 * @property {number} [tp.percent] - TP percentage
 */

/**
 * @typedef {Object} OrderResponse
 * @property {boolean} success - Whether order was successful
 * @property {string} orderId - Order ID from exchange
 * @property {string} [errorCode] - Error code if failed
 * @property {string} [errorMsg] - Error message if failed
 * @property {number} fillPrice - Price at which order was filled
 * @property {number} fillTime - Timestamp of fill
 */

/**
 * @typedef {Object} PositionManagerResult
 * @property {boolean} success - Operation success
 * @property {string} message - Operation message
 * @property {Trade} [trade] - Trade object if applicable
 * @property {OrderResponse} [orderResponse] - Exchange response
 * @property {string} [error] - Error message if failed
 */

module.exports = {
  // Type definitions are JSDoc-only for JavaScript
  // This file serves as documentation
};
