/**
 * HYPE DETECTOR MODULE
 * Real hype detection for PEPE - filters false signals
 */

const MARKET_STATE = {
  NORMAL: 'NORMAL_MARKET',
  WATCHLIST: 'WATCHLIST',
  HYPE: 'HYPE_CONFIRMED'
};

// Cache for hype state
const hypeState = {
  currentState: MARKET_STATE.NORMAL,
  hypeScore: 0,
  conditionsPassed: 0,
  lastUpdate: 0,
  lockUntil: 0,
  reason: ''
};

/**
 * Calculate hype score and determine market state
 * @param {Object} pepeData - PEPE market data
 * @param {Object} btcData - BTC market data (for comparison)
 * @returns {Object} - { state, hypeScore, conditionsPassed, reason }
 */
async function analyzeHype(pepeData, btcData) {
  const conditions = [];
  const reasons = [];

  // 1. Volume Ratio ≥ 2.2x average
  const volRatio = pepeData.volumeRatio || 1;
  const volCondition = volRatio >= 2.2;
  conditions.push(volCondition);
  reasons.push(`Volume ${volRatio.toFixed(1)}x ${volCondition ? '✅' : '❌'}`);

  // 2. ATR expanding for 3 consecutive candles
  const atrCondition = pepeData.atrExpansion === true;
  conditions.push(atrCondition);
  reasons.push(`ATR Expanding ${atrCondition ? '✅' : '❌'}`);

  // 3. Price distance from EMA21 > 0.6%
  const priceDist = Math.abs(pepeData.priceDistanceFromEMA21 || 0);
  const emaCondition = priceDist > 0.6;
  conditions.push(emaCondition);
  reasons.push(`Price-EMA21 ${priceDist.toFixed(2)}% ${emaCondition ? '✅' : '❌'}`);

  // 4. RSI between 58-72 (not overbought)
  const rsi = pepeData.rsi || 50;
  const rsiCondition = rsi >= 58 && rsi <= 72;
  conditions.push(rsiCondition);
  reasons.push(`RSI ${rsi.toFixed(1)} ${rsiCondition ? '✅' : '❌'}`);

  // 5. BTC volatility LOW or sideways
  const btcCondition = btcData && (btcData.volatility < 0.5 || btcData.trend === 'SIDEWAYS');
  conditions.push(!!btcCondition);
  reasons.push(`BTC Low Vol ${btcCondition ? '✅' : '❌'}`);

  // 6. Candle body expansion increasing
  const candleCondition = pepeData.candleExpansion === true;
  conditions.push(candleCondition);
  reasons.push(`Candle Expansion ${candleCondition ? '✅' : '❌'}`);

  // 7. Funding rate increasing momentum (optional — often unavailable)
  const fundingCondition = pepeData.fundingMomentum > 0;
  // Only include funding as a condition if we have real data (non-zero)
  if (pepeData.fundingMomentum !== 0) {
    conditions.push(fundingCondition);
    reasons.push(`Funding Momentum ${fundingCondition ? '✅' : '❌'}`);
  } else {
    reasons.push(`Funding N/A ⏭️`);
  }

  const totalConditions = conditions.length; // may be 6 if funding skipped
  const conditionsPassed = conditions.filter(c => c).length;
  const hypeScore = Math.round((conditionsPassed / totalConditions) * 100);

  // Determine state: HYPE needs 4 out of active conditions (≥57%)
  let state = MARKET_STATE.NORMAL;
  if (hypeScore >= 57) state = MARKET_STATE.HYPE;
  else if (hypeScore >= 34) state = MARKET_STATE.WATCHLIST;

  // Anti-false trend filter - IMMEDIATELY cancel if any trigger
  const antiTriggers = [];

  if (rsi > 75) {
    antiTriggers.push('RSI overbought (>75)');
  }
  if (pepeData.bbUpperTouch === 2) {
    antiTriggers.push('BB Upper 2x touch');
  }
  if (volRatio > 2 && !atrCondition) {
    antiTriggers.push('Volume spike without ATR expansion');
  }
  if (pepeData.emaFlattening === true) {
    antiTriggers.push('EMA9/EMA21 flattening');
  }
  if (pepeData.atrPercent < 0.15) {
    antiTriggers.push('ATR too low (<0.15%)');
  }

  if (antiTriggers.length > 0) {
    state = MARKET_STATE.WATCHLIST;
    reasons.push(`FILTER: ${antiTriggers.join(', ')}`);
  }

  const result = {
    state,
    hypeScore,
    conditionsPassed,
    totalConditions,
    reasons: reasons.join(' | ')
  };

  return result;
}

/**
 * Calculate market data for PEPE hype analysis
 * @param {Array} klines - PEPE candlestick data
 * @param {Object} indicators - PEPE technical indicators
 * @param {Array} btcKlines - BTC data for comparison
 * @returns {Object} - PEPE and BTC data for hype detection
 */
async function calculateHypeMetrics(klines, indicators, btcKlines) {
  if (!klines || klines.length < 20) {
    return null;
  }

  const recent = klines.slice(-20);
  const current = klines[klines.length - 1];

  // Calculate average volume
  const avgVolume = recent.reduce((sum, k) => sum + (k.volume || 0), 0) / recent.length;
  const currentVolume = current.volume || 0;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  // ATR calculation
  const atrValues = recent.map(k => {
    const hl = k.high - k.low;
    const hc = Math.abs(k.high - (klines[recent.indexOf(k) - 1]?.close || k.close));
    const lc = Math.abs(k.low - (klines[recent.indexOf(k) - 1]?.close || k.close));
    return Math.max(hl, hc, lc);
  });
  const currentATR = atrValues[atrValues.length - 1] || 0;
  const atrPercent = currentATR / current.close * 100;

  // ATR expansion check (3 consecutive candles)
  const atrExpansion = atrValues.slice(-3).every((atr, i, arr) => 
    i === 0 || atr > arr[i - 1]
  );

  // Price distance from EMA21
  const ema21 = indicators?.ema21 || current.close;
  const priceDistanceFromEMA21 = ((current.close - ema21) / ema21) * 100;

  // Candle body expansion
  const recentBodies = recent.slice(-3).map(k => Math.abs(k.close - k.open));
  const candleExpansion = recentBodies.length >= 2 && 
    recentBodies[2] > recentBodies[0];

  // EMA flattening check
  const ema9 = indicators?.ema9 || current.close;
  const emaFlattening = Math.abs(ema9 - ema21) / ema21 < 0.001;

  // BB upper touch count
  const bbUpper = indicators?.bb?.upper || current.close * 1.01;
  let bbUpperTouch = 0;
  for (let i = Math.max(0, recent.length - 3); i < recent.length; i++) {
    if (recent[i].high >= bbUpper) bbUpperTouch++;
  }

  // BTC analysis
  let btcVolatility = 0;
  let btcTrend = 'SIDEWAYS';
  if (btcKlines && btcKlines.length > 20) {
    const btcRecent = btcKlines.slice(-20);
    const btcCurrent = btcKlines[btcKlines.length - 1];
    const btcATR = btcRecent.reduce((sum, k) => sum + (k.high - k.low), 0) / btcRecent.length;
    btcVolatility = (btcATR / btcCurrent.close) * 100;
    
    // Simple BTC trend
    const btcEMA20 = btcRecent.slice(-10).reduce((s, k) => s + k.close, 0) / 10;
    const btcEMA50 = btcRecent.reduce((s, k) => s + k.close, 0) / 20;
    if (btcEMA20 > btcEMA50 * 1.01) btcTrend = 'BULLISH';
    else if (btcEMA20 < btcEMA50 * 0.99) btcTrend = 'BEARISH';
  }

  return {
    pepe: {
      volumeRatio,
      atrExpansion,
      priceDistanceFromEMA21,
      candleExpansion,
      emaFlattening,
      bbUpperTouch,
      atrPercent,
      rsi: indicators?.rsi || 50,
      fundingMomentum: 0 // Will be populated from funding rate
    },
    btc: {
      volatility: btcVolatility,
      trend: btcTrend
    }
  };
}

/**
 * Get current hype state
 * @returns {Object} - Current hype state
 */
function getHypeState() {
  return { ...hypeState };
}

/**
 * Set hype state (for external control)
 * @param {string} state - New state
 * @param {number} lockMinutes - Lock duration in minutes
 */
function setHypeState(state, lockMinutes = 30) {
  hypeState.currentState = state;
  hypeState.lockUntil = Date.now() + (lockMinutes * 60 * 1000);
}

/**
 * Check if hype is locked
 * @returns {boolean}
 */
function isHypeLocked() {
  return Date.now() < hypeState.lockUntil;
}

/**
 * Reset hype state
 */
function resetHypeState() {
  hypeState.currentState = MARKET_STATE.NORMAL;
  hypeState.hypeScore = 0;
  hypeState.conditionsPassed = 0;
  hypeState.reason = '';
}

module.exports = {
  MARKET_STATE,
  analyzeHype,
  calculateHypeMetrics,
  getHypeState,
  setHypeState,
  isHypeLocked,
  resetHypeState
};
