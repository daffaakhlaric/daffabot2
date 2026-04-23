"use strict";

/**
 * BingX Perpetual Swap V2 — REST Adapter
 *
 * Native features used:
 *  - HMAC-SHA256 query-string signing
 *  - Atomic stopLoss / takeProfit attached to MARKET order placement
 *  - Standalone leverage endpoint
 *  - One-way & hedge-mode position support
 *
 * Endpoints (host: open-api.bingx.com):
 *   GET  /openApi/swap/v2/quote/klines        market klines
 *   GET  /openApi/swap/v2/quote/price         ticker
 *   GET  /openApi/swap/v2/quote/depth         orderbook
 *   POST /openApi/swap/v2/trade/order         place order (with optional SL/TP)
 *   GET  /openApi/swap/v2/user/positions      open positions
 *   POST /openApi/swap/v2/trade/leverage      set leverage
 *   GET  /openApi/swap/v2/user/balance        equity
 *
 * Env required:
 *   BINGX_API_KEY
 *   BINGX_SECRET_KEY
 *   (no passphrase — BingX uses key+secret only)
 */

const https = require("https");
const crypto = require("crypto");

const HOST = "open-api.bingx.com";
const RECV_WINDOW = 5000;

const KEY = process.env.BINGX_API_KEY || "";
const SECRET = process.env.BINGX_SECRET_KEY || "";

// ---------- helpers ----------

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Map our internal symbol "BTCUSDT" to BingX swap symbol "BTC-USDT"
function toBingxSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.includes("-")) return symbol;
  if (symbol.endsWith("USDT")) return `${symbol.slice(0, -4)}-USDT`;
  if (symbol.endsWith("USDC")) return `${symbol.slice(0, -4)}-USDC`;
  return symbol;
}

// Map our internal granularity "1m"/"5m"/"15m"/"1h"/"4h" to BingX format
function toBingxInterval(granularity) {
  // BingX uses identical short codes — just normalize 1H -> 1h
  if (!granularity) return "1m";
  return String(granularity).toLowerCase();
}

function signQuery(paramsObj) {
  // BingX signs the canonical query string (sorted insertion order maintained)
  const parts = [];
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${v}`);
  }
  const queryString = parts.join("&");
  const signature = crypto.createHmac("sha256", SECRET).update(queryString).digest("hex");
  return { queryString, signature };
}

function httpRequest(method, fullPath, headers = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: HOST, path: fullPath, method, headers },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: safeJsonParse(data), raw: data }));
      }
    );
    req.on("error", (err) => resolve({ status: 0, body: null, raw: "", error: err.message }));
    req.end();
  });
}

// Public (unsigned) GET
async function publicGet(path, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const fullPath = qs ? `${path}?${qs}` : path;
  return httpRequest("GET", fullPath, { "User-Agent": "Daffabot2/bingx" });
}

// Signed request — params in query for ALL methods (BingX convention)
async function signedRequest(method, path, params = {}) {
  if (!KEY || !SECRET) {
    return { status: 0, body: null, error: "BINGX_API_KEY/SECRET not set" };
  }
  const fullParams = {
    ...params,
    timestamp: Date.now(),
    recvWindow: RECV_WINDOW,
  };
  const { queryString, signature } = signQuery(fullParams);
  const fullPath = `${path}?${queryString}&signature=${signature}`;
  return httpRequest(method, fullPath, {
    "X-BX-APIKEY": KEY,
    "User-Agent": "Daffabot2/bingx",
  });
}

// ---------- market data ----------

async function getKlines(symbol, granularity = "1m", limit = 100) {
  const res = await publicGet("/openApi/swap/v2/quote/klines", {
    symbol: toBingxSymbol(symbol),
    interval: toBingxInterval(granularity),
    limit,
  });
  const arr = res.body?.data;
  if (!Array.isArray(arr) || arr.length === 0) return [];
  // BingX returns descending; normalize to ascending {open,high,low,close,volume}
  return arr.map((c) => ({
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: +c.volume,
    time: +c.time,
  })).sort((a, b) => a.time - b.time);
}

async function getTickerPrice(symbol) {
  const res = await publicGet("/openApi/swap/v2/quote/price", {
    symbol: toBingxSymbol(symbol),
  });
  const p = res.body?.data?.price;
  return p ? parseFloat(p) : null;
}

async function getOrderbook(symbol, depth = 20) {
  const res = await publicGet("/openApi/swap/v2/quote/depth", {
    symbol: toBingxSymbol(symbol),
    limit: depth,
  });
  const ob = res.body?.data;
  if (!ob) return null;
  return {
    bids: (ob.bids || []).map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
    asks: (ob.asks || []).map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
  };
}

// ---------- account ----------

async function getEquity() {
  const res = await signedRequest("GET", "/openApi/swap/v2/user/balance", {});
  // shape: { data: { balance: { equity, balance, ... } } }
  const eq = res.body?.data?.balance?.equity ?? res.body?.data?.balance?.balance;
  return eq ? parseFloat(eq) : null;
}

async function setLeverage(symbol, leverage, side = "BOTH") {
  // BingX accepts "LONG" | "SHORT" | "BOTH"; in one-way mode use "BOTH"
  return signedRequest("POST", "/openApi/swap/v2/trade/leverage", {
    symbol: toBingxSymbol(symbol),
    side,
    leverage: String(leverage),
  });
}

async function getPosition(symbol) {
  const res = await signedRequest("GET", "/openApi/swap/v2/user/positions", {
    symbol: toBingxSymbol(symbol),
  });
  const arr = res.body?.data;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // Filter out zero positions; pick the first non-zero
  for (const p of arr) {
    const sz = parseFloat(p.positionAmt || p.positionSize || 0);
    if (Math.abs(sz) > 0) {
      return {
        raw: p,
        symbol: p.symbol,
        side: (p.positionSide || (sz > 0 ? "LONG" : "SHORT")).toUpperCase(),
        size: Math.abs(sz),
        entryPrice: parseFloat(p.avgPrice || p.entryPrice || 0),
        unrealizedPnl: parseFloat(p.unrealizedProfit || 0),
        leverage: parseFloat(p.leverage || 0),
        liquidationPrice: parseFloat(p.liquidationPrice || 0),
      };
    }
  }
  return null;
}

// ---------- order placement (atomic SL native) ----------

/**
 * Place market order with OPTIONAL atomic stop-loss / take-profit.
 *
 * BingX accepts `stopLoss` and `takeProfit` as JSON strings on order body —
 * the exchange creates the conditional orders atomically with the entry.
 *
 * @param {Object} p
 * @param {String} p.symbol         e.g. "BTCUSDT"
 * @param {String} p.side           "BUY" | "SELL"
 * @param {String} p.positionSide   "LONG" | "SHORT" (hedge mode) or "BOTH" (one-way)
 * @param {Number} p.quantity       contract quantity
 * @param {Number} [p.slPrice]      atomic stop-loss trigger price
 * @param {Number} [p.tpPrice]      atomic take-profit trigger price
 * @param {Boolean}[p.reduceOnly]   close-only (for explicit close calls)
 */
async function placeMarketOrder(p) {
  const params = {
    symbol: toBingxSymbol(p.symbol),
    side: p.side,
    positionSide: p.positionSide || "BOTH",
    type: "MARKET",
    quantity: String(p.quantity),
  };
  if (p.reduceOnly) params.reduceOnly = "true";

  if (typeof p.slPrice === "number" && p.slPrice > 0) {
    // BingX expects stopLoss as a JSON object with type/stopPrice/price/workingType
    params.stopLoss = JSON.stringify({
      type: "STOP_MARKET",
      stopPrice: p.slPrice,
      price: p.slPrice,
      workingType: "MARK_PRICE",
    });
  }
  if (typeof p.tpPrice === "number" && p.tpPrice > 0) {
    params.takeProfit = JSON.stringify({
      type: "TAKE_PROFIT_MARKET",
      stopPrice: p.tpPrice,
      price: p.tpPrice,
      workingType: "MARK_PRICE",
    });
  }

  return signedRequest("POST", "/openApi/swap/v2/trade/order", params);
}

async function closeMarketPosition({ symbol, side, quantity, positionSide = "BOTH" }) {
  // Close: opposite side, reduceOnly
  const closeSide = side === "LONG" ? "SELL" : "BUY";
  return placeMarketOrder({
    symbol,
    side: closeSide,
    positionSide,
    quantity,
    reduceOnly: true,
  });
}

module.exports = {
  // identity
  name: "bingx",
  // helpers
  toBingxSymbol,
  toBingxInterval,
  // market
  getKlines,
  getTickerPrice,
  getOrderbook,
  // account
  getEquity,
  setLeverage,
  getPosition,
  // orders
  placeMarketOrder,
  closeMarketPosition,
};
