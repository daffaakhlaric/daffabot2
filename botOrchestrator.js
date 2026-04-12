"use strict";

/**
 * BOT ORCHESTRATOR — Master decision brain.
 * Replaces direct btcStrategy calls in the run loop.
 */

const https         = require("https");
const btcStrategy   = require("./btcStrategy");
const featureEngine = require("./featureEngine");
const riskGuard     = require("./riskGuard");
const tradeMemory   = require("./tradeMemory");

// ── HELPERS ───────────────────────────────────────────────
function liveData() {
  return global.liveData || {};
}

/**
 * UPGRADE 7 — Orderbook Imbalance.
 * Pure math — given bids/asks arrays [[price, size], ...] returns BULLISH/BEARISH/NEUTRAL.
 */
function orderbookImbalance(bids, asks) {
  try {
    const bidVol = bids.reduce((s, b) => s + parseFloat(b[1] || 0), 0);
    const askVol = asks.reduce((s, a) => s + parseFloat(a[1] || 0), 0);
    if (bidVol > askVol * 1.5) return "BULLISH";
    if (askVol > bidVol * 1.5) return "BEARISH";
    return "NEUTRAL";
  } catch { return "NEUTRAL"; }
}

/**
 * Fetch top-5 orderbook from Bitget (public endpoint, no auth required).
 * Returns { bids, asks } or null on failure.
 */
function fetchOrderbook(symbol = process.env.BTC_SYMBOL || "BTCUSDT") {
  return new Promise(resolve => {
    const path = `/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=5`;
    const req = https.request({ hostname: "api.bitget.com", path, method: "GET" }, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.code === "00000" && parsed.data) {
            resolve({ bids: parsed.data.bids || [], asks: parsed.data.asks || [] });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * UPGRADE 8 — Sniper Lock System.
 * Returns { locked, reason } — lock entry if sniper trade taken today OR big win achieved.
 */
function isSniperLocked(tradeHistory, equity) {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = tradeHistory.filter(t =>
      (t.exitTime || t.timestamp || 0) >= todayStart.getTime()
    );

    // Lock if any sniper trade was already taken today (protect the setup)
    const sniperTaken = today.some(t =>
      t.setup === "SNIPER_KILLER" || t.setup === "SNIPER_ELITE"
    );
    if (sniperTaken) {
      return { locked: true, reason: "Sniper trade already taken today — protecting the day" };
    }

    // Lock if today's cumulative PnL >= 3% of equity or $30 (big win — stop trading)
    const todayPnL = today.reduce((sum, t) => sum + (t.pnlUSDT || 0), 0);
    const bigWinThreshold = Math.max(30, (equity || 1000) * 0.03);
    if (todayPnL >= bigWinThreshold) {
      return { locked: true, reason: `Big win locked — today's PnL $${todayPnL.toFixed(2)} >= threshold $${bigWinThreshold.toFixed(2)}` };
    }

    return { locked: false };
  } catch { return { locked: false }; }
}

/**
 * Counter-trend guard — returns { isCounter, againstHTF, againstRegime }.
 */
function isCounterTrend(signal, htf, regime) {
  if (!signal || signal === "HOLD") return { isCounter: false };
  const htfBias    = htf?.htf_bias  || "";
  const regimeName = regime?.regime || "";
  const againstHTF =
    (signal === "SHORT" && htfBias === "BULLISH") ||
    (signal === "LONG"  && htfBias === "BEARISH");
  const againstRegime =
    (signal === "SHORT" && regimeName === "TRENDING_BULL") ||
    (signal === "LONG"  && regimeName === "TRENDING_BEAR");
  return { isCounter: againstHTF || againstRegime, againstHTF, againstRegime };
}

/**
 * UPGRADE 1 — Adaptive Decision Score.
 * Dynamic weights per regime — no penalty, just smarter weighting.
 */
function buildAdaptiveScore({ htf, smc, momentum, judas, regime }) {
  const r = regime?.regime || "";

  let weights;
  if (r === "TRENDING_BULL" || r === "TRENDING_BEAR") {
    weights = { htf: 0.35, smc: 0.25, momentum: 0.30, judas: 0.10 };
  } else if (r === "RANGING") {
    weights = { htf: 0.20, smc: 0.40, momentum: 0.20, judas: 0.20 };
  } else if (r === "VOLATILE_SPIKE") {
    weights = { htf: 0.30, smc: 0.20, momentum: 0.20, judas: 0.30 };
  } else {
    weights = { htf: 0.40, smc: 0.30, momentum: 0.20, judas: 0.10 };
  }

  const htfScore   = htf?.confidence          || 50;
  const smcScore   = smc?.confluence_score     || 50;
  const momScore   = momentum?.ignition_detected ? (momentum.confidence || 70) : 50;
  const judasScore = judas?.judas_detected      ? (judas.confidence     || 70) : 50;

  const weighted = Math.round(
    htfScore   * weights.htf      +
    smcScore   * weights.smc      +
    momScore   * weights.momentum +
    judasScore * weights.judas
  );

  return Math.max(0, Math.min(100, weighted));
}


/**
 * UPGRADE 2 — Market State Engine.
 */
function detectMarketState({ atrPct, regime, klines_15m }) {
  // ATR override first
  if (regime?.regime === "VOLATILE_SPIKE") return "VOLATILE";
  if (regime?.regime === "TRENDING_BULL" || regime?.regime === "TRENDING_BEAR") return "TRENDING";
  if (regime?.regime === "RANGING") return "RANGING";

  // Fallback: compute from klines trend strength
  let trendStrength = 0;
  if (klines_15m && klines_15m.length >= 10) {
    const last10  = klines_15m.slice(-10);
    const highs   = last10.map(k => k.high);
    const lows    = last10.map(k => k.low);
    const hhCount = highs.filter((h, i) => i > 0 && h > highs[i - 1]).length;
    const llCount = lows.filter((l, i) => i > 0 && l < lows[i - 1]).length;
    trendStrength = Math.max(hhCount, llCount) / 9; // 0–1
  }

  const atr = atrPct || 1.0;
  if (atr > 1.8) return "VOLATILE";
  if (trendStrength > 0.6) return "TRENDING";
  return "RANGING";
}

/**
 * UPGRADE 5 — Sniper Elite conditions check.
 * All 5 conditions must be met; returns entry object or null.
 */
function sniperEliteEntry({ htf, judas, smc, kz, tradeHistory, dailyTrades, lastTradePnL }) {
  try {
    if (dailyTrades >= 3) return null;

    // Cooldown 30 min after loss
    if (lastTradePnL < 0) {
      const lastTrade = tradeHistory[tradeHistory.length - 1];
      const elapsed   = Date.now() - (lastTrade?.exitTime || 0);
      if (elapsed < 30 * 60 * 1000) return null;
    }

    const strongHTF     = (htf?.confidence || 0) >= 80;
    const sweepDetected = judas?.judas_detected && judas.phase === "REVERSAL_CONFIRMED";
    const inZone        = smc?.checklist?.mitigation_zone === true;
    const sessionOk     = ["London", "New York", "NY_OPEN", "LONDON_OPEN"].some(s =>
                            kz?.current_kill_zone?.includes(s.replace(" ", "_")) ||
                            kz?.current_kill_zone?.includes(s));
    const htfAligned    = htf?.htf_bias && judas?.signal &&
      ((htf.htf_bias === "BULLISH" && judas.signal === "LONG")  ||
       (htf.htf_bias === "BEARISH" && judas.signal === "SHORT"));

    if (!strongHTF || !sweepDetected || !inZone || !sessionOk || !htfAligned) return null;

    return {
      action:    judas.signal,
      setup:     "SNIPER_ELITE",
      entry:     judas.entry_price,
      sl:        judas.sl_price,
      tp1:       null,
      tp2:       null,
      tp3:       null,
      rr_target: [2, 5, 10],
      source:    "SNIPER_ELITE",
      reason:    `SNIPER_ELITE: HTF ${htf.confidence}% + sweep confirmed + zone hit`,
    };
  } catch { return null; }
}

/**
 * UPGRADE 6 — Anti-FOMO price movement check.
 * Returns true if price has moved too far from entry zone.
 */
function checkPriceMoved(price, entryZone, maxMovePct = 0.012) {
  try {
    if (!entryZone) return false;
    const mid = Array.isArray(entryZone)
      ? (entryZone[0] + entryZone[1]) / 2
      : entryZone;
    if (!mid || mid <= 0) return false;
    return Math.abs(price - mid) / mid > maxMovePct;
  } catch { return false; }
}

/**
 * UPGRADE C — Smart Entry Engine.
 * Confluence check before committing to an entry.
 * Returns entry object (setup=AI_CONFLUENCE) or null.
 */
function buildSmartEntry({ htf, smc, liquidity, score }) {
  try {
    if (!score || score < 70) return null;
    if (!smc?.signal || smc.signal === "HOLD") return null;
    if (liquidity?.bias && liquidity.bias !== smc.signal) return null;

    const entry = Array.isArray(smc.entry_zone)
      ? (smc.entry_zone[0] + smc.entry_zone[1]) / 2
      : smc.entry_zone || null;

    return {
      action:    smc.signal,
      setup:     "AI_CONFLUENCE",
      entry,
      sl:        smc.stop_loss,
      tp1:       smc.tp1,
      tp2:       smc.tp2,
      tp3:       smc.tp3,
      confidence: score,
      reason:    `AI confluence: HTF ${htf?.confidence || 0}% + SMC ${smc.confluence_score || 0} + liquidity ${liquidity?.type || "N/A"}`,
      source:    "SMART_ENTRY",
    };
  } catch { return null; }
}

/**
 * UPGRADE D — Sniper Killer Mode.
 * All 5 conditions must pass. Returns SNIPER_KILLER entry or null.
 */
function sniperKiller({ htf, smc, judas, liquidity, kz }) {
  try {
    const htfOk      = (htf?.confidence || 0) >= 85;
    const smcOk      = (smc?.confluence_score || 0) >= 80;
    const judasOk    = judas?.judas_detected === true;
    const liqOk      = liquidity !== null && liquidity?.detected === true;
    const sessionOk  = ["LONDON_OPEN", "NY_OPEN", "London", "New York"].some(s =>
                         (kz?.current_kill_zone || "").includes(s.replace(" ", "_")) ||
                         (kz?.current_kill_zone || "").includes(s));

    if (!htfOk || !smcOk || !judasOk || !liqOk || !sessionOk) return null;

    // Signal must agree: judas + SMC must point same direction
    const signal = judas.signal || smc.signal;
    if (!signal || signal === "HOLD") return null;
    if (judas.signal && smc.signal && judas.signal !== smc.signal) return null;

    const entry = judas.entry_price || smc.entry_zone?.[0] || null;
    const sl    = judas.sl_price    || smc.stop_loss       || null;
    const r     = entry && sl ? Math.abs(entry - sl) : 0;

    return {
      action:          signal,
      setup:           "SNIPER_KILLER",
      entry,
      sl,
      tp1:             r > 0 ? (signal === "LONG" ? entry + r * 3  : entry - r * 3)  : null,
      tp2:             r > 0 ? (signal === "LONG" ? entry + r * 8  : entry - r * 8)  : null,
      tp3:             r > 0 ? (signal === "LONG" ? entry + r * 15 : entry - r * 15) : null,
      leverage:        10,
      rr_target:       [3, 8, 15],
      max_daily_trades: 2,
      confidence:      Math.round(((htf.confidence || 0) + (smc.confluence_score || 0)) / 2),
      reason:          `SNIPER_KILLER: HTF ${htf.confidence}% + SMC ${smc.confluence_score} + Judas + Liquidity ${liquidity.type}`,
      source:          "SNIPER_KILLER",
    };
  } catch { return null; }
}

/**
 * UPGRADE E — Dynamic Exit Manager.
 * pnl>1.5% → move SL to BE, pnl>3% → partial close 50%, pnl>5% → trail at ATR*1.2.
 * Returns exit action or null (no action needed).
 */
function dynamicExit(pos, price, atrPct) {
  try {
    if (!pos || !price) return null;
    const pnlPct = pos.pnlPct || 0;
    const entry  = pos.entry  || price;

    if (pnlPct > 5) {
      const atr       = atrPct || 1.0;
      const trailDist = entry * (atr * 1.2 / 100);
      const new_sl    = pos.side === "LONG" ? price - trailDist : price + trailDist;
      if (!pos.sl || (pos.side === "LONG" ? new_sl > pos.sl : new_sl < pos.sl)) {
        return { action: "UPDATE_SL", new_sl: +new_sl.toFixed(2), reason: "Dynamic trail: pnl>5%, SL at ATR*1.2", source: "DYNAMIC_EXIT" };
      }
    }

    if (pnlPct > 3) {
      return { action: "PARTIAL_CLOSE", percentage: 50, reason: "Dynamic exit: pnl>3%, close 50%", source: "DYNAMIC_EXIT" };
    }

    if (pnlPct > 1.5 && pos.sl !== entry) {
      return { action: "UPDATE_SL", new_sl: entry, reason: "Dynamic exit: pnl>1.5%, move SL to BE", source: "DYNAMIC_EXIT" };
    }

    return null;
  } catch { return null; }
}

// ── MAIN ORCHESTRATE FUNCTION ─────────────────────────────
async function orchestrate({
  klines_1m, klines_15m, klines_1h, klines_4h,
  price, activePosition, tradeHistory = [], equityCurve = [], equity = 1000,
  mode = "SAFE",
}) {

  // STEP 1: Risk checks

  const lastTrade     = tradeHistory[tradeHistory.length - 1];
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
  // RELAXED: Allow off-hours entry (lower liquidity but acceptable for testing)
  // Uncomment below to block off-hours if needed
  // if (kz.kz_quality === "AVOID") {
  //   return { action: "HOLD", reason: `Off-hours (${kz.current_kill_zone})`, setup: "KZ_AVOID", source: "KILLZONE" };
  // }

  // STEP 3: Active position → exit management first
  if (activePosition) {
    // UPGRADE E — Dynamic Exit (runs before AI exit check)
    const dynExit = dynamicExit(
      activePosition,
      price,
      featureEngine.calcATR(klines_1m || klines_15m || [], 14)
    );
    if (dynExit) return dynExit;

    // Sniper Elite exit rules (UPGRADE 5)
    if (activePosition.setup === "SNIPER_ELITE") {
      const pnlPct  = activePosition.pnlPct || 0;
      const entry   = activePosition.entry   || price;
      const sl      = activePosition.sl      || entry * (activePosition.side === "LONG" ? 0.993 : 1.007);
      const riskPct = Math.abs((entry - sl) / entry * 100);
      if (riskPct > 0) {
        if (pnlPct >= riskPct * 10) {
          return { action: "CLOSE", reason: "Sniper TP3 (10R) hit", source: "SNIPER_ELITE_EXIT" };
        }
        if (pnlPct >= riskPct * 5) {
          return { action: "UPDATE_SL", new_sl: entry, reason: "Sniper 5R — move SL to BE", source: "SNIPER_ELITE_EXIT" };
        }
        if (pnlPct >= riskPct * 2) {
          return { action: "PARTIAL_CLOSE", percentage: 50, reason: "Sniper TP1 (2R) — partial 50%", source: "SNIPER_ELITE_EXIT" };
        }
      }
    }

    // Minimum hold time: don't let AI exit optimizer fire on a position that just opened.
    // AI sees duration_minutes=0 → "entry failed" → immediate close. Give it 2 minutes to breathe.
    const posAgeMs      = activePosition.openedAt ? Date.now() - activePosition.openedAt : 999999;
    const posAgeMinutes = Math.round(posAgeMs / 60000);
    const MIN_HOLD_MS   = 2 * 60 * 1000; // 2 minutes

    let exit = null;
    if (posAgeMs >= MIN_HOLD_MS) {
      try {
        exit = await featureEngine.exitOptimizer({
          side:             activePosition.side,
          entry:            activePosition.entry,
          current_price:    price,
          pnl_pct:          activePosition.pnlPct || 0,
          peak_pnl_pct:     activePosition.peak   || 0,
          current_sl:       activePosition.sl     || 0,
          tp1:              activePosition.tp1    || 0,
          tp2:              activePosition.tp2    || 0,
          klines_15m:       klines_15m || klines_1m,
          klines_5m:        klines_1m,
          duration_minutes: posAgeMinutes,
          setup_type:       activePosition.setup || "TREND",
        });
      } catch {}
    }

    // CRITICAL override — close immediately regardless of exit_mode
    if (exit?.urgency === "CRITICAL") {
      return { action: "CLOSE", reason: exit.reasoning || "AI CRITICAL exit", urgency: "CRITICAL", source: "AI_EXIT_CRITICAL" };
    }

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

    // TIGHTEN_TRAIL exit mode: move SL closer based on trail distance
    if (exit?.exit_mode === "TIGHTEN_TRAIL" && exit.action_details?.trail_distance_pct) {
      const dist = activePosition.entry * (exit.action_details.trail_distance_pct / 100);
      const new_sl = activePosition.side === "LONG" ? price - dist : price + dist;
      return { action: "UPDATE_SL", new_sl: +new_sl.toFixed(2), reason: exit.reasoning || "Trail tightened", source: "AI_EXIT_TRAIL" };
    }

    // FALLBACK EXIT ONLY — bukan untuk entry baru
    const fast = btcStrategy.analyze({ klines: klines_1m, position: activePosition });
    if (fast.action === "CLOSE") {
      return { ...fast, source: "BTCSTRATEGY_FALLBACK_EXIT", reason: fast.reason || "btcStrategy exit" };
    }
    if (fast.action === "PYRAMID") {
      return { ...fast, source: "BTCSTRATEGY_FALLBACK_EXIT" };
    }
    return { action: "HOLD", reason: "Position held — no exit signal", source: "ORCHESTRATOR_HOLD" };
  }

  // UPGRADE 4 — FAST MODE: langsung entry tanpa nunggu semua AI jika momentum sangat kuat
  if (mode === "FAST") {
    const htfBias      = global.botState?.features?.f1?.htf_bias;
    const lastMomentum = global.botState?.features?.momentum;

    if (kz.kz_quality !== "AVOID"
        && lastMomentum?.ignition_detected
        && (lastMomentum.confidence || 0) >= 85
        && htfBias
        && lastMomentum.direction === (htfBias === "BULLISH" ? "LONG" : "SHORT")
        && lastMomentum.time_sensitivity === "IMMEDIATE") {
      return {
        action:  lastMomentum.direction,
        setup:   "FAST_MOMENTUM",
        entry:   price,
        sl:      lastMomentum.sl_price,
        tp1:     lastMomentum.tp1_price,
        tp2:     lastMomentum.tp2_price,
        source:  "FAST_MODE",
        reason:  `Fast mode: momentum ${lastMomentum.confidence}% confidence`,
      };
    }
  }

  // STEP 4: Run signal features + orderbook in parallel
  let htf = null, regime = null, judas = null, momentum = null, obRaw = null;
  try {
    [htf, regime, judas, momentum, obRaw] = await Promise.all([
      featureEngine.callF1({ klines_4h: klines_4h || klines_1h, klines_1h: klines_1h || klines_15m, price }),
      featureEngine.volatilityRegime({ klines_1h: klines_1h || klines_15m, price }),
      featureEngine.judasSweepDetector({ klines_15m, klines_5m: klines_1m, klines_1m, price }),
      featureEngine.momentumIgnition({ klines_5m: klines_1m, klines_1m, price }),
      fetchOrderbook(),
    ]);
  } catch {}

  // Compute orderbook bias (NEUTRAL if fetch failed)
  const obBias = obRaw ? orderbookImbalance(obRaw.bids, obRaw.asks) : "NEUTRAL";
  if (global.botState) global.botState.obBias = obBias;

  // UPGRADE B — Liquidity Trap (pure math, no latency)
  let liquidity = null;
  try {
    liquidity = featureEngine.detectLiquidityTrap({ klines: klines_15m || klines_1m });
  } catch {}

  // STEP 5: Regime check
  if (regime?.regime === "VOLATILE_SPIKE") {
    return { action: "HOLD", reason: "Volatile spike regime — pausing entries", setup: "REGIME_PAUSE", source: "REGIME_GUARD" };
  }

  // UPGRADE 2 — Market State Engine
  const atrPct     = featureEngine.calcATR(klines_1m || klines_15m || [], 14);
  const marketState = detectMarketState({ atrPct, regime, klines_15m });
  if (global.botState) global.botState.marketState = marketState;

  const disableTrendEntry  = marketState === "RANGING";
  const disableSniperEntry = marketState === "TRENDING";

  if (marketState === "VOLATILE") {
    return { action: "HOLD", reason: "Volatile market — no new entries", source: "MARKET_STATE_GATE" };
  }

  // UPGRADE 8 — Sniper Lock System
  const sniperLock = isSniperLocked(tradeHistory, equity);
  if (sniperLock.locked) {
    return { action: "HOLD", reason: sniperLock.reason, source: "SNIPER_LOCK" };
  }

  // Shared SMC result — fetched once in SNIPER_ELITE, reused in KILLER & STEP 8
  let smcForElite = null;

  // STEP 5.5 — SNIPER ELITE (UPGRADE 5): priority di atas SMC flow biasa
  if (process.env.SNIPER_ENABLED !== "false") {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const dailyTrades = tradeHistory.filter(t =>
      (t.exitTime || t.timestamp || 0) >= todayStart.getTime()).length;
    const lastTr  = tradeHistory[tradeHistory.length - 1];
    const lastPnL = lastTr?.pnlUSDT || 0;
    try {
      smcForElite = await featureEngine.callF2({
        klines_4h:  klines_4h || klines_1h,
        klines_1h:  klines_1h || klines_15m,
        klines_15m,
        klines_5m:  klines_1m,
        price,
        htfBias:    htf,
      });
    } catch {}

    const elite = sniperEliteEntry({
      htf, judas, smc: smcForElite, kz,
      tradeHistory, dailyTrades, lastTradePnL: lastPnL,
    });

    if (elite) {
      let eliteComp = null;
      try {
        eliteComp = await featureEngine.smartCompounder({ equity, base_size: 15, tradeHistory });
      } catch {}
      if (eliteComp && !eliteComp.approved) {
        return { action: "HOLD", reason: "Compounder block (SNIPER_ELITE): " + (eliteComp.anti_tilt_reason || "tilt"), source: "COMPOUNDER_BLOCK" };
      }

      const entryP = elite.entry || price;
      const slP    = elite.sl    || entryP * (elite.action === "LONG" ? 0.993 : 1.007);
      const r      = Math.abs(entryP - slP);
      elite.tp1 = elite.action === "LONG" ? entryP + r * 2  : entryP - r * 2;
      elite.tp2 = elite.action === "LONG" ? entryP + r * 5  : entryP - r * 5;
      elite.tp3 = elite.action === "LONG" ? entryP + r * 10 : entryP - r * 10;
      return { ...elite, leverage: 10 };
    }
  }

  // STEP 5.6 — SNIPER KILLER (UPGRADE D): higher priority than Judas
  if (process.env.SNIPER_ENABLED !== "false") {
    // Reuse smcForElite from STEP 5.5 to avoid redundant callF2
    const smcForKiller = smcForElite;

    const killer = sniperKiller({ htf, smc: smcForKiller, judas, liquidity, kz });
    if (killer) {
      let killerComp = null;
      try {
        killerComp = await featureEngine.smartCompounder({ equity, base_size: 15, tradeHistory });
      } catch {}
      if (killerComp && !killerComp.approved) {
        return { action: "HOLD", reason: "Compounder block (SNIPER_KILLER): " + (killerComp.anti_tilt_reason || "tilt"), source: "COMPOUNDER_BLOCK" };
      }

      // Daily trade cap for SNIPER_KILLER (max 2)
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const dailyKiller = tradeHistory.filter(t =>
        t.setup === "SNIPER_KILLER" && (t.exitTime || t.timestamp || 0) >= todayStart.getTime()
      ).length;
      if (dailyKiller < 2) {
        return killer;
      }
    }
  }

  // STEP 6: Judas override (high-priority fake-move signal)
  // RELAXED: reduced from 80→60 and HTF from 65→50 for more sweep entries
  if (judas?.judas_detected && (judas.confidence || 0) >= 60 && judas.signal && judas.signal !== "HOLD" && (htf?.confidence || 0) >= 50) {
    // Anti-FOMO (UPGRADE 6)
    if (judas?.entry_price && checkPriceMoved(price, judas.entry_price, 0.015)) {
      return { action: "HOLD", reason: "Anti-FOMO: Judas entry zone passed", source: "ANTI_FOMO" };
    }

    // Asian session filter — require conf>=85 during ASIAN_KZ (low liquidity)
    if (kz.current_kill_zone === "ASIAN_KZ" && (judas.confidence || 0) < 85) {
      return { action: "HOLD", reason: `Judas in Asian session requires conf>=85, got ${judas.confidence}`, source: "ASIAN_KZ_JUDAS_FILTER" };
    }

    const decisionScore = buildAdaptiveScore({ htf, smc: null, momentum, judas, regime });
    const ct = isCounterTrend(judas.signal, htf, regime);
    if (ct.isCounter) {
      if (ct.againstRegime) {
        return { action: "HOLD", reason: `Counter-trend blocked — regime ${regime?.regime}`, source: "CT_HARD_BLOCK" };
      }
      if (decisionScore < 90) {
        return { action: "HOLD", reason: `Counter-trend blocked — score ${decisionScore} < 90`, source: "CT_SCORE_BLOCK" };
      }
    }

    // Final decision filter (UPGRADE 7+8): score >= 60 required; orderbook must not oppose
    // RELAXED: reduced from 75 to 60 for more entries
    const minScore = 60;
    if (decisionScore < minScore) {
      return { action: "HOLD", reason: `Score ${decisionScore} < ${minScore}`, source: "LOW_SCORE" };
    }
    if (obBias !== "NEUTRAL" && obBias !== judas.signal.replace("LONG", "BULLISH").replace("SHORT", "BEARISH")) {
      return { action: "HOLD", reason: `Orderbook ${obBias} opposes ${judas.signal} entry`, source: "OB_FILTER" };
    }

    if (global.botState) global.botState.decisionScore = decisionScore;

    // Trade memory gate (UPGRADE 3)
    const judasSetup = judas.type || "JUDAS_SWING";
    if (!tradeMemory.isSetupAllowed(judasSetup)) {
      return { action: "HOLD", reason: `Setup ${judasSetup} blocked by trade memory (WR < 30%)`, source: "TRADE_MEMORY" };
    }

    let size = null;
    try {
      const comp = await featureEngine.smartCompounder({ equity, base_size: 15, tradeHistory });
      if (comp && !comp.approved) {
        return { action: "HOLD", reason: "Compounder block (Judas): " + (comp.anti_tilt_reason || "tilt"), source: "COMPOUNDER_BLOCK" };
      }
      size = comp?.recommended_size_usdt || 15;
    } catch {}

    return {
      action:     judas.signal,
      setup:      decisionScore >= 90 ? "JUDAS_SWING_SNIPER" : "JUDAS_SWING",
      entry:      judas.entry_price,
      sl:         judas.sl_price,
      tp1:        judas.target_1,
      tp2:        judas.target_2,
      size,
      leverage:   regime?.recommended_leverage || 7,
      confidence: judas.confidence,
      reason:     judas.explanation || "Judas sweep detected",
      source:     "JUDAS",
      counter_trend_warning: ct.isCounter || undefined,
    };
  }

  // STEP 7: Momentum ignition override
  if (momentum?.ignition_detected && (momentum.confidence || 0) >= 80) {
    // Anti-FOMO (UPGRADE 6)
    if (momentum?.entry_price && checkPriceMoved(price, momentum.entry_price, 0.015)) {
      return { action: "HOLD", reason: "Anti-FOMO: Momentum entry zone passed", source: "ANTI_FOMO" };
    }

    const decisionScore = buildAdaptiveScore({ htf, smc: null, momentum, judas: null, regime });
    const ct = isCounterTrend(momentum.direction, htf, regime);
    if (ct.isCounter) {
      if (ct.againstRegime) {
        return { action: "HOLD", reason: `Counter-trend blocked — regime ${regime?.regime}`, source: "CT_HARD_BLOCK" };
      }
      if (decisionScore < 90) {
        return { action: "HOLD", reason: `Counter-trend blocked — score ${decisionScore} < 90`, source: "CT_SCORE_BLOCK" };
      }
    }

    // Final decision filter
    // RELAXED: reduced from 75 to 60
    if (decisionScore < 60) {
      return { action: "HOLD", reason: `Score ${decisionScore} < 60`, source: "LOW_SCORE" };
    }
    if (obBias !== "NEUTRAL" && obBias !== momentum.direction.replace("LONG", "BULLISH").replace("SHORT", "BEARISH")) {
      return { action: "HOLD", reason: `Orderbook ${obBias} opposes ${momentum.direction} entry`, source: "OB_FILTER" };
    }

    if (global.botState) global.botState.decisionScore = decisionScore;

    // Trade memory gate (UPGRADE 3)
    const momSetup = momentum.direction ? `MOMENTUM_${momentum.direction}` : "MOMENTUM_IGNITION";
    if (!tradeMemory.isSetupAllowed(momSetup)) {
      return { action: "HOLD", reason: `Setup ${momSetup} blocked by trade memory (WR < 30%)`, source: "TRADE_MEMORY" };
    }

    return {
      action:     momentum.direction,
      setup:      "MOMENTUM_IGNITION",
      entry:      momentum.entry_price,
      sl:         momentum.sl_price,
      tp1:        momentum.tp1_price,
      tp2:        momentum.tp2_price,
      confidence: momentum.confidence,
      reason:     `Momentum ignition: ${momentum.checks?.volume_spike ? "vol+" : ""} ${momentum.estimated_move_pct?.toFixed(1)}% move expected`,
      source:     "MOMENTUM",
      counter_trend_warning: ct.isCounter || undefined,
    };
  }

  // STEP 8: Normal SMC flow
  // RELAXED: reduced from 70 to 55 for more responsive entries
  if ((htf?.confidence || 0) >= 55) {
    // Reuse smcForElite from STEP 5.5 if available; only call callF2 if null
    let smc = smcForElite;
    if (!smc) {
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
    }

    // RELAXED: reduced from 65 to 50 for more SMC entries
    if (smc?.signal !== "HOLD" && (smc?.confluence_score || 0) >= 50) {
      // Anti-FOMO (UPGRADE 6)
      if (smc?.entry_zone && checkPriceMoved(price, smc.entry_zone, 0.012)) {
        return { action: "HOLD", reason: "Anti-FOMO: price moved >1.2% from zone", source: "ANTI_FOMO" };
      }

      // Market state gate (UPGRADE 2): RANGING → block trend-follow entries
      if (disableTrendEntry && smc?.setup_type === "TREND") {
        return { action: "HOLD", reason: "Trend entry disabled in ranging market", source: "MARKET_STATE_GATE" };
      }

      const decisionScore = buildAdaptiveScore({ htf, smc, momentum, judas, regime });
      const ct = isCounterTrend(smc.signal, htf, regime);
      if (ct.isCounter) {
        if (ct.againstRegime) {
          return { action: "HOLD", reason: `Counter-trend blocked — regime ${regime?.regime}`, source: "CT_HARD_BLOCK" };
        }
        if (decisionScore < 90) {
          return { action: "HOLD", reason: `Counter-trend blocked — score ${decisionScore} < 90`, source: "CT_SCORE_BLOCK" };
        }
      }

      // Final decision filter (UPGRADE 7+8)
      // RELAXED: reduced from 75 to 60
      if (decisionScore < 60) {
        return { action: "HOLD", reason: `Score ${decisionScore} < 60`, source: "LOW_SCORE" };
      }
      if (obBias !== "NEUTRAL" && obBias !== smc.signal.replace("LONG", "BULLISH").replace("SHORT", "BEARISH")) {
        return { action: "HOLD", reason: `Orderbook ${obBias} opposes ${smc.signal} entry`, source: "OB_FILTER" };
      }

      if (global.botState) global.botState.decisionScore = decisionScore;

      // Trade memory gate (UPGRADE 3)
      const smcSetup = smc.setup_type || "SMC";
      if (!tradeMemory.isSetupAllowed(smcSetup)) {
        return { action: "HOLD", reason: `Setup ${smcSetup} blocked by trade memory (WR < 30%)`, source: "TRADE_MEMORY" };
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

      // UPGRADE 2 gate: skip sniper in TRENDING market (enter at market instead)
      if (disableSniperEntry && sniper?.sniper_available) {
        sniper = null;
      }

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

      // UPGRADE C — Smart Entry confluence check
      const smartEntry = buildSmartEntry({ htf, smc, liquidity, score: decisionScore });
      if (smartEntry) {
        return { ...smartEntry, leverage: finalRisk.approved_leverage, size: 15 };
      }

      // Regular SMC entry
      let size = 15;
      try {
        const comp = await featureEngine.smartCompounder({ equity, base_size: 15, tradeHistory });
        if (comp && !comp.approved) {
          return { action: "HOLD", reason: "Compounder block (SMC): " + (comp.anti_tilt_reason || "tilt"), source: "COMPOUNDER_BLOCK" };
        }
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

  // STEP 9: No valid AI signal
  return { action: "HOLD", reason: "No valid signal from AI analysis", source: "ORCHESTRATOR_HOLD" };
}

module.exports = { orchestrate };
