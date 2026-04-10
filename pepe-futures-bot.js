"use strict";

require("dotenv").config();
const https = require("https");
const crypto = require("crypto");

const btcStrategy = require("./btcStrategy");

// ================= CONFIG =================
const CONFIG = {
  SYMBOL: "BTCUSDT",
  PRODUCT_TYPE: "usdt-futures",

  API_KEY: process.env.BITGET_API_KEY,
  SECRET_KEY: process.env.BITGET_SECRET_KEY,
  PASSPHRASE: process.env.BITGET_PASSPHRASE,

  LEVERAGE: 7,
  POSITION_SIZE_USDT: 15,

  TRADE_COOLDOWN_MS: 5 * 60 * 1000,
  CHECK_INTERVAL: 20000,

  DRY_RUN: process.env.DRY_RUN !== "false",
};

// ================= STATE =================
let state = {
  activePosition: null,
  lastTradeTime: 0,
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
};

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

// ================= SAFE REQUEST =================
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

// ================= EXECUTION =================
async function openPosition(side, price, entryConfig, setup = "TREND") {
  log(`🚀 OPEN ${side} @ ${price}`);

  state.activePosition = {
    side,
    entry: price,
    setup,
    sl:            entryConfig.sl,
    trailActivate: entryConfig.trailActivate,
    trailDrop:     entryConfig.trailDrop,
    pyr1:          entryConfig.pyr1,
    pyr2:          entryConfig.pyr2,
    peak:          0,
    pyr1Done:      false,
    pyr2Done:      false,
  };

  state.lastTradeTime = Date.now();
  global.botState.activePosition = { side, entry: price, leverage: CONFIG.LEVERAGE, setup };
}

async function closePosition(price, reason = "UNKNOWN") {
  const pos = state.activePosition;
  if (!pos) return;

  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) / pos.entry * 100
      : (pos.entry - price) / pos.entry * 100;

  const pnlUSDT = +(CONFIG.POSITION_SIZE_USDT * CONFIG.LEVERAGE * (pnl / 100)).toFixed(3);

  log(`💰 CLOSE @ ${price} | PnL: ${pnl.toFixed(2)}% (${pnlUSDT > 0 ? "+" : ""}${pnlUSDT} USDT) | ${reason}`);

  // Record trade for dashboard analytics
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
  };

  global.botState.tradeHistory.push(trade);

  // Persist via dashboard recorder if available
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
}

// ================= MAIN LOOP =================
async function run() {
  while (true) {
    try {
      const now = Date.now();

      const klines = await getKlines();
      if (!klines || klines.length < 10) {
        log("⚠️ INVALID KLINES");
        await sleep(CONFIG.CHECK_INTERVAL);
        continue;
      }

      const price = klines[klines.length - 1].close;

      const decision = btcStrategy.analyze({
        klines,
        position: state.activePosition,
      });

      log(`🧠 ${decision.action}`);

      // Sync live state to global.botState for dashboard
      global.botState.price        = price;
      global.botState.lastDecision = decision.action;
      global.botState.botStatus    = "RUNNING";

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
          pnlPct:   +pnlPct.toFixed(3),
          pnl:      +pnlUSDT.toFixed(3),
        };
      } else {
        global.botState.activePosition = null;
      }

      if (decision.action === "LONG" || decision.action === "SHORT") {
        if (!decision.entry) continue;

        if (!state.activePosition && now - state.lastTradeTime > CONFIG.TRADE_COOLDOWN_MS) {
          const setup = decision.setup || "TREND";
          await openPosition(decision.action, price, decision.entry, setup);
        }
      }

      else if (decision.action === "CLOSE") {
        if (state.activePosition) {
          log(`📉 ${decision.reason}`);
          await closePosition(price, decision.reason || "SIGNAL");
        }
      }

      else if (decision.action === "PYRAMID") {
        if (state.activePosition) {
          await addPosition(decision.level);
        }
      }

    } catch (err) {
      log("ERROR: " + err.message);
    }

    await sleep(CONFIG.CHECK_INTERVAL);
  }
}

// ── START DASHBOARD ──────────────────────────────────────
try {
  require("./dashboard-server").start();
} catch (e) {
  log("⚠️ Dashboard failed to start: " + e.message);
}

run();