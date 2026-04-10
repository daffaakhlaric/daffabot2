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
const PORT          = parseInt(process.env.MONITOR_PORT || process.env.DASHBOARD_PORT || "3000", 10);
const INITIAL_EQ    = parseFloat(process.env.INITIAL_EQUITY || "1000");
const SYMBOL        = process.env.BTC_SYMBOL || "BTCUSDT";
const PRODUCT_TYPE  = "usdt-futures";
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
  // Return demo data when no real trades exist
  console.log("[DASHBOARD] No trade-history.json found — loading demo data");
  return analytics.generateDemoTrades(60);
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
  tradeHistory.push(trade);
  // Keep last 5000 trades in memory
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
};

async function fetchLiveData() {
  // Prefer in-process bot state if available
  if (global.botState) {
    const s = global.botState;
    liveData.price         = s.price || liveData.price;
    liveData.balance       = s.balance || liveData.balance;
    liveData.equity        = s.equity  || liveData.equity;
    liveData.unrealizedPnL = s.unrealizedPnL || 0;
    liveData.activePosition = s.activePosition || null;
    liveData.marketState   = s.marketState  || "UNKNOWN";
    liveData.lastDecision  = s.lastDecision || "HOLD";
    liveData.botStatus     = s.botStatus    || "RUNNING";
    liveData.lastUpdate    = Date.now();
    liveData.apiConnected  = true;

    if (s.tradeHistory && s.tradeHistory.length) {
      tradeHistory = s.tradeHistory;
    }
    return;
  }

  // Fetch from Bitget REST API
  const [accRes, posRes, tickRes] = await Promise.all([
    bitgetRequest("GET", `/api/v2/mix/account/account?symbol=${SYMBOL}&productType=${PRODUCT_TYPE}&marginCoin=USDT`),
    bitgetRequest("GET", `/api/v2/mix/position/single-position?symbol=${SYMBOL}&productType=${PRODUCT_TYPE}&marginCoin=USDT`),
    bitgetRequest("GET", `/api/v2/mix/market/ticker?symbol=${SYMBOL}&productType=${PRODUCT_TYPE}`),
  ]);

  liveData.apiConnected = !!(accRes || posRes || tickRes);
  liveData.lastUpdate   = Date.now();
  liveData.botStatus    = "RUNNING";

  if (accRes?.data) {
    const acc = Array.isArray(accRes.data) ? accRes.data[0] : accRes.data;
    liveData.balance = parseFloat(acc?.available || 0);
    liveData.equity  = parseFloat(acc?.accountEquity || acc?.equity || 0);
    liveData.unrealizedPnL = parseFloat(acc?.unrealizedPL || acc?.crossUnrealizedPL || 0);
  }

  if (posRes?.data) {
    const pos = Array.isArray(posRes.data) ? posRes.data[0] : posRes.data;
    if (pos && parseFloat(pos.total || 0) > 0) {
      liveData.activePosition = {
        side:    pos.holdSide === "long" ? "LONG" : "SHORT",
        entry:   parseFloat(pos.openPriceAvg || 0),
        size:    parseFloat(pos.total || 0),
        pnl:     parseFloat(pos.unrealizedPL || 0),
        pnlPct:  parseFloat(pos.unrealizedPLR || 0) * 100,
        leverage: parseFloat(pos.leverage || 1),
      };
    } else {
      liveData.activePosition = null;
    }
  }

  if (tickRes?.data) {
    const tick = Array.isArray(tickRes.data) ? tickRes.data[0] : tickRes.data;
    liveData.price = parseFloat(tick?.lastPr || tick?.last || 0);
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
  res.setHeader("Access-Control-Allow-Methods", "GET");

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

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
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
