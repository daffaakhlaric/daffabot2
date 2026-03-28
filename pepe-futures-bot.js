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
  POSITION_SIZE_USDT: 3,   // USDT per trade
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
  DRY_RUN: false,

  // Dashboard
  DASHBOARD_PORT: process.env.MONITOR_PORT ? parseInt(process.env.MONITOR_PORT) : 4000,

  // File persistensi
  TRADES_FILE: "trades.json",
  STATS_FILE:  "stats.json",
  STATE_FILE:  "state.json",

  // ── Fitur #1: Multi-Timeframe Analysis ────────────────────
  REQUIRE_MTF_CONSENSUS: true,   // false = matikan fitur MTF

  // ── Fitur #2: Bollinger Bands ─────────────────────────────
  BB_PERIOD:  20,
  BB_STDDEV:  2,

  // ── Fitur #3: VWAP ────────────────────────────────────────
  VWAP_BIAS_THRESHOLD: 0.5,   // % di atas/bawah VWAP untuk bias

  // ── Fitur #5: Partial Close ───────────────────────────────
  PARTIAL_CLOSE_ENABLED: true,
  PARTIAL_CLOSE_PCT:     50,    // tutup 50% posisi
  PARTIAL_CLOSE_TRIGGER: 1.5,   // trigger saat profit ≥ 1.5%

  // ── Fitur #6: Auto Compound ───────────────────────────────
  AUTO_COMPOUND:       true,
  COMPOUND_MIN_PROFIT: 0.5,   // compound mulai kalau profit > 0.5 USDT
  COMPOUND_RATIO:      0.5,   // 50% profit di-compound
  MAX_POSITION_USDT:   50,    // batas maksimal posisi setelah compound

  // ── Fitur #7: Auto Pause saat Market Crash ────────────────
  AUTO_PAUSE_ENABLED:   true,
  PAUSE_BTC_DROP_PCT:   5.0,      // pause kalau BTC turun > 5% dalam 1 jam
  PAUSE_PEPE_DROP_PCT:  10.0,     // pause kalau PEPE turun > 10% dalam 1 jam
  PAUSE_DURATION_MS:    3600000,  // pause 1 jam

  // ── Fitur #9: Backtest ────────────────────────────────────
  BACKTEST_MODE:      false,
  BACKTEST_DAYS:      7,
  BACKTEST_SYMBOL:    "PEPEUSDT",
  BACKTEST_TIMEFRAME: "1m",
};

// ─────────────────────────────────────────────────────────────
// STATE GLOBAL
// ─────────────────────────────────────────────────────────────
let state = {
  activePosition:   null,   // { side, entryPrice, size, leverage, stopLoss, takeProfit, trailingHigh, trailingLow, openTime, partialClosed }
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
  available:        0,
  unrealizedPnL:    0,
  // Fitur #7: Auto Pause
  pausedUntil:      null,
  pauseReason:      "",
  // Balance Monitoring
  balanceHistory:   [],
  lastBalanceUpdate: 0,
  peakBalance:      0,
  lowestBalance:    0,
};

let stats = {
  totalTrades:   0,
  wins:          0,
  losses:        0,
  totalPnL:      0,
  maxDrawdown:   0,
  startTime:     new Date().toISOString(),
  // Fitur #8: Win Rate Tracker
  recentTrades:  [],   // 20 trade terakhir
  winRate7d:     0,
  avgProfitPct:  0,
  avgLossPct:    0,
  currentStreak: 0,   // + = win streak, - = loss streak
};

let tradeLog = [];
// Fitur #6: balance yang di-compound setelah tiap trade
let compoundedBalance = CONFIG.POSITION_SIZE_USDT;

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
  const candles = res.data.map((c) => ({
    time:   parseInt(c[0]),
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  })).reverse(); // Bitget returns newest first → reverse ke oldest first

  // BUG #6 FIX: validasi urutan agar RSI/EMA dihitung oldest→newest
  if (candles.length >= 2 && candles[0].time > candles[candles.length - 1].time) {
    log("WARN", "Klines urutan terbalik! Re-reverse...");
    candles.reverse();
  }
  return candles;
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

/** Fear & Greed dengan tren 7 hari */
async function getFearGreedIndex() {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.alternative.me",
        path:     "/fng/?limit=7",
        method:   "GET",
        headers:  { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      }, (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });

    const data = res?.data || [];
    if (data.length === 0) return { value: 50, classification: "Neutral", trend: "STABLE", avg7d: 50, yesterday: 50 };

    const latest    = parseInt(data[0].value);
    const oldest    = parseInt(data[data.length - 1].value);
    const yesterday = parseInt(data[1]?.value || latest);
    const avg7d     = Math.round(data.reduce((s, d) => s + parseInt(d.value), 0) / data.length);
    const trend     = latest > oldest + 5 ? "IMPROVING" : latest < oldest - 5 ? "WORSENING" : "STABLE";

    return { value: latest, classification: data[0].value_classification, trend, avg7d, yesterday };
  } catch {
    return { value: 50, classification: "Neutral", trend: "STABLE", avg7d: 50, yesterday: 50 };
  }
}

// ─────────────────────────────────────────────────────────────
// SOURCE DATA EKSTERNAL (CoinGecko, CMC, Fear & Greed)
// ─────────────────────────────────────────────────────────────

// Cache 10 menit — hemat quota CoinGecko public & CMC free plan
let externalDataCache  = null;
let externalDataLastTs = 0;
const EXTERNAL_CACHE_MS = 10 * 60 * 1000;
let cmcDisabledUntil   = 0; // disable CMC sementara kalau quota habis

/** Source #1: CoinGecko — data PEPE global (tanpa API key) */
async function fetchCoinGeckoData() {
  try {
    const [coinData, trendingData] = await Promise.all([
      httpsRequest({
        hostname: "api.coingecko.com",
        path:     "/api/v3/coins/pepe?localization=false&tickers=false&community_data=true&developer_data=false",
        method:   "GET",
        headers:  { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      }),
      httpsRequest({
        hostname: "api.coingecko.com",
        path:     "/api/v3/search/trending",
        method:   "GET",
        headers:  { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      }),
    ]);

    // Handle rate limit 429 — pakai cache
    if (coinData?.status?.error_code === 429 || trendingData?.status?.error_code === 429) {
      log("WARN", "CoinGecko rate limit (429) — pakai cache terakhir");
      return null;
    }

    const md = coinData?.market_data;
    if (!md) { log("WARN", "CoinGecko: data tidak valid"); return null; }

    const trendingCoins = trendingData?.coins || [];
    const pepeTrend     = trendingCoins.find(c => c.item?.id === "pepe" || c.item?.symbol?.toLowerCase() === "pepe");

    return {
      priceUSD:          md.current_price?.usd || 0,
      change1h:          md.price_change_percentage_1h_in_currency?.usd || 0,
      change24h:         md.price_change_percentage_24h || 0,
      change7d:          md.price_change_percentage_7d || 0,
      volume24h:         md.total_volume?.usd || 0,
      marketCap:         md.market_cap?.usd || 0,
      marketCapRank:     coinData.market_cap_rank || 0,
      twitterFollowers:  coinData.community_data?.twitter_followers || 0,
      redditSubscribers: coinData.community_data?.reddit_subscribers || 0,
      redditPosts48h:    coinData.community_data?.reddit_average_posts_48h || 0,
      redditComments48h: coinData.community_data?.reddit_average_comments_48h || 0,
      isPepeTrending:    !!pepeTrend,
      trendingRank:      pepeTrend ? (trendingCoins.indexOf(pepeTrend) + 1) : null,
    };
  } catch (err) {
    log("WARN", `CoinGecko gagal: ${err.message} — pakai cache`);
    return null;
  }
}

/** Source #2: CoinMarketCap — global crypto metrics (butuh API key gratis) */
async function fetchCMCData() {
  if (!process.env.CMC_API_KEY || process.env.CMC_API_KEY === "your_key_here") return null;
  if (Date.now() < cmcDisabledUntil) return null; // sementara dinonaktifkan

  try {
    const [globalData, pepeData] = await Promise.all([
      httpsRequest({
        hostname: "pro-api.coinmarketcap.com",
        path:     "/v1/global-metrics/quotes/latest",
        method:   "GET",
        headers:  { "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      }),
      httpsRequest({
        hostname: "pro-api.coinmarketcap.com",
        path:     "/v2/cryptocurrency/quotes/latest?symbol=PEPE&convert=USD",
        method:   "GET",
        headers:  { "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      }),
    ]);

    // Quota habis → disable CMC sisa hari ini
    if (globalData?.status?.error_code === 402 || pepeData?.status?.error_code === 402) {
      cmcDisabledUntil = new Date().setHours(24, 0, 0, 0); // reset tengah malam
      log("ERROR", "CMC quota habis — nonaktifkan CMC sampai tengah malam");
      return null;
    }
    if (globalData?.status?.error_code === 429 || pepeData?.status?.error_code === 429) {
      log("WARN", "CMC rate limit (429) — pakai cache");
      return null;
    }

    const g = globalData?.data;
    const p = pepeData?.data?.PEPE?.[0]?.quote?.USD;
    if (!g || !p) return null;

    return {
      btcDominance:        g.btc_dominance || 0,
      ethDominance:        g.eth_dominance || 0,
      totalMarketCap:      g.total_market_cap?.USD || 0,
      totalVolume24h:      g.total_volume_24h?.USD || 0,
      marketCapChange24h:  g.total_market_cap_yesterday_percentage_change || 0,
      defiMarketCap:       g.defi_market_cap || 0,
      stablecoinMarketCap: g.stablecoin_market_cap || 0,
      pepeChange1h:        p.percent_change_1h || 0,
      pepeChange24h:       p.percent_change_24h || 0,
      pepeVolumeChange24h: p.volume_change_24h || 0,
      pepeCMCRank:         pepeData?.data?.PEPE?.[0]?.cmc_rank || 0,
    };
  } catch (err) {
    log("WARN", `CoinMarketCap gagal: ${err.message} — pakai cache`);
    return null;
  }
}

/** Fetch & cache semua data eksternal (update tiap 10 menit) */
async function fetchAllExternalData() {
  if (externalDataCache && Date.now() - externalDataLastTs < EXTERNAL_CACHE_MS) {
    return externalDataCache;
  }

  log("INFO", "Memperbarui data eksternal (CoinGecko + CMC + F&G)...");
  const [geckoData, cmcData, fearGreedNew] = await Promise.all([
    fetchCoinGeckoData(),
    fetchCMCData(),
    getFearGreedIndex(),
  ]);

  // Pertahankan cache lama jika data baru null
  externalDataCache = {
    geckoData: geckoData || externalDataCache?.geckoData || null,
    cmcData:   cmcData   || externalDataCache?.cmcData   || null,
    fearGreed: fearGreedNew || externalDataCache?.fearGreed || { value: 50, classification: "Neutral", trend: "STABLE", avg7d: 50, yesterday: 50 },
  };
  externalDataLastTs = Date.now();

  // Log ringkasan data baru
  if (geckoData) {
    log("INFO", `CoinGecko: PEPE 24h=${geckoData.change24h.toFixed(2)}% | Vol=$${(geckoData.volume24h/1e6).toFixed(1)}M | Trending: ${geckoData.isPepeTrending ? "YA #"+geckoData.trendingRank : "Tidak"}`);
  }
  if (cmcData) {
    log("INFO", `CMC: BTC Dom=${cmcData.btcDominance.toFixed(1)}% | Market ${cmcData.marketCapChange24h >= 0 ? "+" : ""}${cmcData.marketCapChange24h.toFixed(2)}%`);
  }
  const fg = externalDataCache.fearGreed;
  log("INFO", `F&G: ${fg.value} (${fg.classification}) | Trend: ${fg.trend} | Avg7d: ${fg.avg7d}`);

  return externalDataCache;
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
 * Bitget PEPE contract: 1 kontrak = 1000 PEPE, minimum order = 1000 PEPE
 */
function calcOrderSize(price, leverage) {
  // BUG #1 FIX: CONTRACT_SIZE = 1000 (bukan 1)
  // Bitget PEPEUSDT USDT-M: 1 kontrak = 1000 PEPE, minimum 1 kontrak
  const CONTRACT_SIZE = 1000;
  const MIN_QTY       = 1000;
  const notional  = CONFIG.POSITION_SIZE_USDT * leverage;
  const qty       = notional / price;
  const contracts = Math.max(1, Math.floor(qty / CONTRACT_SIZE));
  const finalQty  = contracts * CONTRACT_SIZE;
  log("INFO", `Kalkulasi order: notional=${notional.toFixed(2)} USDT | qty=${qty.toFixed(0)} PEPE | kontrak=${contracts} | final=${finalQty} PEPE`);
  return finalQty;
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

  // BUG #4 FIX: update currentBalance setiap posisi ditutup
  state.currentBalance = state.initialBalance + stats.totalPnL;

  updateCompoundBalance(pnlUSDT);
  updateWinRateTracker(pnlUSDT, pnlPct);
  autoAdjustStrategy();

  recordTrade("CLOSE", pos.side, currentPrice, pos.size, pos.leverage, pos.liqPrice, reason, pnlUSDT);
  state.activePosition = null;
  saveState();
  saveStats();
  await fetchAndUpdateBalance();
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
// INDIKATOR TAMBAHAN: BB, VWAP, VOLUME PROFILE, CANDLE PATTERN
// ─────────────────────────────────────────────────────────────

/** Fitur #2: Bollinger Bands */
function calcBollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const sd     = Math.sqrt(variance);
  const upper  = middle + stdDevMult * sd;
  const lower  = middle - stdDevMult * sd;
  const bandwidth = (upper - lower) / middle * 100;
  const price  = closes[closes.length - 1];
  const pctB   = (upper - lower) !== 0 ? (price - lower) / (upper - lower) : 0.5;
  return { upper, middle, lower, bandwidth, pctB };
}

function detectSqueeze(klines) {
  const closes = klines.map(k => k.close);
  const bb     = calcBollingerBands(closes);
  if (!bb) return { squeeze: false, bandwidthPct: 0, pricePosition: "MIDDLE", breakoutDirection: "NONE" };

  // Hitung rata-rata bandwidth 20 candle terakhir
  const bwHistory = [];
  for (let i = Math.max(20, closes.length - 20); i <= closes.length; i++) {
    const b = calcBollingerBands(closes.slice(0, i));
    if (b) bwHistory.push(b.bandwidth);
  }
  const avgBw  = bwHistory.length ? bwHistory.reduce((a, b) => a + b, 0) / bwHistory.length : bb.bandwidth;
  const squeeze = bb.bandwidth < avgBw * 0.5;

  const price = closes[closes.length - 1];
  let pricePosition = "MIDDLE";
  let breakoutDirection = "NONE";
  if (price > bb.upper) { pricePosition = "UPPER"; breakoutDirection = "UP"; }
  else if (price < bb.lower) { pricePosition = "LOWER"; breakoutDirection = "DOWN"; }

  return { squeeze, bandwidthPct: bb.bandwidth, pricePosition, breakoutDirection, bb };
}

/** Fitur #3: VWAP */
function calcVWAP(klines) {
  let cumTP = 0, cumVol = 0;
  // Gunakan semua klines yang ada (reset harian tidak bisa tanpa timestamp hari)
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    cumTP  += tp * k.volume;
    cumVol += k.volume;
  }
  return cumVol > 0 ? cumTP / cumVol : 0;
}

function calcVolumeProfile(klines, buckets = 10) {
  const prices  = klines.map(k => k.close);
  const minP    = Math.min(...prices);
  const maxP    = Math.max(...prices);
  const range   = maxP - minP || 1;
  const size    = range / buckets;

  const profile = Array.from({ length: buckets }, (_, i) => ({
    low:    minP + i * size,
    high:   minP + (i + 1) * size,
    mid:    minP + (i + 0.5) * size,
    volume: 0,
  }));

  for (const k of klines) {
    const idx = Math.min(Math.floor((k.close - minP) / size), buckets - 1);
    profile[idx].volume += k.volume;
  }

  const avgVol = profile.reduce((s, b) => s + b.volume, 0) / buckets;
  const poc    = profile.reduce((a, b) => b.volume > a.volume ? b : a, profile[0]);
  const hvn    = profile.filter(b => b.volume > avgVol * 1.5).map(b => b.mid);
  const lvn    = profile.filter(b => b.volume < avgVol * 0.5).map(b => b.mid);

  return { poc: poc.mid, hvn, lvn, avgVol };
}

/** Fitur #4: Candle Pattern Detection */
function detectCandlePatterns(klines) {
  if (klines.length < 3) return { bullishPatterns: [], bearishPatterns: [], dominantBias: "NEUTRAL", strength: "WEAK" };
  const [c1, c2, c3] = klines.slice(-3); // oldest → newest
  const bullishPatterns = [];
  const bearishPatterns = [];

  const body = (c) => Math.abs(c.close - c.open);
  const isGreen = (c) => c.close > c.open;
  const wickDown = (c) => Math.min(c.open, c.close) - c.low;
  const wickUp   = (c) => c.high - Math.max(c.open, c.close);

  // Hammer: body kecil, wick bawah > 2× body
  if (body(c3) > 0 && wickDown(c3) > body(c3) * 2 && wickUp(c3) < body(c3)) bullishPatterns.push("Hammer");
  // Shooting Star: body kecil, wick atas > 2× body
  if (body(c3) > 0 && wickUp(c3) > body(c3) * 2 && wickDown(c3) < body(c3)) bearishPatterns.push("Shooting Star");
  // Bullish Engulfing
  if (!isGreen(c2) && isGreen(c3) && c3.open < c2.close && c3.close > c2.open) bullishPatterns.push("Bullish Engulfing");
  // Bearish Engulfing
  if (isGreen(c2) && !isGreen(c3) && c3.open > c2.close && c3.close < c2.open) bearishPatterns.push("Bearish Engulfing");
  // Morning Star: merah-doji/kecil-hijau
  if (!isGreen(c1) && body(c2) < body(c1) * 0.3 && isGreen(c3) && c3.close > (c1.open + c1.close) / 2) bullishPatterns.push("Morning Star");
  // Evening Star: hijau-doji/kecil-merah
  if (isGreen(c1) && body(c2) < body(c1) * 0.3 && !isGreen(c3) && c3.close < (c1.open + c1.close) / 2) bearishPatterns.push("Evening Star");
  // Piercing Line
  if (!isGreen(c2) && isGreen(c3) && c3.close > (c2.open + c2.close) / 2 && c3.open < c2.close) bullishPatterns.push("Piercing Line");
  // Dark Cloud
  if (isGreen(c2) && !isGreen(c3) && c3.close < (c2.open + c2.close) / 2 && c3.open > c2.close) bearishPatterns.push("Dark Cloud");

  const dominantBias = bullishPatterns.length > bearishPatterns.length ? "BULLISH"
    : bearishPatterns.length > bullishPatterns.length ? "BEARISH" : "NEUTRAL";
  const strength = (bullishPatterns.length + bearishPatterns.length) >= 2 ? "STRONG" : "WEAK";

  return { bullishPatterns, bearishPatterns, dominantBias, strength };
}

/** Fitur #1: Multi-Timeframe Analysis */
async function fetchMultiTimeframe() {
  const [kl1m, kl5m, kl15m] = await Promise.all([
    getKlines("1m",  50),
    getKlines("5m",  50),
    getKlines("15m", 30),
  ]);
  const analyze = (klines) => {
    const closes = klines.map(k => k.close);
    const rsi    = calcRSI(closes);
    const ema9   = calcEMA(closes, 9);
    const ema21  = calcEMA(closes, 21);
    return { rsi, ema9, ema21, trend: ema9 > ema21 ? "BULLISH" : "BEARISH" };
  };
  return { tf1m: analyze(kl1m), tf5m: analyze(kl5m), tf15m: analyze(kl15m), kl1m };
}

function getTimeframeConsensus(tf1m, tf5m, tf15m) {
  const bulls = [tf1m, tf5m, tf15m].filter(t => t.trend === "BULLISH").length;
  const bears = [tf1m, tf5m, tf15m].filter(t => t.trend === "BEARISH").length;
  if (bulls === 3) return "STRONG_LONG";
  if (bears === 3) return "STRONG_SHORT";
  if (bulls === 2) return "WEAK_LONG";
  if (bears === 2) return "WEAK_SHORT";
  return "MIXED";
}

/** Fitur #7: Ambil perubahan BTC 1 jam */
async function fetchBTCChange() {
  try {
    const res = await bitgetRequest("GET", "/api/v2/mix/market/candles", {
      symbol: "BTCUSDT", productType: CONFIG.PRODUCT_TYPE, granularity: "1m", limit: "61",
    });
    if (res.code !== "00000" || !res.data || res.data.length < 2) return 0;
    const candles = res.data.map(c => parseFloat(c[4])).reverse();
    return ((candles[candles.length - 1] - candles[0]) / candles[0]) * 100;
  } catch { return 0; }
}

async function checkMarketCrash(ticker, klines) {
  if (!CONFIG.AUTO_PAUSE_ENABLED) return;
  // Hitung perubahan PEPE 1 jam dari 60 candle 1m
  if (klines.length < 60) return;
  const pepeChange1h = ((klines[klines.length - 1].close - klines[klines.length - 60].close)
    / klines[klines.length - 60].close) * 100;
  const btcChange1h  = await fetchBTCChange();

  if (btcChange1h < -CONFIG.PAUSE_BTC_DROP_PCT || pepeChange1h < -CONFIG.PAUSE_PEPE_DROP_PCT) {
    state.pausedUntil = Date.now() + CONFIG.PAUSE_DURATION_MS;
    state.pauseReason = btcChange1h < -CONFIG.PAUSE_BTC_DROP_PCT
      ? `BTC crash ${btcChange1h.toFixed(2)}%`
      : `PEPE crash ${pepeChange1h.toFixed(2)}%`;
    log("WARN", `AUTO PAUSE! ${state.pauseReason} — resume dalam 1 jam`);
    if (state.activePosition) await closePosition("AUTO_PAUSE_CRASH", state.lastPrice);
  }
}

// ─────────────────────────────────────────────────────────────
// FITUR #5: PARTIAL CLOSE
// ─────────────────────────────────────────────────────────────

async function closePartialPosition(reason, currentPrice) {
  const pos = state.activePosition;
  if (!pos || pos.partialClosed) return;

  const halfSize   = Math.floor(pos.size * (CONFIG.PARTIAL_CLOSE_PCT / 100) / 1000) * 1000;
  if (halfSize <= 0) return;

  const pnlPct  = pos.side === "LONG"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
  const lockedPnL = (compoundedBalance * (CONFIG.PARTIAL_CLOSE_PCT / 100)) * (pnlPct / 100);

  log("TRADE", `PARTIAL CLOSE ${CONFIG.PARTIAL_CLOSE_PCT}% | Alasan: ${reason} | Lock PnL: +${lockedPnL.toFixed(4)} USDT`);

  if (!CONFIG.DRY_RUN) {
    await bitgetRequest("POST", "/api/v2/mix/order/place-order", {}, {
      symbol:      CONFIG.SYMBOL,
      productType: CONFIG.PRODUCT_TYPE,
      marginMode:  CONFIG.MARGIN_MODE,
      marginCoin:  CONFIG.MARGIN_COIN,
      size:        halfSize.toString(),
      side:        pos.side === "LONG" ? "sell" : "buy",
      tradeSide:   "close",
      orderType:   "market",
    });
  } else {
    log("INFO", `[DRY RUN] Simulasi partial close ${halfSize} PEPE`);
  }

  pos.partialClosed = true;
  pos.size          = pos.size - halfSize;
  saveState();
}

// ─────────────────────────────────────────────────────────────
// FITUR #6: AUTO COMPOUND
// ─────────────────────────────────────────────────────────────

function updateCompoundBalance(pnlUSDT) {
  if (!CONFIG.AUTO_COMPOUND) return;
  if (pnlUSDT > CONFIG.COMPOUND_MIN_PROFIT) {
    const add      = pnlUSDT * CONFIG.COMPOUND_RATIO;
    compoundedBalance = Math.min(compoundedBalance + add, CONFIG.MAX_POSITION_USDT);
    log("INFO", `Auto compound: +${add.toFixed(4)} USDT → posisi berikutnya: ${compoundedBalance.toFixed(4)} USDT`);
  } else if (pnlUSDT < 0) {
    compoundedBalance = Math.max(
      compoundedBalance + pnlUSDT * CONFIG.COMPOUND_RATIO,
      CONFIG.POSITION_SIZE_USDT
    );
  }
}

// ─────────────────────────────────────────────────────────────
// FITUR #8: WIN RATE TRACKER & AUTO-ADJUST STRATEGY
// ─────────────────────────────────────────────────────────────

function updateWinRateTracker(pnlUSDT, pnlPct) {
  stats.recentTrades.push({ pnlUSDT, pnlPct, time: Date.now(), win: pnlUSDT > 0 });
  if (stats.recentTrades.length > 20) stats.recentTrades.shift();

  const recentWins   = stats.recentTrades.filter(t => t.win).length;
  stats.winRate7d    = (recentWins / stats.recentTrades.length) * 100;

  const profits = stats.recentTrades.filter(t => t.win).map(t => t.pnlPct);
  const losses  = stats.recentTrades.filter(t => !t.win).map(t => t.pnlPct);
  stats.avgProfitPct = profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;
  stats.avgLossPct   = losses.length  ? losses.reduce((a, b) => a + b, 0) / losses.length   : 0;

  stats.currentStreak = pnlUSDT > 0
    ? (stats.currentStreak > 0 ? stats.currentStreak + 1 : 1)
    : (stats.currentStreak < 0 ? stats.currentStreak - 1 : -1);
}

function autoAdjustStrategy() {
  if (stats.recentTrades.length < 10) return;
  if (stats.totalTrades % 10 !== 0)   return;

  if (stats.winRate7d < 40) {
    CONFIG.OPEN_CONFIDENCE = Math.min(CONFIG.OPEN_CONFIDENCE + 5, 90);
    log("WARN", `Win rate rendah (${stats.winRate7d.toFixed(1)}%) → naikkan confidence ke ${CONFIG.OPEN_CONFIDENCE}%`);
  }
  if (stats.winRate7d > 65 && stats.recentTrades.length >= 15) {
    CONFIG.OPEN_CONFIDENCE = Math.max(CONFIG.OPEN_CONFIDENCE - 5, 65);
    log("INFO", `Win rate bagus (${stats.winRate7d.toFixed(1)}%) → turunkan confidence ke ${CONFIG.OPEN_CONFIDENCE}%`);
  }
  if (stats.currentStreak <= -3) {
    state.pausedUntil = Date.now() + 1800000;
    state.pauseReason = `Loss streak ${Math.abs(stats.currentStreak)}x berturut`;
    log("WARN", `Loss streak! Pause 30 menit untuk recovery...`);
  }
}

// ─────────────────────────────────────────────────────────────
// BALANCE MONITORING
// ─────────────────────────────────────────────────────────────

async function fetchAndUpdateBalance() {
  if (CONFIG.DRY_RUN) {
    state.currentBalance = compoundedBalance + stats.totalPnL;
    if (!state.initialBalance) state.initialBalance = CONFIG.POSITION_SIZE_USDT * 10;
  } else {
    try {
      const info = await getAccountInfo();
      state.currentBalance = info.equity;
      state.available      = info.available;
      state.unrealizedPnL  = info.unrealizedPnL;
      if (!state.initialBalance) state.initialBalance = info.equity;
    } catch (err) {
      log("WARN", `Gagal update saldo: ${err.message}`);
      return;
    }
  }

  if (state.currentBalance > (state.peakBalance || 0))    state.peakBalance   = state.currentBalance;
  if (!state.lowestBalance || state.currentBalance < state.lowestBalance) state.lowestBalance = state.currentBalance;

  state.balanceHistory.push({ time: Date.now(), balance: state.currentBalance });
  if (state.balanceHistory.length > 100) state.balanceHistory.shift();

  const changeUSDT = state.currentBalance - state.initialBalance;
  const changePct  = state.initialBalance > 0 ? (changeUSDT / state.initialBalance) * 100 : 0;
  const drawdown   = state.peakBalance > 0 ? ((state.peakBalance - state.currentBalance) / state.peakBalance) * 100 : 0;

  broadcastSSE({
    type: "balance", currentBalance: state.currentBalance, initialBalance: state.initialBalance,
    available: state.available || state.currentBalance, unrealizedPnL: state.unrealizedPnL || 0,
    changeUSDT, changePct, peakBalance: state.peakBalance, lowestBalance: state.lowestBalance,
    drawdown, history: state.balanceHistory.slice(-20),
  });
  state.lastBalanceUpdate = Date.now();
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

## Sentimen & Makro Market

### Fear & Greed Index
- Sekarang   : ${marketData.fearGreed.value} — ${marketData.fearGreed.classification}
- Kemarin    : ${marketData.fearGreed.yesterday}
- Rata 7 hari: ${marketData.fearGreed.avg7d}
- Tren 7h    : ${marketData.fearGreed.trend} (IMPROVING=membaik, WORSENING=memburuk, STABLE=stabil)

### CoinGecko — PEPE Global
${marketData.geckoData ? `- Perubahan 1j   : ${marketData.geckoData.change1h.toFixed(2)}%
- Perubahan 24j  : ${marketData.geckoData.change24h.toFixed(2)}%
- Perubahan 7h   : ${marketData.geckoData.change7d.toFixed(2)}%
- Volume 24j     : $${(marketData.geckoData.volume24h / 1e6).toFixed(1)}M
- Market Cap     : $${(marketData.geckoData.marketCap / 1e6).toFixed(0)}M (Rank #${marketData.geckoData.marketCapRank})
- Reddit Posts 48j: ${marketData.geckoData.redditPosts48h.toFixed(1)}
- TRENDING       : ${marketData.geckoData.isPepeTrending ? "YA — Rank #" + marketData.geckoData.trendingRank + " (potensi hype!)" : "Tidak trending"}` : "- Data tidak tersedia (pakai cache)"}

### CoinMarketCap — Global Market
${marketData.cmcData ? `- BTC Dominance   : ${marketData.cmcData.btcDominance.toFixed(2)}% ${marketData.cmcData.btcDominance > 60 ? "⚠ >60% = BTC season, hindari long altcoin" : marketData.cmcData.btcDominance < 45 ? "✓ <45% = Altcoin season, PEPE berpeluang naik" : "(Netral)"}
- Market Cap 24j  : ${marketData.cmcData.marketCapChange24h >= 0 ? "+" : ""}${marketData.cmcData.marketCapChange24h.toFixed(2)}%
- Vol PEPE change : ${marketData.cmcData.pepeVolumeChange24h >= 0 ? "+" : ""}${marketData.cmcData.pepeVolumeChange24h.toFixed(2)}% ${Math.abs(marketData.cmcData.pepeVolumeChange24h) > 50 ? "⚡ Volume spike signifikan!" : ""}` : "- Data tidak tersedia (pakai cache)"}

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
- BTC Dominance >60% → hindari LONG altcoin seperti PEPE
- PEPE trending CoinGecko → potensi hype pump, pertimbangkan LONG tapi waspadai dump setelah hype
- Fear & Greed WORSENING 7 hari → lebih konservatif
- Volume PEPE naik >50% + harga naik → konfirmasi LONG kuat
- Volume PEPE naik >50% + harga turun → konfirmasi SHORT kuat
- Altcoin season (BTC Dom <45%) → lebih agresif di PEPE

## Multi-Timeframe Analysis
${marketData.mtf ? `- 1m  : RSI=${marketData.mtf.tf1m.rsi.toFixed(1)} | EMA9${marketData.mtf.tf1m.ema9 > marketData.mtf.tf1m.ema21 ? ">" : "<"}EMA21 | Tren=${marketData.mtf.tf1m.trend}
- 5m  : RSI=${marketData.mtf.tf5m.rsi.toFixed(1)} | EMA9${marketData.mtf.tf5m.ema9 > marketData.mtf.tf5m.ema21 ? ">" : "<"}EMA21 | Tren=${marketData.mtf.tf5m.trend}
- 15m : RSI=${marketData.mtf.tf15m.rsi.toFixed(1)} | EMA9${marketData.mtf.tf15m.ema9 > marketData.mtf.tf15m.ema21 ? ">" : "<"}EMA21 | Tren=${marketData.mtf.tf15m.trend}
- Consensus: ${marketData.consensus}` : "- Data MTF tidak tersedia"}

## Bollinger Bands & Squeeze
${marketData.bb ? `- Upper/Middle/Lower: ${marketData.bb.upper.toFixed(8)} / ${marketData.bb.middle.toFixed(8)} / ${marketData.bb.lower.toFixed(8)}
- Bandwidth: ${marketData.bb.bandwidth.toFixed(2)}% | Squeeze: ${marketData.squeeze?.squeeze ? "AKTIF ⚠" : "tidak"}
- %B: ${marketData.bb.pctB.toFixed(3)} (>1=di atas upper, <0=di bawah lower)
- Breakout: ${marketData.squeeze?.breakoutDirection || "NONE"}` : "- Data BB tidak tersedia"}

## Volume Profile & VWAP
- VWAP: ${marketData.vwap.toFixed(8)} | Harga vs VWAP: ${marketData.vwapPct >= 0 ? "+" : ""}${marketData.vwapPct.toFixed(3)}%
- Point of Control (POC): ${marketData.volProf?.poc.toFixed(8) || "N/A"}
- HVN terdekat: ${marketData.volProf?.hvn.length ? marketData.volProf.hvn.slice(0, 2).map(v => v.toFixed(8)).join(", ") : "tidak ada"}

## Candle Patterns (3 candle terakhir)
- Bullish: ${marketData.candlePatterns?.bullishPatterns.join(", ") || "tidak ada"}
- Bearish: ${marketData.candlePatterns?.bearishPatterns.join(", ") || "tidak ada"}
- Dominant Bias: ${marketData.candlePatterns?.dominantBias} (Strength: ${marketData.candlePatterns?.strength})

## Performa Bot (20 trade terakhir)
- Win Rate   : ${marketData.winRate.toFixed(1)}%
- Streak     : ${marketData.streak > 0 ? "+" : ""}${marketData.streak} (+ = win streak, - = loss streak)
- Total PnL  : ${marketData.totalPnL >= 0 ? "+" : ""}${marketData.totalPnL.toFixed(4)} USDT

Instruksi tambahan:
- Pertimbangkan MTF consensus sebelum rekomendasikan LONG/SHORT
- JANGAN rekomendasikan entry saat Bollinger Squeeze aktif
- Gunakan VWAP sebagai bias directional (harga di atas VWAP = bias LONG)
- Konfirmasi dengan candle pattern sebelum entry
- Sesuaikan confidence dengan win rate bot (win rate rendah = lebih konservatif)
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

  // ── BUG #2 FIX: Hard stop — berhenti total jika total loss > threshold ──────
  if (stats.totalPnL < 0) {
    const lossPercent = Math.abs(stats.totalPnL) / CONFIG.POSITION_SIZE_USDT * 100;
    if (lossPercent >= CONFIG.HARD_STOP_TOTAL) {
      log("ERROR", `HARD STOP! Total loss ${lossPercent.toFixed(2)}% melebihi batas ${CONFIG.HARD_STOP_TOTAL}%`);
      log("ERROR", `Bot dihentikan otomatis. Total PnL: ${stats.totalPnL.toFixed(4)} USDT`);
      if (state.activePosition) {
        log("ERROR", "Menutup posisi aktif karena hard stop...");
        await closePosition("HARD_STOP", state.lastPrice || 0);
      }
      state.running = false;
      process.exit(1);
    }
  }

  // ── Fitur #7: Cek auto pause ──────────────────────────────
  if (state.pausedUntil && Date.now() < state.pausedUntil) {
    const sisaMin = Math.ceil((state.pausedUntil - Date.now()) / 60000);
    if (state.tickCount % 6 === 0) log("WARN", `Bot PAUSE (${state.pauseReason}) — resume dalam ${sisaMin} menit`);
    broadcastSSE({ type: "pause", reason: state.pauseReason, resumeIn: sisaMin });
    return;
  }
  if (state.pausedUntil && Date.now() >= state.pausedUntil) {
    state.pausedUntil = null; state.pauseReason = "";
    log("INFO", "Bot RESUME dari pause otomatis");
  }

  // ── 1. Ambil data market ──────────────────────────────────
  let ticker, klines, fundingRate, orderBook;
  try {
    [ticker, klines, fundingRate, orderBook] = await Promise.all([
      getTicker(),
      getKlines("1m", 50),
      getFundingRate(),
      getOrderBook(),
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
  state.lastRSI   = indicators.rsi;
  state.lastEMA9  = indicators.ema9;
  state.lastEMA21 = indicators.ema21;

  // ── Fitur #2: Bollinger Bands & Squeeze ───────────────────
  const squeezeData = detectSqueeze(klines);
  const bbData      = squeezeData.bb || calcBollingerBands(indicators.closes);

  // ── Fitur #3: VWAP & Volume Profile ──────────────────────
  const vwap    = calcVWAP(klines);
  const vwapPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
  const volProf = calcVolumeProfile(klines);

  // ── Fitur #4: Candle Pattern ──────────────────────────────
  const candlePatterns = detectCandlePatterns(klines);

  // ── Fitur #1: Multi-Timeframe (setiap 2 tick) ─────────────
  let mtfData = null;
  let consensus = "MIXED";
  if (CONFIG.REQUIRE_MTF_CONSENSUS && state.tickCount % 2 === 0) {
    try {
      mtfData   = await fetchMultiTimeframe();
      consensus = getTimeframeConsensus(mtfData.tf1m, mtfData.tf5m, mtfData.tf15m);
    } catch { consensus = "MIXED"; }
  }

  // ── Fitur #7: Cek market crash setiap 6 tick ─────────────
  if (CONFIG.AUTO_PAUSE_ENABLED && state.tickCount % 6 === 0) {
    await checkMarketCrash(ticker, klines);
    if (state.pausedUntil) return;
  }

  // ── Balance log setiap 6 tick ─────────────────────────────
  if (state.tickCount % 6 === 0) {
    await fetchAndUpdateBalance();
    const chg = state.currentBalance - state.initialBalance;
    const chgPct = state.initialBalance > 0 ? (chg / state.initialBalance) * 100 : 0;
    const chgColor = chg >= 0 ? C.green : C.red;
    log("INFO", `Saldo: ${C.bold}${state.currentBalance.toFixed(4)} USDT${C.reset} | Awal: ${state.initialBalance.toFixed(4)} | P&L: ${chgColor}${chg >= 0 ? "+" : ""}${chg.toFixed(4)} USDT (${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%)${C.reset}`);
  }

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
    const _fg = externalDataCache?.fearGreed;
    log("INFO", `Funding: ${(fundingRate * 100).toFixed(4)}% | F&G: ${_fg ? _fg.value + " (" + _fg.classification + ")" : "N/A"} | Vol: ${indicators.volumeRatio.toFixed(2)}x`);
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

    // Fitur #5: Partial close trigger
    if (CONFIG.PARTIAL_CLOSE_ENABLED && !pos.partialClosed) {
      const profitPct = pos.side === "LONG"
        ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage;
      if (profitPct >= CONFIG.PARTIAL_CLOSE_TRIGGER) {
        await closePartialPosition("PARTIAL_PROFIT_LOCK", price);
        pos.trailingHigh = price; pos.trailingLow = price; // longgarkan trailing
      }
    }
  }

  // ── 5. Claude AI Analysis ─────────────────────────────────
  const shouldAnalyze = state.tickCount % CONFIG.CLAUDE_ANALYSIS_INTERVAL === 0;
  if (!shouldAnalyze) {
    broadcastSSE({ type: "tick", price, rsi: indicators.rsi, ema9: indicators.ema9, ema21: indicators.ema21,
                   fundingRate, fearGreed: externalDataCache?.fearGreed, position: pos,
                   bid: ticker?.bidPrice, ask: ticker?.askPrice,           // BUG #2 FIX
                   volume24h: ticker?.volume24h, change24h: ticker?.change24h,
                   isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil) }); // BUG #6 FIX
    return;
  }

  // ── Fetch data eksternal setiap siklus analisis ───────────
  const extData   = await fetchAllExternalData();
  const fearGreed = extData.fearGreed;
  const geckoData = extData.geckoData;
  const cmcData   = extData.cmcData;

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
    // Data eksternal
    geckoData,
    cmcData,
    // Fitur #1: MTF
    mtf:        mtfData,
    consensus,
    // Fitur #2: BB
    squeeze:    squeezeData,
    bb:         bbData,
    // Fitur #3: VWAP
    vwap,
    vwapPct,
    volProf,
    // Fitur #4: Candle
    candlePatterns,
    // Fitur #8: performa bot
    winRate:    stats.winRate7d,
    streak:     stats.currentStreak,
    totalPnL:   stats.totalPnL,
    activePosition: pos ? {
      side:       pos.side,
      entryPrice: pos.entryPrice,
      leverage:   pos.leverage,
      liqPrice:   pos.liqPrice,
      // BUG #3 FIX: hitung PnL manual saat DRY RUN agar Claude punya data lengkap
      unrealPnL: livePosition
        ? livePosition.unrealPnL
        : (() => {
            const pct = pos.side === "LONG"
              ? ((price - pos.entryPrice) / pos.entryPrice) * pos.leverage
              : ((pos.entryPrice - price) / pos.entryPrice) * pos.leverage;
            return compoundedBalance * pct;
          })(),
      pnlPct: livePosition
        ? livePosition.pnlPct
        : pos.side === "LONG"
          ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
          : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage,
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
    // Fitur #1: tentukan minimum confidence berdasarkan MTF consensus
    let requiredConf = CONFIG.OPEN_CONFIDENCE;
    if (CONFIG.REQUIRE_MTF_CONSENSUS) {
      if (consensus === "MIXED") {
        log("INFO", `MTF consensus MIXED → skip entry`);
        return;
      }
      if (consensus === "WEAK_LONG" || consensus === "WEAK_SHORT") requiredConf = 80;
      // STRONG_LONG/SHORT pakai CONFIG.OPEN_CONFIDENCE (default 75)
    }

    // Fitur #2: jangan entry saat BB squeeze aktif
    if (squeezeData.squeeze) {
      log("INFO", `Bollinger Squeeze aktif (bandwidth ${squeezeData.bandwidthPct.toFixed(2)}%) → tunggu breakout`);
      return;
    }

    if ((analysis.action === "LONG" || analysis.action === "SHORT") &&
        analysis.confidence >= requiredConf) {

      const leverage = Math.min(Math.max(analysis.leverage || CONFIG.DEFAULT_LEVERAGE, CONFIG.DEFAULT_LEVERAGE), CONFIG.MAX_LEVERAGE);
      log("TRADE", `Membuka posisi ${analysis.action} | leverage ${leverage}x | MTF: ${consensus} | Candle: ${candlePatterns.dominantBias}`);
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
    mtf:      mtfData,
    consensus,
    bb:       bbData,
    squeeze:  squeezeData,
    vwap,
    vwapPct,
    volProf,
    candlePatterns,
    externalData: externalDataCache,
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
  // Broadcast ke dashboard agar log transaksi terupdate real-time
  broadcastSSE({ type: "trade", trade, tradeLog: tradeLog.slice(-50) });
}

// ─────────────────────────────────────────────────────────────
// FITUR #9: BACKTESTING MODE
// ─────────────────────────────────────────────────────────────

async function runBacktest() {
  log("INFO", `Memulai backtest ${CONFIG.BACKTEST_DAYS} hari...`);
  const totalCandles = CONFIG.BACKTEST_DAYS * 24 * 60;
  const pageSize     = 1000;
  let   allCandles   = [];

  // Ambil data historis dengan pagination
  let endTime = Date.now();
  for (let i = 0; i < Math.ceil(totalCandles / pageSize); i++) {
    try {
      const res = await bitgetRequest("GET", "/api/v2/mix/market/history-candles", {
        symbol:      CONFIG.BACKTEST_SYMBOL,
        productType: CONFIG.PRODUCT_TYPE,
        granularity: CONFIG.BACKTEST_TIMEFRAME,
        limit:       pageSize.toString(),
        endTime:     endTime.toString(),
      });
      if (res.code !== "00000" || !res.data || res.data.length === 0) break;
      const batch = res.data.map(c => ({
        time: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
      })).reverse();
      allCandles = [...batch, ...allCandles];
      endTime    = batch[0].time - 1;
      if (res.data.length < pageSize) break;
      await sleep(200);
    } catch (err) { log("WARN", `Backtest fetch error: ${err.message}`); break; }
  }

  if (allCandles.length < 60) {
    log("ERROR", `Data historis tidak cukup: hanya ${allCandles.length} candle`);
    return;
  }
  log("INFO", `Total candle historis: ${allCandles.length}`);

  // Simulasi trading
  const bs = { trades: 0, wins: 0, pnl: 0, maxDrawdown: 0, bestTrade: 0, worstTrade: 0, peak: 0 };
  let btPos = null;

  for (let i = 50; i < allCandles.length; i++) {
    const window  = allCandles.slice(i - 50, i);
    const closes  = window.map(c => c.close);
    const price   = closes[closes.length - 1];
    const rsi     = calcRSI(closes);
    const ema9    = calcEMA(closes, 9);
    const ema21   = calcEMA(closes, 21);
    const bb      = calcBollingerBands(closes);

    // Cek close posisi aktif
    if (btPos) {
      const pnlPct = btPos.side === "LONG"
        ? ((price - btPos.entry) / btPos.entry) * 100 * CONFIG.DEFAULT_LEVERAGE
        : ((btPos.entry - price) / btPos.entry) * 100 * CONFIG.DEFAULT_LEVERAGE;
      const hit = (btPos.side === "LONG" && (price >= btPos.tp || price <= btPos.sl))
               || (btPos.side === "SHORT" && (price <= btPos.tp || price >= btPos.sl));
      if (hit) {
        const pnlUSDT = CONFIG.POSITION_SIZE_USDT * pnlPct / 100;
        bs.trades++; bs.pnl += pnlUSDT;
        if (pnlUSDT > 0) bs.wins++;
        if (pnlUSDT > bs.bestTrade)  bs.bestTrade  = pnlUSDT;
        if (pnlUSDT < bs.worstTrade) bs.worstTrade = pnlUSDT;
        if (bs.pnl > bs.peak) bs.peak = bs.pnl;
        const dd = bs.peak - bs.pnl;
        if (dd > bs.maxDrawdown) bs.maxDrawdown = dd;
        btPos = null;
      }
    }

    // Cari sinyal entry (aturan sederhana tanpa Claude API)
    if (!btPos && bb) {
      if (rsi < 35 && ema9 > ema21 && price < bb.lower) {
        btPos = { side: "LONG",  entry: price, sl: price * (1 - CONFIG.STOP_LOSS_PCT / 100), tp: price * (1 + CONFIG.TAKE_PROFIT_PCT / 100) };
      } else if (rsi > 65 && ema9 < ema21 && price > bb.upper) {
        btPos = { side: "SHORT", entry: price, sl: price * (1 + CONFIG.STOP_LOSS_PCT / 100), tp: price * (1 - CONFIG.TAKE_PROFIT_PCT / 100) };
      }
    }
  }

  const winRate      = bs.trades > 0 ? (bs.wins / bs.trades) * 100 : 0;
  const totalLoss    = Math.abs(bs.pnl < 0 ? bs.pnl : 0) + (bs.wins < bs.trades ? Math.abs(bs.worstTrade) * (bs.trades - bs.wins) : 0.001);
  const profitFactor = bs.pnl > 0 ? (bs.wins * bs.bestTrade) / Math.max(totalLoss, 0.001) : 0;

  log("INFO", "=== HASIL BACKTEST ===");
  log("INFO", `Period       : ${CONFIG.BACKTEST_DAYS} hari (${allCandles.length} candle)`);
  log("INFO", `Total Trade  : ${bs.trades}`);
  log("INFO", `Win Rate     : ${winRate.toFixed(1)}%`);
  log("INFO", `Total PnL    : ${bs.pnl >= 0 ? "+" : ""}${bs.pnl.toFixed(4)} USDT`);
  log("INFO", `Max Drawdown : ${bs.maxDrawdown.toFixed(4)} USDT`);
  log("INFO", `Best Trade   : +${bs.bestTrade.toFixed(4)} USDT`);
  log("INFO", `Worst Trade  : ${bs.worstTrade.toFixed(4)} USDT`);
  log("INFO", `Profit Factor: ${profitFactor.toFixed(2)}`);
  log("INFO", "====================");

  fs.writeFileSync("backtest_results.json", JSON.stringify({ ...bs, winRate, profitFactor, date: new Date().toISOString() }, null, 2));
  log("INFO", "Hasil disimpan ke backtest_results.json");
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
    <span id="pause-badge" style="display:none;background:#f8514933;color:#f85149;padding:2px 8px;border-radius:4px;font-size:11px;border:1px solid #f8514966">⏸ PAUSED</span>
  </div>

  <div class="grid">
    <!-- Card Market Intelligence -->
    <div class="card" style="grid-column:1/-1">
      <h3>Market Intelligence</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
        <div style="text-align:center">
          <div style="font-size:10px;color:#8b949e;margin-bottom:4px">FEAR & GREED</div>
          <div id="fg-value" style="font-size:26px;font-weight:bold">--</div>
          <div id="fg-class" style="font-size:11px;color:#8b949e">--</div>
          <div id="fg-trend" style="font-size:11px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;color:#8b949e;margin-bottom:4px">BTC DOMINANCE</div>
          <div id="btc-dom" style="font-size:26px;font-weight:bold">--</div>
          <div id="btc-dom-hint" style="font-size:10px;color:#8b949e;margin-top:2px">--</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;color:#8b949e;margin-bottom:4px">PEPE TRENDING</div>
          <div id="pepe-trending" style="font-size:26px;font-weight:bold">--</div>
          <div id="pepe-trend-rank" style="font-size:11px;color:#8b949e;margin-top:2px">--</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;color:#8b949e;margin-bottom:4px">MARKET CAP 24J</div>
          <div id="mkt-change" style="font-size:26px;font-weight:bold">--</div>
          <div style="font-size:10px;color:#8b949e;margin-top:2px">Global change</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid #30363d">
        <div class="row"><span class="label">F&G Avg 7 Hari</span><span id="fg-avg" class="val">--</span></div>
        <div class="row"><span class="label">PEPE Vol Change</span><span id="pepe-vol-chg" class="val">--</span></div>
        <div class="row"><span class="label">Reddit Posts 48j</span><span id="reddit-posts" class="val">--</span></div>
        <div class="row"><span class="label">PEPE Rank</span><span id="pepe-rank" class="val">--</span></div>
      </div>
    </div>

    <!-- Card Saldo Utama -->
    <div class="card" style="grid-column:1/-1">
      <h3>Saldo & Balance</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
        <div style="text-align:center"><div style="font-size:11px;color:#8b949e;margin-bottom:4px">SALDO SEKARANG</div><div id="bal-current" style="font-size:28px;font-weight:bold;color:#58a6ff">--</div><div style="font-size:10px;color:#8b949e">USDT</div></div>
        <div style="text-align:center"><div style="font-size:11px;color:#8b949e;margin-bottom:4px">P&L TOTAL</div><div id="bal-pnl" style="font-size:28px;font-weight:bold">--</div><div id="bal-pnl-pct" style="font-size:12px;color:#8b949e">--</div></div>
        <div style="text-align:center"><div style="font-size:11px;color:#8b949e;margin-bottom:4px">AVAILABLE</div><div id="bal-available" style="font-size:28px;font-weight:bold;color:#e6edf3">--</div><div style="font-size:10px;color:#8b949e">USDT</div></div>
        <div style="text-align:center"><div style="font-size:11px;color:#8b949e;margin-bottom:4px">UNREALIZED PnL</div><div id="bal-unrealized" style="font-size:28px;font-weight:bold">--</div><div style="font-size:10px;color:#8b949e">USDT</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid #30363d">
        <div class="row"><span class="label">Modal Awal</span><span id="bal-initial" class="val">--</span></div>
        <div class="row"><span class="label">Tertinggi</span><span id="bal-peak" class="green">--</span></div>
        <div class="row"><span class="label">Terendah</span><span id="bal-lowest" class="red">--</span></div>
        <div class="row"><span class="label">Drawdown</span><span id="bal-drawdown" class="yellow">--</span></div>
      </div>
      <div style="margin-top:12px"><div style="font-size:10px;color:#8b949e;margin-bottom:4px">RIWAYAT SALDO</div><canvas id="balanceChart" height="50" style="width:100%"></canvas></div>
    </div>
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

    <!-- Multi-Timeframe -->
    <div class="card">
      <h3>Multi-Timeframe</h3>
      <div id="mtf-content"><div class="no-pos">Menunggu data MTF...</div></div>
    </div>

    <!-- Bollinger Bands -->
    <div class="card">
      <h3>Bollinger Bands</h3>
      <div id="bb-content"><div class="no-pos">Menunggu data BB...</div></div>
    </div>

    <!-- Win Rate -->
    <div class="card">
      <h3>Win Rate (20 trade terakhir)</h3>
      <div id="wr-content"><div class="no-pos">Belum ada trade</div></div>
    </div>

    <!-- AI Analysis -->
    <div class="card ai-card">
      <h3>Analisis Claude AI Terakhir</h3>
      <div id="ai-content"><div class="no-pos">Menunggu analisis pertama...</div></div>
    </div>

    <!-- Log Transaksi -->
    <div class="card ai-card">
      <h3>Log Transaksi</h3>
      <div style="overflow-x:auto">
        <table id="trade-table" style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="color:#8b949e;border-bottom:1px solid #30363d">
              <th style="text-align:left;padding:4px 8px">Waktu</th>
              <th style="text-align:left;padding:4px 8px">Tipe</th>
              <th style="text-align:left;padding:4px 8px">Side</th>
              <th style="text-align:right;padding:4px 8px">Harga</th>
              <th style="text-align:right;padding:4px 8px">Size</th>
              <th style="text-align:right;padding:4px 8px">Leverage</th>
              <th style="text-align:right;padding:4px 8px">PnL (USDT)</th>
              <th style="text-align:left;padding:4px 8px">Alasan</th>
            </tr>
          </thead>
          <tbody id="trade-tbody">
            <tr><td colspan="8" style="text-align:center;color:#8b949e;padding:16px">Belum ada transaksi</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Log -->
  <div id="log-box"></div>

  <script>
    // BUG #5 FIX: DRY badge dikontrol dari server via SSE event 'init'

    const sse = new EventSource('/events');
    sse.onmessage = (e) => {
      try { handle(JSON.parse(e.data)); } catch {}
    };

    function fmt(n, dec = 8) { return Number(n).toFixed(dec); }
    function fmtPct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
    // BUG #5 FIX: format harga PEPE dengan presisi yang tepat
    function formatPepePrice(price) { return price < 0.001 ? Number(price).toFixed(8) : Number(price).toFixed(6); }

    // BUG #6 FIX: track pause state secara lokal
    let isPaused = false;

    // ── Balance chart ──────────────────────────────────────────
    let balHistory = [];
    function renderBalanceChart() {
      const canvas = document.getElementById('balanceChart');
      if (!canvas || balHistory.length < 2) return;
      const ctx = canvas.getContext('2d');
      canvas.width = canvas.offsetWidth || 600;
      const W = canvas.width, H = 50;
      const prices = balHistory.map(b => b.balance);
      const min = Math.min(...prices) * 0.9995, max = Math.max(...prices) * 1.0005;
      const range = max - min || 1;
      ctx.clearRect(0, 0, W, H);
      const isUp = prices[prices.length-1] >= prices[0];
      const grad = ctx.createLinearGradient(0,0,0,H);
      grad.addColorStop(0, isUp ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.3)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      prices.forEach((p,i) => { const x=(i/(prices.length-1))*W, y=H-((p-min)/range)*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
      ctx.beginPath();
      prices.forEach((p,i) => { const x=(i/(prices.length-1))*W, y=H-((p-min)/range)*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.strokeStyle = isUp ? '#3fb950' : '#f85149'; ctx.lineWidth=2; ctx.stroke();
    }

    function handleBalance(d) {
      document.getElementById('bal-current').textContent = Number(d.currentBalance).toFixed(4);
      document.getElementById('bal-initial').textContent = Number(d.initialBalance).toFixed(4) + ' USDT';
      const pnlEl = document.getElementById('bal-pnl');
      pnlEl.textContent = (d.changeUSDT >= 0 ? '+' : '') + Number(d.changeUSDT).toFixed(4);
      pnlEl.className = d.changeUSDT >= 0 ? 'green' : 'red';
      document.getElementById('bal-pnl-pct').textContent = (d.changePct >= 0 ? '+' : '') + Number(d.changePct).toFixed(2) + '%';
      document.getElementById('bal-available').textContent = Number(d.available).toFixed(4);
      const unreal = document.getElementById('bal-unrealized');
      unreal.textContent = (d.unrealizedPnL >= 0 ? '+' : '') + Number(d.unrealizedPnL).toFixed(4);
      unreal.className = d.unrealizedPnL >= 0 ? 'green' : 'red';
      document.getElementById('bal-peak').textContent    = Number(d.peakBalance).toFixed(4) + ' USDT';
      document.getElementById('bal-lowest').textContent  = Number(d.lowestBalance).toFixed(4) + ' USDT';
      const ddEl = document.getElementById('bal-drawdown');
      ddEl.textContent = Number(d.drawdown).toFixed(2) + '%';
      ddEl.className = d.drawdown > 10 ? 'red' : d.drawdown > 5 ? 'yellow' : 'green';
      if (d.history) { balHistory = d.history; renderBalanceChart(); }
    }

    function renderMTF(d) {
      if (!d.mtf) return;
      const t = d.mtf; const con = d.consensus || 'MIXED';
      const conColor = con.includes('STRONG') ? (con.includes('LONG') ? 'green' : 'red') : con === 'MIXED' ? 'yellow' : (con.includes('LONG') ? 'green' : 'red');
      document.getElementById('mtf-content').innerHTML = \`
        <div class="row"><span class="label">1m</span><span class="val \${t.tf1m.trend==='BULLISH'?'green':'red'}">\${t.tf1m.trend} | RSI \${t.tf1m.rsi.toFixed(1)}</span></div>
        <div class="row"><span class="label">5m</span><span class="val \${t.tf5m.trend==='BULLISH'?'green':'red'}">\${t.tf5m.trend} | RSI \${t.tf5m.rsi.toFixed(1)}</span></div>
        <div class="row"><span class="label">15m</span><span class="val \${t.tf15m.trend==='BULLISH'?'green':'red'}">\${t.tf15m.trend} | RSI \${t.tf15m.rsi.toFixed(1)}</span></div>
        <div class="row" style="margin-top:6px"><span class="label">Consensus</span><span class="\${conColor}" style="font-weight:bold">\${con}</span></div>
      \`;
    }

    function renderBB(d) {
      if (!d.bb) return;
      const sq = d.squeeze;
      document.getElementById('bb-content').innerHTML = \`
        <div class="row"><span class="label">Upper</span><span class="val red">\${fmt(d.bb.upper)}</span></div>
        <div class="row"><span class="label">Middle</span><span class="val">\${fmt(d.bb.middle)}</span></div>
        <div class="row"><span class="label">Lower</span><span class="val green">\${fmt(d.bb.lower)}</span></div>
        <div class="row"><span class="label">%B</span><span class="val">\${Number(d.bb.pctB).toFixed(3)}</span></div>
        <div class="row"><span class="label">Squeeze</span><span class="\${sq&&sq.squeeze?'red':'green'}">\${sq&&sq.squeeze?'AKTIF ⚠':'Tidak'}</span></div>
        <div class="row"><span class="label">Breakout</span><span class="val">\${sq?sq.breakoutDirection:'NONE'}</span></div>
      \`;
    }

    function renderWinRate(s) {
      if (!s || s.totalTrades === 0) return;
      const wr = s.winRate7d || 0;
      const fill = wr >= 60 ? '#3fb950' : wr >= 45 ? '#d29922' : '#f85149';
      const str = s.currentStreak || 0;
      document.getElementById('wr-content').innerHTML = \`
        <div class="row"><span class="label">Win Rate (recent)</span><span class="val" style="color:\${fill}">\${wr.toFixed(1)}%</span></div>
        <div style="background:#21262d;height:6px;border-radius:3px;margin:6px 0;overflow:hidden"><div style="width:\${Math.min(wr,100)}%;height:100%;background:\${fill};border-radius:3px"></div></div>
        <div class="row"><span class="label">Streak</span><span class="\${str>0?'green':str<0?'red':'val'}">\${str>0?'+':''}\${str}</span></div>
        <div class="row"><span class="label">Avg Profit</span><span class="green">+\${(s.avgProfitPct||0).toFixed(2)}%</span></div>
        <div class="row"><span class="label">Avg Loss</span><span class="red">\${(s.avgLossPct||0).toFixed(2)}%</span></div>
      \`;
    }

    function handle(d) {
      // BUG #4 FIX: simpan posisi & harga terakhir untuk re-render real-time
      window.currentPosition = d.position !== undefined ? d.position : window.currentPosition;
      window.lastPrice = d.price || window.lastPrice || 0;

      if (d.type === 'init') {
        document.getElementById('dry-badge').style.display = d.dryRun ? 'inline' : 'none';
        if (d.stats) renderWinRate(d.stats);
        if (d.balance) handleBalance(d.balance);                              // BUG #1b FIX
        if (d.externalData) handleIntelligence({ externalData: d.externalData }); // BUG #1b FIX
        if (d.position) renderPosition(d.position, d.price || 0);
        if (d.tradeLog) renderTradeLog(d.tradeLog);
      }
      if (d.type === 'trade') { renderTradeLog(d.tradeLog); return; }
      if (d.type === 'pause') {
        isPaused = true;                                                       // BUG #6 FIX
        const pb = document.getElementById('pause-badge');
        pb.style.display = 'inline';
        pb.title = d.reason + ' — resume dalam ' + d.resumeIn + ' menit';
      }
      // BUG #6 FIX: gunakan isPaused flag dari server, jangan hapus badge di setiap event
      if (d.isPaused !== undefined) {
        isPaused = d.isPaused;
        document.getElementById('pause-badge').style.display = isPaused ? 'inline' : 'none';
      }
      if (d.type === 'balance') { handleBalance(d); return; }
      if (d.price) document.getElementById('price').textContent = formatPepePrice(d.price); // BUG #5 FIX
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
      if (d.fearGreed) document.getElementById('feargreed').textContent = d.fearGreed.value + ' (' + d.fearGreed.classification + ')';
      // BUG #2 FIX: tampilkan bid/ask real-time
      if (d.bid) document.getElementById('bid').textContent = formatPepePrice(d.bid);
      if (d.ask) document.getElementById('ask').textContent = formatPepePrice(d.ask);
      if (d.position) renderPosition(d.position, d.price || window.lastPrice);
      else if (d.type === 'analysis' && !d.position) document.getElementById('position-content').innerHTML = '<div class="no-pos">Tidak ada posisi aktif</div>';
      if (d.analysis) renderAI(d.analysis);
      if (d.type === 'analysis') { renderMTF(d); renderBB(d); handleIntelligence(d); }
      if (d.type === 'log') addLog(d);
      if (d.type === 'stats') { renderStats(d); renderWinRate(d); }
    }

    // BUG #4 FIX: refresh PnL posisi setiap 1 detik dengan harga terbaru
    setInterval(() => {
      if (window.currentPosition && window.lastPrice) {
        renderPosition(window.currentPosition, window.lastPrice);
      }
    }, 1000);

    function handleIntelligence(d) {
      if (!d.externalData) return;
      const { geckoData, cmcData, fearGreed } = d.externalData;

      if (fearGreed) {
        const fgEl = document.getElementById('fg-value');
        fgEl.textContent = fearGreed.value;
        fgEl.className   = fearGreed.value <= 25 ? 'green' : fearGreed.value >= 75 ? 'red' : 'yellow';
        document.getElementById('fg-class').textContent = fearGreed.classification;
        const tEl = document.getElementById('fg-trend');
        tEl.textContent = '7d: ' + fearGreed.trend;
        tEl.style.color = fearGreed.trend === 'IMPROVING' ? '#3fb950' : fearGreed.trend === 'WORSENING' ? '#f85149' : '#8b949e';
        document.getElementById('fg-avg').textContent = fearGreed.avg7d + ' (avg)';
      }

      if (cmcData) {
        const domEl = document.getElementById('btc-dom');
        domEl.textContent = cmcData.btcDominance.toFixed(1) + '%';
        domEl.className   = cmcData.btcDominance > 60 ? 'red' : cmcData.btcDominance < 45 ? 'green' : 'yellow';
        document.getElementById('btc-dom-hint').textContent =
          cmcData.btcDominance > 60 ? 'BTC season' : cmcData.btcDominance < 45 ? 'Altcoin season' : 'Netral';
        const mEl = document.getElementById('mkt-change');
        mEl.textContent = (cmcData.marketCapChange24h >= 0 ? '+' : '') + cmcData.marketCapChange24h.toFixed(2) + '%';
        mEl.className   = cmcData.marketCapChange24h >= 0 ? 'green' : 'red';
        const vEl = document.getElementById('pepe-vol-chg');
        vEl.textContent = (cmcData.pepeVolumeChange24h >= 0 ? '+' : '') + cmcData.pepeVolumeChange24h.toFixed(1) + '%';
        vEl.className   = Math.abs(cmcData.pepeVolumeChange24h) > 50 ? 'yellow' : 'val';
      }

      if (geckoData) {
        const tEl = document.getElementById('pepe-trending');
        tEl.textContent = geckoData.isPepeTrending ? 'YA' : '— Tidak';
        tEl.className   = geckoData.isPepeTrending ? 'green' : 'val';
        document.getElementById('pepe-trend-rank').textContent =
          geckoData.isPepeTrending ? 'Rank #' + geckoData.trendingRank + ' Global' : 'Tidak trending';
        document.getElementById('reddit-posts').textContent = geckoData.redditPosts48h.toFixed(1) + ' posts';
        document.getElementById('pepe-rank').textContent   = '#' + geckoData.marketCapRank;
      }
    }

    function renderPosition(pos, price) {
      const pnlPct = pos.side === 'LONG'
        ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage;
      const pnlClass = pnlPct >= 0 ? 'green' : 'red';
      document.getElementById('position-content').innerHTML = \`
        <div class="row"><span class="label">Side</span><span class="val \${pos.side === 'LONG' ? 'green' : 'red'}">\${pos.side}</span></div>
        <div class="row"><span class="label">Entry</span><span class="val">\${formatPepePrice(pos.entryPrice)}</span></div>
        <div class="row"><span class="label">Leverage</span><span class="val">\${pos.leverage}x</span></div>
        <div class="row"><span class="label">Stop Loss</span><span class="val yellow">\${formatPepePrice(pos.stopLoss)}</span></div>
        <div class="row"><span class="label">Take Profit</span><span class="val green">\${formatPepePrice(pos.takeProfit)}</span></div>
        <div class="row"><span class="label">PnL</span><span class="val \${pnlClass}">\${fmtPct(pnlPct)}</span></div>
        <div class="liq-warning">⚠ LIQUIDATION: \${formatPepePrice(pos.liqPrice)} — jangan biarkan harga mencapai ini!</div>
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

    function renderTradeLog(trades) {
      if (!trades || trades.length === 0) return;
      const tbody = document.getElementById('trade-tbody');
      // Tampilkan urutan terbaru di atas
      const sorted = [...trades].reverse();
      tbody.innerHTML = sorted.map(t => {
        const dt   = new Date(t.time);
        const tStr = dt.toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit' })
                   + ' ' + dt.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
        const isOpen  = t.type === 'OPEN';
        const pnlStr  = isOpen ? '—' : ((t.pnlUSDT >= 0 ? '+' : '') + Number(t.pnlUSDT).toFixed(4));
        const pnlCls  = isOpen ? 'val' : (t.pnlUSDT >= 0 ? 'green' : 'red');
        const sideCls = t.side === 'LONG' ? 'green' : 'red';
        const typeCls = isOpen ? 'blue' : (t.pnlUSDT >= 0 ? 'green' : 'red');
        return \`<tr style="border-bottom:1px solid #21262d">
          <td style="padding:4px 8px;color:#8b949e;white-space:nowrap">\${tStr}</td>
          <td style="padding:4px 8px" class="\${typeCls}">\${t.type}</td>
          <td style="padding:4px 8px" class="\${sideCls}">\${t.side}</td>
          <td style="padding:4px 8px;text-align:right">\${formatPepePrice(t.price)}</td>
          <td style="padding:4px 8px;text-align:right">\${Number(t.size).toLocaleString()}</td>
          <td style="padding:4px 8px;text-align:right">\${t.leverage}x</td>
          <td style="padding:4px 8px;text-align:right" class="\${pnlCls}">\${pnlStr}</td>
          <td style="padding:4px 8px;color:#8b949e;font-size:11px">\${t.reason || '—'}</td>
        </tr>\`;
      }).join('');
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
      const _initBal = {
        currentBalance: state.currentBalance,
        initialBalance: state.initialBalance,
        available:      state.available || state.currentBalance,
        unrealizedPnL:  state.unrealizedPnL || 0,
        peakBalance:    state.peakBalance   || state.currentBalance,
        lowestBalance:  state.lowestBalance || state.currentBalance,
        changeUSDT:     state.currentBalance - state.initialBalance,
        changePct:      state.initialBalance > 0 ? ((state.currentBalance - state.initialBalance) / state.initialBalance) * 100 : 0,
        drawdown:       (state.peakBalance || 0) > 0 ? (((state.peakBalance - state.currentBalance) / state.peakBalance) * 100) : 0,
        history:        state.balanceHistory || [],
      };
      res.write(`data: ${JSON.stringify({
        type:        "init",
        price:       state.lastPrice,
        rsi:         state.lastRSI,
        ema9:        state.lastEMA9,
        ema21:       state.lastEMA21,
        fundingRate: state.lastFundingRate,
        position:    state.activePosition,
        stats,
        dryRun:      CONFIG.DRY_RUN,
        balance:     _initBal,               // BUG #1a FIX
        externalData: externalDataCache,     // BUG #1a FIX
        isPaused:    !!(state.pausedUntil && Date.now() < state.pausedUntil), // BUG #6 FIX
        tradeLog:    tradeLog.slice(-50),    // Log transaksi 50 terakhir
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

  // Kirim stats + win rate setiap 30 detik
  setInterval(() => {
    broadcastSSE({ type: "stats", ...stats, compoundBalance: compoundedBalance });
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

  // Fitur #9: jalankan backtest lalu keluar jika BACKTEST_MODE = true
  if (CONFIG.BACKTEST_MODE) {
    await runBacktest();
    process.exit(0);
  }

  // Load data tersimpan
  loadPersistedData();

  // BUG #4 FIX: ambil balance awal
  if (!CONFIG.DRY_RUN && CONFIG.API_KEY) {
    try {
      const accountInfo = await getAccountInfo();
      state.initialBalance = accountInfo.equity;
      state.currentBalance = accountInfo.equity;
      log("INFO", `Balance akun: ${accountInfo.available.toFixed(4)} USDT available | Equity: ${accountInfo.equity.toFixed(4)} USDT`);
    } catch (err) {
      log("WARN", `Gagal ambil balance awal: ${err.message}`);
    }
  } else {
    state.initialBalance = CONFIG.POSITION_SIZE_USDT * 10;
    state.currentBalance = state.initialBalance;
    log("INFO", `[DRY RUN] Balance simulasi: ${state.initialBalance} USDT`);
  }

  // Setup margin mode (live only)
  if (!CONFIG.DRY_RUN && CONFIG.API_KEY) {
    try {
      await setMarginMode();
      log("INFO", `Margin mode diset ke: ${CONFIG.MARGIN_MODE}`);
    } catch (err) {
      log("WARN", `Gagal set margin mode: ${err.message}`);
    }
  }

  // BUG #3 FIX: fetch data eksternal SEBELUM startDashboard agar init event sudah punya data
  await fetchAllExternalData();

  // Mulai dashboard
  startDashboard();
  await fetchAndUpdateBalance();

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
