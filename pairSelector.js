/**
 * Pair Selector Module - ADAPTIVE AUTO PAIR TRADING SYSTEM
 * Automatically selects between BTCUSDT and PEPEUSDT based on market conditions
 * 
 * Selection Criteria:
 * 1. ATR-based volatility comparison
 * 2. RSI-based opportunity detection
 * 3. Trend alignment (EMA)
 * 4. Volume analysis
 * 5. HYPE DETECTOR - Real hype detection for PEPE
 */

"use strict";

const https = require("https");
const httpsAgent = new https.Agent({ rejectUnauthorized: true });

// Import Hype Detector
const { 
  MARKET_STATE, 
  analyzeHype, 
  calculateHypeMetrics, 
  getHypeState, 
  setHypeState, 
  isHypeLocked,
  resetHypeState
} = require('./hypeDetector');

const SYMBOLS = {
  BTC: "BTCUSDT",
  PEPE: "PEPEUSDT"
};

// Timeframes for analysis
const TIMEFRAMES = {
  m15: "15m",
  h1: "1h"
};

/**
 * Fetch klines/candlestick data from Bitget
 */
async function fetchKlines(symbol, interval, limit = 100) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.bitget.com",
      path: `/api/v2/mix/market/history-candles?symbol=${symbol}&productType=usdt-futures&granularity=${interval}&limit=${limit}`,
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      },
      agent: httpsAgent
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.code === "00000" && json.data) {
            // Transform to standard format: [time, open, high, low, close, volume]
            const klines = json.data.map(k => ({
              time: parseInt(k[0]),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5])
            }));
            resolve(klines);
          } else {
            reject(new Error(json.msg || "Unknown error"));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

/**
 * Calculate ATR (Average True Range)
 */
function calculateATR(klines, period = 14) {
  const atrValues = [];
  
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    
    atrValues.push(tr);
  }
  
  // Calculate SMA of TR
  let sum = 0;
  for (let i = 0; i < period && i < atrValues.length; i++) {
    sum += atrValues[atrValues.length - period + i];
  }
  
  return sum / period;
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calculateEMA(values, period) {
  if (values.length < period) return null;
  
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(klines, period = 14) {
  const closes = klines.map(k => k.close);
  if (closes.length < period + 1) return null;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate volume ratio (current vs average)
 */
function calculateVolumeRatio(klines, period = 20) {
  const recentVolume = klines.slice(-5).map(k => k.volume);
  const avgVolume = klines.slice(-period).map(k => k.volume).reduce((a, b) => a + b, 0) / period;
  
  return recentVolume.reduce((a, b) => a + b, 0) / 5 / avgVolume;
}

/**
 * Analyze a symbol and return opportunity score
 */
async function analyzeSymbol(symbol) {
  try {
    // Fetch 15m and 1h data
    const [klines15m, klines1h] = await Promise.all([
      fetchKlines(symbol, TIMEFRAMES.m15, 100),
      fetchKlines(symbol, TIMEFRAMES.h1, 50)
    ]);
    
    const closes15m = klines15m.map(k => k.close);
    const closes1h = klines1h.map(k => k.close);
    
    // Current price
    const currentPrice = closes15m[closes15m.length - 1];
    
    // Calculate indicators
    const atr15m = calculateATR(klines15m, 14);
    const atr1h = calculateATR(klines1h, 14);
    const rsi15m = calculateRSI(klines15m, 14);
    const rsi1h = calculateRSI(klines1h, 14);
    const ema20_15m = calculateEMA(closes15m, 20);
    const ema50_15m = calculateEMA(closes15m, 50);
    const ema20_1h = calculateEMA(closes1h, 20);
    const ema50_1h = calculateEMA(closes1h, 50);
    const volumeRatio15m = calculateVolumeRatio(klines15m);
    
    // ATR as percentage of price
    const atr15mPct = (atr15m / currentPrice) * 100;
    const atr1hPct = (atr1h / currentPrice) * 100;
    
    // Trend detection
    const trend15m = ema20_15m > ema50_15m ? "BULLISH" : (ema20_15m < ema50_15m ? "BEARISH" : "NEUTRAL");
    const trend1h = ema20_1h > ema50_1h ? "BULLISH" : (ema20_1h < ema50_1h ? "BEARISH" : "NEUTRAL");
    
    // Opportunity scoring
    let score = 50; // base score
    let signals = [];
    
    // RSI opportunity (extreme = opportunity)
    if (rsi15m < 30) {
      score += 15;
      signals.push(`RSI15m oversold (${rsi15m.toFixed(1)})`);
    } else if (rsi15m > 70) {
      score += 15;
      signals.push(`RSI15m overbought (${rsi15m.toFixed(1)})`);
    } else if (rsi15m < 40 || rsi15m > 60) {
      score += 5;
      signals.push(`RSI15m favorable (${rsi15m.toFixed(1)})`);
    }
    
    if (rsi1h < 30) {
      score += 10;
      signals.push(`RSI1h oversold (${rsi1h.toFixed(1)})`);
    } else if (rsi1h > 70) {
      score += 10;
      signals.push(`RSI1h overbought (${rsi1h.toFixed(1)})`);
    }
    
    // Trend alignment
    if (trend15m === trend1h && trend15m !== "NEUTRAL") {
      score += 15;
      signals.push(`Aligned trend: ${trend15m}`);
    }
    
    // Volume
    if (volumeRatio15m > 1.5) {
      score += 10;
      signals.push(`High volume: ${volumeRatio15m.toFixed(1)}x`);
    }
    
    // ATR opportunity (higher ATR = more movement potential)
    const avgAtrPct = (atr15mPct + atr1hPct) / 2;
    if (avgAtrPct > 1.0) {
      score += 10;
      signals.push(`High volatility: ${avgAtrPct.toFixed(2)}%`);
    } else if (avgAtrPct > 0.5) {
      score += 5;
    }
    
    return {
      symbol,
      score,
      signals,
      price: currentPrice,
      rsi: { m15: rsi15m, h1: rsi1h },
      trend: { m15: trend15m, h1: trend1h },
      volatility: { m15: atr15mPct, h1: atr1hPct },
      volumeRatio: volumeRatio15m,
      timestamp: Date.now()
    };
  } catch (error) {
    return {
      symbol,
      score: 0,
      signals: [`Error: ${error.message}`],
      error: true,
      timestamp: Date.now()
    };
  }
}

/**
 * Select the best pair to trade
 * Uses HYPE DETECTOR for PEPE - requires 4/7 conditions for HYPE state
 * Returns: { selected: 'BTCUSDT' | 'PEPEUSDT', analysis: {...}, reason: string, hypeState: {...} }
 */
async function selectPair() {
  console.log("[PairSelector] Analyzing market conditions...");
  
  const [btcAnalysis, pepeAnalysis] = await Promise.all([
    analyzeSymbol(SYMBOLS.BTC),
    analyzeSymbol(SYMBOLS.PEPE)
  ]);
  
  const results = { BTC: btcAnalysis, PEPE: pepeAnalysis };
  
  // Check for lock (prevent rapid switching) - but always analyze to detect HYPE
  const wasLocked = isHypeLocked();
  let cachedPair = null;
  if (wasLocked) {
    const current = getCurrentPair();
    if (current && current.selected) {
      cachedPair = current.selected;
      console.log(`[PairSelector] Pair locked, will check if PEPE HYPE overrides...`);
    }
  }
  
  // Calculate HYPE metrics for PEPE
  let hypeAnalysis = null;
  try {
    const hypeMetrics = await calculateHypeMetrics(
      pepeAnalysis.klines,
      { 
        rsi: pepeAnalysis.rsi, 
        ema9: pepeAnalysis.ema9, 
        ema21: pepeAnalysis.ema21,
        bb: pepeAnalysis.bb
      },
      btcAnalysis.klines
    );
    
    if (hypeMetrics) {
      hypeAnalysis = await analyzeHype(hypeMetrics.pepe, hypeMetrics.btc);
      console.log(`[PAIR SELECTOR] PEPE Score: ${hypeAnalysis.hypeScore}/100`);
      console.log(`[PAIR SELECTOR] State: ${hypeAnalysis.state}`);
      console.log(`[PAIR SELECTOR] Conditions: ${hypeAnalysis.conditionsPassed}/7`);
      console.log(`[PAIR SELECTOR] Reason: ${hypeAnalysis.reasons}`);
    }
  } catch (err) {
    console.log(`[PairSelector] Hype analysis error: ${err.message}`);
  }
  
  // Determine best pair using HYPE state
  let selected;
  let reason;
  let marketState = 'NORMAL';
  
  // Use hype analysis if available
  if (hypeAnalysis) {
    marketState = hypeAnalysis.state;
    
    if (hypeAnalysis.state === MARKET_STATE.HYPE) {
      // HYPE CONFIRMED - Allow PEPE trading
      selected = SYMBOLS.PEPE;
      reason = `PEPE HYPE CONFIRMED: ${hypeAnalysis.hypeScore}/100 (${hypeAnalysis.conditionsPassed}/7 conditions)`;
      // Lock PEPE for 30 minutes
      setHypeState(MARKET_STATE.HYPE, 30);
    } else if (hypeAnalysis.state === MARKET_STATE.WATCHLIST) {
      // WATCHLIST - Monitor but don't trade PEPE
      selected = SYMBOLS.BTC;
      reason = `PEPE WATCHLIST: ${hypeAnalysis.hypeScore}/100 (${hypeAnalysis.conditionsPassed}/7) - monitoring`;
      setHypeState(MARKET_STATE.WATCHLIST, 15);
    } else {
      // NORMAL - Use score-based selection
      selected = SYMBOLS.BTC;
      reason = `PEPE NORMAL: ${hypeAnalysis.hypeScore}/100 - using BTC`;
    }
  } else {
    // Fallback to original score-based logic
    const scoreDiff = btcAnalysis.score - pepeAnalysis.score;
    if (scoreDiff > 15) {
      selected = SYMBOLS.BTC;
      reason = `BTC score significantly higher: ${btcAnalysis.score} vs ${pepeAnalysis.score}`;
    } else if (scoreDiff < -15) {
      selected = SYMBOLS.PEPE;
      reason = `PEPE score significantly higher: ${pepeAnalysis.score} vs ${btcAnalysis.score}`;
    } else if (scoreDiff > 5) {
      selected = SYMBOLS.BTC;
      reason = `BTC slightly better: ${btcAnalysis.score} vs ${pepeAnalysis.score}`;
    } else if (scoreDiff < -5) {
      selected = SYMBOLS.PEPE;
      reason = `PEPE slightly better: ${pepeAnalysis.score} vs ${btcAnalysis.score}`;
    } else {
      selected = SYMBOLS.BTC;
      reason = `Equal scores (${btcAnalysis.score}), defaulting to BTC for stability`;
    }
  }
  
  // Override lock if PEPE is in HYPE state - always allow PEPE when hype is confirmed
  if (wasLocked && selected === SYMBOLS.BTC && hypeAnalysis && hypeAnalysis.state === MARKET_STATE.HYPE) {
    console.log(`[PairSelector] ⚡ PEPE HYPE DETECTED - Overriding lock to switch to PEPE!`);
    selected = SYMBOLS.PEPE;
    reason = `PEPE HYPE OVERRIDE: ${hypeAnalysis.hypeScore}/100 - switching from ${cachedPair}`;
    marketState = MARKET_STATE.HYPE;
    setHypeState(MARKET_STATE.HYPE, 30);
  }
   
  // Check if we should enable DUAL TRADING MODE (both BTC and PEPE)
  const isDualMode = hypeAnalysis && hypeAnalysis.state === MARKET_STATE.HYPE;
  let bothPairs = null;
  if (isDualMode) {
    bothPairs = [SYMBOLS.BTC, SYMBOLS.PEPE];
    reason = `DUAL MODE: BTC + PEPE (PEPE HYPE: ${hypeAnalysis.hypeScore}/100)`;
    console.log(`[PairSelector] ⚡⚡ DUAL TRADING MODE ENABLED - Trading both BTC and PEPE!`);
  }
   
  console.log(`[PairSelector] Selected: ${selected}`);
  console.log(`[PairSelector] Market State: ${marketState}`);
  console.log(`[PairSelector] Reason: ${reason}`);
  console.log(`[PairSelector] BTC Score: ${btcAnalysis.score} | PEPE Score: ${pepeAnalysis.score}`);
  
  return {
    selected,
    bothPairs,        // Array of pairs for dual mode: [BTCUSDT, PEPEUSDT] or null
    isDualMode,       // true if trading both pairs
    reason,
    marketState,
    hypeAnalysis,
    analysis: results,
    selectedAnalysis: results[selected === SYMBOLS.BTC ? "BTC" : "PEPE"]
  };
}

/**
 * Get current pair selection (cached, refreshes periodically)
 */
let cachedSelection = null;
let lastSelectionTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCurrentPair(forceRefresh = false) {
  const now = Date.now();
  
  if (!forceRefresh && cachedSelection && (now - lastSelectionTime) < CACHE_DURATION) {
    // Add current hype state
    return {
      ...cachedSelection,
      hypeState: getHypeState()
    };
  }
  
  cachedSelection = await selectPair();
  lastSelectionTime = now;
  
  return {
    ...cachedSelection,
    hypeState: getHypeState()
  };
}

/**
 * Manual pair selection override
 */
let manualOverride = null;

function setManualPair(symbol) {
  if (symbol === SYMBOLS.BTC || symbol === SYMBOLS.PEPE) {
    manualOverride = symbol;
    console.log(`[PairSelector] Manual override: ${symbol}`);
    return true;
  }
  return false;
}

function clearManualOverride() {
  manualOverride = null;
  console.log("[PairSelector] Manual override cleared");
}

function getManualOverride() {
  return manualOverride;
}

module.exports = {
  SYMBOLS,
  selectPair,
  getCurrentPair,
  analyzeSymbol,
  setManualPair,
  clearManualOverride,
  getManualOverride,
  // Hype Detector exports
  MARKET_STATE,
  getHypeState,
  analyzeHype,
  calculateHypeMetrics,
  // For testing
  calculateATR,
  calculateEMA,
  calculateRSI,
  calculateVolumeRatio
};
