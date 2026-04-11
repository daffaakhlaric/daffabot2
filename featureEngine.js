"use strict";

/**
 * FEATURE ENGINE — All AI feature engines for DaffaBot.
 * Pattern: raw HTTPS to Anthropic API, no extra npm packages.
 */

require("dotenv").config();
const https = require("https");
const PROMPTS = require("./prompts");

// ── CACHE SYSTEM ──────────────────────────────────────────
const CACHE = {};
const COOLDOWNS = {
  f1_htf:       15 * 60 * 1000,
  f2_smc:        3 * 60 * 1000,
  sniper:        1 * 60 * 1000,
  judas:            30 * 1000,
  sweep:         2 * 60 * 1000,
  regime:       15 * 60 * 1000,
  compounder:    5 * 60 * 1000,
  momentum:         30 * 1000,
  ob_scorer:    10 * 60 * 1000,
  macro:        60 * 60 * 1000,
  exit:             20 * 1000,
  orchestrator:  1 * 60 * 1000,
};

function getCached(key) {
  const entry = CACHE[key];
  if (!entry) return null;
  const cooldown = COOLDOWNS[key] || COOLDOWNS["exit"] || 20000;
  if (Date.now() - entry.ts < cooldown) return entry.result;
  return null;
}

function setCache(key, result) {
  CACHE[key] = { ts: Date.now(), result };
}

// ── AI LOG ────────────────────────────────────────────────
function aiLog(feature, latency_ms, result_summary) {
  try {
    if (!global.botState) return;
    if (!global.botState.aiLogs) global.botState.aiLogs = [];
    global.botState.aiLogs.push({ ts: Date.now(), feature, latency_ms, result_summary });
    if (global.botState.aiLogs.length > 500) global.botState.aiLogs.shift();
  } catch {}
}

// ── CLAUDE API CALL ────────────────────────────────────────
function claudeCall(systemPrompt, userPrompt) {
  return new Promise(resolve => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { resolve(null); return; }

    const body = JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    const options = {
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length":    Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || "";
          const match = text.match(/\{[\s\S]*\}/);
          if (match) resolve(JSON.parse(match[0]));
          else resolve(null);
        } catch { resolve(null); }
      });
    });

    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── HELPERS ───────────────────────────────────────────────
function formatKlines(klines, limit = 20) {
  if (!Array.isArray(klines)) return "[]";
  const slice = klines.slice(-limit);
  return slice.map(k =>
    `[O:${(k.open||0).toFixed(1)} H:${(k.high||0).toFixed(1)} L:${(k.low||0).toFixed(1)} C:${(k.close||0).toFixed(1)} V:${(k.volume||0).toFixed(0)}]`
  ).join(" ");
}

function extractSwings(klines, lookback = 10) {
  const highs = [], lows = [];
  const k = klines.slice(-lookback * 3);
  for (let i = 2; i < k.length - 2; i++) {
    if (k[i].high >= k[i-1].high && k[i].high >= k[i+1].high &&
        k[i].high >= k[i-2].high && k[i].high >= k[i+2].high) {
      highs.push(+(k[i].high).toFixed(1));
    }
    if (k[i].low <= k[i-1].low && k[i].low <= k[i+1].low &&
        k[i].low <= k[i-2].low && k[i].low <= k[i+2].low) {
      lows.push(+(k[i].low).toFixed(1));
    }
  }
  return { highs: highs.slice(-5), lows: lows.slice(-5) };
}

function calcATR(klines, period = 14) {
  const k = klines.slice(-period - 1);
  if (k.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(
      k[i].high - k[i].low,
      Math.abs(k[i].high - k[i-1].close),
      Math.abs(k[i].low  - k[i-1].close)
    );
    total += tr;
  }
  const atr = total / (k.length - 1);
  const lastClose = k[k.length - 1].close;
  return lastClose > 0 ? (atr / lastClose * 100) : 0;
}

function calcEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 2)  return "Asian Kill Zone";
  if (h >= 7  && h < 9)  return "London";
  if (h >= 11 && h < 12) return "London Close";
  if (h >= 13 && h < 16) return "New York";
  if (h >= 17 && h < 18) return "NY PM";
  if (h >= 20 && h < 21) return "NY Close";
  return "OFF";
}

function getWIBTime() {
  const d = new Date();
  const wib = new Date(d.getTime() + 7 * 3600000);
  return `${String(wib.getUTCHours()).padStart(2,"0")}:${String(wib.getUTCMinutes()).padStart(2,"0")} WIB`;
}

// ── F1 — HTF BIAS SCANNER ─────────────────────────────────
async function callF1({ klines_4h, klines_1h, price }) {
  const cached = getCached("f1_htf");
  if (cached) return cached;

  const t0 = Date.now();
  const vars = {
    price: price.toFixed(2),
    klines_4h: formatKlines(klines_4h, 20),
    klines_1h: formatKlines(klines_1h, 30),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.F1.user, vars);
  const result = await claudeCall(PROMPTS.F1.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("f1_htf", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), f1: result };
    aiLog("F1_HTF", lat, `Bias=${result.htf_bias} conf=${result.confidence}%`);
  }
  return result;
}

// ── F2 — SMC SIGNAL ENGINE ────────────────────────────────
async function callF2({ klines_4h, klines_1h, klines_15m, klines_5m, price, htfBias, fundingRate = 0, oiChange = 0 }) {
  const cached = getCached("f2_smc");
  if (cached) return cached;

  const swings = extractSwings(klines_1h || klines_15m || [], 15);
  const session = getSession();
  const t0 = Date.now();

  const vars = {
    price: price.toFixed(2),
    htf_bias:        htfBias?.htf_bias || "UNKNOWN",
    htf_confidence:  htfBias?.confidence || 50,
    funding_rate:    fundingRate.toFixed(4),
    oi_change:       oiChange.toFixed(2),
    klines_4h:       formatKlines(klines_4h, 15),
    klines_1h:       formatKlines(klines_1h, 20),
    klines_15m:      formatKlines(klines_15m, 40),
    klines_5m:       formatKlines(klines_5m || klines_15m, 20),
    bsl_levels:      JSON.stringify(swings.highs),
    ssl_levels:      JSON.stringify(swings.lows),
    current_session: session,
    session_wib:     getWIBTime(),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.F2.user, vars);
  const result = await claudeCall(PROMPTS.F2.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("f2_smc", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), f2: result };
    aiLog("F2_SMC", lat, `Signal=${result.signal} setup=${result.setup_type} score=${result.confluence_score}`);
  }
  return result;
}

// ── SNIPER MODE ───────────────────────────────────────────
async function sniperMode({ klines_15m, klines_5m, price, htf_bias, htf_score }) {
  const cached = getCached("sniper");
  if (cached) return cached;

  const t0 = Date.now();
  const vars = {
    price:      price.toFixed(2),
    htf_bias:   htf_bias || "UNKNOWN",
    htf_score:  htf_score || 50,
    bullish_obs: "N/A",
    bearish_obs: "N/A",
    fvgs:        "N/A",
    last_sweep:  "N/A",
    klines_15m:  formatKlines(klines_15m, 50),
    klines_5m:   formatKlines(klines_5m || klines_15m, 30),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.SNIPER.user, vars);
  const result = await claudeCall(PROMPTS.SNIPER.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("sniper", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), sniper: result };
    aiLog("SNIPER", lat, `avail=${result.sniper_available} entry=${result.entry_price} conf=${result.confidence}`);
  }
  return result;
}

// ── JUDAS SWING DETECTOR ──────────────────────────────────
async function judasSweepDetector({ klines_15m, klines_5m, klines_1m, price }) {
  const cached = getCached("judas");
  if (cached) return cached;

  const t0 = Date.now();
  const kl15 = klines_15m || klines_5m || klines_1m;
  const kl5  = klines_5m  || klines_1m;
  const kl1  = klines_1m  || klines_5m;
  const swings = extractSwings(kl15, 15);
  const last1h = kl15.slice(-4);
  const lastH1 = last1h.length ? last1h[last1h.length - 1] : { open: price, high: price, low: price, close: price };

  const vars = {
    price:      price.toFixed(2),
    utc_time:   new Date().toUTCString(),
    session:    getSession(),
    swing_highs: JSON.stringify(swings.highs),
    swing_lows:  JSON.stringify(swings.lows),
    equal_highs: JSON.stringify(swings.highs.filter((v, i, a) => a.filter(x => Math.abs(x - v) < price * 0.001).length > 1).slice(-3)),
    equal_lows:  JSON.stringify(swings.lows.filter((v, i, a) => a.filter(x => Math.abs(x - v) < price * 0.001).length > 1).slice(-3)),
    klines_15m:  formatKlines(kl15, 30),
    klines_5m:   formatKlines(kl5, 40),
    klines_1m:   formatKlines(kl1, 20),
    h1_o:  lastH1.open?.toFixed(1),
    h1_h:  lastH1.high?.toFixed(1),
    h1_l:  lastH1.low?.toFixed(1),
    h1_c:  lastH1.close?.toFixed(1),
    htf_bias: global.botState?.features?.f1?.htf_bias || "UNKNOWN",
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.JUDAS.user, vars);
  const result = await claudeCall(PROMPTS.JUDAS.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("judas", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), judas: result };
    aiLog("JUDAS", lat, `detected=${result.judas_detected} type=${result.type} conf=${result.confidence}`);
  }
  return result;
}

// ── LIQUIDITY SWEEP ENGINE ────────────────────────────────
async function liquiditySweepEngine({ klines_15m, klines_5m, price, htf_bias }) {
  const cached = getCached("sweep");
  if (cached) return cached;

  const t0 = Date.now();
  const kl = klines_15m || klines_5m;
  const swings = extractSwings(kl, 20);
  const avgVol = kl.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const lastK = kl[kl.length - 1];
  const volRatio = avgVol > 0 ? lastK.volume / avgVol : 1;
  const bslLevel = swings.highs[swings.highs.length - 1] || price * 1.01;
  const sslLevel = swings.lows[swings.lows.length - 1] || price * 0.99;

  const vars = {
    price:          price.toFixed(2),
    htf_bias:       htf_bias || "UNKNOWN",
    bsl_level:      bslLevel.toFixed(2),
    bsl_details:    `swing high, ${volRatio.toFixed(1)}x vol`,
    ssl_level:      sslLevel.toFixed(2),
    ssl_details:    `swing low, ${volRatio.toFixed(1)}x vol`,
    current_volume: lastK.volume.toFixed(0),
    avg_volume:     avgVol.toFixed(0),
    volume_ratio:   volRatio.toFixed(2),
    klines_15m:     formatKlines(kl, 20),
    klines_5m:      formatKlines(klines_5m || kl, 30),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.SWEEP.user, vars);
  const result = await claudeCall(PROMPTS.SWEEP.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("sweep", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), sweep: result };
    aiLog("SWEEP", lat, `rec=${result.overall_recommendation} sweeps=${result.sweeps?.length}`);
  }
  return result;
}

// ── VOLATILITY REGIME DETECTOR ────────────────────────────
async function volatilityRegime({ klines_1h, price }) {
  const cached = getCached("regime");
  if (cached) return cached;

  const t0 = Date.now();
  const closes = klines_1h.map(k => k.close);
  const ema20 = calcEMA(closes, 20) || price;
  const ema50 = calcEMA(closes, 50) || price;
  const atr14 = calcATR(klines_1h, 14);
  const swings = extractSwings(klines_1h, 20);

  // Simple ATR stats
  const atrs = [];
  for (let i = 1; i < klines_1h.length; i++) {
    const k = klines_1h[i], p = klines_1h[i-1];
    atrs.push(Math.max(k.high - k.low, Math.abs(k.high - p.close), Math.abs(k.low - p.close)));
  }
  const atr_avg = atrs.reduce((s, v) => s + v, 0) / atrs.length;
  const atr_sd = Math.sqrt(atrs.reduce((s, v) => s + Math.pow(v - atr_avg, 2), 0) / atrs.length);

  // ADX approximation
  let plus_dm = 0, minus_dm = 0;
  for (let i = 1; i < Math.min(15, klines_1h.length); i++) {
    const h = klines_1h[i].high - klines_1h[i-1].high;
    const l = klines_1h[i-1].low - klines_1h[i].low;
    if (h > l && h > 0) plus_dm += h;
    if (l > h && l > 0) minus_dm += l;
  }
  const adx_approx = atr_avg > 0 ? Math.round(Math.abs(plus_dm - minus_dm) / (plus_dm + minus_dm) * 100) : 20;

  const vars = {
    price:      price.toFixed(2),
    klines_1h:  formatKlines(klines_1h, 50),
    ema20:      ema20.toFixed(2),
    ema50:      ema50.toFixed(2),
    atr14:      atr14.toFixed(4),
    atr_avg:    (atr_avg / price * 100).toFixed(4),
    atr_sd:     (atr_sd / price * 100).toFixed(4),
    adx_approx: adx_approx,
    swing_highs: JSON.stringify(swings.highs),
    swing_lows:  JSON.stringify(swings.lows),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.REGIME.user, vars);
  const result = await claudeCall(PROMPTS.REGIME.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("regime", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), regime: result };
    aiLog("REGIME", lat, `regime=${result.regime} lev=${result.recommended_leverage}x`);
  }
  return result;
}

// ── KILL ZONE TIMER (pure JS, no API) ────────────────────
function killZoneTimer() {
  const now  = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const totalMin = utcH * 60 + utcM;

  const zones = [
    { name: "ASIAN_KZ",    start: 0*60,    end: 2*60,    quality: "GOOD",    bias: "NEUTRAL", mult: 0.8 },
    { name: "LONDON_OPEN", start: 7*60,    end: 9*60,    quality: "PRIME",   bias: "BEARISH", mult: 1.2 },
    { name: "LONDON_CLOSE",start: 11*60,   end: 12*60,   quality: "AVERAGE", bias: "NEUTRAL", mult: 0.9 },
    { name: "NY_OPEN",     start: 13*60+30,end: 15*60+30,quality: "PRIME",   bias: "NEUTRAL", mult: 1.2 },
    { name: "NY_PM",       start: 17*60,   end: 18*60,   quality: "AVERAGE", bias: "NEUTRAL", mult: 0.8 },
    { name: "NY_CLOSE",    start: 20*60,   end: 21*60,   quality: "POOR",    bias: "NEUTRAL", mult: 0.5 },
    { name: "OFF_HOURS",   start: 21*60,   end: 24*60,   quality: "AVOID",   bias: "NEUTRAL", mult: 0.0 },
    { name: "OFF_HOURS",   start: 2*60,    end: 7*60,    quality: "AVOID",   bias: "NEUTRAL", mult: 0.0 },
  ];

  let currentZone = null;
  for (const z of zones) {
    if (totalMin >= z.start && totalMin < z.end) {
      currentZone = z;
      break;
    }
  }

  if (!currentZone) currentZone = { name: "OFF_HOURS", start: 21*60, end: 24*60, quality: "AVOID", bias: "NEUTRAL", mult: 0.0 };

  const minutes_into_kz = totalMin - currentZone.start;
  const minutes_remaining = currentZone.end - totalMin;
  const optimal_entry = minutes_into_kz < 5 ? "WAIT_N_MINUTES" : minutes_into_kz <= 30 ? "NOW" : "NEXT_KZ";

  // Next zone
  const sortedZones = [
    { name: "ASIAN_KZ",    start: 0*60,     wib: "07:00" },
    { name: "LONDON_OPEN", start: 7*60,     wib: "14:00" },
    { name: "LONDON_CLOSE",start: 11*60,    wib: "18:00" },
    { name: "NY_OPEN",     start: 13*60+30, wib: "20:30" },
    { name: "NY_PM",       start: 17*60,    wib: "00:00" },
    { name: "NY_CLOSE",    start: 20*60,    wib: "03:00" },
  ];
  const nextZone = sortedZones.find(z => z.start > totalMin) ||
                   sortedZones.find(z => z.start > 0);

  return {
    current_kill_zone:   currentZone.name,
    kz_quality:          currentZone.quality,
    minutes_into_kz,
    minutes_remaining,
    optimal_entry_window: optimal_entry,
    wait_minutes:        optimal_entry === "WAIT_N_MINUTES" ? 5 - minutes_into_kz : null,
    kz_bias:             currentZone.bias,
    size_multiplier:     currentZone.mult,
    session_narrative:   `${currentZone.name} — ${currentZone.quality} — ${minutes_into_kz}min in`,
    next_kz_name:        nextZone?.name || "ASIAN_KZ",
    next_kz_utc:         nextZone ? `${String(Math.floor(nextZone.start/60)).padStart(2,"0")}:${String(nextZone.start%60).padStart(2,"0")}` : "00:00",
    next_kz_wib:         nextZone?.wib || "07:00",
    utc_time:            `${String(utcH).padStart(2,"0")}:${String(utcM).padStart(2,"0")} UTC`,
  };
}

// ── SMART COMPOUNDER ──────────────────────────────────────
async function smartCompounder({ equity, base_size = 15, tradeHistory = [] }) {
  const cached = getCached("compounder");
  if (cached) return cached;

  const last50 = tradeHistory.slice(-50);
  const wins = last50.filter(t => (t.pnlUSDT || 0) > 0);
  const losses = last50.filter(t => (t.pnlUSDT || 0) <= 0);
  const win_rate = last50.length ? (wins.length / last50.length * 100).toFixed(1) : 50;
  const avg_win  = wins.length ? wins.reduce((s, t) => s + (t.pnlUSDT || 0), 0) / wins.length : 0;
  const avg_loss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnlUSDT || 0), 0) / losses.length) : 0;
  const pf = avg_loss > 0 ? (avg_win * wins.length) / (avg_loss * losses.length) : 1;

  let consec_wins = 0, consec_losses = 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    if ((tradeHistory[i].pnlUSDT || 0) > 0) consec_wins++;
    else break;
  }
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    if ((tradeHistory[i].pnlUSDT || 0) < 0) consec_losses++;
    else break;
  }

  // Daily PnL
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayTrades = tradeHistory.filter(t => (t.exitTime || t.timestamp || 0) >= todayStart.getTime());
  const daily_pnl = todayTrades.reduce((s, t) => s + (t.pnlUSDT || 0), 0);
  const daily_pnl_pct = equity > 0 ? (daily_pnl / equity * 100).toFixed(2) : "0";

  const t0 = Date.now();
  const vars = {
    equity,
    base_size,
    max_leverage: 20,
    win_rate,
    avg_win:       avg_win.toFixed(2),
    avg_loss:      avg_loss.toFixed(2),
    profit_factor: pf.toFixed(2),
    consec_wins,
    consec_losses,
    current_dd:    0,
    daily_pnl_pct,
    daily_pnl_usdt: daily_pnl.toFixed(2),
    setup_type:    "MIXED",
    setup_winrate: win_rate,
    confluence_score: 70,
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.COMPOUNDER.user, vars);
  const result = await claudeCall(PROMPTS.COMPOUNDER.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("compounder", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), compounder: result };
    aiLog("COMPOUNDER", lat, `mode=${result.recommended_mode} size=$${result.recommended_size_usdt}`);
  }
  return result;
}

// ── MOMENTUM IGNITION CATCHER ─────────────────────────────
async function momentumIgnition({ klines_5m, klines_1m, price, current_candle, avg_volume }) {
  const cached = getCached("momentum");
  if (cached) return cached;

  const t0 = Date.now();
  const kl5 = klines_5m || klines_1m;
  const kl1 = klines_1m || klines_5m;
  const lastK = current_candle || kl1[kl1.length - 1] || { open: price, high: price, low: price, close: price, volume: 0 };
  const avgVol = avg_volume || (kl5.slice(-20).reduce((s, k) => s + k.volume, 0) / 20);
  const volRatio = avgVol > 0 ? lastK.volume / avgVol : 1;

  const swings = extractSwings(kl5, 10);
  const prev5 = kl5.slice(-6, -1);
  const compressionBody = prev5.length
    ? prev5.reduce((s, k) => s + Math.abs(k.close - k.open) / (k.high - k.low || 1), 0) / prev5.length * 100
    : 50;

  const vars = {
    price:          price.toFixed(2),
    c_open:  lastK.open?.toFixed(2),  c_high:  lastK.high?.toFixed(2),
    c_low:   lastK.low?.toFixed(2),   c_close: lastK.close?.toFixed(2),
    c_volume: lastK.volume?.toFixed(0),
    avg_volume: avgVol.toFixed(0),
    volume_ratio: volRatio.toFixed(2),
    klines_5m:  formatKlines(kl5, 20),
    klines_1m:  formatKlines(kl1, 15),
    resistance_levels: JSON.stringify(swings.highs),
    support_levels:    JSON.stringify(swings.lows),
    nearest_ob:  "N/A", nearest_fvg: "N/A",
    compression_avg_body: compressionBody.toFixed(1),
    htf_bias:    "UNKNOWN",
    clean_air_above: "2.0", clean_air_below: "2.0",
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.MOMENTUM.user, vars);
  const result = await claudeCall(PROMPTS.MOMENTUM.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("momentum", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), momentum: result };
    aiLog("MOMENTUM", lat, `detected=${result.ignition_detected} dir=${result.direction} conf=${result.confidence}`);
  }
  return result;
}

// ── OB FRESHNESS SCORER ───────────────────────────────────
async function obFreshnessScorer({ klines_1h, klines_15m, price }) {
  const cached = getCached("ob_scorer");
  if (cached) return cached;

  const t0 = Date.now();
  const kl = klines_1h || klines_15m;
  const closes = kl.map(k => k.close);
  const ema50v = calcEMA(closes, 50) || price;
  const premium = price * 1.015;
  const discount = price * 0.985;

  // Auto-detect OBs from klines
  const obs = [];
  for (let i = 5; i < kl.length - 2; i++) {
    const cur = kl[i], next1 = kl[i+1], next2 = kl[i+2];
    const impulse = Math.abs(next1.close - kl[i].close) / kl[i].close * 100;
    if (impulse >= 0.5) {
      const type = next1.close > kl[i].close ? "BULL" : "BEAR";
      obs.push({ id: `OB_${i}`, type, high: cur.high, low: cur.low,
        created_at_candle_index: kl.length - i, times_tested: 0,
        impulse_size_pct: impulse.toFixed(2), volume_at_creation: cur.volume });
    }
  }
  const recent_obs = obs.slice(-6);

  const vars = {
    price:           price.toFixed(2),
    premium_level:   premium.toFixed(2),
    discount_level:  discount.toFixed(2),
    order_blocks_list: JSON.stringify(recent_obs),
    klines_1h:  formatKlines(kl, 50),
    klines_15m: formatKlines(klines_15m || kl, 30),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.OB_SCORER.user, vars);
  const result = await claudeCall(PROMPTS.OB_SCORER.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("ob_scorer", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), ob_scorer: result };
    aiLog("OB_SCORER", lat, `scored=${result.scored_obs?.length} bestBull=${result.best_bullish_ob}`);
  }
  return result;
}

// ── MACRO CORRELATION ENGINE ──────────────────────────────
async function macroCorrelation({ btc_price, btc_change_24h }) {
  const cached = getCached("macro");
  if (cached) return cached;

  const t0 = Date.now();
  const vars = {
    btc_price:       btc_price?.toFixed(2) || "N/A",
    btc_change_24h:  btc_change_24h?.toFixed(2) || "0",
    dxy_value:       "N/A", dxy_change: "N/A", dxy_weekly_trend: "N/A",
    btc_dom:         "N/A", btcd_change: "N/A",
    ethbtc_ratio:    "N/A", ethbtc_change: "N/A",
    fear_greed:      "N/A", fear_greed_label: "N/A",
    oi_value:        "N/A", oi_change_24h: "N/A",
    long_pct:        "N/A", short_pct: "N/A",
    spy_change:      "N/A", gold_change: "N/A", vix: "N/A",
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.MACRO.user, vars);
  const result = await claudeCall(PROMPTS.MACRO.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("macro", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), macro: result };
    aiLog("MACRO", lat, `bias=${result.macro_bias} score=${result.macro_bias_score}`);
  }
  return result;
}

// ── EXIT OPTIMIZER ────────────────────────────────────────
async function exitOptimizer({ side, entry, current_price, pnl_pct, peak_pnl_pct,
  current_sl, tp1, tp2, klines_15m, klines_5m, duration_minutes, setup_type }) {
  const exitCacheKey = `exit_${entry}`;
  const cached = getCached(exitCacheKey);
  if (cached) return cached;

  const t0 = Date.now();
  const pnl_usdt = 15 * 7 * (pnl_pct / 100);
  const kl15 = klines_15m || klines_5m;
  const kl5  = klines_5m  || klines_15m;
  const swings = extractSwings(kl15, 10);
  const nextRes = side === "LONG"
    ? swings.highs.find(h => h > current_price) || current_price * 1.01
    : swings.lows.find(l => l < current_price) || current_price * 0.99;
  const resDist = Math.abs((nextRes - current_price) / current_price * 100);

  const vars = {
    side, entry:   entry?.toFixed(2), current_price: current_price?.toFixed(2),
    pnl_pct:    pnl_pct?.toFixed(2),  pnl_usdt:  pnl_usdt?.toFixed(2),
    peak_pnl_pct: peak_pnl_pct?.toFixed(2),
    current_sl: current_sl?.toFixed(2), tp1: tp1?.toFixed(2), tp2: tp2?.toFixed(2),
    tp1_status: "PENDING", tp2_status: "PENDING",
    duration_minutes: duration_minutes || 0,
    setup_type: setup_type || "TREND",
    klines_15m: formatKlines(kl15, 15),
    klines_5m:  formatKlines(kl5, 15),
    volume_trend: "NEUTRAL", momentum_direction: "NEUTRAL", momentum_strength: "MEDIUM",
    next_resistance: nextRes.toFixed(2),
    resistance_distance_pct: resDist.toFixed(2),
    htf_levels_ahead: JSON.stringify([]),
    current_session: getSession(),
    minutes_to_session_close: 60,
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.EXIT_OPTIMIZER.user, vars);
  const result = await claudeCall(PROMPTS.EXIT_OPTIMIZER.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache(exitCacheKey, result);
    CACHE["exit"] = CACHE[exitCacheKey]; // kompatibilitas key umum
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), exit: result };
    aiLog("EXIT", lat, `mode=${result.exit_mode} urgency=${result.urgency}`);
  }
  return result;
}

// ── MASTER ORCHESTRATOR ───────────────────────────────────
async function masterOrchestrator({ all_results, active_position, price, equity }) {
  const cached = getCached("orchestrator");
  if (cached) return cached;

  const t0 = Date.now();
  const vars = {
    f1_result:     JSON.stringify(all_results.f1 || {}),
    f2_result:     JSON.stringify(all_results.f2 || {}),
    sniper_result: JSON.stringify(all_results.sniper || {}),
    judas_result:  JSON.stringify(all_results.judas || {}),
    regime_result: JSON.stringify(all_results.regime || {}),
    kz_result:     JSON.stringify(all_results.kz || {}),
    sweep_result:  JSON.stringify(all_results.sweep || {}),
    momentum_result:  JSON.stringify(all_results.momentum || {}),
    macro_result:     JSON.stringify(all_results.macro || {}),
    ob_scores_result: JSON.stringify(all_results.ob_scorer || {}),
    compounder_result:JSON.stringify(all_results.compounder || {}),
    active_position:  JSON.stringify(active_position || null),
    price:  price.toFixed(2),
    equity: equity.toFixed(2),
  };
  const userPrompt = PROMPTS.fillTemplate(PROMPTS.ORCHESTRATOR.user, vars);
  const result = await claudeCall(PROMPTS.ORCHESTRATOR.system, userPrompt);
  const lat = Date.now() - t0;

  if (result) {
    setCache("orchestrator", result);
    if (global.botState) global.botState.features = { ...(global.botState.features || {}), orchestrator: result };
    aiLog("ORCHESTRATOR", lat, `decision=${result.final_decision} conf=${result.decision_confidence}%`);
  }
  return result;
}

// ── RUN ALL ───────────────────────────────────────────────
async function runAll({ klines_1m, klines_15m, klines_1h, klines_4h,
  price, activePosition, tradeHistory = [], equity = 1000 }) {

  const kz = killZoneTimer();

  // Always run KZ (sync), conditionally run others based on cache/cooldown
  const [f1, regime] = await Promise.all([
    callF1({ klines_4h: klines_4h || klines_1h, klines_1h: klines_1h || klines_15m, price }),
    volatilityRegime({ klines_1h: klines_1h || klines_15m, price }),
  ]);

  const [judas, momentum] = await Promise.all([
    judasSweepDetector({ klines_15m, klines_1m, price }),
    momentumIgnition({ klines_5m: klines_1m, klines_1m, price }),
  ]);

  let f2 = null, sniper = null, sweep = null, compounder = null;

  if (f1?.confidence >= 55 && !activePosition) {
    [f2, sniper, sweep, compounder] = await Promise.all([
      callF2({ klines_4h: klines_4h || klines_1h, klines_1h, klines_15m, klines_5m: klines_1m, price, htfBias: f1 }),
      sniperMode({ klines_15m, klines_5m: klines_1m, price, htf_bias: f1?.htf_bias, htf_score: f1?.confidence }),
      liquiditySweepEngine({ klines_15m, klines_5m: klines_1m, price, htf_bias: f1?.htf_bias }),
      smartCompounder({ equity, base_size: 15, tradeHistory }),
    ]);
  }

  let exitResult = null;
  if (activePosition) {
    exitResult = await exitOptimizer({
      side:          activePosition.side,
      entry:         activePosition.entry,
      current_price: price,
      pnl_pct:       activePosition.pnlPct || 0,
      peak_pnl_pct:  activePosition.peak   || 0,
      current_sl:    activePosition.sl     || 0,
      tp1:           activePosition.tp1    || 0,
      tp2:           activePosition.tp2    || 0,
      klines_15m,
      klines_5m: klines_1m,
      duration_minutes: activePosition.openedAt ? Math.round((Date.now() - activePosition.openedAt) / 60000) : 0,
      setup_type: activePosition.setup || "TREND",
    });
  }

  return { f1, f2, sniper, judas, sweep, regime, kz, compounder, momentum, exit: exitResult };
}

// ── F10 POST-TRADE REVIEW ─────────────────────────────────
async function reviewTrade(trade) {
  if (!trade) return null;
  const t0 = Date.now();
  const TZ = "Asia/Jakarta";
  const fmtWIB = ts => ts ? new Date(ts).toLocaleTimeString("id-ID", { timeZone: TZ, hour12: false }) : "—";
  const pnlUSDT = Math.abs(trade.pnlUSDT || 0);
  const sign = (trade.pnlUSDT || 0) >= 0 ? "+" : "-";

  const vars = {
    trade_side:              trade.side || "UNKNOWN",
    trade_setup:             trade.setup || "UNKNOWN",
    leverage:                trade.leverage || 7,
    entry_price:             (trade.entry || 0).toFixed(2),
    entry_time_wib:          fmtWIB(trade.timestamp),
    exit_price:              (trade.exit || 0).toFixed(2),
    exit_time_wib:           fmtWIB(trade.exitTime),
    duration_minutes:        trade.duration || 0,
    pnl_pct:                 (trade.pnl || 0).toFixed(2),
    pnl_usdt_sign:           sign,
    pnl_usdt:                pnlUSDT.toFixed(2),
    exit_reason:             trade.reason || "UNKNOWN",
    session:                 (() => { const h = new Date(trade.exitTime || Date.now()).getUTCHours(); return h < 8 ? "Asia" : h < 14 ? "London" : "New York"; })(),
    htf_bias_at_entry:       "UNKNOWN",
    consec_losses_before:    0,
    time_since_last_trade_mins: trade.duration || 0,
    trades_today:            1,
  };

  const userPrompt = PROMPTS.fillTemplate(PROMPTS.F10.user, vars);
  const result = await claudeCall(PROMPTS.F10.system, userPrompt);
  const lat = Date.now() - t0;
  if (result) aiLog("F10_REVIEW", lat, `grade=${result.quality_score} flag=${result.behavioral_flag}`);
  return result;
}

/**
 * UPGRADE B — Liquidity Trap Detector.
 * Detects BSL/SSL sweeps from the last 20 candles (no AI call, pure math).
 * Returns { detected, type, bias, swept_level, reason } or null.
 */
function detectLiquidityTrap({ klines }) {
  try {
    if (!Array.isArray(klines) || klines.length < 5) return null;
    const candles = klines.slice(-20);
    const last    = candles[candles.length - 1];
    if (!last) return null;

    // Build range from all-but-last candle
    const prior   = candles.slice(0, -1);
    const maxHigh = Math.max(...prior.map(k => k.high));
    const minLow  = Math.min(...prior.map(k => k.low));

    const bslSweep = last.high > maxHigh * 0.999 && last.close < maxHigh;
    const sslSweep = last.low  < minLow  * 1.001 && last.close > minLow;

    if (bslSweep) {
      return {
        detected:     true,
        type:         "BSL_SWEEP",
        bias:         "SHORT",
        swept_level:  maxHigh,
        reason:       `Candle swept BSL at ${maxHigh.toFixed(2)} but closed below`,
      };
    }
    if (sslSweep) {
      return {
        detected:     true,
        type:         "SSL_SWEEP",
        bias:         "LONG",
        swept_level:  minLow,
        reason:       `Candle swept SSL at ${minLow.toFixed(2)} but closed above`,
      };
    }
    return null;
  } catch { return null; }
}

module.exports = {
  callF1, callF2, sniperMode, judasSweepDetector, liquiditySweepEngine,
  volatilityRegime, killZoneTimer, smartCompounder, momentumIgnition,
  obFreshnessScorer, macroCorrelation, exitOptimizer, masterOrchestrator,
  reviewTrade, runAll, detectLiquidityTrap,
  // helpers exported for testing
  calcATR, calcEMA, extractSwings, formatKlines,
};
