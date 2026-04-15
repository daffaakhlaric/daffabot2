"use strict";

/**
 * EXAMPLE: Orchestrator Integration with All Fixes
 * Shows how to integrate circuit breaker, entry protocol, intra-session loss guard, etc.
 *
 * This is a template—adapt to your actual orchestrate() function
 */

// ═══════════════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════════════

const tradeMemory = require("../tradeMemory");
const { entryProtocol } = require("../strategy");
const { scoreThresholds } = require("../config");
const { pairRotation } = require("../strategy");
const { intraSessionLossGuard } = require("../guards");
const { riskGuard, profitProtector } = require("../guards");

// ═══════════════════════════════════════════════════════════════
// ENHANCED ORCHESTRATION FUNCTION
// ═══════════════════════════════════════════════════════════════

/**
 * ENHANCED orchestrate() with all safety checks
 * @param {Object} params - All market data and state
 * @returns {Object} Decision object { action, entry, sl, tp, reason, blocks }
 */
async function orchestrateWithAllFixes({
  klines_5m = [],
  klines_15m = [],
  klines_1h = [],
  klines_4h = [],
  price = 0,
  pair = "BTCUSDT",
  activePosition = null,
  tradeHistory = [],
  equity = 1000,
  session = "UNKNOWN",
  volatilityRegime = "NORMAL",
}) {
  // ─────────────────────────────────────────────────────────────
  // STEP 1: Check Circuit Breaker
  // ─────────────────────────────────────────────────────────────
  const cbStatus = tradeMemory.isCircuitBreakerActive();
  if (cbStatus.active) {
    return {
      action: "HOLD",
      reason: `🔴 CIRCUIT BREAKER ACTIVE: ${cbStatus.reason}`,
      blocks: ["Circuit breaker active"],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 2: Check Intra-Session Loss Limit
  // ─────────────────────────────────────────────────────────────
  const intraDayStatus = tradeMemory.getIntraDayLossStatus();
  const sessionCheck = intraSessionLossGuard.runIntraSessionLossChecks({
    sessionLossUSDT: intraDayStatus.sessionLossUSDT,
    maxDrawdownUSDT: intraDayStatus.sessionMaxDrawdown,
    equity,
    tradeHistory: tradeHistory.filter(t => (t.exitTime || t.timestamp || 0) > intraDayStatus.sessionStartTime),
  });

  if (sessionCheck.blocked) {
    return {
      action: "HOLD",
      reason: `⚠️ INTRA-SESSION LOSS LIMIT: ${sessionCheck.blocks[0]}`,
      blocks: sessionCheck.blocks,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 3: Profit Protection Checks (7 layers)
  // ─────────────────────────────────────────────────────────────
  const profitCheck = profitProtector.runProfitProtectionChecks({
    equity,
    tradeHistory,
    lastClosedTradePnL: tradeHistory[tradeHistory.length - 1]?.pnlPercent,
  });

  if (!profitCheck.approved) {
    return {
      action: "HOLD",
      reason: `🛡️ PROFIT PROTECTION: ${profitCheck.reason}`,
      blocks: [profitCheck.reason],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 4: Generate Entry Signal (from existing btcStrategy)
  // ─────────────────────────────────────────────────────────────
  const signal = await btcStrategy.analyze({
    klines_5m,
    klines_15m,
    klines_1h,
    klines_4h,
    price,
    pair,
  });

  if (!signal || signal.signal === "HOLD") {
    return {
      action: "HOLD",
      reason: "No valid entry signal from strategy",
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 5: Pair Rotation Check (with new liquidity gate)
  // ─────────────────────────────────────────────────────────────
  const pairRotationCheck = pairRotation.checkPairRotation({
    currentPair: pair,
    tradeHistory,
    enabledPairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"],
    klinesByPair: {
      "BTCUSDT": klines_5m, // Assuming we only have current pair data
      // In real implementation, pass all pairs' klines
    },
  });

  if (pairRotationCheck.mandatory) {
    tradeMemory.activateCircuitBreaker(pairRotationCheck.lossStreak);
    tradeMemory.setMandatorySwitchState(pair, pairRotationCheck.newPair);
    return {
      action: "HOLD",
      reason: `🔄 MANDATORY PAIR SWITCH: ${pairRotationCheck.reason}`,
      blocks: ["Pair rotation mandatory switch"],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 6: ⭐ ENTRY PROTOCOL CHECK (6 rules + fee-adjusted RR)
  // ─────────────────────────────────────────────────────────────
  const entryProtocolDecision = entryProtocol.evaluateEntrySignal({
    pair,
    direction: signal.signal,
    entry: signal.entry || price,
    sl: signal.stop_loss,
    tp: signal.tp1,  // or best TP
    klines_1h,
    klines_4h,
    klines_5m,  // ⭐ NEW: Required for ATR-based hold time
    tradeHistory,
    smc_valid: signal.smc?.checklist?.structure_valid || false,
    volume_confirmed: signal.volume_confirmed || false,
    no_news_30m: true, // Would be from economic calendar check
    entry_at_poi: signal.smc?.checklist?.order_block || false,
  });

  if (!entryProtocolDecision.entry_approved) {
    return {
      action: "HOLD",
      reason: `❌ ENTRY PROTOCOL REJECTED: ${entryProtocolDecision.rejection_reasons.join("; ")}`,
      blocks: entryProtocolDecision.rejection_reasons,
      details: {
        htf_aligned: entryProtocolDecision.htf_aligned,
        hold_time_valid: entryProtocolDecision.hold_time_valid,
        score: entryProtocolDecision.entry_score,
        rr_fee_adjusted: entryProtocolDecision.risk_reward_fee_adjusted,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 7: Session-Based Score Threshold (unified)
  // ─────────────────────────────────────────────────────────────
  const scoreApproval = scoreThresholds.shouldApproveEntry({
    score: entryProtocolDecision.entry_score,
    session,
    volatility: volatilityRegime,
    isAfterWin: tradeHistory[tradeHistory.length - 1]?.pnlPercent > 0,
    consecutiveLosses: calculateConsecutiveLosses(tradeHistory),
  });

  if (!scoreApproval.approved) {
    return {
      action: "HOLD",
      reason: `⚠️ SESSION-BASED SCORE REJECTED: ${scoreApproval.message}`,
      blocks: [`Score ${scoreApproval.score} < ${scoreApproval.minRequired} (${session})`],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 8: ✅ ALL CHECKS PASSED - READY FOR ENTRY
  // ─────────────────────────────────────────────────────────────
  const finalDecision = {
    action: "ENTER",
    pair,
    direction: signal.signal,
    entry: entryProtocolDecision.entry_price,
    sl: entryProtocolDecision.stop_loss,
    tp: entryProtocolDecision.take_profit,
    leverage: 50,
    reason: `✅ ALL CHECKS PASSED (Score ${entryProtocolDecision.entry_score}, RR ${entryProtocolDecision.risk_reward_fee_adjusted})`,
    confidence: entryProtocolDecision.entry_score,
    fees: {
      estimated_entry_fee_usd: (entryProtocolDecision.entry_price * 0.05) / 100,
      estimated_exit_fee_usd: (entryProtocolDecision.take_profit * 0.05) / 100,
    },
    details: {
      // Full breakdown for dashboard/logging
      entry_protocol_score: entryProtocolDecision.entry_score,
      htf_aligned: entryProtocolDecision.htf_aligned,
      pair_concentration: entryProtocolDecision.pair_concentration_pct,
      loss_streak: entryProtocolDecision.loss_streak,
      hold_time_estimated: entryProtocolDecision.estimated_hold_min,
      rr_raw: entryProtocolDecision.risk_reward_raw,
      rr_fee_adjusted: entryProtocolDecision.risk_reward_fee_adjusted,
      session,
      volatility: volatilityRegime,
    },
  };

  return finalDecision;
}

// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────

function calculateConsecutiveLosses(tradeHistory) {
  let count = 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    if (tradeHistory[i].pnlPercent < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
// EXECUTION FLOW IN MAIN BOT LOOP
// ─────────────────────────────────────────────────────────────

/**
 * How to use in your main bot loop
 */
async function mainBotLoop() {
  // Fetch market data...
  const klines_5m = await fetchKlines(pair, "5m", 100);
  const klines_1h = await fetchKlines(pair, "1h", 100);
  // etc.

  // Get decision
  const decision = await orchestrateWithAllFixes({
    klines_5m,
    klines_15m: await fetchKlines(pair, "15m", 100),
    klines_1h,
    klines_4h: await fetchKlines(pair, "4h", 100),
    price: klines_5m[klines_5m.length - 1]?.close,
    pair,
    tradeHistory: global.botState.tradeHistory,
    equity: global.botState.equity,
    session: getCurrentSession(), // From sessionFilter
    volatilityRegime: detectVolatilityRegime(klines_1h), // From your regime detector
  });

  // Log decision
  console.log(`\n[${new Date().toISOString()}] ${decision.action}: ${decision.reason}`);

  if (decision.action === "ENTER") {
    // Execute order
    const result = await executeOrder({
      pair: decision.pair,
      direction: decision.direction,
      entry: decision.entry,
      sl: decision.sl,
      tp: decision.tp,
      leverage: decision.leverage,
    });

    if (result.success) {
      console.log(`✅ Order executed`);
      // Update memory
      tradeMemory.updateSetupStats(result.setup, result.pnlUSDT);
    }
  } else if (decision.action === "HOLD") {
    // Log rejection for analysis
    console.log(`  Rejection reasons: ${decision.blocks.join(", ")}`);
  }

  // Monitor open position
  if (global.botState.activePosition) {
    // Check profit protection, trailing stops, etc.
    const exitCheck = checkExitSignal(global.botState.activePosition);
    if (exitCheck.shouldExit) {
      await closePosition(exitCheck.reason);

      // Update intra-session loss tracking
      if (exitCheck.pnlUSDT < 0) {
        tradeMemory.recordIntraDayLoss(exitCheck.pnlUSDT);
      }

      // Check if need to activate circuit breaker
      if (calculateConsecutiveLosses(global.botState.tradeHistory) >= 3) {
        tradeMemory.activateCircuitBreaker(3);
        console.log(`🔴 CIRCUIT BREAKER: 3 consecutive losses detected`);
      }
    }
  }
}

module.exports = {
  orchestrateWithAllFixes,
  mainBotLoop,
};
