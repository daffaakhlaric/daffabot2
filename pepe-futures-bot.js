"use strict";

require("dotenv").config();
const https = require("https");
const crypto = require("crypto");

const { multiPairStrategy, btcStrategy } = require("./strategy");
const { getBTCSentiment, getPairCategory } = require("./strategy/pairRegimeDetector");
const { recordExit } = require("./strategy/antiFakeout");
const orchestrator = require("./botOrchestrator");
const { riskGuard } = require("./guards");
const { analytics } = require("./services/analytics");
const tradeMemory  = require("./tradeMemory");
const { tpCalculator } = require("./utils");

// Multi-pair support
const pairManager = require("./pairManager");
const { PAIRS, getEnabledPairs, getPairBySymbol } = require("./config");

// ================= CONFIG =================
const CONFIG = {
  SYMBOL: "BTCUSDT",
  PRODUCT_TYPE: "usdt-futures",

  API_KEY: process.env.BITGET_API_KEY,
  SECRET_KEY: process.env.BITGET_SECRET_KEY,
  PASSPHRASE: process.env.BITGET_PASSPHRASE,

  LEVERAGE: 50,             // 50x leverage
  POSITION_SIZE_USDT: 0.40, // Margin: $0.40 → Notional: $20 (0.40 × 50)

  TRADE_COOLDOWN_MS: 5 * 60 * 1000,
  CHECK_INTERVAL: 20000,

  DRY_RUN:               process.env.DRY_RUN               !== "false",
  AI_ENABLED:            process.env.AI_ENABLED            !== "false",
  SNIPER_MODE:           process.env.SNIPER_MODE           !== "false",
  SNIPER_ENABLED:        process.env.SNIPER_ENABLED        !== "false",
  MODE:                  process.env.BOT_MODE              || "SAFE",   // SAFE | FAST
  MULTI_PAIR_ENABLED:    process.env.MULTI_PAIR_ENABLED    === "true",
  PAIR_EVAL_INTERVAL_MS: 60 * 1000,  // Evaluate pairs every 60 seconds
  SNIPER_CONFIG: {
    risk:               0.03,
    leverage:           10,
    tp_r:               [3, 8, 15],
    max_daily_trades:   2,
    post_loss_cooldown_ms: 45 * 60 * 1000,
  },
};

// ── DRY_RUN SIZING (Fixed realistic margin per pair) ──────────────
// IMPORTANT: Only used when DRY_RUN=true. LIVE mode uses CONFIG.LEVERAGE
const DRY_RUN_MARGIN = {
  BTCUSDT:  25,    // $25 margin × 20x lev = $500 notional
  ETHUSDT:  20,    // $20 margin × 15x lev = $300 notional
  SOLUSDT:  15,    // $15 margin × 10x lev = $150 notional
  PEPEUSDT: 10,    // $10 margin × 10x lev = $100 notional
};

const DRY_RUN_LEVERAGE = {
  BTCUSDT:  20,    // Conservative 20x (was 50x)
  ETHUSDT:  15,    // Conservative 15x
  SOLUSDT:  10,    // Conservative 10x
  PEPEUSDT: 10,    // Conservative 10x
};

// ================= STATE =================
let state = {
  activePosition:      null,
  lastTradeTime:       0,
  lastTradeCloseTime:  0,    // Track when position closed (for cooldown)
  lastClosedTradePnL:  null, // Track if last trade was WIN or LOSS
  lastClosedCandleTime: 0,   // Track candle time when position closed
  lastJudasLevel:      null,
  lastJudasLevelTime:  0,
};

// ── LOAD TRADE HISTORY AT STARTUP ──────────────────────────
// IMPORTANT: Load history for analytics, but DON'T apply cooldown for old trades
function loadTradeHistoryFromDashboard() {
  try {
    const dash = require("./dashboard-server");
    if (dash.tradeHistory && dash.tradeHistory.length > 0) {
      global.botState.tradeHistory = dash.tradeHistory;
      const lastTrade = dash.tradeHistory[dash.tradeHistory.length - 1];
      if (lastTrade) {
        const lastTradeTime = lastTrade.exitTime || lastTrade.timestamp || 0;
        // Only apply cooldown if trade was closed AFTER bot started
        // Otherwise, ignore old trades (they're just for analytics)
        if (lastTradeTime > botStartTime) {
          state.lastTradeTime = lastTradeTime;
          state.lastTradeCloseTime = lastTradeTime;
          state.lastClosedTradePnL = lastTrade.result || null;
          log(`📂 LOADED: ${dash.tradeHistory.length} trades | last: ${lastTrade.result} @ ${new Date(lastTradeTime).toISOString()}`);
        } else {
          log(`📂 LOADED: ${dash.tradeHistory.length} trades (old trades - cooldown not applied)`);
        }
      }
    }
  } catch (e) {
    // Ignore if dashboard not ready
  }
}

// ── STARTUP COOLDOWN ───────────────────────────────────────
// Prevent instant trade on bot start (give time to assess market)
const STARTUP_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const botStartTime = Date.now();

// ── GLOBAL BOT STATE (shared with dashboard) ──────────────
global.botState = {
  price:          0,
  balance:        0,
  equity:         0,
  unrealizedPnL:  0,
  activePosition: null,
  tradeHistory:   [],
  lastDecision:   "HOLD",
  marketState:    "UNKNOWN",
  botStatus:      "RUNNING",
  logs:           [],
  features:       {},
  aiLogs:         [],
  psychWarnings:  [],
  aiMode:         true,             // ← AI enabled/disabled flag
  aiSource:       "ORCHESTRATOR",   // ← Which engine is active
  forceMode:      null,             // ← null=AUTO | "AI"=force | "BOT"=force
  aiHealthy:      true,             // ← false when billing/auth error detected
  aiDownReason:   null,             // ← "BILLING" | "AUTH" | "OVERLOADED" | null
  aiForced:       false,            // ← true if user manually set mode
  scoreBoard:     {
    htf_confidence:        null,
    smc_confluence_score:  null,
    decision_score:        null,
    momentum_confidence:   null,
    judas_confidence:      null,
    regime:                "UNKNOWN",
    market_state:          "UNKNOWN",
    timestamp:             0,
  },
  // Multi-pair fund manager state
  multiPairEnabled:      false,
  currentPair:           "BTCUSDT",
  pairScoreboard:        [],
  pairRecommendation:    "Multi-pair disabled",
  whaleAlerts:           [],
};

// ── MULTI-PAIR STATE ──────────────────────────
let currentSymbol = CONFIG.SYMBOL;
let currentPairConfig = PAIRS.find(p => p.symbol === CONFIG.SYMBOL) || null;
let lastPairEvalTime = 0;
let forceEvalNextTick = false;

// ================= UTIL =================
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);

  // Simpan ke buffer — max 200 baris terakhir
  global.botState.logs.push({ ts: Date.now(), msg });
  if (global.botState.logs.length > 200) {
    global.botState.logs.shift();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

let _tickRunning = false;
let _openingPosition = false;
let _justClosed = false;      // Flag to skip decision logic for 1-2 ticks after close

// ================= SAFE REQUEST ==================
function safeJsonParse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function request(method, path, body = null) {
  const ts = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : "";

  const headers = {
    "ACCESS-KEY": CONFIG.API_KEY,
    "ACCESS-SIGN": crypto
      .createHmac("sha256", CONFIG.SECRET_KEY)
      .update(ts + method + path + bodyStr)
      .digest("base64"),
    "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": CONFIG.PASSPHRASE,
    "Content-Type": "application/json",
  };

  return new Promise((resolve) => {
    const req = https.request(
      { hostname: "api.bitget.com", path, method, headers },
      (res) => {
        let data = "";
        res.on("data", d => (data += d));
        res.on("end", () => {
          const json = safeJsonParse(data);
          if (!json || !json.data) {
            log("⚠️ API ERROR / EMPTY");
            return resolve({ data: [] });
          }
          resolve(json);
        });
      }
    );

    req.on("error", () => {
      log("⚠️ REQUEST ERROR");
      resolve({ data: [] });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ================= MARKET =================

// Generate mock candles for DRY_RUN testing
function generateMockKlines(symbol, basePrice = null, bars = 100) {
  const prices = { BTCUSDT: 74000, PEPEUSDT: 0.000016, SOLUSDT: 210, DOGEUSDT: 0.35 };
  let price = basePrice || prices[symbol] || 50000;

  const klines = [];
  for (let i = 0; i < bars; i++) {
    // Random walk: ±0.5% per candle
    const change = (Math.random() - 0.5) * 2 * 0.005;
    const open = price;
    price = price * (1 + change);
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * 0.002);
    const low = Math.min(open, close) * (1 - Math.random() * 0.002);
    const volume = Math.random() * 1000000;

    klines.push({ open, high, low, close, volume });
  }
  return klines.reverse();
}

// Fetch real-time ticker price (for display & decisions)
async function getTickerPrice(symbol = CONFIG.SYMBOL) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/ticker?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}`
  );

  if (res?.data) {
    const tick = Array.isArray(res.data) ? res.data[0] : res.data;
    return parseFloat(tick?.lastPr || tick?.last || tick?.close || 0) || null;
  }

  // Fallback: return mock price for DRY_RUN or when API unavailable
  if (CONFIG.DRY_RUN) {
    const mockPrices = { BTCUSDT: 74000, PEPEUSDT: 0.000016, SOLUSDT: 210, DOGEUSDT: 0.35 };
    return mockPrices[symbol] || 50000;
  }

  return null;
}

async function getKlines(symbol = CONFIG.SYMBOL) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}&granularity=1m&limit=100`
  );

  if (Array.isArray(res.data) && res.data.length > 0) {
    return res.data.map(c => ({
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
    })).reverse();
  }

  // Fallback: generate mock candles for DRY_RUN or when API unavailable
  if (CONFIG.DRY_RUN) {
    return generateMockKlines(symbol);
  }

  return [];
}

// Parameterized klines fetch for multi-pair support
async function fetchKlinesForSymbol(symbol, granularity = "1m", limit = 100) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}&granularity=${granularity}&limit=${limit}`
  );

  if (Array.isArray(res.data) && res.data.length > 0) {
    return res.data.map(c => ({
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
    })).reverse();
  }

  // Fallback: generate mock candles for DRY_RUN or when API unavailable
  if (CONFIG.DRY_RUN) {
    return generateMockKlines(symbol, null, limit);
  }

  return [];
}

// Fetch klines for all enabled pairs (multi-pair support)
async function fetchAllPairKlines() {
  const pairs = getEnabledPairs();
  const klines1mMap = {};
  const priceMap = {};

  try {
    // Fetch both klines & ticker prices in parallel for all pairs
    const klinesPromises = pairs.map(p => fetchKlinesForSymbol(p.symbol, "1m", 100));
    const tickerPromises = pairs.map(p => getTickerPrice(p.symbol));

    const [allKlines, allTickers] = await Promise.all([
      Promise.all(klinesPromises),
      Promise.all(tickerPromises)
    ]);

    pairs.forEach((p, idx) => {
      const klines = allKlines[idx] || [];
      klines1mMap[p.symbol] = klines;

      // Use ticker price (real-time) if available, fallback to klines
      const tickerPrice = allTickers[idx];
      if (tickerPrice) {
        priceMap[p.symbol] = tickerPrice;
      } else if (klines.length > 0) {
        priceMap[p.symbol] = klines[klines.length - 1].close;
      }
    });
  } catch (err) {
    log(`⚠️ Multi-pair fetch error: ${err.message}`);
  }

  return { klines1mMap, priceMap };
}

async function getKlinesHTF(granularity, limit, symbol = CONFIG.SYMBOL) {
  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}&granularity=${granularity}&limit=${limit}`
  );
  if (Array.isArray(res.data) && res.data.length > 0) {
    return res.data.map(c => ({
      open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
    })).reverse();
  }

  // Fallback: generate mock candles for DRY_RUN or when API unavailable
  if (CONFIG.DRY_RUN) {
    return generateMockKlines(symbol, null, limit);
  }

  return [];
}

// ================= ORDER EXECUTION =================

// Hitung size dalam BTC dari margin USDT
function calcSizeBTC(price) {
  const notional = CONFIG.POSITION_SIZE_USDT * CONFIG.LEVERAGE;
  const raw      = notional / price;
  // Minimum 0.00005 BTC (allows smaller positions), floor ke 5 desimal
  return Math.max(0.00005, Math.floor(raw * 100000) / 100000);
}

// Set leverage sebelum open posisi
async function setLeverage() {
  const res = await request("POST", "/api/v2/mix/account/set-leverage", {
    symbol:      currentSymbol,
    productType: CONFIG.PRODUCT_TYPE,
    marginCoin:  "USDT",
    leverage:    String(CONFIG.LEVERAGE),
  });
  if (res?.code === "00000") {
    log(`⚙️ Leverage set: ${CONFIG.LEVERAGE}x on ${currentSymbol}`);
  } else {
    log(`⚠️ Set leverage response: ${res?.msg || JSON.stringify(res)}`);
  }
  return res;
}

// Kirim market order ke Bitget
// side: "buy" | "sell"    tradeSide: "open" | "close"
async function placeOrder(side, tradeSide, size) {
  const body = {
    symbol:      currentSymbol,
    productType: CONFIG.PRODUCT_TYPE,
    marginMode:  "isolated",
    marginCoin:  "USDT",
    size:        String(size),
    side,
    tradeSide,
    orderType:   "market",
    force:       "gtc",
  };

  log(`📤 ORDER → ${side.toUpperCase()} ${tradeSide.toUpperCase()} ${size} @ ${currentSymbol}`);
  const res = await request("POST", "/api/v2/mix/order/place-order", body);

  if (res?.code === "00000") {
    log(`✅ ORDER OK — orderId: ${res.data?.orderId || "?"}`);
  } else {
    log(`❌ ORDER FAILED — code: ${res?.code} msg: ${res?.msg}`);
  }
  return res;
}

// Ambil posisi real dari Bitget (untuk close)
async function fetchRealPosition(symbol = currentSymbol) {
  const res = await request(
    "GET",
    `/api/v2/mix/position/single-position?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}&marginCoin=USDT`
  );
  const pos = Array.isArray(res.data) ? res.data[0] : res.data;
  return (pos && parseFloat(pos.total || 0) > 0) ? pos : null;
}

// ================= MAX HOLD TIME HELPER =================
function getMaxHoldMs(setup, symbol) {
  if (/SNIPER_KILLER|ULTRA/.test(setup)) return 45 * 60 * 1000;  // 45 min
  if (/SNIPER/.test(setup))              return 90 * 60 * 1000;  // 90 min
  if (symbol === "BTCUSDT")              return 240 * 60 * 1000; // 4h BTC trend
  return 120 * 60 * 1000;                                         // 2h alts
}

// ================= EXECUTION =================
async function openPosition(side, price, entryConfig, setup = "TREND") {
  log(`🚀 OPEN ${side} @ ${price} | DRY_RUN: ${CONFIG.DRY_RUN}`);

  // ── DRY_RUN REALISTIC SIZING ──────────────────────────────
  let size, notional, leverage, margin;

  if (CONFIG.DRY_RUN) {
    // Use fixed realistic margin per pair in DRY_RUN
    margin = DRY_RUN_MARGIN[currentSymbol] ?? 15;
    leverage = DRY_RUN_LEVERAGE[currentSymbol] ?? 10;
    notional = margin * leverage;
    size = notional / price;

    log(`📊 DRY_RUN SIZING: ${currentSymbol} | Margin: $${margin} | Leverage: ${leverage}x | Notional: $${notional}`);
  } else {
    // LIVE mode: use existing sizing logic
    size = calcSizeBTC(price);
    notional = parseFloat(size) * price;
    leverage = CONFIG.LEVERAGE;
    margin = CONFIG.POSITION_SIZE_USDT;
  }

  if (!CONFIG.DRY_RUN) {
    await setLeverage();

    const orderSide = side === "LONG" ? "buy" : "sell";
    const res       = await placeOrder(orderSide, "open", size);

    if (res?.code !== "00000") {
      log(`❌ OPEN DIBATALKAN — order gagal`);
      return; // Jangan set state kalau order gagal
    }
  }

  const sl = entryConfig.sl ?? 0.7;

  // ⭐ NEW: Ensure multi-level TP targets (1.5%, 2.5%, 4%)
  const tpLevels = tpCalculator.calculateMultiLevelTP(price, side, {
    tp1_pct: 1.5,  // First target: 1.5% profit
    tp2_pct: 2.5,  // Second target: 2.5% profit
    tp3_pct: 4.0,  // Third target: 4.0% profit
  });

  state.activePosition = {
    side,
    entry: price,
    setup,
    size,                 // Add size for dashboard display
    sizeUSDT: notional,   // Add notional for dashboard display
    margin,               // Track actual margin used
    leverage,             // Track actual leverage used
    symbol: currentSymbol,
    pairDisplayName: currentPairConfig?.displayName || currentSymbol,
    openedAt:      Date.now(),
    sl,
    slPrice:       entryConfig.sl_price ?? (side === "LONG" ? price*(1-sl/100) : price*(1+sl/100)),
    tp1Price:      entryConfig.tp1 ?? tpLevels.tp1,      // ⭐ Use calculated TP1
    tp2Price:      entryConfig.tp2 ?? tpLevels.tp2,      // ⭐ Use calculated TP2
    tp3Price:      entryConfig.tp3 ?? tpLevels.tp3,      // ⭐ Use calculated TP3
    tp1Done:       false,
    tp2Done:       false,
    peakPnl:       0,
    maxHoldMs:     entryConfig.maxHoldMs ?? getMaxHoldMs(setup, currentSymbol),
    trailActivate: entryConfig.trailActivate ?? 1.5,
    trailDrop:     entryConfig.trailDrop ?? 0.3,
    pyr1:          entryConfig.pyr1 ?? 1.5,
    pyr2:          entryConfig.pyr2 ?? 3.0,
    peak:          0,
    pyr1Done:      false,
    pyr2Done:      false,
  };

  state.lastTradeTime = Date.now();
  if (setup === "JUDAS_SWING") {
    state.lastJudasLevel     = price;
    state.lastJudasLevelTime = Date.now();
  }
  global.botState.activePosition = {
    side, entry: price, leverage, setup, size, sizeUSDT: notional, pnl: 0, pnlPct: 0,
    symbol: currentSymbol, pairDisplayName: currentPairConfig?.displayName || currentSymbol,
    margin, notional,  // Add margin and notional for dashboard display
  };

  // Debug: confirm position state updated
  const posObj = global.botState.activePosition;
  log(`💾 STATE SAVED: ${side} ${(+size).toFixed(4)} @ ${(+price).toFixed(2)} on ${currentSymbol}`);
  if (posObj) {
    log(`   ✓ activePosition SET | side=${posObj.side} | symbol=${posObj.symbol} | size=${posObj.size}`);
  } else {
    log(`   ✗ ERROR: activePosition is NULL!`);
  }
}

async function closePosition(price, reason = "UNKNOWN") {
  const pos = state.activePosition;
  if (!pos) return;

  if (!CONFIG.DRY_RUN) {
    // Ambil size real dari Bitget supaya full close
    const realPos   = await fetchRealPosition();
    const size      = realPos?.total || calcSizeBTC(pos.entry);
    const closeSide = pos.side === "LONG" ? "sell" : "buy";
    const res       = await placeOrder(closeSide, "close", size);

    if (res?.code !== "00000") {
      log(`❌ CLOSE GAGAL — coba manual di Bitget!`);
      // Tetap clear state supaya bot tidak stuck
    }
  }

  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) / pos.entry * 100
      : (pos.entry - price) / pos.entry * 100;

  // Use actual margin and leverage from position (handles both LIVE and DRY_RUN correctly)
  const posMargin = pos.margin || CONFIG.POSITION_SIZE_USDT;
  const posLeverage = pos.leverage || CONFIG.LEVERAGE;
  const pnlUSDT = +(posMargin * posLeverage * (pnl / 100)).toFixed(3);

  log(`💰 CLOSE @ ${price} | PnL: ${pnl.toFixed(2)}% (${pnlUSDT > 0 ? "+" : ""}${pnlUSDT} USDT) | ${reason}`);

  const exitTime = Date.now();
  const entryTime = pos.openedAt || state.lastTradeTime || Date.now();

  const trade = {
    id:        `T-${Date.now()}`,
    side:      pos.side,
    entry:     pos.entry,
    exit:      price,
    pnl:       +pnl.toFixed(4),
    pnlUSDT,
    result:    pnl > 0 ? "WIN" : "LOSS",
    reason,
    duration:  Math.max(0, exitTime - entryTime),  // milliseconds
    timestamp: entryTime,
    entryTime,
    exitTime,
    setup:     pos.setup || "TREND",
    // Trade execution details
    size:      pos.size || "0",
    sizeUSDT:  pos.sizeUSDT || 0,
    leverage:  CONFIG.LEVERAGE,
    source:    global.botState.aiSource || "UNKNOWN",
    symbol:    pos.symbol || currentSymbol,
    pairDisplay: pos.pairDisplayName || currentPairConfig?.displayName || currentSymbol,
  };

  global.botState.tradeHistory.push(trade);
  tradeMemory.updateSetupStats(trade.setup, trade.pnlUSDT);

  try {
    const dash = require("./dashboard-server");
    dash.recordTrade(trade);
  } catch {}

  // ── POST-CLOSE COOLDOWN TRACKING ──────────────
  state.activePosition = null;
  global.botState.activePosition = null;

  // Track close time for post-exit cooldown + differentiate WIN/LOSS cooldown
  state.lastTradeCloseTime = Date.now();
  state.lastClosedTradePnL = pnl > 0 ? "WIN" : "LOSS";
  _justClosed = true;  // Set flag to skip decision logic for next 1-2 ticks

  // Record exit for anti-fakeout cooldown
  try {
    recordExit(pos.symbol || currentSymbol, reason, pnlUSDT, pos.side);
  } catch (e) {}

  const cooldownMins = pnl > 0 ? Math.max(5, Math.ceil(CONFIG.TRADE_COOLDOWN_MS / 60000)) : 10;
  log(`⏱️  POST-${state.lastClosedTradePnL} COOLDOWN: ${cooldownMins}min lockout active`);

  // ── FORCE PAIR RE-EVALUATION AFTER CLOSE ──────────────────────────
  // Re-evaluate pairs immediately after exit to select best pair for next entry
  forceEvalNextTick = true;
  log(`🔄 Pair re-evaluation triggered — will select best pair for next entry`);
}

// Partial close for TP levels — doesn't null position (stays open with reduced size)
async function partialClose(price, pct, reason = "PARTIAL") {
  const pos = state.activePosition;
  if (!pos) return;

  const closeFrac = pct / 100;
  const pnlPct    = pos.side === "LONG"
    ? (price - pos.entry) / pos.entry * 100
    : (pos.entry - price) / pos.entry * 100;

  // Use actual margin and leverage from position (handles both LIVE and DRY_RUN)
  const posMargin = pos.margin || CONFIG.POSITION_SIZE_USDT;
  const posLeverage = pos.leverage || CONFIG.LEVERAGE;
  const pnlUSDT   = +(posMargin * posLeverage * (pnlPct / 100) * closeFrac).toFixed(3);

  if (!CONFIG.DRY_RUN) {
    const realPos = await fetchRealPosition();
    const total   = parseFloat(realPos?.total || calcSizeBTC(pos.entry));
    const sz      = Math.floor(total * closeFrac * 100000) / 100000;
    if (sz > 0) {
      const closeSide = pos.side === "LONG" ? "sell" : "buy";
      await placeOrder(closeSide, "close", sz);
    }
  }

  const exitTime  = Date.now();
  const entryTime = pos.openedAt || state.lastTradeTime || Date.now();
  const trade = {
    id: `T-${Date.now()}`, side: pos.side, entry: pos.entry, exit: price,
    pnl: +pnlPct.toFixed(4), pnlUSDT, result: pnlUSDT > 0 ? "WIN" : "LOSS",
    reason: `${reason} (${pct}%)`, duration: Math.max(0, exitTime - entryTime),
    timestamp: entryTime, entryTime, exitTime, setup: pos.setup,
    size: pos.size, sizeUSDT: pos.sizeUSDT, leverage: posLeverage,
    source: global.botState.aiSource || "UNKNOWN",
    symbol: pos.symbol, pairDisplay: pos.pairDisplayName,
  };
  global.botState.tradeHistory.push(trade);
  tradeMemory.updateSetupStats(trade.setup, trade.pnlUSDT);
  try { require("./dashboard-server").recordTrade(trade); } catch {}

  // Reduce remaining position (don't null)
  const remaining = 1 - closeFrac;
  pos.size    = (parseFloat(pos.size) * remaining).toFixed(5);
  pos.sizeUSDT = +(pos.sizeUSDT * remaining).toFixed(2);
  global.botState.activePosition = { ...pos };
  log(`📉 PARTIAL ${pct}% CLOSE @ ${price} | ${reason} | PnL: ${pnlUSDT > 0 ? "+" : ""}${pnlUSDT} USDT`);
}

async function addPosition(level) {
  if (level > 2) return;
  log(`🚀 PYRAMID LEVEL ${level}`);

  if (!CONFIG.DRY_RUN && state.activePosition) {
    const price     = global.botState.price;
    const size      = calcSizeBTC(price);
    const orderSide = state.activePosition.side === "LONG" ? "buy" : "sell";
    await placeOrder(orderSide, "open", size);
  }
}

// ================= MAIN LOOP =================
async function run() {
  while (true) {
    try {
      // Bug 5: skip tick if previous still running
      if (_tickRunning) {
        log("⏭ Tick skipped — previous still running");
        await sleep(CONFIG.CHECK_INTERVAL);
        continue;
      }
      _tickRunning = true;

      const now = Date.now();

      // ── MULTI-PAIR EVALUATION ─────────────────────────────
      if (CONFIG.MULTI_PAIR_ENABLED) {
        // ── ANTI INSTANT-SWITCH ──────────────────────────
        // Skip pair re-eval for N seconds after a position closes (prevent pair hopping)
        // BUT: Allow immediate re-eval if forceEvalNextTick is set (after close)
        const postCloseSkipMs = 3 * 60 * 1000;  // 3 min skip after close
        const justClosed = !forceEvalNextTick && state.lastTradeCloseTime > 0 && (Date.now() - state.lastTradeCloseTime) < postCloseSkipMs;

        const shouldEval = (forceEvalNextTick) ||
          (Date.now() - lastPairEvalTime > CONFIG.PAIR_EVAL_INTERVAL_MS && !justClosed);

        if (shouldEval && !state.activePosition) {
          forceEvalNextTick = false;
          lastPairEvalTime = Date.now();

          try {
            const { klines1mMap, priceMap } = await fetchAllPairKlines();

            const evalResult = await pairManager.evaluateAll({
              klines1mMap,
              priceMap,
              aiEnabled: global.botState.aiMode || false,
            });

            // Update dashboard state
            global.botState.pairScoreboard = evalResult.scoreboard;
            global.botState.pairRecommendation = evalResult.recommendation;
            global.botState.whaleAlerts = evalResult.whaleAlerts;

            // Handle pair switch
            if (evalResult.shouldSwitch && evalResult.nextPair) {
              const prevSymbol = currentSymbol;
              const newPairCfg = getPairBySymbol(evalResult.nextPair);

              if (newPairCfg) {
                const switchContext = forceEvalNextTick ? " [POST-EXIT]" : "";
                log(`🔄 PAIR SWITCH${switchContext}: ${prevSymbol} → ${evalResult.nextPair} | Reason: ${evalResult.switchReason}`);
                pairManager.recordSwitch(prevSymbol, evalResult.nextPair, evalResult.switchReason);

                currentSymbol = evalResult.nextPair;
                currentPairConfig = newPairCfg;

                // Update CONFIG-like values for current pair
                CONFIG.LEVERAGE = currentPairConfig.leverage;
                CONFIG.POSITION_SIZE_USDT = currentPairConfig.positionSizeUSDT;

                global.botState.currentPair = currentSymbol;
                forceEvalNextTick = true;
              }
            } else if (forceEvalNextTick) {
              // Pair re-evaluation after close found current pair is still best
              const currentScore = evalResult.scoreboard.find(p => p.symbol === currentSymbol);
              if (currentScore) {
                log(`✅ POST-EXIT PAIR CHECK: ${currentSymbol} still best (${currentScore.score}pts)`);
              }
            }
          } catch (err) {
            log(`⚠️ Pair eval error: ${err.message}`);
          }
        }
      }
      // ── END MULTI-PAIR EVALUATION ─────────────────────────

      const klines = CONFIG.MULTI_PAIR_ENABLED
        ? await fetchKlinesForSymbol(currentSymbol, "1m", 100)
        : await getKlines(currentSymbol);
      if (!klines || klines.length < 10) {
        log("⚠️ INVALID KLINES");
        _tickRunning = false;
        await sleep(CONFIG.CHECK_INTERVAL);
        continue;
      }

      // Fetch real-time ticker price (more accurate than candles)
      const tickerPrice = await getTickerPrice(currentSymbol);
      const price = tickerPrice || klines[klines.length - 1].close;

      // ── PRIORITY EXIT CHECKS (per-tick, before decision engine) ──────────────
      if (state.activePosition) {
        const pos = state.activePosition;
        const pnlPct = pos.side === "LONG"
          ? (price - pos.entry) / pos.entry * 100
          : (pos.entry - price) / pos.entry * 100;

        // Update peak PnL
        pos.peakPnl = Math.max(pos.peakPnl || 0, pnlPct);
        global.botState.activePosition.peakPnL = pos.peakPnl;

        // DEBUG: Log position monitor every tick
        const holdMs = Date.now() - pos.openedAt;
        const holdSec = holdMs / 1000;
        const MIN_HOLD_MS = 2 * 60 * 1000;  // 2 minutes minimum before TP exits
        const canTakeProfit = holdMs >= MIN_HOLD_MS;
        log(`📊 POS MONITOR | ${pos.side} ${pos.symbol} @ ${pos.entry.toFixed(2)} | Price: ${price.toFixed(2)} | PnL: ${pnlPct.toFixed(3)}% | Hold: ${holdSec.toFixed(0)}s | TP OK: ${canTakeProfit ? 'YES' : 'NO'} | SL: ${pos.slPrice?.toFixed(2) || 'N/A'} | TP1: ${pos.tp1Price?.toFixed(2) || 'N/A'}`);

        // 1. SL check (absolute price) — ONLY if slPrice is valid — IMMEDIATE (no hold time)
        if (pos.slPrice && pos.slPrice > 0) {
          const slHit = pos.side === "LONG" ? price <= pos.slPrice : price >= pos.slPrice;
          if (slHit) {
            log(`🔴 SL HIT @ ${price} (SL: ${pos.slPrice})`);
            await closePosition(price, "STOP_LOSS");
            _tickRunning = false; continue;
          }
        }

        // 2. TP1 → partial 40% (only after 2min hold)
        if (pos.tp1Price && !pos.tp1Done && canTakeProfit) {
          const tp1Hit = pos.side === "LONG" ? price >= pos.tp1Price : price <= pos.tp1Price;
          if (tp1Hit) {
            pos.tp1Done = true;
            await partialClose(price, 40, "TP1_HIT");
            pos.slPrice = pos.entry;  // move SL to breakeven
            global.botState.activePosition = { ...pos };
            _tickRunning = false; continue;
          }
        }

        // 3. TP2 → partial 30% (only after TP1 + 2min hold)
        if (pos.tp2Price && !pos.tp2Done && pos.tp1Done && canTakeProfit) {
          const tp2Hit = pos.side === "LONG" ? price >= pos.tp2Price : price <= pos.tp2Price;
          if (tp2Hit) {
            pos.tp2Done = true;
            await partialClose(price, 30, "TP2_HIT");
            global.botState.activePosition = { ...pos };
            _tickRunning = false; continue;
          }
        }

        // 4. TP3 → close runner (only after TP2 + 2min hold)
        if (pos.tp3Price && pos.tp2Done && canTakeProfit) {
          const tp3Hit = pos.side === "LONG" ? price >= pos.tp3Price : price <= pos.tp3Price;
          if (tp3Hit) {
            await closePosition(price, "TP3_HIT_RUNNER");
            _tickRunning = false; continue;
          }
        }

        // 5. Trailing SL update (step-trail system)
        if (pos.peakPnl >= 0.3) {
          const trailPct = pos.peakPnl >= 1.2 ? 0.4 : pos.peakPnl >= 0.7 ? 0.2 : 0;
          const trailSL  = trailPct === 0
            ? pos.entry
            : pos.side === "LONG" ? price * (1 - trailPct / 100) : price * (1 + trailPct / 100);
          const current  = pos.slPrice || 0;
          const better   = pos.side === "LONG" ? trailSL > current : trailSL < current;
          if (better) {
            pos.slPrice = +trailSL.toFixed(6);
            global.botState.activePosition = { ...pos };
            log(`🔒 TRAIL SL → ${pos.slPrice} (peak ${pos.peakPnl.toFixed(2)}%)`);
          }
        }

        // 6. Max hold safety (last resort)
        const maxHold  = pos.maxHoldMs || (2 * 60 * 60 * 1000);
        global.botState.activePosition.holdMs = holdMs;
        if (holdMs > maxHold && pnlPct <= 0) {
          log(`⏰ TIMEOUT_SAFETY — ${Math.round(holdMs/60000)}min held at ${pnlPct.toFixed(2)}%`);
          await closePosition(price, `TIMEOUT_SAFETY_${Math.round(holdMs/60000)}min`);
          _tickRunning = false; continue;
        }
      }
      // ── END PRIORITY EXIT CHECKS ──────────────────────────────────────────────

      const liveEquity = global.botState?.equity || parseFloat(process.env.INITIAL_EQUITY || "1000");

      // Bug 1: compute equityCurve once per tick (not [])
      const equityCurve = analytics.calcEquityCurve(
        global.botState.tradeHistory || [],
        parseFloat(process.env.INITIAL_EQUITY || "1000")
      );

      // Fetch HTF klines setiap 3 tick (hemat API quota)
      if (tickCount % 3 === 0 || !klines_4h.length) {
        [klines_4h, klines_1h, klines_15m] = await Promise.all([
          getKlinesHTF("4H", 20, currentSymbol),
          getKlinesHTF("1H", 30, currentSymbol),
          getKlinesHTF("15m", 40, currentSymbol),
        ]);
      }
      tickCount++;

      // === AI ENABLED CHECK ===
      // Simple check: AI is disabled if no API key
      const hasAIKey = !!process.env.ANTHROPIC_API_KEY;
      const isAIMode = global.botState?.aiMode !== false && hasAIKey;
      const aiEnabled = isAIMode && global.botState?.aiHealthy !== false;

      // === MULTI-PAIR STRATEGY ===
      // Primary: multiPairStrategy (pair-specific regime detection)
      // Fallback: btcStrategy (legacy)
      // BTC klines passed for sentiment filter on altcoins
      const btcKlines = currentSymbol !== "BTCUSDT" 
        ? await fetchKlinesForSymbol("BTCUSDT", "1m", 100)
        : klines;

      let decision;
      if (aiEnabled) {
        // AI Orchestrator - still uses its own logic but with pair context
        decision = await withTimeout(
          orchestrator.orchestrate({
            klines_1m:      klines,
            klines_15m:     klines_15m.length ? klines_15m : klines,
            klines_1h:      klines_1h.length  ? klines_1h  : klines,
            klines_4h:      klines_4h.length  ? klines_4h  : klines,
            price,
            activePosition: state.activePosition,
            tradeHistory:   global.botState.tradeHistory,
            equityCurve,
            equity:         liveEquity,
            mode:           CONFIG.MODE,
            pairConfig:     currentPairConfig,  // Pass pair config
          }),
          12000,
          null
        );

        if (!decision || global.botState.aiHealthy === false) {
          // AI failed → use multiPairStrategy as primary fallback
          log(`🔄 FALLBACK: AI ${!decision ? 'timeout' : global.botState.aiDownReason} — using multiPairStrategy`);
          decision = multiPairStrategy.analyze({ 
            klines, 
            position: state.activePosition, 
            pairConfig: currentPairConfig,
            btcKlines: btcKlines,
          });
          decision.source = !decision.source ? "MULTIPAIR_FALLBACK" : decision.source;
        }
      } else {
        // No AI - use multiPairStrategy as primary strategy
        decision = multiPairStrategy.analyze({ 
          klines, 
          position: state.activePosition, 
          pairConfig: currentPairConfig,
          btcKlines: btcKlines,
        });
        decision.source = "MULTIPAIR_ONLY";
      }

      // Pastikan decision selalu ada
      if (!decision) decision = { action: "HOLD", reason: "No decision generated", source: "GUARD" };

      // Extract confidence scores for dashboard monitoring
      const htfConf      = global.botState.features?.f1?.confidence || decision.htf_confidence || null;
      const smcConf      = global.botState.features?.f2?.confluence_score || decision.smc?.confluence_score || null;
      const momConf      = global.botState.features?.momentum?.confidence || null;
      const judasConf    = global.botState.features?.judas?.confidence || null;
      const decisionConf = decision.confidence || null;
      const regime       = global.botState.marketState || "UNKNOWN";

      // Update scoreBoard for dashboard display
      global.botState.scoreBoard = {
        htf_confidence:       htfConf,
        smc_confluence_score: smcConf,
        decision_score:       decisionConf,
        momentum_confidence:  momConf,
        judas_confidence:     judasConf,
        regime:               regime,
        market_state:         global.botState.marketState || "UNKNOWN",
        timestamp:            Date.now(),
      };

      // Track AI mode status (show if using AI or btcStrategy fallback)
      global.botState.aiMode = aiEnabled;
      global.botState.aiSource = aiEnabled ? "ORCHESTRATOR" : "MULTIPAIR";
      global.botState.aiForced = forceMode !== null;
      global.botState.aiDownReason = global.botState.aiHealthy === false ? global.botState.aiDownReason : null;

      // Add pair-specific regime info to botState
      if (decision.regime) {
        global.botState.pairRegime = decision.regime;
      }

      // ⭐ Check if ASIA session is blocked (00:00-06:00 UTC = 07:00-13:00 WIB)
      const utcNow = new Date().getUTCHours();
      const isAsiaPeriod = utcNow >= 0 && utcNow < 6;  // 00:00-05:59 UTC = 07:00-12:59 WIB

      // Enhanced logging with confidence scores + AI mode
      const scoreStr = [
        htfConf !== null ? `HTF=${htfConf}%` : null,
        smcConf !== null ? `SMC=${smcConf}%` : null,
        decisionConf !== null ? `DECISION=${decisionConf}%` : null,
        momConf !== null ? `MOM=${momConf}%` : null,
        judasConf !== null ? `JUDAS=${judasConf}%` : null,
      ].filter(Boolean).join(" | ");

      let logMsg;
      if (isAsiaPeriod && decision.action !== "HOLD") {
        // ⭐ If ASIA and trying to enter, show BLOCKED message instead
        logMsg = `🔴 ASIA SESSION BLOCKED — ${decision.action} setup rejected (low liquidity period 07:00-13:00 WIB)`;
      } else {
        const modeTag = aiEnabled ? "🤖" : "🔴";
        logMsg = `${modeTag} ${decision.action} [${decision.source || "UNKNOWN"}]${scoreStr ? " | " + scoreStr : ""}${decision.reason ? " — " + decision.reason : ""}`;
      }

      log(logMsg);

      // Sync live state to global.botState for dashboard
      global.botState.price        = price;
      global.botState.lastDecision = decision.action;
      global.botState.botStatus    = "RUNNING";
      global.botState.multiPairEnabled = CONFIG.MULTI_PAIR_ENABLED;
      global.botState.currentPair = currentSymbol;

      if (state.activePosition) {
        const pos = state.activePosition;
        const pnlPct = pos.side === "LONG"
          ? (price - pos.entry) / pos.entry * 100
          : (pos.entry - price) / pos.entry * 100;
        const pnlUSDT = CONFIG.POSITION_SIZE_USDT * CONFIG.LEVERAGE * (pnlPct / 100);

        const updatedPos = {
          side:     pos.side,
          entry:    pos.entry,
          leverage: CONFIG.LEVERAGE,
          setup:    pos.setup,
          size:     pos.size,
          sizeUSDT: pos.sizeUSDT,
          pnlPct:   +pnlPct.toFixed(3),
          pnl:      +pnlUSDT.toFixed(3),
          symbol:   currentSymbol,
          pairDisplayName: currentPairConfig?.displayName || currentSymbol,
        };
        global.botState.activePosition = updatedPos;

        // Debug log on first update after open
        if (!global._posLogged || global._posLogged !== pos.side) {
          log(`📊 POSITION TRACKED: ${updatedPos.side} ${(+updatedPos.size).toFixed(4)} ${updatedPos.symbol} | PnL: ${updatedPos.pnlPct.toFixed(2)}%`);
          global._posLogged = pos.side;
        }
      } else {
        global.botState.activePosition = null;
        global._posLogged = null;
      }

      if (decision.action === "LONG" || decision.action === "SHORT") {
        // ── ANTI IMMEDIATE RE-ENTRY ──────────────────────────
        // Skip entry signals for 1 tick after closing (prevents FOMO/revenge trading)
        if (_justClosed) {
          log(`⏸️  ENTRY SKIPPED — just closed, waiting for new candle`);
          _justClosed = false;  // Reset flag for next tick
          _tickRunning = false;
          continue;
        }

        // ── ANTI-FAKEOUT: MINIMUM HOLD TIME CHECK ──────────────────────────
        // Prevent entries immediately after position close (even if cooldown passed)
        const antiFakeout = require("./strategy/antiFakeout");
        const { getPairCategory } = require("./strategy/pairRegimeDetector");
        const pairCategory = getPairCategory(currentSymbol);
        
        // Check recent exit for fast-loss cooldown
        const recentExitCheck = antiFakeout.checkReentryCooldown(currentSymbol, decision.action);
        if (recentExitCheck.blocked) {
          log(`⛔ ${recentExitCheck.reason}`);
          global.botState.cooldownReason = recentExitCheck.reason;
          _tickRunning = false;
          continue;
        }

        // Check for micro-chop before entry
        const chopCheck = antiFakeout.checkMicroChop(klines);
        if (chopCheck.isChop) {
          log(`⛔ MICRO CHOP BLOCK — ${chopCheck.reason}`);
          global.botState.cooldownReason = `MICRO_CHOP: ${chopCheck.reason}`;
          _tickRunning = false;
          continue;
        }

        // Check for tick noise
        const noiseCheck = antiFakeout.checkTickNoise(klines);
        if (noiseCheck.isNoise) {
          log(`⛔ TICK NOISE BLOCK — ${noiseCheck.reason}`);
          global.botState.cooldownReason = `NOISE: ${noiseCheck.reason}`;
          _tickRunning = false;
          continue;
        }

        // Require minimum signal score (A/A+ only)
        const htfCheck = require("./strategy/pairRegimeDetector");
        const regime = htfCheck.detectPairRegime(klines, currentSymbol);
        const signalScore = antiFakeout.scoreSignal(
          klines,
          regime.trendDirection,
          null,
          null,
          klines.slice(-5).reduce((s,k)=>s+k.volume,0) > klines.slice(-20).reduce((s,k)=>s+k.volume,0)/20 * 1.2,
          regime.session
        );
        const minScore = pairCategory === "MEME" ? 80 : pairCategory === "MID" ? 70 : 65;
        if (signalScore.score < minScore) {
          log(`⛔ SIGNAL WEAK — score ${signalScore.score} < ${minScore} (${signalScore.grade})`);
          global.botState.cooldownReason = `WEAK_SIGNAL: ${signalScore.score}`;
          _tickRunning = false;
          continue;
        }

        // Bug 2: gunakan == null agar entry angka valid (termasuk 0) tidak ter-skip
        if (decision.entry == null) { _tickRunning = false; continue; }

        // Bug 2: normalize entry — AI bisa return number atau object
        const entryPrice = typeof decision.entry === "number"
          ? decision.entry
          : decision.entry?.price || price;

        const entryConfig = typeof decision.entry === "object" && decision.entry !== null
          ? decision.entry
          : { price: entryPrice, sl: 0.7, trailActivate: 1.5, trailDrop: 0.3, pyr1: 1.5, pyr2: 3.0 };

        // Judas re-entry guard — block same sweep level within 2h
        if (decision.source === "JUDAS") {
          const judasLevel = entryPrice;
          const judasAge   = now - state.lastJudasLevelTime;
          const sameLevel  = state.lastJudasLevel &&
            Math.abs(judasLevel - state.lastJudasLevel) / judasLevel < 0.002;
          if (sameLevel && judasAge < 2 * 60 * 60 * 1000) {
            log(`⛔ Judas re-entry blocked — same level $${judasLevel.toFixed(0)} used ${Math.round(judasAge / 60000)}min ago`);
            _tickRunning = false;
            continue;
          }
        }

        if (!state.activePosition && !_openingPosition) {
          // ── PROFIT PROTECTION CHECK (NEW) ─────────────────────────
          // Run profit protection checks BEFORE allowing entry
          const profitCheckResult = riskGuard.runAllChecks({
            tradeHistory: global.botState.tradeHistory || [],
            equity: liveEquity,
            peakEquity: equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : liveEquity,
            proposedTrade: {
              side: decision.action,
              size: CONFIG.POSITION_SIZE_USDT * CONFIG.LEVERAGE,
              confluenceScore: decision.confidence || 65,
              symbol: currentSymbol, // Pass symbol for pair-aware revenge check
            },
            htfBias: global.botState.marketState || "RANGING",
            regime: global.botState.marketState || "RANGING",
          });

          // Check for hard blocks vs soft blocks
          const hardBlocks = profitCheckResult.blocks.filter(b => 
            b.type.includes("HARD") || b.type.includes("CONSEC_LOSSES") || b.type.includes("DAILY_LIMIT") || b.type.includes("MAX_DRAWDOWN")
          );
          const softBlocks = profitCheckResult.blocks.filter(b => 
            b.type.includes("SOFT") || b.type.includes("REVENGE") || b.type.includes("EUPHORIA") || b.type.includes("OVERTRADING")
          );

          if (hardBlocks.length > 0) {
            const blockReasons = hardBlocks.map(b => b.reason).join("; ");
            log(`⛔ HARD BLOCK: ${blockReasons}`);
            global.botState.cooldownReason = `HARD_BLOCK: ${blockReasons}`;
            _tickRunning = false;
            await sleep(CONFIG.CHECK_INTERVAL);
            continue;
          }

          // Soft block: raise min score, reduce size instead of hard stop
          let minScoreOverride = 55;
          let sizeMultiplier = 1.0;
          if (softBlocks.length > 0) {
            const softReasons = softBlocks.map(b => b.reason).join("; ");
            log(`⚠️ SOFT BLOCK: ${softReasons} — applying restrictions`);
            minScoreOverride = 70; // Raise min score
            sizeMultiplier = 0.5;  // Reduce size 50%
            global.botState.cooldownReason = `SOFT_BLOCK: ${softReasons}`;
          }

          // Check if setup score meets override
          const setupScore = decision.confidence || 65;
          if (setupScore < minScoreOverride) {
            log(`⛔ SCORE TOO LOW: ${setupScore} < ${minScoreOverride} (soft block override)`);
            _tickRunning = false;
            await sleep(CONFIG.CHECK_INTERVAL);
            continue;
          }

          // Apply size multiplier for soft block
          if (sizeMultiplier < 1.0) {
            log(`⚠️ SIZE REDUCED: ${sizeMultiplier * 100}% (soft block)`);
          }

          // Log warnings but allow trade
          if (profitCheckResult.warnings.length > 0) {
            profitCheckResult.warnings.forEach(w => {
              log(`⚠️ PROFIT WARNING: ${w.message || w.type}`);
            });
          }

          // ── STARTUP COOLDOWN ──────────────────────────────────────
          // Prevent instant trade on bot start (give time to assess market)
          const timeSinceStart = now - botStartTime;
          if (timeSinceStart < STARTUP_COOLDOWN_MS) {
            const remainMs = STARTUP_COOLDOWN_MS - timeSinceStart;
            global.botState.cooldownReason = `STARTUP_COOLDOWN — ${Math.ceil(remainMs/1000)}s remaining`;
            _tickRunning = false;
            continue;
          }

          // ── POST-CLOSE COOLDOWN (HIGH PRIORITY) ──────────────
          // After closing: apply longer cooldown, especially after WINS (avoid revenge/FOMO)
          const postCloseCooldown = state.lastClosedTradePnL === "WIN"
            ? 5 * 60 * 1000    // 5 min after WIN (protect profit)
            : 10 * 60 * 1000;  // 10 min after LOSS (avoid revenge)

          if (state.lastTradeCloseTime > 0 && now - state.lastTradeCloseTime < postCloseCooldown) {
            const remainMs = postCloseCooldown - (now - state.lastTradeCloseTime);
            global.botState.cooldownReason = `${state.lastClosedTradePnL}_COOLDOWN — ${Math.ceil(remainMs/1000)}s remaining`;
            // Skip entry — cooldown active
            continue;
          }

          // ── NORMAL TRADE COOLDOWN ──────────────────────────
          // Between trades: avoid rapid re-entry
          if (now - state.lastTradeTime <= CONFIG.TRADE_COOLDOWN_MS) {
            global.botState.cooldownReason = `TRADE_COOLDOWN — ${Math.ceil((CONFIG.TRADE_COOLDOWN_MS - (now - state.lastTradeTime))/1000)}s remaining`;
            // Skip entry — still in cooldown
            continue;
          }

          // ⭐ ASIA SESSION BLOCK — NO ENTRIES ALLOWED (00:00-06:00 UTC = 07:00-13:00 WIB)
          const utcHour = new Date().getUTCHours();
          if (utcHour >= 0 && utcHour < 6) {  // 00:00-05:59 UTC = 07:00-12:59 WIB (fully safe until LONDON)
            log(`🔴 ENTRY BLOCKED: ASIA SESSION (${utcHour.toString().padStart(2,'0')}:00 UTC) — no trading 07:00-13:00 WIB`);
            global.botState.cooldownReason = `ASIA_BLOCKED — ${new Date().toLocaleTimeString()}`;
            continue;
          }

          const setup = decision.setup || "TREND";
          _openingPosition = true;
          try {
            await openPosition(decision.action, entryPrice, entryConfig, setup);
            global.botState.cooldownReason = null;  // Clear cooldown reason on successful entry
          } finally {
            _openingPosition = false;
          }
        }
      }

      else if (decision.action === "CLOSE") {
        if (state.activePosition) {
          log(`📉 ${decision.reason}`);
          await closePosition(price, decision.reason || "SIGNAL");

          // Non-blocking AI post-trade review
          if (CONFIG.AI_ENABLED) {
            const lastTrade = global.botState.tradeHistory[global.botState.tradeHistory.length - 1];
            if (lastTrade) {
              try {
                const fe = require("./featureEngine");
                fe.reviewTrade(lastTrade).then(review => {
                  if (review) {
                    lastTrade.aiReview = review;
                    log(`🔍 AI [${review.quality_score}] ${review.lesson}`);
                    // Track behavioral flags for psychological monitoring
                    if (review.behavioral_flag && review.behavioral_flag !== "GOOD") {
                      if (!global.botState.psychWarnings) global.botState.psychWarnings = [];
                      global.botState.psychWarnings.push({
                        ts: Date.now(),
                        flag: review.behavioral_flag,
                        trade_id: lastTrade.id,
                        lesson: review.lesson,
                      });
                      if (global.botState.psychWarnings.length > 20) global.botState.psychWarnings.shift();
                    }
                  }
                }).catch(() => {});
              } catch {}
            }
          }
        }
      }

      else if (decision.action === "PARTIAL_CLOSE") {
        if (state.activePosition) {
          await partialClose(price, decision.percentage || 50, decision.reason || "SIGNAL_PARTIAL");
        }
      }

      else if (decision.action === "UPDATE_SL") {
        if (state.activePosition && decision.new_sl) {
          log(`🔧 UPDATE SL → ${decision.new_sl} — ${decision.reason || ""}`);
          state.activePosition.sl      = decision.new_sl;
          state.activePosition.slPrice = decision.new_sl;  // Also update absolute price
          global.botState.activePosition = { ...state.activePosition };
        }
      }

      else if (decision.action === "PYRAMID") {
        if (state.activePosition) {
          await addPosition(decision.level);
        }
      }

    } catch (err) {
      log("ERROR: " + err.message);
    } finally {
      _tickRunning = false;
    }

    await sleep(CONFIG.CHECK_INTERVAL);
  }
}

// ── HTF KLINES STATE (diisi setiap 3 tick) ───────────────
let tickCount = 0;
let klines_4h = [], klines_1h = [], klines_15m = [];

// ── AUTO-RECOVERY AI HEALTH CHECK ────────────────────────
// Every 5 minutes, if AI is down (aiHealthy=false) and not force-botted,
// try a minimal Claude call to see if billing/auth has recovered
setInterval(async () => {
  if (global.botState.aiHealthy === false && global.botState.forceMode !== "BOT") {
    const featureEngine = require("./featureEngine");
    const result = await featureEngine.testAIHealth?.();
    if (result) {
      global.botState.aiHealthy = true;
      global.botState.aiDownReason = null;
      log("🟢 AI RESTORED — switching back to ORCHESTRATOR");
    }
  }
}, 5 * 60 * 1000); // 5 minutes

// ── START DASHBOARD ──────────────────────────────────────
try {
  require("./dashboard-server").start();
} catch (e) {
  log("⚠️ Dashboard failed to start: " + e.message);
}

// ── LOAD TRADE HISTORY AT STARTUP ──────────────────────────
loadTradeHistoryFromDashboard();

// ── INITIALIZE STARTUP PAIR ──────────────────────────────────────
async function initializeBotStartup() {
  log("🚀 STARTUP: Evaluating pairs to select the best one...");

  try {
    // Fetch klines for all enabled pairs
    const { klines1mMap, priceMap } = await fetchAllPairKlines();

    // Initialize pair and select best one
    const initResult = await pairManager.initializeStartupPair({
      klines1mMap,
      priceMap,
      aiEnabled: global.botState.aiMode || false,
    });

    if (initResult.selectedPair) {
      const newPairCfg = getPairBySymbol(initResult.selectedPair);
      if (newPairCfg) {
        currentSymbol = initResult.selectedPair;
        currentPairConfig = newPairCfg;

        // Update CONFIG-like values for current pair
        CONFIG.LEVERAGE = currentPairConfig.leverage;
        CONFIG.POSITION_SIZE_USDT = currentPairConfig.positionSizeUSDT;

        global.botState.currentPair = currentSymbol;

        log(`✅ STARTUP PAIR SELECTED: ${initResult.selectedPair} (Score: ${initResult.score})`);
        log(`📊 Top 5 Pairs Scoreboard:`);
        initResult.scoreboard.slice(0, 5).forEach((p, idx) => {
          log(`   ${idx + 1}. ${p.displayName}: ${p.score}pts (${p.trendDirection}) ${p.isSaturated ? '⚠️ SATURATED' : '✅ OK'}`);
        });
        log(`💡 Recommendation: ${initResult.recommendation}`);
      }
    }
  } catch (err) {
    log(`⚠️ Startup pair initialization error: ${err.message}`);
    log(`⚠️ Falling back to BTC`);
    currentSymbol = CONFIG.SYMBOL;
    currentPairConfig = getPairBySymbol(CONFIG.SYMBOL);
  }
}

// Start bot with pair initialization
(async () => {
  await initializeBotStartup();
  run();
})();