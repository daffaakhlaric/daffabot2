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
  MAX_LEVERAGE:     7,

  // Ukuran posisi
  POSITION_SIZE_USDT: 2,   // USDT per trade
  MAX_POSITIONS:       1,

  // Risk management — SL disesuaikan untuk PEPE (spread ~0.2% + fee 0.12% = cost 0.32%)
  STOP_LOSS_PCT:    2.5,    // dari 1.0 → 2.5% (beri ruang noise PEPE)
  TAKE_PROFIT_PCT:  5.0,    // dari 2.0 → 5.0% (RR 1:2 tetap terjaga)
  TRAILING_STOP:    true,    // aktifkan trailing stop
  TRAILING_OFFSET:  0.8,     // dari 0.3 → 0.8% (tidak kena noise)
  MAX_LOSS_PCT:     8.0,     // dari 5.0 → 8.0% (longgarkan force close)
  // Minimum SL untuk cover spread + fee PEPE
  MIN_SL_PCT:       0.5,    // minimal SL untuk cover cost masuk-keluar
  MAX_SL_PCT:       3.5,    // maksimal SL
  HARD_STOP_TOTAL:  20.0,   // hard stop jika total loss > 20%

  // Funding rate threshold
  FUNDING_RATE_THRESHOLD: 0.001, // 0.1% = pertimbangkan tutup

  // Jadwal
  CHECK_INTERVAL_MS:        10000, // 10 detik
  CLAUDE_ANALYSIS_INTERVAL: 6,    // scalping: setiap 6 tick = ~1 menit (lebih responsif)

  // Batas confidence AI — lebih selektif setelah loss streak
  OPEN_CONFIDENCE:  75,   // dari 70 → 75
  CLOSE_CONFIDENCE: 55,   // tidak dipakai SMC (SL/TP auto dari swing)

  // Hemat kredit AI: skip panggilan kalau tidak ada sinyal kuat
  CLAUDE_SMART_FILTER: false,   // SMC: Claude hanya dipanggil saat setup lengkap
  CLAUDE_RSI_DEAD_ZONE: 5,     // skip kalau RSI dalam range 50±5 (45-55) = netral

  // Dry run (WAJIB true saat testing SMC minimal 5 hari!)
  DRY_RUN: true,

  // Dashboard
  DASHBOARD_PORT: process.env.MONITOR_PORT ? parseInt(process.env.MONITOR_PORT) : 4000,

  // File persistensi
  TRADES_FILE: "trades.json",
  STATS_FILE:  "stats.json",
  STATE_FILE:  "state.json",

  // ── Fitur #1: Multi-Timeframe Analysis ────────────────────
  REQUIRE_MTF_CONSENSUS: false,  // scalping: matikan MTF consensus

  // ── Fitur #2: Bollinger Bands ─────────────────────────────
  BB_PERIOD:  20,
  BB_STDDEV:  2,

  // ── Fitur #3: VWAP ────────────────────────────────────────
  VWAP_BIAS_THRESHOLD: 0.5,   // % di atas/bawah VWAP untuk bias

  // ── Fitur #5: Partial Close ───────────────────────────────
  PARTIAL_CLOSE_ENABLED: true,
  PARTIAL_CLOSE_PCT:     50,    // tutup 50% posisi
  PARTIAL_CLOSE_TRIGGER: 1.5,   // dari 0.8 → 1.5% (jangan terlalu cepat)

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

  // ── CONFIRMATION-BASED REVERSAL SCALPING ─────────────────
  // [1] ATR-based SL/TP — lebih longgar untuk PEPE
  ATR_SL_MULTIPLIER:  2.0,   // dari 1.5 → 2.0
  ATR_TP_MULTIPLIER:  3.5,   // dari 2.5 → 3.5

  // [2] Volatility filter — skip trading saat ATR terlalu rendah
  ATR_MIN_MULTIPLIER: 0.7,   // skip jika ATR < avgATR × 0.7

  // [3] Entry delay — tunggu N candle setelah sinyal reversal
  ENTRY_CONFIRM_CANDLES: 2,  // jumlah candle konfirmasi sebelum masuk

  // [4] Post-SL cooldown — tunggu N candle setelah stop loss
  SL_COOLDOWN_CANDLES: 3,    // tunggu 3 candle (≈30 detik di 1m) setelah SL
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
  // Chart data
  lastKlines:       [],   // klines 1m terakhir untuk chart dashboard
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
    markPrice: parseFloat(d.markPr || d.lastPr),
    quoteVolume: parseFloat(d.quoteVolume || 0),
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

  // validasi urutan agar RSI/EMA dihitung oldest→newest
  if (candles.length >= 2 && candles[0].time > candles[candles.length - 1].time) {
    candles.reverse(); // auto-fix urutan tanpa spam log
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

/**
 * Risk-based order sizing — posisi dihitung agar jika SL kena,
 * loss = POSITION_SIZE_USDT (modal isolated yang diinput).
 * qty × price × slPct% = riskUsdt
 */
function calcOrderSizeByRisk(price, slPct) {
  const CONTRACT_SIZE = 1000;
  const riskUsdt  = CONFIG.POSITION_SIZE_USDT;
  const rawQty    = riskUsdt / (price * slPct / 100);
  const contracts = Math.max(1, Math.floor(rawQty / CONTRACT_SIZE));
  const finalQty  = contracts * CONTRACT_SIZE;
  const notional  = finalQty * price;
  const leverage  = Math.min(Math.ceil(notional / riskUsdt), CONFIG.MAX_LEVERAGE);
  log("INFO",
    `[Risk sizing] risk=${riskUsdt}USDT sl=${slPct.toFixed(3)}% ` +
    `qty=${finalQty} notional=${notional.toFixed(2)}USDT lev=${leverage}x`
  );
  return { qty: finalQty, leverage };
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

async function openPosition(side, leverage, price, overrideQty = null) {
  const qty = overrideQty || calcOrderSize(price, leverage);
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
    trailingTP:   takeProfit, // untuk trailing TP dinamis
    tpTrailPct:   CONFIG.TAKE_PROFIT_PCT * 0.5, // 50% dari TP awal untuk trailing
    breakevenSet: false,  // flag auto breakeven
    lockLevel:    undefined, // level lock profit aktif
    momentumWeakCount: 0,  // counter untuk early exit momentum
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

  // FIX #7: Log diagnostik untuk debugging SL
  const holdDurationMs = pos.openTime ? Date.now() - new Date(pos.openTime).getTime() : 0;
  const holdSec = Math.round(holdDurationMs / 1000);
  if (reason.includes("STOP_LOSS") || reason.includes("FORCE_CLOSE")) {
    log("WARN",
      `📊 SL Diagnostik: Hold=${holdSec}s | Entry=${pos.entryPrice.toFixed(8)} Exit=${currentPrice.toFixed(8)} | Gerak=${Math.abs((currentPrice-pos.entryPrice)/pos.entryPrice*100).toFixed(4)}%`
    );
    if (holdSec < 60) {
      log("WARN",
        `⚠️ SL dalam ${holdSec} detik! Kemungkinan: spread terlalu besar, SL terlalu ketat, atau entry di harga ekstrem`
      );
    }
    // Catat ke stats untuk analisis
    if (!stats.slDiagnostics) stats.slDiagnostics = [];
    stats.slDiagnostics.push({
      time:      new Date().toISOString(),
      holdSec,
      entryPrice: pos.entryPrice,
      exitPrice:  currentPrice,
      movePct:   Math.abs((currentPrice-pos.entryPrice)/pos.entryPrice*100),
      side:       pos.side,
      leverage:   pos.leverage,
    });
    if (stats.slDiagnostics.length > 20) stats.slDiagnostics.shift();
  }

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

  // FIX #2: Post-SL Cooldown — cegah revenge trading
  if (reason === "STOP_LOSS" || reason === "FORCE_CLOSE_MAX_LOSS" || reason.includes("HARD_STOP")) {
    const lossStreak = stats.losses;
    // Durasi cooldown bertingkat berdasarkan loss streak
    const cooldownMs =
      lossStreak >= 5 ? 120 * 60 * 1000 :  // 2 jam kalau loss 5+
      lossStreak >= 3 ? 60  * 60 * 1000 :  // 1 jam kalau loss 3+
                        15  * 60 * 1000;    // 15 menit normal
    state.pausedUntil = Date.now() + cooldownMs;
    state.pauseReason =
      `SL cooldown — loss streak ${lossStreak}x ` +
      `(${Math.round(cooldownMs / 60000)} menit)`;
    log("WARN",
      `⏸ Cooldown ${Math.round(cooldownMs / 60000)} menit setelah SL ke-${lossStreak} — cegah revenge trading`
    );
    // Emergency pause kalau loss streak ≥ 5
    if (lossStreak >= 5) {
      log("ERROR",
        `🛑 EMERGENCY PAUSE! Loss streak ${lossStreak}x berturut — pause 2 jam. Buka dashboard untuk review.`
      );
      broadcastSSE({
        type:      "emergency_stop",
        lossStreak,
        message:   `Loss streak ${lossStreak}x — pause 2 jam otomatis`,
        resumeAt:  new Date(state.pausedUntil).toLocaleTimeString("id-ID"),
      });
    }
    broadcastSSE({
      type:      "sl_cooldown",
      lossStreak,
      cooldownMs,
      resumeAt:  state.pausedUntil,
      message:   state.pauseReason,
    });
    // Simpan harga SL terakhir untuk avoid entry
    smcState.lastSLPrice = currentPrice;
  }

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
  // Filter volume 0 agar tidak distorsi rata-rata
  const nonZeroVols = volumes.filter(v => v > 0);
  const avgVol = nonZeroVols.length > 0
    ? nonZeroVols.slice(-20).reduce((a, b) => a + b, 0) /
      Math.min(nonZeroVols.length, 20)
    : 1;
  const lastVol = volumes[volumes.length - 1] || 0;

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

  // Prompt ringkas — hemat token ~55% vs versi panjang
  const p = marketData;
  const posStr = p.activePosition
    ? `${p.activePosition.side} entry=${p.activePosition.entryPrice.toFixed(8)} ${p.activePosition.leverage}x PnL=${p.activePosition.pnlPct !== undefined ? (p.activePosition.pnlPct >= 0 ? "+" : "") + p.activePosition.pnlPct.toFixed(2) + "%" : "?"} Liq=${p.activePosition.liqPrice ? p.activePosition.liqPrice.toFixed(8) : "?"}`
    : "tidak ada";
  const geckoStr = p.geckoData
    ? `PEPE 1h=${p.geckoData.change1h.toFixed(2)}% 24h=${p.geckoData.change24h.toFixed(2)}% 7d=${p.geckoData.change7d.toFixed(2)}% Vol=$${(p.geckoData.volume24h/1e6).toFixed(1)}M${p.geckoData.isPepeTrending ? ` TRENDING#${p.geckoData.trendingRank}` : ""}`
    : "gecko:N/A";
  const cmcStr = p.cmcData
    ? `BTCdom=${p.cmcData.btcDominance.toFixed(1)}% MktCap24h=${p.cmcData.marketCapChange24h >= 0 ? "+" : ""}${p.cmcData.marketCapChange24h.toFixed(2)}% PEPEvol=${p.cmcData.pepeVolumeChange24h >= 0 ? "+" : ""}${p.cmcData.pepeVolumeChange24h.toFixed(2)}%`
    : "cmc:N/A";
  const mtfStr = p.mtf
    ? `1m:${p.mtf.tf1m.trend}/RSI${p.mtf.tf1m.rsi.toFixed(0)} 5m:${p.mtf.tf5m.trend}/RSI${p.mtf.tf5m.rsi.toFixed(0)} 15m:${p.mtf.tf15m.trend}/RSI${p.mtf.tf15m.rsi.toFixed(0)} Consensus:${p.consensus}`
    : "MTF:N/A";
  const bbStr = p.bb
    ? `U=${p.bb.upper.toFixed(8)} M=${p.bb.middle.toFixed(8)} L=${p.bb.lower.toFixed(8)} %B=${p.bb.pctB.toFixed(3)} Squeeze=${p.squeeze?.squeeze ? "YA" : "tidak"} Break=${p.squeeze?.breakoutDirection || "NONE"}`
    : "BB:N/A";
  const prompt = `Bot PEPE/USDT Bitget futures. MODE: SCALPING AGRESIF (hold <30 menit, target cepat). Balas HANYA JSON.

PASAR: ${p.price.toFixed(8)} Bid/Ask:${p.bid.toFixed(8)}/${p.ask.toFixed(8)} Vol24h:${(p.volume24h/1e9).toFixed(2)}B Δ24h:${(p.change24h*100).toFixed(2)}%
TEKNIKAL: RSI:${p.rsi.toFixed(1)} EMA9:${p.ema9.toFixed(8)} EMA21:${p.ema21.toFixed(8)} VolRatio:${p.volumeRatio.toFixed(2)}x
ORDERBOOK: Bid/Ask ratio=${p.orderBook.bidAskRatio.toFixed(3)}
FUNDING: ${(p.fundingRate*100).toFixed(4)}%${Math.abs(p.fundingRate) > 0.001 ? " ⚠tinggi" : ""} SIGNAL:${p.fundingSignal}${p.fundingRate < -0.0001 ? " ⚡mayoritas short→bias LONG" : p.fundingRate > 0.0001 ? " ⚠mayoritas long→pertimbangkan SHORT" : ""}
F&G: ${p.fearGreed.value}(${p.fearGreed.classification}) Avg7d:${p.fearGreed.avg7d} Trend:${p.fearGreed.trend}
${geckoStr}
${cmcStr}
POSISI: ${posStr}
MTF: ${mtfStr}
BB: ${bbStr}
VWAP: ${p.vwap.toFixed(8)} vs harga ${p.vwapPct >= 0 ? "+" : ""}${p.vwapPct.toFixed(3)}% POC:${p.volProf?.poc.toFixed(8) || "N/A"}
CANDLE: Bull:[${p.candlePatterns?.bullishPatterns.join(",") || "-"}] Bear:[${p.candlePatterns?.bearishPatterns.join(",") || "-"}] Bias:${p.candlePatterns?.dominantBias}(${p.candlePatterns?.strength})
PERFORMA: WR:${p.winRate.toFixed(1)}% Streak:${p.streak > 0 ? "+" : ""}${p.streak} TotalPnL:${p.totalPnL >= 0 ? "+" : ""}${p.totalPnL.toFixed(4)}USDT

Aturan SCALPING AGRESIF:
- buka≥${CONFIG.OPEN_CONFIDENCE}% tutup≥${CONFIG.CLOSE_CONFIDENCE}%
- RSI 55-65 + EMA cross = confidence minimal 65%
- RSI 45-55 + volume spike = confidence minimal 60%
- BB breakout + volume = confidence minimal 70%
- Jangan tunggu kondisi sempurna — scalping butuh action
- Funding negatif saat market BULLISH = LONG lebih aman (short membayar long, artinya mayoritas short)
- Fear&Greed Extreme Fear (<20) = peluang bounce LONG
- Volume ratio < 0.1x → HOLD (tidak ada momentum)
- Volume ratio > 0.3x = konfirmasi sinyal KUAT
- Leverage 7-10x untuk semua entry
- SL ketat 0.5-1.0%, TP cepat 1.0-2.0%
- Jangan confidence < 50% kecuali kondisi sangat buruk
{"action":"LONG|SHORT|CLOSE|HOLD","leverage":7-10,"confidence":0-100,"sentiment":"BULLISH|BEARISH|NEUTRAL|VOLATILE","stop_loss_pct":0.5-1.5,"take_profit_pct":1.0-2.5,"reasoning":"<30 kata"}`;


  const bodyStr = JSON.stringify({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 200,   // JSON response kecil, 200 cukup
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
// SMC — SMART MONEY CONCEPTS
// ─────────────────────────────────────────────────────────────

/** 1A — HTF Trend Filter (15m EMA50 vs EMA200) */
async function getHTFTrend() {
  try {
    const klines5m = await getKlines("5m", 110); // HTF = 5m, EMA50+EMA100
    if (klines5m.length < 100) return { trend: "NEUTRAL", strength: "WEAK" };
    const closes = klines5m.map(k => k.close);
    function emaLocal(data, period) {
      const k = 2 / (period + 1);
      let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
      return ema;
    }
    const ema50  = emaLocal(closes, 50);
    const ema100 = emaLocal(closes, 100); // EMA100 menggantikan EMA200 (sesuai jumlah candle)
    const sep    = Math.abs((ema50 - ema100) / ema100 * 100);
    return {
      trend:    ema50 > ema100 ? "BULLISH" : "BEARISH",
      strength: sep > 0.5 ? "STRONG" : "WEAK", // threshold diturunkan karena TF lebih kecil
      ema50, ema200: ema100, sep: parseFloat(sep.toFixed(3)),
    };
  } catch (err) {
    log("WARN", `HTF trend gagal: ${err.message}`);
    return { trend: "NEUTRAL", strength: "WEAK" };
  }
}

/** 1B — Fractal Swing Detection (5 candle) */
function detectSwings(klines) {
  const highs = [], lows = [];
  for (let i = 2; i < klines.length - 2; i++) {
    const c = klines[i];
    if (c.high > klines[i-1].high && c.high > klines[i-2].high &&
        c.high > klines[i+1].high && c.high > klines[i+2].high) {
      highs.push({ index: i, price: c.high, time: c.time });
    }
    if (c.low < klines[i-1].low && c.low < klines[i-2].low &&
        c.low < klines[i+1].low && c.low < klines[i+2].low) {
      lows.push({ index: i, price: c.low, time: c.time });
    }
  }
  const rh = highs.slice(-5), rl = lows.slice(-5);
  return {
    swingHighs: rh, swingLows: rl,
    lastHigh:   rh[rh.length - 1] || null,
    lastLow:    rl[rl.length - 1] || null,
    prevHigh:   rh[rh.length - 2] || null,
    prevLow:    rl[rl.length - 2] || null,
  };
}

/** 1C — Inducement Detection */
function detectInducement(swings, side) {
  const arr   = side === "BULLISH" ? swings.swingLows : swings.swingHighs;
  const slice = arr.slice(-4);
  if (slice.length < 3) return { valid: false, count: 0 };
  let count = 0;
  for (let i = 1; i < slice.length; i++) {
    const ok = side === "BULLISH"
      ? slice[i].price > slice[i-1].price   // Higher Low
      : slice[i].price < slice[i-1].price;  // Lower High
    if (ok) count++;
  }
  return { valid: count >= 2, count, type: side === "BULLISH" ? "HIGHER_LOW" : "LOWER_HIGH" };
}

/** 1D — Liquidity Grab Detection */
function detectLiquidityGrab(klines, swings, side) {
  if (klines.length < 5) return { detected: false };
  const bodies  = klines.slice(-20).map(k => Math.abs(k.close - k.open));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  const last    = klines[klines.length - 1];
  const bodySize = Math.abs(last.close - last.open);
  if (side === "BULLISH") {
    const sl = swings.lastLow;
    if (!sl) return { detected: false };
    return {
      detected:  last.low < sl.price && last.close > sl.price && bodySize > avgBody * 0.8,
      grabPrice: sl.price,
      bodySize:  parseFloat(bodySize.toFixed(8)),
      avgBody:   parseFloat(avgBody.toFixed(8)),
    };
  } else {
    const sh = swings.lastHigh;
    if (!sh) return { detected: false };
    return {
      detected:  last.high > sh.price && last.close < sh.price && bodySize > avgBody * 0.8,
      grabPrice: sh.price,
      bodySize:  parseFloat(bodySize.toFixed(8)),
      avgBody:   parseFloat(avgBody.toFixed(8)),
    };
  }
}

/** 1E — CHoCH Detection (close + volume wajib) */
function detectCHoCH(klines, swings, side, avgVol) {
  if (klines.length < 3) return { detected: false };
  const last = klines[klines.length - 1];
  if (side === "BULLISH") {
    const ph = swings.prevHigh;
    if (!ph) return { detected: false };
    const ok = last.close > ph.price && last.volume > avgVol * 0.8;
    return { detected: ok, breakLevel: ph.price, volume: last.volume, avgVol, confirmed: ok && last.volume > avgVol };
  } else {
    const pl = swings.prevLow;
    if (!pl) return { detected: false };
    const ok = last.close < pl.price && last.volume > avgVol * 0.8;
    return { detected: ok, breakLevel: pl.price, volume: last.volume, avgVol, confirmed: ok && last.volume > avgVol };
  }
}

/** 1F — FVG Detection */
function detectFVG(klines, side) {
  const bullFVGs = [], bearFVGs = [];
  for (let i = 2; i < klines.length; i++) {
    const c1 = klines[i-2], c3 = klines[i];
    const minGap = c1.high * 0.0001;
    if (side === "BULLISH" && c3.low > c1.high && (c3.low - c1.high) > minGap) {
      bullFVGs.push({ type: "BULLISH", upper: c3.low, lower: c1.high, mid: (c3.low + c1.high) / 2, time: klines[i-1].time });
    }
    if (side === "BEARISH" && c3.high < c1.low && (c1.low - c3.high) > minGap) {
      bearFVGs.push({ type: "BEARISH", upper: c1.low, lower: c3.high, mid: (c1.low + c3.high) / 2, time: klines[i-1].time });
    }
  }
  const lb = bullFVGs.slice(-3), lbr = bearFVGs.slice(-3);
  return {
    lastBullFVG: lb[lb.length - 1] || null,
    lastBearFVG: lbr[lbr.length - 1] || null,
    bullFVGs: lb, bearFVGs: lbr,
  };
}

function isPriceInFVG(price, fvg, side) {
  const zone = side === "BULLISH" ? fvg.lastBullFVG : fvg.lastBearFVG;
  if (!zone) return { inFVG: false };
  return { inFVG: price >= zone.lower && price <= zone.upper, fvg: zone };
}

/** 1G — Entry Candle Confirmation */
function confirmEntryCandle(klines, side) {
  const c     = klines[klines.length - 1];
  const body  = c.close - c.open;
  const range = c.high - c.low || 1;
  if (side === "BULLISH") {
    const isGreen       = c.close > c.open;
    const closeNearHigh = (c.high - c.close) / range < 0.3;
    return { confirmed: isGreen && closeNearHigh, isGreen, closeNearHigh, bodyPct: parseFloat((Math.abs(body)/range*100).toFixed(1)) };
  } else {
    const isRed        = c.close < c.open;
    const closeNearLow = (c.close - c.low) / range < 0.3;
    return { confirmed: isRed && closeNearLow, isRed, closeNearLow, bodyPct: parseFloat((Math.abs(body)/range*100).toFixed(1)) };
  }
}

/** 1H — Session Filter (WIB) */
function isActiveSession() {
  const now   = new Date();
  const hour  = now.getUTCHours();
  const min   = now.getUTCMinutes();
  const t     = hour + min / 60;
  const inLondon  = t >= 7  && t < 16;
  const inNY      = t >= 13 && t < 22;
  const inOverlap = t >= 13 && t < 16;
  return {
    active:     inLondon || inNY,
    session:    inOverlap ? "OVERLAP(TERBAIK)" : inNY ? "NEW_YORK" : inLondon ? "LONDON" : "ASIA(SKIP)",
    inLondon, inNY, inOverlap,
    wibHour:    (hour + 7) % 24,
  };
}

/**
 * 1I-B — Supply/Demand Zone Touch Detection
 * Demand (LONG) : price retest swing-low area dengan candle bullish rejection
 * Supply (SHORT): price retest swing-high area dengan candle bearish rejection
 * "strong" = wick rejection ≥ 30% range + close di luar zone = konfirmasi kuat
 */
function detectSDZoneTouch(klines, swings, side) {
  if (klines.length < 3) return { detected: false };
  const last  = klines[klines.length - 1];
  const range = last.high - last.low || 1e-10;

  if (side === "BULLISH") {
    const zones = [swings.lastLow, swings.prevLow].filter(Boolean);
    for (const z of zones) {
      // Low candle masuk ke area demand zone (±0.5% dari swing low)
      const inZone = last.low <= z.price * 1.005 && last.low >= z.price * 0.995;
      if (inZone) {
        const lowerWick = Math.min(last.open, last.close) - last.low;
        const wickRatio = lowerWick / range;
        const isBullish = last.close > last.open;
        const closeAbove = last.close > z.price; // rebound ke atas zone
        const strong = isBullish && wickRatio >= 0.30 && closeAbove;
        return {
          detected:  true,
          strong,
          zone:      z.price,
          zoneType:  "DEMAND",
          proximity: parseFloat((Math.abs(last.low - z.price) / z.price * 100).toFixed(4)),
          wickRatio: parseFloat(wickRatio.toFixed(3)),
        };
      }
    }
  } else {
    const zones = [swings.lastHigh, swings.prevHigh].filter(Boolean);
    for (const z of zones) {
      // High candle masuk ke area supply zone (±0.5% dari swing high)
      const inZone = last.high >= z.price * 0.995 && last.high <= z.price * 1.005;
      if (inZone) {
        const upperWick = last.high - Math.max(last.open, last.close);
        const wickRatio = upperWick / range;
        const isBearish = last.close < last.open;
        const closeBelow = last.close < z.price; // reject kembali ke bawah zone
        const strong = isBearish && wickRatio >= 0.30 && closeBelow;
        return {
          detected:  true,
          strong,
          zone:      z.price,
          zoneType:  "SUPPLY",
          proximity: parseFloat((Math.abs(last.high - z.price) / z.price * 100).toFixed(4)),
          wickRatio: parseFloat(wickRatio.toFixed(3)),
        };
      }
    }
  }
  return { detected: false };
}

/** 1I — ATR (Average True Range) */
function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i-1].close),
      Math.abs(klines[i].low  - klines[i-1].close)
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Confirmation-Based Reversal Helpers ───────────────────────

/**
 * [1] ATR-based SL/TP calculator
 * SL = entry ± (ATR × ATR_SL_MULTIPLIER)
 * TP = entry ± (ATR × ATR_TP_MULTIPLIER)
 * Lebih adaptif dari fixed % — mengikuti volatilitas aktual pasar.
 */
function calcATRStops(side, entryPrice, atr) {
  const slDist = atr * CONFIG.ATR_SL_MULTIPLIER;
  const tpDist = atr * CONFIG.ATR_TP_MULTIPLIER;
  const stopLoss   = side === "LONG" ? entryPrice - slDist : entryPrice + slDist;
  const takeProfit = side === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
  const slPct      = slDist / entryPrice * 100;
  const tpPct      = tpDist / entryPrice * 100;
  return { stopLoss, takeProfit, slPct, tpPct, slDist, tpDist };
}

/**
 * [2] Volatility filter — cek apakah ATR cukup untuk trading.
 * Menghindari entry saat market sedang konsolidasi/squeeze.
 * Returns { pass, atr, avgATR, ratio }
 */
function checkVolatilityFilter(klines) {
  if (klines.length < 28) return { pass: true, atr: 0, avgATR: 0, ratio: 1 };
  // Hitung ATR 14 dari seluruh klines, lalu ambil rata-rata 14 ATR terakhir
  const atrs = [];
  for (let i = 15; i < klines.length; i++) {
    const slice = klines.slice(i - 14, i + 1);
    atrs.push(calcATR(slice, 14));
  }
  const atr    = atrs[atrs.length - 1] || 0;
  const avgATR = atrs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(atrs.length, 14);
  const ratio  = avgATR > 0 ? atr / avgATR : 1;
  const pass   = ratio >= CONFIG.ATR_MIN_MULTIPLIER;
  return { pass, atr, avgATR, ratio: parseFloat(ratio.toFixed(3)) };
}

/**
 * [2] Reversal confirmation filter
 * Sebelum entry, pastikan reversal dikonfirmasi oleh indikator:
 * LONG: RSI naik dari OS (<35) + close > EMA9 + ada higher-low
 * SHORT: RSI turun dari OB (>65) + close < EMA9 + ada lower-high
 * Returns { pass, reasons[] }
 */
function checkReversalConfirmation(side, klines, indicators, swings) {
  const reasons = [];
  let score = 0;
  const last = klines[klines.length - 1];

  if (side === "BULLISH") {
    // RSI in oversold territory
    if (indicators.rsi < 45) { score += 2; reasons.push(`RSI OS (${indicators.rsi.toFixed(1)})`); }
    // Close above EMA9
    if (last.close > indicators.ema9) { score += 2; reasons.push("Close > EMA9"); }
    // Higher low confirmation (last swing low > prev swing low)
    const hl = swings.lastLow && swings.prevLow && swings.lastLow.price > swings.prevLow.price;
    if (hl) { score += 2; reasons.push("Higher Low"); }
    // Bullish candle (green close)
    if (last.close > last.open) { score += 1; reasons.push("Bullish candle"); }
  } else {
    // RSI falling from overbought
    if (indicators.rsi > 55) { score += 2; reasons.push(`RSI OB (${indicators.rsi.toFixed(1)})`); }
    // Close below EMA9
    if (last.close < indicators.ema9) { score += 2; reasons.push("Close < EMA9"); }
    // Lower high confirmation
    const lh = swings.lastHigh && swings.prevHigh && swings.lastHigh.price < swings.prevHigh.price;
    if (lh) { score += 2; reasons.push("Lower High"); }
    // Bearish candle (red close)
    if (last.close < last.open) { score += 1; reasons.push("Bearish candle"); }
  }

  // Butuh score ≥ 4 dari 7 untuk lolos
  return { pass: score >= 4, score, maxScore: 7, reasons };
}

// ── Reversal Detection Functions ──────────────────────────────

/**
 * B. Liquidity Sweep — wick menembus swing level lalu reject balik.
 * Berbeda dari detectLiquidityGrab (hanya cek candle terakhir),
 * fungsi ini scan 5 candle terakhir untuk cari event sweep.
 */
function detectLiquiditySweep(klines, swings, side) {
  if (klines.length < 3) return { detected: false };
  const recent = klines.slice(-5);

  if (side === "BULLISH") {
    const level = swings.lastLow?.price;
    if (!level) return { detected: false };
    for (let i = recent.length - 1; i >= 0; i--) {
      const c = recent[i];
      // Wick tembus di bawah swing low, tapi close kembali di atas
      if (c.low < level && c.close > level) {
        const wickSize = level - c.low;
        return {
          detected:   true,
          level,
          wickSize:   parseFloat(wickSize.toFixed(8)),
          rejection:  parseFloat((c.close - c.low).toFixed(8)),
          strong:     c.close > c.open, // candle bullish setelah sweep = kuat
        };
      }
    }
  } else {
    const level = swings.lastHigh?.price;
    if (!level) return { detected: false };
    for (let i = recent.length - 1; i >= 0; i--) {
      const c = recent[i];
      // Wick tembus di atas swing high, tapi close kembali di bawah
      if (c.high > level && c.close < level) {
        const wickSize = c.high - level;
        return {
          detected:   true,
          level,
          wickSize:   parseFloat(wickSize.toFixed(8)),
          rejection:  parseFloat((c.high - c.close).toFixed(8)),
          strong:     c.close < c.open, // candle bearish setelah sweep = kuat
        };
      }
    }
  }
  return { detected: false, level: side === "BULLISH" ? swings.lastLow?.price : swings.lastHigh?.price };
}

/**
 * C. Break of Structure (BOS) — close melampaui swing high/low sebelumnya.
 * BOS bullish: close > previous swing high → struktur naik.
 * BOS bearish: close < previous swing low  → struktur turun.
 */
function detectBreakOfStructure(klines, swings, side) {
  if (klines.length < 2) return { detected: false };
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];

  if (side === "BULLISH") {
    const target = swings.prevHigh?.price || swings.lastHigh?.price;
    if (!target) return { detected: false, type: "BOS_BULLISH" };
    const broken   = last.close > target;
    const momentum = broken && last.close > last.open && last.close > prev.close;
    return {
      detected:    broken,
      type:        "BOS_BULLISH",
      breakLevel:  target,
      momentum,
      breakAmount: broken ? parseFloat(((last.close - target) / target * 100).toFixed(4)) : 0,
    };
  } else {
    const target = swings.prevLow?.price || swings.lastLow?.price;
    if (!target) return { detected: false, type: "BOS_BEARISH" };
    const broken   = last.close < target;
    const momentum = broken && last.close < last.open && last.close < prev.close;
    return {
      detected:    broken,
      type:        "BOS_BEARISH",
      breakLevel:  target,
      momentum,
      breakAmount: broken ? parseFloat(((target - last.close) / target * 100).toFixed(4)) : 0,
    };
  }
}

/**
 * D. Reversal Score 0–100.
 * Skor komposit dari sinyal reversal kelas institusional.
 * Grade: A (≥80) · B (≥60) · C (≥40) · D (<40)
 * Claude hanya dipanggil saat score ≥ 60 (grade B/A).
 */
function calculateReversalScore({ sweep, bos, rsi, bbData, price, volumeRatio, candlePatterns, htfStrength }) {
  let score = 0;
  const reasons = [];

  // Liquidity sweep: sinyal terkuat, +40–45
  if (sweep?.detected) {
    const pts = sweep.strong ? 45 : 35;
    score += pts;
    reasons.push(`Liq sweep ${sweep.strong ? "kuat" : "lemah"} +${pts}`);
  }

  // BOS: konfirmasi perubahan struktur, +25–35
  if (bos?.detected) {
    const pts = bos.momentum ? 35 : 25;
    score += pts;
    reasons.push(`${bos.type} +${pts}`);
  }

  // RSI extreme: mean reversion signal
  if (rsi < 25 || rsi > 75)      { score += 20; reasons.push(`RSI ekstrem (${rsi.toFixed(1)}) +20`); }
  else if (rsi < 30 || rsi > 70) { score += 12; reasons.push(`RSI OB/OS (${rsi.toFixed(1)}) +12`); }

  // Bollinger band touch / breach
  if (bbData) {
    if (price <= bbData.lower || price >= bbData.upper) {
      score += 12; reasons.push(`Harga di luar BB +12`);
    } else if (bbData.pctB < 0.1 || bbData.pctB > 0.9) {
      score += 7;  reasons.push(`%B ekstrem (${bbData.pctB.toFixed(2)}) +7`);
    }
  }

  // Volume confirmation
  if (volumeRatio > 1.5)      { score += 8; reasons.push(`Volume spike ${volumeRatio.toFixed(1)}x +8`); }
  else if (volumeRatio > 0.8) { score += 3; }

  // HTF strength bonus
  if (htfStrength === "STRONG") { score += 5; reasons.push("HTF kuat +5"); }

  // Candle pattern
  const nPat = (candlePatterns?.bullishPatterns?.length || 0) + (candlePatterns?.bearishPatterns?.length || 0);
  if (nPat > 0) { const pts = Math.min(nPat * 5, 10); score += pts; reasons.push(`Candle pattern +${pts}`); }

  const final = Math.min(100, score);
  return {
    score:   final,
    reasons,
    grade:   final >= 80 ? "A" : final >= 60 ? "B" : final >= 40 ? "C" : "D",
    callAI:  final >= 60,
  };
}

/** 1J — SMC State */
const smcState = {
  htfTrend:      null,
  htfLastUpdate: 0,
  setupValid:    false,
  lastEntryTime: 0,
  minEntryGap:   5 * 60 * 1000, // minimal 5 menit antar entry (dari 3 menit)
  lastSLPrice:     0,         // harga saat SL terakhir
  slZoneBuffer:    0.005,     // 0.5% buffer dari harga SL terakhir

  // [3] Entry delay — pending signal menunggu konfirmasi N candle
  pendingSignal:      null,   // { side, detectedAt, candleCount }
  pendingCandleCount: 0,

  // [4] Post-SL cooldown
  lastSLTime:       0,        // timestamp terakhir SL hit
  slCooldownCount:  0,        // candle counter sejak SL terakhir
};

// ─────────────────────────────────────────────────────────────
// SMC — CLAUDE FILTER
// ─────────────────────────────────────────────────────────────

async function analyzeWithClaudeSMC(smcSetup, marketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { approve: false, confidence: 0, reason: "Tidak ada API key" };

  const p       = marketData;
  const extData = externalDataCache;

  const prompt = `Bot PEPE/USDT Bitget. SMC setup sudah terdeteksi.
Tugasmu: konfirmasi apakah AMAN untuk entry sekarang.

SMC SETUP:
- Side: ${smcSetup.side}
- HTF Trend: ${smcSetup.htfTrend} (${smcSetup.htfStrength})
- Session: ${smcSetup.session}
- ATR: ${smcSetup.atrPct}%
- Inducement: ${smcSetup.inducement.count}x ${smcSetup.inducement.type}
- Liq Grab: harga wick ke ${smcSetup.grabPrice?.toFixed(8) || "N/A"} lalu rebound
- CHoCH: close melewati level ${smcSetup.chochLevel?.toFixed(8) || "N/A"}
- FVG Zone: ${smcSetup.fvgLower?.toFixed(8) || "N/A"} - ${smcSetup.fvgUpper?.toFixed(8) || "N/A"}
- Harga sekarang: ${p.price.toFixed(8)} (dalam FVG ✅)
- Candle konfirmasi: ${smcSetup.candleOK ? "✅" : "❌"}
- Mode: ${smcSetup.smcMode}
- Reversal Score: ${smcSetup.revScore}/100 (Grade ${smcSetup.revGrade})
- Liquidity Sweep: ${smcSetup.sweep}
- Break of Structure: ${smcSetup.bos}
- Sinyal reversal: ${smcSetup.revReasons || "tidak ada"}

KONTEKS MARKET:
- F&G: ${extData?.fearGreed?.value || "N/A"}(${extData?.fearGreed?.classification || "N/A"}) trend:${extData?.fearGreed?.trend || "N/A"}
- Funding: ${(p.fundingRate * 100).toFixed(4)}%${p.fundingRate < -0.0001 ? " ⚡negatif=bias LONG" : p.fundingRate > 0.0001 ? " ⚠️positif=bias SHORT" : ""}
- Volume: ${p.volumeRatio.toFixed(2)}x rata-rata
- RSI: ${p.rsi.toFixed(1)}
- BTC dom: ${extData?.cmcData?.btcDominance?.toFixed(1) || "N/A"}%
- PEPE 1h: ${extData?.geckoData?.change1h?.toFixed(2) || "N/A"}%
- PEPE 24h: ${extData?.geckoData?.change24h?.toFixed(2) || "N/A"}%

Evaluasi:
1. Apakah sentimen mendukung arah ${smcSetup.side}?
2. Ada risiko besar yang terlihat? (funding extreme, F&G extreme, dll)
3. Volume cukup untuk konfirmasi move?

APPROVE jika tidak ada red flag besar.
REJECT hanya jika ada risiko jelas yang membatalkan setup.

JSON only:
{"approve":true|false,"confidence":0-100,"reason":"<max 20 kata>","risk":"LOW|MEDIUM|HIGH"}`;

  const bodyStr = JSON.stringify({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 120,
    messages:   [{ role: "user", content: prompt }],
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.anthropic.com",
        path:     "/v1/messages",
        method:   "POST",
        agent:    HTTPS_AGENT,
        headers:  {
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
      }, (res) => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("Claude SMC timeout")); });
      req.write(bodyStr);
      req.end();
    });

    if (!result?.content?.[0]?.text) return { approve: false, confidence: 0, reason: "Respons kosong" };
    const text      = result.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approve: false, confidence: 0, reason: "Parse error" };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approve:    parsed.approve === true,
      confidence: parseInt(parsed.confidence) || 0,
      reason:     parsed.reason || "-",
      risk:       parsed.risk   || "MEDIUM",
    };
  } catch (err) {
    log("WARN", `Claude SMC filter error: ${err.message} — approve by default`);
    return { approve: true, confidence: 60, reason: "Claude timeout — approve by default", risk: "MEDIUM" };
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
      log("INFO", `Dashboard masih aktif di http://localhost:${CONFIG.DASHBOARD_PORT} — buka untuk lihat hasil`);
      log("INFO", `Reset simulasi: klik tombol "↺ Reset Simulasi" di dashboard`);
      broadcastSSE({ type: "hardstop", totalPnL: stats.totalPnL, lossPercent: lossPercent.toFixed(2) });
      if (state.activePosition) {
        log("ERROR", "Menutup posisi aktif karena hard stop...");
        await closePosition("HARD_STOP", state.lastPrice || 0);
      }
      state.running = false;
      // TIDAK process.exit — biarkan dashboard tetap hidup untuk review
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
  state.lastKlines      = klines; // simpan untuk chart dashboard

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

  // ── Periodic Claude market analysis (bukan untuk entry) ─────
  // Update card "Analisis Claude AI Terakhir" setiap 1 menit
  // Independen dari SMC entry logic
  if (state.tickCount % 6 === 0) {
    // Fetch external data kalau belum update
    const extData = await fetchAllExternalData();

    // Hitung funding signal
    const fundingSignal = fundingRate < -0.0001
      ? "NEGATIVE_FUNDING_LONG_SIGNAL"
      : fundingRate > 0.0001
      ? "POSITIVE_FUNDING_SHORT_SIGNAL"
      : "NEUTRAL";

    // Kirim ke Claude untuk analisis market saja (bukan entry decision)
    try {
      const marketAnalysis = await analyzeWithClaude({
        price,
        bid:           ticker.bidPrice,
        ask:           ticker.askPrice,
        volume24h:     ticker.volume24h,
        change24h:     ticker.change24h,
        rsi:           indicators.rsi,
        ema9:          indicators.ema9,
        ema21:         indicators.ema21,
        volumeRatio:   indicators.volumeRatio,
        orderBook,
        fundingRate,
        fundingSignal,
        fearGreed:     extData.fearGreed,
        geckoData:     extData.geckoData,
        cmcData:       extData.cmcData,
        mtf:           null,
        consensus:     "MIXED",
        squeeze:       squeezeData,
        bb:            bbData,
        vwap,
        vwapPct,
        volProf,
        candlePatterns,
        winRate:       stats.winRate7d || 0,
        streak:        stats.currentStreak || 0,
        totalPnL:      stats.totalPnL || 0,
        activePosition: pos ? {
          side:       pos.side,
          entryPrice: pos.entryPrice,
          leverage:   pos.leverage,
          liqPrice:   pos.liqPrice,
          pnlPct:     pos.side === "LONG"
            ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
            : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage,
          unrealPnL:  0,
        } : null,
      });

      if (marketAnalysis) {
        state.lastAnalysis = marketAnalysis;
        log("AI",
          `Market analysis: ${marketAnalysis.action} | ` +
          `Conf:${marketAnalysis.confidence}% | ` +
          `${marketAnalysis.sentiment} | ` +
          `${marketAnalysis.reasoning}`
        );
        // Broadcast ke dashboard untuk update card AI
        broadcastSSE({
          type:     "analysis_update",
          analysis: marketAnalysis,
          price,
          rsi:         indicators.rsi,
          ema9:        indicators.ema9,
          ema21:       indicators.ema21,
          fundingRate,
          fearGreed:   extData.fearGreed,
          bb:          bbData,
          squeeze:     squeezeData,
          vwap,
          vwapPct,
          candlePatterns,
          externalData: extData,
        });
      }
    } catch (err) {
      log("WARN", `Periodic Claude analysis gagal: ${err.message}`);
    }
  }

  // ── 3. Tampilkan status di log ────────────────────────────
  if (state.tickCount % 3 === 0) { // setiap 30 detik
    log("INFO", `Harga: ${C.bold}${price.toFixed(8)}${C.reset} USDT | RSI: ${indicators.rsi.toFixed(1)} | EMA9: ${indicators.ema9.toFixed(8)} | EMA21: ${indicators.ema21.toFixed(8)}`);
    const _fg = externalDataCache?.fearGreed;
    log("INFO", `Funding: ${(fundingRate * 100).toFixed(4)}% | F&G: ${_fg ? _fg.value + " (" + _fg.classification + ")" : "N/A"} | Vol: ${indicators.volumeRatio.toFixed(2)}x`);
    if (!pos) {
      const emaTrend   = indicators.ema9 > indicators.ema21 ? `${C.green}EMA BULLISH${C.reset}` : `${C.red}EMA BEARISH${C.reset}`;
      const rsiState   = indicators.rsi > 70 ? `${C.red}OB${C.reset}` : indicators.rsi < 30 ? `${C.green}OS${C.reset}` : "NETRAL";
      const volState   = indicators.volumeRatio < 0.1 ? `${C.red}SANGAT RENDAH${C.reset}` : indicators.volumeRatio > 0.3 ? `${C.green}OK${C.reset}` : "RENDAH";
      const sqState    = squeezeData.squeeze ? `${C.yellow}SQUEEZE${C.reset}` : "normal";
      log("INFO", `Entry kondisi: ${emaTrend} | RSI ${rsiState} | Vol ${volState} | BB ${sqState} | Consensus: ${consensus}`);
    }
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

    // FIX #4: Minimum hold time — hindari keluar karena spread
    // Jangan close posisi dalam 30 detik pertama (kecuali force close)
    const holdMs    = pos.openTime ? Date.now() - new Date(pos.openTime).getTime() : 99999;
    const minHoldMs = 30 * 1000; // 30 detik minimum hold

    if (holdMs < minHoldMs) {
      const sisaSec = Math.ceil((minHoldMs - holdMs) / 1000);
      if (state.tickCount % 3 === 0) {
        log("INFO",
          `⏳ Minimum hold time — tunggu ${sisaSec} detik lagi (cegah exit karena spread)`
        );
      }
      // Tetap cek force close (MAX_LOSS) tapi skip TP/SL normal
      if (pnlPct < -CONFIG.MAX_LOSS_PCT) {
        log("TRADE", `Force close dalam hold time — rugi > ${CONFIG.MAX_LOSS_PCT}%`);
        await closePosition("FORCE_CLOSE_MAX_LOSS", price);
        return;
      }
      // Skip semua SL/TP lainnya selama minimum hold time
    } else {

    // ── FITUR #1: AUTO BREAKEVEN ───────────────────────────────
    // Geser SL ke entry + buffer fee saat profit raw ≥ 0.4%
    // Fee PEPE = 0.12% × 2 = 0.24% round trip + buffer 0.1%
    const BREAKEVEN_TRIGGER_PCT = 0.4;  // % profit (raw, belum × leverage)
    const BREAKEVEN_BUFFER_PCT  = 0.15; // buffer di atas entry untuk nutup fee

    if (!pos.breakevenSet) {
      const rawProfitPct = pos.side === "LONG"
        ? (price - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - price) / pos.entryPrice * 100;

      if (rawProfitPct >= BREAKEVEN_TRIGGER_PCT) {
        const newSL = pos.side === "LONG"
          ? pos.entryPrice * (1 + BREAKEVEN_BUFFER_PCT / 100)
          : pos.entryPrice * (1 - BREAKEVEN_BUFFER_PCT / 100);

        // Hanya geser SL kalau lebih baik dari SL sekarang
        const slImproved = pos.side === "LONG"
          ? newSL > pos.stopLoss
          : newSL < pos.stopLoss;

        if (slImproved) {
          pos.stopLoss    = newSL;
          pos.breakevenSet = true;
          log("TRADE",
            `🔒 BREAKEVEN SET! SL digeser ke entry+buffer: ` +
            `${newSL.toFixed(8)} (profit raw ${rawProfitPct.toFixed(3)}%)`
          );
          broadcastSSE({
            type:    "breakeven",
            message: `Breakeven aktif — SL = ${newSL.toFixed(8)}`,
            sl:      newSL,
            entry:   pos.entryPrice,
          });
          saveState();
        }
      }
    }

    // ── FITUR #4: LOCK PROFIT — Anti Profit Balik Jadi Loss ───
    // Level lock: tiap profit naik X%, SL digeser untuk kunci Y% profit
    const LOCK_LEVELS = [
      { triggerRaw: 1.0, lockRaw: 0.3 },  // profit ≥1% → kunci 0.3%
      { triggerRaw: 1.5, lockRaw: 0.6 },  // profit ≥1.5% → kunci 0.6%
      { triggerRaw: 2.0, lockRaw: 1.0 },  // profit ≥2% → kunci 1%
      { triggerRaw: 3.0, lockRaw: 1.8 },  // profit ≥3% → kunci 1.8%
    ];

    const rawProfitLock = pos.side === "LONG"
      ? (price - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - price) / pos.entryPrice * 100;

    for (let i = LOCK_LEVELS.length - 1; i >= 0; i--) {
      const level = LOCK_LEVELS[i];
      if (rawProfitLock >= level.triggerRaw) {
        // Hitung SL yang mengunci profit lock%
        const lockedSL = pos.side === "LONG"
          ? pos.entryPrice * (1 + level.lockRaw / 100)
          : pos.entryPrice * (1 - level.lockRaw / 100);

        // Hanya update SL kalau lebih baik dari SL sekarang
        const improved = pos.side === "LONG"
          ? lockedSL > pos.stopLoss
          : lockedSL < pos.stopLoss;

        if (improved) {
          const prevSL      = pos.stopLoss;
          pos.stopLoss      = lockedSL;
          pos.lockLevel     = i; // simpan level yang aktif
          log("TRADE",
            `🔐 LOCK PROFIT Level ${i+1}: ` +
            `SL ${prevSL.toFixed(8)} → ${lockedSL.toFixed(8)} ` +
            `(kunci ${level.lockRaw}% profit, trigger ${level.triggerRaw}%)`
          );
          broadcastSSE({
            type:      "lock_profit",
            level:     i + 1,
            lockPct:   level.lockRaw,
            newSL:     lockedSL,
            profitRaw: rawProfitLock.toFixed(3),
          });
          saveState();
        }
        break; // Pakai level tertinggi yang applicable
      }
    }

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

    // ── FITUR #2: TRAILING TP DINAMIS ───────────────────────
    // TP tidak lagi fixed, ikut naik/turun saat harga berlanjut
    if (!pos.trailingTP) pos.trailingTP = pos.takeProfit;
    if (!pos.tpTrailPct) pos.tpTrailPct = CONFIG.TAKE_PROFIT_PCT * 0.5; // 50% dari TP awal

    if (pos.side === "LONG") {
      // Update trailing TP ke atas saat harga naik melewati TP lama
      if (price > pos.trailingTP) {
        const newTP = price * (1 + pos.tpTrailPct / 100 / pos.leverage);
        // Jangan update kalau perbedaannya kecil (< 0.05% dari harga)
        if (newTP - pos.trailingTP > price * 0.0005) {
          pos.trailingTP = newTP;
          log("TRADE",
            `📈 Trailing TP naik → ${pos.trailingTP.toFixed(8)} ` +
            `(harga ${price.toFixed(8)} melewati TP lama)`
          );
        }
      }
      // Close saat harga turun dari trailing TP
      // (harga sudah melewati TP lama dan sekarang turun)
      const tpTriggered = price >= pos.takeProfit  // TP awal tercapai
        && price <= pos.trailingTP * (1 - pos.tpTrailPct / 100 / pos.leverage / 2);
      if (tpTriggered || price >= pos.trailingTP) {
        log("TRADE", `${C.green}TAKE PROFIT (trailing TP=${pos.trailingTP.toFixed(8)})${C.reset}`);
        await closePosition("TAKE_PROFIT_TRAILING", price);
        return;
      }
    } else { // SHORT
      if (price < pos.trailingTP) {
        const newTP = price * (1 - pos.tpTrailPct / 100 / pos.leverage);
        if (pos.trailingTP - newTP > price * 0.0005) {
          pos.trailingTP = newTP;
          log("TRADE",
            `📉 Trailing TP turun → ${pos.trailingTP.toFixed(8)} ` +
            `(harga ${price.toFixed(8)} melewati TP lama)`
          );
        }
      }
      const tpTriggered = price <= pos.takeProfit
        && price >= pos.trailingTP * (1 + pos.tpTrailPct / 100 / pos.leverage / 2);
      if (tpTriggered || price <= pos.trailingTP) {
        log("TRADE", `${C.green}TAKE PROFIT (trailing TP=${pos.trailingTP.toFixed(8)})${C.reset}`);
        await closePosition("TAKE_PROFIT_TRAILING", price);
        return;
      }
    }

    // Stop Loss
    if ((pos.side === "LONG" && price <= pos.stopLoss) ||
        (pos.side === "SHORT" && price >= pos.stopLoss)) {
      log("TRADE", `${C.yellow}STOP LOSS tercapai!${C.reset}`);
      await closePosition("STOP_LOSS", price);
      // [4] Mulai post-SL cooldown
      smcState.lastSLTime      = Date.now();
      smcState.slCooldownCount = 0;
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

    // ── FITUR #3: EARLY EXIT — MOMENTUM LEMAH ────────────────
    // Aktif hanya kalau: sudah profit ≥ 1% raw DAN belum kena TP
    const MOMENTUM_EXIT_TRIGGER = 1.0; // % profit raw untuk aktifkan check
    const rawProfit = pos.side === "LONG"
      ? (price - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - price) / pos.entryPrice * 100;

    if (rawProfit >= MOMENTUM_EXIT_TRIGGER) {
      // Deteksi momentum melemah berdasarkan RSI + EMA
      let momentumWeak = false;
      const reasons = [];

      if (pos.side === "LONG") {
        // RSI mulai overbought (>72) = potensi reversal
        if (indicators.rsi > 72) {
          momentumWeak = true;
          reasons.push(`RSI OB ${indicators.rsi.toFixed(1)}`);
        }
        // EMA9 mulai turun di bawah EMA21 = trend lemah
        if (indicators.ema9 < indicators.ema21 * 0.9998) {
          momentumWeak = true;
          reasons.push("EMA9<EMA21 (trend melemah)");
        }
        // Volume turun drastis saat harga di atas TP awal = exhaustion
        if (price > pos.takeProfit && indicators.volumeRatio < 0.15) {
          momentumWeak = true;
          reasons.push(`Volume drop ${indicators.volumeRatio.toFixed(2)}x`);
        }
      } else { // SHORT
        if (indicators.rsi < 28) {
          momentumWeak = true;
          reasons.push(`RSI OS ${indicators.rsi.toFixed(1)}`);
        }
        if (indicators.ema9 > indicators.ema21 * 1.0002) {
          momentumWeak = true;
          reasons.push("EMA9>EMA21 (trend melemah)");
        }
        if (price < pos.takeProfit && indicators.volumeRatio < 0.15) {
          momentumWeak = true;
          reasons.push(`Volume drop ${indicators.volumeRatio.toFixed(2)}x`);
        }
      }

      if (momentumWeak) {
        // Butuh minimal 2 konfirmasi sebelum early exit
        pos.momentumWeakCount = (pos.momentumWeakCount || 0) + 1;

        if (pos.momentumWeakCount >= 2) {
          log("TRADE",
            `⚡ EARLY EXIT — Momentum melemah [${reasons.join(", ")}] ` +
            `| Profit ${rawProfit.toFixed(3)}% raw | Amankan sekarang`
          );
          await closePosition("EARLY_EXIT_WEAK_MOMENTUM", price);
          return;
        } else {
          log("INFO",
            `⚠ Momentum mulai lemah (${pos.momentumWeakCount}/2) [${reasons.join(", ")}] ` +
            `— konfirmasi 1 tick lagi`
          );
        }
      } else {
        // Reset counter kalau momentum kembali kuat
        pos.momentumWeakCount = 0;
      }
    }
    } // end else dari minimum hold time check

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

  // ── Kalkulasi prediksi profit (lokal, setiap tick) ───────
  const prediction = calcProfitPrediction(
    indicators, squeezeData, bbData, vwap, vwapPct,
    candlePatterns, consensus, fundingRate,
    externalDataCache?.fearGreed, pos
  );

  // ═══════════════════════════════════════════════════════════
  // SMC ANALYSIS + CLAUDE FILTER
  // ═══════════════════════════════════════════════════════════

  if (!pos) {

    // ── A. Update HTF Trend setiap 1 menit ─────────────────
    if (Date.now() - smcState.htfLastUpdate > 60000 || !smcState.htfTrend) {
      smcState.htfTrend      = await getHTFTrend();
      smcState.htfLastUpdate = Date.now();
    }
    const htf = smcState.htfTrend;

    // ── B. Session filter ───────────────────────────────────
    const session = isActiveSession();

    // ── C. ATR filter ───────────────────────────────────────
    const atr    = calcATR(klines, 14);
    const atrPct = price > 0 ? atr / price * 100 : 0;

    // Log status SMC setiap 30 detik
    if (state.tickCount % 3 === 0) {
      log("INFO",
        `SMC: HTF=${htf?.trend || "N/A"}(${htf?.strength || "?"}) | ` +
        `Session=${session.session}(${session.wibHour}:xx WIB) | ` +
        `ATR=${atrPct.toFixed(3)}% | ` +
        `Aktif=${session.active ? "✅" : "❌"}`
      );
    }

    // Skip entry kalau di luar session aktif
    if (!session.active) {
      // Tetap jalankan SMC detection untuk dashboard
      // tapi tandai sebagai no-entry zone

      let klines5mAsia = klines;
      try { klines5mAsia = await getKlines("5m", 100); } catch (_) {}

      const nonZeroAsia = klines5mAsia.slice(-20).map(k => k.volume).filter(v => v > 0);
      const avgVolAsia  = nonZeroAsia.length > 0
        ? nonZeroAsia.reduce((a, b) => a + b, 0) / nonZeroAsia.length : 1;

      const swingsAsia   = detectSwings(klines5mAsia);
      const inducmtAsia  = detectInducement(swingsAsia, htf?.trend || "BULLISH");
      const liqGrabAsia  = detectLiquidityGrab(klines5mAsia, swingsAsia, htf?.trend || "BULLISH");
      const chochAsia    = detectCHoCH(klines5mAsia, swingsAsia, htf?.trend || "BULLISH", avgVolAsia);
      const fvgDataAsia  = detectFVG(klines5mAsia, htf?.trend || "BULLISH");
      const inFVGAsia    = isPriceInFVG(price, fvgDataAsia, htf?.trend || "BULLISH");
      const candleOKAsia = confirmEntryCandle(klines5mAsia, htf?.trend || "BULLISH");
      const sdZoneAsia   = detectSDZoneTouch(klines5mAsia, swingsAsia, htf?.trend || "BULLISH");
      const sweepAsia    = detectLiquiditySweep(klines5mAsia, swingsAsia, htf?.trend || "BULLISH");
      const bosAsia      = detectBreakOfStructure(klines5mAsia, swingsAsia, htf?.trend || "BULLISH");
      const revScoreAsia = calculateReversalScore({
        sweep: sweepAsia, bos: bosAsia,
        rsi: indicators.rsi, bbData,
        price, volumeRatio: indicators.volumeRatio,
        candlePatterns, htfStrength: htf?.strength,
      });

      broadcastSSE({
        type: "tick", price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
        volume24h: ticker?.volume24h, change24h: ticker?.change24h,
        isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
        latestCandle: klines[klines.length - 1], prediction,
        smcData: {
          htfTrend:      htf?.trend,
          htfStrength:   htf?.strength,
          tradeSide:     htf?.trend || "NEUTRAL",
          session:       session.session,
          atrPct:        parseFloat(atrPct.toFixed(3)),
          active:        false,  // tandai no-entry
          noEntryReason: `Session ${session.session} — entry hanya London/NY`,
          inducement:    inducmtAsia,
          liquidityGrab: liqGrabAsia,
          choch:         chochAsia,
          fvgData:       fvgDataAsia,
          inFVG:         inFVGAsia,
          candleOK:      candleOKAsia,
          sdZone:        sdZoneAsia,
          sweep:         sweepAsia,
          bos:           bosAsia,
          revScore:      revScoreAsia,
          smcReady:      false,
        },
      });
      return;
    }

    // Skip entry kalau ATR terlalu rendah (market flat)
    if (atrPct < 0.03) {
      if (state.tickCount % 6 === 0) {
        log("INFO", `ATR terlalu rendah (${atrPct.toFixed(3)}%) — market flat, skip`);
      }
      broadcastSSE({
        type: "tick", price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
        isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
        latestCandle: klines[klines.length - 1], prediction,
        smcData: { atrPct: parseFloat(atrPct.toFixed(3)), flat: true, session: session.session, htfTrend: htf?.trend },
      });
      return;
    }

    // Skip kalau baru entry (cooldown 3 menit)
    if (Date.now() - smcState.lastEntryTime < smcState.minEntryGap) {
      const sisaSec = Math.ceil((smcState.minEntryGap - (Date.now() - smcState.lastEntryTime)) / 1000);
      if (state.tickCount % 3 === 0) {
        log("INFO", `Cooldown entry — tunggu ${sisaSec} detik lagi`);
      }
      broadcastSSE({
        type: "tick", price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
        isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
        latestCandle: klines[klines.length - 1], prediction,
        smcData: { session: session.session, htfTrend: htf?.trend, cooldown: sisaSec },
      });
      return;
    }

    // Skip kalau HTF netral
    if (!htf || htf.trend === "NEUTRAL") {
      if (state.tickCount % 6 === 0) log("INFO", "HTF NEUTRAL — tidak ada trade");
      broadcastSSE({
        type: "tick", price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
        isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
        latestCandle: klines[klines.length - 1], prediction,
        smcData: { htfTrend: "NEUTRAL", session: session.session, atrPct: parseFloat(atrPct.toFixed(3)) },
      });
      return;
    }
    const tradeSide = htf.trend; // "BULLISH" atau "BEARISH"

    // ── D. Ambil klines 5m untuk SMC ───────────────────────
    let klines5m = klines; // fallback ke 1m
    try { klines5m = await getKlines("5m", 100); } catch (_) {}

    const nonZeroVols5m = klines5m.slice(-20).map(k => k.volume).filter(v => v > 0);
    const avgVol5m = nonZeroVols5m.length > 0
      ? nonZeroVols5m.reduce((a, b) => a + b, 0) / nonZeroVols5m.length
      : 1;

    // ── E. Deteksi semua komponen SMC ──────────────────────
    const swings   = detectSwings(klines5m);
    const inducmt  = detectInducement(swings, tradeSide);
    const liqGrab  = detectLiquidityGrab(klines5m, swings, tradeSide);
    const choch    = detectCHoCH(klines5m, swings, tradeSide, avgVol5m);
    const fvgData  = detectFVG(klines5m, tradeSide);
    const inFVG    = isPriceInFVG(price, fvgData, tradeSide);
    const candleOK = confirmEntryCandle(klines5m, tradeSide);

    // ── E2. S/D Zone Touch + Reversal Detection ────────────
    const sdZone  = detectSDZoneTouch(klines5m, swings, tradeSide);
    const sweep   = detectLiquiditySweep(klines5m, swings, tradeSide);
    const bos     = detectBreakOfStructure(klines5m, swings, tradeSide);
    const revScore = calculateReversalScore({
      sweep,
      bos,
      rsi:           indicators.rsi,
      bbData,
      price,
      volumeRatio:   indicators.volumeRatio,
      candlePatterns,
      htfStrength:   htf?.strength,
    });

    // Log checklist SMC + reversal score setiap tick
    const checks = [
      choch.detected                        ? "✅CHoCH"  : "❌CHoCH",
      inFVG.inFVG                           ? "✅FVG"    : "❌FVG",
      sdZone.detected && sdZone.strong      ? "✅SD🔥"   : sdZone.detected ? "⚠️SD"   : "❌SD",
      inducmt.valid                         ? "✅Ind"    : "❌Ind",
      liqGrab.detected                      ? "✅Liq"    : "❌Liq",
      candleOK.confirmed                    ? "✅Candle" : "❌Candle",
      sweep.detected                        ? "✅Sweep"  : "❌Sweep",
      bos.detected                          ? "✅BOS"    : "❌BOS",
    ].join(" ");
    log("INFO", `[${tradeSide}] ${checks} | ATR:${atrPct.toFixed(3)}% | RevScore:${revScore.score}(${revScore.grade})`);

    // ── [4] Post-SL cooldown — tunggu N candle setelah stop loss ──
    if (smcState.lastSLTime > 0) {
      smcState.slCooldownCount++;
      if (smcState.slCooldownCount < CONFIG.SL_COOLDOWN_CANDLES) {
        const remaining = CONFIG.SL_COOLDOWN_CANDLES - smcState.slCooldownCount;
        if (state.tickCount % 3 === 0) log("INFO", `Post-SL cooldown — tunggu ${remaining} candle lagi`);
        return;
      } else {
        // Cooldown selesai
        smcState.lastSLTime      = 0;
        smcState.slCooldownCount = 0;
      }
    }

    // ── [2] Volatility filter — skip saat ATR terlalu rendah ──────
    const volFilter = checkVolatilityFilter(klines5m);
    if (!volFilter.pass) {
      if (state.tickCount % 6 === 0) {
        log("INFO", `Volatility filter FAIL — ATR ratio ${volFilter.ratio}x < ${CONFIG.ATR_MIN_MULTIPLIER}x (market compression, skip)`);
      }
      return;
    }

    // ── F. Cek apakah kondisi cukup untuk entry ────────────
    // Mode D (Utama) — CHoCH + FVG + S/D Zone strong retest → langsung entry, no Claude
    const sdReady        = choch.detected && inFVG.inFVG && sdZone.detected && sdZone.strong;
    // Mode A — SMC Lengkap: semua 5 kondisi
    const smcFull        = inducmt.valid && liqGrab.detected && choch.detected && inFVG.inFVG && candleOK.confirmed;
    // Mode B — Reversal Grade A/B
    const revReady       = revScore.callAI && (sweep.detected || bos.detected) && (liqGrab.detected || choch.detected);
    // Mode C — BOS Direct: BOS saja cukup
    const bosDirectEntry = bos.detected;
    const smcReady       = sdReady || smcFull || revReady || bosDirectEntry;

    // ── [3] Entry delay — pending signal & candle confirmation ────
    if (smcReady) {
      const pendingSide = smcState.pendingSignal?.side;
      if (!smcState.pendingSignal || pendingSide !== tradeSide) {
        // Sinyal baru — mulai hitungan candle, belum masuk
        smcState.pendingSignal      = { side: tradeSide, detectedAt: Date.now() };
        smcState.pendingCandleCount = 1;
        log("INFO", `⏳ Sinyal ${tradeSide} terdeteksi — tunggu ${CONFIG.ENTRY_CONFIRM_CANDLES} candle konfirmasi (1/${CONFIG.ENTRY_CONFIRM_CANDLES})`);
        return;
      } else {
        smcState.pendingCandleCount++;
        if (smcState.pendingCandleCount < CONFIG.ENTRY_CONFIRM_CANDLES) {
          log("INFO", `⏳ Konfirmasi candle ${smcState.pendingCandleCount}/${CONFIG.ENTRY_CONFIRM_CANDLES} — tunggu...`);
          return;
        }
        // Candle cukup — reset pending dan lanjut ke cek konfirmasi
        smcState.pendingSignal      = null;
        smcState.pendingCandleCount = 0;
      }
    } else {
      // Sinyal hilang — reset pending
      smcState.pendingSignal      = null;
      smcState.pendingCandleCount = 0;
    }

    // ── [2b] Reversal confirmation filter ─────────────────────────
    if (smcReady) {
      const revConfirm = checkReversalConfirmation(tradeSide, klines5m, indicators, swings);
      if (!revConfirm.pass) {
        log("INFO",
          `Reversal confirmation FAIL (${revConfirm.score}/${revConfirm.maxScore}) ` +
          `[${revConfirm.reasons.join(", ") || "tidak ada sinyal"}] — skip entry`
        );
        return;
      }
      log("INFO", `Reversal confirmation OK (${revConfirm.score}/${revConfirm.maxScore}): ${revConfirm.reasons.join(", ")}`);
    }

    // Bangun smcData untuk broadcast (dipakai di kedua cabang)
    const smcData = {
      htfTrend:      htf?.trend,
      htfStrength:   htf?.strength,
      tradeSide,
      session:       session.session,
      atrPct:        parseFloat(atrPct.toFixed(3)),
      inducement:    inducmt,
      liquidityGrab: liqGrab,
      choch,
      fvgData,
      inFVG,
      candleOK,
      sdZone,
      sweep,
      bos,
      revScore,
      sdReady,
      smcFull,
      smcReady,
      bosDirectEntry,
    };
    
    // Debug: log smcData yang dikirim
    if (state.tickCount % 6 === 0) {
      log("DEBUG", `Broadcasting smcData: htfTrend=${smcData.htfTrend}, session=${smcData.session}, atrPct=${smcData.atrPct}, smcReady=${smcData.smcReady}`);
    }

    if (smcReady) {
      const modeLabel = sdReady
        ? `SD ZONE (${sdZone.zoneType}) CHoCH+FVG`
        : smcFull
          ? "FULL SMC"
          : (bosDirectEntry && !revReady)
            ? `BOS DIRECT (${bos.type || "BOS"})`
            : `REVERSAL Grade-${revScore.grade} (${revScore.score}/100)`;

      // ── G. Hitung SL/TP ─────────────────────────────────
      // Mode D (sdReady): SL tepat di bawah/atas S/D zone
      // Mode lain: SL dari swing level
      let slPrice, slPct, tpPct, orderQty, leverage;

      // [1] ATR-based SL/TP — primary method
      const atrStops = calcATRStops(tradeSide === "BULLISH" ? "LONG" : "SHORT", price, atr);

      if (sdReady) {
        // SD Zone: SL di luar zone tapi minimal ATR-based SL
        const zoneSL = tradeSide === "BULLISH"
          ? sdZone.zone * (1 - 0.0015)
          : sdZone.zone * (1 + 0.0015);
        // Ambil yang lebih jauh (lebih konservatif) antara zone SL dan ATR SL
        slPrice = tradeSide === "BULLISH"
          ? Math.min(zoneSL, atrStops.stopLoss)
          : Math.max(zoneSL, atrStops.stopLoss);
        slPct = Math.max(0.2, Math.abs((price - slPrice) / price * 100));
        tpPct = slPct * (CONFIG.ATR_TP_MULTIPLIER / CONFIG.ATR_SL_MULTIPLIER); // jaga RR ratio
        const sized = calcOrderSizeByRisk(price, slPct);
        orderQty = sized.qty;
        leverage = sized.leverage;
      } else {
        // ATR-based SL/TP dengan batas dari swing level
        const swingLevel = tradeSide === "BULLISH"
          ? (swings.lastLow?.price  || price * 0.99)
          : (swings.lastHigh?.price || price * 1.01);
        const swingSLPct = Math.abs((price - swingLevel) / price * 100);
        // Pilih yang lebih besar antara ATR SL dan swing SL (lebih aman dari noise)
        slPct    = Math.max(atrStops.slPct, swingSLPct, 0.3);
        slPct    = Math.min(slPct, 2.5); // cap maksimal
        slPrice  = tradeSide === "BULLISH" ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
        tpPct    = slPct * (CONFIG.ATR_TP_MULTIPLIER / CONFIG.ATR_SL_MULTIPLIER);
        orderQty = null;
        leverage = Math.min(Math.max(Math.round(1 / slPct * 8), CONFIG.DEFAULT_LEVERAGE), CONFIG.MAX_LEVERAGE);
      }

      // FIX #3: Validasi minimum SL sebelum entry — wajib cover spread + fee PEPE
      const MIN_SL_PCT = CONFIG.MIN_SL_PCT || 0.5;
      const MAX_SL_PCT = CONFIG.MAX_SL_PCT || 3.5;
      if (slPct < MIN_SL_PCT) {
        log("WARN",
          `SL ${slPct.toFixed(3)}% terlalu kecil (minimum ${MIN_SL_PCT}%) — akan langsung KENA SPREAD/fee! Skip.`
        );
        return; // skip entry
      }
      if (slPct > MAX_SL_PCT) {
        log("WARN",
          `SL ${slPct.toFixed(3)}% terlalu besar (maksimum ${MAX_SL_PCT}%) — risiko terlalu tinggi. Skip.`
        );
        return; // skip entry
      }

      const fvg = tradeSide === "BULLISH" ? fvgData.lastBullFVG : fvgData.lastBearFVG;
      const smcSetup = {
        side:         tradeSide,
        htfTrend:     htf.trend,
        htfStrength:  htf.strength,
        session:      session.session,
        atrPct:       atrPct.toFixed(3),
        inducement:   inducmt,
        grabPrice:    liqGrab.grabPrice,
        chochLevel:   choch.breakLevel,
        fvgLower:     fvg?.lower,
        fvgUpper:     fvg?.upper,
        candleOK:     candleOK.confirmed,
        sdZone:       sdZone.detected ? `${sdZone.zoneType} zone=${sdZone.zone?.toFixed(8)} wick=${sdZone.wickRatio}` : "tidak terdeteksi",
        sweep:        sweep.detected ? `wick=${sweep.wickSize} strong=${sweep.strong}` : "tidak terdeteksi",
        bos:          bos.detected   ? `${bos.type} break=${bos.breakAmount}% momentum=${bos.momentum}` : "tidak terdeteksi",
        revScore:     revScore.score,
        revGrade:     revScore.grade,
        revReasons:   revScore.reasons.join(", "),
        smcMode:      sdReady ? "SD_ZONE" : smcFull ? "FULL_SMC" : (bosDirectEntry && !revReady) ? "BOS_DIRECT" : "REVERSAL_ONLY",
      };

      // ── H. Tentukan claudeFilter berdasarkan mode ───────
      let claudeFilter;
      if (sdReady) {
        // Mode D: CHoCH + FVG + SD Zone strong → langsung masuk, no Claude
        claudeFilter = {
          approve:    true,
          confidence: 80,
          reason:     `CHoCH+FVG+${sdZone.zoneType}(wick=${sdZone.wickRatio}) — SD Zone direct entry`,
          risk:       "LOW",
          direct:     true,
        };
        log("TRADE",
          `🎯 SD ZONE ENTRY [${tradeSide}] ${sdZone.zoneType} zone=${sdZone.zone?.toFixed(8)} | ` +
          `CHoCH✅ FVG✅ wick=${sdZone.wickRatio} | ` +
          `SL:${slPct.toFixed(3)}% TP:${tpPct.toFixed(3)}% Lev:${leverage}x | ` +
          `modal=${CONFIG.POSITION_SIZE_USDT}USDT → max loss=${CONFIG.POSITION_SIZE_USDT}USDT`
        );
      } else if (bosDirectEntry && !smcFull) {
        // Mode C: BOS Direct
        const bosDesc = bos.type || "BOS";
        const extras  = [
          choch.detected   ? "CHoCH"   : null,
          liqGrab.detected ? "LiqGrab" : null,
          sweep.detected   ? "Sweep"   : null,
        ].filter(Boolean).join("+") || "confirmed";
        claudeFilter = {
          approve:    true,
          confidence: 75,
          reason:     `${bosDesc} ${extras} — BOS Direct Entry`,
          risk:       "MEDIUM",
          direct:     true,
        };
        log("TRADE",
          `⚡ BOS DIRECT [${tradeSide}] ${bosDesc} ${extras} | ` +
          `ATR:${atrPct.toFixed(3)}% HTF:${htf.trend} Session:${session.session} ` +
          `→ MASUK LANGSUNG tanpa Claude`
        );
      } else {
        // Mode A/B: SMC Lengkap atau Reversal — pakai Claude sebagai filter
        log("AI",
          `🎯 SETUP LENGKAP [${modeLabel}] [${tradeSide}] ` +
          `Session:${session.session} HTF:${htf.trend} ` +
          `→ Tanya Claude untuk konfirmasi...`
        );
        await fetchAllExternalData();
        claudeFilter = await analyzeWithClaudeSMC(smcSetup, {
          price, fundingRate,
          volumeRatio: indicators.volumeRatio,
          rsi:         indicators.rsi,
        });
        log("AI",
          `Claude filter: ${claudeFilter.approve ? "✅ APPROVE" : "❌ REJECT"} ` +
          `(conf:${claudeFilter.confidence}% risk:${claudeFilter.risk}) ` +
          `— ${claudeFilter.reason}`
        );
      }

      smcData.claudeFilter = claudeFilter;

      // SD Zone & BOS Direct: threshold 65 | SMC/Reversal: 70
      const confThreshold = (sdReady || (bosDirectEntry && !smcFull)) ? 65 : CONFIG.OPEN_CONFIDENCE;

      // ── I. Entry ────────────────────────────────────────
      if (claudeFilter.approve && claudeFilter.confidence >= confThreshold) {
        log("TRADE",
          `🚀 ENTRY ${tradeSide} [${modeLabel}] | ` +
          `SL:${slPct.toFixed(3)}% TP:${tpPct.toFixed(3)}% ` +
          `Lev:${leverage}x RR:1:2 | ` +
          `${claudeFilter.direct ? modeLabel : `Claude:${claudeFilter.confidence}%`} (${claudeFilter.risk})`
        );
        const opened = await openPosition(
          tradeSide === "BULLISH" ? "LONG" : "SHORT",
          leverage,
          price,
          orderQty
        );
        if (opened && state.activePosition) {
          // Override SL/TP dengan kalkulasi SMC
          state.activePosition.stopLoss = tradeSide === "BULLISH"
            ? slPrice
            : slPrice;
          state.activePosition.takeProfit = tradeSide === "BULLISH"
            ? price * (1 + tpPct / 100)
            : price * (1 - tpPct / 100);
          smcState.lastEntryTime = Date.now();
          log("TRADE",
            `SL: ${state.activePosition.stopLoss.toFixed(8)} | ` +
            `TP: ${state.activePosition.takeProfit.toFixed(8)}`
          );
        }
      } else {
        log("AI",
          `Claude REJECT — ${claudeFilter.reason} ` +
          `(conf:${claudeFilter.confidence}%) — tunggu setup berikutnya`
        );
      }

      broadcastSSE({
        type: "analysis",
        price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        analysis: {
          action:          claudeFilter.approve && claudeFilter.confidence >= CONFIG.OPEN_CONFIDENCE
            ? (tradeSide === "BULLISH" ? "LONG" : "SHORT") : "HOLD",
          confidence:      claudeFilter.confidence,
          sentiment:       tradeSide,
          leverage:        CONFIG.DEFAULT_LEVERAGE,
          stop_loss_pct:   slPct,
          take_profit_pct: tpPct,
          reasoning:       claudeFilter.direct
            ? `BOS Direct Entry: ${claudeFilter.reason}`
            : `SMC+Claude: ${claudeFilter.approve ? "✅" : "❌"} — ${claudeFilter.reason}`,
        },
        position:    state.activePosition,
        bb:          bbData,
        squeeze:     squeezeData,
        vwap,
        vwapPct,
        candlePatterns,
        externalData: externalDataCache,
        latestCandle: klines[klines.length - 1],
        prediction,
        smcData,
      });

    } else {
      // SMC belum lengkap — broadcast tick biasa dengan data SMC
      broadcastSSE({
        type: "tick", price,
        rsi: indicators.rsi, ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
        volume24h: ticker?.volume24h, change24h: ticker?.change24h,
        isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
        latestCandle: klines[klines.length - 1],
        prediction, smcData,
      });
    }

  } else {
    // Ada posisi aktif — broadcast tick saja (SL/TP dihandle risk management di atas)
    // Sampaikan juga smcData agar dashboard dapat menampilkan analisis SMC
    broadcastSSE({
      type: "tick", price,
      rsi: indicators.rsi, ema9: indicators.ema9, ema21: indicators.ema21,
      fundingRate, fearGreed: externalDataCache?.fearGreed,
      position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
      isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
      latestCandle: klines[klines.length - 1],
      prediction,
      smcData,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// PREDIKSI PROFIT
// ─────────────────────────────────────────────────────────────

/**
 * Prediksi probabilitas dan estimasi profit trade berikutnya
 * berdasarkan kondisi teknikal saat ini + histori trade.
 * Tidak menggunakan Claude API — murni kalkulasi lokal.
 */
function calcProfitPrediction(indicators, squeezeData, bbData, vwap, vwapPct,
                               candlePatterns, consensus, fundingRate, fearGreed,
                               pos) {
  let bullScore  = 0;  // skor bullish 0-100
  let bearScore  = 0;  // skor bearish 0-100
  let confidence = 0;  // keyakinan prediksi 0-100
  const signals  = []; // alasan singkat

  const rsi = indicators.rsi;
  const ema9 = indicators.ema9, ema21 = indicators.ema21;
  const volRatio = indicators.volumeRatio;

  // ── RSI ─────────────────────────────────────────────────────
  if (rsi < 25)       { bullScore += 25; signals.push("RSI oversold ekstrem"); }
  else if (rsi < 35)  { bullScore += 15; signals.push("RSI oversold"); }
  else if (rsi < 45)  { bullScore += 5;  signals.push("RSI lemah"); }
  else if (rsi > 75)  { bearScore += 25; signals.push("RSI overbought ekstrem"); }
  else if (rsi > 65)  { bearScore += 15; signals.push("RSI overbought"); }
  else if (rsi > 55)  { bearScore += 5;  signals.push("RSI tinggi"); }
  else                { confidence -= 5; } // zona netral

  // ── EMA Trend ───────────────────────────────────────────────
  const emaDiff = (ema9 - ema21) / ema21 * 100;
  if      (emaDiff >  0.05) { bullScore += 20; signals.push(`EMA9>EMA21 +${emaDiff.toFixed(3)}%`); }
  else if (emaDiff >  0.01) { bullScore += 10; signals.push("EMA golden cross lemah"); }
  else if (emaDiff < -0.05) { bearScore += 20; signals.push(`EMA9<EMA21 ${emaDiff.toFixed(3)}%`); }
  else if (emaDiff < -0.01) { bearScore += 10; signals.push("EMA death cross lemah"); }

  // ── Volume ──────────────────────────────────────────────────
  if      (volRatio > 2.0)  { confidence += 20; signals.push(`Volume spike ${volRatio.toFixed(1)}x`); }
  else if (volRatio > 1.0)  { confidence += 10; signals.push(`Volume tinggi ${volRatio.toFixed(1)}x`); }
  else if (volRatio > 0.3)  { confidence += 5;  }
  else if (volRatio < 0.1)  { confidence -= 15; signals.push("Volume sangat rendah"); }

  // ── BB Position ─────────────────────────────────────────────
  if (bbData) {
    if      (bbData.pctB < 0.1)  { bullScore += 15; signals.push("Harga di bawah BB lower"); }
    else if (bbData.pctB < 0.2)  { bullScore += 8;  }
    else if (bbData.pctB > 0.9)  { bearScore += 15; signals.push("Harga di atas BB upper"); }
    else if (bbData.pctB > 0.8)  { bearScore += 8;  }
  }
  if (squeezeData?.squeeze)      { confidence -= 10; signals.push("BB squeeze (breakout menunggu)"); }

  // ── VWAP ────────────────────────────────────────────────────
  if      (vwapPct >  0.3) { bullScore += 8;  signals.push(`Harga +${vwapPct.toFixed(2)}% di atas VWAP`); }
  else if (vwapPct < -0.3) { bearScore += 8;  signals.push(`Harga ${vwapPct.toFixed(2)}% di bawah VWAP`); }

  // ── Candle Pattern ──────────────────────────────────────────
  const bullPat = candlePatterns?.bullishPatterns?.length || 0;
  const bearPat = candlePatterns?.bearishPatterns?.length || 0;
  if (bullPat > 0) { bullScore += bullPat * 8; signals.push(`Candle bullish: ${candlePatterns.bullishPatterns.join(",")}`); }
  if (bearPat > 0) { bearScore += bearPat * 8; signals.push(`Candle bearish: ${candlePatterns.bearishPatterns.join(",")}`); }

  // ── MTF Consensus ───────────────────────────────────────────
  if      (consensus === "STRONG_LONG")  { bullScore += 20; confidence += 15; signals.push("MTF consensus STRONG LONG"); }
  else if (consensus === "WEAK_LONG")    { bullScore += 10; }
  else if (consensus === "STRONG_SHORT") { bearScore += 20; confidence += 15; signals.push("MTF consensus STRONG SHORT"); }
  else if (consensus === "WEAK_SHORT")   { bearScore += 10; }
  else                                    { confidence -= 5; } // MIXED

  // ── Funding Rate ────────────────────────────────────────────
  if      (fundingRate < -0.0001) { bullScore += 10; signals.push("Funding negatif → bias LONG"); }
  else if (fundingRate >  0.001)  { bearScore += 8;  signals.push("Funding positif tinggi → hati-hati LONG"); }

  // ── Fear & Greed ────────────────────────────────────────────
  if      ((fearGreed?.value || 50) <= 15)  { bullScore += 15; signals.push(`Extreme Fear F&G=${fearGreed.value}`); }
  else if ((fearGreed?.value || 50) <= 25)  { bullScore += 8;  }
  else if ((fearGreed?.value || 50) >= 85)  { bearScore += 12; signals.push(`Extreme Greed F&G=${fearGreed.value}`); }
  else if ((fearGreed?.value || 50) >= 75)  { bearScore += 6;  }

  // ── Win Rate historis ────────────────────────────────────────
  const winRate = stats.winRate7d || 50;
  if      (winRate >= 65) { confidence += 10; }
  else if (winRate <= 35) { confidence -= 10; }

  // ── Tentukan arah prediksi ───────────────────────────────────
  const totalScore = bullScore + bearScore || 1;
  const bullPct    = (bullScore / totalScore) * 100;
  const bearPct    = (bearScore / totalScore) * 100;
  const direction  = bullScore > bearScore + 10
    ? "LONG" : bearScore > bullScore + 10
    ? "SHORT" : "NETRAL";

  // ── Confidence final ─────────────────────────────────────────
  const scoreDiff  = Math.abs(bullScore - bearScore);
  confidence = Math.min(95, Math.max(10,
    confidence + scoreDiff * 0.8 + (volRatio > 0.3 ? 10 : 0)
  ));

  // ── Estimasi profit ──────────────────────────────────────────
  // Gunakan histori recent trades jika ada, fallback ke CONFIG
  const avgWin  = stats.avgProfitPct || CONFIG.TAKE_PROFIT_PCT * 7; // leverage 7x
  const avgLoss = Math.abs(stats.avgLossPct) || CONFIG.STOP_LOSS_PCT * 7;
  const winProb = confidence / 100;
  const ev      = (winProb * avgWin) - ((1 - winProb) * avgLoss); // expected value %
  const evUSDT  = compoundedBalance * ev / 100;

  // Estimasi SL/TP berdasarkan kondisi pasar
  const slPct   = squeezeData?.squeeze ? CONFIG.STOP_LOSS_PCT * 0.8 : CONFIG.STOP_LOSS_PCT;
  const tpPct   = volRatio > 1.5 ? CONFIG.TAKE_PROFIT_PCT * 1.2 : CONFIG.TAKE_PROFIT_PCT;
  const rr      = tpPct / slPct; // risk/reward ratio

  return {
    direction,
    bullPct:     Math.round(bullPct),
    bearPct:     Math.round(bearPct),
    confidence:  Math.round(confidence),
    ev:          parseFloat(ev.toFixed(3)),
    evUSDT:      parseFloat(evUSDT.toFixed(4)),
    slPct:       parseFloat(slPct.toFixed(2)),
    tpPct:       parseFloat(tpPct.toFixed(2)),
    rr:          parseFloat(rr.toFixed(2)),
    winProb:     Math.round(winProb * 100),
    signals:     signals.slice(0, 5),  // max 5 alasan teratas
    positionSize: parseFloat(compoundedBalance.toFixed(4)),
  };
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
  <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
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
    .chart-card { grid-column: 1 / -1; }
    #price-chart { width: 100%; height: 320px; }
    .price-bar { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
    .price-change-pos { color: #3fb950; font-size: 14px; }
    .price-change-neg { color: #f85149; font-size: 14px; }
    .price-meta { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 8px; }
    .price-meta-item { display: flex; flex-direction: column; }
    .price-meta-label { font-size: 10px; color: #8b949e; }
    .price-meta-val { font-size: 13px; color: #c9d1d9; }
  </style>
</head>
<body>
  <div class="header">
    <div class="dot"></div>
    <h1>PEPE/USDT Futures Bot</h1>
    <span id="dry-badge" class="dry-badge" style="display:none">DRY RUN</span>
    <span id="pause-badge" style="display:none;background:#f8514933;color:#f85149;padding:2px 8px;border-radius:4px;font-size:11px;border:1px solid #f8514966">⏸ PAUSED</span>
    <span id="hardstop-badge" style="display:none;background:#f8514933;color:#f85149;padding:2px 10px;border-radius:4px;font-size:11px;border:1px solid #f8514966">🛑 HARD STOP</span>
    <button id="reset-btn" onclick="resetSim()" style="display:none;margin-left:8px;padding:3px 12px;background:#21262d;color:#e3b341;border:1px solid #e3b34155;border-radius:4px;font-size:11px;cursor:pointer">↺ Reset Data</button>
    <button id="start-btn" onclick="startBot()" style="display:none;margin-left:4px;padding:3px 12px;background:#21262d;color:#3fb950;border:1px solid #3fb95055;border-radius:4px;font-size:11px;cursor:pointer">▶ Start Bot</button>
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
      <!-- Top Up simulasi — hanya muncul saat DRY_RUN -->
      <div id="topup-panel" style="display:none;margin-top:14px;padding-top:12px;border-top:1px solid #30363d">
        <div style="font-size:11px;color:#e3b341;margin-bottom:8px">💰 TOP UP SALDO SIMULASI</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="topup-amount" type="number" min="1" max="10000" step="1" placeholder="Jumlah USDT"
            style="padding:5px 10px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#e6edf3;font-size:13px;width:130px"
            onkeydown="if(event.key==='Enter') topupBalance()" />
          <button onclick="topupBalance()" style="padding:5px 14px;background:#e3b34122;color:#e3b341;border:1px solid #e3b34155;border-radius:4px;font-size:12px;cursor:pointer">+ Top Up</button>
          <button onclick="topupQuick(5)"  style="padding:5px 10px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;font-size:11px;cursor:pointer">+5</button>
          <button onclick="topupQuick(10)" style="padding:5px 10px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;font-size:11px;cursor:pointer">+10</button>
          <button onclick="topupQuick(20)" style="padding:5px 10px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;font-size:11px;cursor:pointer">+20</button>
          <button onclick="topupQuick(50)" style="padding:5px 10px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;font-size:11px;cursor:pointer">+50</button>
          <span id="topup-msg" style="font-size:11px;color:#3fb950"></span>
        </div>
      </div>
    </div>
    <!-- Harga + Chart -->
    <div class="card chart-card">
      <h3>PEPE/USDT Perpetual
        <span style="font-size:10px;color:#8b949e;font-weight:normal;margin-left:8px">Timeframe:</span>
        <span id="tf-buttons" style="display:inline-flex;gap:4px;margin-left:4px">
          <button onclick="switchTF('1m')" id="tf-1m" style="padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer;background:#21262d;color:#8b949e;border:1px solid #30363d">1m</button>
          <button onclick="switchTF('5m')" id="tf-5m" style="padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer;background:#388bfd33;color:#58a6ff;border:1px solid #388bfd66">5m</button>
          <button onclick="switchTF('15m')" id="tf-15m" style="padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer;background:#21262d;color:#8b949e;border:1px solid #30363d">15m</button>
          <button onclick="switchTF('1H')" id="tf-1h" style="padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer;background:#21262d;color:#8b949e;border:1px solid #30363d">1H</button>
        </span>
      </h3>
      <div class="price-bar">
        <!-- Harga utama dengan 10 desimal seperti Bitget -->
        <span class="big-price" id="price" style="font-size:28px;font-family:'Courier New',monospace">--</span>
        <div style="display:flex;flex-direction:column;justify-content:center;margin-left:8px">
          <span id="price-change" class="price-change-pos" style="font-size:13px">--</span>
          <span style="font-size:10px;color:#8b949e">USDT Perpetual</span>
        </div>
      </div>
      <div class="price-meta" style="margin-top:6px">
        <div class="price-meta-item"><span class="price-meta-label">BID</span><span class="price-meta-val green" id="bid">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">ASK</span><span class="price-meta-val red" id="ask">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">MARK PRICE</span><span class="price-meta-val" id="mark-price">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">24H HIGH</span><span class="price-meta-val green" id="high24h">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">24H LOW</span><span class="price-meta-val red" id="low24h">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">FUNDING/COUNTDOWN</span><span class="price-meta-val" id="funding">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">24H VOL (PEPE)</span><span class="price-meta-val" id="vol24h">--</span></div>
        <div class="price-meta-item"><span class="price-meta-label">24H VOL (USDT)</span><span class="price-meta-val" id="vol24h-usdt">--</span></div>
      </div>
      <div id="price-chart" style="margin-top:12px"></div>
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
      <!-- Loss Streak Warning -->
      <div id="loss-streak-warning" style="display:none;
        margin-top:10px;padding:8px;border-radius:6px;
        background:#f8514922;border:1px solid #f8514966;
        color:#f85149;font-size:12px;text-align:center">
        🔴 Loss Streak: <span id="loss-streak-count">0</span>x
        <span id="loss-streak-msg"></span>
      </div>
      <div id="cooldown-info" style="display:none;
        margin-top:6px;padding:6px;border-radius:4px;
        background:#d2992222;border:1px solid #d2992266;
        color:#d29922;font-size:11px;text-align:center">
        ⏸ Cooldown aktif — resume:
        <span id="cooldown-resume">--</span>
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

    <!-- SMC + Claude Filter -->
    <div class="card ai-card">
      <h3>🧠 SMC + Claude Filter</h3>
      <div id="smc-status-bar" style="padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center;background:#21262d;color:#8b949e">
        Menunggu data SMC...
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
        <div style="text-align:center;padding:8px;background:#21262d;border-radius:6px">
          <div style="font-size:9px;color:#8b949e;margin-bottom:2px">HTF TREND (15m)</div>
          <div id="smc-htf" style="font-size:16px;font-weight:bold">--</div>
        </div>
        <div style="text-align:center;padding:8px;background:#21262d;border-radius:6px">
          <div style="font-size:9px;color:#8b949e;margin-bottom:2px">SESSION</div>
          <div id="smc-session" style="font-size:13px;font-weight:bold">--</div>
        </div>
        <div style="text-align:center;padding:8px;background:#21262d;border-radius:6px">
          <div style="font-size:9px;color:#8b949e;margin-bottom:2px">ATR</div>
          <div id="smc-atr" style="font-size:16px;font-weight:bold">--</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:10px">
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px">
          <div style="font-size:8px;color:#8b949e">INDUCEMENT</div>
          <div id="smc-ind" style="font-size:18px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px">
          <div style="font-size:8px;color:#8b949e">LIQ GRAB</div>
          <div id="smc-liq" style="font-size:18px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px">
          <div style="font-size:8px;color:#8b949e">CHoCH</div>
          <div id="smc-choch" style="font-size:18px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px">
          <div style="font-size:8px;color:#8b949e">FVG</div>
          <div id="smc-fvg" style="font-size:18px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px">
          <div style="font-size:8px;color:#8b949e">CANDLE</div>
          <div id="smc-candle" style="font-size:18px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px;border:1px solid #30363d66">
          <div style="font-size:8px;color:#58a6ff">LIQ SWEEP</div>
          <div id="smc-sweep" style="font-size:18px;margin-top:2px">--</div>
        </div>
        <div style="text-align:center;padding:6px 4px;background:#21262d;border-radius:4px;border:1px solid #30363d66">
          <div style="font-size:8px;color:#58a6ff">BOS</div>
          <div id="smc-bos" style="font-size:18px;margin-top:2px">--</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:6px 10px;background:#21262d;border-radius:6px">
        <div style="font-size:10px;color:#8b949e;flex-shrink:0">REVERSAL SCORE</div>
        <div id="smc-rev-score" style="font-size:20px;font-weight:bold;min-width:60px">--</div>
        <div style="flex:1;background:#161b22;height:6px;border-radius:3px;overflow:hidden">
          <div id="smc-rev-bar" style="height:100%;border-radius:3px;background:#3fb950;transition:width 0.5s;width:0%"></div>
        </div>
        <div style="font-size:9px;color:#8b949e">≥60 = Claude dipanggil</div>
      </div>
      <!-- Session countdown timer -->
      <div id="session-countdown" style="margin-top:8px;padding:6px 10px;background:#21262d;border-radius:6px;font-size:11px;display:flex;justify-content:space-between;align-items:center">
        <span style="color:#8b949e">Session berikutnya:</span>
        <span id="session-timer" style="color:#d29922;font-family:'Courier New',monospace;font-weight:bold">--</span>
        <span style="color:#8b949e">| WIB sekarang:</span>
        <span id="wib-time" style="color:#c9d1d9;font-family:'Courier New',monospace">--</span>
      </div>
      <div id="claude-filter-result" style="display:none;padding:8px;border-radius:6px;font-size:11px;border:1px solid #30363d">
        <div style="font-size:10px;color:#8b949e;margin-bottom:4px">CLAUDE FILTER RESULT</div>
        <div id="claude-approve" style="font-weight:bold;margin-bottom:2px">--</div>
        <div id="claude-reason" style="color:#8b949e">--</div>
      </div>
    </div>

    <!-- Prediksi Profit -->
    <div class="card ai-card" id="pred-card">
      <h3>Prediksi Profit Trade Berikutnya</h3>
      <div id="pred-content"><div class="no-pos">Menunggu data...</div></div>
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
    const sse = new EventSource('/events');
    sse.onmessage = (e) => {
      try { handle(JSON.parse(e.data)); } catch (err) { console.error('SSE error:', err); }
    };

    function fmt(n, dec = 10) {
      if (!n || n === 0) return '--';
      const p = Number(n);
      if (p < 0.000001) return p.toFixed(10);
      if (p < 0.0001)   return p.toFixed(8);
      return p.toFixed(dec);
    }
    function fmtPct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
    function formatPepePrice(price) {
      if (!price || price === 0) return '--';
      const p = Number(price);
      // PEPE di Bitget selalu tampil 10 desimal
      // contoh: 0.0000033993
      if (p < 0.000001)      return p.toFixed(10); // 0.0000033993
      if (p < 0.0001)        return p.toFixed(8);
      if (p < 0.01)          return p.toFixed(6);
      return p.toFixed(4);
    }
    function fmtVol(v) {
      if (!v || v === 0) return '--';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
      return Number(v).toFixed(2);
    }

    // ── TradingView Lightweight Chart ──────────────────────────
    let chart = null, candleSeries = null, volSeries = null;
    let ema9Series = null, ema21Series = null;
    let currentTF = '5m';
    let currentKlines = [];

    function initChart() {
      const container = document.getElementById('price-chart');
      if (!container || chart) return;
      chart = LightweightCharts.createChart(container, {
        width:  container.offsetWidth || 800,
        height: 320,
        layout: { background: { color: '#161b22' }, textColor: '#c9d1d9' },
        grid:   { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#30363d' },
        timeScale: {
          borderColor: '#30363d',
          timeVisible: true,
          secondsVisible: false,
        },
      });
      candleSeries = chart.addCandlestickSeries({
        upColor:        '#3fb950',
        downColor:      '#f85149',
        borderUpColor:  '#3fb950',
        borderDownColor:'#f85149',
        wickUpColor:    '#3fb950',
        wickDownColor:  '#f85149',
      });
      volSeries = chart.addHistogramSeries({
        color: '#8b949e66',
        priceFormat:   { type: 'volume' },
        priceScaleId:  'vol',
        scaleMargins:  { top: 0.8, bottom: 0 },
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

      // ── EMA Lines overlay ──────────────────────────────
      ema9Series = chart.addLineSeries({
        color:     '#58a6ff',
        lineWidth: 1,
        title:     'EMA9',
        priceLineVisible:  false,
        lastValueVisible:  true,
        crosshairMarkerVisible: false,
      });

      ema21Series = chart.addLineSeries({
        color:     '#f0883e',
        lineWidth: 1,
        title:     'EMA21',
        priceLineVisible:  false,
        lastValueVisible:  true,
        crosshairMarkerVisible: false,
      });

      // Responsive resize
      const ro = new ResizeObserver(() => {
        if (chart) chart.applyOptions({ width: container.offsetWidth });
      });
      ro.observe(container);
    }

    function setChartData(klines) {
      if (!klines || klines.length === 0) return;
      if (!chart) initChart();
      const candles = klines.map(k => ({
        time:  Math.floor(k.time / 1000),
        open:  k.open, high: k.high, low: k.low, close: k.close,
      })).filter((c, i, arr) => i === 0 || c.time > arr[i-1].time); // deduplicate
      const volumes = klines.map(k => ({
        time:  Math.floor(k.time / 1000),
        value: k.volume,
        color: k.close >= k.open ? '#3fb95044' : '#f8514944',
      })).filter((c, i, arr) => i === 0 || c.time > arr[i-1].time);
      candleSeries.setData(candles);
      volSeries.setData(volumes);
      chart.timeScale().fitContent();

      // Update EMA setelah set data
      updateEMALines(klines);
      currentKlines = klines;
    }

    function updateChartCandle(candle) {
      if (!candleSeries || !candle) return;
      if (!chart) initChart();

      // Hanya update chart kalau TF = 1m (TF lain di-update oleh auto-refresh interval)
      if (currentTF !== '1m') return;

      const c = {
        time:  Math.floor(candle.time / 1000),
        open:  candle.open, high: candle.high,
        low:   candle.low,  close: candle.close,
      };
      const v = {
        time:  Math.floor(candle.time / 1000),
        value: candle.volume,
        color: candle.close >= candle.open ? '#3fb95044' : '#f8514944',
      };
      try {
        candleSeries.update(c);
        volSeries.update(v);
      } catch (_) {}

      // Update EMA real-time di 1m
      if (currentKlines.length > 0) {
        const idx = currentKlines.findIndex(k =>
          Math.floor(k.time/1000) === c.time
        );
        if (idx >= 0) currentKlines[idx] = candle;
        else { currentKlines.push(candle); currentKlines.shift(); }
        updateEMACandle(currentKlines);
      }
    }

    // ── EMA Calculator (untuk chart) ────────────────────────────
    function calcEMAArr(closes, period) {
      if (closes.length < period) return [];
      const k = 2 / (period + 1);
      const res = [];
      let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
      res.push(ema);
      for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
        res.push(ema);
      }
      return res;
    }

    function updateEMALines(klines) {
      if (!ema9Series || !ema21Series || !klines?.length) return;
      const closes    = klines.map(k => k.close);
      const times     = klines.map(k => Math.floor(k.time / 1000));
      const ema9Vals  = calcEMAArr(closes, 9);
      const ema21Vals = calcEMAArr(closes, 21);

      const ema9Data = ema9Vals.map((v, i) => ({
        time:  times[i + (closes.length - ema9Vals.length)],
        value: v,
      })).filter(d => d.time > 0);

      const ema21Data = ema21Vals.map((v, i) => ({
        time:  times[i + (closes.length - ema21Vals.length)],
        value: v,
      })).filter(d => d.time > 0);

      try {
        ema9Series.setData(ema9Data);
        ema21Series.setData(ema21Data);
      } catch (_) {}
    }

    function updateEMACandle(klines) {
      if (!ema9Series || !ema21Series || !klines?.length) return;
      const closes = klines.map(k => k.close);
      const lastTime = Math.floor(klines[klines.length-1].time / 1000);

      function lastEMA(period) {
        const k = 2 / (period + 1);
        if (closes.length < period) return null;
        let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
        for (let i = period; i < closes.length; i++) {
          ema = closes[i] * k + ema * (1 - k);
        }
        return ema;
      }

      const e9  = lastEMA(9);
      const e21 = lastEMA(21);
      if (e9)  ema9Series.update({ time: lastTime, value: e9 });
      if (e21) ema21Series.update({ time: lastTime, value: e21 });
    }

    // ── Timeframe Switch & Auto-refresh ─────────────────────────
    async function switchTF(tf) {
      currentTF = tf;

      // Update tombol aktif
      ['1m','5m','15m','1h'].forEach(t => {
        const btn = document.getElementById('tf-' + t);
        if (!btn) return;
        if (t === tf) {
          btn.style.background = '#388bfd33';
          btn.style.color      = '#58a6ff';
          btn.style.border     = '1px solid #388bfd66';
        } else {
          btn.style.background = '#21262d';
          btn.style.color      = '#8b949e';
          btn.style.border     = '1px solid #30363d';
        }
      });

      // Fetch klines dari server
      try {
        const res  = await fetch('/api/klines?tf=' + tf + '&limit=150');
        const data = await res.json();
        if (data.klines && data.klines.length > 0) {
          currentKlines = data.klines;
          setChartData(data.klines);
          updateEMALines(data.klines);
        }
      } catch (err) {
        console.warn('Gagal fetch klines:', err.message);
      }
    }

    // Auto-refresh chart setiap 10 detik (kecuali 1m yang sudah real-time dari SSE)
    setInterval(async () => {
      if (currentTF === '1m') return;
      try {
        const res  = await fetch('/api/klines?tf=' + currentTF + '&limit=20');
        const data = await res.json();
        if (data.klines?.length > 0) {
          const latest = data.klines[data.klines.length - 1];
          const c = {
            time:  Math.floor(latest.time / 1000),
            open:  latest.open,
            high:  latest.high,
            low:   latest.low,
            close: latest.close,
          };
          const v = {
            time:  Math.floor(latest.time / 1000),
            value: latest.volume,
            color: latest.close >= latest.open ? '#3fb95044' : '#f8514944',
          };
          try {
            if (candleSeries) candleSeries.update(c);
            if (volSeries)    volSeries.update(v);
            // Update klines cache untuk EMA
            if (currentKlines.length > 0) {
              const idx = currentKlines.findIndex(k =>
                Math.floor(k.time/1000) === c.time
              );
              if (idx >= 0) currentKlines[idx] = latest;
              else currentKlines.push(latest);
              updateEMACandle(currentKlines);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }, 10000);

    // Update session countdown setiap detik
    setInterval(() => {
      const now     = new Date();
      const utcH    = now.getUTCHours();
      const utcM    = now.getUTCMinutes();
      const utcS    = now.getUTCSeconds();
      const wibH    = (utcH + 7) % 24;
      const wibStr  = String(wibH).padStart(2,'0') + ':' +
                      String(utcM).padStart(2,'0') + ':' +
                      String(utcS).padStart(2,'0');

      const wibEl = document.getElementById('wib-time');
      if (wibEl) wibEl.textContent = wibStr + ' WIB';

      const timerEl = document.getElementById('session-timer');
      if (!timerEl) return;

      const utcNow = utcH + utcM / 60 + utcS / 3600;
      const inLondon = utcNow >= 7  && utcNow < 16;
      const inNY     = utcNow >= 13 && utcNow < 22;

      if (inLondon || inNY) {
        // Dalam session aktif — tampilkan kapan berakhir
        const endH = inNY && utcNow >= 16 ? 22 : inLondon ? 16 : 22;
        const secsLeft = (endH - utcH) * 3600 - utcM * 60 - utcS;
        const h = Math.floor(secsLeft / 3600);
        const m = Math.floor((secsLeft % 3600) / 60);
        const s = secsLeft % 60;
        timerEl.textContent = "AKTIF - berakhir " + String(h).padStart(2,'0') +":"+ String(m).padStart(2,'0') +":"+ String(s).padStart(2,'0');
        timerEl.style.color = '#3fb950';
      } else {
        // Di luar session — hitung ke London open berikutnya
        let nextUTC = utcNow < 7 ? 7 : 7 + 24; // London open
        const secsLeft = Math.max(0, Math.round((nextUTC - utcNow) * 3600));
        const h = Math.floor(secsLeft / 3600);
        const m = Math.floor((secsLeft % 3600) / 60);
        const s = secsLeft % 60;
        timerEl.textContent = "London " + String(h).padStart(2,'0') +":"+ String(m).padStart(2,'0') +":"+ String(s).padStart(2,'0');
        timerEl.style.color = '#d29922';
      }
    }, 1000);

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
      window.currentPosition = d.position !== undefined ? d.position : window.currentPosition;

      if (d.type === 'init') {
        document.getElementById('dry-badge').style.display    = d.dryRun ? 'inline' : 'none';
        document.getElementById('topup-panel').style.display  = d.dryRun ? 'block'  : 'none';
        if (d.botStopped) {
          // Bot sedang stopped saat dashboard dibuka — tampilkan badge + tombol langsung
          document.getElementById('hardstop-badge').style.display = 'inline';
          document.getElementById('start-btn').style.display      = 'inline-block';
          document.getElementById('reset-btn').style.display      = 'inline-block';
          document.querySelector('.dot').style.background = '#f85149';
        }
        if (d.stats) renderWinRate(d.stats);
        if (d.balance) handleBalance(d.balance);
        if (d.externalData) handleIntelligence({ externalData: d.externalData });
        if (d.position) renderPosition(d.position, d.price || 0);
        if (d.tradeLog) renderTradeLog(d.tradeLog);
        if (d.klines && d.klines.length > 0) {
          // Init dengan data 1m dari SSE
          currentKlines = d.klines;
          setChartData(d.klines);
          updateEMALines(d.klines);
          // Langsung switch ke 5m setelah init
          setTimeout(() => switchTF('5m'), 500);
        }
      }
      if (d.type === 'trade') { renderTradeLog(d.tradeLog); return; }
      // Fast price update (tiap 3 detik)
      if (d.type === 'price') {
        if (d.price) {
          document.getElementById('price').textContent = formatPepePrice(d.price);
          window.lastPrice = d.price;
          if (d.change24h !== undefined) {
            const el = document.getElementById('price-change');
            el.textContent = fmtPct(d.change24h * 100);
            el.className   = d.change24h >= 0 ? 'price-change-pos' : 'price-change-neg';
          }
        }
        if (d.bid) document.getElementById('bid').textContent = formatPepePrice(d.bid);
        if (d.ask) document.getElementById('ask').textContent = formatPepePrice(d.ask);
        if (d.high24h) document.getElementById('high24h').textContent = formatPepePrice(d.high24h);
        if (d.low24h) document.getElementById('low24h').textContent = formatPepePrice(d.low24h);
        if (d.markPrice) document.getElementById('mark-price').textContent = formatPepePrice(d.markPrice);
        if (d.volume24h) {
          document.getElementById('vol24h').textContent = fmtVol(d.volume24h);
          // Vol dalam USDT
          const volUsdt = d.volume24h * (window.lastPrice || 0);
          document.getElementById('vol24h-usdt').textContent = fmtVol(volUsdt) + ' USDT';
        }
        return;
      }
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
      if (d.price) {
        document.getElementById('price').textContent = formatPepePrice(d.price);
        window.lastPrice = d.price;
        if (d.change24h !== undefined) {
          const el = document.getElementById('price-change');
          el.textContent = fmtPct(d.change24h * 100);
          el.className   = d.change24h >= 0 ? 'price-change-pos' : 'price-change-neg';
        }
      }
      if (d.volume24h) document.getElementById('vol24h').textContent = fmtVol(d.volume24h);
      if (d.vwap) document.getElementById('vwap-price').textContent = formatPepePrice(d.vwap);
      if (d.latestCandle) updateChartCandle(d.latestCandle);
      if (d.rsi !== undefined) {
        const rsiEl = document.getElementById('rsi');
        rsiEl.textContent = Number(d.rsi).toFixed(2);
        rsiEl.className = d.rsi > 70 ? 'val red' : d.rsi < 30 ? 'val green' : 'val';
      }
      if (d.ema9)  document.getElementById('ema9').textContent  = formatPepePrice(d.ema9);
      if (d.ema21) document.getElementById('ema21').textContent = formatPepePrice(d.ema21);
      if (d.fundingRate !== undefined) {
        const fr = (d.fundingRate * 100).toFixed(4) + '%';
        const el = document.getElementById('funding');
        el.textContent = fr;
        el.className = Math.abs(d.fundingRate) > 0.001 ? 'val red' : 'val';
      }
      if (d.fearGreed) document.getElementById('feargreed').textContent = d.fearGreed.value + ' (' + d.fearGreed.classification + ')';
      if (d.bid) document.getElementById('bid').textContent = formatPepePrice(d.bid);
      if (d.ask) document.getElementById('ask').textContent = formatPepePrice(d.ask);
      if (d.position) renderPosition(d.position, d.price || window.lastPrice);
      else if (d.type === 'analysis' && !d.position) document.getElementById('position-content').innerHTML = '<div class="no-pos">Tidak ada posisi aktif</div>';
      if (d.analysis) renderAI(d.analysis);
      if (d.prediction) renderPrediction(d.prediction);
      if (d.smcData) {
        console.log('smcData received in handle, calling renderSMC');
        renderSMC(d.smcData);
      }
      if (d.type === 'analysis') { renderMTF(d); renderBB(d); handleIntelligence(d); }
      // Handler untuk periodic Claude analysis
      // (update card AI tanpa trigger entry logic)
      if (d.type === 'analysis_update') {
        if (d.analysis) renderAI(d.analysis);
        if (d.bb)       renderBB(d);
        if (d.fearGreed) document.getElementById('feargreed').textContent =
          d.fearGreed.value + ' (' + d.fearGreed.classification + ')';
        if (d.externalData) handleIntelligence({ externalData: d.externalData });
        return;
      }
      if (d.type === 'log') addLog(d);
      if (d.type === 'stats') {
        renderStats(d);
        renderWinRate(d);

        // Loss streak dan cooldown display
        const streakEl   = document.getElementById('loss-streak-warning');
        const countEl    = document.getElementById('loss-streak-count');
        const msgEl      = document.getElementById('loss-streak-msg');
        const cooldownEl = document.getElementById('cooldown-info');
        const resumeEl   = document.getElementById('cooldown-resume');

        if (streakEl && d.lossStreak > 0) {
          streakEl.style.display = 'block';
          if (countEl) countEl.textContent = d.lossStreak;
          if (msgEl) {
            msgEl.textContent = d.lossStreak >= 5
              ? '— EMERGENCY PAUSE 2 jam!'
              : d.lossStreak >= 3
              ? '— Pause 1 jam otomatis'
              : '— Cooldown 15 menit';
          }
        } else if (streakEl) {
          streakEl.style.display = 'none';
        }

        if (cooldownEl && d.cooldownActive) {
          cooldownEl.style.display = 'block';
          if (resumeEl && d.cooldownResumeAt) {
            resumeEl.textContent = new Date(d.cooldownResumeAt).toLocaleTimeString('id-ID');
          }
        } else if (cooldownEl) {
          cooldownEl.style.display = 'none';
        }
      }
      if (d.type === 'topup') {
        const msg = document.getElementById('topup-msg');
        if (msg) { msg.textContent = \`✓ +\${d.amount} USDT\`; msg.style.color = '#3fb950'; setTimeout(() => { msg.textContent = ''; }, 4000); }
      }
      if (d.type === 'hardstop') {
        document.getElementById('hardstop-badge').style.display = 'inline';
        document.getElementById('reset-btn').style.display      = 'inline-block';
        document.getElementById('start-btn').style.display      = 'inline-block';
        document.querySelector('.dot').style.background = '#f85149';
        addLog({ level: 'ERROR', msg: \`🛑 HARD STOP — Loss \${d.lossPercent}% | klik ▶ Start Bot untuk lanjut atau ↺ Reset Data untuk sesi baru\` });
      }
      if (d.type === 'reset') {
        // Data direset — tampilkan Start Bot, sembunyikan Reset
        document.getElementById('reset-btn').style.display = 'none';
        document.getElementById('start-btn').style.display = 'inline-block';
        addLog({ level: 'INFO', msg: '↺ Data simulasi direset — klik Start Bot untuk mulai lagi' });
      }
      if (d.type === 'started') {
        document.getElementById('hardstop-badge').style.display = 'none';
        document.getElementById('start-btn').style.display      = 'none';
        document.querySelector('.dot').style.background = '#3fb950';
        addLog({ level: 'INFO', msg: '▶ Bot dimulai' });
      }
    }

    async function resetSim() {
      if (!confirm('Reset data simulasi? Bot tidak akan otomatis restart — bisa pelajari data dulu.')) return;
      try {
        const r = await fetch('/api/reset', { method: 'POST' });
        const j = await r.json();
        addLog({ level: 'INFO', msg: j.message });
      } catch (e) {
        alert('Gagal reset: ' + e.message);
      }
    }

    async function startBot() {
      if (!confirm('Start bot? Trading akan dimulai kembali.')) return;
      try {
        const r = await fetch('/api/start', { method: 'POST' });
        const j = await r.json();
        addLog({ level: 'INFO', msg: j.message });
      } catch (e) {
        alert('Gagal start: ' + e.message);
      }
    }

    async function topupBalance() {
      const input  = document.getElementById('topup-amount');
      const amount = parseFloat(input.value);
      if (!amount || amount <= 0) { alert('Masukkan jumlah USDT yang valid'); return; }
      await doTopup(amount);
      input.value = '';
    }

    async function topupQuick(amount) {
      await doTopup(amount);
    }

    async function doTopup(amount) {
      try {
        const r = await fetch('/api/topup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount }),
        });
        const j = await r.json();
        const msg = document.getElementById('topup-msg');
        msg.textContent = j.message;
        msg.style.color = j.ok ? '#3fb950' : '#f85149';
        if (j.ok) {
          addLog({ level: 'INFO', msg: \`💰 Top up +\${amount} USDT → saldo: \${j.balance?.toFixed(2)} USDT\` });
          setTimeout(() => { msg.textContent = ''; }, 4000);
        }
      } catch (e) {
        alert('Gagal top up: ' + e.message);
      }
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
      
      // Fitur baru: Breakeven status
      const breakevenStatus = pos.breakevenSet 
        ? '<span class="val green">✅ Aktif</span>' 
        : '<span class="val yellow">⏳ Belum (profit &lt;0.4%)</span>';
      
      // Fitur baru: Lock Profit status
      const lockProfitStatus = pos.lockLevel !== undefined 
        ? '<span class="val green">🔐 Level ' + (pos.lockLevel+1) + '</span>' 
        : '<span class="val yellow">⏳ Belum aktif</span>';
      
      // Fitur baru: Trailing TP
      const trailingTPVal = pos.trailingTP ? formatPepePrice(pos.trailingTP) : '--';
      
      document.getElementById('position-content').innerHTML = \`
        <div class="row"><span class="label">Side</span><span class="val \${pos.side === 'LONG' ? 'green' : 'red'}">\${pos.side}</span></div>
        <div class="row"><span class="label">Entry</span><span class="val">\${formatPepePrice(pos.entryPrice)}</span></div>
        <div class="row"><span class="label">Leverage</span><span class="val">\${pos.leverage}x</span></div>
        <div class="row"><span class="label">Stop Loss</span><span class="val yellow">\${formatPepePrice(pos.stopLoss)}</span></div>
        <div class="row"><span class="label">Take Profit</span><span class="val green">\${formatPepePrice(pos.takeProfit)}</span></div>
        <div class="row"><span class="label">PnL</span><span class="val \${pnlClass}">\${fmtPct(pnlPct)}</span></div>
        <div class="row"><span class="label">Breakeven</span>\${breakevenStatus}</div>
        <div class="row"><span class="label">Lock Profit</span>\${lockProfitStatus}</div>
        <div class="row"><span class="label">Trailing TP</span><span class="val blue">\${trailingTPVal}</span></div>
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

    function renderSMC(s) {
      console.log('renderSMC called with:', JSON.stringify(s, null, 2));
      if (!s) {
        console.log('smcData is empty or undefined!');
        return;
      }

      // HTF
      const htfEl = document.getElementById('smc-htf');
      if (htfEl) {
        htfEl.textContent = s.htfTrend || '--';
        htfEl.className   = s.htfTrend === 'BULLISH' ? 'green' : s.htfTrend === 'BEARISH' ? 'red' : 'val';
        if (s.htfStrength) htfEl.title = s.htfStrength;
      }

      // Session
      const sesEl = document.getElementById('smc-session');
      if (sesEl) {
        sesEl.textContent  = s.session || '--';
        sesEl.style.color  = s.session?.includes('OVERLAP') ? '#d29922'
          : (s.session?.includes('LONDON') || s.session?.includes('NEW_YORK')) ? '#3fb950'
          : '#f85149';
      }

      // ATR
      const atrEl = document.getElementById('smc-atr');
      if (atrEl) {
        atrEl.textContent  = s.atrPct !== undefined ? s.atrPct + '%' : '--';
        atrEl.style.color  = parseFloat(s.atrPct) < 0.03 ? '#f85149'
          : parseFloat(s.atrPct) > 0.1 ? '#3fb950' : '#d29922';
      }

      // Checklist
      const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ? '✅' : '❌'; };
      setCheck('smc-ind',    s.inducement?.valid);
      setCheck('smc-liq',    s.liquidityGrab?.detected);
      setCheck('smc-choch',  s.choch?.detected);
      setCheck('smc-fvg',    s.inFVG?.inFVG);
      setCheck('smc-candle', s.candleOK?.confirmed);
      setCheck('smc-sweep',  s.sweep?.detected);
      setCheck('smc-bos',    s.bos?.detected);

      // Reversal Score
      const rsEl = document.getElementById('smc-rev-score');
      if (rsEl && s.revScore) {
        rsEl.textContent  = s.revScore.score + ' ' + (s.revScore.grade || '');
        rsEl.style.color  = s.revScore.grade === 'A' ? '#3fb950'
          : s.revScore.grade === 'B' ? '#d29922'
          : s.revScore.grade === 'C' ? '#f0883e' : '#f85149';
        rsEl.title = s.revScore.reasons?.join(' | ') || '';
        const barEl = document.getElementById('smc-rev-bar');
        if (barEl) {
          barEl.style.width      = Math.min(100, s.revScore.score) + '%';
          barEl.style.background = s.revScore.grade === 'A' ? '#3fb950'
            : s.revScore.grade === 'B' ? '#d29922'
            : s.revScore.grade === 'C' ? '#f0883e' : '#f85149';
        }
      }

      // Status bar
      const bar = document.getElementById('smc-status-bar');
      if (bar) {
        if (s.flat) {
          bar.textContent = \`⏸ Market flat (ATR \${s.atrPct}%) — menunggu volatilitas\`;
          bar.style.cssText = 'padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center;background:#21262d;color:#8b949e;border:none';
        } else if (s.cooldown) {
          bar.textContent = \`⏳ Cooldown entry — \${s.cooldown} detik lagi\`;
          bar.style.cssText = 'padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center;background:#21262d;color:#8b949e;border:none';
        } else if (!s.active && s.active !== undefined) {
          // Tampilkan waktu London/NY berikutnya
          const now    = new Date();
          const utcHour = now.getUTCHours();
          const utcMin  = now.getUTCMinutes();
          const wibHour = (utcHour + 7) % 24;

          // Hitung sisa waktu ke London open (07:00 UTC = 14:00 WIB)
          let nextSession = '', minsToNext = 0;
          if (utcHour < 7) {
            minsToNext = (7 - utcHour) * 60 - utcMin;
            nextSession = 'London';
          } else if (utcHour >= 22) {
            minsToNext = (31 - utcHour) * 60 - utcMin; // next day 07:00
            nextSession = 'London';
          } else {
            minsToNext = 0;
            nextSession = 'aktif';
          }

          const hoursLeft = Math.floor(minsToNext / 60);
          const minsLeft  = minsToNext % 60;
          const timeStr   = minsToNext > 0
            ? \`(\${hoursLeft}j \${minsLeft}m lagi)\`
            : '';

          bar.textContent = \`😴 \${s.session} — Entry dinonaktifkan. Sesi \${nextSession} \${timeStr} | Scan SMC tetap aktif\`;
          bar.style.cssText = 'padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center;background:#21262d;color:#d29922;border:1px solid #d2992244';
        } else if (s.smcReady) {
          bar.textContent = '🎯 SMC LENGKAP! Menunggu konfirmasi Claude...';
          bar.style.cssText = 'padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center;background:#3fb95022;color:#3fb950;border:1px solid #3fb95066';
        } else {
          const missing = [];
          if (!s.inducement?.valid)      missing.push('Inducement');
          if (!s.liquidityGrab?.detected) missing.push('Liq Grab');
          if (!s.choch?.detected)         missing.push('CHoCH');
          if (!s.inFVG?.inFVG)            missing.push('FVG');
          if (!s.candleOK?.confirmed)     missing.push('Candle');
          bar.textContent = missing.length ? \`Menunggu: \${missing.join(' → ')}\` : 'Scanning...';
          bar.style.cssText = 'padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center;background:#21262d;color:#8b949e;border:none';
        }
      }

      // Claude filter result
      if (s.claudeFilter) {
        const filterDiv = document.getElementById('claude-filter-result');
        const approveEl = document.getElementById('claude-approve');
        const reasonEl  = document.getElementById('claude-reason');
        if (filterDiv) filterDiv.style.display = 'block';
        if (approveEl) {
          approveEl.textContent = s.claudeFilter.approve
            ? \`✅ APPROVED (\${s.claudeFilter.confidence}%) — Risk: \${s.claudeFilter.risk}\`
            : \`❌ REJECTED (\${s.claudeFilter.confidence}%) — Risk: \${s.claudeFilter.risk}\`;
          approveEl.style.color = s.claudeFilter.approve ? '#3fb950' : '#f85149';
        }
        if (reasonEl) reasonEl.textContent = s.claudeFilter.reason || '--';
      }
    }

    function renderPrediction(p) {
      if (!p) return;
      const dirColor = p.direction === 'LONG' ? '#3fb950' : p.direction === 'SHORT' ? '#f85149' : '#d29922';
      const evColor  = p.ev >= 0 ? '#3fb950' : '#f85149';
      const confFill = p.confidence >= 70 ? '#3fb950' : p.confidence >= 50 ? '#d29922' : '#f85149';
      const bullW    = Math.min(100, p.bullPct);
      const bearW    = Math.min(100, p.bearPct);
      const rrColor  = p.rr >= 1.5 ? '#3fb950' : p.rr >= 1.0 ? '#d29922' : '#f85149';
      document.getElementById('pred-content').innerHTML = \`
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:14px">
          <div style="text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:4px">ARAH PREDIKSI</div>
            <div style="font-size:24px;font-weight:bold;color:\${dirColor}">\${p.direction}</div>
            <div style="font-size:11px;color:#8b949e;margin-top:2px">Peluang menang \${p.winProb}%</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:4px">EXPECTED VALUE</div>
            <div style="font-size:24px;font-weight:bold;color:\${evColor}">\${p.ev >= 0 ? '+' : ''}\${p.ev.toFixed(2)}%</div>
            <div style="font-size:11px;color:\${evColor};margin-top:2px">\${p.evUSDT >= 0 ? '+' : ''}\${p.evUSDT.toFixed(4)} USDT</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:4px">RISK / REWARD</div>
            <div style="font-size:24px;font-weight:bold;color:\${rrColor}">1:\${p.rr.toFixed(1)}</div>
            <div style="font-size:11px;color:#8b949e;margin-top:2px">SL \${p.slPct}% → TP \${p.tpPct}%</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:10px;color:#8b949e;margin-bottom:4px">KEYAKINAN</div>
            <div style="font-size:24px;font-weight:bold;color:\${confFill}">\${p.confidence}%</div>
            <div style="font-size:11px;color:#8b949e;margin-top:2px">Ukuran posisi \${p.positionSize} USDT</div>
          </div>
        </div>

        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#8b949e;margin-bottom:4px">
            <span>BULL \${p.bullPct}%</span><span>BEAR \${p.bearPct}%</span>
          </div>
          <div style="background:#21262d;height:8px;border-radius:4px;overflow:hidden;display:flex">
            <div style="width:\${bullW}%;background:#3fb950;transition:width 0.6s"></div>
            <div style="width:\${bearW}%;background:#f85149;transition:width 0.6s;margin-left:auto"></div>
          </div>
        </div>

        <div style="margin-bottom:10px">
          <div style="font-size:10px;color:#8b949e;margin-bottom:4px">KEYAKINAN SINYAL</div>
          <div style="background:#21262d;height:6px;border-radius:3px;overflow:hidden">
            <div style="width:\${p.confidence}%;height:100%;background:\${confFill};border-radius:3px;transition:width 0.6s"></div>
          </div>
        </div>

        <div style="font-size:11px;color:#8b949e">
          <div style="margin-bottom:4px;font-weight:bold;color:#c9d1d9">Sinyal Terdeteksi:</div>
          \${p.signals.length > 0
            ? p.signals.map(s => \`<div style="padding:2px 0;border-left:2px solid \${dirColor};padding-left:8px;margin:3px 0">\${s}</div>\`).join('')
            : '<div style="padding:2px 0">Tidak ada sinyal kuat</div>'}
        </div>
      \`;
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
  const server = http.createServer(async (req, res) => {
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
        botStopped:  !state.running,         // kirim status stopped ke dashboard
        balance:     _initBal,               // BUG #1a FIX
        externalData: externalDataCache,     // BUG #1a FIX
        isPaused:    !!(state.pausedUntil && Date.now() < state.pausedUntil), // BUG #6 FIX
        tradeLog:    tradeLog.slice(-50),    // Log transaksi 50 terakhir
        klines:      state.lastKlines.slice(-150), // Data chart 150 candle terakhir
      })}\n\n`);

      req.on("close", () => {
        state.dashboardClients = state.dashboardClients.filter((c) => c !== res);
      });
    } else if (req.url?.startsWith("/api/klines")) {
      // Parse query params
      const urlObj  = new URL(req.url, 'http://localhost');
      const tf      = urlObj.searchParams.get('tf')    || '5m';
      const limit   = parseInt(urlObj.searchParams.get('limit') || '150');

      // Map TF ke granularity Bitget
      const tfMap = {
        '1m': '1m', '5m': '5m', '15m': '15m',
        '1H': '1H', '4H': '4H', '1D': '1D',
      };
      const granularity = tfMap[tf] || '5m';

      try {
        const klines = await getKlines(granularity, Math.min(limit, 200));
        res.writeHead(200, {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ klines, tf, granularity }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, klines: [] }));
      }
    } else if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: { lastPrice: state.lastPrice, activePosition: state.activePosition }, stats }));
    } else if (req.url === "/api/reset" && req.method === "POST") {
      // Reset data simulasi saja — bot TIDAK otomatis restart
      stats.totalPnL    = 0;
      stats.totalTrades = 0;
      stats.wins        = 0;
      stats.losses      = 0;
      stats.winStreak   = 0;
      stats.lossStreak  = 0;
      stats.maxDrawdown = 0;
      stats.bestTrade   = 0;
      stats.worstTrade  = 0;
      state.activePosition   = null;
      state.currentBalance   = state.initialBalance;
      state.peakBalance      = state.initialBalance;
      state.balanceHistory   = [];
      smcState.lastEntryTime = 0;
      tradeLog.length        = 0;
      saveStats();
      saveState();
      broadcastSSE({ type: "stats", ...stats });
      broadcastSSE({ type: "reset", message: "Data simulasi direset — klik Start Bot untuk mulai lagi" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Data simulasi direset. Klik Start Bot untuk mulai trading." }));
      log("INFO", "Data simulasi direset via dashboard (bot masih berhenti)");
    } else if (req.url === "/api/topup" && req.method === "POST" && CONFIG.DRY_RUN) {
      // Top up saldo simulasi — hanya DRY_RUN
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const { amount } = JSON.parse(body);
          const topup = parseFloat(amount);
          if (!topup || topup <= 0 || topup > 10000) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, message: "Jumlah tidak valid (1–10000 USDT)" }));
            return;
          }
          compoundedBalance          += topup;
          state.initialBalance       += topup;
          state.currentBalance        = compoundedBalance + stats.totalPnL;
          if (state.currentBalance > (state.peakBalance || 0)) state.peakBalance = state.currentBalance;
          saveState();
          broadcastSSE({
            type:    "topup",
            amount:  topup,
            balance: state.currentBalance,
            message: `+${topup} USDT ditambahkan ke saldo simulasi`,
          });
          broadcastSSE({ type: "stats", ...stats, compoundBalance: compoundedBalance });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: `Saldo +${topup} USDT → ${state.currentBalance.toFixed(2)} USDT`, balance: state.currentBalance }));
          log("INFO", `[DRY RUN] Top up +${topup} USDT → saldo simulasi: ${state.currentBalance.toFixed(2)} USDT`);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: "Body tidak valid" }));
        }
      });
      return;
    } else if (req.url === "/api/start" && req.method === "POST") {
      // Start / restart trading loop secara manual dari dashboard
      if (state.running) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Bot sudah berjalan" }));
        return;
      }
      // Reset checkpoint loss agar hard stop tidak langsung trigger lagi
      // (data trade tetap tersimpan, hanya baseline direset ke saldo sekarang)
      if (CONFIG.DRY_RUN && state.currentBalance > 0) {
        state.initialBalance = state.currentBalance;
        state.peakBalance    = state.currentBalance;
        stats.totalPnL       = 0; // mulai hitung loss dari nol lagi
        saveStats();
        saveState();
        log("INFO", `[DRY RUN] Baseline saldo direset ke ${state.currentBalance.toFixed(2)} USDT untuk sesi baru`);
      }
      state.running = true;
      (async () => {
        while (state.running) {
          try { await tradingLoop(); } catch (err) { log("ERROR", `Loop error: ${err.message}`); }
          await new Promise(r => setTimeout(r, CONFIG.CHECK_INTERVAL_MS));
        }
      })();
      broadcastSSE({ type: "started", message: "Bot dimulai — baseline saldo direset ke saldo sekarang" });
      broadcastSSE({ type: "stats", ...stats, compoundBalance: compoundedBalance });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: `Bot dimulai. Saldo baseline: ${state.currentBalance.toFixed(2)} USDT` }));
      log("INFO", "Bot di-start manual via dashboard");
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
    const lossStreak = stats.losses > 0 && stats.wins === 0
      ? stats.losses
      : stats.currentStreak < 0
      ? Math.abs(stats.currentStreak)
      : 0;

    broadcastSSE({
      type:             "stats",
      ...stats,
      compoundBalance:  compoundedBalance,
      lossStreak,
      // Info cooldown kalau aktif
      cooldownActive:   !!(state.pausedUntil && Date.now() < state.pausedUntil),
      cooldownReason:   state.pauseReason,
      cooldownResumeAt: state.pausedUntil,
    });
  }, 30000);

  // Fast price ticker tiap 3 detik — harga real-time di dashboard
  setInterval(async () => {
    if (state.dashboardClients.length === 0) return; // skip kalau tidak ada client
    try {
      const ticker = await getTicker();
      state.lastPrice  = ticker.lastPrice;
      state.lastBidAsk = { bid: ticker.bidPrice, ask: ticker.askPrice };
      broadcastSSE({
        type:      "price",
        price:     ticker.lastPrice,
        bid:       ticker.bidPrice,
        ask:       ticker.askPrice,
        change24h: ticker.change24h,
        volume24h: ticker.volume24h,
        high24h:   ticker.high24h,
        low24h:    ticker.low24h,
        markPrice: ticker.markPrice,
        quoteVolume: ticker.quoteVolume,
      });
    } catch { /* abaikan error — trading loop tetap jalan */ }
  }, 3000);
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
