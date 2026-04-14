"use strict";

/**
 * Pair Manager — Fund manager brain deciding which pair to trade
 * Evaluates all pairs, manages switches, tracks whale activity
 */

const { getEnabledPairs, getPairBySymbol } = require("./pairConfig");
const { scorePair } = require("./pairScorer");
const { detectWhaleActivity } = require("./whaleTracker");

const SWITCH_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_SWITCHES_PER_DAY = 3;
const MIN_SCORE_GAP_TO_SWITCH = 20;
const SCORE_DROP_TRIGGER = 15;
const MAX_WHALE_ALERTS = 20;
const MAX_SCORE_HISTORY = 5;

// Initialize global state
function initState() {
  if (!global.pairManagerState) {
    global.pairManagerState = {
      activePair: null,
      activePairSetAt: 0,
      activePairPeakScore: 0,
      pairScores: {},
      scoreHistory: {},
      switchHistory: [],
      switchCount: 0,
      switchCountResetAt: 0,
      lastSwitchTime: 0,
      lastEvalTime: 0,
      recommendation: "Initializing...",
      scoreboard: [],
      whaleAlerts: [],
      currentMode: "UNKNOWN",
      initialized: false,
    };
  }
}

async function evaluateAll({ klines1mMap, priceMap, aiEnabled }) {
  initState();
  const state = global.pairManagerState;

  // Reset daily switch count if new day
  const now = Date.now();
  if (now - state.switchCountResetAt > 24 * 60 * 60 * 1000) {
    state.switchCount = 0;
    state.switchCountResetAt = now;
  }

  const pairs = getEnabledPairs();
  const scored = [];

  // Score each pair
  for (const pair of pairs) {
    const klines = klines1mMap[pair.symbol];
    const price = priceMap[pair.symbol];

    if (!klines || klines.length < 50 || !price) {
      continue;
    }

    // Get whale signal
    const whaleSignal = detectWhaleActivity({ klines, price });

    // Score pair
    const pairScore = scorePair({ klines, price, pairConfig: pair, whaleSignal });

    // Store score
    state.pairScores[pair.symbol] = { ...pairScore, whaleSignal };

    // Update score history
    if (!state.scoreHistory[pair.symbol]) {
      state.scoreHistory[pair.symbol] = [];
    }
    state.scoreHistory[pair.symbol].push(pairScore.score);
    if (state.scoreHistory[pair.symbol].length > MAX_SCORE_HISTORY) {
      state.scoreHistory[pair.symbol].shift();
    }

    // Record whale alert
    if (whaleSignal.whaleDetected) {
      state.whaleAlerts.push({
        symbol: pair.symbol,
        signal: whaleSignal.signal,
        type: whaleSignal.type,
        confidence: whaleSignal.confidence,
        timestamp: now,
      });
      if (state.whaleAlerts.length > MAX_WHALE_ALERTS) {
        state.whaleAlerts.shift();
      }
    }

    // Build scoreboard entry
    scored.push({
      symbol: pair.symbol,
      displayName: pair.displayName,
      score: pairScore.score,
      recommendation: pairScore.recommendation,
      trendDirection: pairScore.trend_direction,
      isSaturated: pairScore.isSaturated,
      whaleDetected: whaleSignal.whaleDetected,
      whaleSignal: whaleSignal.signal,
      whaleConfidence: whaleSignal.confidence,
      atrQuality: pairScore.breakdown.atr,
      volumeAnomaly: pairScore.breakdown.volume,
      trendStrength: pairScore.breakdown.trend,
      notes: pairScore.notes,
    });
  }

  // Sort by score
  scored.sort((a, b) => b.score - a.score);
  state.scoreboard = scored;

  // Update peak score if active pair improved
  if (state.activePair && state.pairScores[state.activePair]) {
    const currentScore = state.pairScores[state.activePair].score;
    state.activePairPeakScore = Math.max(state.activePairPeakScore, currentScore);
  }

  // Determine switch decision
  const switchDecision = shouldSwitchPair(state, scored);
  state.recommendation = buildRecommendation(scored, aiEnabled);
  state.lastEvalTime = now;
  state.currentMode = aiEnabled ? "AI" : "BOT";

  return {
    scoreboard: scored,
    activePair: state.activePair,
    shouldSwitch: switchDecision.shouldSwitch,
    nextPair: switchDecision.nextPair,
    switchReason: switchDecision.reason,
    recommendation: state.recommendation,
    whaleAlerts: state.whaleAlerts.slice(-5),
  };
}

function shouldSwitchPair(state, scoreboard) {
  const hasOpenPosition = global.botState?.activePosition !== null;

  if (hasOpenPosition) {
    return { shouldSwitch: false, nextPair: null, reason: "Position open" };
  }

  const canSwitchResult = canSwitch(state);
  if (!canSwitchResult.allowed) {
    return { shouldSwitch: false, nextPair: null, reason: canSwitchResult.reason };
  }

  // Initial pair selection
  if (!state.activePair) {
    const best = scoreboard[0];
    if (best) {
      const pairCfg = getPairBySymbol(best.symbol);
      if (pairCfg && best.score >= pairCfg.minScore) {
        return { shouldSwitch: true, nextPair: best.symbol, reason: "Initial pair selection" };
      }
    }
    return { shouldSwitch: false, nextPair: null, reason: "No pair meets minimum score" };
  }

  const activeScore = state.pairScores[state.activePair]?.score || 0;
  const activeSaturated = state.pairScores[state.activePair]?.isSaturated || false;

  // Switch if saturated
  if (activeSaturated) {
    const nextBest = scoreboard.find(p => p.symbol !== state.activePair && !p.isSaturated);
    if (nextBest) {
      return { shouldSwitch: true, nextPair: nextBest.symbol, reason: "Active pair saturated" };
    }
  }

  // Switch if score dropped significantly
  if (activeScore < state.activePairPeakScore - SCORE_DROP_TRIGGER) {
    const nextBest = scoreboard[0];
    if (nextBest.symbol !== state.activePair) {
      return {
        shouldSwitch: true,
        nextPair: nextBest.symbol,
        reason: `Score dropped ${SCORE_DROP_TRIGGER}pts from peak (${state.activePairPeakScore})`,
      };
    }
  }

  // Check whale exit signal
  const activeWhale = state.pairScores[state.activePair]?.whaleSignal;
  if (activeWhale?.whaleDetected &&
      (activeWhale.type.includes("DISTRIBUTION") || activeWhale.type.includes("ABSORPTION_BEAR"))) {
    const nextBest = scoreboard.find(p => p.symbol !== state.activePair);
    if (nextBest) {
      return { shouldSwitch: true, nextPair: nextBest.symbol, reason: "Whale exit signal detected" };
    }
  }

  // Switch if gap is large enough
  const best = scoreboard[0];
  if (best.symbol !== state.activePair && best.score > activeScore + MIN_SCORE_GAP_TO_SWITCH) {
    const gap = best.score - activeScore;
    return {
      shouldSwitch: true,
      nextPair: best.symbol,
      reason: `Better pair found: +${gap}pts gap (${best.symbol} ${best.score} vs ${state.activePair} ${activeScore})`,
    };
  }

  return { shouldSwitch: false, nextPair: null, reason: "Active pair still optimal" };
}

function canSwitch(state) {
  if (state.switchCount >= MAX_SWITCHES_PER_DAY) {
    return { allowed: false, reason: "Max switches reached today" };
  }

  if (Date.now() - state.lastSwitchTime < SWITCH_COOLDOWN_MS) {
    const remaining = Math.ceil((SWITCH_COOLDOWN_MS - (Date.now() - state.lastSwitchTime)) / 60000);
    return { allowed: false, reason: `Cooldown: ${remaining}min remaining` };
  }

  return { allowed: true, reason: "Switch allowed" };
}

function recordSwitch(fromPair, toPair, reason) {
  initState();
  const state = global.pairManagerState;

  state.activePair = toPair;
  state.activePairSetAt = Date.now();
  state.activePairPeakScore = state.pairScores[toPair]?.score || 0;
  state.switchCount++;
  state.lastSwitchTime = Date.now();

  state.switchHistory.push({
    from: fromPair,
    to: toPair,
    reason,
    timestamp: Date.now(),
    scores: {
      fromScore: state.pairScores[fromPair]?.score,
      toScore: state.pairScores[toPair]?.score,
    },
  });

  if (state.switchHistory.length > 50) {
    state.switchHistory.shift();
  }
}

function buildRecommendation(scoreboard, aiEnabled) {
  if (!scoreboard || scoreboard.length === 0) {
    return "No pairs available";
  }

  const mode = aiEnabled ? "[AI]" : "[BOT]";
  const lines = [];

  // Top pair
  const top = scoreboard[0];
  lines.push(`${top.displayName} leading (${top.score}pts) ${mode}`);

  // Queue (next 2)
  if (scoreboard.length > 1) {
    const queue = scoreboard.slice(1, 3).map(p => `${p.displayName} (${p.score}pts)`).join(", ");
    lines.push(`Queue: ${queue}`);
  }

  // Saturated
  const saturated = scoreboard.filter(p => p.isSaturated).map(p => p.displayName);
  if (saturated.length > 0) {
    lines.push(`Saturated — skip: ${saturated.join(", ")}`);
  }

  return lines.join(" | ");
}

function getActivePairConfig() {
  initState();
  const state = global.pairManagerState;
  const pairCfg = state.activePair ? getPairBySymbol(state.activePair) : getPairBySymbol("BTCUSDT");
  return pairCfg || getPairBySymbol("BTCUSDT");
}

module.exports = {
  evaluateAll,
  shouldSwitchPair,
  canSwitch,
  recordSwitch,
  buildRecommendation,
  getActivePairConfig,
  initState,
};
