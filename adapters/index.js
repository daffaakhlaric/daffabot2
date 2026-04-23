"use strict";

/**
 * EXCHANGE ROUTER
 *
 * Selects active exchange adapter based on env:
 *   EXCHANGE=bingx   (default for new BingX migration)
 *   EXCHANGE=bitget  (legacy)
 *
 * All adapters expose the same surface — see bingxAdapter.js for the
 * canonical interface contract.
 *
 *   getKlines(symbol, granularity, limit) -> [{open,high,low,close,volume,time}]
 *   getTickerPrice(symbol)                -> Number | null
 *   getOrderbook(symbol, depth)           -> { bids:[[p,q]], asks:[[p,q]] } | null
 *   getEquity()                           -> Number | null
 *   setLeverage(symbol, leverage, side)   -> raw response
 *   getPosition(symbol)                   -> { side, size, entryPrice, ... } | null
 *   placeMarketOrder({ symbol, side, positionSide, quantity, slPrice, tpPrice, reduceOnly })
 *   closeMarketPosition({ symbol, side, quantity, positionSide })
 *
 * Adapters that do not natively support atomic SL ignore slPrice/tpPrice;
 * the bot still maintains software-side SL monitoring as a backstop.
 */

const bingx = require("./bingxAdapter");
const bitget = require("./bitgetAdapter");

const SELECTED = (process.env.EXCHANGE || "bingx").toLowerCase();

const REGISTRY = {
  bingx,
  bitget,
};

const active = REGISTRY[SELECTED] || bingx;

if (!REGISTRY[SELECTED]) {
  // Use console — log() lives in the bot module, not here.
  console.warn(`[adapters] Unknown EXCHANGE="${SELECTED}", falling back to "bingx"`);
}

module.exports = {
  // active adapter (proxy-style export)
  ...active,
  // capability flags for callers that need to branch
  supportsAtomicSL: active.name === "bingx",
  exchangeName: active.name,
  // direct access to adapters by name
  adapters: REGISTRY,
};
