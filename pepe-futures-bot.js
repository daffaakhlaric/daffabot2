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

// ── ADAPTIVE AUTO PAIR TRADING SYSTEM ───────────────────────────
const pairSelector    = require("./pairSelector");
const btcStrategy     = require("./btcStrategy");
const { resetHypeState } = require("./hypeDetector");
const { evaluatePhase, phaseLogLine, PHASES } = require("./phaseIndicator");

// ── SUPABASE DATA LAYER ──────────────────────────────────────────
const db = require("./supabaseClient");

// ── SELF-LEARNING ENGINE ──────────────────────────────────────────
const learningEngine = require("./learningEngine");

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
  PRODUCT_TYPE:     "usdt-futures",
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

  // ── SNIPER MODE ───────────────────────────────────────────────
  // Mode 1: hanya masuk kalau semua kondisi terpenuhi
  SNIPER_MODE:        true,   // aktifkan SNIPER filter
  OPEN_CONFIDENCE:    65,     // Mode 1: AI confidence ≥ 65%
  OPEN_CONFIDENCE_MIN: 65,
  OPEN_CONFIDENCE_MAX: 75,
  CLOSE_CONFIDENCE:   55,

  // Mode 9: Market filter
  MIN_VOLUME_RATIO:   0.8,   // block entry kalau vol < 0.8x
  ENTRY_MIN_VOLUME:   1.2,   // entry hanya kalau vol ≥ 1.2x
  BLOCK_ASIA_SESSION: true,  // jangan entry saat ASIA (mode 9)

  // ATR Filter
  ATR_MIN_PERCENT:    0.15,
  ATR_LOW_THRESHOLD:  0.15,
  ATR_HIGH_THRESHOLD: 0.50,

  // Entry Quality Score (Mode 1)
  ENTRY_SCORE_MIN: 70,    // Min score ≥ 70

  // Mode 8: Daily trade limit
  MAX_TRADES_PER_DAY: 5,    // normal mode
  MAX_SNIPER_TRADES:  3,    // sniper mode

  // Hemat kredit AI: skip panggilan kalau tidak ada sinyal kuat
  CLAUDE_SMART_FILTER: false,   // SMC: Claude hanya dipanggil saat setup lengkap
  CLAUDE_RSI_DEAD_ZONE: 5,     // skip kalau RSI dalam range 50±5 (45-55) = netral

  // Dry run - ambil dari environment variable
  // Set DRY_RUN=false di .env untuk live trading
  DRY_RUN: process.env.DRY_RUN !== 'false',
  DRY_RUN_ALL_SESSIONS: process.env.DRY_RUN_ALL_SESSIONS !== 'false',

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
  PARTIAL_CLOSE_PCT:     30,    // tutup 30% posisi (Phase 7: close 30%, keep 70% running)
  PARTIAL_CLOSE_TRIGGER: 1.5,   // Phase 7: partial at 1.5% profit

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

  // ── ADAPTIVE AUTO PAIR TRADING SYSTEM ──────────────────────────
  ADAPTIVE_PAIR_ENABLED:    false,      // Disabled - force single pair
  DUAL_TRADING_MODE:        false,      // Disabled - single pair only
  DEFAULT_SYMBOL:           "BTCUSDT",  // Force BTC only for now
                                         // Jika false: switching antara BTC dan PEPE
  PAIR_SELECTION_INTERVAL:  300000,     // 5 menit - interval evaluasi ulang pair
  BTC_SPECIFIC_CONFIG: {
    STOP_LOSS_PCT:    1.5,    // Lebih konservatif untuk BTC
    TAKE_PROFIT_PCT:  3.0,
    TRAILING_OFFSET:  0.5,
    POSITION_SIZE_USDT: 15,  // Min 15 USDT: 0.001 BTC × 68k = 68 USDT notional, butuh ≥14 USDT margin @ 5x
    MIN_SL_PCT:       0.3,
    MAX_SL_PCT:       2.0,
  },
  PEPE_SPECIFIC_CONFIG: {
    STOP_LOSS_PCT:    2.5,    // SL lebih besar untuk PEPE (volatil)
    TAKE_PROFIT_PCT:  5.0,
    TRAILING_OFFSET:  0.8,
    POSITION_SIZE_USDT: 2,
    MIN_SL_PCT:       0.5,
    MAX_SL_PCT:       3.5,
  },
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
  totalAccountBalance: 0,  // Total USDT balance from all accounts
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
  
  // ── ADAPTIVE PAIR SELECTION STATE ─────────────────────────────
  currentPair:         "PEPEUSDT",  // Current trading pair
  currentPairMode:     "PEPE",       // "BTC" or "PEPE" or "DUAL"
  pairSelectionReason:  "",           // Reason for current selection
  isDualMode:          false,         // true if trading both BTC and PEPE
  btcPosition:         null,          // BTC position data
  pepePosition:        null,          // PEPE position data
  lastBtcPrice:        0,             // Last BTC price for dual mode
  lastPepePrice:       0,             // Last PEPE price for dual mode
  lastPairSelection:    0,            // Timestamp of last selection
  pairAnalysis:         null,         // Latest pair analysis data
  btcAnalysis:          null,         // Latest BTC strategy analysis

  // Mode 8: Daily trade limit
  dailyTradeCount:      0,            // trades opened today
  dailyTradeDate:       '',           // YYYY-MM-DD of current day
  sniperModeActive:     true,         // SNIPER mode flag

  // Mode 5: Scale-in tracking
  scaleInDone:          false,        // whether we've scaled in this trade

  // Mode 7: capital growth factor (applied to next position)
  capitalGrowthFactor:  1.0,          // multiplier for next position (1.0 = normal)

  // Phase Indicator
  phase:                null,         // Current phase result from phaseIndicator
  phaseCooldownLeft:    0,            // MARKET_BAD: remaining cooldown trades

  // Market Regime Detection
  lastRegime:          null,         // "TREND" or "RANGE"
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
// DRY RUN ADAPTIVE RISK
// In DRY_RUN mode loss streaks never pause trading — instead they
// scale down position size and raise the confidence bar so the bot
// keeps scanning and learning while behaving more defensively.
// ─────────────────────────────────────────────────────────────

/**
 * Returns risk scaling for DRY_RUN loss-streak protection.
 * Called from the entry check block; has NO effect in LIVE mode.
 * @param {number} streak - consecutive loss count
 * @returns {{ riskMultiplier: number, confidenceBoost: number, label: string }}
 */
function getAdaptiveRisk(streak) {
  // RULE 1: After 2 consecutive losses - reduce by 50%, require higher confidence
  if (streak >= 5) return { 
    riskMultiplier: 0.30, 
    confidenceBoost: 25, 
    minConfidence: 75,  // NEW: Minimum confidence required
    minOrderbookScore: 3,  // NEW: Orderbook must be strong
    testTrade: true,  // NEW: Only allow test trade
    label: "⚠️ STREAK≥5 — ultra-defensive + TEST TRADE ONLY" 
  };
  if (streak >= 4) return { 
    riskMultiplier: 0.40, 
    confidenceBoost: 20, 
    minConfidence: 70,
    minOrderbookScore: 3,
    testTrade: true,
    label: "🔴 STREAK≥4 — defensive + TEST TRADE ONLY" 
  };
  // RULE 2: After 3 consecutive losses - STOP for 1 hour + MARKET_BAD phase
  if (streak >= 3) return { 
    riskMultiplier: 0.50, 
    confidenceBoost: 15, 
    minConfidence: 68,
    minOrderbookScore: 2,
    forceCooldown: true,  // NEW: Force cooldown
    label: "🟠 STREAK≥3 — COOLDOWN 1H + MARKET_BAD" 
  };
  // RULE 1: After 2 consecutive losses
  if (streak >= 2) return { 
    riskMultiplier: 0.50,  // 50% size reduction
    confidenceBoost: 10, 
    minConfidence: 65,  // Higher than normal
    minOrderbookScore: 2,
    label: "🟡 STREAK≥2 — 50% size + conf≥65" 
  };
  return { 
    riskMultiplier: 1.00, 
    confidenceBoost: 0, 
    minConfidence: 55,
    minOrderbookScore: 0,
    label: "🟢 NORMAL" 
  };
}

/** Anti-Loss Streak SMART FILTER */
function checkLossStreakFilters(stats, orderBook, choch, volumeRatio) {
  const streak = stats.lossStreak || 0;
  const adaptive = getAdaptiveRisk(streak);
  
  // If no loss streak, allow all
  if (streak < 2) {
    return { allowed: true, reason: "Normal trading" };
  }
  
  // Check orderbook score (require ≥ 2 during loss streak)
  let orderbookScore = 0;
  if (orderBook) {
    if (orderBook.bidAskRatio > 1.5) orderbookScore += 1;
    if (orderBook.spread < 0.02) orderbookScore += 1;
    if (orderBook.totalBid > orderBook.totalAsk * 2) orderbookScore += 1;
  }
  
  // Check SMC confirmation
  const smcConfirmed = choch?.detected || false;
  
  // Check volume spike
  const volumeSpike = volumeRatio > 1.5;
  
  const reasons = [];
  if (orderbookScore < adaptive.minOrderbookScore) {
    reasons.push(`OB=${orderbookScore}<${adaptive.minOrderbookScore}`);
  }
  if (!smcConfirmed) {
    reasons.push("SMC=❌");
  }
  if (!volumeSpike) {
    reasons.push(`VOL=${volumeRatio.toFixed(1)}<1.5`);
  }
  
  if (reasons.length > 0) {
    log("LOSS PROTECTION", `[LOSS PROTECTION] Streak=${streak} → SKIP: ${reasons.join(", ")}`);
    return { allowed: false, reason: reasons.join(", "), orderbookScore, smcConfirmed, volumeSpike };
  }
  
  log("LOSS PROTECTION", `[LOSS PROTECTION] Streak=${streak} → PASS (OB=${orderbookScore} SMC=✅ VOL=${volumeSpike})`);
  return { allowed: true, reason: "All filters passed", orderbookScore, smcConfirmed, volumeSpike };
}

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
  try {
    const res = await bitgetRequest("GET", "/api/v2/mix/market/merge-depth", {
      symbol:      CONFIG.SYMBOL,
      productType: CONFIG.PRODUCT_TYPE,
    });
    if (res.code !== "00000") {
      log("WARN", `Order book error: ${res.msg} - using fallback`);
      return null;  // Return null instead of throwing
    }
    const bids = res.data.bids.slice(0, 5).map((b) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
    const asks = res.data.asks.slice(0, 5).map((a) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
    const totalBid = bids.reduce((s, b) => s + b.qty, 0);
    const totalAsk = asks.reduce((s, a) => s + a.qty, 0);
    
    // STEP 1: Get best bid/ask for spread calculation
    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const spread = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
    
    return { 
      bids, asks, totalBid, totalAsk, 
      bidAskRatio: totalBid / (totalAsk || 1),
      bestBid, bestAsk, spread  // Added for maker order optimization
    };
  } catch (err) {
    log("WARN", `Order book fetch failed: ${err.message}`);
    return null;
  }
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

/**
 * Get ALL USDT-M futures account balance
 * Endpoint: /api/v2/mix/account/accounts (all futures balances)
 */
async function getAllAccountBalances() {
  try {
    // Method 1: Get all futures accounts
    const res = await bitgetRequest("GET", "/api/v2/mix/account/accounts", {
      productType: "usdt-futures"
    });
    if (res.code !== "00000") throw new Error(res.msg || "Unknown error");
    
    log("DEBUG", `All accounts response: ${JSON.stringify(res.data?.slice(0, 3))}`);
    
    // Find USDT balance in futures - try different field names
    let usdtData = res.data?.find((c) => c.currency === "USDT");
    if (!usdtData) usdtData = res.data?.find((c) => c.coin === "USDT");
    if (!usdtData) usdtData = res.data?.[0]; // Take first available
    
    if (!usdtData) {
      log("WARN", `No USDT data found in accounts response`);
      return { totalBalance: 0, available: 0 };
    }
    
    const available = parseFloat(usdtData.available || usdtData.availableBalance || "0");
    const frozen = parseFloat(usdtData.frozen || usdtData.frozenBalance || "0");
    const totalBalance = available + frozen;
    
    log("INFO", `💰 Total futures balance: ${totalBalance.toFixed(4)} USDT (avail: ${available.toFixed(4)}, frozen: ${frozen.toFixed(4)})`);
    
    return { totalBalance, available };
  } catch (err) {
    log("WARN", `Gagal get all balances: ${err.message}`);
    return { totalBalance: 0, available: 0 };
  }
}

/**
 * Calculate auto position size based on account balance (LIVE mode only)
 * Balance  <$60  → $4
 * Balance  ~$80  → $5  
 * Balance  ~$100 → $6-7
 * Balance  ~$150 → $8-10
 */
function calculateAutoPositionSize(balance) {
  if (balance < 60) return 4;
  if (balance < 80) return 5;
  if (balance < 100) return 6;
  if (balance < 150) return 8;
  return Math.min(10, Math.floor(balance * 0.07)); // Max 10% of balance
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
  try {
    await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {}, {
      symbol:      CONFIG.SYMBOL,
      productType: CONFIG.PRODUCT_TYPE,
      marginCoin:  CONFIG.MARGIN_COIN,
      leverage:    leverage.toString(),
    });
    log("INFO", `✅ Set leverage ${leverage}x for ${CONFIG.SYMBOL}`);
  } catch (err) {
    log("WARN", `⚠️ Set leverage failed: ${err.message} - continuing anyway`);
  }
}

async function setMarginMode() {
  if (CONFIG.DRY_RUN) {
    log("INFO", `[DRY] Set margin mode: ${CONFIG.MARGIN_MODE}`);
    return;
  }
  try {
    await bitgetRequest("POST", "/api/v2/mix/account/set-margin-mode", {}, {
      symbol:      CONFIG.SYMBOL,
      productType: CONFIG.PRODUCT_TYPE,
      marginCoin:  CONFIG.MARGIN_COIN,
      marginMode:  CONFIG.MARGIN_MODE,
    });
    log("INFO", `✅ Set margin mode ${CONFIG.MARGIN_MODE} for ${CONFIG.SYMBOL}`);
  } catch (err) {
    log("WARN", `⚠️ Set margin mode failed: ${err.message} - continuing anyway`);
  }
}

// ─────────────────────────────────────────────────────────────
// EKSEKUSI ORDER
// ─────────────────────────────────────────────────────────────

/**
 * Hitung jumlah kontrak dari USDT
 * Bitget PEPE contract: 1 kontrak = 1000 PEPE
 * Bitget BTC contract: 1 kontrak = 1 USDT (for USDT-M)
 */
function calcOrderSize(price, leverage) {
  // Detect symbol and use appropriate contract size
  const isPepe = (CONFIG.SYMBOL || "PEPEUSDT").includes("PEPE");
  
  // PEPE: 1 kontrak = 1000 PEPE, minimum 1 kontrak
  // BTC: 1 kontrak = 1 USDT (for USDT-M perpetual)
  const CONTRACT_SIZE = isPepe ? 1000 : 1;
  const MIN_QTY = isPepe ? 1000 : 5;  // BTC minimum ~5 USDT
  
  const phaseMultiplier2  = state.phase?.riskMultiplier ?? 1.0;
  const dryRunMultiplier2 = CONFIG.DRY_RUN ? (getAdaptiveRisk(stats.lossStreak || 0).riskMultiplier) : 1.0;
  const riskMultiplier    = phaseMultiplier2 * dryRunMultiplier2;
  const notional          = CONFIG.POSITION_SIZE_USDT * riskMultiplier * leverage;
  const qty       = notional / price;
  const contracts = Math.max(1, Math.floor(qty / CONTRACT_SIZE));
  const finalQty  = contracts * CONTRACT_SIZE;
  log("INFO", `Kalkulasi order: ${isPepe ? 'PEPE' : 'BTC'} | notional=${notional.toFixed(2)} USDT | qty=${qty.toFixed(4)} | contracts=${contracts} | final=${finalQty}`);
  return finalQty;
}

/**
 * Risk-based order sizing — posisi dihitung agar jika SL kena,
 * loss = POSITION_SIZE_USDT (modal isolated yang diinput).
 * qty × price × slPct% = riskUsdt
 */
function calcOrderSizeByRisk(price, slPct) {
  const isPepe = (CONFIG.SYMBOL || "PEPEUSDT").includes("PEPE");
  const CONTRACT_SIZE = isPepe ? 1000 : 1;
  // Phase multiplier (both modes) × DRY_RUN adaptive multiplier on loss streak
  const phaseMultiplier    = state.phase?.riskMultiplier ?? 1.0;
  const dryRunMultiplier   = CONFIG.DRY_RUN ? (getAdaptiveRisk(stats.lossStreak || 0).riskMultiplier) : 1.0;
  const riskMultiplier     = phaseMultiplier * dryRunMultiplier;
  const riskUsdt           = CONFIG.POSITION_SIZE_USDT * riskMultiplier;
  const rawQty         = riskUsdt / (price * slPct / 100);
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

/**
 * ═══════════════════════════════════════════════════════════════
 * ADAPTIVE POSITION SIZING & DYNAMIC LEVERAGE SYSTEM
 * ═══════════════════════════════════════════════════════════════
 */
function calcDynamicPositionSize(balance, phase, confidence, lossStreak) {
  // STEP 1: BASE NOTIONAL FROM BALANCE
  let baseNotional;
  if (balance <= 60) baseNotional = 4;
  else if (balance <= 80) baseNotional = 5;
  else if (balance <= 100) baseNotional = 6.5;
  else if (balance <= 150) baseNotional = 9;
  else baseNotional = balance * 0.06;

  // STEP 2: PHASE MULTIPLIER
  let phaseMultiplier;
  switch (phase) {
    case 'TRAINING': phaseMultiplier = 0.7; break;
    case 'STABLE': phaseMultiplier = 1.0; break;
    case 'PROFIT': phaseMultiplier = 1.3; break;
    case 'MARKET_BAD': phaseMultiplier = 0.5; break;
    default: phaseMultiplier = 1.0;
  }

  // STEP 3: CONFIDENCE MULTIPLIER
  let confidenceMultiplier;
  if (confidence < 50) confidenceMultiplier = 0.6;
  else if (confidence <= 70) confidenceMultiplier = 1.0;
  else confidenceMultiplier = 1.2;

  // STEP 4: CALCULATE FINAL NOTIONAL
  let notional = baseNotional * phaseMultiplier * confidenceMultiplier;

  // STEP 5: SAFETY CAP (MANDATORY)
  if (notional > balance * 0.15) {
    notional = balance * 0.15;
  }
  if (notional < 2) {
    notional = 2;
  }

  // STEP 6: DYNAMIC LEVERAGE SYSTEM
  let leverage = 5; // default
  
  // Base leverage by phase
  switch (phase) {
    case 'MARKET_BAD': leverage = 3; break;
    case 'TRAINING': leverage = 4; break;
    case 'STABLE': leverage = 5; break;
    case 'PROFIT': leverage = 6; break;
    default: leverage = 5;
  }

  // STEP 7: CONFIDENCE ADJUSTMENT (LEVERAGE)
  if (confidence < 50) leverage -= 1;
  if (confidence > 75) leverage += 1;

  // Clamp leverage
  if (leverage < 2) leverage = 2;
  if (leverage > 7) leverage = 7;

  // STEP 8: LOSS STREAK PROTECTION
  if (lossStreak >= 2) {
    notional *= 0.7;
    leverage -= 1;
  }
  if (lossStreak >= 3) {
    notional *= 0.5;
    leverage = 2;
  }

  // Final clamp
  if (leverage < 2) leverage = 2;
  if (leverage > 7) leverage = 7;

  // Determine risk level
  let riskLevel = 'MEDIUM';
  if (leverage <= 3 || phase === 'MARKET_BAD') riskLevel = 'LOW';
  else if (leverage >= 6 && phase === 'PROFIT') riskLevel = 'HIGH';

  // Logging
  log("INFO",
    `[POSITION] Balance=${balance.toFixed(2)} | Phase=${phase} | Confidence=${confidence}\n` +
    `  Base=${baseNotional.toFixed(2)} | Phase×${phaseMultiplier} | Conf×${confidenceMultiplier} | Final=${notional.toFixed(2)}\n` +
    `  Leverage=${leverage}x | Risk=${riskLevel}`
  );

  return {
    notional: parseFloat(notional.toFixed(2)),
    leverage,
    risk_level: riskLevel,
    reason: `Phase=${phase} Conf=${confidence} Streak=${lossStreak}`
  };
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

async function openPosition(side, leverage, price, overrideQty = null, symbol = null, indicators = null, orderBook = null) {
  const tradeSymbol = symbol || CONFIG.SYMBOL;
  const isPepe = tradeSymbol === "PEPEUSDT";
  const config = isPepe ? CONFIG.PEPE_SPECIFIC_CONFIG : CONFIG.BTC_SPECIFIC_CONFIG;
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 2: SPREAD FILTER
  // ═══════════════════════════════════════════════════════════════
  const MAX_SPREAD = 0.03;  // 0.03% max spread for BTC
  if (orderBook && orderBook.spread !== undefined) {
    log("SPREAD", `[SPREAD] ${orderBook.spread.toFixed(4)}% | Bid=${orderBook.bestBid?.toFixed(2)} Ask=${orderBook.bestAsk?.toFixed(2)}`);
    if (orderBook.spread > MAX_SPREAD) {
      log("FILTER", `[SPREAD FILTER] Spread ${orderBook.spread.toFixed(4)}% > MAX ${MAX_SPREAD}% → SKIP TRADE`);
      return null;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 7: PRICE VALIDATION & MAKER ORDER PRICING
  // ═══════════════════════════════════════════════════════════════
  let orderPrice = price;
  let useLimitOrder = false;
  let orderType = "market";
  
  if (orderBook && orderBook.bestBid && orderBook.bestAsk) {
    // STEP 3: Use maker pricing for better fees
    if (side === "LONG") {
      // For LONG: place at bestBid (maker) to get better price
      orderPrice = orderBook.bestBid;
      // STEP 7: Ensure entry not above bestAsk
      if (price > orderBook.bestAsk) {
        orderPrice = orderBook.bestAsk * 0.9999;  // Slightly below ask
      }
    } else {
      // For SHORT: place at bestAsk (maker) to get better price
      orderPrice = orderBook.bestAsk;
      // STEP 7: Ensure entry not below bestBid
      if (price < orderBook.bestBid) {
        orderPrice = orderBook.bestBid * 1.0001;  // Slightly above bid
      }
    }
    useLimitOrder = true;
    orderType = "limit";
    
    // STEP 6: Slippage control
    const priceDeviation = Math.abs(price - orderPrice) / price * 100;
    const MAX_SLIPPAGE = 0.05;  // 0.05% max slippage
    if (priceDeviation > MAX_SLIPPAGE) {
      log("FILTER", `[SLIPPAGE] Price deviation ${priceDeviation.toFixed(4)}% > MAX ${MAX_SLIPPAGE}% → SKIP`);
      return null;
    }
    log("SLIPPAGE", `[SLIPPAGE] ${priceDeviation.toFixed(4)}% OK`);
  }
  
  // Log untuk debugging
  log("INFO", `📊 Order: Symbol=${tradeSymbol} isPepe=${isPepe} Price=${price} Lev=${leverage}`);
  
  const qty = overrideQty || calcOrderSize(price, leverage);
  const liqPrice = calcLiquidationPrice(side, orderPrice, leverage);
  const stopLoss = side === "LONG"
    ? orderPrice * (1 - config.STOP_LOSS_PCT / 100)
    : orderPrice * (1 + config.STOP_LOSS_PCT / 100);
  const takeProfit = side === "LONG"
    ? orderPrice * (1 + config.TAKE_PROFIT_PCT / 100)
    : orderPrice * (1 - config.TAKE_PROFIT_PCT / 100);

  log("TRADE", `${C.bold}BUKA ${side} ${tradeSymbol}${C.reset} | Harga: ${orderPrice.toFixed(8)} | Qty: ${qty} | Leverage: ${leverage}x`);
  log("TRADE", `  Stop Loss  : ${stopLoss.toFixed(8)} (${config.STOP_LOSS_PCT}%)`);
  log("TRADE", `  Take Profit: ${takeProfit.toFixed(8)} (${config.TAKE_PROFIT_PCT}%)`);
  log("TRADE", `  ${C.red}Liquidation: ${liqPrice.toFixed(8)}${C.reset} ← JANGAN BIARKAN SAMPAI SINI!`);

  if (CONFIG.DRY_RUN) {
    log("INFO", `[DRY RUN] Simulasi order ${side} ${tradeSymbol} berhasil`);
  } else {
    await setLeverage(leverage, tradeSymbol);
    const orderSide = side === "LONG" ? "buy" : "sell";
    
    // ═══════════════════════════════════════════════════════════════
    // STEP 4: POST-ONLY MODE & STEP 5: FALLBACK TO MARKET
    // ═══════════════════════════════════════════════════════════════
    let res = null;
    let orderMode = "MARKET";
    
    if (useLimitOrder) {
      // STEP 4: Try limit order with postOnly
      const limitOrderParams = {
        symbol:      tradeSymbol,
        productType: CONFIG.PRODUCT_TYPE,
        marginMode:  CONFIG.MARGIN_MODE,
        marginCoin:  CONFIG.MARGIN_COIN,
        size:        qty.toString(),
        side:        orderSide,
        tradeSide:   "open",
        orderType:   "limit",
        price:       orderPrice.toString(),
        // postOnly: true  // Bitget doesn't have explicit postOnly, use timeInForce
        timeInForce: "postOnly",  // GTC by default, try IOC for immediate
      };
      
      log("ORDER", `[ORDER MODE] Maker LIMIT placed at ${orderPrice.toFixed(2)}`);
      
      // Try limit order first
      try {
        res = await bitgetRequest("POST", "/api/v2/mix/order/place-order", {}, limitOrderParams);
        
        if (res.code === "00000") {
          orderMode = "LIMIT";
          // Wait for fill with timeout
          const maxWait = 8000;  // 8 seconds
          const checkInterval = 1000;
          let waited = 0;
          let filled = false;
          
          while (waited < maxWait) {
            await new Promise(r => setTimeout(r, checkInterval));
            waited += checkInterval;
            
            // Check order status
            try {
              const orderRes = await bitgetRequest("GET", "/api/v2/mix/order/detail", { orderId: res.data?.orderId });
              if (orderRes.data?.status === "filled" || orderRes.data?.status === "partial_fill") {
                filled = true;
                log("ORDER", `✅ LIMIT order filled! OrderId: ${res.data.orderId}`);
                break;
              } else if (orderRes.data?.status === "canceled" || orderRes.data?.status === "expired") {
                log("ORDER", `⚠️ LIMIT order not filled, status: ${orderRes.data?.status}`);
                break;
              }
            } catch (e) {
              // Continue waiting
            }
          }
          
          // STEP 5: Fallback to market if not filled and confidence > 70
          if (!filled) {
            const conf = indicators?.confidence || 60;
            if (conf > 70) {
              log("ORDER", `⚠️ LIMIT not filled, confidence ${conf}% > 70 → Falling back to MARKET`);
              // Cancel limit order and place market
              try {
                await bitgetRequest("POST", "/api/v2/mix/order/cancel-order", {}, { 
                  symbol: tradeSymbol, orderId: res.data?.orderId 
                });
              } catch (e) {}
              
              orderType = "market";
              orderMode = "MARKET_FALLBACK";
            } else {
              log("FILTER", `[ORDER] Confidence ${conf}% <= 70 → Skip (no fallback)`);
              return null;
            }
          }
        }
      } catch (limitErr) {
        log("WARN", `LIMIT order failed: ${limitErr.message} → Using market`);
        orderType = "market";
      }
    }
    
    // Place final order (market or fallback)
    if (orderType === "market" || orderMode === "MARKET_FALLBACK") {
      const orderParams = {
        symbol:      tradeSymbol,
        productType: CONFIG.PRODUCT_TYPE,
        marginMode:  CONFIG.MARGIN_MODE,
        marginCoin:  CONFIG.MARGIN_COIN,
        size:        qty.toString(),
        side:        orderSide,
        tradeSide:   "open",
        orderType:   "market",
        leverage:    leverage.toString(),
      };
      res = await bitgetRequest("POST", "/api/v2/mix/order/place-order", {}, orderParams);
    }
    
    if (res.code !== "00000") {
      log("ERROR", `Gagal buka order: ${res.msg} | Symbol: ${tradeSymbol} | Qty: ${qty} | Lev: ${leverage}x`);
      // Check if there's a conflicting position
      try {
        const pos = await getActivePosition();
        if (pos) {
          log("WARN", `⚠️ Ada posisi terbuka: ${pos.symbol} ${pos.side} ${pos.size} | Tutup dulu sebelum trading lain!`);
        }
      } catch (e) {}
      return null;
    }
    log("TRADE", `Order sukses! Order ID: ${res.data?.orderId}`);
  }

  // Update state - use btcPosition or pepePosition for dual mode
  // Get regime from state (set during entry)
  const positionRegime = state.lastRegime || "TREND";
  
  // PEPE: qty = jumlah token, notional = qty × price (benar)
  // BTC:  qty = contracts (pakai CONTRACT_SIZE=1000 konvensi PEPE → salah untuk BTC)
  //       Hitung notional dari risk budget: POSITION_SIZE × phaseMultiplier × dryRunMultiplier × leverage
  let notionalUSDT;
  if (isPepe) {
    notionalUSDT = parseFloat((qty * price).toFixed(4));
  } else {
    const phaseMultiplierN  = state.phase?.riskMultiplier ?? 1.0;
    const dryRunMultiplierN = CONFIG.DRY_RUN ? getAdaptiveRisk(stats.lossStreak || 0).riskMultiplier : 1.0;
    notionalUSDT = parseFloat((CONFIG.POSITION_SIZE_USDT * phaseMultiplierN * dryRunMultiplierN).toFixed(4));
  }

  const position = {
    side,
    symbol: tradeSymbol,
    entryPrice:   price,
    size:         qty,
    leverage,
    notionalUSDT,          // nilai posisi dalam USDT (qty × harga)
    stopLoss,
    takeProfit,
    liqPrice,
    trailingHigh: price,
    trailingLow:  price,
    trailingTP:   takeProfit,
    tpTrailPct:   config.TAKE_PROFIT_PCT * 0.5,
    breakevenSet: false,
    runnerActivated: false,  // Fee-aware: disable runner until profit > 0.4%
    lockLevel:    undefined,
    momentumWeakCount: 0,
    openTime:     new Date().toISOString(),
    regime:       positionRegime,
    // AI Trading Risk Manager indicators
    rsi: indicators ? indicators.rsi : 50,
    ema9: indicators ? indicators.ema9 : price,
    ema21: indicators ? indicators.ema21 : price,
    volumeRatio: indicators ? indicators.volumeRatio : 1,
    // ── Supabase entry snapshot (prefixed _) ─────────────────────
    _entryAtrPct:       indicators?._atrPct        ?? null,
    _entryBbPctB:       indicators?.bb?.pctB        ?? null,
    _entryBbBandwidth:  indicators?.bb?.bandwidth   ?? null,
    _entryBbPosition:   indicators?.bb?.position    ?? null,
    _entryVwapPct:      indicators?._vwapPct        ?? null,
    _entrySqueeze:      indicators?._squeeze        ?? null,
    _entrySession:      indicators?._session        ?? null,
    _entryFundingRate:  indicators?._fundingRate    ?? null,
    _entryFearGreed:    indicators?._fearGreed      ?? null,
    _entryObBidAsk:     orderBook?.bidAskRatio      ?? null,
    _entryObSpread:     orderBook?.spread           ?? null,
    _smcData:           null,   // set after openPosition returns
    _claudeFilter:      null,   // set after openPosition returns
  };

  log("INFO", `📊 Position opened in ${positionRegime} mode | Notional: ${notionalUSDT.toFixed(2)} USDT (${qty.toLocaleString()} × ${price})`);

  if (state.isDualMode) {
    if (isPepe) {
      state.pepePosition = position;
      log("INFO", `📊 PEPE position opened: ${side} @ ${price}`);
    } else {
      state.btcPosition = position;
    }
  }
  state.activePosition = position;

  saveState();
  recordTrade("OPEN", side, price, qty, leverage, liqPrice, "", 0, notionalUSDT);
  return state.activePosition;
}

async function closePosition(reason, currentPrice, symbol = null) {
  const tradeSymbol = symbol || (state.activePosition?.symbol) || CONFIG.SYMBOL;
  const isPepe = tradeSymbol === "PEPEUSDT";
  
  // Get the right position based on symbol
  let pos = state.activePosition;
  if (state.isDualMode) {
    if (isPepe && state.pepePosition) {
      pos = state.pepePosition;
    } else if (!isPepe && state.btcPosition) {
      pos = state.btcPosition;
    }
  }
  
  if (!pos) return;

  const pnlPct = pos.side === "LONG"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
  const pnlUSDT = (CONFIG.POSITION_SIZE_USDT * pnlPct) / 100;

  log("TRADE", `${C.bold}TUTUP ${pos.side} ${tradeSymbol}${C.reset} | Alasan: ${reason}`);
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
  if (pnlPct >= 0) {
    stats.wins++;
    stats.winStreak  = (stats.winStreak  || 0) + 1;
    stats.lossStreak = 0;
  } else {
    stats.losses++;
    stats.lossStreak = (stats.lossStreak || 0) + 1;
    stats.winStreak  = 0;
  }
  if (stats.totalPnL < stats.maxDrawdown) stats.maxDrawdown = stats.totalPnL;

  // BUG #4 FIX: update currentBalance setiap posisi ditutup
  state.currentBalance = state.initialBalance + stats.totalPnL;

  updateCompoundBalance(pnlUSDT);
  updateWinRateTracker(pnlUSDT, pnlPct);
  autoAdjustStrategy();

  // ── MODE 7: Capital Growth Loop ───────────────────────────────
  // After a WIN: grow factor slightly → bigger next position
  // After a LOSS: shrink factor → smaller next position
  if (pnlUSDT > 0) {
    state.capitalGrowthFactor = Math.min((state.capitalGrowthFactor || 1.0) * 1.05, 1.5);
    log("INFO", `[MODE 7] WIN → capitalGrowthFactor: ${state.capitalGrowthFactor.toFixed(3)} (next pos slightly larger)`);
  } else if (pnlUSDT < 0) {
    state.capitalGrowthFactor = Math.max((state.capitalGrowthFactor || 1.0) * 0.90, 0.6);
    log("INFO", `[MODE 7] LOSS → capitalGrowthFactor: ${state.capitalGrowthFactor.toFixed(3)} (next pos reduced)`);
  }
  state.scaleInDone = false; // reset for next trade

  recordTrade("CLOSE", pos.side, currentPrice, pos.size, pos.leverage, pos.liqPrice, reason, pnlUSDT, pos.notionalUSDT ?? null);

  // ── SUPABASE: save closed trade (non-blocking) ───────────────
  const _closeTime = new Date().toISOString();
  db.saveTrade({
    symbol:          tradeSymbol,
    side:            pos.side,
    pairMode:        state.currentPairMode,
    regime:          pos.regime,
    entryPrice:      pos.entryPrice,
    exitPrice:       currentPrice,
    size:            pos.size,
    leverage:        pos.leverage,
    notionalUSDT:    pos.notionalUSDT,
    openTime:        pos.openTime,
    closeTime:       _closeTime,
    pnlPct:          pnlPct,
    pnlUSDT:         pnlUSDT,
    reason:          reason,
    breakevenSet:    pos.breakevenSet,
    runnerActivated: pos.runnerActivated,
    partialClosed:   pos.partialClosed,
    lockLevel:       pos.lockLevel,
    wasProfit:       pos._wasProfit,
    entryScore:      pos._entryScore,
    entryMode:       pos._entryMode,
    session:         pos._entrySession,
    entryIndicators: {
      rsi:           pos.rsi,
      ema9:          pos.ema9,
      ema21:         pos.ema21,
      volumeRatio:   pos.volumeRatio,
      atrPct:        pos._entryAtrPct,
      bbPctB:        pos._entryBbPctB,
      bbBandwidth:   pos._entryBbBandwidth,
      bbPosition:    pos._entryBbPosition,
      vwapPct:       pos._entryVwapPct,
      squeeze:       pos._entrySqueeze,
      session:       pos._entrySession,
      fundingRate:   pos._entryFundingRate,
      fearGreed:     pos._entryFearGreed,
      orderbookBidAskRatio: pos._entryObBidAsk,
      orderbookSpread:      pos._entryObSpread,
    },
    exitIndicators: {
      rsi:         state.lastRSI,
      ema9:        state.lastEMA9,
      ema21:       state.lastEMA21,
      volumeRatio: state.lastVolumeRatio,
      momentum:    pos.runnerActivated ? "STRONG" : undefined,
    },
    smcData:       pos._smcData,
    claudeFilter:  pos._claudeFilter,
    phase:         state.phase,
    stats:         stats,
    dryRun:        CONFIG.DRY_RUN,
  }).catch(() => {});

  // ── SUPABASE: update rolling stats (non-blocking) ────────────
  db.updateStats({
    stats,
    state,
    tradeLog,
    dryRun:        CONFIG.DRY_RUN,
    lastTradeTime: _closeTime,
    uptimeSec:     Math.round((Date.now() - new Date(stats.startTime).getTime()) / 1000),
  }).catch(() => {});

  // ── PHASE INDICATOR — re-evaluate after every close ──────────
  const newPhase = evaluatePhase(tradeLog, stats);
  const prevPhase = state.phase?.phase;
  state.phase = newPhase;
  
  // DRY_RUN: Skip cooldown, keep phase visible but non-blocking
  if (CONFIG.DRY_RUN) {
    state.phaseCooldownLeft = 0;
    if (newPhase.phase === PHASES.MARKET_BAD) {
      log("WARN", `[PHASE] MARKET_BAD detected — DRY_RUN: NO cooldown (trades continue)`);
    }
  } else {
    // LIVE: Normal cooldown behavior
    if (newPhase.phase === PHASES.MARKET_BAD && prevPhase !== PHASES.MARKET_BAD) {
      state.phaseCooldownLeft = newPhase.cooldownTrades;
      log("WARN", `[PHASE] Entered MARKET_BAD — ${newPhase.cooldownTrades} cooldown trades before new entries`);
    } else if (newPhase.phase === PHASES.MARKET_BAD && state.phaseCooldownLeft > 0) {
      state.phaseCooldownLeft--;
      log("WARN", `[PHASE] MARKET_BAD cooldown: ${state.phaseCooldownLeft} trade(s) left`);
    } else if (newPhase.phase !== PHASES.MARKET_BAD) {
      state.phaseCooldownLeft = 0;
    }
  }
  
  log("INFO", phaseLogLine(newPhase));
  broadcastSSE({ type: "phase", phase: newPhase, dryRun: CONFIG.DRY_RUN });

  // ── Post-SL Cooldown ─────────────────────────────────────────
  // DRY_RUN: NEVER pause — use adaptive risk scaling instead (getAdaptiveRisk).
  // LIVE:    tiered cooldown + emergency stop still active.
  if (reason === "STOP_LOSS" || reason === "FORCE_CLOSE_MAX_LOSS" || reason.includes("HARD_STOP")) {
    const lossStreak = stats.lossStreak || 0;

    // Step 5 — mode log
    log("INFO",
      `[MODE=${CONFIG.DRY_RUN ? "DRY_RUN" : "LIVE"}] ` +
      `LossStreak=${lossStreak} | CooldownDisabled=${CONFIG.DRY_RUN}`
    );

    if (CONFIG.DRY_RUN) {
      // DRY_RUN: no pause — log adaptive behavior that will apply at next entry
      const adaptive = getAdaptiveRisk(lossStreak);
      log("WARN",
        `[DRY_RUN] SL #${lossStreak} — NO cooldown. ` +
        `Next entry: risk×${adaptive.riskMultiplier} conf+${adaptive.confidenceBoost} | ${adaptive.label}`
      );
      broadcastSSE({
        type:        "sl_cooldown",
        lossStreak,
        cooldownMs:  0,
        dryRun:      true,
        message:     `DRY_RUN: no cooldown — adaptive risk active (${adaptive.label})`,
        adaptive,
      });
    } else {
      // RULE 2: After 3 consecutive losses - STOP for 1 hour + MARKET_BAD phase
      // LIVE: tiered cooldown
      const cooldownMs =
        lossStreak >= 5 ? 180 * 60 * 1000 :  // 3 jam kalau loss 5+
        lossStreak >= 4 ? 120 * 60 * 1000 :  // 2 jam kalau loss 4
        lossStreak >= 3 ? 60  * 60 * 1000 :  // 1 jam kalau loss 3 (RULE 2)
                          0;

      if (cooldownMs > 0) {
        // Switch to MARKET_BAD phase during cooldown
        if (lossStreak >= 3) {
          state.phase = { phase: "MARKET_BAD", reason: `Loss streak ${lossStreak}x` };
          log("LOSS PROTECTION", `[LOSS PROTECTION] LossStreak=${lossStreak} → COOLDOWN ${cooldownMs/60000}H + MARKET_BAD phase`);
        }
        
        state.pausedUntil = Date.now() + cooldownMs;
        state.pauseReason =
          `Loss streak ${lossStreak}x — cooldown ${Math.round(cooldownMs / 60000)} menit`;
        log("WARN",
          `⏸ [LOSS PROTECTION] Cooldown ${Math.round(cooldownMs / 60000)} menit setelah loss ke-${lossStreak} — cegah revenge trading`
        );
        broadcastSSE({
          type:      "sl_cooldown",
          lossStreak,
          cooldownMs,
          resumeAt:  state.pausedUntil,
          message:   state.pauseReason,
          marketBad: lossStreak >= 3,
        });
      }

      // Emergency pause — LIVE only (no pause in DRY_RUN)
      if (!CONFIG.DRY_RUN && lossStreak >= 5) {
        log("ERROR",
          `🛑 EMERGENCY PAUSE! Loss streak ${lossStreak}x berturut — pause 2 jam. Buka dashboard untuk review.`
        );
        broadcastSSE({
          type:      "emergency_stop",
          lossStreak,
          dryRun:    false,
          message:   `Loss streak ${lossStreak}x — pause 2 jam otomatis`,
          resumeAt:  new Date(state.pausedUntil).toLocaleTimeString("id-ID"),
        });
      } else if (CONFIG.DRY_RUN && lossStreak >= 5) {
        // DRY_RUN: Log info only, no pause
        log("WARN",
          `[DRY_RUN] Loss streak ${lossStreak}x — NO emergency pause (cooldown disabled)`
        );
        broadcastSSE({
          type:      "emergency_stop",
          lossStreak,
          dryRun:    true,
          message:   `[DRY_RUN] Loss streak ${lossStreak}x — no pause (adaptive risk active)`,
        });
      }
    }

    // Always record last SL price to avoid immediate re-entry at same level
    smcState.lastSLPrice = currentPrice;
  }

  // Clear position - handle dual mode
  if (state.isDualMode && pos) {
    if (pos.symbol === "PEPEUSDT") {
      state.pepePosition = null;
    } else {
      state.btcPosition = null;
    }
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
      // marginMode:  CONFIG.MARGIN_MODE,  // Remove to use account default
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
    if (!state.initialBalance) state.initialBalance = compoundedBalance;
    state.totalAccountBalance = 0; // Not needed in DRY_RUN
  } else {
    try {
      const info = await getAccountInfo();
      state.currentBalance = info.equity;
      state.available      = info.available;
      state.unrealizedPnL  = info.unrealizedPnL;
      if (!state.initialBalance) state.initialBalance = info.equity;
      
      // Get all account balances for auto position sizing
      const allBalances = await getAllAccountBalances();
      
      // Use equity as primary balance (most accurate for trading)
      // Priority: equity > available > allBalances > fallback
      let bestBalance = info.equity;
      if (bestBalance <= 0) bestBalance = info.available;
      if (bestBalance <= 0 && allBalances.totalBalance > 0) bestBalance = allBalances.totalBalance;
      if (bestBalance <= 0) bestBalance = 30; // fallback minimum
      state.totalAccountBalance = bestBalance;
      
      log("INFO", `💰 Balance - Equity: ${info.equity.toFixed(4)} | Available: ${info.available.toFixed(4)} | Total Account: ${allBalances.totalBalance.toFixed(4)} | Used: ${state.totalAccountBalance.toFixed(4)}`);
      
      // Auto-adjust position size based on balance
      const newPositionSize = calculateAutoPositionSize(state.totalAccountBalance);
      if (newPositionSize !== CONFIG.POSITION_SIZE_USDT) {
        CONFIG.POSITION_SIZE_USDT = newPositionSize;
        CONFIG.PEPE_SPECIFIC_CONFIG.POSITION_SIZE_USDT = newPositionSize;
        log("INFO", `💰 Auto position size: ${newPositionSize} (balance: ${state.totalAccountBalance.toFixed(2)})`);
      }
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
    totalAccountBalance: state.totalAccountBalance || 0,
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
  const isBTC   = state.currentPairMode === "BTC" || state.currentPairMode === "DUAL";
  const pairTag = isBTC ? "BTC/USDT" : "PEPE/USDT";
  const priceStr = isBTC ? p.price.toFixed(2) : p.price.toFixed(8);
  const ema9Str  = isBTC ? p.ema9.toFixed(2)  : p.ema9.toFixed(8);
  const ema21Str = isBTC ? p.ema21.toFixed(2) : p.ema21.toFixed(8);

  const geckoStr = p.geckoData
    ? isBTC
      ? `BTC trending: CMC data available`
      : `PEPE 1h=${p.geckoData.change1h.toFixed(2)}% 24h=${p.geckoData.change24h.toFixed(2)}% 7d=${p.geckoData.change7d.toFixed(2)}% Vol=$${(p.geckoData.volume24h/1e6).toFixed(1)}M${p.geckoData.isPepeTrending ? ` TRENDING#${p.geckoData.trendingRank}` : ""}`
    : "gecko:N/A";
  const cmcStr = p.cmcData
    ? `BTCdom=${p.cmcData.btcDominance.toFixed(1)}% MktCap24h=${p.cmcData.marketCapChange24h >= 0 ? "+" : ""}${p.cmcData.marketCapChange24h.toFixed(2)}%${!isBTC ? ` PEPEvol=${p.cmcData.pepeVolumeChange24h >= 0 ? "+" : ""}${p.cmcData.pepeVolumeChange24h.toFixed(2)}%` : ""}`
    : "cmc:N/A";
  const mtfStr = p.mtf
    ? `1m:${p.mtf.tf1m.trend}/RSI${p.mtf.tf1m.rsi.toFixed(0)} 5m:${p.mtf.tf5m.trend}/RSI${p.mtf.tf5m.rsi.toFixed(0)} 15m:${p.mtf.tf15m.trend}/RSI${p.mtf.tf15m.rsi.toFixed(0)} Consensus:${p.consensus}`
    : "MTF:N/A";
  const bbStr = p.bb
    ? `U=${isBTC ? p.bb.upper.toFixed(2) : p.bb.upper.toFixed(8)} M=${isBTC ? p.bb.middle.toFixed(2) : p.bb.middle.toFixed(8)} L=${isBTC ? p.bb.lower.toFixed(2) : p.bb.lower.toFixed(8)} %B=${p.bb.pctB.toFixed(3)} Squeeze=${p.squeeze?.squeeze ? "YA" : "tidak"} Break=${p.squeeze?.breakoutDirection || "NONE"}`
    : "BB:N/A";

  // BTC analysis context dari quickAnalysis
  const btcCtx = isBTC && state.btcAnalysis && !state.btcAnalysis.error
    ? `BTC15m: Trend=${state.btcAnalysis.trend} EMA20=${state.btcAnalysis.ema20?.toFixed(2)} EMA50=${state.btcAnalysis.ema50?.toFixed(2)} ATR%=${state.btcAnalysis.atrPct?.toFixed(3)} Momentum=${state.btcAnalysis.reason?.substring(0, 60)}`
    : "";

  // Aturan spesifik per pair
  const pairRules = isBTC ? `
Aturan BTC TREND PULLBACK (15m):
- Mode: CONTINUATION trading, BUKAN mean-reversion
- LONG hanya jika: EMA20>EMA50 (uptrend) + EMA9>EMA21 + RSI 42-52 (pullback) + harga>EMA21 + vol≥0.8x
- SHORT hanya jika: EMA20<EMA50 (downtrend) + EMA9<EMA21 + RSI 48-58 (pullback) + harga<EMA21 + vol≥0.8x
- BLOK SHORT jika 5 candle terakhir net >+0.3% atau ≥3 candle hijau — EMA lag bisa menipu
- BLOK LONG jika 5 candle terakhir net <-0.3% atau ≥3 candle merah
- Funding negatif + uptrend = LONG lebih aman
- Fear&Greed <25 = hindari SHORT agresif
- Leverage 3-5x (BTC lebih konservatif)
- SL 0.8-1.5%, TP 1.5-3.0% (RR minimal 1:2)
- buka≥58% confidence
- Jika RSI > 60 dalam downtrend = HOLD, tunggu pullback` : `
Aturan SCALPING AGRESIF PEPE:
- buka≥${CONFIG.OPEN_CONFIDENCE}% tutup≥${CONFIG.CLOSE_CONFIDENCE}%
- RSI 55-65 + EMA cross = confidence minimal 65%
- RSI 45-55 + volume spike = confidence minimal 60%
- BB breakout + volume = confidence minimal 70%
- Jangan tunggu kondisi sempurna — scalping butuh action
- Funding negatif saat market BULLISH = LONG lebih aman
- Fear&Greed Extreme Fear (<20) = peluang bounce LONG
- Volume ratio < 0.1x → HOLD (tidak ada momentum)
- Volume ratio > 0.3x = konfirmasi sinyal KUAT
- Leverage 7-10x untuk semua entry
- SL ketat 0.5-1.0%, TP cepat 1.0-2.0%`;

  const leverageRange = isBTC ? "3-5" : "7-10";
  const slRange       = isBTC ? "0.8-1.5" : "0.5-1.5";
  const tpRange       = isBTC ? "1.5-3.0" : "1.0-2.5";

  const prompt = `Bot ${pairTag} Bitget futures. Balas HANYA JSON.

PASAR: ${priceStr} Bid/Ask:${isBTC ? p.bid.toFixed(2) : p.bid.toFixed(8)}/${isBTC ? p.ask.toFixed(2) : p.ask.toFixed(8)} Vol24h:${(p.volume24h/1e9).toFixed(2)}B Δ24h:${(p.change24h*100).toFixed(2)}%
TEKNIKAL: RSI:${p.rsi.toFixed(1)} EMA9:${ema9Str} EMA21:${ema21Str} VolRatio:${p.volumeRatio.toFixed(2)}x
ORDERBOOK: Bid/Ask ratio=${p.orderBook?.bidAskRatio?.toFixed(3) || 'N/A'}
FUNDING: ${(p.fundingRate*100).toFixed(4)}%${Math.abs(p.fundingRate) > 0.001 ? " ⚠tinggi" : ""} SIGNAL:${p.fundingSignal}${p.fundingRate < -0.0001 ? " ⚡mayoritas short→bias LONG" : p.fundingRate > 0.0001 ? " ⚠mayoritas long→pertimbangkan SHORT" : ""}
F&G: ${p.fearGreed.value}(${p.fearGreed.classification}) Avg7d:${p.fearGreed.avg7d} Trend:${p.fearGreed.trend}
${geckoStr}
${cmcStr}
${btcCtx ? btcCtx + "\n" : ""}POSISI: ${posStr}
MTF: ${mtfStr}
BB: ${bbStr}
VWAP: ${isBTC ? p.vwap.toFixed(2) : p.vwap.toFixed(8)} vs harga ${p.vwapPct >= 0 ? "+" : ""}${p.vwapPct.toFixed(3)}% POC:${p.volProf?.poc ? (isBTC ? p.volProf.poc.toFixed(2) : p.volProf.poc.toFixed(8)) : "N/A"}
CANDLE: Bull:[${p.candlePatterns?.bullishPatterns.join(",") || "-"}] Bear:[${p.candlePatterns?.bearishPatterns.join(",") || "-"}] Bias:${p.candlePatterns?.dominantBias}(${p.candlePatterns?.strength})
PERFORMA: WR:${p.winRate.toFixed(1)}% Streak:${p.streak > 0 ? "+" : ""}${p.streak} TotalPnL:${p.totalPnL >= 0 ? "+" : ""}${p.totalPnL.toFixed(4)}USDT
${pairRules}
{"action":"LONG|SHORT|CLOSE|HOLD","leverage":${leverageRange},"confidence":0-100,"sentiment":"BULLISH|BEARISH|NEUTRAL|VOLATILE","stop_loss_pct":${slRange},"take_profit_pct":${tpRange},"reasoning":"<30 kata"}`;


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

/** 1D-2 — Equal Highs/Lows Liquidity Zone Detection (SMC Enhancement) */
function detectEqualHighsLows(klines, tolerance = 0.001) {
  if (klines.length < 10) return { equalHighs: [], equalLows: [] };
  
  const highs = klines.slice(-50).map(k => k.high);
  const lows = klines.slice(-50).map(k => k.low);
  
  // Find equal highs (resistance liquidity)
  const equalHighs = [];
  for (let i = 0; i < highs.length; i++) {
    const h = highs[i];
    const matches = highs.filter(hi => Math.abs(hi - h) / h < tolerance);
    if (matches.length >= 2) {
      equalHighs.push({ price: h, count: matches.length, index: i });
    }
  }
  
  // Find equal lows (support liquidity)
  const equalLows = [];
  for (let i = 0; i < lows.length; i++) {
    const l = lows[i];
    const matches = lows.filter(li => Math.abs(li - l) / l < tolerance);
    if (matches.length >= 2) {
      equalLows.push({ price: l, count: matches.length, index: i });
    }
  }
  
  // Sort by count and return top
  equalHighs.sort((a, b) => b.count - a.count);
  equalLows.sort((a, b) => b.count - a.count);
  
  return {
    equalHighs: equalHighs.slice(0, 3),
    equalLows: equalLows.slice(0, 3),
  };
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
  // DRY RUN: aktifkan semua session untuk加速 observasi
  if (CONFIG.DRY_RUN && CONFIG.DRY_RUN_ALL_SESSIONS) {
    const now  = new Date();
    const hour = now.getUTCHours();
    return {
      active:     true,
      session:    "ALL_SESSIONS(DRY)",
      inLondon:   true,
      inNY:       true,
      inOverlap:  false,
      wibHour:    (hour + 7) % 24,
    };
  }

  // LIVE: session filter normal (London + New York only)
  // UTC times:
  // London: 07:00 - 16:00 UTC (best volatility)
  // NY: 13:00 - 22:00 UTC (best liquidity)
  // Overlap: 13:00 - 16:00 UTC (both sessions active - BEST)
  // Asia: outside these times (skip - low volatility)
  const now   = new Date();
  const hour  = now.getUTCHours();
  const min   = now.getUTCMinutes();
  const t     = hour + min / 60;
  const inLondon  = t >= 7  && t < 16;   // London: 7am-4pm UTC
  const inNY      = t >= 13 && t < 22;   // NY: 1pm-10pm UTC
  const inOverlap = t >= 13 && t < 16;   // Overlap: 1pm-4pm UTC (BEST)
  return {
    active:     inLondon || inNY,
    session:    inOverlap ? "OVERLAP(TERBAIK)" : inNY ? "NEW_YORK" : inLondon ? "LONDON" : "ASIA(SKIP)",
    inLondon, inNY, inOverlap,
    wibHour:    (hour + 7) % 24,  // Convert to WITA (UTC+7)
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
  return { pass: score >= 5, score, maxScore: 7, reasons };
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

/** STEP 5 — Fake Breakout Filter (SMC Enhancement) */
function detectFakeBreakout(klines, swings, side) {
  if (klines.length < 5) return { detected: false };
  
  const last = klines[klines.length - 1];
  const prev2 = klines[klines.length - 2];
  const prev3 = klines[klines.length - 3];
  
  if (side === "BULLISH") {
    // Fake breakout down: price breaks below support but closes back above
    const swingLow = swings.lastLow?.price;
    if (!swingLow) return { detected: false };
    
    // Check if price broke below swing low recently
    const brokeBelow = prev2.low < swingLow || prev3.low < swingLow;
    // Check if now returning above
    const returnedAbove = last.close > swingLow && last.close > prev2.close;
    // Check for rejection candle (long lower wick)
    const rejection = (last.low - Math.min(last.open, last.close)) > (Math.abs(last.close - last.open)) * 2;
    
    return {
      detected: brokeBelow && returnedAbove,
      type: "FAKE_BREAKDOWN",
      level: swingLow,
      rejection,
      reason: "Price broke below liquidity then returned - stop hunt confirmed"
    };
  } else {
    // Fake breakout up: price breaks above resistance but closes back below
    const swingHigh = swings.lastHigh?.price;
    if (!swingHigh) return { detected: false };
    
    const brokeAbove = prev2.high > swingHigh || prev3.high > swingHigh;
    const returnedBelow = last.close < swingHigh && last.close < prev2.close;
    const rejection = (Math.max(last.open, last.close) - last.high) > (Math.abs(last.close - last.open)) * 2;
    
    return {
      detected: brokeAbove && returnedBelow,
      type: "FAKE_BREAKOUT",
      level: swingHigh,
      rejection,
      reason: "Price broke above liquidity then returned - stop hunt confirmed"
    };
  }
}

/** STEP 6 — Confluence System (SMC Enhancement) */
function calculateConfluence(indicators, orderBook, choch, fvg, liqGrab, emaTrend) {
  let confluenceCount = 0;
  const factors = [];
  
  // Factor 1: SMC Signal (CHoCH + FVG + Liquidity Grab)
  const smcSignal = choch?.detected && fvg?.inFVG;
  if (smcSignal) {
    confluenceCount++;
    factors.push("SMC");
  }
  
  // Factor 2: EMA Trend Alignment
  if (emaTrend) {
    confluenceCount++;
    factors.push("EMA");
  }
  
  // Factor 3: Orderbook Imbalance
  if (orderBook && orderBook.bidAskRatio > 1.5) {
    confluenceCount++;
    factors.push("OB");
  }
  
  // Factor 4: Volume Spike
  if (indicators.volumeRatio > 1.5) {
    confluenceCount++;
    factors.push("VOL");
  }
  
  // Factor 5: RSI in sweet spot
  if (indicators.rsi >= 40 && indicators.rsi <= 65) {
    confluenceCount++;
    factors.push("RSI");
  }
  
  return {
    count: confluenceCount,
    factors,
    sufficient: confluenceCount >= 2,  // Require at least 2 factors
    label: factors.join("+")
  };
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
// DUAL TRADING: PEPE Strategy for Dual Mode
// ─────────────────────────────────────────────────────────────

/**
 * Run PEPE trading when in dual mode (BTC + PEPE)
 * Uses simpler strategy based on hype detection
 */
async function runPepeStrategy(pepeTicker, pepeKlines) {
  if (!state.isDualMode || !pepeTicker || !pepeKlines || pepeKlines.length < 20) {
    return;
  }
  
  // Check if PEPE position already exists
  if (state.pepePosition) {
    log("DEBUG", "PEPE position already exists, skipping entry check");
    return;
  }
  
  const pepePrice = pepeTicker.lastPrice;
  log("INFO", `🔍 PEPE Strategy Check: $${pepePrice.toFixed(8)}`);
  
  try {
    // Calculate simple indicators for PEPE
    const closes = pepeKlines.slice(-20).map(c => c.close);
    const recentCloses = pepeKlines.slice(-5).map(c => c.close);
    
    // Simple EMA calculation
    const ema9 = closes.slice(-9).reduce((a, b) => a + b, 0) / 9;
    const ema21 = closes.slice(-21 < closes.length ? -21 : 0).reduce((a, b) => a + b, 0) / Math.min(21, closes.length);
    
    // Simple RSI calculation
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i-1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / closes.length;
    const avgLoss = losses / closes.length;
    const rs = avgGain / (avgLoss || 0.0001);
    const rsi = 100 - (100 / (1 + rs));
    
    // Price momentum
    const priceChange = (recentCloses[recentCloses.length-1] - recentCloses[0]) / recentCloses[0] * 100;
    
    // Check hype state from pair analysis
    const pairResult = state.pairAnalysis?.PEPE;
    const hypeScore = pairResult?.hypeScore || 0;
    const isHype = hypeScore >= 71;
    
    log("INFO", `📊 PEPE Indicators: RSI=${rsi.toFixed(1)}, EMA9=${ema9.toFixed(8)}, EMA21=${ema21.toFixed(8)}, Change=${priceChange.toFixed(2)}%, Hype=${hypeScore}`);
    
    // Simple entry logic for PEPE
    // LONG: RSI in sweet spot (40-60), price above EMA, positive momentum, hype confirmed
    // SHORT: RSI overbought (>65), price below EMA, negative momentum
    
    let tradeSide = null;
    const inSweetSpot = rsi >= 40 && rsi <= 65;
    const aboveEma = pepePrice > ema9 && pepePrice > ema21;
    const belowEma = pepePrice < ema9 && pepePrice < ema21;
    const positiveMomentum = priceChange > 0.5;
    const negativeMomentum = priceChange < -0.5;
    
    // Entry conditions for PEPE in dual mode
    if (isHype && inSweetSpot && aboveEma && positiveMomentum) {
      tradeSide = "LONG";
      log("INFO", `🟢 PEPE LONG Signal: Hype=${hypeScore}, RSI=${rsi.toFixed(1)}, Momentum=${priceChange.toFixed(2)}%`);
    } else if (isHype && rsi > 65 && belowEma && negativeMomentum) {
      tradeSide = "SHORT";
      log("INFO", `🔴 PEPE SHORT Signal: RSI=${rsi.toFixed(1)}, Below EMA, Momentum=${priceChange.toFixed(2)}%`);
    }
    
    if (tradeSide) {
      // Prevent opening if position already exists (synced from exchange earlier in tradingLoop)
      if (state.activePosition) {
        log("WARN", `[SYNC] Skipping PEPE entry - position already exists!`);
        return;
      }
      
      const config = CONFIG.PEPE_SPECIFIC_CONFIG;
      const tpPct = config?.TAKE_PROFIT_PCT || 3;
      const slPct = config?.STOP_LOSS_PCT || 1.5;
      
      // Adaptive Position Sizing for PEPE
      const currentBalance = state.totalAccountBalance > 0 
        ? state.totalAccountBalance 
        : (CONFIG.DRY_RUN ? compoundedBalance + stats.totalPnL : CONFIG.POSITION_SIZE_USDT * 10);
      const phase = state.phase?.phase || 'STABLE';
      const dynamicSizing = calcDynamicPositionSize(currentBalance, phase, 60, stats.lossStreak || 0);
      const leverage = dynamicSizing.leverage;
      const notional = dynamicSizing.notional;
      const CONTRACT_SIZE = 1000;
      const orderQty = Math.floor((notional / pepePrice) / CONTRACT_SIZE) * CONTRACT_SIZE;
      
      // Open PEPE position
      log("TRADE", `🚀 PEPE ENTRY ${tradeSide} | Price: ${pepePrice.toFixed(8)} | Lev: ${leverage}x | Notional: ${notional}`);
      
      const opened = await openPosition(
        tradeSide === "LONG" ? "LONG" : "SHORT",
        leverage,
        pepePrice,
        orderQty,
        "PEPEUSDT",
        pepeIndicators,
        orderBook
      );
      
      if (opened) {
        // Set PEPE-specific SL/TP
        state.pepePosition.stopLoss = tradeSide === "LONG"
          ? pepePrice * (1 - slPct / 100)
          : pepePrice * (1 + slPct / 100);
        state.pepePosition.takeProfit = tradeSide === "LONG"
          ? pepePrice * (1 + tpPct / 100)
          : pepePrice * (1 - tpPct / 100);
        
        log("TRADE", `PEPE SL: ${state.pepePosition.stopLoss.toFixed(8)} | TP: ${state.pepePosition.takeProfit.toFixed(8)}`);
      }
    } else {
      log("DEBUG", "PEPE no entry signal");
    }
    
  } catch (err) {
    log("ERROR", `PEPE strategy error: ${err.message}`);
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

  // ── Fitur #7: Cek auto pause (LIVE only — DRY_RUN never pauses) ──
  if (!CONFIG.DRY_RUN && state.pausedUntil && Date.now() < state.pausedUntil) {
    const sisaMin = Math.ceil((state.pausedUntil - Date.now()) / 60000);
    if (state.tickCount % 6 === 0) log("WARN", `Bot PAUSE (${state.pauseReason}) — resume dalam ${sisaMin} menit`);
    broadcastSSE({ type: "pause", reason: state.pauseReason, resumeIn: sisaMin });
    return;
  }
  if (state.pausedUntil && Date.now() >= state.pausedUntil) {
    state.pausedUntil = null; state.pauseReason = "";
    log("INFO", "Bot RESUME dari pause otomatis");
  }

  // ── PHASE INDICATOR: MARKET_BAD cooldown gate (LIVE only) ─
  if (!CONFIG.DRY_RUN && state.phase?.phase === PHASES.MARKET_BAD && state.phaseCooldownLeft > 0) {
    if (state.tickCount % 6 === 0) {
      log("WARN", `[PHASE] MARKET_BAD cooldown — ${state.phaseCooldownLeft} trade(s) remaining before new entries`);
    }
    broadcastSSE({ type: "phase", phase: state.phase });
    return;
  }

  // ── ADAPTIVE PAIR SELECTION ─────────────────────────────────
  if (!CONFIG.ADAPTIVE_PAIR_ENABLED) {
    // Fixed pair mode - use DEFAULT_SYMBOL
    const fixedSymbol = CONFIG.DEFAULT_SYMBOL || "PEPEUSDT";
    if (state.currentPair !== fixedSymbol) {
      log("INFO", `🔄 Using fixed pair: ${fixedSymbol}`);
      state.currentPair = fixedSymbol;
      state.currentPairMode = fixedSymbol.includes("BTC") ? "BTC" : "PEPE";
      CONFIG.SYMBOL = fixedSymbol;
      
      // Apply symbol-specific config
      if (fixedSymbol.includes("BTC")) {
        CONFIG.STOP_LOSS_PCT = CONFIG.BTC_SPECIFIC_CONFIG.STOP_LOSS_PCT;
        CONFIG.TAKE_PROFIT_PCT = CONFIG.BTC_SPECIFIC_CONFIG.TAKE_PROFIT_PCT;
        CONFIG.TRAILING_OFFSET = CONFIG.BTC_SPECIFIC_CONFIG.TRAILING_OFFSET;
        CONFIG.POSITION_SIZE_USDT = CONFIG.BTC_SPECIFIC_CONFIG.POSITION_SIZE_USDT;
      } else {
        CONFIG.STOP_LOSS_PCT = CONFIG.PEPE_SPECIFIC_CONFIG.STOP_LOSS_PCT;
        CONFIG.TAKE_PROFIT_PCT = CONFIG.PEPE_SPECIFIC_CONFIG.TAKE_PROFIT_PCT;
        CONFIG.TRAILING_OFFSET = CONFIG.PEPE_SPECIFIC_CONFIG.TRAILING_OFFSET;
        CONFIG.POSITION_SIZE_USDT = CONFIG.PEPE_SPECIFIC_CONFIG.POSITION_SIZE_USDT;
      }
    }
  } else if (CONFIG.ADAPTIVE_PAIR_ENABLED) {
    const timeSinceLastSelection = Date.now() - state.lastPairSelection;
    
    // First run or interval elapsed
    if (state.lastPairSelection === 0 || timeSinceLastSelection >= CONFIG.PAIR_SELECTION_INTERVAL) {
      try {
        const pairResult = await pairSelector.getCurrentPair(true);
        
        if (pairResult && pairResult.selected) {
          const newPair = pairResult.selected;
          
          // Check for DUAL TRADING MODE
          const isDualMode = CONFIG.DUAL_TRADING_MODE && pairResult.isDualMode;
          
          let pairMode;
          if (isDualMode) {
            pairMode = "DUAL";
            log("INFO", `⚡⚡ DUAL TRADING MODE: BTC + PEPE (${pairResult.reason})`);
          } else {
            pairMode = newPair === "BTCUSDT" ? "BTC" : "PEPE";
          }
          
          // Only log and update if pair changed
          if (newPair !== state.currentPair || isDualMode !== state.isDualMode) {
            if (isDualMode) {
              log("INFO", `⚡⚡ DUAL MODE: BTC + PEPE (${pairResult.reason})`);
            } else {
              log("INFO", `🔄 PAIR SWITCH: ${state.currentPair} → ${newPair} (${pairResult.reason})`);
            }
          }
          
          state.currentPair = newPair;
          state.currentPairMode = pairMode;
          state.isDualMode = isDualMode;
          state.pairSelectionReason = pairResult.reason;
          state.lastPairSelection = Date.now();
          state.pairAnalysis = pairResult.analysis;
          
          // Update CONFIG based on selected pair
          if (isDualMode) {
            // In dual mode, we use BTC config as main, but track both
            CONFIG.SYMBOL = "BTCUSDT";
            CONFIG.STOP_LOSS_PCT = CONFIG.BTC_SPECIFIC_CONFIG.STOP_LOSS_PCT;
            CONFIG.TAKE_PROFIT_PCT = CONFIG.BTC_SPECIFIC_CONFIG.TAKE_PROFIT_PCT;
            CONFIG.TRAILING_OFFSET = CONFIG.BTC_SPECIFIC_CONFIG.TRAILING_OFFSET;
            CONFIG.POSITION_SIZE_USDT = CONFIG.BTC_SPECIFIC_CONFIG.POSITION_SIZE_USDT;
            CONFIG.MIN_SL_PCT = CONFIG.BTC_SPECIFIC_CONFIG.MIN_SL_PCT;
            CONFIG.MAX_SL_PCT = CONFIG.BTC_SPECIFIC_CONFIG.MAX_SL_PCT;
          } else if (pairMode === "BTC") {
            CONFIG.SYMBOL = "BTCUSDT";
            CONFIG.STOP_LOSS_PCT = CONFIG.BTC_SPECIFIC_CONFIG.STOP_LOSS_PCT;
            CONFIG.TAKE_PROFIT_PCT = CONFIG.BTC_SPECIFIC_CONFIG.TAKE_PROFIT_PCT;
            CONFIG.TRAILING_OFFSET = CONFIG.BTC_SPECIFIC_CONFIG.TRAILING_OFFSET;
            CONFIG.POSITION_SIZE_USDT = CONFIG.BTC_SPECIFIC_CONFIG.POSITION_SIZE_USDT;
            CONFIG.MIN_SL_PCT = CONFIG.BTC_SPECIFIC_CONFIG.MIN_SL_PCT;
            CONFIG.MAX_SL_PCT = CONFIG.BTC_SPECIFIC_CONFIG.MAX_SL_PCT;
          } else {
            CONFIG.SYMBOL = "PEPEUSDT";
            CONFIG.STOP_LOSS_PCT = CONFIG.PEPE_SPECIFIC_CONFIG.STOP_LOSS_PCT;
            CONFIG.TAKE_PROFIT_PCT = CONFIG.PEPE_SPECIFIC_CONFIG.TAKE_PROFIT_PCT;
            CONFIG.TRAILING_OFFSET = CONFIG.PEPE_SPECIFIC_CONFIG.TRAILING_OFFSET;
            CONFIG.POSITION_SIZE_USDT = CONFIG.PEPE_SPECIFIC_CONFIG.POSITION_SIZE_USDT;
            CONFIG.MIN_SL_PCT = CONFIG.PEPE_SPECIFIC_CONFIG.MIN_SL_PCT;
            CONFIG.MAX_SL_PCT = CONFIG.PEPE_SPECIFIC_CONFIG.MAX_SL_PCT;
          }
          
          // Get BTC strategy analysis
          try {
            state.btcAnalysis = await btcStrategy.quickAnalysis(stats.lossStreak || 0);
          } catch (e) {
            log("WARN", `BTC strategy analysis failed: ${e.message}`);
          }
        }
      } catch (err) {
        log("WARN", `Pair selection error: ${err.message}, keeping current pair`);
      }
    }
  }

  // ── Refresh BTC pullback analysis setiap 3 tick saat BTC mode aktif ──
  if ((state.currentPairMode === "BTC" || state.currentPairMode === "DUAL") && state.tickCount % 3 === 0) {
    try {
      state.btcAnalysis = await btcStrategy.quickAnalysis(stats.lossStreak || 0);
    } catch (e) {
      log("WARN", `BTC quick analysis refresh failed: ${e.message}`);
    }
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
    // Broadcast error state ke dashboard agar user tahu ada masalah koneksi
    broadcastSSE({
      type: "error",
      message: `❌ Gagal koneksi ke Bitget: ${err.message}. Cek VPN/internet!`,
      lastPrice: state.lastPrice || '--',
      lastUpdate: new Date().toISOString(),
      smcData: null,
    });
    return;
  }

  // ── 1b. Ambil data PEPE untuk DUAL MODE ─────────────────────
  let pepeTicker = null;
  let pepeKlines = null;
  if (state.isDualMode) {
    try {
      const [pt, pk] = await Promise.all([
        bitgetRequest("GET", "/api/v2/mix/market/ticker", { symbol: "PEPEUSDT", productType: "usdt-futures" }),
        bitgetRequest("GET", "/api/v2/mix/market/candles", { symbol: "PEPEUSDT", productType: "usdt-futures", granularity: "1m", limit: "50" })
      ]);
      if (pt.code === "00000" && pt.data[0]) {
        pepeTicker = {
          lastPrice: parseFloat(pt.data[0].lastPr),
          bidPrice: parseFloat(pt.data[0].bidPr),
          askPrice: parseFloat(pt.data[0].askPr),
        };
      }
      if (pk.code === "00000") {
        pepeKlines = pk.data.map((c) => ({
          time: parseInt(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        }));
      }
      state.lastPepePrice = pepeTicker?.lastPrice || 0;
      log("INFO", `📊 PEPE Data: $${state.lastPepePrice.toFixed(8)}`);
    } catch (e) {
      log("WARN", `Gagal ambil data PEPE: ${e.message}`);
    }
  }

  // ── 1c. Run PEPE Strategy in Dual Mode ─────────────────────
  // Run PEPE strategy after BTC data is processed
  if (state.isDualMode && pepeTicker && pepeKlines) {
    await runPepeStrategy(pepeTicker, pepeKlines);
  }

  const price = ticker.lastPrice;
  state.lastPrice       = price;
  state.lastFundingRate = fundingRate;
  state.lastBidAsk      = { bid: ticker.bidPrice, ask: ticker.askPrice };
  state.lastKlines      = klines; // simpan untuk chart dashboard

  const indicators = calcIndicators(klines);
  state.lastRSI          = indicators.rsi;
  state.lastEMA9         = indicators.ema9;
  state.lastEMA21        = indicators.ema21;
  state.lastVolumeRatio  = indicators.volumeRatio;

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

  // ── 2. SYNC POSITION: Fetch real position from Bitget and sync with local state ─
  let livePosition = null;
  if (!CONFIG.DRY_RUN && CONFIG.API_KEY) {
    try {
      livePosition = await getActivePosition();
      
      if (livePosition) {
        // [SYNC] Exchange Position Detected
        log("INFO", `[SYNC] Exchange Position Detected | Side=${livePosition.side} | Size=${livePosition.size} | Entry=${livePosition.entryPrice}`);
        
        if (!state.activePosition) {
          // No local position but exchange has position - sync from exchange!
          log("WARN", `[SYNC] Position exists on exchange but NOT in local state! Syncing...`);
          state.activePosition = {
            side: livePosition.side,
            entryPrice: livePosition.entryPrice,
            size: livePosition.size,
            leverage: livePosition.leverage,
            liqPrice: livePosition.liqPrice,
            unrealPnL: livePosition.unrealPnL,
            pnlPct: livePosition.pnlPct,
            marginSize: livePosition.marginSize,
            openTime: Date.now(),
            symbol: CONFIG.SYMBOL,
            runnerActivated: false,
          };
        } else {
          // Both have position - sync live data
          state.activePosition.liqPrice   = livePosition.liqPrice;
          state.activePosition.unrealPnL  = livePosition.unrealPnL;
          state.activePosition.pnlPct     = livePosition.pnlPct;
          state.activePosition.marginSize = livePosition.marginSize;
        }
      } else {
        // No position on exchange
        if (state.activePosition && !state.activePosition.closing) {
          // Local has position but exchange doesn't - was closed externally!
          log("WARN", `[SYNC] Position closed on exchange (externally) but local still has it! Clearing local state.`);
          state.activePosition = null;
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
        pairMode:      state.currentPairMode,
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

  // ── Supabase: equity snapshot every 30 ticks (~5 menit) ─────
  if (state.tickCount % 30 === 0) {
    const _posPnlPct = pos ? (pos.side === "LONG"
      ? (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage
      : (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage) : null;
    db.saveEquity({
      symbol:         state.currentPair || CONFIG.SYMBOL,
      balance:        state.currentBalance || state.initialBalance,
      initialBalance: state.initialBalance,
      peakBalance:    state.peakBalance,
      totalPnL:       stats.totalPnL,
      unrealizedPnL:  pos ? (CONFIG.POSITION_SIZE_USDT * (_posPnlPct || 0) / 100) : 0,
      hasPosition:    !!pos,
      positionSide:   pos?.side || null,
      positionPnlPct: _posPnlPct,
      phase:          state.phase?.phase || null,
      lossStreak:     stats.lossStreak   || 0,
      tickCount:      state.tickCount,
      dryRun:         CONFIG.DRY_RUN,
    }).catch(() => {});
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
      log("INFO", `  ${C.red}LIQUIDATION: ${pos.liqPrice?.toFixed(8) ?? '--'}${C.reset} | SL: ${pos.stopLoss?.toFixed(8) ?? '--'} | TP: ${pos.takeProfit?.toFixed(8) ?? '--'}`);
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

    // Declare momentumCondCount at function level (outside if/else)
    let momentumCondCount = 0;

    if (holdMs < minHoldMs) {
      const sisaSec = Math.ceil((minHoldMs - holdMs) / 1000);
      if (state.tickCount % 3 === 0) {
        log("INFO", `⏳ Minimum hold time — tunggu ${sisaSec}s lagi`);
      }
      // Hard SL tetap aktif saat hold time
      if (pnlPct < -CONFIG.MAX_LOSS_PCT) {
        log("TRADE", `Force close dalam hold time — rugi > ${CONFIG.MAX_LOSS_PCT}%`);
        await closePosition("FORCE_CLOSE_MAX_LOSS", price);
        return;
      }
    } else {

    // ═══════════════════════════════════════════════════════════════
    // LOW-RISK PROFIT MAXIMIZER
    // ═══════════════════════════════════════════════════════════════
    const holdDurationMs = pos.openTime ? Date.now() - new Date(pos.openTime).getTime() : 0;
    const holdMinutes    = holdDurationMs / 60000;
    const positionRegime = pos.regime || "TREND";

    // Profit tanpa leverage (raw price move %)
    const rawProfitPct = pos.side === "LONG"
      ? (price - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - price) / pos.entryPrice * 100;

    // Estimasi PnL dalam USDT (pakai margin = POSITION_SIZE_USDT sebagai basis)
    const marginUsdt   = CONFIG.POSITION_SIZE_USDT;
    const profitUsdt   = marginUsdt * pos.leverage * rawProfitPct / 100;
    const lossUsdt     = -profitUsdt; // positif kalau rugi

    // ── Supabase: track max profit / max drawdown per trade ──────
    db.updateTradeTracker(
      db.makeTradeId(pos.symbol || CONFIG.SYMBOL, pos.openTime),
      rawProfitPct
    );

    // Fee-aware minimum profit (Mode 6: never close < 0.3% unless emergency)
    const TOTAL_FEE_RAW      = 0.12;                     // entry + exit fee as % of raw price
    const min_profit_required = TOTAL_FEE_RAW * 2;       // 0.24%
    const MIN_PROFIT_PCT      = Math.max(0.30, min_profit_required); // Mode 6: ≥0.30%
    const MIN_PROFIT_USDT     = 0.05;  // minimum profit USDT
    const HARD_SL_PCT         = 0.5;   // hard stop loss % (raw)
    const HARD_SL_USDT        = 0.20;  // hard stop loss USDT

    // ── 1. HARD STOP LOSS ─────────────────────────────────────────
    if (rawProfitPct < 0) {
      const hitPct  = rawProfitPct <= -HARD_SL_PCT;
      const hitUsdt = lossUsdt >= HARD_SL_USDT;
      if (hitPct || hitUsdt) {
        log("TRADE", `[RISK] Hard SL triggered | Loss=${rawProfitPct.toFixed(3)}% / ${lossUsdt.toFixed(4)} USDT`);
        await closePosition("HARD_STOP_LOSS", price);
        return;
      }
    }

    // ── 2. VIRTUAL SL CHECK (SL dari state lokal) ─────────────────
    if (pos.stopLoss) {
      const slHit = pos.side === "LONG" ? price <= pos.stopLoss : price >= pos.stopLoss;
      if (slHit) {
        log("TRADE", `[RISK] SL kena: ${price.toFixed(8)} vs SL ${pos.stopLoss.toFixed(8)}`);
        await closePosition("STOP_LOSS", price);
        return;
      }
    }

    // ── 3. MOMENTUM CHECK (Phase 2: ≥3 conditions = RUNNER_CANDIDATE) ──────────
    const rsiNow      = indicators.rsi || 50;
    const ema9Now     = indicators.ema9  || price;
    const ema21Now    = indicators.ema21 || price;
    const volRatioNow = indicators.volumeRatio || 1;

    // Consecutive candles in direction (Phase 2 condition)
    const consec3 = klines.length >= 3 && (
      pos.side === "LONG"
        ? klines.slice(-3).every((c, i, a) => i === 0 || c.close > a[i-1].close)
        : klines.slice(-3).every((c, i, a) => i === 0 || c.close < a[i-1].close)
    );
    // Count how many Phase-2 conditions are met
    momentumCondCount = [
      volRatioNow > 1.3,
      pos.side === "LONG" ? (rsiNow >= 55 && rsiNow <= 70) : (rsiNow >= 30 && rsiNow <= 45),
      pos.side === "LONG" ? (price > ema9Now && price > ema21Now) : (price < ema9Now && price < ema21Now),
      consec3,
    ].filter(Boolean).length;
    const momentumStrong = momentumCondCount >= 3;
    const momentumWeak   = volRatioNow < 0.8
      || (pos.side === "LONG" ? rsiNow < 40 : rsiNow > 62);

    // ── 4. EARLY BREAKEVEN ────────────────────────────────────────
    if (!pos.breakevenSet && rawProfitPct >= 0.15) {
      const beSL = pos.side === "LONG"
        ? pos.entryPrice * (1 + 0.03 / 100)
        : pos.entryPrice * (1 - 0.03 / 100);
      const beImproved = pos.stopLoss == null
        ? true
        : pos.side === "LONG" ? beSL > pos.stopLoss : beSL < pos.stopLoss;
      if (beImproved) {
        pos.stopLoss    = beSL;
        pos.breakevenSet = true;
        log("TRADE", `[PROFIT] Early BE activated | Profit=${rawProfitPct.toFixed(3)}% → SL=${beSL.toFixed(8)}`);
        broadcastSSE({ type: "breakeven", message: `BE aktif → SL=${beSL.toFixed(8)}`, sl: beSL, entry: pos.entryPrice });
        saveState();
      }
    }

    // ── 5. LOSS CONTROL AFTER PROFIT ──────────────────────────────
    if (!pos._wasProfit && rawProfitPct >= 0.2) pos._wasProfit = true;
    if (pos._wasProfit && rawProfitPct <= 0.02) {
      log("TRADE", `[RISK] Trade was profitable tapi harga kembali ke entry → exit paksa`);
      await closePosition("PROFIT_RETURN_PROTECT", price);
      return;
    }

    // ── 6. MICRO PROFIT BLOCKER (Rules 1 + 2) ─────────────────────────────────
    // HOLD profit < MIN unless STRONG reversal: engulfing + vol-spike + RSI-div (≥2/3)
    if (rawProfitPct > 0 && rawProfitPct < MIN_PROFIT_PCT) {
      const last3   = klines.slice(-3);
      const lastC   = last3[last3.length - 1];
      const prevC   = last3[last3.length - 2] || lastC;
      // Bearish engulfing for LONG / bullish engulfing for SHORT
      const engulfing = pos.side === "LONG"
        ? lastC && prevC && lastC.close < lastC.open
            && lastC.open >= prevC.close && lastC.close <= prevC.open  // bear engulf
        : lastC && prevC && lastC.close > lastC.open
            && lastC.open <= prevC.close && lastC.close >= prevC.open; // bull engulf
      // Volume spike against position direction
      const volSpike     = volRatioNow > 1.5;
      // RSI divergence: RSI moving against position
      const rsiDivergence = pos.side === "LONG" ? rsiNow < 40 : rsiNow > 62;
      const reversalScore = (engulfing ? 1 : 0) + (volSpike ? 1 : 0) + (rsiDivergence ? 1 : 0);
      const strongReversal = reversalScore >= 2;

      if (strongReversal && momentumWeak) {
        log("TRADE",
          `[PROFIT] Micro profit + strong reversal (engulf=${engulfing} volSpike=${volSpike} rsiDiv=${rsiDivergence}) → close ${rawProfitPct.toFixed(3)}%`
        );
        await closePosition("MICRO_PROFIT_REVERSAL", price);
        return;
      }
      // Otherwise HOLD — fee protection active
      if (state.tickCount % 5 === 0)
        log("INFO", `[FEE GATE] Hold — profit ${rawProfitPct.toFixed(3)}% < min ${MIN_PROFIT_PCT}% (fee protection, reversal score ${reversalScore}/3)`);
    }

    // ── 7. TIMEOUT EXITS (Rules 4 + 6) ───────────────────────────────────────
    // Detect dead trade signals (Rule 6): volume dying + sideways
    const volumeDying  = volRatioNow < 0.5;
    const sidewaysNow  = klines.length >= 5 && (() => {
      const slice = klines.slice(-5);
      const hi    = Math.max(...slice.map(c => c.high));
      const lo    = Math.min(...slice.map(c => c.low));
      return (hi - lo) / price * 100 < 0.10; // < 0.10% range = sideways
    })();

    // Dead trade: >60 min, profit < 0.2% — HOLD if profit still covers fees (Rule 4)
    if (!pos._timeoutDisabled && holdMinutes >= 60 && rawProfitPct < 0.2) {
      if (rawProfitPct >= min_profit_required) {
        log("TRADE", `⏰ DEAD TRADE (profit OK): ${holdMinutes.toFixed(0)}min | profit=${rawProfitPct.toFixed(3)}% → close`);
        await closePosition("DEAD_TRADE_TIMEOUT", price);
        return;
      } else if (volumeDying && sidewaysNow) {
        // Truly dead: no vol, no move — cut even at small loss
        log("TRADE", `⏰ DEAD TRADE (no vol + sideways): ${holdMinutes.toFixed(0)}min | profit=${rawProfitPct.toFixed(3)}% → close`);
        await closePosition("DEAD_TRADE_TIMEOUT", price);
        return;
      } else {
        if (state.tickCount % 6 === 0)
          log("INFO", `⏰ TIMEOUT extend — profit ${rawProfitPct.toFixed(3)}% < fee min ${min_profit_required.toFixed(2)}% → hold`);
      }
    }
    // Normal timeout: >45 min, not runner — only if profit > 0.4% (Rule 4)
    if (!pos.runnerActivated && !pos._timeoutDisabled && holdMinutes >= 45 && rawProfitPct >= 0.4) {
      log("TRADE", `⏰ TIMEOUT EXIT: ${holdMinutes.toFixed(0)}min | profit=${rawProfitPct.toFixed(3)}% → close`);
      await closePosition("TIMEOUT_EXIT", price);
      return;
    }

    // ── 8. RUNNER MODE (Phases 3 + 6) ────────────────────────────────────────
    // Phase 6: Anti-fake runner — revert if profit drops < 0.8% AND momentum gone
    if (pos.runnerActivated && rawProfitPct < 0.8 && momentumWeak) {
      pos.runnerActivated  = false;
      pos._timeoutDisabled = false;
      pos.tpTrailPct       = null;
      log("TRADE", `[RUNNER] Phase 6 anti-fake: profit ${rawProfitPct.toFixed(3)}% < 0.8% + weak momentum → revert to NORMAL`);
    }
    // Phase 3: Promote to RUNNER — profit > 0.8%, momentum strong, no rejection
    if (rawProfitPct >= 0.8 && momentumStrong && !pos.runnerActivated) {
      pos.runnerActivated  = true;
      pos._timeoutDisabled = true;
      pos.tpTrailPct       = 0.35; // Phase 4 baseline trailing (20% lock)
      log("TRADE", `[RUNNER] Phase 3 confirmed → RUNNER mode | profit=${rawProfitPct.toFixed(3)}% Vol=${volRatioNow.toFixed(2)} RSI=${rsiNow.toFixed(1)} conds=${momentumCondCount}/4`);
    }

    // ── 9. DYNAMIC LOCK V2 ────────────────────────────────────────
    const rawProfitLock = rawProfitPct;
    const lockBuffer = momentumStrong ? 1.15 : momentumWeak ? 0.85 : 1.0;

    if (state.tickCount % 5 === 0 && rawProfitLock > 0.1) {
      log("INFO", `[LOCK] Profit=${rawProfitLock.toFixed(3)}% Vol=${volRatioNow.toFixed(2)} RSI=${rsiNow.toFixed(1)} Mom=${momentumStrong?"STRONG":momentumWeak?"WEAK":"NEUTRAL"}`);
    }

    if (!pos._wasProfit && rawProfitLock >= 0.15) pos._wasProfit = true;

    // Mode 4 — Runner priority lock levels (1%/2%/3%/5%)
    const V2_LEVELS = [
      { id: 1, trigger: 1.00, lockPct: 0.20,  label: "20% locked @1%"  },
      { id: 2, trigger: 2.00, lockPct: 0.40,  label: "40% locked @2%"  },
      { id: 3, trigger: 3.00, lockPct: 0.60,  label: "60% locked @3%"  },
      { id: 4, trigger: 5.00, lockPct: 0.80,  label: "80% locked @5%"  },
    ];
    if (rawProfitLock >= 0.8 && !pos._timeoutDisabled) {
      pos._timeoutDisabled = true;
      log("INFO", `[LOCK] Profit ≥0.8% → timeout DINONAKTIFKAN`);
    }
    for (let i = V2_LEVELS.length - 1; i >= 0; i--) {
      const lv = V2_LEVELS[i];
      if (rawProfitLock >= lv.trigger) {
        const lockAmt  = rawProfitLock * lv.lockPct * lockBuffer;
        const lockedSL = pos.side === "LONG"
          ? pos.entryPrice * (1 + lockAmt / 100)
          : pos.entryPrice * (1 - lockAmt / 100);
        const improved = pos.stopLoss == null ? true
          : pos.side === "LONG" ? lockedSL > pos.stopLoss : lockedSL < pos.stopLoss;
        if (improved) {
          const prevSL  = pos.stopLoss;
          pos.stopLoss  = lockedSL;
          pos.lockLevel = i;
          if (lv.id === 4 && !pos.runnerActivated) {
            pos.runnerActivated = true;
            pos.tpTrailPct      = 0.18; // Phase 4 at 2% profit → 60% lock trailing
            log("TRADE", `[RUNNER] Level 4 (2% profit) → runner mode | trailing=0.18%`);
          }
          log("TRADE", `[LOCK] Level ${lv.id} → ${lv.label} | SL ${prevSL?.toFixed(8)??"--"} → ${lockedSL.toFixed(8)} (profit=${rawProfitLock.toFixed(3)}%)`);
          broadcastSSE({ type: "lock_profit", level: lv.id, label: lv.label, newSL: lockedSL, profitRaw: rawProfitLock.toFixed(3) });
          saveState();
        }
        break;
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

    // ── FITUR #2: TRAILING TP DINAMIS (Regime-based) ─────────────
    // RANGE: trailing distance = 0.35% | TREND: existing (0.5 * TP)
    if (!pos.trailingTP) pos.trailingTP = pos.takeProfit;
    if (!pos.tpTrailPct) {
      // Use regime-based trailing distance
      pos.tpTrailPct = positionRegime === "RANGE" ? 0.35 : CONFIG.TAKE_PROFIT_PCT * 0.5;
    }
    
    // Phase 4: Runner trailing — dynamic based on profit level (let winner run)
    if (pos.runnerActivated) {
      const prevTrail = pos.tpTrailPct;
      if      (rawProfitPct >= 6.0) pos.tpTrailPct = 0.08;  // 85% lock — ride hard
      else if (rawProfitPct >= 4.0) pos.tpTrailPct = 0.12;  // 75% lock
      else if (rawProfitPct >= 2.5) pos.tpTrailPct = 0.18;  // 60% lock
      else if (rawProfitPct >= 1.5) pos.tpTrailPct = 0.25;  // 40% lock
      else                          pos.tpTrailPct = 0.35;  // 20% lock — early runner
      if (pos.tpTrailPct !== prevTrail)
        log("TRADE", `🏃 RUNNER trail ${prevTrail?.toFixed(2) ?? '?'}% → ${pos.tpTrailPct}% (profit=${rawProfitPct.toFixed(3)}%)`);
    }

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
        // STEP 3: FEE GATE - Don't close if profit < minProfitPercent
        if (rawProfitPct > 0 && rawProfitPct < MIN_PROFIT_PCT) {
          log("FEE", `[FEE GATE] Trailing TP hit but profit ${rawProfitPct.toFixed(2)}% < min ${MIN_PROFIT_PCT}% → HOLD`);
        } else {
          log("TRADE", `${C.green}TAKE PROFIT (trailing TP=${pos.trailingTP.toFixed(8)})${C.reset}`);
          await closePosition("TAKE_PROFIT_TRAILING", price);
          return;
        }
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
        // STEP 3: FEE GATE - Don't close if profit < minProfitPercent
        if (rawProfitPct > 0 && rawProfitPct < MIN_PROFIT_PCT) {
          log("FEE", `[FEE GATE] Trailing TP hit but profit ${rawProfitPct.toFixed(2)}% < min ${MIN_PROFIT_PCT}% → HOLD`);
        } else {
          log("TRADE", `${C.green}TAKE PROFIT (trailing TP=${pos.trailingTP.toFixed(8)})${C.reset}`);
          await closePosition("TAKE_PROFIT_TRAILING", price);
          return;
        }
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
          // STEP 3: FEE GATE - Don't close if profit < minProfitPercent
          if (rawProfitPct > 0 && rawProfitPct < MIN_PROFIT_PCT) {
            log("FEE", `[FEE GATE] Early exit blocked - profit ${rawProfitPct.toFixed(2)}% < min ${MIN_PROFIT_PCT}% → HOLD`);
          } else {
            log("TRADE",
              `⚡ EARLY EXIT — Momentum melemah [${reasons.join(", ")}] ` +
              `| Profit ${rawProfit.toFixed(3)}% raw | Amankan sekarang`
            );
            await closePosition("EARLY_EXIT_WEAK_MOMENTUM", price);
            return;
          }
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

    // ── MODE 5: SCALE-IN — tambah posisi saat profit > 0.7% + momentum kuat ─────
    if (!state.scaleInDone && pos && !pos.partialClosed) {
      const siRawPct = pos.side === "LONG"
        ? (price - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - price) / pos.entryPrice * 100;
      const siVolOk = (indicators.volumeRatio || 0) > 1.2;
      const siMomOk = momentumCondCount >= 2; // 2+ momentum conditions
      if (siRawPct >= 0.7 && siVolOk && siMomOk) {
        state.scaleInDone = true;
        const scaleQty = Math.round(pos.size * 0.40); // add 40% of current position
        log("TRADE",
          `📈 [MODE 5] SCALE-IN | profit=${siRawPct.toFixed(3)}% Vol=${(indicators.volumeRatio||0).toFixed(2)}x ` +
          `→ add ${scaleQty} (40% of current ${pos.size})`
        );
        if (!CONFIG.DRY_RUN && scaleQty > 0) {
          const sym = pos.symbol || CONFIG.SYMBOL;
          await bitgetRequest("POST", "/api/v2/mix/order/place-order", {}, {
            symbol:      sym,
            productType: CONFIG.PRODUCT_TYPE,
            marginCoin:  CONFIG.MARGIN_COIN,
            size:        scaleQty.toString(),
            side:        pos.side === "LONG" ? "buy" : "sell",
            tradeSide:   "open",
            orderType:   "market",
          });
        } else if (CONFIG.DRY_RUN) {
          log("INFO", `[DRY RUN] Simulasi scale-in +${scaleQty} @ ${price}`);
        }
        pos.size += scaleQty;
        saveState();
        broadcastSSE({ type: "scale_in", addedQty: scaleQty, totalSize: pos.size, profit: siRawPct.toFixed(3) });

        // Optional second scale-in at 1.5%
        if (siRawPct >= 1.5 && !pos._scaleIn2Done) {
          pos._scaleIn2Done = true;
          const scaleQty2 = Math.round(pos.size * 0.20);
          if (scaleQty2 > 0) {
            log("TRADE", `📈 [MODE 5] SCALE-IN 2 | profit=${siRawPct.toFixed(3)}% → add ${scaleQty2} (20%)`);
            if (!CONFIG.DRY_RUN) {
              await bitgetRequest("POST", "/api/v2/mix/order/place-order", {}, {
                symbol: pos.symbol || CONFIG.SYMBOL, productType: CONFIG.PRODUCT_TYPE,
                marginCoin: CONFIG.MARGIN_COIN, size: scaleQty2.toString(),
                side: pos.side === "LONG" ? "buy" : "sell", tradeSide: "open", orderType: "market",
              });
            }
            pos.size += scaleQty2;
            saveState();
          }
        }
      }
    }

    // Fitur #5: Partial close trigger (Phase 7 — close 30% at 1.5%)
    if (CONFIG.PARTIAL_CLOSE_ENABLED && !pos.partialClosed) {
      const profitPct = pos.side === "LONG"
        ? ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - price) / pos.entryPrice) * 100 * pos.leverage;
      if (profitPct >= CONFIG.PARTIAL_CLOSE_TRIGGER) {
        await closePartialPosition("PARTIAL_PROFIT_LOCK", price);
        pos.trailingHigh = price; pos.trailingLow = price;
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

  let smcData = null; // defined here so it's accessible in both if(!pos) and else branches

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

    // ═══════════════════════════════════════════════════════════════
    // MARKET REGIME DETECTION (ATR-based)
    // ═══════════════════════════════════════════════════════════════
    const isRangeMode = atrPct < 0.12;
    const currentRegime = isRangeMode ? "RANGE" : "TREND";
    
    // Log regime changes
    if (state.lastRegime !== currentRegime) {
      if (isRangeMode) {
        log("REGIME", `[REGIME] RANGE MODE (Low Volatility) - ATR: ${atrPct.toFixed(3)}%`);
      } else {
        log("REGIME", `[REGIME] TREND MODE - ATR: ${atrPct.toFixed(3)}%`);
      }
      state.lastRegime = currentRegime;
    }

    // ═══════════════════════════════════════════════════════════════
    // BTC RANGE MODE STRATEGY
    // ═══════════════════════════════════════════════════════════════
    if (isRangeMode && !pos && session.active) {
      // Range mode entry conditions — hanya London/NY session
      const rsi = indicators.rsi || 50;
      const volRatio = indicators.volumeRatio || 0;
      
      // Check Bollinger Band touches
      const bbTouchLower = bbData && bbData.pctB < 0.15;  // Touching lower band
      const bbTouchUpper = bbData && bbData.pctB > 0.85;  // Touching upper band
      
      let rangeTradeSide = null;
      
      // LONG: RSI <= 38, touches lower BB, volume >= 0.5
      if (rsi <= 38 && bbTouchLower && volRatio >= 0.5) {
        rangeTradeSide = "BULLISH";
        log("REGIME", `₿ BTC RANGE MODE LONG | RSI=${rsi.toFixed(1)} | BB Lower Touch | Vol=${volRatio.toFixed(1)}`);
      }
      // SHORT: RSI >= 62, touches upper BB, volume >= 0.5
      else if (rsi >= 62 && bbTouchUpper && volRatio >= 0.5) {
        rangeTradeSide = "BEARISH";
        log("REGIME", `₿ BTC RANGE MODE SHORT | RSI=${rsi.toFixed(1)} | BB Upper Touch | Vol=${volRatio.toFixed(1)}`);
      }
      
      if (rangeTradeSide) {
        // Range mode risk management: TP=0.6%, SL=0.4%
        const rangeTpPct = 0.6;
        const rangeSlPct = 0.4;
        
        // Adaptive Position Sizing for RANGE mode
        const currentBalance = state.totalAccountBalance > 0 
          ? state.totalAccountBalance 
          : (CONFIG.DRY_RUN ? compoundedBalance + stats.totalPnL : CONFIG.POSITION_SIZE_USDT * 10);
        const dynamicSizing = calcDynamicPositionSize(currentBalance, 'STABLE', 60, stats.lossStreak || 0);
        let leverage = dynamicSizing.leverage;
        const notional = dynamicSizing.notional;
        const isPepe = CONFIG.SYMBOL.includes("PEPE");
        // BTC: Convert notional (USDT) to quantity (BTC contracts)
        // QTY = notional / price (e.g., 5 USDT / 82000 = 0.000061 BTC)
        let orderQty;
        if (isPepe) {
          const CONTRACT_SIZE = 1000;
          orderQty = Math.floor((notional / price) / CONTRACT_SIZE) * CONTRACT_SIZE;
          if (orderQty < CONTRACT_SIZE) orderQty = CONTRACT_SIZE;
        } else {
          // BTC USDT-M: margin = POSITION_SIZE_USDT, cap ke 80% saldo live agar tidak exceed balance
          const availBalance = state.totalAccountBalance > 0
            ? state.totalAccountBalance * 0.8
            : CONFIG.POSITION_SIZE_USDT;
          const marginUsdt = Math.min(CONFIG.POSITION_SIZE_USDT, availBalance);
          const minQty = 0.001;
          const minLevNeeded = Math.ceil((minQty * price) / marginUsdt);
          leverage = Math.min(Math.max(leverage, minLevNeeded, 3), CONFIG.MAX_LEVERAGE);
          let qty = (marginUsdt * leverage) / price;
          qty = Math.round(qty * 1000) / 1000;
          if (qty < minQty) qty = minQty;
          orderQty = qty;
        }
        log("INFO", `📊 BTC Range Order: Qty=${orderQty} BTC | Lev=${leverage}x | Margin≈${(orderQty * price / leverage).toFixed(2)} USDT`);
        
        const tpPrice = rangeTradeSide === "BULLISH"
          ? price * (1 + rangeTpPct / 100)
          : price * (1 - rangeTpPct / 100);
        const slPrice = rangeTradeSide === "BULLISH"
          ? price * (1 - rangeSlPct / 100)
          : price * (1 + rangeSlPct / 100);
        
        // Prevent opening if position already exists (synced from exchange earlier)
        if (state.activePosition) {
          log("WARN", `[SYNC] Skipping BTC RANGE entry - position already exists!`);
          return;
        }
        
        log("TRADE",
          `🚀 BTC RANGE ENTRY ${rangeTradeSide} | ` +
          `SL:${rangeSlPct}% TP:${rangeTpPct}% | ` +
          `Lev:${leverage}x | RSI:${rsi.toFixed(1)} BB:%B:${bbData?.pctB?.toFixed(2)}`
        );
        
        const opened = await openPosition(
          rangeTradeSide === "BULLISH" ? "LONG" : "SHORT",
          leverage,
          price,
          orderQty,
          null,
          indicators,
          orderBook
        );
        
        if (opened && state.activePosition) {
          state.activePosition.stopLoss = slPrice;
          state.activePosition.takeProfit = tpPrice;
          smcState.lastEntryTime = Date.now();
          log("TRADE", `SL: ${slPrice.toFixed(2)} | TP: ${tpPrice.toFixed(2)}`);
        }
        
        // Broadcast range mode entry
        broadcastSSE({
          type: "analysis",
          price, rsi: indicators.rsi,
          ema9: indicators.ema9, ema21: indicators.ema21,
          fundingRate, 
          analysis: {
            action: rangeTradeSide,
            confidence: 80,
            regime: "RANGE",
            reasoning: `Range Mode: RSI=${rsi.toFixed(1)}, BB touch, Vol=${volRatio.toFixed(1)}`,
          },
          position: state.activePosition,
          smcData: { regime: "RANGE", atrPct: parseFloat(atrPct.toFixed(3)) },
        });
        return;
      }
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
        // Adaptive pair mode
        currentPair: state.currentPair,
        currentPairMode: state.currentPairMode,
        btcAnalysis: state.btcAnalysis,
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

    // [ATR HARD FILTER] Skip entry kalau ATR terlalu rendah (market compression)
    const atrStatus = atrPct < CONFIG.ATR_LOW_THRESHOLD ? "LOW" : atrPct > CONFIG.ATR_HIGH_THRESHOLD ? "HIGH" : "NORMAL";
    if (atrPct < CONFIG.ATR_MIN_PERCENT) {
      if (state.tickCount % 6 === 0) {
        log("FILTER", `[FILTER] ATR too low (${atrPct.toFixed(3)}%) — market compression → HOLD`);
      }
      broadcastSSE({
        type: "tick", price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
        isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
        latestCandle: klines[klines.length - 1], prediction,
        smcData: { 
          atrPct: parseFloat(atrPct.toFixed(3)), 
          atrStatus: atrStatus,
          flat: true, 
          session: session.session, 
          htfTrend: htf?.trend 
        },
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
        smcData: { htfTrend: "NEUTRAL", session: session.session, atrPct: parseFloat(atrPct.toFixed(3)), regime: currentRegime, exitMode: currentRegime === "RANGE" ? "EXIT MODE: RANGE SCALP" : "EXIT MODE: TREND RUN" },
      });
      return;
    }
    const tradeSide = htf.trend; // "BULLISH" atau "BEARISH"

  // Skip entry kalau HTF terlalu lemah — counter-trend berbahaya
  if (htf.strength === "WEAK") {
    if (state.tickCount % 6 === 0) {
      log("INFO", `HTF ${htf.trend} tapi WEAK (sep=${htf.sep}%) — skip, tunggu trend lebih jelas`);
    }
    broadcastSSE({
      type: "tick", price,
      rsi: indicators.rsi, ema9: indicators.ema9, ema21: indicators.ema21,
      fundingRate, fearGreed: externalDataCache?.fearGreed,
      position: pos, bid: ticker?.bidPrice, ask: ticker?.askPrice,
      isPaused: !!(state.pausedUntil && Date.now() < state.pausedUntil),
      latestCandle: klines[klines.length - 1], prediction,
      smcData: {
        htfTrend:    htf.trend,
        htfStrength: "WEAK",
        session:     session.session,
        atrPct:      parseFloat(atrPct.toFixed(3)),
        regime:      currentRegime,
        noEntryReason: `HTF WEAK (sep=${htf.sep}%) — tunggu trend lebih kuat`,
      },
    });
    return;
  }


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
    
    // ── STEP 5: FAKE BREAKOUT FILTER ───────────────────────────
    const fakeBreakout = detectFakeBreakout(klines5m, swings, tradeSide);
    if (fakeBreakout.detected) {
      log("SMC", `[SMC] Fake Breakout detected: ${fakeBreakout.type} at ${fakeBreakout.level?.toFixed(2)} → ${fakeBreakout.reason}`);
    }
    
    // ── STEP 1: LIQUIDITY ZONES (Equal Highs/Lows) ───────────────
    const liqZones = detectEqualHighsLows(klines5m);
    if (liqZones.equalHighs.length > 0 || liqZones.equalLows.length > 0) {
      const liqLabel = tradeSide === "BULLISH" 
        ? `Lows: ${liqZones.equalLows[0]?.price?.toFixed(2)} (${liqZones.equalLows[0]?.count}x)`
        : `Highs: ${liqZones.equalHighs[0]?.price?.toFixed(2)} (${liqZones.equalHighs[0]?.count}x)`;
      log("SMC", `[SMC] Liquidity Zone: ${liqLabel}`);
    }

    // ── E2. S/D Zone Touch + Reversal Detection ────────────
    const sdZone  = detectSDZoneTouch(klines5m, swings, tradeSide);
    const sweep   = detectLiquiditySweep(klines5m, swings, tradeSide);
    const bos     = detectBreakOfStructure(klines5m, swings, tradeSide);
    
    // ── STEP 6: CONFLUENCE SYSTEM ───────────────────────────────
    const emaTrend = tradeSide === "BULLISH" 
      ? (indicators.ema9 > indicators.ema21) 
      : (indicators.ema9 < indicators.ema21);
    const confluence = calculateConfluence(
      indicators, orderBook, choch, inFVG, liqGrab, emaTrend
    );
    
    if (!confluence.sufficient) {
      log("SMC", `[SMC] Confluence insufficient: ${confluence.count}/2 factors (${confluence.label}) → SKIP`);
    }
    
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
    const bosDirectEntry = bos.detected && htf.strength === "STRONG"
    && (choch.detected || liqGrab.detected || sweep.detected);

    // ── Mode E — BTC TREND PULLBACK (relaxed SMC: any 2 signals) ──
    const isBTCMode = state.currentPairMode === "BTC" || state.currentPairMode === "DUAL";
    const btcA      = state.btcAnalysis;
    const smcScore  = [inducmt.valid, liqGrab.detected, choch.detected, inFVG.inFVG, candleOK.confirmed]
      .filter(Boolean).length;

    // === LOSS STREAK GUARD — strategy-level pause ===
    if (isBTCMode && btcA && btcA.lossStreakPause) {
      log("WARN", `[STRATEGY] Loss streak protection active — BTC entries suppressed (streak ${stats.lossStreak})`);
    }

    // btcPullback fires when: pullback strategy agrees + at least 2 SMC signals + no conflicting direction
    const btcPullbackReady = isBTCMode
      && btcA && !btcA.error
      && btcA.action !== "HOLD"
      && !btcA.lossStreakPause
      && smcScore >= 2
      && ((btcA.action === "LONG"  && tradeSide === "BULLISH") ||
          (btcA.action === "SHORT" && tradeSide === "BEARISH"));

    const smcReady = sdReady || smcFull || revReady || bosDirectEntry || btcPullbackReady;
    
    // ── STEP 5: FAKE BREAKOUT FILTER - Skip if breakout without return ─
    // Only enter if fake breakout detected (stop hunt) OR no breakout
    const validEntry = fakeBreakout.detected || !bos.detected;
    if (!validEntry && smcReady) {
      log("SMC", `[SMC] Fake Breakout Filter: Breakout without return → SKIP (wait for confirmation)`);
      return;
    }
    
    // ── STEP 6: CONFLUENCE REQUIREMENT ─────────────────────────────
    if (!confluence.sufficient && smcReady) {
      log("SMC", `[SMC] Insufficient confluence: ${confluence.count}/2 → SKIP`);
      return;
    }

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

    // Exit mode label based on regime
    const exitModeLabel = currentRegime === "RANGE" ? "EXIT MODE: RANGE SCALP" : "EXIT MODE: TREND RUN";

    // Bangun smcData untuk broadcast (dipakai di kedua cabang)
    smcData = {
      htfTrend:      htf?.trend,
      htfStrength:   htf?.strength,
      tradeSide,
      session:       session.session,
      atrPct:        parseFloat(atrPct.toFixed(3)),
      regime:        currentRegime,
      exitMode:      exitModeLabel,
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
      log("DEBUG", `Broadcasting smcData: htfTrend=${smcData.htfTrend}, session=${smcData.session}, atrPct=${smcData.atrPct}, regime=${currentRegime}, exitMode=${exitModeLabel}, smcReady=${smcData.smcReady}`);
    }

    if (smcReady) {
      const modeLabel = sdReady
        ? `SD ZONE (${sdZone.zoneType}) CHoCH+FVG`
        : smcFull
          ? "FULL SMC"
          : (bosDirectEntry && !revReady)
            ? `BOS DIRECT (${bos.type || "BOS"})`
            : btcPullbackReady
              ? `BTC PULLBACK (SMC:${smcScore}/5 conf:${btcA?.confidence}%)`
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

      // ═══════════════════════════════════════════════════════════════
      // ADAPTIVE POSITION SIZING - Dynamic calculation before entry
      // ═══════════════════════════════════════════════════════════════
      const currentBalance = state.totalAccountBalance > 0 
        ? state.totalAccountBalance 
        : (CONFIG.DRY_RUN ? compoundedBalance + stats.totalPnL : CONFIG.POSITION_SIZE_USDT * 10);
      const phase = state.phase?.phase || 'STABLE';
      const confidence = claudeFilter.confidence || 60;
      const streak = stats.lossStreak || 0;
      
      const dynamicSizing = calcDynamicPositionSize(currentBalance, phase, confidence, streak);
      
      // Override leverage and orderQty with dynamic values
      leverage = dynamicSizing.leverage;
      const notional = dynamicSizing.notional;
      const isPepe = CONFIG.SYMBOL.includes("PEPE");
      if (isPepe) {
        // PEPE: 1 contract = 1000 PEPE, size in PEPE
        const CONTRACT_SIZE = 1000;
        const qty = notional / price;
        orderQty = Math.floor(qty / CONTRACT_SIZE) * CONTRACT_SIZE;
        if (orderQty < CONTRACT_SIZE) orderQty = CONTRACT_SIZE;
      } else {
        // BTC USDT-M: cap margin ke 80% saldo live agar tidak exceed balance
        const availBalance = state.totalAccountBalance > 0
          ? state.totalAccountBalance * 0.8
          : CONFIG.POSITION_SIZE_USDT;
        const marginUsdt = Math.min(CONFIG.POSITION_SIZE_USDT, availBalance);
        const minQty = 0.001;
        const minLevNeeded = Math.ceil((minQty * price) / marginUsdt);
        leverage = Math.min(Math.max(leverage, minLevNeeded, 3), CONFIG.MAX_LEVERAGE);
        let qty = (marginUsdt * leverage) / price;
        qty = Math.round(qty * 1000) / 1000;
        if (qty < minQty) qty = minQty;
        orderQty = qty;
      }

      log("INFO", `📊 BTC Trend Order: Qty=${orderQty} BTC | Lev=${leverage}x | Margin≈${(orderQty * price / leverage).toFixed(2)} USDT`);

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
        smcMode:      sdReady ? "SD_ZONE" : smcFull ? "FULL_SMC" : (bosDirectEntry && !revReady) ? "BOS_DIRECT" : btcPullbackReady ? "BTC_PULLBACK" : "REVERSAL_ONLY",
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
      } else if (btcPullbackReady) {
        // Mode E: BTC Trend Pullback — direct entry, no Claude call
        const btcConf = Math.min(85, (btcA.confidence || 58));
        claudeFilter = {
          approve:    true,
          confidence: btcConf,
          reason:     btcA.reason || `BTC pullback ${btcA.action} SMC:${smcScore}/5`,
          risk:       btcConf >= 70 ? "LOW" : "MEDIUM",
          direct:     true,
        };
        log("TRADE",
          `₿ BTC PULLBACK [${tradeSide}] ${btcA.action} | ` +
          `RSI:${btcA.rsi?.toFixed(1)} ATR:${btcA.atrPct?.toFixed(3)}% SMC:${smcScore}/5 | ` +
          `Conf:${btcConf}% → MASUK LANGSUNG`
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

      // Add entry metrics to smcData for dashboard
      smcData.entryScore = entryScore;
      smcData.entryMode = entryMode;
      smcData.atrStatus = atrStatus;
      smcData.confidenceRequired = CONFIG.OPEN_CONFIDENCE;
      smcData.claudeFilter = claudeFilter;

      // ═══════════════════════════════════════════════════
      // ENTRY QUALITY SCORE (BTC 15m optimized)
      // ═══════════════════════════════════════════════════
      const ema9 = indicators.ema9 || price;
      const ema21 = indicators.ema21 || price;
      const rsi = indicators.rsi || 50;
      
      // Trend direction
      const trendAligned = tradeSide === "BULLISH" ? (ema9 > ema21) : (ema9 < ema21);
      
      // RSI pullback zone (trend continuation)
      const rsiPullback = tradeSide === "BULLISH" 
        ? (rsi >= 42 && rsi <= 50) 
        : (rsi >= 50 && rsi <= 58);
      
      // Volume confirmation
      const volumeConfirmed = indicators.volumeRatio >= 0.8;
      
      // ATR valid
      const atrValid = atrPct >= CONFIG.ATR_MIN_PERCENT;
      
      // ═══════════════════════════════════════════════════════════════
      // STEP 5: ENTRY FILTER - Skip if expected move < 0.3%
      // ═══════════════════════════════════════════════════════════════
      const expectedMove = atrPct * 1.5;  // Expected move = ATR * 1.5
      const MIN_EXPECTED_MOVE = 0.3;  // Minimum 0.3% expected move
      if (expectedMove < MIN_EXPECTED_MOVE) {
        log("FILTER", `[FILTER] Expected move ${expectedMove.toFixed(2)}% < MIN ${MIN_EXPECTED_MOVE}% (ATR=${atrPct.toFixed(2)}%) → SKIP`);
        return;
      }
      
      // AI agrees
      const aiAgrees = claudeFilter.approve;
      
      // Calculate score
      let entryScore = 0;
      if (trendAligned) entryScore += 30;
      if (rsiPullback) entryScore += 25;
      if (volumeConfirmed) entryScore += 20;
      if (atrValid) entryScore += 15;
      if (aiAgrees) entryScore += 10;
      
      // Entry mode label
      const entryMode = (trendAligned && rsiPullback) ? "TREND_PULLBACK" : "MOMENTUM";
      
      log("ENTRY", `[ENTRY SCORE] ${entryScore}/100 → ${entryScore >= CONFIG.ENTRY_SCORE_MIN ? 'VALID' : 'INVALID'} | ` +
        `Trend:${trendAligned?'✅':'❌'}(${tradeSide}) RSI:${rsiPullback?'✅':'❌'} Vol:${volumeConfirmed?'✅':'❌'} ATR:${atrValid?'✅':'❌'} AI:${aiAgrees?'✅':'❌'}`);
      
      log("ENTRY", `[ENTRY CHECK] AI confidence ${claudeFilter.confidence}% / Required ${CONFIG.OPEN_CONFIDENCE}%`);

      // ═══════════════════════════════════════════════════════════════
      // BB SQUEEZE PROTECTION - Enhanced
      // Block entry if squeeze is active unless confirmed breakout with volume
      // ═══════════════════════════════════════════════════════════════
      const squeezeActive = squeezeData?.squeeze || false;
      const breakoutConfirmed = squeezeData?.breakoutDirection !== "NONE";
      const volumeExpansion = indicators.volumeRatio > 1.2;
      
      // Check if price is outside Bollinger bands (breakout)
      const priceOutsideBB = bbData && (price > bbData.upper || price < bbData.lower);
      
      // Allow entry only if:
      // 1. No squeeze active, OR
      // 2. Squeeze active AND breakout confirmed with volume expansion
      const squeezeSafe = !squeezeActive || (breakoutConfirmed && volumeExpansion);
      
      // Log squeeze status
      if (squeezeActive && !breakoutConfirmed) {
        log("FILTER", "[FILTER] BB SQUEEZE ACTIVE - Market compression - breakout risk → HOLD");
      } else if (squeezeActive && breakoutConfirmed && !volumeExpansion) {
        log("FILTER", "[FILTER] BB BREAKOUT detected but volume too low (${indicators.volumeRatio.toFixed(1)}) → HOLD");
      } else if (squeezeActive && breakoutConfirmed && volumeExpansion) {
        log("FILTER", "[FILTER] BB BREAKOUT + VOLUME CONFIRMED - Entry allowed ✅");
      }
      
      const volumeTooLow = indicators.volumeRatio < 0.5;
      
      if (volumeTooLow) {
        log("FILTER", "[FILTER] Volume too low (${indicators.volumeRatio.toFixed(1)}) → HOLD");
      }
      
      // ════════════════════════════════════════════════════════════
      // MODE 8: DAILY TRADE LIMIT
      // ════════════════════════════════════════════════════════════
      const todayDate = new Date().toISOString().slice(0, 10);
      if (state.dailyTradeDate !== todayDate) {
        state.dailyTradeDate  = todayDate;
        state.dailyTradeCount = 0;  // reset at midnight
      }
      const dailyLimit = CONFIG.SNIPER_MODE ? CONFIG.MAX_SNIPER_TRADES : CONFIG.MAX_TRADES_PER_DAY;
      if (state.dailyTradeCount >= dailyLimit) {
        if (state.tickCount % 12 === 0)
          log("FILTER", `[MODE 8] Daily limit reached (${state.dailyTradeCount}/${dailyLimit}) → SKIP until tomorrow`);
        return;
      }

      // ════════════════════════════════════════════════════════════
      // MODE 9: MARKET FILTER — block ASIA + low volume
      // ════════════════════════════════════════════════════════════
      if (CONFIG.BLOCK_ASIA_SESSION && session.session === "ASIA") {
        if (state.tickCount % 9 === 0)
          log("FILTER", `[MODE 9] ASIA session — SNIPER only trades London/NY → SKIP`);
        return;
      }
      if (indicators.volumeRatio < CONFIG.MIN_VOLUME_RATIO) {
        if (state.tickCount % 6 === 0)
          log("FILTER", `[MODE 9] Market choppy — Vol ${indicators.volumeRatio.toFixed(2)}x < ${CONFIG.MIN_VOLUME_RATIO}x → SKIP`);
        return;
      }

      // ════════════════════════════════════════════════════════════
      // MODE 1: SNIPER ENTRY — ALL conditions must pass
      // ════════════════════════════════════════════════════════════
      const sniperVolOk     = indicators.volumeRatio >= CONFIG.ENTRY_MIN_VOLUME;
      const sniperEmaOk     = trendAligned; // EMA9 > EMA21 (LONG) or EMA9 < EMA21 (SHORT)
      const sniperAtrOk     = atrPct >= CONFIG.ATR_MIN_PERCENT;
      const sniperSessionOk = session.session === "LONDON" || session.session === "NEW_YORK"
                              || session.session === "ALL_SESSIONS";
      const sniperSideways  = !squeezeActive || squeezeSafe;

      const sniperFails = [
        !sniperVolOk     && `Vol ${indicators.volumeRatio.toFixed(2)}x < 1.2x`,
        !sniperEmaOk     && `EMA not aligned for ${tradeSide}`,
        !sniperAtrOk     && `ATR ${atrPct.toFixed(3)}% too low`,
        !sniperSessionOk && `Session ${session.session} not London/NY`,
        !sniperSideways  && `Sideways/squeeze active`,
      ].filter(Boolean);

      if (CONFIG.SNIPER_MODE && sniperFails.length > 0) {
        if (state.tickCount % 6 === 0)
          log("FILTER", `[MODE 1 SNIPER] SKIP — ${sniperFails.join(' | ')}`);
        return;
      }

      // ════════════════════════════════════════════════════════════
      // MODE 2: ENTRY QUALITY CLASSIFICATION
      // PERFECT (score≥85 + conf≥70) → 100% size
      // GOOD    (score≥70 + conf≥65) → 70% size
      // WEAK                          → SKIP
      // ════════════════════════════════════════════════════════════
      let entryQuality;
      let entryQualityFactor; // position size multiplier
      if (entryScore >= 85 && claudeFilter.confidence >= 70) {
        entryQuality       = "PERFECT";
        entryQualityFactor = 1.0;
      } else if (entryScore >= 70 && claudeFilter.confidence >= 65) {
        entryQuality       = "GOOD";
        entryQualityFactor = 0.70;
      } else {
        if (state.tickCount % 4 === 0)
          log("FILTER", `[MODE 2] WEAK setup — score:${entryScore} conf:${claudeFilter.confidence}% → SKIP`);
        return;
      }
      log("ENTRY", `[MODE 2] ${entryQuality} setup → pos size ×${entryQualityFactor} | score:${entryScore} conf:${claudeFilter.confidence}%`);

      // ════════════════════════════════════════════════════════════
      // SD Zone & BOS Direct: threshold 65 | SMC/Reversal: 70
      // DRY_RUN: adaptive confidence boost applied on loss streak
      // ════════════════════════════════════════════════════════════
      const adaptive = CONFIG.DRY_RUN ? getAdaptiveRisk(stats.lossStreak || 0) : null;
      if (adaptive && adaptive.confidenceBoost > 0) {
        log("INFO",
          `[DRY_RUN] Adaptive risk: ${adaptive.label} | ` +
          `risk×${adaptive.riskMultiplier} conf+${adaptive.confidenceBoost}`
        );
      }
      const baseConfThreshold = CONFIG.OPEN_CONFIDENCE; // 65 (Sniper mode)
      const confThreshold = baseConfThreshold + (adaptive?.confidenceBoost ?? 0);

      // ── ANTI-LOSS STREAK: Get adaptive minimum confidence ───────────
      const adaptiveRisk = getAdaptiveRisk(stats.lossStreak || 0);
      const MIN_CONFIDENCE = Math.max(adaptiveRisk.minConfidence || 55, CONFIG.OPEN_CONFIDENCE);

      // ── SMART FILTER: Check loss streak filters ──────────────────────
      const lossStreakFilter = checkLossStreakFilters(
        stats,
        orderBook,
        choch,
        indicators.volumeRatio
      );

      // ── LOW QUALITY TRADE FILTER: Skip if confidence < MIN ───────
      if (claudeFilter.confidence < MIN_CONFIDENCE) {
        if (state.tickCount % 6 === 0) {
          log("FILTER", `[FILTER] Low confidence ${claudeFilter.confidence}% < ${MIN_CONFIDENCE}% → SKIP`);
        }
        return;
      }
      
      // ── LOSS STREAK SMART FILTER ─────────────────────────────────
      if (!lossStreakFilter.allowed) {
        if (state.tickCount % 6 === 0) {
          log("LOSS PROTECTION", `[LOSS PROTECTION] Loss streak filters blocked entry: ${lossStreakFilter.reason}`);
        }
        return;
      }

      // ── I. Entry ────────────────────────────────────────
      // Allow entry if: score >= 70 AND confidence >= threshold AND squeeze is safe
      if (entryScore >= CONFIG.ENTRY_SCORE_MIN &&
          claudeFilter.confidence >= confThreshold &&
          squeezeSafe &&
          !volumeTooLow) {

        // Mode 3: Compound position size based on balance %
        const balNow = state.totalAccountBalance > 0
          ? state.totalAccountBalance
          : (CONFIG.DRY_RUN ? compoundedBalance + (stats.totalPnL || 0) : compoundedBalance);
        let riskPct;
        if      (balNow < 50)  riskPct = 0.05;
        else if (balNow < 100) riskPct = 0.06;
        else if (balNow < 200) riskPct = 0.07;
        else                   riskPct = 0.09; // 8–10%, use 9% average
        const maxLossPerTrade = balNow * 0.02; // Mode 3: max loss = 2% balance
        let sniperMarginUSDT = balNow * riskPct * state.capitalGrowthFactor * entryQualityFactor;
        // Cap so max loss doesn't exceed 2% (SL covers the stop)
        const slFraction = (slPct || CONFIG.STOP_LOSS_PCT) / 100;
        const maxMarginFromRisk = maxLossPerTrade / (slFraction * leverage);
        sniperMarginUSDT = Math.min(sniperMarginUSDT, maxMarginFromRisk, balNow * 0.15);
        sniperMarginUSDT = Math.max(sniperMarginUSDT, 2); // minimum 2 USDT

        // Recalculate qty from sniper margin
        const isPepeEntry = (state.currentPair || CONFIG.SYMBOL).includes("PEPE");
        let sniperQty;
        if (isPepeEntry) {
          const CONTRACT_SIZE = 1000;
          sniperQty = Math.floor((sniperMarginUSDT * leverage / price) / CONTRACT_SIZE) * CONTRACT_SIZE;
          if (sniperQty < CONTRACT_SIZE) sniperQty = CONTRACT_SIZE;
        } else {
          let qty = (sniperMarginUSDT * leverage) / price;
          qty = Math.round(qty * 1000) / 1000;
          if (qty < 0.001) qty = 0.001;
          sniperQty = qty;
        }
        log("TRADE",
          `🎯 SNIPER ENTRY ${tradeSide} [${entryQuality}] | ` +
          `SL:${slPct.toFixed(3)}% TP:${tpPct.toFixed(3)}% ` +
          `Lev:${leverage}x | Margin:${sniperMarginUSDT.toFixed(2)} USDT (${(riskPct*100).toFixed(0)}% bal) | ` +
          `Claude:${claudeFilter.confidence}% score:${entryScore}`
        );

        // Prevent opening if position already exists
        if (state.activePosition) {
          log("WARN", `[SYNC] Skipping SMC entry - position already exists!`);
          return;
        }

        const opened = await openPosition(
          tradeSide === "BULLISH" ? "LONG" : "SHORT",
          leverage,
          price,
          sniperQty,
          null,
          indicators,
          orderBook
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
          // Mode 8: count trade
          state.dailyTradeCount = (state.dailyTradeCount || 0) + 1;
          // Mode 5: reset scale-in flag
          state.scaleInDone = false;
          // Store quality for dashboard
          state.activePosition._entryQuality       = entryQuality;
          state.activePosition._entryQualityFactor = entryQualityFactor;
          state.activePosition._entryRiskPct       = riskPct;
          state.activePosition._dailyTradeNum      = state.dailyTradeCount;
          log("TRADE",
            `SL: ${state.activePosition.stopLoss?.toFixed(8) ?? '--'} | ` +
            `TP: ${state.activePosition.takeProfit?.toFixed(8) ?? '--'} | ` +
            `Daily trade #${state.dailyTradeCount}/${dailyLimit}`
          );
          // ── Supabase: store SMC + AI context on position for closePosition ──
          state.activePosition._smcData      = smcData;
          state.activePosition._claudeFilter = claudeFilter;
          state.activePosition._entryScore   = entryScore;
          state.activePosition._entryMode    = entryMode;
          state.activePosition._entryAtrPct  = atrPct;
          state.activePosition._entrySession = session.session;
          state.activePosition._entryBbPctB  = bbData?.pctB        ?? null;
          state.activePosition._entryBbBandwidth = bbData?.bandwidth ?? null;
          state.activePosition._entryBbPosition  = squeezeData?.pricePosition ?? null;
          state.activePosition._entryVwapPct = vwapPct ?? null;
          state.activePosition._entrySqueeze = squeezeData?.squeeze ?? null;
          state.activePosition._entryFundingRate = fundingRate ?? null;
          state.activePosition._entryFearGreed   = externalDataCache?.fearGreed ?? null;
          state.activePosition._entryObBidAsk    = orderBook?.bidAskRatio ?? null;
          state.activePosition._entryObSpread    = orderBook?.spread ?? null;

          // ── Supabase: save signal (approved) ────────────────────────────
          db.saveSignal({
            symbol:       state.currentPair || CONFIG.SYMBOL,
            pairMode:     state.currentPairMode,
            session:      session.session,
            action:       tradeSide === "BULLISH" ? "LONG" : "SHORT",
            approved:     true,
            price,
            indicators:   { ...indicators, atrPct, bbPctB: bbData?.pctB, bbBandwidth: bbData?.bandwidth,
                            vwapPct, squeeze: squeezeData?.squeeze, fundingRate,
                            fearGreed: externalDataCache?.fearGreed,
                            orderbookBidAskRatio: orderBook?.bidAskRatio,
                            orderbookSpread: orderBook?.spread },
            smcData:      { ...smcData, smcScore },
            claudeFilter,
            entryScore,
            entryMode,
            confThreshold,
            regime:       currentRegime,
            phase:        state.phase,
            stats:        { lossStreak: stats.lossStreak },
            openedTradeId: db.makeTradeId(state.currentPair || CONFIG.SYMBOL, state.activePosition.openTime),
            dryRun:       CONFIG.DRY_RUN,
          }).catch(() => {});
        }
      } else {
        log("AI",
          `Claude REJECT — ${claudeFilter.reason} ` +
          `(conf:${claudeFilter.confidence}%) — tunggu setup berikutnya`
        );
        // ── Supabase: save rejected signal ──────────────────────────────
        db.saveSignal({
          symbol:       state.currentPair || CONFIG.SYMBOL,
          pairMode:     state.currentPairMode,
          session:      session.session,
          action:       tradeSide === "BULLISH" ? "LONG" : "SHORT",
          approved:     false,
          rejectReason: `conf:${claudeFilter.confidence}%<${confThreshold} — ${claudeFilter.reason}`,
          price,
          indicators:   { ...indicators, atrPct, bbPctB: bbData?.pctB, bbBandwidth: bbData?.bandwidth,
                          vwapPct, squeeze: squeezeData?.squeeze, fundingRate,
                          fearGreed: externalDataCache?.fearGreed,
                          orderbookBidAskRatio: orderBook?.bidAskRatio,
                          orderbookSpread: orderBook?.spread },
          smcData:      { ...smcData, smcScore },
          claudeFilter,
          entryScore,
          entryMode,
          confThreshold,
          regime:       currentRegime,
          phase:        state.phase,
          stats:        { lossStreak: stats.lossStreak },
          dryRun:       CONFIG.DRY_RUN,
        }).catch(() => {});
      }

      broadcastSSE({
        type: "analysis",
        price, rsi: indicators.rsi,
        ema9: indicators.ema9, ema21: indicators.ema21,
        fundingRate, fearGreed: externalDataCache?.fearGreed,
        analysis: {
          action:          entryScore >= CONFIG.ENTRY_SCORE_MIN && claudeFilter.confidence >= confThreshold && squeezeSafe && !volumeTooLow
            ? (tradeSide === "BULLISH" ? "LONG" : "SHORT") : "HOLD",
          confidence:      claudeFilter.confidence,
          entryScore:      entryScore,
          entryMode:       entryMode,
          atrStatus:       atrStatus,
          confidenceReq:    CONFIG.OPEN_CONFIDENCE,
          sentiment:       tradeSide,
          leverage:        CONFIG.DEFAULT_LEVERAGE,
          stop_loss_pct:   slPct,
          take_profit_pct: tpPct,
          reasoning:       claudeFilter.direct
            ? `BOS Direct Entry: ${claudeFilter.reason}`
            : `SMC+Claude: ${claudeFilter.approve ? "✅" : "❌"} — ${claudeFilter.reason}`,
          regime:          currentRegime,
          squeezeSafe:     squeezeSafe,
          squeezeActive:   squeezeActive,
          breakoutConfirmed: breakoutConfirmed,
          volumeExpansion: volumeExpansion,
        },
        position:    state.activePosition,
        bb:          bbData,
        squeeze:     squeezeData,
        vwap,
        vwapPct,
        candlePatterns,
        externalData: externalDataCache,
        latestCandle: klines[klines.length - 1],
        smcData: { regime: currentRegime, atrPct: parseFloat(atrPct.toFixed(3)), squeezeSafe, squeezeActive, breakoutConfirmed },
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
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify({
    activePosition:   state.activePosition,
    compoundedBalance,
    initialBalance:   state.initialBalance,
  }, null, 2));
}

function saveStats() {
  fs.writeFileSync(CONFIG.STATS_FILE, JSON.stringify(stats, null, 2));
}

function recordTrade(type, side, price, size, leverage, liqPrice, reason = "", pnlUSDT = 0, notionalUSDT = null) {
  const trade = {
    type, side, price, size, leverage, liqPrice, reason, pnlUSDT,
    notionalUSDT: notionalUSDT ?? parseFloat((size * price).toFixed(4)),
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
      // Restore compoundedBalance agar P&L tidak reset ke -18 setiap PM2 reload
      if (saved.compoundedBalance && saved.compoundedBalance > 0) {
        compoundedBalance = saved.compoundedBalance;
        log("INFO", `compoundedBalance dipulihkan: ${compoundedBalance.toFixed(4)} USDT`);
      }
      if (saved.initialBalance && saved.initialBalance > 0) {
        state.initialBalance = saved.initialBalance;
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

// Dashboard HTML served from dashboard/index.html
function getDashboardHTML() {
  const htmlPath = path.join(__dirname, "dashboard", "index.html");
  if (fs.existsSync(htmlPath)) return fs.readFileSync(htmlPath, "utf8");
  return "<h1>Dashboard not found. Ensure dashboard/index.html exists.</h1>";
}

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
        totalAccountBalance: state.totalAccountBalance || 0,
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
        botStopped:  !state.running,
        balance:     _initBal,
        externalData: externalDataCache,
        isPaused:    !!(state.pausedUntil && Date.now() < state.pausedUntil),
        tradeLog:    tradeLog.slice(-50),
        klines:      state.lastKlines.slice(-150),
        phase:       state.phase,
        phaseCooldownLeft: state.phaseCooldownLeft,
        symbol:      CONFIG.SYMBOL,
      })}\n\n`);

      req.on("close", () => {
        state.dashboardClients = state.dashboardClients.filter((c) => c !== res);
      });
    } else if (req.url?.startsWith("/api/klines")) {
      // Parse query params
      const urlObj  = new URL(req.url, 'http://localhost');
      const tf      = urlObj.searchParams.get('tf')     || '5m';
      const limit   = parseInt(urlObj.searchParams.get('limit') || '150');
      const symParam = urlObj.searchParams.get('symbol') || null;

      // Map TF ke granularity Bitget
      const tfMap = {
        '1m': '1m', '5m': '5m', '15m': '15m',
        '1H': '1H', '4H': '4H', '1D': '1D',
      };
      const granularity = tfMap[tf] || '5m';

      try {
        let klines;
        if (symParam && symParam !== CONFIG.SYMBOL) {
          // Fetch klines for a different symbol (e.g. PEPEUSDT in dual mode)
          const altRes = await bitgetRequest("GET", "/api/v2/mix/market/candles", {
            symbol:      symParam,
            productType: CONFIG.PRODUCT_TYPE,
            granularity,
            limit:       Math.min(limit, 200).toString(),
          });
          if (altRes.code !== "00000") throw new Error(`Klines error: ${altRes.msg}`);
          klines = altRes.data.map((c) => ({
            time:   parseInt(c[0]),
            open:   parseFloat(c[1]),
            high:   parseFloat(c[2]),
            low:    parseFloat(c[3]),
            close:  parseFloat(c[4]),
            volume: parseFloat(c[5]),
          })).reverse();
          if (klines.length >= 2 && klines[0].time > klines[klines.length - 1].time) {
            klines.reverse();
          }
        } else {
          klines = await getKlines(granularity, Math.min(limit, 200));
        }
        res.writeHead(200, {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ klines, tf, granularity, symbol: symParam || CONFIG.SYMBOL }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, klines: [] }));
      }
    } else if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: { lastPrice: state.lastPrice, activePosition: state.activePosition }, stats }));
    } else if (req.url === "/api/reset" && req.method === "POST") {
      // ── FULL RESET — bot TIDAK otomatis restart ──────────────
      // 1. Reset balance & compound
      compoundedBalance      = CONFIG.POSITION_SIZE_USDT;
      state.initialBalance   = compoundedBalance;
      state.currentBalance   = compoundedBalance;
      state.peakBalance      = compoundedBalance;
      state.lowestBalance    = compoundedBalance;
      state.balanceHistory   = [];

      // 2. Reset semua stats — termasuk win rate tracker
      stats.totalPnL    = 0;
      stats.totalTrades = 0;
      stats.wins        = 0;
      stats.losses      = 0;
      stats.winStreak   = 0;
      stats.lossStreak  = 0;
      stats.maxDrawdown = 0;
      stats.bestTrade   = 0;
      stats.worstTrade  = 0;
      stats.recentTrades  = [];
      stats.winRate7d     = 0;
      stats.avgProfitPct  = 0;
      stats.avgLossPct    = 0;
      stats.currentStreak = 0;
      stats.startTime     = new Date().toISOString();

      // 3. Reset posisi aktif dan trade log
      state.activePosition   = null;
      state.pepePosition     = null;
      state.btcPosition      = null;
      tradeLog.length        = 0;

      // 4. Reset SMC state dan cooldown
      smcState.lastEntryTime  = 0;
      smcState.lastSLPrice    = null;
      smcState.pendingSignal  = null;
      smcState.pendingCandleCount = 0;
      state.pausedUntil       = null;
      state.pauseReason       = "";

      // 5. Reset Phase Indicator
      state.phase             = null;
      state.phaseCooldownLeft = 0;

      // 6. Tulis ulang file JSON supaya PM2 reload tidak load data lama
      fs.writeFileSync(CONFIG.TRADES_FILE, "[]");
      saveStats();
      saveState();

      // 7. Broadcast update ke dashboard
      broadcastSSE({ type: "stats", ...stats, compoundBalance: compoundedBalance, dryRun: CONFIG.DRY_RUN });
      broadcastSSE({ type: "trade", trade: null, tradeLog: [] });
      broadcastSSE({ type: "reset", message: "Data simulasi direset — klik Start Bot untuk mulai lagi" });
      broadcastSSE({ type: "phase", phase: null });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Data simulasi direset. Klik Start Bot untuk mulai trading." }));
      log("INFO", `Data simulasi direset via dashboard — balance: ${compoundedBalance} USDT (bot masih berhenti)`);
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
          broadcastSSE({ type: "stats", ...stats, compoundBalance: compoundedBalance, dryRun: CONFIG.DRY_RUN });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: `Saldo +${topup} USDT → ${state.currentBalance.toFixed(2)} USDT`, balance: state.currentBalance }));
          log("INFO", `[DRY RUN] Top up +${topup} USDT → saldo simulasi: ${state.currentBalance.toFixed(2)} USDT`);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: "Body tidak valid" }));
        }
      });
      return;
    } else if (req.url?.startsWith("/api/orderbook") && req.method === "GET") {
      const symbol = new URL(req.url, "http://localhost").searchParams.get("symbol") || CONFIG.SYMBOL;
      try {
        const r = await bitgetRequest("GET", "/api/v2/mix/market/merge-depth", {
          symbol, productType: CONFIG.PRODUCT_TYPE, limit: "15",
        });
        const bids = (r.data?.bids || []).slice(0, 15).map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
        const asks = (r.data?.asks || []).slice(0, 15).map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
        const totalBid = bids.reduce((s, b) => s + b.qty, 0);
        const totalAsk = asks.reduce((s, a) => s + a.qty, 0);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, symbol, bids, asks, totalBid, totalAsk, bidAskRatio: totalBid / (totalAsk || 1) }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message, bids: [], asks: [] }));
      }
    } else if (req.url?.startsWith("/api/market-trades") && req.method === "GET") {
      const symbol = new URL(req.url, "http://localhost").searchParams.get("symbol") || CONFIG.SYMBOL;
      try {
        const r = await bitgetRequest("GET", "/api/v2/mix/market/fills", {
          symbol, productType: CONFIG.PRODUCT_TYPE, limit: "30",
        });
        const trades = (r.data || []).map(t => ({
          price:  parseFloat(t.price),
          size:   parseFloat(t.size),
          side:   t.side === "buy" ? "BUY" : "SELL",
          time:   t.ts ? new Date(Number(t.ts)).toLocaleTimeString("id-ID") : "--",
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, symbol, trades }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message, trades: [] }));
      }
    } else if (req.url === "/api/position-history" && req.method === "GET") {
      if (CONFIG.DRY_RUN) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, dryRun: true, data: [] }));
        return;
      }
      try {
        const histRes = await bitgetRequest("GET", "/api/v2/mix/position/history-position", {
          productType: CONFIG.PRODUCT_TYPE,
          limit: "20",
        });
        const rawList = histRes.data?.list || histRes.data || [];
        if (rawList.length > 0) {
          log("INFO", `[HISTORY] Fields: ${Object.keys(rawList[0]).join(", ")}`);
        }
        const rows = rawList.map(p => {
          // Bitget v2 field names (berbeda dari v1)
          const entryPrice = parseFloat(
            p.openAvgPrice || p.openPriceAvg || p.entryPrice || p.openPrice || 0
          );
          const exitPrice = parseFloat(
            p.closeAvgPrice || p.closePriceAvg || p.exitPrice || p.closePrice || 0
          );
          const openTs  = p.cTime || p.ctime || p.openTime  || p.createTime;
          const closeTs = p.uTime || p.utime || p.closeTime || p.updateTime;
          const lev     = p.leverage || p.lever;
          const size    = parseFloat(p.closeTotalPos || p.openTotalPos || p.total || p.size || 0);
          const pnl     = parseFloat(p.pnl || p.realizedPL || p.netProfit || 0);
          // ROI = pnl / margin, margin = entryPrice * size / leverage
          const margin  = lev && entryPrice && size ? (entryPrice * size / parseFloat(lev)) : 0;
          const roi     = margin > 0 ? (pnl / margin) * 100 : parseFloat(p.pnlRate || 0) * 100;
          return {
            symbol:     p.symbol,
            side:       (p.holdSide || p.side || "long") === "long" ? "Long" : "Short",
            leverage:   lev || "--",
            marginMode: (p.marginMode || "") === "isolated" ? "Isolated" : "Cross",
            openTime:   openTs  ? new Date(Number(openTs)).toLocaleString("id-ID")  : "--",
            closeTime:  closeTs ? new Date(Number(closeTs)).toLocaleString("id-ID") : "--",
            entryPrice,
            exitPrice,
            size,
            pnl,
            roi,
          };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: rows }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message, data: [] }));
      }
    } else if (req.url?.startsWith("/api/supabase/trades") && req.method === "GET") {
      // ── Supabase: ambil riwayat trade dari DB ─────────────────
      const urlQ   = new URL(req.url, "http://localhost");
      const limit  = Math.min(parseInt(urlQ.searchParams.get("limit") || "50"), 200);
      const symbol = urlQ.searchParams.get("symbol") || null;
      const result = urlQ.searchParams.get("result") || null; // WIN|LOSS|BE
      const from   = urlQ.searchParams.get("from")   || null; // ISO date

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });

      if (!db.isEnabled()) {
        res.end(JSON.stringify({ ok: false, error: "Supabase tidak aktif — set SUPABASE_URL dan SUPABASE_SERVICE_KEY di .env", data: [] }));
        return;
      }

      try {
        const { createClient } = require("@supabase/supabase-js");
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        let q = sb.from("trades")
          .select("trade_id,symbol,side,regime,entry_price,exit_price,size,leverage,notional_usdt,open_time,close_time,duration_sec,pnl_pct,pnl_usdt,fee_usdt,net_profit_usdt,result,close_reason,exit_type,breakeven_set,runner_activated,lock_level,max_profit_pct,max_drawdown_pct,entry_rsi,entry_ema_trend,entry_volume_ratio,entry_atr_pct,entry_session,entry_fear_greed,entry_smc_mode,entry_smc_score,entry_rev_score,entry_score,ai_confidence,ai_decision,ai_risk,phase,loss_streak_at_entry,dry_run")
          .order("close_time", { ascending: false })
          .limit(limit);
        if (symbol) q = q.eq("symbol", symbol);
        if (result) q = q.eq("result", result);
        if (from)   q = q.gte("close_time", from);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        res.end(JSON.stringify({ ok: true, count: data.length, data }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: err.message, data: [] }));
      }

    } else if (req.url?.startsWith("/api/supabase/stats") && req.method === "GET") {
      // ── Supabase: ambil bot_stats ──────────────────────────────
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });

      if (!db.isEnabled()) {
        res.end(JSON.stringify({ ok: false, error: "Supabase tidak aktif", data: null }));
        return;
      }

      try {
        const { createClient } = require("@supabase/supabase-js");
        const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const key = CONFIG.DRY_RUN ? "dry_run" : "live";
        const { data, error } = await sb.from("bot_stats").select("*").eq("stat_key", key).single();
        if (error) throw new Error(error.message);
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: err.message, data: null }));
      }

    } else if (req.url?.startsWith("/api/supabase/equity") && req.method === "GET") {
      // ── Supabase: ambil equity_history ─────────────────────────
      const urlQ  = new URL(req.url, "http://localhost");
      const limit = Math.min(parseInt(urlQ.searchParams.get("limit") || "200"), 1000);

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });

      if (!db.isEnabled()) {
        res.end(JSON.stringify({ ok: false, error: "Supabase tidak aktif", data: [] }));
        return;
      }

      try {
        const { createClient } = require("@supabase/supabase-js");
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data, error } = await sb.from("equity_history")
          .select("ts,balance,initial_balance,equity_pct,total_pnl,drawdown_pct,has_position,phase")
          .eq("dry_run", CONFIG.DRY_RUN)
          .order("ts", { ascending: false })
          .limit(limit);
        if (error) throw new Error(error.message);
        res.end(JSON.stringify({ ok: true, count: data.length, data: data.reverse() }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: err.message, data: [] }));
      }

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
      broadcastSSE({ type: "stats", ...stats, compoundBalance: compoundedBalance, dryRun: CONFIG.DRY_RUN });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: `Bot dimulai. Saldo baseline: ${state.currentBalance.toFixed(2)} USDT` }));
      log("INFO", "Bot di-start manual via dashboard");
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHTML());
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
      // Adaptive pair mode
      currentPair:      state.currentPair,
      currentPairMode:  state.currentPairMode,
      pairSelectionReason: state.pairSelectionReason,
      // Info cooldown kalau aktif (only meaningful in LIVE mode)
      cooldownActive:   !CONFIG.DRY_RUN && !!(state.pausedUntil && Date.now() < state.pausedUntil),
      cooldownReason:   state.pauseReason,
      cooldownResumeAt: state.pausedUntil,
      // Phase Indicator
      phase:            state.phase,
      phaseCooldownLeft: state.phaseCooldownLeft,
      dryRun:           CONFIG.DRY_RUN,
      // Trading mode label
      tradingModeLabel: CONFIG.DRY_RUN
        ? "🧪 TRAINING MODE (NO COOLDOWN)"
        : (lossStreak >= 5 ? "🚨 DEFENSIVE MODE" : "🟢 NORMAL TRADING"),
      isDryRun: CONFIG.DRY_RUN,
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
        // Adaptive pair mode
        currentPair: state.currentPair,
        currentPairMode: state.currentPairMode,
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
  console.log(`  ${C.yellow}ADAPTIVE AUTO PAIR TRADING SYSTEM — Daffabot2${C.reset}`);
  console.log(`  ${C.gray}Exchange: Bitget USDT-M Perpetual | AI: Claude AI${C.reset}`);
  console.log(`  ${C.gray}Auto-switch: BTCUSDT ↔ PEPEUSDT based on market conditions${C.reset}`);
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
  
  // Reset hype state on bot start to allow fresh pair selection
  resetHypeState();
  log("INFO", "🔄 Hype state reset - fresh pair selection");

  log("INFO", `Mode        : ${CONFIG.DRY_RUN ? C.yellow + "DRY RUN (simulasi)" + C.reset : C.red + "LIVE TRADING!" + C.reset}`);
  log("INFO", `Pair        : ${CONFIG.ADAPTIVE_PAIR_ENABLED ? C.cyan + "ADAPTIVE (BTC/PEPE)" + C.reset : CONFIG.SYMBOL}`);
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

  // Supabase data layer
  db.initSupabase();

  // Self-learning engine
  learningEngine.initLearning();

  // Load data tersimpan
  loadPersistedData();
  // Evaluasi phase langsung dari data yang sudah di-load
  // supaya dashboard tidak perlu menunggu trade close pertama
  state.phase = evaluatePhase(tradeLog, stats);
  log("INFO", phaseLogLine(state.phase));

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
    // Pakai compoundedBalance yang sudah dipulihkan dari state.json (atau default POSITION_SIZE_USDT)
    // Jangan hardcode ×10 karena menyebabkan P&L selalu -18 setelah reload
    if (!state.initialBalance || state.initialBalance <= 0) {
      state.initialBalance = compoundedBalance;
    }
    state.currentBalance = compoundedBalance + (stats.totalPnL || 0);
    log("INFO", `[DRY RUN] Balance simulasi: ${compoundedBalance.toFixed(4)} USDT | P&L tersimpan: ${(stats.totalPnL || 0).toFixed(4)} USDT`);
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

  // Self-learning cycle - run every 30 minutes (DRY RUN only)
  const LEARNING_INTERVAL_MS = 30 * 60 * 1000;
  setInterval(async () => {
    if (!learningEngine.isEnabled()) return;
    
    // Check eligibility first
    const eligibility = await learningEngine.checkLearningEligibility(CONFIG.SYMBOL);
    log("LEARNING", `Status: ${eligibility.status} - ${eligibility.reason}`);
    
    if (!eligibility.self_learning) {
      log("LEARNING", "Not eligible for learning yet");
      return;
    }
    
    try {
      const result = await learningEngine.runLearningCycle(CONFIG.SYMBOL, CONFIG.DRY_RUN);
      if (result && (result.favorable_conditions?.length > 0 || result.avoid_conditions?.length > 0)) {
        log("LEARNING", `[LEARNING] Cycle: ${result.sampleSize.total} trades analyzed`);
        log("LEARNING", `  Favorable: ${result.favorable_conditions.length} | Avoid: ${result.avoid_conditions.length}`);
        log("LEARNING", `  Weights: trend=${result.weight_adjustments.trend}%, volume=${result.weight_adjustments.volume}%, rsi=${result.weight_adjustments.rsi}%`);
        
        // Broadcast learning results to dashboard
        broadcastSSE({
          type: "learning",
          favorable_conditions: result.favorable_conditions,
          avoid_conditions: result.avoid_conditions,
          weight_adjustments: result.weight_adjustments,
          current_weights: result.current_weights,
          sampleSize: result.sampleSize,
          confidence: result.confidence,
          status: eligibility.status,
          timestamp: result.timestamp,
        });
      }
    } catch (err) {
      log("WARN", `[LEARNING] Cycle failed: ${err.message}`);
    }
  }, LEARNING_INTERVAL_MS);

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
