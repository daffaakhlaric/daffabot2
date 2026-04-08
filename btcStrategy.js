/**
 * BTC Strategy Module - TREND-FOLLOWING SNIPER SYSTEM
 * Trading strategy specifically for BTCUSDT 15m timeframe
 * Indicators: EMA20/EMA50, RSI, ATR
 * 
 * RULES:
 * 1. NO mean-reversion (RSI < 30 → LONG or RSI > 70 → SHORT is DELETED)
 * 2. ONLY trend pullback entries
 * 3. Strict entry filter (score ≥ 75, gap ≥ 25)
 * 4. Market session filter (Asia = strict mode)
 * 5. Trade frequency control
 * 6. Adaptive profit system
 * 7. Trend strength detection
 * 8. Block bad market conditions
 */

"use strict";

const https = require("https");
const httpsAgent = new https.Agent({ rejectUnauthorized: true });

const SYMBOL = "BTCUSDT";
const TIMEFRAME = "15m";
const KLINE_LIMIT = 200; // More data for better EMA accuracy

// ═══════════════════════════════════════════════════════════════
// STRICT SNIPER CONFIG - Trend-Following System
// ═══════════════════════════════════════════════════════════════

// 1. ENTRY FILTER
const MIN_ENTRY_SCORE = 75;        // Minimum score required
const SCORE_GAP = 25;              // Score gap must be >= 25

// 2. MARKET CONDITIONS
const MIN_VOLUME_RATIO = 1.2;       // Volume >= 1.2x
const MIN_ATR_PERCENT = 0.15;       // ATR >= 0.15%
const MIN_ATR_BLOCK = 0.12;         // Block if ATR < 0.12%
const MIN_VOLUME_BLOCK = 1.0;       // Block if volume < 1.0x

// 3. MARKET SESSION
const ASIA_SCORE_MIN = 85;         // Asia strict mode: score >= 85
const ASIA_VOLUME_MIN = 1.5;       // Asia strict mode: volume >= 1.5x

// 4. TRADE FREQUENCY
const MAX_TRADES_PER_DAY = 3;
const MAX_TRADES_PER_HOUR = 1;
const WIN_LOCK_DURATION = 10;      // Minutes to wait after win >= 0.5%

// 5. ADAPTIVE PROFIT TARGETS
const PROFIT_STRONG = { min: 1.0, max: 2.5 };   // Trend STRONG
const PROFIT_NORMAL = { min: 0.5, max: 1.0 };  // Trend NORMAL
const PROFIT_WEAK = { min: 0.25, max: 0.5 };   // Trend WEAK

// 6. TREND STRENGTH
const EMA_GAP_STRONG = 0.2;        // EMA gap > 0.2% = STRONG
const EMA_GAP_NORMAL = 0.1;        // EMA gap 0.1-0.2% = NORMAL
const VOLUME_STRONG = 1.3;         // Volume > 1.3x = STRONG

// 7. FEE PROTECTION
const MIN_PROFIT_EXIT = 0.25;      // Never close below 0.25%

/**
 * Fetch klines from Bitget
 */
async function fetchKlines(symbol, interval, limit = KLINE_LIMIT) {
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
 * Calculate EMA array for all points
 */
function calculateEMAArray(values, period) {
  if (values.length < period) return [];
  
  const multiplier = 2 / (period + 1);
  const emaArray = new Array(values.length).fill(null);
  
  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  emaArray[period - 1] = sum / period;
  
  // Calculate rest
  for (let i = period; i < values.length; i++) {
    emaArray[i] = (values[i] - emaArray[i - 1]) * multiplier + emaArray[i - 1];
  }
  
  return emaArray;
}

/**
 * Calculate RSI
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
 * Calculate ATR (Average True Range)
 */
function calculateATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  
  const trValues = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }
  
  // Calculate ATR using Wilder's smoothing
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trValues[trValues.length - period + i];
  }
  
  let atr = sum / period;
  
  // Continue with Wilder's method
  for (let i = trValues.length - period - 1; i >= 0; i--) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }
  
  return atr;
}

/**
 * Calculate ATR percentage
 */
function calculateATRPct(klines, period = 14) {
  const atr = calculateATR(klines, period);
  const currentPrice = klines[klines.length - 1].close;
  return atr ? (atr / currentPrice) * 100 : null;
}

/**
 * Analyze BTC market and generate trading signals
 * TREND-FOLLOWING SNIPER SYSTEM
 */
async function analyzeBTC() {
  try {
    const klines = await fetchKlines(SYMBOL, TIMEFRAME, KLINE_LIMIT);
    
    if (!klines || klines.length < 50) {
      throw new Error("Insufficient data");
    }
    
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);
    
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    
    // Calculate EMAs
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema20Array = calculateEMAArray(closes, 20);
    const ema50Array = calculateEMAArray(closes, 50);
    
    // Calculate RSI
    const rsi = calculateRSI(klines, 14);
    
    // Calculate ATR
    const atr = calculateATR(klines, 14);
    const atrPct = (atr / currentPrice) * 100;
    
    // Calculate volume
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = currentVolume / avgVolume;
    
    // ═══════════════════════════════════════════════════════════════
    // RULE 8: BLOCK BAD MARKET CONDITIONS
    // ═══════════════════════════════════════════════════════
    
    // ATR check
    if (atrPct < MIN_ATR_BLOCK) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend: ema20 > ema50 ? "BULLISH" : (ema20 < ema50 ? "BEARISH" : "NEUTRAL"),
        trend_strength: "WEAK",
        reason: `ATR ${atrPct.toFixed(2)}% < ${MIN_ATR_BLOCK}% (too weak)`,
        indicators: { rsi, atrPct, volumeRatio },
        signal: "BLOCKED"
      };
    }
    
    // Volume check
    if (volumeRatio < MIN_VOLUME_BLOCK) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend: ema20 > ema50 ? "BULLISH" : (ema20 < ema50 ? "BEARISH" : "NEUTRAL"),
        trend_strength: "WEAK",
        reason: `Volume ${volumeRatio.toFixed(2)}x < ${MIN_VOLUME_BLOCK}x (too low)`,
        indicators: { rsi, atrPct, volumeRatio },
        signal: "BLOCKED"
      };
    }
    
    // Sideways check (EMA20 ≈ EMA50)
    const emaGap = ema50 > 0 ? Math.abs((ema20 - ema50) / ema50 * 100) : 0;
    if (emaGap < 0.05) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend: "NEUTRAL",
        trend_strength: "WEAK",
        reason: `EMA gap ${emaGap.toFixed(3)}% < 0.05% (sideways)`,
        indicators: { rsi, atrPct, volumeRatio },
        signal: "BLOCKED"
      };
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RULE 7: TREND STRENGTH DETECTION
    // ═══════════════════════════════════════════════════════════════
    
    let trendStrength = "NORMAL";
    if (emaGap > EMA_GAP_STRONG && volumeRatio > VOLUME_STRONG) {
      trendStrength = "STRONG";
    } else if (emaGap < EMA_GAP_NORMAL) {
      trendStrength = "WEAK";
    }
    
    // Determine trend
    const trend = ema20 > ema50 ? "BULLISH" : (ema20 < ema50 ? "BEARISH" : "NEUTRAL");
    
    // EMA crossover detection
    let emaSignal = "NEUTRAL";
    if (ema20Array.length >= 2) {
      const prevEma20 = ema20Array[ema20Array.length - 2];
      const prevEma50 = ema50Array[ema50Array.length - 2];
      
      if (ema20 > ema50 && prevEma20 <= prevEma50) {
        emaSignal = "GOLDEN_CROSS";
      } else if (ema20 < ema50 && prevEma20 >= prevEma50) {
        emaSignal = "DEATH_CROSS";
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RULE 1: REMOVE MEAN-REVERSION - REPLACE WITH TREND PULLBACK
    // NO RSI < 30 → LONG, NO RSI > 70 → SHORT
    // ═══════════════════════════════════════════════════════════════
    
    // Calculate signals based on TREND PULLBACK only
    let bullishScore = 0;
    let bearishScore = 0;
    const sigReasons = [];
    
    // TREND-FOLLOWING: Must align with EMA trend
    if (trend === "BULLISH") {
      bullishScore += 30; // Strong bias for trend-following
      sigReasons.push(`HTF BULLISH: EMA20>EMA50 (${emaGap.toFixed(2)}%)`);
    } else if (trend === "BEARISH") {
      bearishScore += 30; // Strong bias for trend-following
      sigReasons.push(`HTF BEARISH: EMA20<EMA50 (${emaGap.toFixed(2)}%)`);
    }
    
    // RSI PULLBACK ZONE (not mean-reversion!)
    // LONG: RSI 45-60 (pullback in bullish trend)
    // SHORT: RSI 40-55 (pullback in bearish trend)
    const rsiInLongPullback = rsi >= 45 && rsi <= 60;
    const rsiInShortPullback = rsi >= 40 && rsi <= 55;
    
    if (trend === "BULLISH" && rsiInLongPullback) {
      bullishScore += 25;
      sigReasons.push(`RSI pullback: ${rsi.toFixed(1)} in [45-60]`);
    } else if (trend === "BEARISH" && rsiInShortPullback) {
      bearishScore += 25;
      sigReasons.push(`RSI pullback: ${rsi.toFixed(1)} in [40-55]`);
    } else if (trend === "BULLISH" && rsi > 60) {
      sigReasons.push(`RSI ${rsi.toFixed(1)} too high for LONG`);
    } else if (trend === "BEARISH" && rsi < 40) {
      sigReasons.push(`RSI ${rsi.toFixed(1)} too low for SHORT`);
    }
    
    // Price MUST be above/below EMAs (trend confirmation)
    const priceAboveEma20 = currentPrice > ema20;
    const priceAboveEma50 = currentPrice > ema50;
    const priceBelowEma20 = currentPrice < ema20;
    const priceBelowEma50 = currentPrice < ema50;
    
    if (trend === "BULLISH" && priceAboveEma20 && priceAboveEma50) {
      bullishScore += 15;
      sigReasons.push("Price above EMA20 & EMA50");
    } else if (trend === "BEARISH" && priceBelowEma20 && priceBelowEma50) {
      bearishScore += 15;
      sigReasons.push("Price below EMA20 & EMA50");
    }
    
    // Volume confirmation
    if (volumeRatio >= MIN_VOLUME_RATIO) {
      if (trend === "BULLISH") {
        bullishScore += 10;
      } else if (trend === "BEARISH") {
        bearishScore += 10;
      }
      sigReasons.push(`Volume ${volumeRatio.toFixed(2)}x OK`);
    } else {
      sigReasons.push(`Volume ${volumeRatio.toFixed(2)}x too low`);
    }
    
    // ATR confirmation
    if (atrPct >= MIN_ATR_PERCENT) {
      if (trend === "BULLISH") {
        bullishScore += 10;
      } else if (trend === "BEARISH") {
        bearishScore += 10;
      }
      sigReasons.push(`ATR ${atrPct.toFixed(2)}% OK`);
    }
    
    // EMA Crossover bonus (early entry)
    if (emaSignal === "GOLDEN_CROSS" && trend === "BULLISH") {
      bullishScore += 15;
      sigReasons.push("Golden Cross detected");
    } else if (emaSignal === "DEATH_CROSS" && trend === "BEARISH") {
      bearishScore += 15;
      sigReasons.push("Death Cross detected");
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RULE 2: STRICT ENTRY FILTER (SNIPER MODE)
    // ═══════════════════════════════════════════════════════
    
    const scoreGap = bullishScore - bearishScore;
    const totalScore = Math.max(bullishScore, bearishScore);
    const confidence = totalScore > 0 ? Math.round(scoreGap / totalScore * 100) : 0;
    
    // Determine action based on score and gap
    let action = "HOLD";
    let actionReason = "";
    
    if (bullishScore >= MIN_ENTRY_SCORE && scoreGap >= SCORE_GAP && rsiInLongPullback) {
      action = "LONG";
      actionReason = `LONG: score=${bullishScore} gap=${scoreGap} RSI=${rsi.toFixed(1)}`;
    } else if (bearishScore >= MIN_ENTRY_SCORE && scoreGap >= SCORE_GAP && rsiInShortPullback) {
      action = "SHORT";
      actionReason = `SHORT: score=${bearishScore} gap=${scoreGap} RSI=${rsi.toFixed(1)}`;
    } else {
      actionReason = `HOLD: score=${Math.max(bullishScore, bearishScore)} < ${MIN_ENTRY_SCORE} or gap=${scoreGap} < ${SCORE_GAP}`;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RULE 5: ADAPTIVE PROFIT TARGETS
    // ═══════════════════════════════════════════════════════════════
    
    let targetProfit;
    if (trendStrength === "STRONG") {
      targetProfit = PROFIT_STRONG;
    } else if (trendStrength === "NORMAL") {
      targetProfit = PROFIT_NORMAL;
    } else {
      targetProfit = PROFIT_WEAK;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RULE 6: FEE PROTECTION
    // (Handled at exit level, not here)
    
    // Calculate SL and TP levels
    let stopLoss = null;
    let takeProfit = null;
    
    if (action === "LONG") {
      const recentLow = Math.min(...lows.slice(-10));
      stopLoss = Math.min(recentLow, ema50) * (1 - 0.015); // 1.5% SL for BTC
      takeProfit = currentPrice * (1 + targetProfit.max / 100);
    } else if (action === "SHORT") {
      const recentHigh = Math.max(...highs.slice(-10));
      stopLoss = Math.max(recentHigh, ema50) * (1 + 0.015); // 1.5% SL for BTC
      takeProfit = currentPrice * (1 - targetProfit.max / 100);
    }
    
    return {
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      action,
      confidence,
      price: currentPrice,
      priceChange: ((currentPrice - prevPrice) / prevPrice) * 100,
      trend,
      trend_strength: trendStrength,
      trend_ema_gap: emaGap,
      reason: actionReason + " | " + sigReasons.slice(0, 3).join(", "),
      indicators: {
        ema20: ema20?.toFixed(2),
        ema50: ema50?.toFixed(2),
        rsi: rsi?.toFixed(1),
        atr: atr?.toFixed(2),
        atrPct: atrPct?.toFixed(3),
        volumeRatio: volumeRatio?.toFixed(2)
      },
      scores: {
        bullish: bullishScore,
        bearish: bearishScore,
        gap: scoreGap
      },
      target_profit: targetProfit,
      levels: {
        stopLoss: stopLoss?.toFixed(8),
        takeProfit: takeProfit?.toFixed(8)
      },
      timestamp: Date.now()
    };
    
  } catch (error) {
    return {
      symbol: SYMBOL,
      action: "HOLD",
      error: true,
      message: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * Quick analysis for trading loop — BTC TREND PULLBACK STRATEGY
 * Entry only on pullback continuation. Counter-trend entries blocked.
 * LONG : HTF BULLISH + EMA9>EMA21 + RSI 45-52 + price near EMA21 + vol>=0.8
 * SHORT: HTF BEARISH + EMA9<EMA21 + RSI 48-55 + price near EMA21 + vol>=0.8
 * @param {number} lossStreak - consecutive losses (0 = none)
 */
async function quickAnalysis(lossStreak = 0) {
  try {
    const klines = await fetchKlines(SYMBOL, TIMEFRAME, 100);
    const closes  = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);

    const ema9  = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi   = calculateRSI(klines, 14);
    const atr   = calculateATR(klines, 14);

    const currentPrice = closes[closes.length - 1];
    const atrPct       = atr ? (atr / currentPrice) * 100 : 0;

    const nonZeroVols = volumes.slice(-20).filter(v => v > 0);
    const avgVol      = nonZeroVols.length > 0
      ? nonZeroVols.reduce((a, b) => a + b, 0) / nonZeroVols.length : 1;
    const volumeRatio = volumes[volumes.length - 1] / avgVol;

    // HTF trend from EMA20/EMA50
    const trend = ema20 > ema50 ? "BULLISH" : (ema20 < ema50 ? "BEARISH" : "NEUTRAL");

    let action     = "HOLD";
    let confidence = 0;
    let reason     = "";
    const signals  = [];

    // === PART 3: ATR ENTRY GATE ===
    if (atrPct < 0.15) {
      reason = `ATR too low (${atrPct.toFixed(3)}% < 0.15%) — no trade`;
      console.log(`[STRATEGY] ATR gate blocked: ${atrPct.toFixed(3)}%`);
      console.log(`[ENTRY CHECK BTC] Trend: ${trend} | RSI: ${rsi?.toFixed(1)} | ATR%: ${atrPct.toFixed(3)} | Confidence: 0 | Decision: HOLD | Reason: ${reason}`);
      return { action: "HOLD", price: currentPrice, trend, rsi, ema9, ema21, ema20, ema50, atr, atrPct, volumeRatio, confidence: 0, reason, signals: [reason], timestamp: Date.now() };
    }

    // === PART 4: LOSS STREAK GUARD ===
    if (lossStreak >= 3) {
      reason = `Loss streak ${lossStreak}x — paused 30 min`;
      console.log(`[STRATEGY] Loss streak protection active — streak ${lossStreak}, trading PAUSED`);
      console.log(`[ENTRY CHECK BTC] Trend: ${trend} | RSI: ${rsi?.toFixed(1)} | ATR%: ${atrPct.toFixed(3)} | Confidence: 0 | Decision: HOLD | Reason: ${reason}`);
      return { action: "HOLD", price: currentPrice, trend, rsi, ema9, ema21, ema20, ema50, atr, atrPct, volumeRatio, confidence: 0, reason, signals: [reason], lossStreakPause: true, timestamp: Date.now() };
    }
    const lossStreakConfBonus = lossStreak >= 2 ? 10 : 0;
    if (lossStreak >= 2) {
      console.log(`[STRATEGY] Loss streak protection active — streak ${lossStreak}, required confidence +${lossStreakConfBonus}`);
    }

    // === PART 1: HARD TREND FILTER ===
    const trendStrengthPct = ema9 && ema21 ? Math.abs(ema9 - ema21) / currentPrice * 100 : 0;
    const isStrongTrend    = trendStrengthPct > 0.25;
    console.log(`[STRATEGY] TrendStrength: ${trendStrengthPct.toFixed(3)}% | Regime: ${isStrongTrend ? "STRONG_TREND" : "WEAK_TREND"} | HTF: ${trend}`);

    // ── Recent price momentum (last 5 candles = ~75 min) ──
    // Guards against EMA lag when price has already reversed
    const last5closes       = closes.slice(-5);
    const netMove5          = (last5closes[4] - last5closes[0]) / last5closes[0] * 100;
    const greenCount        = klines.slice(-5).filter(k => k.close > k.open).length;
    const redCount          = klines.slice(-5).filter(k => k.close < k.open).length;
    const priceMomentumBullish = netMove5 > 0.3 || greenCount >= 3;
    const priceMomentumBearish = netMove5 < -0.3 || redCount >= 3;

    // === PART 2: PULLBACK ENTRY ===
    const distFromEMA21  = ema21 ? Math.abs(currentPrice - ema21) / ema21 * 100 : 999;
    const nearEMA21      = distFromEMA21 < 0.15;
    const inLongPullback  = rsi != null && rsi >= 45 && rsi <= 52;
    const inShortPullback = rsi != null && rsi >= 48 && rsi <= 55;
    const volOK           = volumeRatio >= 0.8;

    if (trend === "BULLISH" && ema9 > ema21 && nearEMA21 && inLongPullback && volOK && !priceMomentumBearish) {

      // === PART 1: Counter-trend block (LONG is WITH trend — no block needed) ===
      action     = "LONG";
      confidence = 58;
      signals.push(`HTF BULLISH (EMA20>EMA50: ${((ema20 - ema50) / ema50 * 100).toFixed(2)}%)`);
      signals.push(`EMA9(${ema9?.toFixed(2)}) > EMA21(${ema21?.toFixed(2)})`);
      signals.push(`RSI pullback: ${rsi.toFixed(1)} in [45-52]`);
      signals.push(`Price near EMA21: dist ${distFromEMA21.toFixed(3)}%`);
      signals.push(`Vol ${volumeRatio.toFixed(2)}x avg`);
      confidence += 10; // pullback confirmed bonus
      if (atrPct > 0.18) { confidence += 5; signals.push(`ATR active: ${atrPct.toFixed(3)}%`); }
      confidence = Math.min(85, confidence + lossStreakConfBonus);
      reason = `[STRATEGY] Pullback detected — BTC LONG: RSI=${rsi.toFixed(1)}, dist=${distFromEMA21.toFixed(3)}%, vol=${volumeRatio.toFixed(2)}x`;
      console.log(reason);

    } else if (trend === "BEARISH" && ema9 < ema21 && nearEMA21 && inShortPullback && volOK && !priceMomentumBullish) {

      // === PART 1: Counter-trend block — block LONG when STRONG BEARISH trend ===
      if (isStrongTrend && priceMomentumBullish) {
        console.log(`[STRATEGY] Counter-trend blocked — STRONG BEARISH but momentum bullish`);
        reason = `Counter-trend blocked: strong BEARISH trend + bullish momentum`;
      } else {
        action     = "SHORT";
        confidence = 58;
        signals.push(`HTF BEARISH (EMA20<EMA50: ${((ema20 - ema50) / ema50 * 100).toFixed(2)}%)`);
        signals.push(`EMA9(${ema9?.toFixed(2)}) < EMA21(${ema21?.toFixed(2)})`);
        signals.push(`RSI pullback: ${rsi.toFixed(1)} in [48-55]`);
        signals.push(`Price near EMA21: dist ${distFromEMA21.toFixed(3)}%`);
        signals.push(`Vol ${volumeRatio.toFixed(2)}x avg`);
        confidence += 10;
        if (atrPct > 0.18) { confidence += 5; signals.push(`ATR active: ${atrPct.toFixed(3)}%`); }
        confidence = Math.min(85, confidence + lossStreakConfBonus);
        reason = `[STRATEGY] Pullback detected — BTC SHORT: RSI=${rsi.toFixed(1)}, dist=${distFromEMA21.toFixed(3)}%, vol=${volumeRatio.toFixed(2)}x`;
        console.log(reason);
      }

    } else {
      // === PART 1: Hard counter-trend block ===
      if (isStrongTrend && trend === "BULLISH" && priceMomentumBullish) {
        console.log(`[STRATEGY] Counter-trend blocked — STRONG BULLISH trend active, SHORT entries suppressed`);
      }
      if (isStrongTrend && trend === "BEARISH" && priceMomentumBearish) {
        console.log(`[STRATEGY] Counter-trend blocked — STRONG BEARISH trend active, LONG entries suppressed`);
      }

      // Log which conditions failed
      const whyNot = [];
      if (trend === "NEUTRAL") whyNot.push("trend NEUTRAL");
      if (trend === "BULLISH") {
        if (!(ema9 > ema21))    whyNot.push(`EMA9(${ema9?.toFixed(0)})<EMA21(${ema21?.toFixed(0)})`);
        if (!nearEMA21)         whyNot.push(`dist EMA21 ${distFromEMA21.toFixed(3)}%>0.15%`);
        if (!inLongPullback)    whyNot.push(`RSI ${rsi?.toFixed(1)} not in 45-52`);
        if (!volOK)             whyNot.push(`vol ${volumeRatio.toFixed(2)}x<0.8`);
        if (priceMomentumBearish) whyNot.push("bearish momentum blocks LONG");
      }
      if (trend === "BEARISH") {
        if (!(ema9 < ema21))    whyNot.push(`EMA9(${ema9?.toFixed(0)})>EMA21(${ema21?.toFixed(0)})`);
        if (!nearEMA21)         whyNot.push(`dist EMA21 ${distFromEMA21.toFixed(3)}%>0.15%`);
        if (!inShortPullback)   whyNot.push(`RSI ${rsi?.toFixed(1)} not in 48-55`);
        if (!volOK)             whyNot.push(`vol ${volumeRatio.toFixed(2)}x<0.8`);
        if (priceMomentumBullish) whyNot.push("bullish momentum blocks SHORT");
      }
      reason = `No pullback setup: ${whyNot.join(", ")}`;
    }

    console.log(`[ENTRY CHECK BTC] Trend: ${trend} | RSI: ${rsi?.toFixed(1)} | ATR%: ${atrPct.toFixed(3)} | TrendStr: ${trendStrengthPct.toFixed(3)}% | LossStreak: ${lossStreak} | Confidence: ${confidence} | Decision: ${action} | Reason: ${reason}`);

    return { action, price: currentPrice, trend, rsi, ema9, ema21, ema20, ema50, atr, atrPct, volumeRatio, trendStrengthPct, isStrongTrend, confidence, reason, signals, timestamp: Date.now() };

  } catch (error) {
    return { error: true, action: "HOLD", message: error.message, timestamp: Date.now() };
  }
}

/**
 * Get BTC-specific configuration
 */
function getBTCConfig() {
  return {
    symbol: SYMBOL,
    // BTC-specific risk parameters (more conservative than PEPE)
    STOP_LOSS_PCT: 1.5,    // Lower SL for BTC (less volatile)
    TAKE_PROFIT_PCT: 3.0,  // Lower TP (BTC moves smaller)
    TRAILING_STOP: true,
    TRAILING_OFFSET: 0.5,   // Tighter trailing for BTC
    MIN_SL_PCT: 0.3,
    MAX_SL_PCT: 2.0,
    // Position sizing - BTC allows larger positions
    POSITION_SIZE_USDT: 5,  // More USDT per trade for BTC
    // Timeframe
    TIMEFRAME: TIMEFRAME,
    // Analysis — pullback entry confidence floor (Part 5)
    OPEN_CONFIDENCE: 58,
    // Cooldowns
    SL_COOLDOWN_CANDLES: 2  // Shorter cooldown for BTC
  };
}

module.exports = {
  SYMBOL,
  TIMEFRAME,
  analyzeBTC,
  quickAnalysis,
  getBTCConfig,
  // Utility functions exported for testing
  calculateEMA,
  calculateEMAArray,
  calculateRSI,
  calculateATR,
  calculateATRPct,
  fetchKlines
};
