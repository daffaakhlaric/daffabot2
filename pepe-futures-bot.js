"use strict";

require("dotenv").config();
const https = require("https");
const crypto = require("crypto");

const btcStrategy  = require("./btcStrategy");
const orchestrator = require("./botOrchestrator");
const riskGuard    = require("./riskGuard");
const analytics    = require("./analytics");
const tradeMemory  = require("./tradeMemory");

// Multi-pair support
const pairManager = require("./pairManager");
const { PAIRS, getEnabledPairs, getPairBySymbol } = require("./pairConfig");

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

// ================= STATE =================
let state = {
  activePosition:     null,
  lastTradeTime:      0,
  lastJudasLevel:     null,
  lastJudasLevelTime: 0,
};

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
async function getKlines() {
  // DRY_RUN mode: generate fake price data for testing
  if (CONFIG.DRY_RUN) {
    const basePrice = 71000;
    const now = Date.now();
    const klines = [];
    for (let i = 99; i >= 0; i--) {
      const variation = (Math.random() - 0.5) * 100; // ±50 price variation
      const price = basePrice + variation;
      klines.push({
        open: price,
        high: price + 50,
        low: price - 50,
        close: price,
        volume: Math.random() * 1000,
      });
    }
    return klines;
  }

  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${CONFIG.SYMBOL}&productType=${CONFIG.PRODUCT_TYPE}&granularity=1m&limit=100`
  );

  if (!Array.isArray(res.data)) return [];

  return res.data.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
  })).reverse();
}

// Parameterized klines fetch for multi-pair support
async function fetchKlinesForSymbol(symbol, granularity = "1m", limit = 100) {
  // DRY_RUN mode: generate fake price data
  if (CONFIG.DRY_RUN) {
    const basePrice = symbol === "BTCUSDT" ? 71000 : 3200;
    const klines = [];
    for (let i = limit - 1; i >= 0; i--) {
      const variation = (Math.random() - 0.5) * 100;
      const price = basePrice + variation;
      klines.push({
        open: price,
        high: price + 50,
        low: price - 50,
        close: price,
        volume: Math.random() * 1000,
      });
    }
    return klines;
  }

  // LIVE mode: fetch from Bitget
  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}&granularity=${granularity}&limit=${limit}`
  );

  if (!Array.isArray(res.data)) return [];

  return res.data.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
  })).reverse();
}

// Fetch klines for all enabled pairs (multi-pair support)
async function fetchAllPairKlines() {
  const pairs = getEnabledPairs();
  const klines1mMap = {};
  const priceMap = {};

  try {
    const klinesPromises = pairs.map(p => fetchKlinesForSymbol(p.symbol, "1m", 100));
    const allKlines = await Promise.all(klinesPromises);

    pairs.forEach((p, idx) => {
      const klines = allKlines[idx] || [];
      klines1mMap[p.symbol] = klines;
      if (klines.length > 0) {
        priceMap[p.symbol] = klines[klines.length - 1].close;
      }
    });
  } catch (err) {
    log(`⚠️ Multi-pair fetch error: ${err.message}`);
  }

  return { klines1mMap, priceMap };
}

async function getKlinesHTF(granularity, limit, symbol = CONFIG.SYMBOL) {
  // DRY_RUN mode: generate fake price data for testing
  if (CONFIG.DRY_RUN) {
    const basePrice = 71000;
    const klines = [];
    for (let i = limit - 1; i >= 0; i--) {
      const variation = (Math.random() - 0.5) * 500; // larger variation for HTF
      const price = basePrice + variation;
      klines.push({
        open: price,
        high: price + 200,
        low: price - 200,
        close: price,
        volume: Math.random() * 5000,
      });
    }
    return klines;
  }

  const res = await request(
    "GET",
    `/api/v2/mix/market/candles?symbol=${symbol}&productType=${CONFIG.PRODUCT_TYPE}&granularity=${granularity}&limit=${limit}`
  );
  if (!Array.isArray(res.data)) return [];
  return res.data.map(c => ({
    open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
  })).reverse();
}

// ================= ORDER EXECUTION =================

// Hitung size dalam BTC dari margin USDT
function calcSizeBTC(price) {
  const notional = CONFIG.POSITION_SIZE_USDT * CONFIG.LEVERAGE;
  const raw      = notional / price;
  // Minimum 0.00005 BTC (allows smaller positions), floor ke 5 desimal
  return Math.max(0.00005, Math.floor(raw * 100000) / 100000).toFixed(5);
}

// Set leverage sebelum open posisi
async function setLeverage() {
  const res = await request("POST", "/api/v2/mix/account/set-leverage", {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    marginCoin:  "USDT",
    leverage:    String(CONFIG.LEVERAGE),
  });
  if (res?.code === "00000") {
    log(`⚙️ Leverage set: ${CONFIG.LEVERAGE}x`);
  } else {
    log(`⚠️ Set leverage response: ${res?.msg || JSON.stringify(res)}`);
  }
  return res;
}

// Kirim market order ke Bitget
// side: "buy" | "sell"    tradeSide: "open" | "close"
async function placeOrder(side, tradeSide, size) {
  const body = {
    symbol:      CONFIG.SYMBOL,
    productType: CONFIG.PRODUCT_TYPE,
    marginMode:  "isolated",
    marginCoin:  "USDT",
    size:        String(size),
    side,
    tradeSide,
    orderType:   "market",
    force:       "gtc",
  };

  log(`📤 ORDER → ${side.toUpperCase()} ${tradeSide.toUpperCase()} ${size} BTC`);
  const res = await request("POST", "/api/v2/mix/order/place-order", body);

  if (res?.code === "00000") {
    log(`✅ ORDER OK — orderId: ${res.data?.orderId || "?"}`);
  } else {
    log(`❌ ORDER FAILED — code: ${res?.code} msg: ${res?.msg}`);
  }
  return res;
}

// Ambil posisi real dari Bitget (untuk close)
async function fetchRealPosition() {
  const res = await request(
    "GET",
    `/api/v2/mix/position/single-position?symbol=${CONFIG.SYMBOL}&productType=${CONFIG.PRODUCT_TYPE}&marginCoin=USDT`
  );
  const pos = Array.isArray(res.data) ? res.data[0] : res.data;
  return (pos && parseFloat(pos.total || 0) > 0) ? pos : null;
}

// ================= EXECUTION =================
async function openPosition(side, price, entryConfig, setup = "TREND") {
  log(`🚀 OPEN ${side} @ ${price} | DRY_RUN: ${CONFIG.DRY_RUN}`);

  const size = calcSizeBTC(price);
  const notional = parseFloat(size) * price;

  if (!CONFIG.DRY_RUN) {
    await setLeverage();

    const orderSide = side === "LONG" ? "buy" : "sell";
    const res       = await placeOrder(orderSide, "open", size);

    if (res?.code !== "00000") {
      log(`❌ OPEN DIBATALKAN — order gagal`);
      return; // Jangan set state kalau order gagal
    }
  }

  state.activePosition = {
    side,
    entry: price,
    setup,
    size,                 // Add size for dashboard display
    sizeUSDT: notional,   // Add notional for dashboard display
    symbol: currentSymbol,
    pairDisplayName: currentPairConfig?.displayName || currentSymbol,
    openedAt:      Date.now(),
    sl:            entryConfig.sl ?? 0.7,
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
    side, entry: price, leverage: CONFIG.LEVERAGE, setup, size, sizeUSDT: notional, pnl: 0, pnlPct: 0,
    symbol: currentSymbol, pairDisplayName: currentPairConfig?.displayName || currentSymbol,
  };
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

  const pnlUSDT = +(CONFIG.POSITION_SIZE_USDT * CONFIG.LEVERAGE * (pnl / 100)).toFixed(3);

  log(`💰 CLOSE @ ${price} | PnL: ${pnl.toFixed(2)}% (${pnlUSDT > 0 ? "+" : ""}${pnlUSDT} USDT) | ${reason}`);

  const trade = {
    id:        `T-${Date.now()}`,
    side:      pos.side,
    entry:     pos.entry,
    exit:      price,
    pnl:       +pnl.toFixed(4),
    pnlUSDT,
    result:    pnl > 0 ? "WIN" : "LOSS",
    reason,
    duration:  Math.round((Date.now() - state.lastTradeTime) / 60000),
    timestamp: state.lastTradeTime || Date.now(),
    exitTime:  Date.now(),
    setup:     pos.setup || "TREND",
    // Trade execution details
    size:      pos.size || "0",
    sizeUSDT:  pos.sizeUSDT || 0,
    leverage:  CONFIG.LEVERAGE,
    source:    global.botState.aiSource || "UNKNOWN",
  };

  global.botState.tradeHistory.push(trade);
  tradeMemory.updateSetupStats(trade.setup, trade.pnlUSDT);

  try {
    const dash = require("./dashboard-server");
    dash.recordTrade(trade);
  } catch {}

  state.activePosition = null;
  global.botState.activePosition = null;
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
        const shouldEval = forceEvalNextTick ||
          (Date.now() - lastPairEvalTime > CONFIG.PAIR_EVAL_INTERVAL_MS);

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
                log(`🔄 PAIR SWITCH: ${prevSymbol} → ${evalResult.nextPair} | Reason: ${evalResult.switchReason}`);
                pairManager.recordSwitch(prevSymbol, evalResult.nextPair, evalResult.switchReason);

                currentSymbol = evalResult.nextPair;
                currentPairConfig = newPairCfg;

                // Update CONFIG-like values for current pair
                CONFIG.LEVERAGE = currentPairConfig.leverage;
                CONFIG.POSITION_SIZE_USDT = currentPairConfig.positionSizeUSDT;

                global.botState.currentPair = currentSymbol;
                forceEvalNextTick = true;
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
        : await getKlines();
      if (!klines || klines.length < 10) {
        log("⚠️ INVALID KLINES");
        _tickRunning = false;
        await sleep(CONFIG.CHECK_INTERVAL);
        continue;
      }

      const price = klines[klines.length - 1].close;

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

      // Hanya SATU otak yang aktif — tidak ada voting/gabungan
      // Kondisi 1: AI_ENABLED=true DAN ANTHROPIC_API_KEY ada → orchestrator saja
      // Kondisi 2: salah satu tidak ada → btcStrategy saja
      // NEW: Respect forceMode override (manual toggle from dashboard)
      const forceMode = global.botState.forceMode;
      const keyAvailable = process.env.AI_ENABLED !== "false"
                        && !!process.env.ANTHROPIC_API_KEY;
      const aiEnabled = forceMode === "BOT" ? false
                      : forceMode === "AI"  ? keyAvailable
                      : keyAvailable && global.botState.aiHealthy !== false;

      let decision;
      if (aiEnabled) {
        // Bug 5: wrap dengan 12s timeout agar loop tidak hang
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
          }),
          12000,
          null  // Return null on timeout instead of HOLD
        );

        if (!decision || global.botState.aiHealthy === false) {
          // AI gagal/timeout → fallback ke btcStrategy dengan context HTF
          log(`🔄 FALLBACK: AI ${!decision ? 'timeout' : global.botState.aiDownReason} — using btcStrategy`);
          decision = btcStrategy.analyze({ klines, position: state.activePosition });
          decision.source = !decision.source
            ? "BTCSTRATEGY_FALLBACK"
            : decision.source;

          // Jangan blokir entry saat fallback — reset scoreBoard agar tidak confusing
          global.botState.scoreBoard = {
            htf_confidence: null,
            smc_confluence_score: null,
            decision_score: null,
            momentum_confidence: null,
            judas_confidence: null,
            regime: "FALLBACK_MODE",
            market_state: "UNKNOWN",
            timestamp: Date.now(),
          };
        }
      } else {
        decision = btcStrategy.analyze({ klines, position: state.activePosition });
        decision.source = "BTCSTRATEGY_ONLY";
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
      global.botState.aiSource = aiEnabled ? "ORCHESTRATOR" : "BTCSTRATEGY";
      global.botState.aiForced = forceMode !== null;
      global.botState.aiDownReason = global.botState.aiHealthy === false ? global.botState.aiDownReason : null;

      // Enhanced logging with confidence scores + AI mode
      const scoreStr = [
        htfConf !== null ? `HTF=${htfConf}%` : null,
        smcConf !== null ? `SMC=${smcConf}%` : null,
        decisionConf !== null ? `DECISION=${decisionConf}%` : null,
        momConf !== null ? `MOM=${momConf}%` : null,
        judasConf !== null ? `JUDAS=${judasConf}%` : null,
      ].filter(Boolean).join(" | ");

      const modeTag = aiEnabled ? "🤖" : "🔴";
      const logMsg = `${modeTag} ${decision.action} [${decision.source || "UNKNOWN"}]${scoreStr ? " | " + scoreStr : ""}${decision.reason ? " — " + decision.reason : ""}`;
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

        global.botState.activePosition = {
          side:     pos.side,
          entry:    pos.entry,
          leverage: CONFIG.LEVERAGE,
          setup:    pos.setup,
          size:     pos.size,
          sizeUSDT: pos.sizeUSDT,
          pnlPct:   +pnlPct.toFixed(3),
          pnl:      +pnlUSDT.toFixed(3),
        };
      } else {
        global.botState.activePosition = null;
      }

      if (decision.action === "LONG" || decision.action === "SHORT") {
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

        if (!state.activePosition && !_openingPosition && now - state.lastTradeTime > CONFIG.TRADE_COOLDOWN_MS) {
          const setup = decision.setup || "TREND";
          _openingPosition = true;
          try {
            await openPosition(decision.action, entryPrice, entryConfig, setup);
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
          log(`📉 PARTIAL CLOSE ${decision.percentage || 50}% — ${decision.reason || ""}`);
          await closePosition(price, `PARTIAL ${decision.percentage || 50}%`);
        }
      }

      else if (decision.action === "UPDATE_SL") {
        if (state.activePosition && decision.new_sl) {
          log(`🔧 UPDATE SL → ${decision.new_sl} — ${decision.reason || ""}`);
          state.activePosition.sl = decision.new_sl;
        }
      }

      else if (decision.action === "PYRAMID") {
        if (state.activePosition) {
          await addPosition(decision.level);
        }
      }

      _tickRunning = false;

    } catch (err) {
      _tickRunning = false;
      log("ERROR: " + err.message);
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

run();