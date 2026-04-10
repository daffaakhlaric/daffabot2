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
// HTF TREND FILTER CONFIG
// ═══════════════════════════════════════════════════════════════

const HTF_CONFIG = {
  TIMEFRAME: "1h",           // Use 1H for HTF trend
  EMA_PERIOD: 50,            // EMA for HTF trend detection
  WHALE_REVERSAL_SCORE: 50   // Min whale score for reversal signal
};

// ═══════════════════════════════════════════════════════════════
// CONTINUATION ENTRY CONFIG
// ═══════════════════════════════════════════════════════════════

const CONTINUATION_CONFIG = {
  BODY_PERCENT_MIN: 0.60,    // Candle body ≥ 60% of range
  VOLUME_MIN: 1.3,           // Volume ≥ 1.3x avg
  PULLBACK_MAX: 0.15,        // Max pullback from prev close (not a weak bounce)
  BREAK_CLOSE_ABOVE: true,   // Break must close above prev high/low
  MOMENTUM确认: true         // Require momentum confirmation
};

// ═══════════════════════════════════════════════════════════════
// EARLY EXIT PROTECTION CONFIG
// ═══════════════════════════════════════════════════════════════

const EARLY_EXIT_CONFIG = {
  MAX_LOSS_BPS: 20,          // 0.2% = 20 bps
  MONITOR_WINDOW_MS: 120000, // 2 minutes
  TRAILING_RESET: true       // Reset if price moves in favor
};

let EarlyExitState = {
  entryPrice: null,
  entryTime: null,
  side: null,
  maxFavorableMove: 0,
  initialLossDetected: false
};

// ═══════════════════════════════════════════════════════════════
// ANTI COUNTER-TREND CONFIG
// ═══════════════════════════════════════════════════════════════

const ANTI_COUNTER_CONFIG = {
  ALLOW_COUNTER_IF_WHALE: true,
  ALLOW_COUNTER_IF_STRUCTURE_BREAK: true,
  WHALE_SCORE_THRESHOLD: 50
};

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
// AUTO PAUSE AFTER LOSS STREAK (Defense Mode)
// ═══════════════════════════════════════════════════════════════

const DEFENSE_CONFIG = {
  CONSECUTIVE_LOSSES_DEFENSE: 2,
  CONSECUTIVE_LOSSES_HARD_PAUSE: 3,
  CONSECUTIVE_LOSSES_EXTREME: 4,
  HARD_PAUSE_MINUTES_30: 30,
  HARD_PAUSE_MINUTES_60: 60,
  MIN_SCORE_DEFENSE: 85,
  POSITION_SIZE_DEFENSE: 0.50,
  SCALP_BLOCK_IN_DEFENSE: true
};

let DefenseState = {
  consecutive_losses: 0,
  defense_mode_active: false,
  hard_pause_until: null,
  trend_reset_required: false
};

function checkDefenseMode() {
  const losses = ExpectancyState.consecutiveLosses;
  const now = Date.now();
  
  if (DefenseState.hard_pause_until && now < DefenseState.hard_pause_until) {
    return {
      mode: "HARD_PAUSE",
      blocked: true,
      remaining_minutes: Math.ceil((DefenseState.hard_pause_until - now) / 60000),
      reason: `Hard pause until ${new Date(DefenseState.hard_pause_until).toISOString()}`
    };
  }
  
  DefenseState.hard_pause_until = null;
  
  if (losses >= DEFENSE_CONFIG.CONSECUTIVE_LOSSES_EXTREME) {
    DefenseState.defense_mode_active = true;
    DefenseState.trend_reset_required = true;
    DefenseState.hard_pause_until = now + (DEFENSE_CONFIG.HARD_PAUSE_MINUTES_60 * 60000);
    return {
      mode: "EXTREME",
      blocked: true,
      remaining_minutes: DEFENSE_CONFIG.HARD_PAUSE_MINUTES_60,
      reason: `${losses} consecutive losses - 60min hard pause + trend reset required`,
      trend_reset_required: true
    };
  }
  
  if (losses >= DEFENSE_CONFIG.CONSECUTIVE_LOSSES_HARD_PAUSE) {
    DefenseState.defense_mode_active = true;
    DefenseState.trend_reset_required = false;
    DefenseState.hard_pause_until = now + (DEFENSE_CONFIG.HARD_PAUSE_MINUTES_30 * 60000);
    return {
      mode: "HARD_PAUSE",
      blocked: true,
      remaining_minutes: DEFENSE_CONFIG.HARD_PAUSE_MINUTES_30,
      reason: `${losses} consecutive losses - 30min hard pause`
    };
  }
  
  if (losses >= DEFENSE_CONFIG.CONSECUTIVE_LOSSES_DEFENSE) {
    DefenseState.defense_mode_active = true;
    return {
      mode: "DEFENSE",
      blocked: false,
      min_score: DEFENSE_CONFIG.MIN_SCORE_DEFENSE,
      position_size: DEFENSE_CONFIG.POSITION_SIZE_DEFENSE,
      scalp_blocked: DEFENSE_CONFIG.SCALP_BLOCK_IN_DEFENSE,
      reason: `${losses} consecutive losses - Defense Mode ACTIVE`
    };
  }
  
  DefenseState.defense_mode_active = false;
  DefenseState.trend_reset_required = false;
  
  return {
    mode: "NORMAL",
    blocked: false,
    reason: "Normal operation"
  };
}

function getDefenseStatus() {
  const defense = checkDefenseMode();
  return {
    ...defense,
    consecutive_losses: ExpectancyState.consecutiveLosses,
    defense_mode_active: DefenseState.defense_mode_active,
    trend_reset_required: DefenseState.trend_reset_required
  };
}

function resetDefenseState() {
  DefenseState = {
    consecutive_losses: 0,
    defense_mode_active: false,
    hard_pause_until: null,
    trend_reset_required: false
  };
}

// ═══════════════════════════════════════════════════════════════
// AI TRADE CLASSIFIER (SCALP vs TREND)
// ═══════════════════════════════════════════════════════════════

const SCALP_TREND_CONFIG = {
  EMA_GAP_SCALP: 0.20,
  ATR_SCALP: 0.18,
  VOLUME_SCALP_MIN: 1.3,
  SCALP_TARGET_MIN: 0.30,
  SCALP_TARGET_MAX: 0.60,
  TREND_TARGET_MIN: 1.00,
  TREND_TARGET_MAX: 2.50,
  SCALP_COOLDOWN_MINUTES: 30
};

function classifyMarketMode(emaGap, atrPct, breakout, volumeRatio) {
  const isScalpConditions = 
    emaGap < SCALP_TREND_CONFIG.EMA_GAP_SCALP &&
    atrPct < SCALP_TREND_CONFIG.ATR_SCALP &&
    !breakout;
  
  const isTrendConditions =
    emaGap >= SCALP_TREND_CONFIG.EMA_GAP_SCALP &&
    atrPct >= SCALP_TREND_CONFIG.ATR_SCALP &&
    breakout;
  
  let mode = "TRANSITION";
  
  if (isScalpConditions) {
    mode = "SCALP";
  } else if (isTrendConditions) {
    mode = "TREND";
  }
  
  const scalpVolumeOK = volumeRatio >= SCALP_TREND_CONFIG.VOLUME_SCALP_MIN;
  
  return {
    mode,
    scalpVolumeOK,
    reasons: [
      `EMA gap ${emaGap.toFixed(3)}% ${emaGap < SCALP_TREND_CONFIG.EMA_GAP_SCALP ? '<' : '≥'} ${SCALP_TREND_CONFIG.EMA_GAP_SCALP}%`,
      `ATR ${atrPct.toFixed(3)}% ${atrPct < SCALP_TREND_CONFIG.ATR_SCALP ? '<' : '≥'} ${SCALP_TREND_CONFIG.ATR_SCALP}%`,
      `Breakout: ${breakout}`,
      `Volume: ${volumeRatio.toFixed(2)}x ${scalpVolumeOK ? 'OK' : 'low'}`
    ]
  };
}

function getTradeTargets(mode) {
  if (mode === "SCALP") {
    return {
      target_min: SCALP_TREND_CONFIG.SCALP_TARGET_MIN,
      target_max: SCALP_TREND_CONFIG.SCALP_TARGET_MAX,
      type: "TIGHT"
    };
  }
  return {
    target_min: SCALP_TREND_CONFIG.TREND_TARGET_MIN,
    target_max: SCALP_TREND_CONFIG.TREND_TARGET_MAX,
    type: "NORMAL"
  };
}

// ═══════════════════════════════════════════════════════════════
// SESSION FILTER (Anti-Asia Chop)
// ═══════════════════════════════════════════════════════════════

const SESSION_CONFIG = {
  ASIA_START: 0,
  ASIA_END: 7,
  LONDON_START: 7,
  LONDON_END: 13,
  NY_START: 13,
  NY_END: 22,
  DEAD_ZONE_START: 22,
  DEAD_ZONE_END: 0,
  ASIA_VOLUME_MULTIPLIER: 1.5,
  DEAD_ZONE_WHALE_THRESHOLD: 50
};

function getCurrentSession() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  
  if (utcHour >= SESSION_CONFIG.ASIA_START && utcHour < SESSION_CONFIG.ASIA_END) {
    return "ASIA";
  }
  if (utcHour >= SESSION_CONFIG.LONDON_START && utcHour < SESSION_CONFIG.LONDON_END) {
    return "LONDON";
  }
  if (utcHour >= SESSION_CONFIG.NY_START && utcHour < SESSION_CONFIG.NY_END) {
    return "NY";
  }
  return "DEAD_ZONE";
}

function checkSessionFilter(mode, trendStrength, volumeRatio, breakout, whaleScore) {
  const session = getCurrentSession();
  
  if (session === "ASIA") {
    return {
      valid: false,
      session,
      mode: "SKIPPED",
      reason: "ASIA SESSION: SKIPPED - No trading during Asia session",
      blocked: true
    };
  }
  
  if (session === "DEAD_ZONE") {
    const whaleOK = whaleScore >= SESSION_CONFIG.DEAD_ZONE_WHALE_THRESHOLD;
    const breakoutOK = breakout;
    
    if (!whaleOK && !breakoutOK) {
      return {
        valid: false,
        session,
        mode: "LOW_LIQUIDITY",
        reason: `DEAD ZONE (${session}): BLOCKED - Low liquidity unless whale (${whaleOK}) or breakout (${breakoutOK})`,
        blocked: true
      };
    }
    
    return {
      valid: true,
      session,
      mode: "LOW_LIQUIDITY",
      reason: `DEAD ZONE: Allowed - Whale detected (${whaleOK})`
    };
  }
  
  return {
    valid: true,
    session,
    mode: "NORMAL",
    reason: `${session} SESSION: Normal mode`
  };
}

// ═══════════════════════════════════════════════════════════════
// WHALE TRAP DETECTION
// ═══════════════════════════════════════════════════════════════

const TRAP_CONFIG = {
  WICK_RATIO_TRAP: 0.60,
  REVERSAL_CONFIRMATION: true
};

function detectWhaleTrap(klines, trend) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  
  const volumes = klines.map(k => k.volume);
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;
  
  const wickRatio = range > 0 ? Math.max(upperWick, lowerWick) / range : 0;
  const wickDominant = wickRatio >= TRAP_CONFIG.WICK_RATIO_TRAP;
  
  let trapType = null;
  let trapValid = false;
  const reasons = [];
  
  if (trend === "BULLISH") {
    const brokeHigh = candle.close > prevCandle.high;
    const longUpperWick = upperWick > lowerWick && upperWick > body * 0.5;
    const volumeSpikeNoContinue = volumeRatio >= 1.3 && candle.close < candle.open;
    
    if (brokeHigh && longUpperWick) {
      trapType = "LONG_TRAP";
      trapValid = true;
      reasons.push("Broke high but long upper wick - fake breakout");
    }
    
    if (volumeSpikeNoContinue) {
      trapType = "LONG_TRAP";
      trapValid = true;
      reasons.push("Volume spike but rejection - likely trap");
    }
  } else if (trend === "BEARISH") {
    const brokeLow = candle.close < prevCandle.low;
    const longLowerWick = lowerWick > upperWick && lowerWick > body * 0.5;
    const volumeSpikeNoContinue = volumeRatio >= 1.3 && candle.close > candle.open;
    
    if (brokeLow && longLowerWick) {
      trapType = "SHORT_TRAP";
      trapValid = true;
      reasons.push("Broke low but long lower wick - fake breakout");
    }
    
    if (volumeSpikeNoContinue) {
      trapType = "SHORT_TRAP";
      trapValid = true;
      reasons.push("Volume spike but rejection - likely trap");
    }
  }
  
  const reversal = TRAP_CONFIG.REVERSAL_CONFIRMATION &&
    prevCandle.close < prevCandle.open && candle.close > candle.open ||
    prevCandle.close > prevCandle.open && candle.close < candle.open;
  
  if (wickDominant && reversal) {
    trapType = trapType || "REVERSAL_TRAP";
    trapValid = true;
    reasons.push("Wick dominant + immediate reversal");
  }
  
  return {
    trapDetected: trapValid,
    trapType,
    wickRatio,
    wickDominant,
    reversal,
    reasons,
    blockTrade: trapValid
  };
}

function getTrapStatus() {
  return {
    config: TRAP_CONFIG,
    currentSession: getCurrentSession()
  };
}

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

// ═══════════════════════════════════════════════════════════════
// HTF TREND FILTER - Higher Timeframe Trend Detection
// ═══════════════════════════════════════════════════════════════

async function getHTFTrend() {
  try {
    const htfKlines = await fetchKlines(SYMBOL, HTF_CONFIG.TIMEFRAME, 100);
    if (!htfKlines || htfKlines.length < HTF_CONFIG.EMA_PERIOD) {
      return { trend: "UNKNOWN", confidence: 0, reasons: ["Insufficient HTF data"] };
    }
    
    const closes = htfKlines.map(k => k.close);
    const htfEma = calculateEMA(closes, HTF_CONFIG.EMA_PERIOD);
    const currentPrice = closes[closes.length - 1];
    
    const htfGap = htfEma > 0 ? Math.abs((currentPrice - htfEma) / htfEma * 100) : 0;
    
    let htfTrend = "NEUTRAL";
    let confidence = 0.5;
    let reasons = [];
    
    if (currentPrice > htfEma && htfGap > 0.1) {
      htfTrend = "BULLISH";
      confidence = Math.min(0.9, 0.6 + htfGap * 0.5);
      reasons = [`HTF ${HTF_CONFIG.TIMEFRAME} above EMA${HTF_CONFIG.EMA_PERIOD}`, `Gap: ${htfGap.toFixed(2)}%`];
    } else if (currentPrice < htfEma && htfGap > 0.1) {
      htfTrend = "BEARISH";
      confidence = Math.min(0.9, 0.6 + htfGap * 0.5);
      reasons = [`HTF ${HTF_CONFIG.TIMEFRAME} below EMA${HTF_CONFIG.EMA_PERIOD}`, `Gap: ${htfGap.toFixed(2)}%`];
    } else {
      reasons = ["HTF trend NEUTRAL - EMA flat"];
    }
    
    return {
      trend: htfTrend,
      confidence,
      reasons,
      ema: htfEma,
      gap: htfGap,
      timeframe: HTF_CONFIG.TIMEFRAME
    };
  } catch (error) {
    return { trend: "UNKNOWN", confidence: 0, reasons: [error.message] };
  }
}

function checkHTFTrendFilter(htfTrend, tradeDirection, whaleScore) {
  if (htfTrend.trend === "UNKNOWN" || htfTrend.trend === "NEUTRAL") {
    return { valid: true, reason: "HTF neutral - proceed normally" };
  }
  
  const counterTrend = (htfTrend.trend === "BEARISH" && tradeDirection === "LONG") ||
                       (htfTrend.trend === "BULLISH" && tradeDirection === "SHORT");
  
  if (!counterTrend) {
    return { valid: true, reason: `HTF ${htfTrend.trend} aligned with ${tradeDirection}` };
  }
  
  let allowCounter = false;
  let reason = "";
  
  if (ANTI_COUNTER_CONFIG.ALLOW_COUNTER_IF_WHALE && whaleScore >= ANTI_COUNTER_CONFIG.WHALE_SCORE_THRESHOLD) {
    allowCounter = true;
    reason = `Whale reversal confirmed (score: ${whaleScore})`;
  }
  
  if (!allowCounter && ANTI_COUNTER_CONFIG.ALLOW_COUNTER_IF_STRUCTURE_BREAK) {
    allowCounter = true;
    reason = "Strong structure break detected";
  }
  
  if (!allowCounter) {
    return {
      valid: false,
      reason: `HTF ${htfTrend.trend} - BLOCK counter-trend ${tradeDirection}`,
      blocked: true
    };
  }
  
  return { valid: true, reason: `Counter-trend allowed: ${reason}`, warning: true };
}

// ═══════════════════════════════════════════════════════════════
// CONTINUATION ENTRY VALIDATION
// ═══════════════════════════════════════════════════════════════

function checkContinuationEntry(klines, trend, volumeRatio, indicators) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyPercent = range > 0 ? body / range : 0;
  
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  
  const pullback = Math.abs(candle.close - prevCandle.close) / prevCandle.close * 100;
  
  const volumeOK = volumeRatio >= CONTINUATION_CONFIG.VOLUME_MIN;
  const bodyOK = bodyPercent >= CONTINUATION_CONFIG.BODY_PERCENT_MIN;
  const pullbackOK = pullback <= CONTINUATION_CONFIG.PULLBACK_MAX;
  
  const reasons = [];
  
  if (trend === "LONG") {
    const brokeHigh = candle.close > prevCandle.high;
    const strongClose = candle.close > candle.open && bodyPercent >= CONTINUATION_CONFIG.BODY_PERCENT_MIN;
    
    reasons.push(`Break high: ${brokeHigh}`, `Body: ${(bodyPercent * 100).toFixed(1)}% ${bodyOK ? 'OK' : '<' + CONTINUATION_CONFIG.BODY_PERCENT_MIN * 100 + '%'}`, `Pullback: ${pullback.toFixed(3)}% ${pullbackOK ? 'OK' : '>' + CONTINUATION_CONFIG.PULLBACK_MAX + '%'}`, `Volume: ${volumeRatio.toFixed(2)}x ${volumeOK ? 'OK' : '<' + CONTINUATION_CONFIG.VOLUME_MIN}`);
    
    const valid = brokeHigh && strongClose && bodyOK && pullbackOK && volumeOK;
    
    if (!valid) {
      if (!brokeHigh) reasons.push("NOT continuation - did not break high");
      if (!strongClose) reasons.push("Weak close - not strong bullish");
      if (!bodyOK) reasons.push(`Body ${(bodyPercent * 100).toFixed(1)}% < ${CONTINUATION_CONFIG.BODY_PERCENT_MIN * 100}%`);
      if (!pullbackOK) reasons.push(`Pullback ${pullback.toFixed(3)}% > ${CONTINUATION_CONFIG.PULLBACK_MAX}%`);
      if (!volumeOK) reasons.push(`Volume ${volumeRatio.toFixed(2)}x < ${CONTINUATION_CONFIG.VOLUME_MIN}x`);
    }
    
    return { valid, reasons, bodyPercent, pullback, brokeHigh, strongClose };
  }
  
  if (trend === "SHORT") {
    const brokeLow = candle.close < prevCandle.low;
    const strongClose = candle.close < candle.open && bodyPercent >= CONTINUATION_CONFIG.BODY_PERCENT_MIN;
    
    reasons.push(`Break low: ${brokeLow}`, `Body: ${(bodyPercent * 100).toFixed(1)}% ${bodyOK ? 'OK' : '<' + CONTINUATION_CONFIG.BODY_PERCENT_MIN * 100 + '%'}`, `Pullback: ${pullback.toFixed(3)}% ${pullbackOK ? 'OK' : '>' + CONTINUATION_CONFIG.PULLBACK_MAX + '%'}`, `Volume: ${volumeRatio.toFixed(2)}x ${volumeOK ? 'OK' : '<' + CONTINUATION_CONFIG.VOLUME_MIN}`);
    
    const valid = brokeLow && strongClose && bodyOK && pullbackOK && volumeOK;
    
    if (!valid) {
      if (!brokeLow) reasons.push("NOT continuation - did not break low");
      if (!strongClose) reasons.push("Weak close - not strong bearish");
      if (!bodyOK) reasons.push(`Body ${(bodyPercent * 100).toFixed(1)}% < ${CONTINUATION_CONFIG.BODY_PERCENT_MIN * 100}%`);
      if (!pullbackOK) reasons.push(`Pullback ${pullback.toFixed(3)}% > ${CONTINUATION_CONFIG.PULLBACK_MAX}%`);
      if (!volumeOK) reasons.push(`Volume ${volumeRatio.toFixed(2)}x < ${CONTINUATION_CONFIG.VOLUME_MIN}x`);
    }
    
    return { valid, reasons, bodyPercent, pullback, brokeLow, strongClose };
  }
  
  return { valid: false, reasons: ["Unknown trend"] };
}

// ═══════════════════════════════════════════════════════════════
// EARLY EXIT PROTECTION - Quick Loss Cut
// ═══════════════════════════════════════════════════════════════

function initEarlyExit(entryPrice, side) {
  EarlyExitState = {
    entryPrice,
    entryTime: Date.now(),
    side,
    maxFavorableMove: 0,
    initialLossDetected: false
  };
  return EarlyExitState;
}

function checkEarlyExit(currentPrice) {
  if (!EarlyExitState.entryPrice || !EarlyExitState.entryTime) {
    return { shouldExit: false, reason: "No active entry tracking" };
  }
  
  const elapsed = Date.now() - EarlyExitState.entryTime;
  if (elapsed > EARLY_EXIT_CONFIG.MONITOR_WINDOW_MS) {
    return { shouldExit: false, reason: "Window passed" };
  }
  
  const pnl = EarlyExitState.side === "LONG"
    ? ((currentPrice - EarlyExitState.entryPrice) / EarlyExitState.entryPrice * 100)
    : ((EarlyExitState.entryPrice - currentPrice) / EarlyExitState.entryPrice * 100);
  
  const pnlBps = pnl * 100;
  
  if (pnlBps < 0) {
    EarlyExitState.initialLossDetected = true;
  }
  
  if (pnl > EarlyExitState.maxFavorableMove) {
    EarlyExitState.maxFavorableMove = pnl;
    if (EARLY_EXIT_CONFIG.TRAILING_RESET && EarlyExitState.initialLossDetected) {
      EarlyExitState.initialLossDetected = false;
    }
  }
  
  if (EarlyExitState.initialLossDetected && pnlBps <= -EARLY_EXIT_CONFIG.MAX_LOSS_BPS) {
    return {
      shouldExit: true,
      reason: `Early exit: ${pnl.toFixed(3)}% loss within ${(elapsed / 1000).toFixed(0)}s`,
      pnl,
      elapsedMs: elapsed
    };
  }
  
  return {
    shouldExit: false,
    reason: `Monitoring: ${pnl.toFixed(3)}% at ${(elapsed / 1000).toFixed(0)}s`,
    pnl,
    elapsedMs: elapsed,
    maxFavorable: EarlyExitState.maxFavorableMove
  };
}

function getEarlyExitStatus() {
  return { ...EarlyExitState };
}

function resetEarlyExit() {
  EarlyExitState = {
    entryPrice: null,
    entryTime: null,
    side: null,
    maxFavorableMove: 0,
    initialLossDetected: false
  };
}

// ═══════════════════════════════════════════════════════════════
// 🎯 ENTRY TIMING ENGINE (CRITICAL)
// ═══════════════════════════════════════════════════════════════

const ENTRY_TIMING_CONFIG = {
  CANDLE_BODY_MIN: 0.60,           // Body ≥ 60% of range
  CANDLE_SIZE_MULTIPLIER: 1.3,     // OR size ≥ 1.3x previous candle
  MICRO_NOISE_THRESHOLD: 0.15,      // Block if last 3 candles < 0.15%
  MIN_MOMENTUM_MOVE: 0.25,          // Price move ≥ 0.25% BEFORE entry
  ANTI_REENTRY_MINUTES: 3,         // No re-entry if last trade < 3 min
  OVERTRADE_WINDOW_MINUTES: 5,      // 2 trades in 5 min = cooldown
  OVERTRADE_COOLDOWN_MINUTES: 10,  // Force cooldown 10 min
  FAKE_WICK_RATIO: 1.0             // Wick > body = fake
};

let EntryTimingState = {
  lastTradeTime: null,
  recentTradeTimes: [],
  lastEntryPrice: null
};

function checkCandleExpansion(klines) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyPercent = range > 0 ? body / range : 0;
  
  const prevRange = prevCandle.high - prevCandle.low;
  const prevBody = Math.abs(prevCandle.close - prevCandle.open);
  const sizeRatio = prevBody > 0 ? body / prevBody : 0;
  
  const passesBody = bodyPercent >= ENTRY_TIMING_CONFIG.CANDLE_BODY_MIN;
  const passesSize = sizeRatio >= ENTRY_TIMING_CONFIG.CANDLE_SIZE_MULTIPLIER;
  
  return {
    valid: passesBody || passesSize,
    bodyPercent,
    sizeRatio,
    passesBody,
    passesSize,
    reasons: [
      `body ${(bodyPercent * 100).toFixed(1)}% ${passesBody ? '≥' : '<'} ${ENTRY_TIMING_CONFIG.CANDLE_BODY_MIN * 100}%`,
      `size ratio ${sizeRatio.toFixed(2)}x ${passesSize ? '≥' : '<'} ${ENTRY_TIMING_CONFIG.CANDLE_SIZE_MULTIPLIER}x`
    ]
  };
}

function checkBreakoutConfirmation(klines, trend) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  const bodyPercent = range > 0 ? body / range : 0;
  
  const wickDominant = upperWick > body || lowerWick > body;
  
  let valid = false;
  let reasons = [];
  
  if (trend === "LONG") {
    const closeAbovePrevHigh = candle.close > prevCandle.high;
    const notJustWick = !wickDominant || candle.close > prevCandle.open;
    
    valid = closeAbovePrevHigh && (notJustWick || bodyPercent > 0.5);
    reasons = [
      `close ${closeAbovePrevHigh ? '>' : '≤'} prev high: ${closeAbovePrevHigh}`,
      `not just wick: ${notJustWick}`
    ];
  } else if (trend === "SHORT") {
    const closeBelowPrevLow = candle.close < prevCandle.low;
    const notJustWick = !wickDominant || candle.close < prevCandle.open;
    
    valid = closeBelowPrevLow && (notJustWick || bodyPercent > 0.5);
    reasons = [
      `close ${closeBelowPrevLow ? '<' : '≥'} prev low: ${closeBelowPrevLow}`,
      `not just wick: ${notJustWick}`
    ];
  }
  
  return { valid, reasons };
}

function checkMicroNoise(klines) {
  const last3 = klines.slice(-3);
  const currentPrice = klines[klines.length - 1].close;
  
  const moves = last3.map((c, i) => {
    if (i === 0) return Math.abs(c.close - c.open) / c.open * 100;
    return Math.abs(c.close - last3[i-1].close) / last3[i-1].close * 100;
  });
  
  const avgMove = moves.reduce((a, b) => a + b, 0) / moves.length;
  const maxMove = Math.max(...moves);
  
  const isSideways = maxMove < ENTRY_TIMING_CONFIG.MICRO_NOISE_THRESHOLD;
  
  return {
    valid: !isSideways,
    avgMove,
    maxMove,
    reasons: [`avg move ${avgMove.toFixed(3)}%, max ${maxMove.toFixed(3)}%, threshold ${ENTRY_TIMING_CONFIG.MICRO_NOISE_THRESHOLD}%`]
  };
}

function checkMinimumMomentum(klines, trend) {
  const candle = klines[klines.length - 1];
  const prevCandle = klines[klines.length - 2];
  
  let move = 0;
  if (trend === "LONG") {
    move = ((candle.close - prevCandle.close) / prevCandle.close) * 100;
  } else if (trend === "SHORT") {
    move = ((prevCandle.close - candle.close) / prevCandle.close) * 100;
  }
  
  const valid = move >= ENTRY_TIMING_CONFIG.MIN_MOMENTUM_MOVE;
  
  return {
    valid,
    momentum: move,
    threshold: ENTRY_TIMING_CONFIG.MIN_MOMENTUM_MOVE,
    reasons: [`momentum ${move.toFixed(3)}% ${valid ? '≥' : '<'} ${ENTRY_TIMING_CONFIG.MIN_MOMENTUM_MOVE}%`]
  };
}

function checkAntiReentry() {
  if (!EntryTimingState.lastTradeTime) return { valid: true, reason: "no previous trade" };
  
  const minutesSince = (Date.now() - EntryTimingState.lastTradeTime) / (1000 * 60);
  const valid = minutesSince >= ENTRY_TIMING_CONFIG.ANTI_REENTRY_MINUTES;
  
  return {
    valid,
    minutesSince: Math.round(minutesSince * 10) / 10,
    threshold: ENTRY_TIMING_CONFIG.ANTI_REENTRY_MINUTES,
    reason: valid ? `OK (${Math.round(minutesSince)} min since last trade)` : `BLOCK: last trade ${minutesSince.toFixed(1)} min ago`
  };
}

function checkOvertrading() {
  const now = Date.now();
  const windowMs = ENTRY_TIMING_CONFIG.OVERTRADE_WINDOW_MINUTES * 60 * 1000;
  
  EntryTimingState.recentTradeTimes = EntryTimingState.recentTradeTimes.filter(t => now - t < windowMs);
  
  const tradesInWindow = EntryTimingState.recentTradeTimes.length;
  
  if (tradesInWindow >= 2) {
    return {
      valid: false,
      tradesInWindow,
      cooldownMinutes: ENTRY_TIMING_CONFIG.OVERTRADE_COOLDOWN_MINUTES,
      reason: `BLOCK: ${tradesInWindow} trades in ${ENTRY_TIMING_CONFIG.OVERTRADE_WINDOW_MINUTES} min - force cooldown`
    };
  }
  
  return {
    valid: true,
    tradesInWindow,
    reason: `${tradesInWindow} trade(s) in window - OK`
  };
}

function checkFakeBreakout(klines, whale) {
  const candle = klines[klines.length - 1];
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  
  const wickToBody = body > 0 ? Math.max(upperWick, lowerWick) / body : 999;
  const wickDominant = Math.max(upperWick, lowerWick) > body;
  
  const volumeNoFollow = whale.volumeSpike && wickDominant;
  
  let valid = true;
  const reasons = [];
  
  if (wickDominant && wickToBody >= ENTRY_TIMING_CONFIG.FAKE_WICK_RATIO) {
    valid = false;
    reasons.push(`wick > body (${wickToBody.toFixed(2)}x)`);
  }
  
  if (volumeNoFollow) {
    valid = false;
    reasons.push("volume spike but no follow-through");
  }
  
  const prevCandle = klines[klines.length - 2];
  const rejectionCandle = (candle.close < candle.open && prevCandle.close > prevCandle.open) ||
                        (candle.close > candle.open && prevCandle.close < prevCandle.open);
  
  if (rejectionCandle && Math.abs(candle.close - candle.open) < body * 0.5) {
    valid = false;
    reasons.push("immediate rejection candle");
  }
  
  return {
    valid,
    reasons
  };
}

function applyEntryTimingEngine(klines, trend, whale, lastTrade) {
  const checks = {
    candleExpansion: checkCandleExpansion(klines),
    breakoutConfirmation: checkBreakoutConfirmation(klines, trend),
    microNoise: checkMicroNoise(klines),
    momentum: checkMinimumMomentum(klines, trend),
    antiReentry: checkAntiReentry(),
    overtrading: checkOvertrading(),
    fakeBreakout: checkFakeBreakout(klines, whale)
  };
  
  const allValid = 
    checks.candleExpansion.valid &&
    checks.breakoutConfirmation.valid &&
    checks.microNoise.valid &&
    checks.momentum.valid &&
    checks.antiReentry.valid &&
    checks.overtrading.valid &&
    checks.fakeBreakout.valid;
  
  const failedChecks = Object.entries(checks)
    .filter(([_, v]) => !v.valid)
    .map(([k, v]) => ({ check: k, ...v }));
  
  let primaryFailure = "ENTRY TIMING FAILED";
  if (failedChecks.length > 0) {
    primaryFailure = failedChecks[0].reason || failedChecks[0].check;
  }
  
  return {
    timing_valid: allValid,
    allChecks: checks,
    failedChecks,
    primaryFailure,
    reasons: {
      candleExpansion: checks.candleExpansion.reasons,
      breakout: checks.breakoutConfirmation.reasons,
      microNoise: checks.microNoise.reasons,
      momentum: checks.momentum.reasons,
      antiReentry: [checks.antiReentry.reason],
      overtrading: [checks.overtrading.reason],
      fakeBreakout: checks.fakeBreakout.reasons
    }
  };
}

function recordTimingTrade() {
  const now = Date.now();
  EntryTimingState.lastTradeTime = now;
  EntryTimingState.recentTradeTimes.push(now);
  EntryTimingState.lastEntryPrice = null;
}

function getEntryTimingStatus() {
  return {
    lastTradeAgo: EntryTimingState.lastTradeTime 
      ? Math.round((Date.now() - EntryTimingState.lastTradeTime) / 60000)
      : null,
    recentTradesCount: EntryTimingState.recentTradeTimes.length,
    config: ENTRY_TIMING_CONFIG
  };
}

function resetEntryTiming() {
  EntryTimingState = {
    lastTradeTime: null,
    recentTradeTimes: [],
    lastEntryPrice: null
  };
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

async function analyzeBTC(lastTrade = null, defenseMode = false, prefetchedKlines = null) { // FIX: accept pre-fetched klines (PERF-1)
  try {
    const klines = prefetchedKlines || await fetchKlines(SYMBOL, TIMEFRAME, KLINE_LIMIT); // FIX: skip fetch if klines provided (PERF-1)
    
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
    
    const signals = [];
    
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
    
    // ─── 📈 HTF TREND FILTER ─────────────────────────────────
    let htfTrend = { trend: "UNKNOWN", confidence: 0.5, reasons: ["HTF check deferred for performance"] };
    if (!prefetchedKlines || !prefetchedKlines.htf) {
      htfTrend = await getHTFTrend();
    } else {
      const htfCloses = prefetchedKlines.htf.map(k => k.close);
      const htfEma = calculateEMA(htfCloses, HTF_CONFIG.EMA_PERIOD);
      const htfPrice = htfCloses[htfCloses.length - 1];
      const htfGap = htfEma > 0 ? Math.abs((htfPrice - htfEma) / htfEma * 100) : 0;
      htfTrend = {
        trend: htfPrice > htfEma && htfGap > 0.1 ? "BULLISH" : (htfPrice < htfEma && htfGap > 0.1 ? "BEARISH" : "NEUTRAL"),
        confidence: Math.min(0.9, 0.6 + htfGap * 0.5),
        reasons: [`HTF ${HTF_CONFIG.TIMEFRAME} ${htfGap > 0.1 ? (htfPrice > htfEma ? "above" : "below") : "near"} EMA${HTF_CONFIG.EMA_PERIOD}`],
        ema: htfEma,
        gap: htfGap
      };
    }
    
    // ─── 🛡️ DEFENSE MODE CHECK (First Priority) ───────────────
    const defenseCheck = checkDefenseMode();

    // FIX: check defense mode before rule engine — lossStreakPause guard (BUG-8)
    if (defenseCheck.blocked) {
      return {
        signal: "HOLD",
        action: "HOLD",
        confidence: 0,
        reason: defenseCheck.reason,
        lossStreakPause: true,     // FIX: was missing — caused guard to always be falsy (BUG-8)
        defense: defenseCheck
      };
    }

    if (defenseCheck.blocked && defenseCheck.mode === "HARD_PAUSE") {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend,
        trend_strength: trendStrength,
        reason: `DEFENSE MODE: ${defenseCheck.reason}`,
        indicators: { rsi, atrPct: atrPct?.toFixed(3), volumeRatio: volumeRatio?.toFixed(2) },
        signal: "DEFENSE_BLOCKED",
        market_phase: marketPhase,
        mode: "SCALP",
        session: getCurrentSession(),
        defense: {
          defense_mode: true,
          mode: defenseCheck.mode,
          cooldown_active: true,
          loss_streak: ExpectancyState.consecutiveLosses,
          remaining_minutes: defenseCheck.remaining_minutes
        },
        lossStreakPause: true, // FIX: added for type consistency (BUG-8)
        whale: { score: whale.score, signals: whale.signals },
        expectancy: getExpectancyForDecision(),
        mlWeights: getMLWeights(),
        selfLearn: getSelfLearnStatus(),
        filters: {
          timing_valid: false,
          session_valid: false,
          trap_detected: false
        },
        timestamp: Date.now()
      };
    }
    
    // ─── 🧠 AI TRADE CLASSIFIER (SCALP vs TREND) ──────────────
    const marketMode = classifyMarketMode(emaGap, atrPct, breakout.valid, volumeRatio);
    
    if (marketMode.mode === "SCALP" && defenseCheck.defense_mode_active && DEFENSE_CONFIG.SCALP_BLOCK_IN_DEFENSE) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend,
        trend_strength: trendStrength,
        reason: `DEFENSE: SCALP blocked in Defense Mode`,
        indicators: { rsi, atrPct: atrPct?.toFixed(3), volumeRatio: volumeRatio?.toFixed(2) },
        signal: "SCALP_BLOCKED_DEFENSE",
        market_phase: marketPhase,
        mode: marketMode.mode,
        session: getCurrentSession(),
        defense: {
          defense_mode: true,
          mode: defenseCheck.mode,
          cooldown_active: false,
          loss_streak: ExpectancyState.consecutiveLosses
        },
        whale: { score: whale.score, signals: whale.signals },
        expectancy: getExpectancyForDecision(),
        mlWeights: getMLWeights(),
        selfLearn: getSelfLearnStatus(),
        filters: {
          timing_valid: false,
          session_valid: false,
          trap_detected: false
        },
        timestamp: Date.now()
      };
    }
    
    // ─── 🐋 WHALE TRAP DETECTION ───────────────────────────────
    const trapDetection = detectWhaleTrap(klines, trend);
    
    if (trapDetection.blockTrade) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend,
        trend_strength: trendStrength,
        reason: `WHALE TRAP: ${trapDetection.reasons.join(", ")}`,
        indicators: { rsi, atrPct: atrPct?.toFixed(3), volumeRatio: volumeRatio?.toFixed(2) },
        signal: "TRAP_DETECTED",
        market_phase: marketPhase,
        mode: marketMode.mode,
        session: getCurrentSession(),
        defense: {
          defense_mode: defenseCheck.defense_mode_active,
          mode: defenseCheck.mode,
          cooldown_active: false,
          loss_streak: ExpectancyState.consecutiveLosses
        },
        whale: { score: whale.score, signals: whale.signals },
        trap: trapDetection,
        expectancy: getExpectancyForDecision(),
        mlWeights: getMLWeights(),
        selfLearn: getSelfLearnStatus(),
        filters: {
          timing_valid: false,
          session_valid: false,
          trap_detected: true
        },
        timestamp: Date.now()
      };
    }
    
    // ─── 🌏 SESSION FILTER ─────────────────────────────────────
    const sessionCheck = checkSessionFilter(marketMode.mode, trendStrength, volumeRatio, breakout.valid, whale.score);
    
    if (!sessionCheck.valid) {
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend,
        trend_strength: trendStrength,
        reason: sessionCheck.reason,
        indicators: { rsi, atrPct: atrPct?.toFixed(3), volumeRatio: volumeRatio?.toFixed(2) },
        signal: "SESSION_BLOCKED",
        market_phase: marketPhase,
        mode: marketMode.mode,
        session: sessionCheck.session,
        defense: {
          defense_mode: defenseCheck.defense_mode_active,
          mode: defenseCheck.mode,
          cooldown_active: false,
          loss_streak: ExpectancyState.consecutiveLosses
        },
        whale: { score: whale.score, signals: whale.signals },
        trap: trapDetection,
        expectancy: getExpectancyForDecision(),
        mlWeights: getMLWeights(),
        selfLearn: getSelfLearnStatus(),
        filters: {
          timing_valid: false,
          session_valid: false,
          trap_detected: trapDetection.blockTrade
        },
        timestamp: Date.now()
      };
    }
    
    // ─── 📈 HTF TREND FILTER ─────────────────────────────────────
    const htfFilterLong = checkHTFTrendFilter(htfTrend, "LONG", whale.score);
    const htfFilterShort = checkHTFTrendFilter(htfTrend, "SHORT", whale.score);
    
    const htfBlockingLong = !htfFilterLong.valid && trend === "BULLISH";
    const htfBlockingShort = !htfFilterShort.valid && trend === "BEARISH";
    
    if (htfBlockingLong || htfBlockingShort) {
      const blockedDir = htfBlockingLong ? "LONG" : "SHORT";
      const filterResult = htfBlockingLong ? htfFilterLong : htfFilterShort;
      return {
        symbol: SYMBOL,
        action: "HOLD",
        confidence: 0,
        trend,
        trend_strength: trendStrength,
        reason: `HTF FILTER: ${filterResult.reason}`,
        indicators: { rsi, atrPct: atrPct?.toFixed(3), volumeRatio: volumeRatio?.toFixed(2) },
        signal: "HTF_BLOCKED",
        market_phase: marketPhase,
        mode: marketMode.mode,
        session: sessionCheck.session,
        defense: {
          defense_mode: defenseCheck.defense_mode_active,
          mode: defenseCheck.mode,
          cooldown_active: false,
          loss_streak: ExpectancyState.consecutiveLosses
        },
        whale: { score: whale.score, signals: whale.signals },
        trap: trapDetection,
        htfTrend,
        filters: {
          timing_valid: false,
          session_valid: sessionCheck.valid,
          trap_detected: trapDetection.blockTrade,
          htf_valid: false
        },
        expectancy: getExpectancyForDecision(),
        mlWeights: getMLWeights(),
        selfLearn: getSelfLearnStatus(),
        timestamp: Date.now()
      };
    }
    
    // Apply defense mode score requirements
    let effectiveDefenseMode = defenseCheck.defense_mode_active;
    if (effectiveDefenseMode && defenseCheck.mode === "DEFENSE") {
      signals.push(`DEFENSE MODE: Min score ${DEFENSE_CONFIG.MIN_SCORE_DEFENSE}, Size ${DEFENSE_CONFIG.POSITION_SIZE_DEFENSE * 100}%`);
    }
    
    let priority = getPriority(trendStrength, breakout.valid, lastTrade?.win, effectiveDefenseMode);
    let action = "HOLD";
    let confidence = 0;
    let reason = "";
    let override = false;
    let positionMultiplier = 1.0;
    
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
    if (effectiveDefenseMode) {
      scoreRequired = Math.max(scoreRequired, DEFENSE_CONFIG.MIN_SCORE_DEFENSE);
      signals.push(`Defense mode: score raised to ${scoreRequired}`);
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
    // Apply ENTRY TIMING ENGINE first - even P1 must pass timing
    const timingCheck = applyEntryTimingEngine(klines, trend, whale, lastTrade);
    
    // ─── CONTINUATION ENTRY VALIDATION ─────────────────────────
    const continuationCheck = checkContinuationEntry(klines, trend, volumeRatio, { rsi, atrPct });
    
    // SCALP mode: require volume >= 1.3x
    const scalpVolumeOK = marketMode.mode !== "SCALP" || volumeRatio >= SCALP_TREND_CONFIG.VOLUME_SCALP_MIN;
    
    const fastEntryAllowed = 
      priority === "P1" && 
      trendStrength === "STRONG" && 
      breakout.valid && 
      volumeRatio >= VOLUME_FAST_ENTRY && 
      breakout.bodyPercent >= CANDLE_BODY_FAST_ENTRY &&
      scalpVolumeOK &&
      continuationCheck.valid;
    
    let entryReady = false;
    
    // If SCALP mode but no perfect entry, DO NOT TRADE
    if (marketMode.mode === "SCALP" && !scalpVolumeOK) {
      reason = `SCALP: Volume ${volumeRatio.toFixed(2)}x < ${SCALP_TREND_CONFIG.VOLUME_SCALP_MIN}x required`;
      signals.push(`SCALP BLOCKED: Low volume ${volumeRatio.toFixed(2)}x`);
    }
    
    // If not continuation entry, DO NOT TRADE (except P1 fast entry)
    if (!continuationCheck.valid && !fastEntryAllowed) {
      reason = `CONTINUATION FAILED: ${continuationCheck.reasons.join(", ")}`;
      signals.push(`CONTINUATION: ${continuationCheck.reasons.slice(0, 2).join(", ")}`);
    }
    
    if (trend === "BULLISH" && finalScore >= scoreRequired) {
      if (fastEntryAllowed && timingCheck.timing_valid) {
        action = "LONG";
        confidence = Math.min(90, finalConfidence * 100);
        reason = `FAST ENTRY P1: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
        signals.push("FAST ENTRY: P1 + STRONG breakout + timing valid");
        entryReady = true;
      } else if (breakout.valid) {
        const confirmation = checkConfirmation(klines, "LONG");
        if (confirmation.confirmed && timingCheck.timing_valid) {
          action = "LONG";
          confidence = Math.min(85, finalConfidence * 100 - 5);
          reason = `CONFIRMED ENTRY: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
          signals.push("Confirmation candle confirmed + timing valid");
          entryReady = true;
        } else if (!timingCheck.timing_valid) {
          reason = `ENTRY TIMING FAILED: ${timingCheck.primaryFailure}`;
          signals.push(`TIMING: ${timingCheck.primaryFailure}`);
        } else {
          reason = `Waiting confirmation: ${confirmation.reasons.join(", ")}`;
        }
      } else {
        reason = `No breakout: ${breakout.reasons.join(", ")}`;
      }
    } else if (trend === "BEARISH" && finalScore >= scoreRequired) {
      if (fastEntryAllowed && timingCheck.timing_valid) {
        action = "SHORT";
        confidence = Math.min(90, finalConfidence * 100);
        reason = `FAST ENTRY P1: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
        signals.push("FAST ENTRY: P1 + STRONG breakout + timing valid");
        entryReady = true;
      } else if (breakout.valid) {
        const confirmation = checkConfirmation(klines, "SHORT");
        if (confirmation.confirmed && timingCheck.timing_valid) {
          action = "SHORT";
          confidence = Math.min(85, finalConfidence * 100 - 5);
          reason = `CONFIRMED ENTRY: score=${finalScore.toFixed(0)} RSI=${rsi.toFixed(1)}`;
          signals.push("Confirmation candle confirmed + timing valid");
          entryReady = true;
        } else if (!timingCheck.timing_valid) {
          reason = `ENTRY TIMING FAILED: ${timingCheck.primaryFailure}`;
          signals.push(`TIMING: ${timingCheck.primaryFailure}`);
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
      positionMultiplier = calculatePositionSize(1.0, trendStrength, effectiveDefenseMode);
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
      mode: marketMode.mode,
      session: sessionCheck.session,
      confidence: Math.round(confidence),
      price: currentPrice,
      priceChange: priceChangePct,
      trend,
      trend_strength: trendStrength,
      market_phase: marketPhase,
      priority,
      reason: reason + " | " + signals.slice(0, 4).join(", "),
      protection: {
        defense_mode: effectiveDefenseMode,
        cooldown_active: defenseCheck.blocked || defenseCheck.cooldown_active,
        loss_streak: ExpectancyState.consecutiveLosses
      },
      filters: {
        timing_valid: timingCheck.timing_valid,
        session_valid: sessionCheck.valid,
        trap_detected: trapDetection.blockTrade,
        htf_valid: htfFilterLong.valid && htfFilterShort.valid,
        continuation_valid: continuationCheck.valid
      },
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
      trap: trapDetection,
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
        blocked: ruleResult.blocked,
        scalpVolumeOK: scalpVolumeOK
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
      timing_valid: timingCheck.timing_valid,
      timing: {
        candleExpansion: timingCheck.allChecks.candleExpansion,
        breakout: timingCheck.allChecks.breakoutConfirmation,
        microNoise: timingCheck.allChecks.microNoise,
        momentum: timingCheck.allChecks.momentum,
        antiReentry: timingCheck.allChecks.antiReentry,
        overtrading: timingCheck.allChecks.overtrading,
        fakeBreakout: timingCheck.allChecks.fakeBreakout
      },
      defense: {
        mode: defenseCheck.mode,
        status: defenseCheck,
        config: DEFENSE_CONFIG
      },
      htfTrend: htfTrend,
      htfFilter: {
        longAllowed: htfFilterLong.valid,
        shortAllowed: htfFilterShort.valid,
        reason: htfFilterLong.valid ? htfFilterLong.reason : htfFilterShort.reason
      },
      continuation: {
        valid: continuationCheck.valid,
        reasons: continuationCheck.reasons,
        bodyPercent: continuationCheck.bodyPercent,
        pullback: continuationCheck.pullback
      },
      earlyExit: getEarlyExitStatus(),
      marketMode: marketMode,
      sessionFilter: sessionCheck,
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
  
  // Record for Entry Timing
  recordTimingTrade();
  
  // Update ML Weights based on features
  if (features) {
    Object.entries(features).forEach(([feature, won]) => {
      updateMLWeights({ feature, result: won ? "WIN" : "LOSS" }, features);
    });
  }
}

async function quickAnalysis(_lossStreak = 0, prefetchedKlines = null) { // FIX: pass through pre-fetched klines (PERF-1)
  return analyzeBTC(null, false, prefetchedKlines);
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
  resetEntryTiming,
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
  getEntryTimingStatus,
  ENTRY_TIMING_CONFIG,
  WHALE_CONFIG,
  ML_WEIGHTS,
  // New exports
  DEFENSE_CONFIG,
  checkDefenseMode,
  getDefenseStatus,
  resetDefenseState,
  classifyMarketMode,
  getTradeTargets,
  SCALP_TREND_CONFIG,
  getCurrentSession,
  checkSessionFilter,
  SESSION_CONFIG,
  detectWhaleTrap,
  getTrapStatus,
  TRAP_CONFIG,
  // HTF + Continuation + Early Exit
  getHTFTrend,
  checkHTFTrendFilter,
  HTF_CONFIG,
  checkContinuationEntry,
  CONTINUATION_CONFIG,
  initEarlyExit,
  checkEarlyExit,
  getEarlyExitStatus,
  resetEarlyExit,
  EARLY_EXIT_CONFIG,
  ANTI_COUNTER_CONFIG
};
