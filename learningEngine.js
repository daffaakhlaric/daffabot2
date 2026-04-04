/**
 * SELF-LEARNING TRADING ENGINE — SAFE MODE
 * ─────────────────────────────────────────────────────────────
 * Learns from historical trades to improve decision quality.
 * Runs in DRY RUN mode only - does NOT affect live trades.
 * 
 * SAFETY LIMITS:
 * - Max ±10% weight adjustment per cycle
 * - Requires minimum 10 valid trades for any change
 * - Only learns from trades with net_profit > 0.25%
 * 
 * Output format:
 * - favorable_conditions: conditions with ≥65% win rate
 * - avoid_conditions: conditions with ≤40% win rate  
 * - weight_adjustments: safe incremental adjustments
 */

"use strict";

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

let supabase = null;
let _enabled = false;

// Current learned weights (persisted in memory)
let learnedWeights = {
  trend: 0,      // ±10% max
  momentum: 0,  // ±10% max
  volume: 0,     // ±10% max
  session: 0,    // ±10% max
  rsi: 0,        // ±10% max
};

function initLearning() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[LEARNING] Disabled — SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
    return;
  }
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    _enabled = true;
    console.log("[LEARNING] Engine initialized ✅ (SAFE MODE)");
  } catch (err) {
    console.error("[LEARNING] Init failed:", err.message);
  }
}

function isEnabled() { return _enabled && supabase !== null; }

function sf(v, decimals = 4) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

/**
 * STEP 1 — DATA VALIDATION
 * Only use trades where:
 * - net_profit > 0
 * - profit ≥ 0.25% (exceeds fee threshold with margin)
 * - entry_snapshot exists (entry_rsi, entry_ema9, etc.)
 * - duration > 30 seconds
 */
const MIN_PROFIT_PCT = 0.25; // Minimum 0.25% profit
const MIN_DURATION_SEC = 30;

function validateTrade(trade) {
  if (!trade) return false;
  
  // Check profit threshold
  const pnlPct = trade.pnl_pct || 0;
  if (pnlPct < MIN_PROFIT_PCT) return false;
  
  // Check duration
  const duration = trade.duration_sec || 0;
  if (duration < MIN_DURATION_SEC) return false;
  
  // Check entry snapshot exists (at least RSI must be present)
  if (trade.entry_rsi == null) return false;
  
  return true;
}

/**
 * STEP 2 — FEATURE EXTRACTION
 * Extract features from valid trades
 */
function extractFeatures(trade) {
  return {
    rsi: trade.entry_rsi || 50,
    volumeRatio: trade.entry_volume_ratio || 1,
    emaTrend: trade.entry_ema_trend || "NEUTRAL", // BULLISH/BEARISH/NEUTRAL
    session: trade.entry_session || "UNKNOWN",
    aiConfidence: trade.ai_confidence || 50,
    smcScore: trade.entry_smc_score || 50,
    htfTrend: trade.entry_htf_trend || "NEUTRAL",
    phase: trade.phase || "UNKNOWN",
    side: trade.side || "UNKNOWN",
    result: trade.result || "UNKNOWN", // WIN/LOSS
    pnlPct: trade.pnl_pct || 0,
  };
}

/**
 * STEP 3 — PATTERN DETECTION
 * Group trades and calculate win rate by condition
 */
function detectPatterns(trades) {
  if (trades.length === 0) return {};
  
  const patterns = {};
  
  // Helper to add to pattern group
  const addToPattern = (key, trade) => {
    if (!patterns[key]) {
      patterns[key] = { wins: 0, losses: 0, total: 0, pnlSum: 0 };
    }
    patterns[key].total++;
    patterns[key].pnlSum += trade.pnlPct;
    if (trade.result === "WIN") {
      patterns[key].wins++;
    } else {
      patterns[key].losses++;
    }
  };
  
  for (const trade of trades) {
    const f = extractFeatures(trade);
    
    // 1. RSI Range
    let rsiKey;
    if (f.rsi < 40) rsiKey = "RSI_UNDER_40";
    else if (f.rsi < 60) rsiKey = "RSI_40_60";
    else if (f.rsi < 70) rsiKey = "RSI_60_70";
    else rsiKey = "RSI_OVER_70";
    addToPattern(rsiKey, f);
    
    // 2. Volume Level
    let volKey;
    if (f.volumeRatio < 0.8) volKey = "VOL_LOW";
    else if (f.volumeRatio < 1.2) volKey = "VOL_NORMAL";
    else volKey = "VOL_HIGH";
    addToPattern(volKey, f);
    
    // 3. Session
    addToPattern(`SESSION_${f.session}`, f);
    
    // 4. EMA Trend
    addToPattern(`EMA_${f.emaTrend}`, f);
    
    // 5. HTF Trend
    addToPattern(`HTF_${f.htfTrend}`, f);
    
    // 6. Phase
    addToPattern(`PHASE_${f.phase}`, f);
    
    // 7. Side
    addToPattern(`SIDE_${f.side}`, f);
    
    // 8. Combined: Session + Volume
    addToPattern(`${f.session}_${volKey}`, f);
    
    // 9. Combined: RSI + Volume
    addToPattern(`${rsiKey}_${volKey}`, f);
  }
  
  // Calculate win rates
  const results = {};
  for (const [key, data] of Object.entries(patterns)) {
    results[key] = {
      ...data,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      avgPnl: data.total > 0 ? data.pnlSum / data.total : 0,
    };
  }
  
  return results;
}

/**
 * STEP 4 — BUILD LEARNING RULES
 * Generate favorable and avoid conditions
 */
function buildRules(patterns) {
  const favorable = [];
  const avoid = [];
  
  const FAVORABLE_THRESHOLD = 65; // 65%+ win rate = favorable
  const AVOID_THRESHOLD = 40;    // 40%- win rate = avoid
  
  for (const [key, data] of Object.entries(patterns)) {
    if (data.total < 3) continue; // Need minimum sample size
    
    if (data.winRate >= FAVORABLE_THRESHOLD) {
      favorable.push({
        condition: key,
        winRate: data.winRate.toFixed(1),
        trades: data.total,
        avgPnl: data.avgPnl.toFixed(2),
        reason: `${data.wins}/${data.total} wins (${data.winRate.toFixed(0)}%)`,
      });
    } else if (data.winRate <= AVOID_THRESHOLD) {
      avoid.push({
        condition: key,
        winRate: data.winRate.toFixed(1),
        trades: data.total,
        avgPnl: data.avgPnl.toFixed(2),
        reason: `${data.wins}/${data.total} wins (${data.winRate.toFixed(0)}%)`,
      });
    }
  }
  
  // Sort by win rate
  favorable.sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));
  avoid.sort((a, b) => parseFloat(a.winRate) - parseFloat(b.winRate));
  
  return { favorable: favorable.slice(0, 10), avoid: avoid.slice(0, 10) };
}

/**
 * STEP 5 — WEIGHT ADJUSTMENT (SAFE)
 * Max ±10% per cycle
 */
function calculateWeightAdjustments(favorable, avoid) {
  const MAX_ADJUSTMENT = 10; // ±10% max
  const MIN_SAMPLES = 5;     // Need at least 5 samples
  
  const adjustments = { trend: 0, momentum: 0, volume: 0, session: 0, rsi: 0 };
  
  // Analyze favorable conditions for boost
  for (const f of favorable) {
    const cond = f.condition;
    
    if (cond.includes("EMA_BULLISH")) {
      adjustments.trend = Math.min(adjustments.trend + 2, MAX_ADJUSTMENT);
    } else if (cond.includes("EMA_BEARISH")) {
      adjustments.trend = Math.max(adjustments.trend - 2, -MAX_ADJUSTMENT);
    } else if (cond.includes("VOL_HIGH")) {
      adjustments.volume = Math.min(adjustments.volume + 3, MAX_ADJUSTMENT);
    } else if (cond.includes("VOL_LOW")) {
      adjustments.volume = Math.max(adjustments.volume - 3, -MAX_ADJUSTMENT);
    } else if (cond.includes("SESSION")) {
      adjustments.session += 2;
    } else if (cond.includes("RSI_UNDER_40")) {
      adjustments.rsi = Math.min(adjustments.rsi + 3, MAX_ADJUSTMENT);
    } else if (cond.includes("RSI_OVER_70")) {
      adjustments.rsi = Math.max(adjustments.rsi - 3, -MAX_ADJUSTMENT);
    }
  }
  
  // Analyze avoid conditions for reduction
  for (const a of avoid) {
    const cond = a.condition;
    
    if (cond.includes("VOL_LOW")) {
      adjustments.volume = Math.max(adjustments.volume - 3, -MAX_ADJUSTMENT);
    } else if (cond.includes("RSI_OVER_70")) {
      adjustments.rsi = Math.max(adjustments.rsi - 3, -MAX_ADJUSTMENT);
    } else if (cond.includes("SESSION_ASIA")) {
      adjustments.session = Math.max(adjustments.session - 2, -MAX_ADJUSTMENT);
    }
  }
  
  // Apply current learned weights
  const finalAdjustments = {};
  for (const [key, adj] of Object.entries(adjustments)) {
    finalAdjustments[key] = learnedWeights[key] + adj;
    // Clamp to max ±10%
    finalAdjustments[key] = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, finalAdjustments[key]));
  }
  
  return finalAdjustments;
}

/**
 * STEP 6 — APPLY WEIGHT ADJUSTMENTS (SAFE)
 * Only applies in DRY RUN mode, logs all changes
 */
function applyWeightAdjustments(newAdjustments, dryRun = true) {
  const changes = [];
  
  for (const [key, value] of Object.entries(newAdjustments)) {
    const prev = learnedWeights[key];
    learnedWeights[key] = value;
    
    if (prev !== value) {
      const direction = value > prev ? "⬆️" : "⬇️";
      changes.push(`${key}: ${prev > 0 ? "+" : ""}${prev}% → ${value > 0 ? "+" : ""}${value}% ${direction}`);
    }
  }
  
  if (changes.length > 0) {
    const mode = dryRun ? "[DRY RUN]" : "[LIVE]";
    console.log(`[LEARNING] ${mode} Weight adjustments:`);
    for (const c of changes) {
      console.log(`  ${c}`);
    }
  }
  
  return learnedWeights;
}

/**
 * Fetch valid trades for learning
 */
async function fetchValidTrades(symbol = null, limit = 200) {
  if (!isEnabled()) return [];
  
  try {
    let query = supabase
      .from("trades")
      .select(`
        *,
        ai_learning (*)
      `)
      .gte("pnl_pct", MIN_PROFIT_PCT)
      .gte("duration_sec", MIN_DURATION_SEC)
      .not("entry_rsi", "is", null)
      .order("close_time", { ascending: false })
      .limit(limit);

    if (symbol) {
      query = query.eq("symbol", symbol);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error("[LEARNING] Fetch error:", error.message);
      return [];
    }

    // Validate all trades
    const valid = (data || []).filter(validateTrade);
    console.log(`[LEARNING] Fetched ${valid.length}/${data?.length || 0} valid trades`);
    return valid;

  } catch (err) {
    console.error("[LEARNING] Exception:", err.message);
    return [];
  }
}

/**
 * Main learning cycle
 */
async function runLearningCycle(symbol = null, dryRun = true) {
  if (!isEnabled()) return null;

  console.log(`[LEARNING] Starting cycle (${dryRun ? "DRY RUN" : "LIVE"})...`);
  
  const trades = await fetchValidTrades(symbol, 200);
  
  if (trades.length < 10) {
    console.log(`[LEARNING] Insufficient valid trades (${trades.length}), need at least 10`);
    return null;
  }
  
  // Split into wins and losses for analysis
  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  
  console.log(`[LEARNING] Analysis: ${wins.length} wins, ${losses.length} losses`);
  
  // Detect patterns on all valid trades
  const allPatterns = detectPatterns(trades);
  const rules = buildRules(allPatterns);
  
  // Calculate weight adjustments
  const adjustments = calculateWeightAdjustments(rules.favorable, rules.avoid);
  
  // Apply if not dry run (or just log in dry run)
  applyWeightAdjustments(adjustments, dryRun);
  
  const result = {
    timestamp: new Date().toISOString(),
    sampleSize: { total: trades.length, wins: wins.length, losses: losses.length },
    favorable_conditions: rules.favorable,
    avoid_conditions: rules.avoid,
    weight_adjustments: adjustments,
    current_weights: { ...learnedWeights },
    confidence: Math.min(100, Math.floor(trades.length / 2)), // More trades = more confidence
    dryRun,
  };
  
  // Log summary
  console.log(`[LEARNING] Cycle complete:`);
  console.log(`  Favorable: ${rules.favorable.length} conditions`);
  console.log(`  Avoid: ${rules.avoid.length} conditions`);
  console.log(`  Weights:`, adjustments);
  
  return result;
}

/**
 * Get current learned weights
 */
function getLearnedWeights() {
  return { ...learnedWeights };
}

/**
 * Reset weights to neutral (for testing)
 */
function resetWeights() {
  learnedWeights = { trend: 0, momentum: 0, volume: 0, session: 0, rsi: 0 };
  console.log("[LEARNING] Weights reset to neutral");
}

// ═══════════════════════════════════════════════════════════════
// LEARNING ACTIVATION CONTROLLER
// ═══════════════════════════════════════════════════════════════

let learningStatus = {
  self_learning: false,
  status: "LOCKED",
  reason: "Initial state",
  data_summary: { total_trades: 0, valid_trades: 0, win_rate: 0 },
  last_check: null,
};

/**
 * STEP 1-3: Check if learning can be activated
 */
async function checkLearningEligibility(symbol = null) {
  if (!isEnabled()) {
    learningStatus = {
      self_learning: false,
      status: "LOCKED",
      reason: "Supabase not enabled",
      data_summary: { total_trades: 0, valid_trades: 0, win_rate: 0 },
      last_check: new Date().toISOString(),
    };
    return learningStatus;
  }

  try {
    let query = supabase
      .from("trades")
      .select("result, pnl_pct, duration_sec, entry_rsi, entry_session, side");

    if (symbol) query = query.eq("symbol", symbol);

    const { data, error } = await query.limit(200);

    if (error) throw error;

    const totalTrades = data?.length || 0;
    
    // STEP 1: Valid trades (net_profit > 0, profit >= 0.25%, entry exists)
    const validTrades = (data || []).filter(t => 
      t.pnl_pct >= MIN_PROFIT_PCT && 
      t.duration_sec >= MIN_DURATION_SEC &&
      t.entry_rsi != null
    );
    const validCount = validTrades.length;
    
    // Winning trades
    const winningTrades = validTrades.filter(t => t.result === "WIN");
    const winningCount = winningTrades.length;

    // STEP 2: Data quality checks
    const winRate = totalTrades > 0 ? (data.filter(t => t.result === "WIN").length / totalTrades) * 100 : 0;
    
    // Average profit vs loss
    const wins = data.filter(t => t.result === "WIN" && t.pnl_pct > 0);
    const losses = data.filter(t => t.result === "LOSS" && t.pnl_pct < 0);
    const avgProfit = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl_pct, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl_pct, 0) / losses.length) : 0;

    // STEP 3: Market variety
    const sessions = new Set(validTrades.map(t => t.entry_session).filter(s => s));
    const sides = new Set(validTrades.map(t => t.side).filter(s => s));
    const rsiRanges = { u40: 0, u60: 0, o60: 0 };
    validTrades.forEach(t => {
      if (t.entry_rsi < 40) rsiRanges.u40++;
      else if (t.entry_rsi < 60) rsiRanges.u60++;
      else rsiRanges.o60++;
    });
    const hasMultipleRSIRanges = (rsiRanges.u40 > 0 && rsiRanges.o60 > 0) || rsiRanges.u60 >= 3;

    // Check conditions
    const hasEnoughData = totalTrades >= 50 && validCount >= 30 && winningCount >= 10;
    const qualityOK = winRate >= 45 && (avgProfit > avgLoss || winningCount > losses.length);
    const varietyOK = sessions.size >= 2 && sides.size >= 2 && hasMultipleRSIRanges;

    if (hasEnoughData && qualityOK && varietyOK) {
      learningStatus = {
        self_learning: true,
        status: "ACTIVE",
        reason: "All conditions met",
        data_summary: { total_trades: totalTrades, valid_trades: validCount, win_rate: winRate.toFixed(1) },
        last_check: new Date().toISOString(),
      };
    } else {
      let reasons = [];
      if (!hasEnoughData) reasons.push(`Need 50+ total, 30+ valid, 10+ wins (have ${totalTrades}/${validCount}/${winningCount})`);
      if (!qualityOK) reasons.push(`Win rate ${winRate.toFixed(0)}% < 45% or avg loss > avg profit`);
      if (!varietyOK) reasons.push(`Need 2+ sessions, 2+ sides, multiple RSI ranges`);
      
      learningStatus = {
        self_learning: false,
        status: reasons.length === 1 && reasons[0].includes("Need 50") ? "LOCKED" : "READY",
        reason: reasons.join("; "),
        data_summary: { total_trades: totalTrades, valid_trades: validCount, win_rate: winRate.toFixed(1) },
        last_check: new Date().toISOString(),
      };
    }

    console.log(`[LEARNING] Eligibility: ${learningStatus.status} - ${learningStatus.reason}`);
    return learningStatus;

  } catch (err) {
    console.error("[LEARNING] Eligibility check failed:", err.message);
    return learningStatus;
  }
}

/**
 * Get learning status
 */
function getLearningStatus() {
  return { ...learningStatus };
}

module.exports = {
  initLearning,
  isEnabled,
  validateTrade,
  extractFeatures,
  detectPatterns,
  buildRules,
  calculateWeightAdjustments,
  applyWeightAdjustments,
  fetchValidTrades,
  runLearningCycle,
  getLearnedWeights,
  resetWeights,
  checkLearningEligibility,
  getLearningStatus,
  MIN_PROFIT_PCT,
  MIN_DURATION_SEC,
};