/**
 * PEPE/USDT Futures Trading Bot
 * Exchange  : Bitget USDT-M Perpetual Futures
 * AI Engine : Claude AI (Anthropic)
 * Author    : Daffabot2
 *
 * PERINGATAN: Bot ini menggunakan uang sungguhan saat DRY_RUN = false.
 * Selalu test dengan DRY_RUN = true terlebih dahulu!
 */

"use strict";

const crypto   = require("crypto");
const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const readline = require("readline");
const tls      = require("tls");
const dns      = require("dns");
require("dotenv").config();

// ── Bypass DNS hijacking ISP (Indosat/IOH memblokir api.bitget.com) ──────────
// ISP Indonesia sering redirect DNS ke server mereka sendiri.
// Paksa Node.js pakai DNS publik Google + Cloudflare agar resolve ke IP asli.
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1"]);

const HTTPS_AGENT = new https.Agent({
  rejectUnauthorized: true,
  minVersion: "TLSv1.2",
  ca: tls.rootCertificates,
});

// ─────────────────────────────────────────────────────────────
// KONFIGURASI UTAMA
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  // Kredensial API (dari .env)
  API_KEY:    process.env.BITGET_API_KEY    || "",
  SECRET_KEY: process.env.BITGET_SECRET_KEY || "",
  PASSPHRASE: process.env.BITGET_PASSPHRASE || "",

  // Symbol & mode trading
  SYMBOL:           "PEPEUSDT",
  PRODUCT_TYPE:     "USDT-FUTURES",
  MARGIN_COIN:      "USDT",
  MARGIN_MODE:      "isolated",
  DEFAULT_LEVERAGE: 5,
  MAX_LEVERAGE:     10,

  // Ukuran posisi
  POSITION_SIZE_USDT: 10,   // USDT per trade
  MAX_POSITIONS:       1,

  // Risk management
  STOP_LOSS_PCT:    2.0,    // 2% dari entry price
  TAKE_PROFIT_PCT:  3.0,    // 3% dari entry price
  TRAILING_STOP:    true,   // aktifkan trailing stop
  TRAILING_OFFSET:  0.5,    // trailing stop offset 0.5%
  MAX_LOSS_PCT:     5.0,    // force close jika unrealized loss > 5%
  HARD_STOP_TOTAL:  20.0,   // hard stop jika total loss > 20%

  // Funding rate threshold
  FUNDING_RATE_THRESHOLD: 0.001, // 0.1% = pertimbangkan tutup

  // Jadwal
  CHECK_INTERVAL_MS:       10000, // 10 detik
  CLAUDE_ANALYSIS_INTERVAL: 6,    // setiap 6 tick = ~1 menit

  // Batas confidence AI
  OPEN_CONFIDENCE:  75,
  CLOSE_CONFIDENCE: 65,

  // Dry run (WAJIB true saat testing!)
  DRY_RUN: true,

  // Dashboard
  DASHBOARD_PORT: process.env.MONITOR_PORT ? parseInt(process.env.MONITOR_PORT) : 4000,

  // File persistensi
  TRADES_FILE: "trades.json",
  STATS_FILE:  "stats.json",
  STATE_FILE:  "state.json",
};

// ─────────────────────────────────────────────────────────────
// STATE GLOBAL
// ─────────────────────────────────────────────────────────────
let state = {
  activePosition:   null,   // { side, entryPrice, size, leverage, stopLoss, takeProfit, trailingHigh, trailingLow, openTime }
  lastAnalysis:     null,   // response terakhir dari Claude
  lastPrice:        0,
  lastFundingRate:  0,
  lastRSI:          0,
  lastEMA9:         0,
  lastEMA21:        0,
  lastBidAsk:       { bid: 0, ask: 0 },
  tickCount:        0,
  running:          true,
  dashboardClients: [],     // SSE clients
  initialBalance:   0,
  currentBalance:   0,
};

let stats = {
  totalTrades:  0,
  wins:         0,
  losses:       0,
  totalPnL:     0,
  maxDrawdown:  0,
  startTime:    new Date().toISOString(),
};

let tradeLog = [];

// ─────────────────────────────────────────────────────────────
// UTILITAS UMUM
// ─────────────────────────────────────────────────────────────

/** Timestamp singkat untuk log */
function ts() {
  return new Date().toLocaleTimeString("id-ID", { hour12: false });
}

/** Warna ANSI untuk terminal */
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  gray:   "\x1b[90m",
};

function log(level, msg) {
  const colors = { INFO: C.cyan, WARN: C.yellow, ERROR: C.red, TRADE: C.green, AI: C.blue };
  const color  = colors[level] || C.white;
  console.log(`${C.gray}[${ts()}]${C.reset} ${color}[${level}]${C.reset} ${msg}`);
  broadcastSSE({ type: "log", level, msg, time: ts() });
}

/** Request HTTPS */
function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, agent: HTTPS_AGENT }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Request timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

/** Sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// BITGET API SIGNATURE
// ─────────────────────────────────────────────────────────────

function createSignature(timestamp, method, path, body = "") {
  const prehash = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", CONFIG.SECRET_KEY).update(prehash).digest("base64");
}

function getAuthHeaders(method, path, body = "") {
  const timestamp = Date.now().toString();
  const sign = createSignature(timestamp, method, path, body);
  return {
    "ACCESS-KEY":        CONFIG.API_KEY,
    "ACCESS-SIGN":       sign,
    "ACCESS-TIMESTAMP":  timestamp,
    "ACCESS-PASSPHRASE": CONFIG.PASSPHRASE,
    "Content-Type":      "application/json",
    "locale":            "en-US",
  };
}

/** Kirim request ke Bitget API */
async function bitgetRequest(method, endpoint, params = {}, body = null) {
  let path = endpoint;
  if (method === "GET" && Object.keys(params).length > 0) {
    path += "?" + new URLSearchParams(params).toString();
  }

  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = method === "GET" && !CONFIG.API_KEY
    ? { "Content-Type": "application/json" }
    : getAuthHeaders(method, path, bodyStr);

  // Untuk endpoint publik tidak perlu auth
  const isPublic = endpoint.includes("/market/");
  const finalHeaders = isPublic && method === "GET"
    ? { "Content-Type": "application/json", "locale": "en-US" }
    : headers;

  const options = {
    hostname: "api.bitget.com",
    port:     443,
    path,
    method,
    headers:  finalHeaders,
  };

  const response = await httpsRequest(options, bodyStr || null);
  return response;
}

// ─────────────────────────────────────────────────────────────
// MARKET DATA
// ─────────────────────────────────────────────────────────────

async function getTicker() {
  const res = await bitgetRequest("GET", "/api/v2/mix/market/ticker", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
  });
  if (res.code !== "00000") throw new Error(`Ticker error: ${res.msg}`);
  const d = res.data[0];
  return {
    lastPrice: parseFloat(d.lastPr),
    bidPrice:  parseFloat(d.bidPr),
    askPrice:  parseFloat(d.askPr),
    volume24h: parseFloat(d.baseVolume),
    change24h: parseFloat(d.change24h),
    high24h:   parseFloat(d.high24h),
    low24h:    parseFloat(d.low24h),
  };
}

async function getKlines(granularity = "1m", limit = 100) {
  const res = await bitgetRequest("GET", "/api/v2/mix/market/candles", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    granularity,
    limit:       limit.toString(),
  });
  if (res.code !== "00000") throw new Error(`Klines error: ${res.msg}`);
  // Format: [timestamp, open, high, low, close, volume, ...]
  return res.data.map((c) => ({
    time:   parseInt(c[0]),
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  })).reverse(); // Bitget returns newest first
}

async function getFundingRate() {
  const res = await bitgetRequest("GET", "/api/v2/mix/market/current-fund-rate", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
  });
  if (res.code !== "00000") throw new Error(`Funding rate error: ${res.msg}`);
  return parseFloat(res.data[0]?.fundingRate || "0");
}

async function getOrderBook() {
  const res = await bitgetRequest("GET", "/api/v2/mix/market/merge-depth", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
  });
  if (res.code !== "00000") throw new Error(`Order book error: ${res.msg}`);
  const bids = res.data.bids.slice(0, 5).map((b) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
  const asks = res.data.asks.slice(0, 5).map((a) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
  const totalBid = bids.reduce((s, b) => s + b.qty, 0);
  const totalAsk = asks.reduce((s, a) => s + a.qty, 0);
  return { bids, asks, totalBid, totalAsk, bidAskRatio: totalBid / (totalAsk || 1) };
}

async function getFearGreedIndex() {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.alternative.me",
        path:     "/fng/",
        method:   "GET",
      }, (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (!res || !res.data) return { value: 50, classification: "Neutral" };
    return {
      value:          parseInt(res.data[0].value),
      classification: res.data[0].value_classification,
    };
  } catch {
    return { value: 50, classification: "Neutral" };
  }
}

// ─────────────────────────────────────────────────────────────
// AKUN & POSISI (PRIVATE)
// ─────────────────────────────────────────────────────────────

async function getAccountInfo() {
  const res = await bitgetRequest("GET", "/api/v2/mix/account/account", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    marginCoin:  CONFIG.MARGIN_COIN,
  });
  if (res.code !== "00000") throw new Error(`Account error: ${res.msg}`);
  const d = res.data;
  return {
    available:     parseFloat(d.available || "0"),
    equity:        parseFloat(d.accountEquity || "0"),
    unrealizedPnL: parseFloat(d.unrealizedPL || "0"),
  };
}

async function getActivePosition() {
  const res = await bitgetRequest("GET", "/api/v2/mix/position/single-position", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    marginCoin:  CONFIG.MARGIN_COIN,
  });
  if (res.code !== "00000") throw new Error(`Position error: ${res.msg}`);

  const positions = res.data.filter((p) => parseFloat(p.total) > 0);
  if (positions.length === 0) return null;

  const p = positions[0];
  const side        = p.holdSide === "long" ? "LONG" : "SHORT";
  const entryPrice  = parseFloat(p.openPriceAvg);
  const size        = parseFloat(p.total);
  const leverage    = parseInt(p.leverage);
  const liqPrice    = parseFloat(p.liquidationPrice || "0");
  const unrealPnL   = parseFloat(p.unrealizedPL || "0");
  const marginSize  = parseFloat(p.marginSize || "0");
  const pnlPct      = marginSize > 0 ? (unrealPnL / marginSize) * 100 : 0;

  return { side, entryPrice, size, leverage, liqPrice, unrealPnL, pnlPct, marginSize };
}

async function setLeverage(leverage) {
  if (CONFIG.DRY_RUN) {
    log("INFO", `[DRY] Set leverage ${leverage}x`);
    return;
  }
  await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {}, {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    marginCoin:  CONFIG.MARGIN_COIN,
    leverage:    leverage.toString(),
  });
}

async function setMarginMode() {
  if (CONFIG.DRY_RUN) {
    log("INFO", `[DRY] Set margin mode: ${CONFIG.MARGIN_MODE}`);
    return;
  }
  await bitgetRequest("POST", "/api/v2/mix/account/set-margin-mode", {}, {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    marginCoin:  CONFIG.MARGIN_COIN,
    marginMode:  CONFIG.MARGIN_MODE,
  });
}

// ─────────────────────────────────────────────────────────────
// EKSEKUSI ORDER
// ─────────────────────────────────────────────────────────────

/**
 * Hitung jumlah kontrak dari USDT
 * Untuk PEPE futures, 1 kontrak = 100 PEPE (cek specs Bitget)
 * Ukuran order = (USDT × leverage) / harga
 */
function calcOrderSize(price, leverage) {
  const notional = CONFIG.POSITION_SIZE_USDT * leverage;
  const qty = notional / price;
  // PEPE memiliki kontrak minimum, round ke kelipatan tertentu
  // Bitget PEPE contract size biasanya 100 atau 1000
  const CONTRACT_SIZE = 1; // 1 PEPE per contract (check Bitget specs)
  const minQty = 1;
  return Math.max(minQty, Math.floor(qty / CONTRACT_SIZE) * CONTRACT_SIZE);
}

/** Hitung liquidation price */
function calcLiquidationPrice(side, entryPrice, leverage) {
  // Untuk isolated margin:
  // LONG:  liqPrice = entryPrice × (1 - 1/leverage + maintenanceMarginRate)
  // SHORT: liqPrice = entryPrice × (1 + 1/leverage - maintenanceMarginRate)
  const mmr = 0.004; // 0.4% maintenance margin rate (tipikal)
  if (side === "LONG") {
    return entryPrice * (1 - 1 / leverage + mmr);
  } else {
    return entryPrice * (1 + 1 / leverage - mmr);
  }
}

async function openPosition(side, leverage, price) {
  const qty = calcOrderSize(price, leverage);
  const liqPrice = calcLiquidationPrice(side, price, leverage);
  const stopLoss = side === "LONG"
    ? price * (1 - CONFIG.STOP_LOSS_PCT / 100)
    : price * (1 + CONFIG.STOP_LOSS_PCT / 100);
  const takeProfit = side === "LONG"
    ? price * (1 + CONFIG.TAKE_PROFIT_PCT / 100)
    : price * (1 - CONFIG.TAKE_PROFIT_PCT / 100);

  log("TRADE", `${C.bold}BUKA ${side}${C.reset} | Harga: ${price.toFixed(8)} | Qty: ${qty} | Leverage: ${leverage}x`);
  log("TRADE", `  Stop Loss  : ${stopLoss.toFixed(8)} (${CONFIG.STOP_LOSS_PCT}%)`);
  log("TRADE", `  Take Profit: ${takeProfit.toFixed(8)} (${CONFIG.TAKE_PROFIT_PCT}%)`);
  log("TRADE", `  ${C.red}Liquidation: ${liqPrice.toFixed(8)}${C.reset} ← JANGAN BIARKAN SAMPAI SINI!`);

  if (CONFIG.DRY_RUN) {
    log("INFO", `[DRY RUN] Simulasi order ${side} berhasil`);
  } else {
    await setLeverage(leverage);
    const orderSide = side === "LONG" ? "buy" : "sell";
    const res = await bitgetRequest("POST", "/api/v2/mix/order/place-order", {}, {
      symbol:      CONFIG.SYMBOL,
      productType: CONFIG.PRODUCT_TYPE,
      marginMode:  CONFIG.MARGIN_MODE,
      marginCoin:  CONFIG.MARGIN_COIN,
      size:        qty.toString(),
      side:        orderSide,
      tradeSide:   "open",
      orderType:   "market",
      leverage:    leverage.toString(),
    });
    if (res.code !== "00000") {
      log("ERROR", `Gagal buka order: ${res.msg}`);
      return null;
    }
    log("TRADE", `Order sukses! Order ID: ${res.data?.orderId}`);
  }

  // Update state
  state.activePosition = {
    side,
    entryPrice:   price,
    size:         qty,
    leverage,
    stopLoss,
    takeProfit,
    liqPrice,
    trailingHigh: price,   // untuk trailing stop LONG
    trailingLow:  price,   // untuk trailing stop SHORT
    openTime:     new Date().toISOString(),
  };

  saveState();
  recordTrade("OPEN", side, price, qty, leverage, liqPrice);
  return state.activePosition;
}

async function closePosition(reason, currentPrice) {
  if (!state.activePosition) return;

  const pos = state.activePosition;
  const pnlPct = pos.side === "LONG"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
  const pnlUSDT = (CONFIG.POSITION_SIZE_USDT * pnlPct) / 100;

  log("TRADE", `${C.bold}TUTUP ${pos.side}${C.reset} | Alasan: ${reason}`);
  log("TRADE", `  Entry   : ${pos.entryPrice.toFixed(8)}`);
  log("TRADE", `  Exit    : ${currentPrice.toFixed(8)}`);
  log("TRADE", `  PnL     : ${pnlPct >= 0 ? C.green : C.red}${pnlPct.toFixed(2)}% (${pnlUSDT >= 0 ? "+" : ""}${pnlUSDT.toFixed(4)} USDT)${C.reset}`);
  log("TRADE", `  ${C.red}Liq Price was: ${pos.liqPrice.toFixed(8)}${C.reset}`);

  if (!CONFIG.DRY_RUN) {
    const res = await bitgetRequest("POST", "/api/v2/mix/order/close-positions", {}, {
      symbol:      CONFIG.SYMBOL,
      productType: CONFIG.PRODUCT_TYPE,
      holdSide:    pos.side === "LONG" ? "long" : "short",
    });
    if (res.code !== "00000") {
      log("ERROR", `Gagal tutup posisi: ${res.msg}`);
      return;
    }
  } else {
    log("INFO", `[DRY RUN] Simulasi close berhasil`);
  }

  // Update stats
  stats.totalTrades++;
  stats.totalPnL += pnlUSDT;
  if (pnlPct >= 0) stats.wins++; else stats.losses++;
  if (stats.totalPnL < stats.maxDrawdown) stats.maxDrawdown = stats.totalPnL;

  recordTrade("CLOSE", pos.side, currentPrice, pos.size, pos.leverage, pos.liqPrice, reason, pnlUSDT);
  state.activePosition = null;
  saveState();
  saveStats();
}

// ─────────────────────────────────────────────────────────────
// INDIKATOR TEKNIKAL
// ─────────────────────────────────────────────────────────────

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcIndicators(klines) {
  const closes  = klines.map((k) => k.close);
  const volumes  = klines.map((k) => k.volume);
  const avgVol  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];

  return {
    rsi:       calcRSI(closes),
    ema9:      calcEMA(closes, 9),
    ema21:     calcEMA(closes, 21),
    avgVolume: avgVol,
    lastVolume: lastVol,
    volumeRatio: lastVol / avgVol,
    closes,
  };
}

// ─────────────────────────────────────────────────────────────
// CLAUDE AI ANALYSIS
// ─────────────────────────────────────────────────────────────

async function analyzeWithClaude(marketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log("ERROR", "ANTHROPIC_API_KEY tidak ditemukan di .env!");
    return null;
  }

  const prompt = `Kamu adalah AI trading bot untuk PEPE/USDT futures di Bitget. Analisis data pasar berikut dan berikan keputusan trading.

## Data Pasar Saat Ini
- Harga terakhir : ${marketData.price.toFixed(8)} USDT
- Bid/Ask        : ${marketData.bid.toFixed(8)} / ${marketData.ask.toFixed(8)}
- Volume 24j     : ${marketData.volume24h.toLocaleString()}
- Perubahan 24j  : ${marketData.change24h > 0 ? "+" : ""}${(marketData.change24h * 100).toFixed(2)}%

## Indikator Teknikal (1m candle)
- RSI (14)       : ${marketData.rsi.toFixed(2)}
- EMA 9          : ${marketData.ema9.toFixed(8)}
- EMA 21         : ${marketData.ema21.toFixed(8)}
- Rasio Volume   : ${marketData.volumeRatio.toFixed(2)}x (>1 = volume tinggi)

## Order Book
- Total Bid      : ${marketData.orderBook.totalBid.toFixed(0)}
- Total Ask      : ${marketData.orderBook.totalAsk.toFixed(0)}
- Bid/Ask Ratio  : ${marketData.orderBook.bidAskRatio.toFixed(3)} (>1 = tekanan beli)

## Funding Rate
- Saat ini       : ${(marketData.fundingRate * 100).toFixed(4)}%
- Interpretasi   : ${marketData.fundingRate > 0 ? "Positif → long bayar short" : "Negatif → short bayar long"}
- Threshold      : >0.1% pertimbangkan tutup posisi

## Sentimen Pasar
- Fear & Greed Index: ${marketData.fearGreed.value} (${marketData.fearGreed.classification})

## Posisi Aktif
${marketData.activePosition
  ? `- Side          : ${marketData.activePosition.side}
- Entry Price   : ${marketData.activePosition.entryPrice.toFixed(8)}
- Leverage      : ${marketData.activePosition.leverage}x
- Unrealized PnL: ${marketData.activePosition.unrealPnL !== undefined ? (marketData.activePosition.unrealPnL >= 0 ? "+" : "") + marketData.activePosition.unrealPnL.toFixed(4) + " USDT" : "N/A"}
- PnL %         : ${marketData.activePosition.pnlPct !== undefined ? (marketData.activePosition.pnlPct >= 0 ? "+" : "") + marketData.activePosition.pnlPct.toFixed(2) + "%" : "N/A"}
- Liquidation   : ${marketData.activePosition.liqPrice ? marketData.activePosition.liqPrice.toFixed(8) : "N/A"} ← KRITIS!`
  : "- Tidak ada posisi aktif"}

## Instruksi
Berikan analisis dan keputusan dalam format JSON berikut (HANYA JSON, tanpa teks lain):
{
  "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
  "leverage": <angka 5-10>,
  "confidence": <0-100>,
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE",
  "stop_loss_pct": <0.5-3.0>,
  "take_profit_pct": <1.0-5.0>,
  "reasoning": "<max 80 kata bahasa Indonesia>"
}

Rules:
- LONG  → rekomendasikan jika harga diprediksi NAIK
- SHORT → rekomendasikan jika harga diprediksi TURUN
- CLOSE → rekomendasikan tutup posisi aktif
- HOLD  → jangan buka/tutup posisi
- confidence ≥ 75 untuk buka posisi baru
- confidence ≥ 65 untuk tutup posisi
- Pertimbangkan funding rate saat ada posisi aktif
`;

  const bodyStr = JSON.stringify({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages:   [{ role: "user", content: prompt }],
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.anthropic.com",
        path:     "/v1/messages",
        method:   "POST",
        agent:    HTTPS_AGENT,   // pakai DNS bypass yang sama
        headers:  {
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error("Claude API timeout")); });
      req.write(bodyStr);
      req.end();
    });

    // Tampilkan detail error dari API agar mudah debug
    if (!result) {
      log("ERROR", "Respons Claude null (parse gagal atau koneksi putus)");
      return null;
    }
    if (result.type === "error") {
      log("ERROR", `Claude API error: [${result.error?.type}] ${result.error?.message}`);
      return null;
    }
    if (!result.content || !result.content[0]) {
      log("ERROR", `Respons Claude tidak terduga: ${JSON.stringify(result).substring(0, 200)}`);
      return null;
    }

    const text = result.content[0].text.trim();
    // Ekstrak JSON dari respons
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log("ERROR", `Claude tidak mengembalikan JSON valid: ${text.substring(0, 100)}`);
      return null;
    }
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    log("ERROR", `Error saat memanggil Claude: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// LOGIKA TRADING UTAMA
// ─────────────────────────────────────────────────────────────

async function tradingLoop() {
  state.tickCount++;

  // ── 1. Ambil data market ──────────────────────────────────
  let ticker, klines, fundingRate, orderBook, fearGreed;
  try {
    [ticker, klines, fundingRate, orderBook, fearGreed] = await Promise.all([
      getTicker(),
      getKlines("1m", 50),
      getFundingRate(),
      getOrderBook(),
      getFearGreedIndex(),
    ]);
  } catch (err) {
    log("ERROR", `Gagal ambil data market: ${err.message}`);
    return;
  }

  const price = ticker.lastPrice;
  state.lastPrice       = price;
  state.lastFundingRate = fundingRate;
  state.lastBidAsk      = { bid: ticker.bidPrice, ask: ticker.askPrice };

  const indicators = calcIndicators(klines);
  state.lastRSI  = indicators.rsi;
  state.lastEMA9 = indicators.ema9;
  state.lastEMA21 = indicators.ema21;

  // ── 2. Cek posisi aktif (live mode) ──────────────────────
  let livePosition = null;
  if (!CONFIG.DRY_RUN && CONFIG.API_KEY) {
    try {
      livePosition = await getActivePosition();
      if (livePosition) {
        // Sync state dengan posisi live
        if (state.activePosition) {
          state.activePosition.liqPrice  = livePosition.liqPrice;
          state.activePosition.unrealPnL = livePosition.unrealPnL;
          state.activePosition.pnlPct    = livePosition.pnlPct;
        }
      }
    } catch (err) {
      log("WARN", `Gagal ambil posisi live: ${err.message}`);
    }
  }

  const pos = state.activePosition;

  // ── 3. Tampilkan status di log ────────────────────────────
  if (state.tickCount % 3 === 0) { // setiap 30 detik
    log("INFO", `Harga: ${C.bold}${price.toFixed(8)}${C.reset} USDT | RSI: ${indicators.rsi.toFixed(1)} | EMA9: ${indicators.ema9.toFixed(8)} | EMA21: ${indicators.ema21.toFixed(8)}`);
    log("INFO", `Funding: ${(fundingRate * 100).toFixed(4)}% | F&G: ${fearGreed.value} (${fearGreed.classification}) | Vol: ${indicators.volumeRatio.toFixed(2)}x`);
    if (pos) {
      const pnlPct = pos.side === "LONG"
        ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage;
      const pnlColor = pnlPct >= 0 ? C.green : C.red;
      log("INFO", `Posisi: ${pos.side} | Entry: ${pos.entryPrice.toFixed(8)} | PnL: ${pnlColor}${pnlPct.toFixed(2)}%${C.reset}`);
      log("INFO", `  ${C.red}LIQUIDATION: ${pos.liqPrice.toFixed(8)}${C.reset} | SL: ${pos.stopLoss.toFixed(8)} | TP: ${pos.takeProfit.toFixed(8)}`);
    }
  }

  // ── 4. Risk management checks ─────────────────────────────
  if (pos) {
    const pnlPct = pos.side === "LONG"
      ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
      : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage;

    // Update trailing stop
    if (CONFIG.TRAILING_STOP) {
      if (pos.side === "LONG") {
        if (price > pos.trailingHigh) {
          pos.trailingHigh = price;
          pos.stopLoss = pos.trailingHigh * (1 - CONFIG.TRAILING_OFFSET / 100);
        }
      } else {
        if (price < pos.trailingLow) {
          pos.trailingLow = price;
          pos.stopLoss = pos.trailingLow * (1 + CONFIG.TRAILING_OFFSET / 100);
        }
      }
    }

    // Take Profit
    if ((pos.side === "LONG" && price >= pos.takeProfit) ||
        (pos.side === "SHORT" && price <= pos.takeProfit)) {
      log("TRADE", `${C.green}TAKE PROFIT tercapai!${C.reset}`);
      await closePosition("TAKE_PROFIT", price);
      return;
    }

    // Stop Loss
    if ((pos.side === "LONG" && price <= pos.stopLoss) ||
        (pos.side === "SHORT" && price >= pos.stopLoss)) {
      log("TRADE", `${C.yellow}STOP LOSS tercapai!${C.reset}`);
      await closePosition("STOP_LOSS", price);
      return;
    }

    // Force close jika rugi > MAX_LOSS_PCT
    if (pnlPct < -CONFIG.MAX_LOSS_PCT) {
      log("TRADE", `${C.red}FORCE CLOSE! Rugi melebihi ${CONFIG.MAX_LOSS_PCT}%${C.reset}`);
      await closePosition("FORCE_CLOSE_MAX_LOSS", price);
      return;
    }

    // Funding rate terlalu tinggi
    if (Math.abs(fundingRate) > CONFIG.FUNDING_RATE_THRESHOLD) {
      const fundingDirection = fundingRate > 0 ? "LONG" : "SHORT";
      if (pos.side === fundingDirection) {
        log("WARN", `Funding rate tinggi (${(fundingRate * 100).toFixed(4)}%) — posisi ${pos.side} membayar. Pertimbangkan tutup.`);
      }
    }
  }

  // ── 5. Claude AI Analysis ─────────────────────────────────
  const shouldAnalyze = state.tickCount % CONFIG.CLAUDE_ANALYSIS_INTERVAL === 0;
  if (!shouldAnalyze) {
    broadcastSSE({ type: "tick", price, rsi: indicators.rsi, ema9: indicators.ema9, ema21: indicators.ema21,
                   fundingRate, fearGreed, position: pos });
    return;
  }

  log("AI", "Meminta analisis dari Claude AI...");

  const marketData = {
    price:          price,
    bid:            ticker.bidPrice,
    ask:            ticker.askPrice,
    volume24h:      ticker.volume24h,
    change24h:      ticker.change24h,
    rsi:            indicators.rsi,
    ema9:           indicators.ema9,
    ema21:          indicators.ema21,
    volumeRatio:    indicators.volumeRatio,
    orderBook,
    fundingRate,
    fearGreed,
    activePosition: pos ? {
      side:       pos.side,
      entryPrice: pos.entryPrice,
      leverage:   pos.leverage,
      liqPrice:   pos.liqPrice,
      unrealPnL:  livePosition ? livePosition.unrealPnL : undefined,
      pnlPct:     livePosition ? livePosition.pnlPct    : undefined,
    } : null,
  };

  const analysis = await analyzeWithClaude(marketData);
  if (!analysis) return;

  state.lastAnalysis = analysis;
  log("AI", `Action: ${C.bold}${analysis.action}${C.reset} | Confidence: ${analysis.confidence}% | Sentiment: ${analysis.sentiment} | Leverage: ${analysis.leverage}x`);
  log("AI", `Alasan: ${analysis.reasoning}`);

  // ── 6. Eksekusi keputusan ─────────────────────────────────

  // Tidak ada posisi aktif → coba buka
  if (!pos) {
    if ((analysis.action === "LONG" || analysis.action === "SHORT") &&
        analysis.confidence >= CONFIG.OPEN_CONFIDENCE) {

      const leverage = Math.min(Math.max(analysis.leverage || CONFIG.DEFAULT_LEVERAGE, CONFIG.DEFAULT_LEVERAGE), CONFIG.MAX_LEVERAGE);
      log("TRADE", `Membuka posisi ${analysis.action} dengan leverage ${leverage}x...`);
      await openPosition(analysis.action, leverage, price);

      // Override stop/tp dari AI jika lebih konservatif
      if (state.activePosition) {
        const slPct = Math.min(analysis.stop_loss_pct || CONFIG.STOP_LOSS_PCT, CONFIG.STOP_LOSS_PCT);
        const tpPct = Math.max(analysis.take_profit_pct || CONFIG.TAKE_PROFIT_PCT, CONFIG.TAKE_PROFIT_PCT);
        state.activePosition.stopLoss = analysis.action === "LONG"
          ? price * (1 - slPct / 100)
          : price * (1 + slPct / 100);
        state.activePosition.takeProfit = analysis.action === "LONG"
          ? price * (1 + tpPct / 100)
          : price * (1 - tpPct / 100);
      }
    } else {
      log("INFO", `HOLD — Confidence: ${analysis.confidence}% (butuh ≥${CONFIG.OPEN_CONFIDENCE}%)`);
    }

  // Ada posisi aktif → cek apakah perlu tutup
  } else {
    if (analysis.action === "CLOSE" && analysis.confidence >= CONFIG.CLOSE_CONFIDENCE) {
      log("TRADE", `Claude rekomendasikan CLOSE (confidence: ${analysis.confidence}%)`);
      await closePosition("CLAUDE_CLOSE", price);
    } else {
      log("INFO", `Posisi dipertahankan — Claude: ${analysis.action} (${analysis.confidence}%)`);
    }
  }

  broadcastSSE({
    type:     "analysis",
    price,
    rsi:      indicators.rsi,
    ema9:     indicators.ema9,
    ema21:    indicators.ema21,
    fundingRate,
    fearGreed,
    analysis,
    position: state.activePosition,
  });
}

// ─────────────────────────────────────────────────────────────
// PERSISTENSI DATA
// ─────────────────────────────────────────────────────────────

function saveState() {
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify({ activePosition: state.activePosition }, null, 2));
}

function saveStats() {
  fs.writeFileSync(CONFIG.STATS_FILE, JSON.stringify(stats, null, 2));
}

function recordTrade(type, side, price, size, leverage, liqPrice, reason = "", pnlUSDT = 0) {
  const trade = {
    type, side, price, size, leverage, liqPrice, reason, pnlUSDT,
    time: new Date().toISOString(),
  };
  tradeLog.push(trade);
  fs.writeFileSync(CONFIG.TRADES_FILE, JSON.stringify(tradeLog, null, 2));
}

function loadPersistedData() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
      if (saved.activePosition) {
        state.activePosition = saved.activePosition;
        log("INFO", `Posisi aktif dipulihkan dari file: ${saved.activePosition.side} @ ${saved.activePosition.entryPrice}`);
      }
    }
    if (fs.existsSync(CONFIG.STATS_FILE)) {
      stats = { ...stats, ...JSON.parse(fs.readFileSync(CONFIG.STATS_FILE, "utf8")) };
    }
    if (fs.existsSync(CONFIG.TRADES_FILE)) {
      tradeLog = JSON.parse(fs.readFileSync(CONFIG.TRADES_FILE, "utf8"));
    }
  } catch (err) {
    log("WARN", `Gagal load data tersimpan: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD HTTP + SSE
// ─────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PEPE Futures Bot | Daffabot2</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: 'Courier New', monospace; font-size: 13px; }
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
    .header h1 { color: #58a6ff; font-size: 18px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #3fb950; animation: blink 1s infinite; }
    @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
    .dry-badge { background: #f0883e33; color: #f0883e; padding: 2px 8px; border-radius: 4px; font-size: 11px; border: 1px solid #f0883e55; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; }
    .card h3 { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
    .big-price { font-size: 32px; font-weight: bold; color: #58a6ff; }
    .row { display: flex; justify-content: space-between; margin: 4px 0; }
    .label { color: #8b949e; }
    .val { color: #c9d1d9; }
    .green { color: #3fb950; }
    .red { color: #f85149; }
    .yellow { color: #d29922; }
    .blue { color: #58a6ff; }
    .position-card { border-color: #388bfd55; }
    .no-pos { color: #8b949e; text-align: center; padding: 20px; }
    .liq-warning { background: #f8514922; border: 1px solid #f8514966; border-radius: 4px; padding: 6px 10px; margin-top: 8px; color: #f85149; font-size: 12px; }
    #log-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin: 0 12px 12px; padding: 10px; height: 200px; overflow-y: auto; font-size: 11px; }
    .log-line { padding: 2px 0; border-bottom: 1px solid #21262d; }
    .log-TRADE { color: #3fb950; }
    .log-AI    { color: #58a6ff; }
    .log-ERROR { color: #f85149; }
    .log-WARN  { color: #d29922; }
    .log-INFO  { color: #8b949e; }
    .ai-card { grid-column: 1 / -1; }
    .confidence-bar { background: #21262d; height: 6px; border-radius: 3px; margin-top: 6px; overflow: hidden; }
    .confidence-fill { height: 100%; border-radius: 3px; background: #3fb950; transition: width 0.5s; }
    .action-badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-bottom: 8px; }
    .action-LONG  { background: #3fb95033; color: #3fb950; border: 1px solid #3fb95066; }
    .action-SHORT { background: #f8514933; color: #f85149; border: 1px solid #f8514966; }
    .action-HOLD  { background: #8b949e33; color: #8b949e; border: 1px solid #8b949e66; }
    .action-CLOSE { background: #d2992233; color: #d29922; border: 1px solid #d2992266; }
    .stats-row { display: flex; gap: 16px; flex-wrap: wrap; }
    .stat-item { text-align: center; flex: 1; min-width: 80px; }
    .stat-num  { font-size: 20px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="header">
    <div class="dot"></div>
    <h1>PEPE/USDT Futures Bot</h1>
    <span id="dry-badge" class="dry-badge" style="display:none">DRY RUN</span>
  </div>

  <div class="grid">
    <!-- Harga -->
    <div class="card">
      <h3>Harga Real-time</h3>
      <div class="big-price" id="price">--</div>
      <div class="row"><span class="label">Bid</span><span id="bid" class="val">--</span></div>
      <div class="row"><span class="label">Ask</span><span id="ask" class="val">--</span></div>
      <div class="row"><span class="label">Funding Rate</span><span id="funding" class="val">--</span></div>
      <div class="row"><span class="label">Fear & Greed</span><span id="feargreed" class="val">--</span></div>
    </div>

    <!-- Indikator -->
    <div class="card">
      <h3>Indikator Teknikal</h3>
      <div class="row"><span class="label">RSI (14)</span><span id="rsi" class="val">--</span></div>
      <div class="row"><span class="label">EMA 9</span><span id="ema9" class="val">--</span></div>
      <div class="row"><span class="label">EMA 21</span><span id="ema21" class="val">--</span></div>
    </div>

    <!-- Posisi aktif -->
    <div class="card position-card">
      <h3>Posisi Aktif</h3>
      <div id="position-content"><div class="no-pos">Tidak ada posisi aktif</div></div>
    </div>

    <!-- Stats -->
    <div class="card">
      <h3>Statistik</h3>
      <div class="stats-row">
        <div class="stat-item"><div class="stat-num green" id="wins">0</div><div class="label">Win</div></div>
        <div class="stat-item"><div class="stat-num red" id="losses">0</div><div class="label">Loss</div></div>
        <div class="stat-item"><div class="stat-num blue" id="winrate">0%</div><div class="label">Win Rate</div></div>
        <div class="stat-item"><div class="stat-num" id="pnl">0</div><div class="label">PnL (USDT)</div></div>
      </div>
    </div>

    <!-- AI Analysis -->
    <div class="card ai-card">
      <h3>Analisis Claude AI Terakhir</h3>
      <div id="ai-content"><div class="no-pos">Menunggu analisis pertama...</div></div>
    </div>
  </div>

  <!-- Log -->
  <div id="log-box"></div>

  <script>
    const isDryRun = true; // akan diupdate oleh server
    document.getElementById('dry-badge').style.display = 'inline';

    const sse = new EventSource('/events');
    sse.onmessage = (e) => {
      try { handle(JSON.parse(e.data)); } catch {}
    };

    function fmt(n, dec = 8) { return Number(n).toFixed(dec); }
    function fmtPct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }

    function handle(d) {
      if (d.price) {
        document.getElementById('price').textContent = fmt(d.price);
      }
      if (d.rsi !== undefined) {
        const rsiEl = document.getElementById('rsi');
        rsiEl.textContent = Number(d.rsi).toFixed(2);
        rsiEl.className = d.rsi > 70 ? 'val red' : d.rsi < 30 ? 'val green' : 'val';
      }
      if (d.ema9)  document.getElementById('ema9').textContent  = fmt(d.ema9);
      if (d.ema21) document.getElementById('ema21').textContent = fmt(d.ema21);
      if (d.fundingRate !== undefined) {
        const fr = (d.fundingRate * 100).toFixed(4) + '%';
        const el = document.getElementById('funding');
        el.textContent = fr;
        el.className = Math.abs(d.fundingRate) > 0.001 ? 'val red' : 'val';
      }
      if (d.fearGreed) {
        document.getElementById('feargreed').textContent = d.fearGreed.value + ' (' + d.fearGreed.classification + ')';
      }

      if (d.position) {
        renderPosition(d.position, d.price);
      } else if (d.type === 'analysis' && !d.position) {
        document.getElementById('position-content').innerHTML = '<div class="no-pos">Tidak ada posisi aktif</div>';
      }

      if (d.analysis) renderAI(d.analysis);

      if (d.type === 'log') addLog(d);

      if (d.type === 'stats') renderStats(d);
    }

    function renderPosition(pos, price) {
      const pnlPct = pos.side === 'LONG'
        ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage;
      const pnlClass = pnlPct >= 0 ? 'green' : 'red';
      document.getElementById('position-content').innerHTML = \`
        <div class="row"><span class="label">Side</span><span class="val \${pos.side === 'LONG' ? 'green' : 'red'}">\${pos.side}</span></div>
        <div class="row"><span class="label">Entry</span><span class="val">\${fmt(pos.entryPrice)}</span></div>
        <div class="row"><span class="label">Leverage</span><span class="val">\${pos.leverage}x</span></div>
        <div class="row"><span class="label">Stop Loss</span><span class="val yellow">\${fmt(pos.stopLoss)}</span></div>
        <div class="row"><span class="label">Take Profit</span><span class="val green">\${fmt(pos.takeProfit)}</span></div>
        <div class="row"><span class="label">PnL</span><span class="val \${pnlClass}">\${fmtPct(pnlPct)}</span></div>
        <div class="liq-warning">⚠ LIQUIDATION: \${fmt(pos.liqPrice)} — jangan biarkan harga mencapai ini!</div>
      \`;
    }

    function renderAI(a) {
      if (!a) return;
      const conf = Math.min(100, Math.max(0, a.confidence || 0));
      const fillColor = conf >= 75 ? '#3fb950' : conf >= 50 ? '#d29922' : '#f85149';
      document.getElementById('ai-content').innerHTML = \`
        <span class="action-badge action-\${a.action}">\${a.action}</span>
        <span style="margin-left:8px;color:#8b949e">\${a.sentiment}</span>
        <div class="row" style="margin-top:6px"><span class="label">Confidence</span><span class="val">\${conf}%</span></div>
        <div class="confidence-bar"><div class="confidence-fill" style="width:\${conf}%;background:\${fillColor}"></div></div>
        <div class="row" style="margin-top:6px"><span class="label">SL / TP</span><span class="val">\${a.stop_loss_pct}% / \${a.take_profit_pct}%</span></div>
        <div style="margin-top:8px;color:#8b949e;font-size:12px">\${a.reasoning || ''}</div>
      \`;
    }

    function addLog(d) {
      const box = document.getElementById('log-box');
      const div = document.createElement('div');
      div.className = 'log-line log-' + d.level;
      div.textContent = '[' + d.time + '] [' + d.level + '] ' + d.msg;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      // Max 200 baris
      while (box.children.length > 200) box.removeChild(box.firstChild);
    }

    function renderStats(s) {
      document.getElementById('wins').textContent    = s.wins || 0;
      document.getElementById('losses').textContent  = s.losses || 0;
      const wr = s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(1) : '0';
      document.getElementById('winrate').textContent = wr + '%';
      const pnl = (s.totalPnL || 0).toFixed(4);
      const pnlEl = document.getElementById('pnl');
      pnlEl.textContent = (s.totalPnL >= 0 ? '+' : '') + pnl;
      pnlEl.className = 'stat-num ' + (s.totalPnL >= 0 ? 'green' : 'red');
    }
  </script>
</body>
</html>`;

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  state.dashboardClients = state.dashboardClients.filter((res) => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

function startDashboard() {
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("data: {\"type\":\"connected\"}\n\n");
      state.dashboardClients.push(res);

      // Kirim state awal
      res.write(`data: ${JSON.stringify({
        type:       "init",
        price:      state.lastPrice,
        rsi:        state.lastRSI,
        ema9:       state.lastEMA9,
        ema21:      state.lastEMA21,
        fundingRate: state.lastFundingRate,
        position:   state.activePosition,
        stats,
      })}\n\n`);

      req.on("close", () => {
        state.dashboardClients = state.dashboardClients.filter((c) => c !== res);
      });
    } else if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: { lastPrice: state.lastPrice, activePosition: state.activePosition }, stats }));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
    }
  });

  server.listen(CONFIG.DASHBOARD_PORT, () => {
    log("INFO", `Dashboard aktif di http://localhost:${CONFIG.DASHBOARD_PORT}`);
  });

  // Kirim stats setiap 30 detik
  setInterval(() => {
    broadcastSSE({ type: "stats", ...stats });
  }, 30000);
}

// ─────────────────────────────────────────────────────────────
// STARTUP & MAIN LOOP
// ─────────────────────────────────────────────────────────────

function printBanner() {
  console.clear();
  console.log(`${C.cyan}${C.bold}`);
  console.log("  ██████╗ ███████╗██████╗ ███████╗    ██████╗  ██████╗ ████████╗");
  console.log("  ██╔══██╗██╔════╝██╔══██╗██╔════╝    ██╔══██╗██╔═══██╗╚══██╔══╝");
  console.log("  ██████╔╝█████╗  ██████╔╝█████╗      ██████╔╝██║   ██║   ██║   ");
  console.log("  ██╔═══╝ ██╔══╝  ██╔═══╝ ██╔══╝      ██╔══██╗██║   ██║   ██║   ");
  console.log("  ██║     ███████╗██║     ███████╗    ██████╔╝╚██████╔╝   ██║   ");
  console.log("  ╚═╝     ╚══════╝╚═╝     ╚══════╝    ╚═════╝  ╚═════╝    ╚═╝   ");
  console.log(`${C.reset}`);
  console.log(`  ${C.yellow}PEPE/USDT Futures Trading Bot — Daffabot2${C.reset}`);
  console.log(`  ${C.gray}Exchange: Bitget USDT-M Perpetual | AI: Claude AI${C.reset}`);
  console.log();
}

async function validateConfig() {
  const errors = [];
  if (!process.env.ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY tidak ada di .env!");
  if (!CONFIG.DRY_RUN) {
    if (!CONFIG.API_KEY)    errors.push("BITGET_API_KEY tidak ada di .env!");
    if (!CONFIG.SECRET_KEY) errors.push("BITGET_SECRET_KEY tidak ada di .env!");
    if (!CONFIG.PASSPHRASE) errors.push("BITGET_PASSPHRASE tidak ada di .env!");
  }
  if (errors.length > 0) {
    errors.forEach((e) => log("ERROR", e));
    return false;
  }
  return true;
}

async function main() {
  printBanner();

  log("INFO", `Mode        : ${CONFIG.DRY_RUN ? C.yellow + "DRY RUN (simulasi)" + C.reset : C.red + "LIVE TRADING!" + C.reset}`);
  log("INFO", `Pair        : ${CONFIG.SYMBOL}`);
  log("INFO", `Leverage    : ${CONFIG.DEFAULT_LEVERAGE}x - ${CONFIG.MAX_LEVERAGE}x (AI yang tentukan)`);
  log("INFO", `Ukuran Posisi: ${CONFIG.POSITION_SIZE_USDT} USDT`);
  log("INFO", `Stop Loss   : ${CONFIG.STOP_LOSS_PCT}% | Take Profit: ${CONFIG.TAKE_PROFIT_PCT}%`);
  log("INFO", `Interval    : ${CONFIG.CHECK_INTERVAL_MS / 1000}s | AI tiap: ${(CONFIG.CHECK_INTERVAL_MS * CONFIG.CLAUDE_ANALYSIS_INTERVAL) / 1000}s`);
  console.log();

  const ok = await validateConfig();
  if (!ok) {
    log("ERROR", "Bot berhenti karena konfigurasi tidak lengkap.");
    process.exit(1);
  }

  // Load data tersimpan
  loadPersistedData();

  // Setup margin mode (live only)
  if (!CONFIG.DRY_RUN && CONFIG.API_KEY) {
    try {
      await setMarginMode();
      log("INFO", `Margin mode diset ke: ${CONFIG.MARGIN_MODE}`);
    } catch (err) {
      log("WARN", `Gagal set margin mode: ${err.message}`);
    }
  }

  // Mulai dashboard
  startDashboard();

  log("INFO", "Bot trading dimulai! Tekan Ctrl+C untuk berhenti.");
  console.log();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log();
    log("WARN", "Menerima sinyal berhenti...");
    state.running = false;

    if (state.activePosition && !CONFIG.DRY_RUN) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Ada posisi aktif! Tutup posisi sekarang? (y/n): ", async (answer) => {
        if (answer.toLowerCase() === "y") {
          log("TRADE", "Menutup posisi aktif sebelum berhenti...");
          await closePosition("MANUAL_STOP", state.lastPrice);
        }
        rl.close();
        saveStats();
        log("INFO", `Total PnL: ${stats.totalPnL.toFixed(4)} USDT | Win Rate: ${stats.totalTrades > 0 ? ((stats.wins / stats.totalTrades) * 100).toFixed(1) : 0}%`);
        process.exit(0);
      });
    } else {
      saveStats();
      log("INFO", `Total PnL: ${stats.totalPnL.toFixed(4)} USDT | Win Rate: ${stats.totalTrades > 0 ? ((stats.wins / stats.totalTrades) * 100).toFixed(1) : 0}%`);
      process.exit(0);
    }
  });

  // Main trading loop
  while (state.running) {
    try {
      await tradingLoop();
    } catch (err) {
      log("ERROR", `Error di trading loop: ${err.message}`);
      if (err.stack) log("ERROR", err.stack.split("\n")[1]);
    }
    await sleep(CONFIG.CHECK_INTERVAL_MS);
  }
}

main();
