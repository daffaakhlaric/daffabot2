"use strict";

/**
 * BOT ORCHESTRATOR — Master decision brain.
 * Replaces direct btcStrategy calls in the run loop.
 */

const btcStrategy  = require("./btcStrategy");
const featureEngine = require("./featureEngine");
const riskGuard    = require("./riskGuard");

// ── HELPERS ───────────────────────────────────────────────
function liveData() {
  return global.liveData || {};
}

/**
 * Counter-trend guard — returns object with isCounter, againstHTF, againstRegime.
 * Rules (per spec):
 *   - counter-trend + regime TRENDING  → block always
 *   - counter-trend + score < 80       → block
 *   - counter-trend + score >= 80      → allow (caller adds warning)
 */
function isCounterTrend(signal, htf, regime) {
  if (!signal || signal === "HOLD") return { isCounter: false };
  const htfBias    = htf?.htf_bias   || "";
  const regimeName = regime?.regime  || "";
  const againstHTF =
    (signal === "SHORT" && htfBias === "BULLISH") ||
    (signal === "LONG"  && htfBias === "BEARISH");
  const againstRegime =
    (signal === "SHORT" && regimeName === "TRENDING_BULL") ||
    (signal === "LONG"  && regimeName === "TRENDING_BEAR");
  return { isCounter: againstHTF || againstRegime, againstHTF, againstRegime };
}

// ── MAIN ORCHESTRATE FUNCTION ─────────────────────────────
async function orchestrate({
  klines_1m, klines_15m, klines_1h, klines_4h,
  price, activePosition, tradeHistory = [], equityCurve = [], equity = 1000,
}) {

  // STEP 1: Risk checks
  const lastTrade    = tradeHistory[tradeHistory.length - 1];
  const lastTradeTime = lastTrade ? (lastTrade.exitTime || lastTrade.timestamp || 0) : 0;

  const risk = riskGuard.runAllChecks({
    tradeHistory,
    equityCurve,
    equity,
    lastTradeTime,
    cooldownMs:        5 * 60 * 1000,
    requestedLeverage: 7,
    atrPct:            featureEngine.calcATR(klines_1m || klines_15m || [], 14),
  });

  if (risk.blocks.length > 0) {
    return {
      action:      "HOLD",
      reason:      risk.blocks[0].reason,
      riskBlocked: true,
      setup:       "RISK_BLOCK",
      source:      "RISK_GUARD",
    };
  }

  // STEP 2: Kill zone (sync, no API)
  const kz = featureEngine.killZoneTimer();
  if (kz.kz_quality === "AVOID") {
    return { action: "HOLD", reason: `Off-hours (${kz.current_kill_zone})`, setup: "KZ_AVOID", source: "KILLZONE" };
  }

  // STEP 3: Active position → exit management first
  if (activePosition) {
    let exit = null;
    try {
      exit = await featureEngine.exitOptimizer({
        side:            activePosition.side,
        entry:           activePosition.entry,
        current_price:   price,
        pnl_pct:         activePosition.pnlPct || 0,
        peak_pnl_pct:    activePosition.peak   || 0,
        current_sl:      activePosition.sl     || 0,
        tp1:             activePosition.tp1    || 0,
        tp2:             activePosition.tp2    || 0,
        klines_15m:      klines_15m || klines_1m,
        klines_5m:       klines_1m,
        duration_minutes: activePosition.openedAt
          ? Math.round((Date.now() - activePosition.openedAt) / 60000)
          : 0,
        setup_type: activePosition.setup || "TREND",
      });
    } catch {}

    if (exit?.exit_mode === "IMMEDIATE_EXIT") {
      return { action: "CLOSE", reason: exit.reasoning || "AI exit signal", urgency: exit.urgency, source: "AI_EXIT" };
    }
    if (exit?.exit_mode === "PARTIAL_CLOSE") {
      return {
        action:     "PARTIAL_CLOSE",
        percentage: exit.action_details?.close_percentage || 50,
        reason:     exit.reasoning,
        source:     "AI_EXIT",
      };
    }
    if (exit?.action_details?.new_sl && exit.action_details.new_sl !== activePosition.sl) {
      return { action: "UPDATE_SL", new_sl: exit.action_details.new_sl, reason: exit.reasoning, source: "AI_EXIT" };
    }

    // FALLBACK EXIT ONLY — bukan untuk entry baru
    // Dipanggil hanya saat ada posisi aktif DAN exitOptimizer AI return null/error
    const fast = btcStrategy.analyze({ klines: klines_1m, position: activePosition });
    if (fast.action === "CLOSE") {
      return { ...fast, source: "BTCSTRATEGY_FALLBACK_EXIT", reason: fast.reason || "btcStrategy exit" };
    }
    if (fast.action === "PYRAMID") {
      return { ...fast, source: "BTCSTRATEGY_FALLBACK_EXIT" };
    }
    return { action: "HOLD", reason: "Position held — no exit signal", source: "ORCHESTRATOR_HOLD" };
  }

  // STEP 4: Run signal features in parallel
  let htf = null, regime = null, judas = null, momentum = null;
  try {
    [htf, regime, judas, momentum] = await Promise.all([
      featureEngine.callF1({ klines_4h: klines_4h || klines_1h, klines_1h: klines_1h || klines_15m, price }),
      featureEngine.volatilityRegime({ klines_1h: klines_1h || klines_15m, price }),
      featureEngine.judasSweepDetector({ klines_15m, klines_5m: klines_1m, klines_1m, price }),
      featureEngine.momentumIgnition({ klines_5m: klines_1m, klines_1m, price }),
    ]);
  } catch {}

  // STEP 5: Regime check
  if (regime?.regime === "VOLATILE_SPIKE") {
    return { action: "HOLD", reason: "Volatile spike regime — pausing entries", setup: "REGIME_PAUSE", source: "REGIME_GUARD" };
  }

  // STEP 6: Judas override (high-priority fake-move signal)
  if (judas?.judas_detected && (judas.confidence || 0) >= 70 && judas.signal && judas.signal !== "HOLD") {
    const ct = isCounterTrend(judas.signal, htf, regime);
    if (ct.isCounter) {
      if (ct.againstRegime) {
        return { action: "HOLD", reason: `Counter-trend Judas blocked — regime ${regime?.regime}`, source: "COUNTER_TREND_GUARD" };
      }
      if ((judas.confidence || 0) < 80) {
        return { action: "HOLD", reason: `Counter-trend Judas blocked — confidence ${judas.confidence} < 80`, source: "COUNTER_TREND_GUARD" };
      }
      // score >= 80 → allow, mark as counter-trend warning
    }

    let size = null;
    try {
      const comp = await featureEngine.smartCompounder({ equity, base_size: 15, tradeHistory });
      size = comp?.recommended_size_usdt || 15;
    } catch {}

    return {
      action:     judas.signal,
      setup:      "JUDAS_SWING",
      entry:      judas.entry_price,
      sl:         judas.sl_price,
      tp1:        judas.target_1,
      tp2:        judas.target_2,
      size:       size,
      leverage:   regime?.recommended_leverage || 7,
      confidence: judas.confidence,
      reason:     judas.explanation || "Judas sweep detected",
      source:     "JUDAS",
      counter_trend_warning: ct.isCounter || undefined,
    };
  }

  // STEP 7: Momentum ignition override
  if (momentum?.ignition_detected && (momentum.confidence || 0) >= 75) {
    const ct = isCounterTrend(momentum.direction, htf, regime);
    if (ct.isCounter) {
      if (ct.againstRegime) {
        return { action: "HOLD", reason: `Counter-trend momentum blocked — regime ${regime?.regime}`, source: "COUNTER_TREND_GUARD" };
      }
      if ((momentum.confidence || 0) < 80) {
        return { action: "HOLD", reason: `Counter-trend momentum blocked — confidence ${momentum.confidence} < 80`, source: "COUNTER_TREND_GUARD" };
      }
    }

    return {
      action:   momentum.direction,
      setup:    "MOMENTUM_IGNITION",
      entry:    momentum.entry_price,
      sl:       momentum.sl_price,
      tp1:      momentum.tp1_price,
      tp2:      momentum.tp2_price,
      confidence: momentum.confidence,
      reason:   `Momentum ignition: ${momentum.checks?.volume_spike ? "vol+" : ""} ${momentum.estimated_move_pct?.toFixed(1)}% move expected`,
      source:   "MOMENTUM",
      counter_trend_warning: ct.isCounter || undefined,
    };
  }

  // STEP 8: Normal SMC flow
  if ((htf?.confidence || 0) >= 60) {
    let smc = null;
    try {
      smc = await featureEngine.callF2({
        klines_4h:  klines_4h || klines_1h,
        klines_1h:  klines_1h || klines_15m,
        klines_15m,
        klines_5m:  klines_1m,
        price,
        htfBias:    htf,
      });
    } catch {}

    if (smc?.signal !== "HOLD" && (smc?.confluence_score || 0) >= 65) {
      // Counter-trend guard for SMC
      const ct = isCounterTrend(smc.signal, htf, regime);
      if (ct.isCounter) {
        if (ct.againstRegime) {
          return { action: "HOLD", reason: `Counter-trend SMC blocked — regime ${regime?.regime}`, source: "COUNTER_TREND_GUARD" };
        }
        if ((smc.confluence_score || 0) < 80) {
          return { action: "HOLD", reason: `Counter-trend SMC blocked — score ${smc.confluence_score} < 80`, source: "COUNTER_TREND_GUARD" };
        }
      }

      // Risk guard: check R:R and FOMO
      const entryZone = smc.entry_zone || [price * 0.999, price * 1.001];
      const finalRisk = riskGuard.runAllChecks({
        tradeHistory, equityCurve, equity, lastTradeTime,
        cooldownMs:        5 * 60 * 1000,
        entry:             entryZone[0],
        sl:                smc.stop_loss,
        tp1:               smc.tp1,
        side:              smc.signal,
        price,
        entryZone,
        requestedLeverage: smc.recommended_leverage || 7,
        atrPct:            smc.atr14_pct || 1.0,
      });

      if (!finalRisk.approved) {
        return { action: "HOLD", reason: finalRisk.blocks[0]?.reason, setup: "SMC_RISK_BLOCK", source: "RISK_GUARD" };
      }

      // Try sniper entry
      let sniper = null;
      try {
        sniper = await featureEngine.sniperMode({
          klines_15m, klines_5m: klines_1m, price,
          htf_bias:  htf.htf_bias,
          htf_score: htf.confidence,
        });
      } catch {}

      if (sniper?.sniper_available && (sniper.distance_from_current_pct || 999) < 0.5) {
        return {
          action:    smc.signal,
          setup:     "SNIPER_" + (smc.setup_type || "SMC"),
          orderType: "LIMIT",
          entry:     sniper.entry_price,
          sl:        sniper.sl_price,
          tp1:       sniper.tp1_price,
          tp2:       sniper.tp2_price,
          tp3:       sniper.tp3_price,
          leverage:  finalRisk.approved_leverage,
          confidence: sniper.confidence,
          reason:    `SMC ${smc.setup_type} + sniper at ${sniper.entry_type}`,
          source:    "SNIPER_SMC",
          counter_trend_warning: ct.isCounter || undefined,
        };
      }

      // Regular SMC entry
      let size = 15;
      try {
        const comp = await featureEngine.smartCompounder({ equity, base_size: 15, tradeHistory });
        size = comp?.recommended_size_usdt || 15;
      } catch {}

      return {
        action:    smc.signal,
        setup:     smc.setup_type || "SMC",
        entry:     entryZone[0],
        sl:        smc.stop_loss,
        tp1:       smc.tp1,
        tp2:       smc.tp2,
        tp3:       smc.tp3,
        size,
        leverage:  finalRisk.approved_leverage,
        confluence: smc.confluence_score,
        reason:    smc.justification || `SMC ${smc.setup_type} score=${smc.confluence_score}`,
        checklist_passed: smc.checklist_passed,
        source:    "SMC",
        counter_trend_warning: ct.isCounter || undefined,
      };
    }
  }

  // STEP 9: No valid AI signal — return HOLD
  // btcStrategy TIDAK dipanggil di sini karena kita dalam mode AI_ENABLED.
  // btcStrategy hanya boleh dipanggil untuk fallback exit (STEP 3, saat ada posisi aktif).
  return { action: "HOLD", reason: "No valid signal from AI analysis", source: "ORCHESTRATOR_HOLD" };
}

module.exports = { orchestrate };
