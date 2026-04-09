/**
 * BTC Strategy Module - v5.0 HYBRID AI MODE
 * TREND-FOLLOWING SNIPER SYSTEM with Hybrid AI Engine
 * 
 * HYBRID AI ARCHITECTURE:
 * - Layer 1: Rule Engine (hard filters)
 * - Layer 2: AI Decision Engine (scoring + confidence)
 * - Layer 3: ML Adaptive Engine (weight tuning)
 * 
 * FEATURES:
 * - Whale Tracking Engine
 * - Expectancy Optimizer
 * - Self-Learning Engine
 * - ML-Lite Weight Adaptation
 */

"use strict";

const https = require("https");
const httpsAgent = new https.Agent({ rejectUnauthorized: true });

const SYMBOL = "BTCUSDT";
const TIMEFRAME = "15m";
const KLINE_LIMIT = 200;

// ═══════════════════════════════════════════════════════════════
// LAYER 1: RULE ENGINE CONFIG (Hard Filters)
// ═══════════════════════════════════════════════════════════════

const MIN_ATR_PERCENT = 0.15;
const MIN_ATR_BLOCK = 0.12;
const MIN_VOLUME_BLOCK = 1.0;
const MIN_VOLUME_RATIO = 1.2;
const EMA_GAP_TREND = 0.15;
const EMA_GAP_CHOP = 0.10;

const RSI_LONG = { min: 45, max: 65 };
const RSI_SHORT = { min: 35, max: 55 };
const RSI_CHOP = { min: 45, max: 55 };

const EXPECTED_MOVE_STRONG = 0.30;
const EXPECTED_MOVE_NORMAL = 0.40;

const MIN_ENTRY_SCORE = 75;
const SCORE_GAP = 25;
const OVERRIDE_SCORE_REDUCTION = 10;
const OVERRIDE_SIZE_REDUCTION = 20;

const POST_WIN_WAIT = 15;
const NO_TRADE_HOURS = 4;
const NO_TRADE_SCORE_REDUCTION = 5;

const VOLUME_BREAKOUT = 1.3;
const VOLUME_FAST_ENTRY = 1.5;
const CANDLE_BODY_BREAKOUT = 0.60;
const CANDLE_BODY_FAST_ENTRY = 0.70;

const ANTI_EXHAUSTION_RSI = 70;
const ANTI_EXHAUSTION_DIST = 0.7;
const ANTI_FOMO_MOVE = 0.8;

const POSITION_STRONG = 1.30;
const POSITION_NORMAL = 1.00;
const POSITION_WEAK = 0.70;
const POSITION_DEFENSE = 0.50;

const SL_PERCENT = 1.5;
const PEAK_DROP_PERCENT = 25;
const TRAILING_START = 0.5;
const PROFIT_LOCK_1 = 1.0;
const PROFIT_LOCK_2 = 2.0;
const PROFIT_LOCK_3 = 3.0;
const LOCK_1_PERCENT = 30;
const LOCK_2_PERCENT = 50;
const LOCK_3_PERCENT = 70;
const PARTIAL_1_PERCENT = 30;
const PARTIAL_2_PERCENT = 30;

// ═══════════════════════════════════════════════════════════════
// LAYER 3: ML-LITE WEIGHT CONFIG (Adaptive)
// ═══════════════════════════════════════════════════════════════

let ML_WEIGHTS = {
  trend: 20,
  momentum: 15,
  volume: 15,
  structure: 20,
  whale: 10
};

const ML_CONFIG = {
  MIN_WEIGHT: 5,
  MAX_WEIGHT: 30,
  ADJUST_STEP: 1,
  TRACK_WINDOW: 20
};

// ═══════════════════════════════════════════════════════════════
// EXPECTANCY TRACKER
// ═══════════════════════════════════════════════════════════════

let ExpectancyState = {
  trades: [],
  winRate: 0,
  avgWin: 0,
  avgLoss: 0,
  expectancy: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0
};

const EXPECTANCY_CONFIG = {
  LOW_EXPECTANCY_THRESHOLD: 0,
  REDUCE_SIZE_ON_LOSS: 0.30,
  INCREASE_SIZE_ON_GAIN: 0.20,
  MAX_LOSS_STREAK_TRIGGER: 3
};

// ═══════════════════════════════════════════════════════════════
// SELF-LEARNING ENGINE STATE
// ═══════════════════════════════════════════════════════════════

let SelfLearnState = {
  tradeLog: [],
  patternScores: {},
  marketPhasePerformance: {},
  scoreRangePerformance: {},
  sessionPerformance: {}
};

const SELF_LEARN_CONFIG = {
  MIN_TRADES_FOR_LEARNING: 10,
  WIN_THRESHOLD: 0.55,
  LOSS_THRESHOLD: 0.45
};

// ═══════════════════════════════════════════════════════════════
// TRADE HISTORY FOR ML + SELF-LEARNING
// ═══════════════════════════════════════════════════════════════

let TradeHistory = {
  entries: [],
  maxSize: 100
};

// ═══════════════════════════════════════════════════════════════
// WHALE TRACKING CONFIG
// ═══════════════════════════════════════════════════════════════

const WHALE_CONFIG = {
  VOLUME_SPIKE_THRESHOLD: 1.5,
  SUDDEN_MOVE_THRESHOLD: 0.5,
  ABSORPTION_BODY_RATIO: 0.30,
  LIQUIDATION_WICK_RATIO: 0.60,
  SCORE_SPIKE: 20,
  SCORE_SUDDEN: 20,
  SCORE_ABSORPTION: 15,
  SCORE_LIQUIDATION: 15,
  WHALE_BOOST_THRESHOLD: 40,
  WHALE_AGGRESSIVE_THRESHOLD: 60
};

// ═══════════════════════════════════════════════════════════════
// FETCH KLINES
// ═══════════════════════════════════════════════════════════════

async function fetchKlines(symbol, interval, limit = KLINE_LIMIT) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.bitget.com",
      path: `/api/v2/mix/market/history-candles?symbol=${symbol}&productType=usdt-futures&granularity=${interval}&limit=${limit}`,
      method: "GET",
      headers: { "Content-Type": "application/json" },
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

// ═══════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════

function calculateEMA(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateEMAArray(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const emaArray = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  emaArray[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    emaArray[i] = (values[i] - emaArray[i - 1]) * multiplier + emaArray[i - 1];
  }
  return emaArray;
}

function calculateRSI(klines, period = 14) {
  const closes = klines.map(k => k.close);
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = (gains / period) / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trValues[trValues.length - period + i];
  let atr = sum / period;
  for (let i = trValues.length - period - 1; i >= 0; i--) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }
  return atr;
}

// ═══════════════════════════════════════════════════════════════
// LAYER 1: RULE ENGINE (Hard Filters)
// ═══════════════════════════════════════════════════════════════

function applyRuleEngine(klines, indicators, state) {
  const errors = [];
  
  if (indicators.atrPct < MIN_ATR_BLOCK) {
    errors.push(`ATR ${indicators.atrPct.toFixed(3)}% < ${MIN_ATR_BLOCK}% (HARD BLOCK)`);
  }
  
  if (indicators.volumeRatio < MIN_VOLUME_BLOCK) {
    errors.push(`Volume ${indicators.volumeRatio.toFixed(2)}x < ${MIN_VOLUME_BLOCK}x (HARD BLOCK)`);
  }
  
  if (indicators.trendStrength === "WEAK") {
    errors.push("Trend too weak (HARD BLOCK)");
  }
  
  if (indicators.emaGap < 0.05) {
    errors.push("EMA flat (HARD BLOCK)");
  }
  
  return {
    passed: errors.length === 0,
    errors,
    blocked: errors.length > 0
  };
}

// ═══════════════════════════════════════════════════════════════
// 🐋 WHALE TRACKING ENGINE
// ═══════════════════════════════════════════════════════════════

function detectWhaleActivity(klines, currentPrice) {
  const whale = {
    volumeSpike: false,
    suddenMove: false,
    absorption: false,
    liquidationCluster: false,
    score: 0,
    signals: []
  };
  
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  const volumes = klines.map(k => k.volume);
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;
  
  const priceMove = Math.abs(candle.close - candle.open) / candle.open * 100;
  const candleRange = candle.high - candle.low;
  const candleBody = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  
  // Volume Spike: volume >= 1.5x avg
  if (volumeRatio >= WHALE_CONFIG.VOLUME_SPIKE_THRESHOLD) {
    whale.volumeSpike = true;
    whale.score += WHALE_CONFIG.SCORE_SPIKE;
    whale.signals.push(`Vol spike ${volumeRatio.toFixed(2)}x (+${WHALE_CONFIG.SCORE_SPIKE})`);
  }
  
  // Sudden Move: candle move >= 0.5%
  if (priceMove >= WHALE_CONFIG.SUDDEN_MOVE_THRESHOLD) {
    whale.suddenMove = true;
    whale.score += WHALE_CONFIG.SCORE_SUDDEN;
    whale.signals.push(`Sudden move ${priceMove.toFixed(2)}% (+${WHALE_CONFIG.SCORE_SUDDEN})`);
  }
  
  // Absorption: high volume but small candle body (< 30% of range)
  if (candleRange > 0) {
    const bodyRatio = candleBody / candleRange;
    if (volumeRatio >= 1.3 && bodyRatio < WHALE_CONFIG.ABSORPTION_BODY_RATIO) {
      whale.absorption = true;
      whale.score += WHALE_CONFIG.SCORE_ABSORPTION;
      whale.signals.push(`Absorption ${bodyRatio.toFixed(2)} body ratio (+${WHALE_CONFIG.SCORE_ABSORPTION})`);
    }
  }
  
  // Liquidation Cluster: large wick (> 60% of range)
  if (candleRange > 0) {
    const wickRatio = Math.max(upperWick, lowerWick) / candleRange;
    if (wickRatio >= WHALE_CONFIG.LIQUIDATION_WICK_RATIO) {
      whale.liquidationCluster = true;
      whale.score += WHALE_CONFIG.SCORE_LIQUIDATION;
      whale.signals.push(`Liquidation wick ${wickRatio.toFixed(2)} (+${WHALE_CONFIG.SCORE_LIQUIDATION})`);
    }
  }
  
  // Whales moving opposite to price (absorption pattern)
  if (whale.absorption) {
    if (candle.close < candle.open && whale.volumeSpike) {
      whale.signals.push("Bearish absorption detected");
    } else if (candle.close > candle.open && whale.volumeSpike) {
      whale.signals.push("Bullish absorption detected");
    }
  }
  
  return whale;
}

function applyWhaleBoost(whale, baseConfidence, baseScore) {
  let adjustedConfidence = baseConfidence;
  let adjustedScore = baseScore;
  let whaleBoost = 0;
  
  if (whale.score >= WHALE_CONFIG.WHALE_AGGRESSIVE_THRESHOLD) {
    whaleBoost = 0.15;
    adjustedConfidence = Math.min(1, adjustedConfidence + whaleBoost);
    adjustedScore += 15;
  } else if (whale.score >= WHALE_CONFIG.WHALE_BOOST_THRESHOLD) {
    whaleBoost = 0.10;
    adjustedConfidence = Math.min(1, adjustedConfidence + whaleBoost);
    adjustedScore += 10;
  }
  
  return {
    confidence: adjustedConfidence,
    score: adjustedScore,
    whaleBoost,
    whaleLevel: whale.score >= WHALE_CONFIG.WHALE_AGGRESSIVE_THRESHOLD ? "AGGRESSIVE" : 
                 whale.score >= WHALE_CONFIG.WHALE_BOOST_THRESHOLD ? "ACTIVE" : "NORMAL"
  };
}

// ═══════════════════════════════════════════════════════════════
// 🧮 EXPECTANCY OPTIMIZER
// ═══════════════════════════════════════════════════════════════

function updateExpectancy(tradeResult) {
  ExpectancyState.trades.push(tradeResult);
  if (ExpectancyState.trades.length > 50) {
    ExpectancyState.trades.shift();
  }
  
  const wins = ExpectancyState.trades.filter(t => t.pnl > 0);
  const losses = ExpectancyState.trades.filter(t => t.pnl <= 0);
  
  ExpectancyState.winRate = ExpectancyState.trades.length > 0 ? wins.length / ExpectancyState.trades.length : 0;
  ExpectancyState.avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  ExpectancyState.avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  
  ExpectancyState.expectancy = (ExpectancyState.winRate * ExpectancyState.avgWin) - ((1 - ExpectancyState.winRate) * ExpectancyState.avgLoss);
  
  if (losses.length > 0) {
    ExpectancyState.consecutiveLosses = 0;
    ExpectancyState.consecutiveWins = 0;
    for (let i = ExpectancyState.trades.length - 1; i >= 0; i--) {
      if (ExpectancyState.trades[i].pnl > 0) break;
      ExpectancyState.consecutiveLosses++;
    }
  }
  
  if (wins.length > 0) {
    ExpectancyState.consecutiveWins = 0;
    ExpectancyState.consecutiveLosses = 0;
    for (let i = ExpectancyState.trades.length - 1; i >= 0; i--) {
      if (ExpectancyState.trades[i].pnl <= 0) break;
      ExpectancyState.consecutiveWins++;
    }
  }
  
  return getExpectancyStatus();
}

function getExpectancyStatus() {
  const exp = ExpectancyState.expectancy;
  const wr = ExpectancyState.winRate;
  const streak = ExpectancyState.consecutiveLosses;
  
  let status = "NORMAL";
  let sizeMultiplier = 1.0;
  let reason = "";
  
  if (streak >= EXPECTANCY_CONFIG.MAX_LOSS_STREAK_TRIGGER) {
    status = "DEFENSIVE";
    sizeMultiplier = 1 - EXPECTANCY_CONFIG.REDUCE_SIZE_ON_LOSS;
    reason = `${streak} losses in row - reducing size ${(EXPECTANCY_CONFIG.REDUCE_SIZE_ON_LOSS * 100).toFixed(0)}%`;
  } else if (exp < EXPECTANCY_CONFIG.LOW_EXPECTANCY_THRESHOLD) {
    status = "CAUTIOUS";
    sizeMultiplier = 1 - EXPECTANCY_CONFIG.REDUCE_SIZE_ON_LOSS * 0.5;
    reason = `Low expectancy ${exp.toFixed(3)} - reducing size`;
  } else if (exp > 0.5) {
    status = "BULLISH";
    sizeMultiplier = 1 + EXPECTANCY_CONFIG.INCREASE_SIZE_ON_GAIN;
    reason = `High expectancy ${exp.toFixed(3)} - increasing size`;
  } else {
    reason = `Expectancy ${exp.toFixed(3)}, WR ${(wr * 100).toFixed(0)}%`;
  }
  
  return {
    status,
    sizeMultiplier: Math.max(0.3, Math.min(1.5, sizeMultiplier)),
    expectancy: exp,
    winRate: wr,
    avgWin: ExpectancyState.avgWin,
    avgLoss: ExpectancyState.avgLoss,
    consecutiveLosses: ExpectancyState.consecutiveLosses,
    consecutiveWins: ExpectancyState.consecutiveWins,
    reason
  };
}

function getExpectancyForDecision() {
  return ExpectancyState;
}

// ═══════════════════════════════════════════════════════════════
// 📊 SELF-LEARNING ENGINE
// ═══════════════════════════════════════════════════════════════

function logTradeForLearning(trade) {
  SelfLearnState.tradeLog.push(trade);
  if (SelfLearnState.tradeLog.length > SelfLearnConfig.MAX_TRADES) {
    SelfLearnState.tradeLog.shift();
  }
  
  analyzeTradePatterns();
}

const SelfLearnConfig = {
  MAX_TRADES: 100,
  MIN_TRADES_FOR_UPDATE: 10,
  SCORE_RANGE_SIZE: 5
};

function analyzeTradePatterns() {
  const trades = SelfLearnState.tradeLog;
  if (trades.length < SelfLearnConfig.MIN_TRADES_FOR_UPDATE) return;
  
  const scoreRanges = {};
  trades.forEach(t => {
    const rangeKey = Math.floor(t.entryScore / SelfLearnConfig.SCORE_RANGE_SIZE) * SelfLearnConfig.SCORE_RANGE_SIZE;
    if (!scoreRanges[rangeKey]) {
      scoreRanges[rangeKey] = { wins: 0, total: 0 };
    }
    scoreRanges[rangeKey].total++;
    if (t.result === "WIN") scoreRanges[rangeKey].wins++;
  });
  
  Object.keys(scoreRanges).forEach(range => {
    const data = scoreRanges[range];
    data.winRate = data.wins / data.total;
  });
  
  SelfLearnState.scoreRangePerformance = scoreRanges;
  
  const marketPhases = {};
  trades.forEach(t => {
    const phase = t.marketPhase || "UNKNOWN";
    if (!marketPhases[phase]) {
      marketPhases[phase] = { wins: 0, total: 0 };
    }
    marketPhases[phase].total++;
    if (t.result === "WIN") marketPhases[phase].wins++;
  });
  
  Object.keys(marketPhases).forEach(phase => {
    const data = marketPhases[phase];
    data.winRate = data.wins / data.total;
  });
  
  SelfLearnState.marketPhasePerformance = marketPhases;
}

function getSelfLearnAdjustment(entryScore, marketPhase) {
  const adjustments = {
    scoreModifier: 0,
    confidenceModifier: 0,
    reasons: []
  };
  
  const trades = SelfLearnState.tradeLog;
  if (trades.length < SelfLearnConfig.MIN_TRADES_FOR_UPDATE) {
    return adjustments;
  }
  
  const rangeKey = Math.floor(entryScore / SelfLearnConfig.SCORE_RANGE_SIZE) * SelfLearnConfig.SCORE_RANGE_SIZE;
  const rangePerf = SelfLearnState.scoreRangePerformance[rangeKey];
  
  if (rangePerf && rangePerf.total >= 3) {
    if (rangePerf.winRate < SELF_LEARN_CONFIG.LOSS_THRESHOLD) {
      adjustments.scoreModifier = 5;
      adjustments.reasons.push(`Score range ${rangeKey}-${rangeKey + SelfLearnConfig.SCORE_RANGE_SIZE} WR ${(rangePerf.winRate * 100).toFixed(0)}% - need higher score`);
    }
  }
  
  const phasePerf = SelfLearnState.marketPhasePerformance[marketPhase];
  if (phasePerf && phasePerf.total >= 3) {
    if (phasePerf.winRate < SELF_LEARN_CONFIG.LOSS_THRESHOLD) {
      adjustments.confidenceModifier -= 0.1;
      adjustments.reasons.push(`${marketPhase} phase WR ${(phasePerf.winRate * 100).toFixed(0)}% - reducing confidence`);
    } else if (phasePerf.winRate > SELF_LEARN_CONFIG.WIN_THRESHOLD) {
      adjustments.confidenceModifier += 0.05;
      adjustments.reasons.push(`${marketPhase} phase WR ${(phasePerf.winRate * 100).toFixed(0)}% - boosting confidence`);
    }
  }
  
  return adjustments;
}

function getSelfLearnStatus() {
  const trades = SelfLearnState.tradeLog;
  const total = trades.length;
  const wins = trades.filter(t => t.result === "WIN").length;
  
  return {
    totalTrades: total,
    learningActive: total >= SelfLearnConfig.MIN_TRADES_FOR_UPDATE,
    scoreRanges: SelfLearnState.scoreRangePerformance,
    marketPhases: SelfLearnState.marketPhasePerformance,
    recentPatterns: trades.slice(-5).map(t => ({
      score: t.entryScore,
      phase: t.marketPhase,
      result: t.result
    }))
  };
}

// ═══════════════════════════════════════════════════════════════
// ⚙️ ML-LITE WEIGHT ADAPTATION
// ═══════════════════════════════════════════════════════════════

function updateMLWeights(tradeResult, featureWeights) {
  const { feature, result } = tradeResult;
  
  if (result === "WIN") {
    ML_WEIGHTS[feature] = Math.min(ML_CONFIG.MAX_WEIGHT, ML_WEIGHTS[feature] + ML_CONFIG.ADJUST_STEP);
  } else {
    ML_WEIGHTS[feature] = Math.max(ML_CONFIG.MIN_WEIGHT, ML_WEIGHTS[feature] - ML_CONFIG.ADJUST_STEP);
  }
}

function applyMLWeights(context) {
  let score = 0;
  const factors = [];
  
  const w = ML_WEIGHTS;
  
  // Trend (default 20)
  if (context.trend === "BULLISH") {
    score += w.trend;
    factors.push({ feature: "trend", value: w.trend, type: "positive", text: `Bullish trend (+${w.trend})` });
  } else if (context.trend === "BEARISH") {
    score -= w.trend;
    factors.push({ feature: "trend", value: -w.trend, type: "negative", text: `Bearish trend (-${w.trend})` });
  }
  
  // Momentum (default 15)
  if (context.momentumPullback) {
    score += w.momentum;
    factors.push({ feature: "momentum", value: w.momentum, type: "positive", text: `RSI pullback (+${w.momentum})` });
  }
  if (context.momentumExhaustion) {
    score -= w.momentum * 0.5;
    factors.push({ feature: "momentum", value: -w.momentum * 0.5, type: "negative", text: `RSI exhaustion (-${w.momentum * 0.5})` });
  }
  
  // Volume (default 15)
  if (context.volumeOK) {
    score += w.volume;
    factors.push({ feature: "volume", value: w.volume, type: "positive", text: `Volume OK (+${w.volume})` });
  }
  if (context.volumeSpike) {
    score += w.volume * 0.5;
    factors.push({ feature: "volume", value: w.volume * 0.5, type: "positive", text: `Volume spike (+${w.volume * 0.5})` });
  }
  
  // Structure/Breakout (default 20)
  if (context.breakout) {
    score += w.structure;
    factors.push({ feature: "structure", value: w.structure, type: "positive", text: `Breakout (+${w.structure})` });
  }
  if (context.fakeBreakoutRisk > 50) {
    score -= w.structure * 0.5;
    factors.push({ feature: "structure", value: -w.structure * 0.5, type: "negative", text: `Fake breakout risk (-${w.structure * 0.5})` });
  }
  
  // Whale (default 10)
  if (context.whaleActive) {
    score += w.whale;
    factors.push({ feature: "whale", value: w.whale, type: "positive", text: `Whale activity (+${w.whale})` });
  }
  
  return { score, factors, weights: { ...w } };
}

function getMLWeights() {
  return { ...ML_WEIGHTS };
}

function resetMLWeights() {
  ML_WEIGHTS = {
    trend: 20,
    momentum: 15,
    volume: 15,
    structure: 20,
    whale: 10
  };
}

// ═══════════════════════════════════════════════════════════════
// MARKET PHASE + TREND HELPERS
// ═══════════════════════════════════════════════════════════════

function getMarketPhase(emaGap, rsi) {
  if (emaGap >= EMA_GAP_TREND) return "TREND";
  if (emaGap < EMA_GAP_CHOP && rsi >= RSI_CHOP.min && rsi <= RSI_CHOP.max) return "CHOP";
  return "TRANSITION";
}

function getTrendStrength(emaGap, volumeRatio) {
  if (emaGap >= 0.20 && volumeRatio >= 1.3) return "STRONG";
  if (emaGap >= 0.10) return "NORMAL";
  return "WEAK";
}

function detectBreakout(klines, trend) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  
  if (range === 0) return { valid: false, reasons: ["no range"] };
  
  const bodyPercent = body / range;
  const wickDominant = Math.max(upperWick, lowerWick) > body;
  
  let direction = null;
  let valid = false;
  const reasons = [];

  if (trend === "BULLISH") {
    if (candle.close > candle.open) {
      direction = "LONG";
      const nearHigh = (candle.high - candle.close) / candle.high * 100 < 0.2;
      if (bodyPercent >= CANDLE_BODY_BREAKOUT && !wickDominant && nearHigh) {
        valid = true;
        reasons.push("bullish body strong");
      } else {
        reasons.push(`body ${bodyPercent.toFixed(2)} < ${CANDLE_BODY_BREAKOUT} or wick dominant or not near high`);
      }
    }
  } else if (trend === "BEARISH") {
    if (candle.close < candle.open) {
      direction = "SHORT";
      const nearLow = (candle.low - candle.close) / candle.low * 100 < 0.2;
      if (bodyPercent >= CANDLE_BODY_BREAKOUT && !wickDominant && nearLow) {
        valid = true;
        reasons.push("bearish body strong");
      } else {
        reasons.push(`body ${bodyPercent.toFixed(2)} < ${CANDLE_BODY_BREAKOUT} or wick dominant or not near low`);
      }
    }
  }

  return { valid, direction, bodyPercent, wickDominant, reasons };
}

function checkAntiExhaustion(rsi, currentPrice, ema20, trend) {
  if (trend === "BULLISH" && rsi > ANTI_EXHAUSTION_RSI) {
    const distFromEma = ema20 ? Math.abs(currentPrice - ema20) / ema20 * 100 : 0;
    if (distFromEma > ANTI_EXHAUSTION_DIST) {
      return { exhausted: true, reason: `RSI ${rsi} > ${ANTI_EXHAUSTION_RSI} + far from EMA20 (${distFromEma.toFixed(2)}%)` };
    }
  }
  return { exhausted: false };
}

function checkAntiFomo(priceChangePct) {
  if (Math.abs(priceChangePct) > ANTI_FOMO_MOVE) {
    return { fomo: true, reason: `price move ${priceChangePct.toFixed(2)}% > ${ANTI_FOMO_MOVE}% without pullback` };
  }
  return { fomo: false };
}

function getPriority(trendStrength, breakoutValid, lastTradeWin, defenseMode) {
  if (defenseMode) return "P4";
  if (lastTradeWin) return "P3";
  if (trendStrength === "STRONG" && breakoutValid) return "P1";
  if (trendStrength === "NORMAL") return "P2";
  return "P4";
}

function checkConfirmation(klines, trend) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  if (trend === "LONG") {
    const bullishClose = candle.close > candle.open;
    const holdAbove = candle.low > prevCandle.high;
    const higherLow = candle.low > prevCandle.low;
    return {
      confirmed: bullishClose && holdAbove && higherLow,
      reasons: [`bullish: ${bullishClose}`, `hold above: ${holdAbove}`, `higher low: ${higherLow}`]
    };
  } else if (trend === "SHORT") {
    const bearishClose = candle.close < candle.open;
    const holdBelow = candle.high < prevCandle.low;
    const lowerHigh = candle.high < prevCandle.high;
    return {
      confirmed: bearishClose && holdBelow && lowerHigh,
      reasons: [`bearish: ${bearishClose}`, `hold below: ${holdBelow}`, `lower high: ${lowerHigh}`]
    };
  }
  return { confirmed: false, reasons: [] };
}

function getExpectedMove(trendStrength) {
  if (trendStrength === "STRONG") return EXPECTED_MOVE_STRONG;
  if (trendStrength === "NORMAL") return EXPECTED_MOVE_NORMAL;
  return null;
}

function calculatePositionSize(baseSize, trendStrength, defenseMode) {
  if (defenseMode) return baseSize * POSITION_DEFENSE;
  if (trendStrength === "STRONG") return baseSize * POSITION_STRONG;
  if (trendStrength === "WEAK") return baseSize * POSITION_WEAK;
  return baseSize * POSITION_NORMAL;
}

// ═══════════════════════════════════════════════════════════════
// HYBRID AI MAIN ANALYZER
// ═══════════════════════════════════════════════════════════════

async function analyzeBTC(lastTrade = null, defenseMode = false) {
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
    const priceChangePct = ((currentPrice - prevPrice) / prevPrice) * 100;

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    
    const rsi = calculateRSI(klines, 14);
    const atr = calculateATR(klines, 14);
    const atrPct = atr ? (atr / currentPrice) * 100 : 0;
    
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = currentVolume / avgVolume;
    
    const emaGap = ema50 > 0 ? Math.abs((ema20 - ema50) / ema50 * 100) : 0;
    const trend = ema20 > ema50 ? "BULLISH" : (ema20 < ema50 ? "BEARISH" : "NEUTRAL");
    const trendStrength = getTrendStrength(emaGap, volumeRatio);
    const marketPhase = getMarketPhase(emaGap, rsi);
    
    // ─── LAYER 1: RULE ENGINE ───────────────────────────────
    const indicators = {
      atrPct,
      volumeRatio,
      trendStrength,
      emaGap,
      rsi
    };
    
    const ruleResult = applyRuleEngine(klines, indicators, { defenseMode });
    if (ruleResult.blocked) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend,
        trend_strength: trendStrength,
        reason: ruleResult.errors.join("; "),
        indicators: { rsi, atrPct: atrPct?.toFixed(3), volumeRatio: volumeRatio?.toFixed(2) },
        signal: "RULE_BLOCKED",
        market_phase: marketPhase,
        whale: { score: 0, signals: [] },
        expectancy: getExpectancyForDecision(),
        mlWeights: getMLWeights(),
        selfLearn: getSelfLearnStatus(),
        timestamp: Date.now()
      };
    }
    
    const breakout = detectBreakout(klines, trend);
    const antiExhaustion = checkAntiExhaustion(rsi, currentPrice, ema20, trend);
    const antiFomo = checkAntiFomo(priceChangePct);
    
    // ─── 🐋 WHALE TRACKING ENGINE ─────────────────────────────
    const whale = detectWhaleActivity(klines, currentPrice);
    
    let priority = getPriority(trendStrength, breakout.valid, lastTrade?.win, defenseMode);
    let action = "HOLD";
    let confidence = 0;
    let reason = "";
    let override = false;
    let positionMultiplier = 1.0;
    
    const signals = [];
    
    // ─── LAYER 2: AI DECISION ENGINE ─────────────────────────
    // Build market context for ML scoring
    const mlContext = {
      trend,
      momentumPullback: (trend === "BULLISH" && rsi >= RSI_LONG.min && rsi <= RSI_LONG.max) ||
                       (trend === "BEARISH" && rsi >= RSI_SHORT.min && rsi <= RSI_SHORT.max),
      momentumExhaustion: antiExhaustion.exhausted,
      volumeOK: volumeRatio >= MIN_VOLUME_RATIO,
      volumeSpike: whale.volumeSpike,
      breakout: breakout.valid,
      fakeBreakoutRisk: breakout.valid ? (1 - breakout.bodyPercent) * 100 : 50,
      whaleActive: whale.score >= WHALE_CONFIG.WHALE_BOOST_THRESHOLD
    };
    
    // Apply ML weights
    const mlResult = applyMLWeights(mlContext);
    let baseScore = mlResult.score;
    let mlFactors = mlResult.factors;
    
    // Apply self-learning adjustments
    const selfLearnAdjust = getSelfLearnAdjustment(baseScore, marketPhase);
    baseScore += selfLearnAdjust.scoreModifier;
    mlFactors = mlFactors.concat(selfLearnAdjust.reasons.map(r => ({
      text: r,
      type: "neutral",
      value: 0
    })));
    
    // Apply whale boost
    const whaleBoost = applyWhaleBoost(whale, baseScore / 100, baseScore);
    let finalScore = whaleBoost.score;
    let finalConfidence = whaleBoost.confidence;
    
    // Score threshold check
    let scoreRequired = MIN_ENTRY_SCORE;
    if (selfLearnAdjust.scoreModifier > 0) {
      scoreRequired += selfLearnAdjust.scoreModifier;
    }
    if (defenseMode) {
      scoreRequired = 85;
      signals.push("Defense mode: score raised to 85");
    }
    
    // Check anti-fomo and anti-exhaustion
    if (antiFomo.fomo) {
      signals.push(`ANTI-FOMO: ${antiFomo.reason}`);
      mlFactors.push({ text: antiFomo.reason, type: "negative", value: -10 });
      finalConfidence -= 0.1;
    }
    
    if (antiExhaustion.exhausted) {
      signals.push(`ANTI-EXHAUSTION: ${antiExhaustion.reason}`);
      mlFactors.push({ text: antiExhaustion.reason, type: "negative", value: -15 });
      finalConfidence -= 0.15;
    }
    
    // ─── DECISION LOGIC ───────────────────────────────────────
    const fastEntryAllowed = 
      priority === "P1" && 
      trendStrength === "STRONG" && 
      breakout.valid && 
      volumeRatio >= VOLUME_FAST_ENTRY && 
      breakout.bodyPercent >= CANDLE_BODY_FAST_ENTRY;
    
    let entryReady = false;
    
    if (trend === "BULLISH" && finalScore >= scoreRequired) {
      if (fastEntryAllowed) {
        action = "LONG";
        confidence = Math.min(90, finalConfidence * 100);
        reason = `FAST ENTRY P1: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
        signals.push("FAST ENTRY: P1 + STRONG breakout + whale boost");
        entryReady = true;
      } else if (breakout.valid) {
        const confirmation = checkConfirmation(klines, "LONG");
        if (confirmation.confirmed) {
          action = "LONG";
          confidence = Math.min(85, finalConfidence * 100 - 5);
          reason = `CONFIRMED ENTRY: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
          signals.push("Confirmation candle confirmed");
          entryReady = true;
        } else {
          reason = `Waiting confirmation: ${confirmation.reasons.join(", ")}`;
        }
      } else {
        reason = `No breakout: ${breakout.reasons.join(", ")}`;
      }
    } else if (trend === "BEARISH" && finalScore >= scoreRequired) {
      if (fastEntryAllowed) {
        action = "SHORT";
        confidence = Math.min(90, finalConfidence * 100);
        reason = `FAST ENTRY P1: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
        signals.push("FAST ENTRY: P1 + STRONG breakout + whale boost");
        entryReady = true;
      } else if (breakout.valid) {
        const confirmation = checkConfirmation(klines, "SHORT");
        if (confirmation.confirmed) {
          action = "SHORT";
          confidence = Math.min(85, finalConfidence * 100 - 5);
          reason = `CONFIRMED ENTRY: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
          signals.push("Confirmation candle confirmed");
          entryReady = true;
        } else {
          reason = `Waiting confirmation: ${confirmation.reasons.join(", ")}`;
        }
      } else {
        reason = `No breakout: ${breakout.reasons.join(", ")}`;
      }
    } else {
      reason = `Score ${finalScore.toFixed(0)} < ${scoreRequired}`;
    }
    
    // ─── EXPECTANCY ADJUSTMENT ────────────────────────────────
    const expStatus = getExpectancyStatus();
    if (action !== "HOLD") {
      positionMultiplier = calculatePositionSize(1.0, trendStrength, defenseMode);
      positionMultiplier *= expStatus.sizeMultiplier;
    }
    
    // ─── OVERRIDE CHECK ────────────────────────────────────────
    if (entryReady && priority !== "P1") {
      override = true;
      confidence -= OVERRIDE_SCORE_REDUCTION;
      positionMultiplier *= (1 - OVERRIDE_SIZE_REDUCTION / 100);
      signals.push(`OVERRIDE used: conf -${OVERRIDE_SCORE_REDUCTION}, size -${OVERRIDE_SIZE_REDUCTION}%`);
    }
    
    if (marketPhase === "CHOP" && action !== "HOLD") {
      positionMultiplier *= 0.5;
      signals.push("CHOP: size reduced to 50%");
    }
    
    confidence = Math.max(0, Math.min(100, confidence));
    
    // ─── CALCULATE SL/TP ───────────────────────────────────────
    let stopLoss = null;
    let takeProfit = null;
    
    if (action === "LONG") {
      const recentLow = Math.min(...lows.slice(-10));
      stopLoss = Math.min(recentLow, ema50) * (1 - SL_PERCENT / 100);
      takeProfit = currentPrice * (1 + PROFIT_LOCK_3 / 100);
    } else if (action === "SHORT") {
      const recentHigh = Math.max(...highs.slice(-10));
      stopLoss = Math.max(recentHigh, ema50) * (1 + SL_PERCENT / 100);
      takeProfit = currentPrice * (1 - PROFIT_LOCK_3 / 100);
    }
    
    const result = {
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      action,
      confidence: Math.round(confidence),
      price: currentPrice,
      priceChange: priceChangePct,
      trend,
      trend_strength: trendStrength,
      market_phase: marketPhase,
      priority,
      reason: reason + " | " + signals.slice(0, 4).join(", "),
      indicators: {
        ema20: ema20?.toFixed(2),
        ema50: ema50?.toFixed(2),
        ema_gap: emaGap?.toFixed(3),
        rsi: rsi?.toFixed(1),
        atr: atr?.toFixed(2),
        atrPct: atrPct?.toFixed(3),
        volumeRatio: volumeRatio?.toFixed(2)
      },
      breakout: {
        valid: breakout.valid,
        bodyPercent: breakout.bodyPercent?.toFixed(2),
        direction: breakout.direction
      },
      whale: {
        score: whale.score,
        level: whale.score >= WHALE_CONFIG.WHALE_AGGRESSIVE_THRESHOLD ? "AGGRESSIVE" : 
               whale.score >= WHALE_CONFIG.WHALE_BOOST_THRESHOLD ? "ACTIVE" : "NORMAL",
        signals: whale.signals,
        volumeSpike: whale.volumeSpike,
        suddenMove: whale.suddenMove,
        absorption: whale.absorption,
        liquidationCluster: whale.liquidationCluster
      },
      mlWeights: mlResult.weights,
      mlFactors: mlFactors.slice(0, 6),
      selfLearn: {
        status: getSelfLearnStatus(),
        adjustments: selfLearnAdjust
      },
      expectancy: getExpectancyForDecision(),
      expectancyStatus: expStatus,
      scores: {
        mlScore: Math.round(finalScore),
        scoreRequired
      },
      position_multiplier: positionMultiplier.toFixed(2),
      override_used: override,
      validation: {
        trendValid: trend !== "NEUTRAL",
        volumeValid: volumeRatio >= MIN_VOLUME_RATIO,
        atrValid: atrPct >= MIN_ATR_PERCENT,
        notChop: marketPhase !== "CHOP" || priority === "P1",
        breakoutValid: breakout.valid,
        blocked: ruleResult.blocked
      },
      levels: {
        stopLoss: stopLoss?.toFixed(8),
        takeProfit: takeProfit?.toFixed(8)
      },
      exit_rules: {
        sl_percent: SL_PERCENT,
        peak_drop_percent: PEAK_DROP_PERCENT,
        trailing_start: TRAILING_START,
        locks: {
          [`${PROFIT_LOCK_1}%`]: `${LOCK_1_PERCENT}%`,
          [`${PROFIT_LOCK_2}%`]: `${LOCK_2_PERCENT}%`,
          [`${PROFIT_LOCK_3}%`]: `${LOCK_3_PERCENT}%`
        },
        partials: {
          [`${PROFIT_LOCK_1}%`]: `${PARTIAL_1_PERCENT}%`,
          [`${PROFIT_LOCK_2}%`]: `${PARTIAL_2_PERCENT}%`
        }
      },
      signals: signals.slice(0, 6),
      timestamp: Date.now()
    };
    
    console.log(`[v5.0 HYBRID] ${action} | Conf: ${result.confidence} | Score: ${finalScore.toFixed(0)} | ${trend} ${trendStrength} | Whale: ${whale.score} | Exp: ${expStatus.expectancy.toFixed(3)}`);
    
    return result;
    
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

// ═══════════════════════════════════════════════════════════════
// RECORD TRADE FOR LEARNING
// ═══════════════════════════════════════════════════════════════

function recordTrade(trade) {
  const { entryScore, confidence, marketPhase, result, pnl, features } = trade;
  
  TradeHistory.entries.push({
    entryScore,
    confidence,
    marketPhase,
    result,
    pnl,
    timestamp: Date.now()
  });
  
  if (TradeHistory.entries.length > TradeHistory.maxSize) {
    TradeHistory.entries.shift();
  }
  
  // Update Expectancy
  updateExpectancy({ pnl, result });
  
  // Log for Self-Learning
  logTradeForLearning({
    entryScore,
    marketPhase,
    result
  });
  
  // Update ML Weights based on features
  if (features) {
    Object.entries(features).forEach(([feature, won]) => {
      updateMLWeights({ feature, result: won ? "WIN" : "LOSS" }, features);
    });
  }
}

async function quickAnalysis() {
  return analyzeBTC();
}

function getBTCConfig() {
  return {
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    stopLoss: SL_PERCENT,
    takeProfit: PROFIT_LOCK_3,
    trailingStart: TRAILING_START,
    peakDropExit: PEAK_DROP_PERCENT,
    position_multipliers: {
      strong: POSITION_STRONG,
      normal: POSITION_NORMAL,
      weak: POSITION_WEAK,
      defense: POSITION_DEFENSE
    },
    mlWeights: getMLWeights(),
    expectancy: getExpectancyForDecision(),
    selfLearn: getSelfLearnStatus()
  };
}

function getSystemStatus() {
  return {
    mlWeights: getMLWeights(),
    expectancy: getExpectancyForDecision(),
    expectancyStatus: getExpectancyStatus(),
    selfLearn: getSelfLearnStatus(),
    whaleConfig: WHALE_CONFIG,
    tradeHistory: TradeHistory.entries.slice(-10)
  };
}

function resetLearning() {
  ExpectancyState = {
    trades: [],
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    expectancy: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0
  };
  
  SelfLearnState = {
    tradeLog: [],
    patternScores: {},
    marketPhasePerformance: {},
    scoreRangePerformance: {},
    sessionPerformance: {}
  };
  
  TradeHistory = {
    entries: [],
    maxSize: 100
  };
  
  resetMLWeights();
  
  console.log("[HYBRID AI] All learning data reset");
}

module.exports = {
  SYMBOL,
  TIMEFRAME,
  analyzeBTC,
  quickAnalysis,
  getBTCConfig,
  getSystemStatus,
  recordTrade,
  resetLearning,
  calculateEMA,
  calculateEMAArray,
  calculateRSI,
  calculateATR,
  fetchKlines,
  // Export sub-engines for external access
  detectWhaleActivity,
  getExpectancyStatus,
  getMLWeights,
  getSelfLearnStatus,
  updateExpectancy,
  WHALE_CONFIG,
  ML_WEIGHTS
};
