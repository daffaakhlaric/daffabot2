"use strict";

/**
 * HEDGE FUND TRADING DASHBOARD — Backend Server
 * Express-free, dependency-free (uses only built-in Node modules + ws which is
 * already installed transitively via @supabase/supabase-js)
 */

require("dotenv").config();

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const https  = require("https");
const WebSocket = require("ws");

const analytics = require("./analytics");

// ── CONFIG ──────────────────────────────────────────────
const PORT             = parseInt(process.env.MONITOR_PORT || process.env.DASHBOARD_PORT || "3000", 10);
const INITIAL_EQ       = parseFloat(process.env.INITIAL_EQUITY || "1000");
const SYMBOL           = process.env.BTC_SYMBOL || "BTCUSDT";
const PRODUCT_TYPE     = "usdt-futures";
const POSITION_SIZE    = parseFloat(process.env.POSITION_SIZE_USDT || "15");
const DEFAULT_LEVERAGE = parseFloat(process.env.LEVERAGE || "7");
const TRADE_FILE    = path.join(__dirname, "trade-history.json");
const DASHBOARD_DIR = path.join(__dirname, "dashboard");

const API_KEY    = process.env.BITGET_API_KEY;
const SECRET_KEY = process.env.BITGET_SECRET_KEY;
const PASSPHRASE = process.env.BITGET_PASSPHRASE;

// ── TRADE HISTORY ────────────────────────────────────────
function loadTrades() {
  try {
    if (fs.existsSync(TRADE_FILE)) {
      return JSON.parse(fs.readFileSync(TRADE_FILE, "utf8"));
    }
  } catch {}
  return [];
}

function saveTrades(trades) {
  try {
    fs.writeFileSync(TRADE_FILE, JSON.stringify(trades, null, 2));
  } catch (e) {
    console.error("[DASHBOARD] Failed to save trades:", e.message);
  }
}

let tradeHistory = loadTrades();

// Public: bot calls this to record a closed trade
function recordTrade(trade) {
  if (tradeHistory.some(t => t.id === trade.id)) return; // dedup — prevent double-record
  tradeHistory.push(trade);
  if (tradeHistory.length > 5000) tradeHistory = tradeHistory.slice(-5000);
  saveTrades(tradeHistory);
}

// ── BITGET API ───────────────────────────────────────────
function bitgetSign(ts, method, path, body = "") {
  return crypto
    .createHmac("sha256", SECRET_KEY || "")
    .update(ts + method + path + body)
    .digest("base64");
}

function bitgetRequest(method, endpoint, body = null) {
  if (!API_KEY || !SECRET_KEY || !PASSPHRASE) {
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    const ts      = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const headers = {
      "ACCESS-KEY":        API_KEY,
      "ACCESS-SIGN":       bitgetSign(ts, method, endpoint, bodyStr),
      "ACCESS-TIMESTAMP":  ts,
      "ACCESS-PASSPHRASE": PASSPHRASE,
      "Content-Type":      "application/json",
    };

    const req = https.request(
      { hostname: "api.bitget.com", path: endpoint, method, headers },
      res => {
        let data = "";
        res.on("data", d => (data += d));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      }
    );

    req.on("error", () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── LIVE DATA ────────────────────────────────────────────
let liveData = {
  price:         0,
  balance:       0,
  equity:        0,
  unrealizedPnL: 0,
  activePosition: null,
  marketState:   "UNKNOWN",
  lastDecision:  "HOLD",
  botStatus:     "CONNECTING",
  lastUpdate:    null,
  apiConnected:  false,
  logs:          [],
  scoreBoard:    {},
};

async function fetchLiveData() {
  // ── Bot state: ambil field non-API dari global.botState ──
  // ── 1. Baca dari global.botState (sumber kebenaran utama) ─
  if (global.botState) {
    const s = global.botState;
    if (s.price)                    liveData.price          = s.price;
    if (s.marketState)              liveData.marketState    = s.marketState;
    if (s.lastDecision)             liveData.lastDecision   = s.lastDecision;
    if (s.botStatus)                liveData.botStatus      = s.botStatus;
    if (s.tradeHistory?.length)     tradeHistory            = s.tradeHistory.slice(); // copy, bukan alias
    if (s.logs?.length)             liveData.logs           = s.logs.slice(-200);    // last 200 logs

    // Posisi dari bot selalu prioritas — termasuk saat DRY_RUN
    // (Bitget tidak punya posisi jika DRY_RUN, jadi jangan overwrite dengan null)
    liveData.activePosition = s.activePosition !== undefined
      ? s.activePosition
      : liveData.activePosition;

    // Upgrade data: decision score, bot mode, trade memory, scoreBoard
    liveData.decisionScore = s.decisionScore ?? null;
    liveData.botMode       = process.env.BOT_MODE || "SAFE";

    // Add AI mode info for mode toggle
    liveData.aiMode        = s.aiMode !== false;
    liveData.aiSource      = s.aiSource || "UNKNOWN";
    liveData.forceMode     = s.forceMode || null;       // null = AUTO, "AI", "BOT"
    liveData.aiHealthy     = s.aiHealthy !== false;     // false if billing/auth error
    liveData.aiDownReason  = s.aiDownReason || null;    // "BILLING" | "AUTH" | "OVERLOADED"
    liveData.aiForced      = s.aiForced || false;       // true if manually set

    // Add scoreBoard for confidence monitoring
    if (s.scoreBoard) {
      liveData.scoreBoard = {
        htf_confidence:       s.scoreBoard.htf_confidence,
        smc_confluence_score: s.scoreBoard.smc_confluence_score,
        decision_score:       s.scoreBoard.decision_score,
        momentum_confidence:  s.scoreBoard.momentum_confidence,
        judas_confidence:     s.scoreBoard.judas_confidence,
        regime:               s.scoreBoard.regime,
        market_state:         s.scoreBoard.market_state,
        timestamp:            s.scoreBoard.timestamp,
      };
    }

    try {
      const tm = require("./tradeMemory");
      liveData.tradeMemory = s.tradeMemory || null;
      if (!liveData.tradeMemory) {
        const rawStats = tm.getStats();
        if (rawStats.length) {
          liveData.tradeMemory = rawStats.reduce((acc, entry) => {
            acc[entry.setup] = { win: 0, loss: 0, totalPnL: 0, streak: 0, ...require("./trade-memory.json")?.[entry.setup] };
            return acc;
          }, {});
        }
      }
    } catch {}
  } else {
    liveData.botStatus = "RUNNING";
  }

  // ── 2. Fetch Bitget secara paralel (balance + harga) ─────
  const [accsRes, posRes, tickRes] = await Promise.all([
    bitgetRequest("GET", `/api/v2/mix/account/accounts?productType=${PRODUCT_TYPE}`),
    bitgetRequest("GET", `/api/v2/mix/position/single-position?symbol=${SYMBOL}&productType=${PRODUCT_TYPE}&marginCoin=USDT`),
    bitgetRequest("GET", `/api/v2/mix/market/ticker?symbol=${SYMBOL}&productType=${PRODUCT_TYPE}`),
  ]);

  liveData._raw        = { accsRes, posRes, tickRes };
  liveData.lastUpdate  = Date.now();

  // ── BALANCE & EQUITY (dari Bitget) ───────────────────────
  const accsOk = accsRes?.code === "00000" && Array.isArray(accsRes.data);
  if (accsOk) {
    const usdt = accsRes.data.find(a => a.marginCoin === "USDT") || accsRes.data[0];
    if (usdt) {
      liveData.balance       = parseFloat(usdt.available                              || 0);
      liveData.equity        = parseFloat(usdt.usdtEquity  || usdt.equity             || 0);
      liveData.unrealizedPnL = parseFloat(usdt.unrealizedPL || usdt.crossedUnrealizedPL || 0);
    }
  }

  // ── POSISI AKTIF ─────────────────────────────────────────
  const posOk = posRes?.code === "00000";
  if (posOk) {
    const pos = Array.isArray(posRes.data) ? posRes.data[0] : posRes.data;
    const qty = parseFloat(pos?.total || 0);
    if (pos && qty > 0) {
      liveData.activePosition = {
        // Core
        side:         pos.holdSide === "long" ? "LONG" : "SHORT",
        marginMode:   pos.marginMode || "isolated",
        leverage:     parseFloat(pos.leverage        || 1),
        // Size
        size:         qty,
        sizeUSDT:     parseFloat(pos.notionalUsd     || 0),
        available:    parseFloat(pos.available        || 0),
        // Prices
        entry:        parseFloat(pos.openPriceAvg    || 0),
        markPrice:    parseFloat(pos.markPrice        || 0),
        breakEven:    parseFloat(pos.breakEvenPrice   || 0),
        liquidation:  parseFloat(pos.liquidationPrice || 0),
        // PnL
        pnl:          parseFloat(pos.unrealizedPL     || 0),
        pnlPct:       parseFloat(pos.unrealizedPLR    || 0) * 100, // ROE
        realizedPnL:  parseFloat(pos.achievedProfits  || 0),
        // Margin
        margin:       parseFloat(pos.margin           || 0),
        marginRatio:  parseFloat(pos.marginRatio      || 0) * 100,
        mmr:          parseFloat(pos.keepMarginRate   || 0) * 100,
      };
    }
    // DRY_RUN: kalau Bitget kosong, biarkan dari botState
  }

  // ── HARGA ────────────────────────────────────────────────
  const tickOk = tickRes?.code === "00000";
  if (tickOk) {
    const tick = Array.isArray(tickRes.data) ? tickRes.data[0] : tickRes.data;
    const raw  = parseFloat(tick?.lastPr || tick?.last || tick?.close || 0);
    if (raw > 0) liveData.price = raw;
  }

  // ── FALLBACK PnL — hitung dari harga live jika PnL masih 0 ─
  // (terjadi saat: baru buka posisi, atau Bitget API gagal return PnL)
  if (liveData.activePosition && liveData.price > 0) {
    const p = liveData.activePosition;
    if ((!p.pnl || p.pnl === 0) && p.entry > 0) {
      const lev  = p.leverage || DEFAULT_LEVERAGE;
      const pct  = p.side === "LONG"
        ? (liveData.price - p.entry) / p.entry * 100
        : (p.entry - liveData.price) / p.entry * 100;
      p.pnlPct = +pct.toFixed(3);
      p.pnl    = +(POSITION_SIZE * lev * (pct / 100)).toFixed(3);
    }
  }

  // ── STATUS KONEKSI ────────────────────────────────────────
  liveData.apiConnected = accsOk || posOk || tickOk;

  if (!liveData.apiConnected) {
    console.warn("[DASHBOARD] ⚠️ Semua Bitget API gagal — cek API key / koneksi");
  }
}

// ── ANALYTICS PAYLOAD ───────────────────────────────────
function buildPayload() {
  const analyticsData = analytics.buildAnalytics(tradeHistory, INITIAL_EQ);

  return {
    timestamp: Date.now(),
    live:      liveData,
    analytics: analyticsData,
  };
}

// ── HTTP SERVER ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // CORS headers for dev convenience
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ── OPTIONS preflight handler (CORS) ────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (url === "/" || url === "/dashboard") {
    const htmlPath = path.join(DASHBOARD_DIR, "index.html");
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("dashboard/index.html not found");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(htmlPath));
  }

  if (url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(buildPayload()));
  }

  if (url === "/api/trades") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(tradeHistory.slice(-200)));
  }

  if (url === "/api/logs") {
    const logs = global.botState?.logs || [];
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(logs));
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  }

  // Debug: lihat raw response Bitget → buka di browser: http://localhost:3000/api/debug
  if (url === "/api/debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      liveData: { ...liveData, _raw: undefined }, // tanpa raw
      raw: liveData._raw || "belum ada data — tunggu 5 detik",
    }, null, 2));
  }

  // ── POST /api/mode: Toggle between AI/BOT mode ────────────
  if (url === "/api/mode" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const { mode } = data; // "AI" | "BOT" | "AUTO"

        if (!["AI", "BOT", "AUTO"].includes(mode)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Invalid mode. Use: AI, BOT, or AUTO" }));
        }

        // Set forceMode: null for AUTO, "AI" or "BOT" for forced modes
        global.botState.forceMode = mode === "AUTO" ? null : mode;
        global.botState.aiForced = mode !== "AUTO";

        // If user forces AI back on, reset aiHealthy to trigger retry
        if (mode === "AI") {
          global.botState.aiHealthy = true;
          global.botState.aiDownReason = null;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          forceMode: global.botState.forceMode,
          message: `Mode set to ${mode}`
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + err.message }));
      }
    });
    return;
  }

  // Static assets: CSS, source maps, JS
  if (url.startsWith("/css/") || url.startsWith("/js/")) {
    const assetPath = path.join(DASHBOARD_DIR, url);
    // Prevent path traversal: ensure resolved path is inside DASHBOARD_DIR
    if (!assetPath.startsWith(DASHBOARD_DIR + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    if (!fs.existsSync(assetPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(assetPath);
    const mimeTypes = {
      ".css": "text/css",
      ".map": "application/json",
      ".js": "text/javascript",
    };
    const contentType = mimeTypes[ext] || "text/plain";
    res.writeHead(200, { "Content-Type": contentType });
    return res.end(fs.readFileSync(assetPath));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ── WEBSOCKET ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", ws => {
  console.log("[DASHBOARD] Client connected");
  // Send initial data immediately on connect
  try {
    ws.send(JSON.stringify(buildPayload()));
  } catch {}
});

// Broadcast to all connected clients
function broadcast() {
  if (!wss.clients.size) return;
  const payload = JSON.stringify(buildPayload());
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch {}
    }
  }
}

// ── MAIN LOOP ────────────────────────────────────────────
let started = false;

async function start() {
  if (started) return;
  started = true;

  // Ensure dashboard dir exists
  if (!fs.existsSync(DASHBOARD_DIR)) {
    fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
  }

  server.listen(PORT, () => {
    console.log(`[DASHBOARD] ✅ Running at http://localhost:${PORT}`);
    console.log(`[DASHBOARD] 📊 Loaded ${tradeHistory.length} trades`);
  });

  // Fetch live data + broadcast loop
  setInterval(async () => {
    try {
      await fetchLiveData();
    } catch (e) {
      console.error("[DASHBOARD] fetchLiveData error:", e.message);
    }
  }, 5000);

  setInterval(broadcast, 3000);

  // Initial fetch
  fetchLiveData().catch(() => {});
}

module.exports = { start, recordTrade };

// Auto-start when run directly: node dashboard-server.js
if (require.main === module) {
  start();
}
