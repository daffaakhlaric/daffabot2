"use strict";

/**
 * Bitget USDT-Futures (V2) — REST Adapter
 *
 * Wraps the existing inline Bitget logic in pepe-futures-bot.js into the
 * unified exchange interface. This adapter is the legacy path; new
 * deployments should use bingxAdapter.
 *
 * Endpoints (host: api.bitget.com):
 *   GET  /api/v2/mix/market/candles
 *   GET  /api/v2/mix/market/ticker
 *   POST /api/v2/mix/order/place-order
 *   GET  /api/v2/mix/position/single-position
 *   POST /api/v2/mix/account/set-leverage
 *
 * NOTE: Bitget atomic TPSL on order placement requires the
 * /api/v2/mix/order/place-tpsl-order or place-plan-order endpoint —
 * NOT exposed here. SL is bot-monitored on this adapter.
 */

const https = require("https");
const crypto = require("crypto");

const HOST = "api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";

const KEY = process.env.BITGET_API_KEY || "";
const SECRET = process.env.BITGET_SECRET_KEY || "";
const PASSPHRASE = process.env.BITGET_PASSPHRASE || "";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sign(ts, method, path, bodyStr) {
  return crypto.createHmac("sha256", SECRET).update(ts + method + path + bodyStr).digest("base64");
}

async function request(method, path, body = null) {
  const ts = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = {
    "ACCESS-KEY": KEY,
    "ACCESS-SIGN": sign(ts, method, path, bodyStr),
    "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": PASSPHRASE,
    "Content-Type": "application/json",
  };
  return new Promise((resolve) => {
    const req = https.request({ hostname: HOST, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        const json = safeJsonParse(data);
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on("error", (err) => resolve({ status: 0, body: null, raw: "", error: err.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------- market ----------

async function getKlines(symbol, granularity = "1m", limit = 100) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${symbol}&productType=${PRODUCT_TYPE}&granularity=${granularity}&limit=${limit}`
  );
  const arr = res.body?.data;
  if (!Array.isArray(arr) || arr.length === 0) return [];
  // Bitget candle: [ts, open, high, low, close, volume, ...]; descending
  return arr.map((c) => ({
    open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], time: +c[0],
  })).reverse();
}

async function getTickerPrice(symbol) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/ticker?symbol=${symbol}&productType=${PRODUCT_TYPE}`
  );
  const tick = Array.isArray(res.body?.data) ? res.body.data[0] : res.body?.data;
  const p = tick?.lastPr || tick?.last || tick?.close;
  return p ? parseFloat(p) : null;
}

async function getOrderbook(symbol, depth = 20) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=${PRODUCT_TYPE}&precision=scale0&limit=${depth}`
  );
  const ob = res.body?.data;
  if (!ob) return null;
  return {
    bids: (ob.bids || []).map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
    asks: (ob.asks || []).map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
  };
}

// ---------- account ----------

async function getEquity() {
  const res = await request("GET", `/api/v2/mix/account/account?symbol=BTCUSDT&productType=${PRODUCT_TYPE}&marginCoin=USDT`);
  const eq = res.body?.data?.usdtEquity;
  return eq ? parseFloat(eq) : null;
}

async function setLeverage(symbol, leverage /*, side */) {
  return request("POST", "/api/v2/mix/account/set-leverage", {
    symbol,
    productType: PRODUCT_TYPE,
    marginCoin: "USDT",
    leverage: String(leverage),
  });
}

async function getPosition(symbol) {
  const res = await request(
    "GET",
    `/api/v2/mix/position/single-position?symbol=${symbol}&productType=${PRODUCT_TYPE}&marginCoin=USDT`
  );
  const pos = Array.isArray(res.body?.data) ? res.body.data[0] : res.body?.data;
  if (!pos || !(parseFloat(pos.total || 0) > 0)) return null;
  return {
    raw: pos,
    symbol,
    side: (pos.holdSide || "").toUpperCase(),
    size: parseFloat(pos.total || 0),
    entryPrice: parseFloat(pos.openPriceAvg || 0),
    unrealizedPnl: parseFloat(pos.unrealizedPL || 0),
    leverage: parseFloat(pos.leverage || 0),
    liquidationPrice: parseFloat(pos.liquidationPrice || 0),
  };
}

// ---------- orders ----------

async function placeMarketOrder(p) {
  // Bitget does not support atomic SL on this endpoint — slPrice/tpPrice are ignored
  // (caller should set up bot-monitored SL or use place-tpsl-order separately).
  const body = {
    symbol: p.symbol,
    productType: PRODUCT_TYPE,
    marginMode: "isolated",
    marginCoin: "USDT",
    size: String(p.quantity),
    side: p.side === "BUY" ? "buy" : "sell",
    tradeSide: p.reduceOnly ? "close" : "open",
    orderType: "market",
    force: "gtc",
  };
  return request("POST", "/api/v2/mix/order/place-order", body);
}

async function closeMarketPosition({ symbol, side, quantity }) {
  return placeMarketOrder({
    symbol,
    side: side === "LONG" ? "SELL" : "BUY",
    quantity,
    reduceOnly: true,
  });
}

module.exports = {
  name: "bitget",
  getKlines,
  getTickerPrice,
  getOrderbook,
  getEquity,
  setLeverage,
  getPosition,
  placeMarketOrder,
  closeMarketPosition,
};
