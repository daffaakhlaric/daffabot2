/**
 * SUPABASE DATA LAYER — DAFFABOT2
 * ─────────────────────────────────────────────────────────────
 * Production-safe, fully non-blocking.
 * Every function is async + try/catch.
 * Failures are logged only — NEVER break trading loop.
 *
 * Tables:
 *   trades          — closed positions (full snapshot)
 *   signals_log     — every entry evaluation (approved + rejected)
 *   bot_stats       — rolling session stats (upsert)
 *   ai_learning     — ML feature rows per trade
 *   equity_history  — balance curve (~every 10s)
 */

"use strict";

const { createClient } = require("@supabase/supabase-js");

// ── Init ──────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

let supabase = null;
let _enabled = false;

function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[SUPABASE] Disabled — SUPABASE_URL or SUPABASE_SERVICE_KEY not set in .env");
    return;
  }
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
    _enabled = true;
    console.log("[SUPABASE] Connected ✅");
  } catch (err) {
    console.error("[SUPABASE] Init failed:", err.message);
  }
}

function isEnabled() { return _enabled && supabase !== null; }

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Generate deterministic trade_id from symbol + open_time.
 * Stable across restarts — no duplicates on re-insert.
 */
function makeTradeId(symbol, openTime) {
  const ts = new Date(openTime).getTime();
  return `${symbol}_${ts}`;
}

/**
 * Generate deterministic signal_id from symbol + timestamp.
 */
function makeSignalId(symbol, ts) {
  return `sig_${symbol}_${new Date(ts).getTime()}`;
}

/**
 * Estimate taker fee for both sides.
 * Bitget USDT-M taker: 0.06% per side → 0.12% round-trip
 */
function estimateFee(notionalUsdt) {
  return parseFloat((notionalUsdt * 0.0012).toFixed(6));
}

/**
 * Map close reason string → clean exit_type bucket.
 */
function mapExitType(reason) {
  if (!reason) return "UNKNOWN";
  const r = reason.toUpperCase();
  if (r.includes("HARD_STOP"))              return "HARD_SL";
  if (r.includes("TRAILING_STOP_PROFIT"))   return "TRAILING_TP";  // before STOP_LOSS check
  if (r.includes("LOCK_PROFIT_STOP"))       return "TRAILING_TP";
  if (r.includes("BREAKEVEN_STOP"))         return "BREAKEVEN_STOP";
  if (r === "STOP_LOSS")                    return "VIRTUAL_SL";   // exact match only
  if (r.includes("STOP_LOSS"))              return "VIRTUAL_SL";
  if (r.includes("TRAILING"))               return "TRAILING_TP";
  if (r.includes("TAKE_PROFIT"))            return "TAKE_PROFIT";
  if (r === "DEAD_TRADE_PROFIT")                return "DEAD_TRADE_PROFIT";
  if (r === "DEAD_TRADE_CUT")                   return "DEAD_TRADE_CUT";
  if (r.includes("DEAD_TRADE") || r.includes("TIMEOUT")) return "TIMEOUT";
  if (r.includes("RUNNER"))                 return "RUNNER";
  if (r.includes("PROFIT_RETURN"))          return "PROFIT_RETURN";
  if (r.includes("MICRO_PROFIT"))           return "MICRO_PROFIT";
  if (r.includes("MOMENTUM"))               return "EARLY_EXIT";
  if (r.includes("FORCE_CLOSE"))            return "FORCE_CLOSE";
  if (r.includes("PARTIAL"))               return "PARTIAL";
  return "OTHER";
}

/**
 * EMA trend label
 */
function emaTrend(ema9, ema21) {
  if (!ema9 || !ema21) return null;
  return ema9 > ema21 ? "BULLISH" : "BEARISH";
}

/**
 * Safe float — returns null if NaN/undefined
 */
function sf(v, decimals = 8) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

// ─────────────────────────────────────────────────────────────
// In-memory trade state tracker
// Tracks max_profit, max_drawdown for the active trade.
// Call updateTradeTracker() every tick with current rawProfitPct.
// ─────────────────────────────────────────────────────────────
const _tracker = {
  tradeId:        null,
  maxProfitPct:   0,
  maxDrawdownPct: 0,
};

/**
 * Called every tick when a position is open.
 * @param {string} tradeId  - trade_id of the current open trade
 * @param {number} rawProfitPct - current raw profit% (no leverage)
 */
function updateTradeTracker(tradeId, rawProfitPct) {
  if (_tracker.tradeId !== tradeId) {
    // New trade — reset
    _tracker.tradeId        = tradeId;
    _tracker.maxProfitPct   = rawProfitPct;
    _tracker.maxDrawdownPct = rawProfitPct;
    return;
  }
  if (rawProfitPct > _tracker.maxProfitPct)   _tracker.maxProfitPct   = rawProfitPct;
  if (rawProfitPct < _tracker.maxDrawdownPct) _tracker.maxDrawdownPct = rawProfitPct;
}

/**
 * Returns current tracker snapshot and resets for next trade.
 */
function consumeTracker() {
  const snap = {
    maxProfitPct:   _tracker.maxProfitPct,
    maxDrawdownPct: _tracker.maxDrawdownPct,
  };
  _tracker.tradeId        = null;
  _tracker.maxProfitPct   = 0;
  _tracker.maxDrawdownPct = 0;
  return snap;
}

// ─────────────────────────────────────────────────────────────
// 1. saveTrade()
// Called on trade CLOSE.
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} p  - all trade data, assembled in closePosition()
 *
 * Required fields in p:
 *   symbol, side, entryPrice, exitPrice, size, leverage, notionalUSDT
 *   openTime, closeTime, pnlPct, pnlUSDT, reason, dryRun
 *
 * Optional enrichment:
 *   entryIndicators, exitIndicators, smcData, claudeFilter, phase, stats
 */
async function saveTrade(p) {
  if (!isEnabled()) return;
  try {
    const tradeId    = makeTradeId(p.symbol, p.openTime);
    const durationSec = p.openTime && p.closeTime
      ? Math.round((new Date(p.closeTime) - new Date(p.openTime)) / 1000)
      : null;
    const feeUsdt    = estimateFee(p.notionalUSDT || 0);
    const netProfit  = sf((p.pnlUSDT || 0) - feeUsdt, 6);
    const result     = (p.pnlUSDT || 0) > 0 ? "WIN" : (p.pnlUSDT || 0) < 0 ? "LOSS" : "BE";
    const tracker    = consumeTracker();

    const ei = p.entryIndicators || {};   // entry snapshot
    const xi = p.exitIndicators  || {};   // exit snapshot
    const sc = p.smcData         || {};   // SMC signals at entry
    const cf = p.claudeFilter    || {};   // AI filter result
    const ph = p.phase           || {};   // phase indicator result
    const st = p.stats           || {};   // bot stats at close

    const fearGreed = ei.fearGreed || p.fearGreed;

    const row = {
      trade_id:        tradeId,
      symbol:          p.symbol,
      side:            p.side,
      pair_mode:       p.pairMode   || null,
      regime:          p.regime     || null,

      entry_price:     sf(p.entryPrice, 8),
      exit_price:      sf(p.exitPrice,  8),
      size:            sf(p.size, 6),
      leverage:        parseInt(p.leverage) || null,
      notional_usdt:   sf(p.notionalUSDT, 4),
      order_type:      p.orderType  || null,
      order_mode:      p.orderMode  || null,

      open_time:       new Date(p.openTime).toISOString(),
      close_time:      new Date(p.closeTime).toISOString(),
      duration_sec:    durationSec,

      pnl_pct:         sf(p.pnlPct, 4),
      pnl_usdt:        sf(p.pnlUSDT, 6),
      fee_usdt:        sf(feeUsdt, 6),
      net_profit_usdt: netProfit,
      result,
      close_reason:    p.reason   || null,
      exit_type:       mapExitType(p.reason),

      breakeven_set:     p.breakevenSet    || false,
      runner_activated:  p.runnerActivated || false,
      partial_closed:    p.partialClosed   || false,
      lock_level:        p.lockLevel       ?? null,
      was_profitable:    p.wasProfit       ?? null,

      max_profit_pct:    sf(tracker.maxProfitPct,   4),
      max_drawdown_pct:  sf(tracker.maxDrawdownPct, 4),

      // Entry snapshot
      entry_rsi:          sf(ei.rsi, 2),
      entry_ema9:         sf(ei.ema9, 8),
      entry_ema21:        sf(ei.ema21, 8),
      entry_ema_trend:    emaTrend(ei.ema9, ei.ema21),
      entry_volume_ratio: sf(ei.volumeRatio, 4),
      entry_atr_pct:      sf(ei.atrPct, 4),
      entry_bb_pct_b:     sf(ei.bbPctB, 4),
      entry_bb_bandwidth: sf(ei.bbBandwidth, 4),
      entry_bb_position:  ei.bbPosition  || null,
      entry_vwap_pct:     sf(ei.vwapPct, 4),
      entry_squeeze:      ei.squeeze     ?? null,

      entry_session:      ei.session     || p.session   || null,
      entry_fear_greed:   fearGreed?.value ? parseInt(fearGreed.value) : null,
      entry_fear_greed_class: fearGreed?.classification || null,
      entry_funding_rate: sf(ei.fundingRate, 6),
      entry_orderbook_bid_ask_ratio: sf(ei.orderbookBidAskRatio, 4),
      entry_orderbook_spread: sf(ei.orderbookSpread, 6),

      // SMC at entry
      entry_smc_mode:    sc.smcMode    || cf.smcMode   || null,
      entry_htf_trend:   sc.htfTrend   || null,
      entry_htf_strength: sc.htfStrength || null,
      entry_inducement:  sc.inducement?.valid     ?? null,
      entry_liq_grab:    sc.liquidityGrab?.detected ?? null,
      entry_choch:       sc.choch?.detected         ?? null,
      entry_in_fvg:      sc.inFVG?.inFVG            ?? null,
      entry_candle_ok:   sc.candleOK?.confirmed      ?? null,
      entry_bos:         sc.bos?.detected            ?? null,
      entry_sweep:       sc.sweep?.detected          ?? null,
      entry_sd_zone:     sc.sdZone?.detected         ?? null,
      entry_smc_score:   sc.smcScore  ?? null,
      entry_rev_score:   sc.revScore?.score          ?? null,
      entry_rev_grade:   sc.revScore?.grade          ?? null,

      entry_score:       p.entryScore   ?? sc.entryScore ?? null,
      entry_mode:        p.entryMode    || null,
      ai_confidence:     cf.confidence  ?? null,
      ai_decision:       cf.approve ? p.side : "HOLD",
      ai_risk:           cf.risk        || null,
      ai_direct_entry:   cf.direct      ?? null,
      ai_reasoning:      cf.reason      ? cf.reason.slice(0, 500) : null,

      phase:             ph.phase       || null,
      phase_risk_mult:   sf(ph.riskMultiplier, 2),
      loss_streak_at_entry: st.lossStreak ?? null,

      // Exit snapshot
      exit_rsi:          sf(xi.rsi, 2),
      exit_ema_trend:    emaTrend(xi.ema9, xi.ema21),
      exit_volume_ratio: sf(xi.volumeRatio, 4),
      exit_momentum:     xi.momentum  || null,
      exit_hold_minutes: durationSec  != null ? sf(durationSec / 60, 2) : null,

      dry_run:           p.dryRun ?? true,
    };

    const { error } = await supabase
      .from("trades")
      .upsert(row, { onConflict: "trade_id" });

    if (error) {
      console.error("[SUPABASE] saveTrade error:", error.message);
    } else {
      console.log(`[SUPABASE] Trade saved: ${tradeId} (${result} ${sf(p.pnlUSDT,4)} USDT)`);
      // Async: save AI learning row in background
      _saveAILearning(row, tradeId).catch(() => {});
    }

  } catch (err) {
    console.error("[SUPABASE] saveTrade exception:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 2. saveSignal()
// Called every time bot evaluates an entry (open or reject).
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 *   action, approved, rejectReason, symbol, price, indicators,
 *   smcData, claudeFilter, session, phase, stats, openedTradeId, dryRun
 */
async function saveSignal(p) {
  if (!isEnabled()) return;
  try {
    const now = new Date().toISOString();
    const signalId = makeSignalId(p.symbol || "UNKNOWN", now);
    const ei = p.indicators  || {};
    const sc = p.smcData     || {};
    const cf = p.claudeFilter || {};
    const ph = p.phase       || {};
    const st = p.stats       || {};

    const row = {
      signal_id:    signalId,
      signal_time:  now,
      symbol:       p.symbol       || null,
      pair_mode:    p.pairMode     || null,
      session:      p.session      || ei.session || null,

      action:       p.action       || "HOLD",
      approved:     p.approved     ?? false,
      reject_reason: p.rejectReason ? p.rejectReason.slice(0, 300) : null,

      price:        sf(p.price, 8),
      rsi:          sf(ei.rsi, 2),
      ema9:         sf(ei.ema9, 8),
      ema21:        sf(ei.ema21, 8),
      ema_trend:    emaTrend(ei.ema9, ei.ema21),
      volume_ratio: sf(ei.volumeRatio, 4),
      atr_pct:      sf(ei.atrPct, 4),
      bb_pct_b:     sf(ei.bbPctB, 4),
      bb_bandwidth: sf(ei.bbBandwidth, 4),
      bb_squeeze:   ei.squeeze ?? null,
      vwap_pct:     sf(ei.vwapPct, 4),
      funding_rate: sf(ei.fundingRate, 6),
      fear_greed:   ei.fearGreed?.value   ? parseInt(ei.fearGreed.value) : null,
      fear_greed_class: ei.fearGreed?.classification || null,
      orderbook_bid_ask_ratio: sf(ei.orderbookBidAskRatio, 4),
      orderbook_spread: sf(ei.orderbookSpread, 6),
      regime:       p.regime  || sc.regime || null,

      htf_trend:    sc.htfTrend  || null,
      htf_strength: sc.htfStrength || null,
      trade_side:   sc.tradeSide || null,
      inducement:   sc.inducement?.valid      ?? null,
      liq_grab:     sc.liquidityGrab?.detected ?? null,
      choch:        sc.choch?.detected         ?? null,
      in_fvg:       sc.inFVG?.inFVG            ?? null,
      candle_ok:    sc.candleOK?.confirmed      ?? null,
      bos:          sc.bos?.detected            ?? null,
      sweep:        sc.sweep?.detected          ?? null,
      sd_zone:      sc.sdZone?.detected         ?? null,
      smc_score:    sc.smcScore ?? null,
      smc_mode:     sc.smcMode  || null,
      rev_score:    sc.revScore?.score ?? null,
      rev_grade:    sc.revScore?.grade ?? null,

      entry_score:  p.entryScore ?? null,
      entry_mode:   p.entryMode  || null,
      ai_confidence: cf.confidence ?? null,
      ai_direct:    cf.direct     ?? null,
      ai_reasoning: cf.reason ? cf.reason.slice(0, 500) : null,
      conf_threshold: p.confThreshold ?? null,

      phase:        ph.phase     || null,
      loss_streak:  st.lossStreak ?? 0,

      opened_trade_id: p.openedTradeId || null,
      dry_run:      p.dryRun ?? true,
    };

    const { error } = await supabase
      .from("signals_log")
      .insert(row);

    if (error) {
      console.error("[SUPABASE] saveSignal error:", error.message);
    }

  } catch (err) {
    console.error("[SUPABASE] saveSignal exception:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. updateStats()
// Upsert bot_stats. Called after every trade close.
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 *   stats (bot stats), state (bot state), tradeLog, dryRun, startTime
 */
async function updateStats(p) {
  if (!isEnabled()) return;
  try {
    const stats    = p.stats    || {};
    const state    = p.state    || {};
    const tradeLog = p.tradeLog || [];
    const dryRun   = p.dryRun   ?? true;
    const key      = dryRun ? "dry_run" : "live";

    // Compute profit factor from tradeLog
    const closedTrades = tradeLog.filter(t => t.type === "CLOSE");
    let grossWin = 0, grossLoss = 0;
    let countSL = 0, countTP = 0, countTimeout = 0, countTrailing = 0, countHardSL = 0, countBE = 0, countRunner = 0;
    let pnlLondon = 0, pnlNY = 0, pnlAsia = 0;
    let pnlBTC = 0, pnlPEPE = 0, tradesBTC = 0, tradesPEPE = 0;
    let tradesTrain = 0, tradesStable = 0, tradesProfit = 0, tradesMarketBad = 0;
    let sumDuration = 0, countDuration = 0;
    let sumEntryScore = 0, countEntryScore = 0;
    let sumAIConf = 0, countAIConf = 0;

    for (const t of closedTrades) {
      const pnl = t.pnlUSDT || 0;
      if (pnl > 0) grossWin  += pnl;
      else         grossLoss += Math.abs(pnl);

      const r = (t.reason || "").toUpperCase();
      if (r.includes("HARD_STOP"))   countHardSL++;
      else if (r.includes("STOP_LOSS")) countSL++;
      if (r.includes("TAKE_PROFIT")) countTP++;
      if (r.includes("TIMEOUT") || r.includes("DEAD_TRADE")) countTimeout++;
      if (r.includes("TRAILING"))    countTrailing++;
      if (r.includes("BREAKEVEN"))   countBE++;
      if (r.includes("RUNNER"))      countRunner++;

      if (t.session === "LONDON")   pnlLondon += pnl;
      if (t.session === "NEW_YORK") pnlNY     += pnl;
      if (t.session === "ASIA")     pnlAsia   += pnl;

      const sym = (t.symbol || "").toUpperCase();
      if (sym.includes("BTC"))  { pnlBTC  += pnl; tradesBTC++; }
      if (sym.includes("PEPE")) { pnlPEPE += pnl; tradesPEPE++; }

      const ph = (t.phase || "").toUpperCase();
      if (ph === "TRAINING")   tradesTrain++;
      if (ph === "STABLE")     tradesStable++;
      if (ph === "PROFIT")     tradesProfit++;
      if (ph === "MARKET_BAD") tradesMarketBad++;

      if (t.durationSec) { sumDuration += t.durationSec; countDuration++; }
      if (t.entryScore)  { sumEntryScore += t.entryScore; countEntryScore++; }
      if (t.aiConfidence) { sumAIConf += t.aiConfidence; countAIConf++; }
    }

    const profitFactor = grossLoss > 0 ? sf(grossWin / grossLoss, 2) : (grossWin > 0 ? 999 : 0);
    const totalTrades  = stats.totalTrades || 0;
    const wins         = stats.wins        || 0;
    const losses       = stats.losses      || 0;
    const winRate      = totalTrades > 0 ? sf(wins / totalTrades * 100, 1) : 0;

    const row = {
      stat_key:          key,
      total_trades:      totalTrades,
      wins,
      losses,
      win_rate:          winRate,
      total_pnl_usdt:    sf(stats.totalPnL, 4),
      total_net_profit:  sf((stats.totalPnL || 0) - estimateFee((state.totalAccountBalance || 0) * 0.01), 4),
      max_drawdown_usdt: sf(Math.abs(stats.maxDrawdown || 0), 4),
      profit_factor:     profitFactor,

      win_streak:        stats.winStreak  || 0,
      loss_streak:       stats.lossStreak || 0,
      max_win_streak:    stats.maxWinStreak  || 0,
      max_loss_streak:   stats.maxLossStreak || 0,

      avg_profit_pct:    sf(stats.avgProfitPct, 2),
      avg_loss_pct:      sf(stats.avgLossPct, 2),
      avg_duration_sec:  countDuration > 0 ? Math.round(sumDuration / countDuration) : null,
      avg_entry_score:   countEntryScore > 0 ? sf(sumEntryScore / countEntryScore, 1) : null,
      avg_ai_confidence: countAIConf > 0 ? sf(sumAIConf / countAIConf, 1) : null,

      count_stop_loss:   countSL,
      count_take_profit: countTP,
      count_timeout:     countTimeout,
      count_trailing_tp: countTrailing,
      count_hard_sl:     countHardSL,
      count_breakeven:   countBE,
      count_runner:      countRunner,

      pnl_london:        sf(pnlLondon, 4),
      pnl_new_york:      sf(pnlNY, 4),
      pnl_asia:          sf(pnlAsia, 4),

      pnl_btc:           sf(pnlBTC, 4),
      pnl_pepe:          sf(pnlPEPE, 4),
      trades_btc:        tradesBTC,
      trades_pepe:       tradesPEPE,

      trades_training:   tradesTrain,
      trades_stable:     tradesStable,
      trades_profit:     tradesProfit,
      trades_market_bad: tradesMarketBad,

      current_phase:     state.phase?.phase || null,
      current_balance:   sf(state.currentBalance, 4),
      peak_balance:      sf(state.peakBalance, 4),
      current_drawdown:  sf((state.peakBalance || 0) - (state.currentBalance || 0), 4),
      active_position:   !!state.activePosition,

      uptime_sec:        p.uptimeSec || null,
      tick_count:        state.tickCount || 0,
      last_trade_time:   p.lastTradeTime ? new Date(p.lastTradeTime).toISOString() : null,
      start_time:        stats.startTime  ? new Date(stats.startTime).toISOString() : null,

      updated_at:        new Date().toISOString(),
    };

    const { error } = await supabase
      .from("bot_stats")
      .upsert(row, { onConflict: "stat_key" });

    if (error) console.error("[SUPABASE] updateStats error:", error.message);

  } catch (err) {
    console.error("[SUPABASE] updateStats exception:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 4. saveEquity()
// Lightweight balance snapshot. Called every ~30 ticks.
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 *   balance, initialBalance, peakBalance, totalPnL, unrealizedPnL,
 *   hasPosition, positionSide, positionPnlPct,
 *   phase, lossStreak, tickCount, symbol, dryRun
 */
async function saveEquity(p) {
  if (!isEnabled()) return;
  try {
    const balance     = p.balance      || 0;
    const initial     = p.initialBalance || balance;
    const peak        = p.peakBalance  || balance;
    const ddUsdt      = sf(peak - balance, 4);
    const ddPct       = initial > 0 ? sf((peak - balance) / initial * 100, 2) : 0;
    const equityPct   = initial > 0 ? sf((balance - initial) / initial * 100, 2) : 0;

    const row = {
      ts:             new Date().toISOString(),
      symbol:         p.symbol        || null,
      balance:        sf(balance, 4),
      initial_balance: sf(initial, 4),
      equity_pct:     equityPct,
      total_pnl:      sf(p.totalPnL || 0, 4),
      unrealized_pnl: sf(p.unrealizedPnL || 0, 4),
      peak_balance:   sf(peak, 4),
      drawdown_usdt:  ddUsdt,
      drawdown_pct:   ddPct,
      has_position:   p.hasPosition   ?? false,
      position_side:  p.positionSide  || null,
      position_pnl_pct: sf(p.positionPnlPct, 2),
      phase:          p.phase         || null,
      loss_streak:    p.lossStreak    || 0,
      tick_count:     p.tickCount     || 0,
      dry_run:        p.dryRun        ?? true,
    };

    const { error } = await supabase
      .from("equity_history")
      .insert(row);

    if (error) console.error("[SUPABASE] saveEquity error:", error.message);

  } catch (err) {
    console.error("[SUPABASE] saveEquity exception:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 5. _saveAILearning() — internal, called from saveTrade
// ─────────────────────────────────────────────────────────────
async function _saveAILearning(tradeRow, tradeId) {
  if (!isEnabled()) return;
  try {
    // Parse open_time to extract hour (WIB = UTC+7) and day_of_week
    const openTs  = new Date(tradeRow.open_time);
    const hourWIB = (openTs.getUTCHours() + 7) % 24;
    const dow     = openTs.getUTCDay();

    const row = {
      trade_id:        tradeId,
      result:          tradeRow.result,
      pnl_usdt:        tradeRow.pnl_usdt,
      pnl_pct:         tradeRow.pnl_pct,

      // Features (normalized where sensible)
      rsi_norm:        tradeRow.entry_rsi     != null ? sf(tradeRow.entry_rsi / 100, 4) : null,
      ema_diff_pct:    tradeRow.entry_ema9 && tradeRow.entry_ema21
                         ? sf((tradeRow.entry_ema9 - tradeRow.entry_ema21) / tradeRow.entry_ema21 * 100, 6)
                         : null,
      volume_ratio:    tradeRow.entry_volume_ratio,
      atr_pct:         tradeRow.entry_atr_pct,
      bb_pct_b:        tradeRow.entry_bb_pct_b,
      vwap_pct:        tradeRow.entry_vwap_pct,
      funding_rate:    tradeRow.entry_funding_rate,
      fear_greed_norm: tradeRow.entry_fear_greed != null ? sf(tradeRow.entry_fear_greed / 100, 4) : null,
      bid_ask_ratio:   tradeRow.entry_orderbook_bid_ask_ratio,

      // Binary
      htf_bullish:     tradeRow.entry_htf_trend === "BULLISH",
      liq_grab:        tradeRow.entry_liq_grab  ?? null,
      choch:           tradeRow.entry_choch      ?? null,
      in_fvg:          tradeRow.entry_in_fvg     ?? null,
      bos:             tradeRow.entry_bos         ?? null,
      bb_squeeze:      tradeRow.entry_squeeze     ?? null,

      // Categorical
      session:         tradeRow.entry_session,
      regime:          tradeRow.regime,
      phase:           tradeRow.phase,
      smc_mode:        tradeRow.entry_smc_mode,
      side:            tradeRow.side,

      // Scores
      smc_score:       tradeRow.entry_smc_score,
      entry_score:     tradeRow.entry_score,
      ai_confidence:   tradeRow.ai_confidence,
      rev_score:       tradeRow.entry_rev_score,

      // Timing
      hour_wib:        hourWIB,
      day_of_week:     dow,
      duration_sec:    tradeRow.duration_sec,

      // Outcome details
      hit_breakeven:   tradeRow.breakeven_set,
      hit_runner:      tradeRow.runner_activated,
      close_reason:    tradeRow.close_reason,
      max_profit_pct:  tradeRow.max_profit_pct,
      max_drawdown_pct: tradeRow.max_drawdown_pct,

      symbol:          tradeRow.symbol,
      dry_run:         tradeRow.dry_run,
    };

    const { error } = await supabase
      .from("ai_learning")
      .upsert(row, { onConflict: "trade_id" });

    if (error) console.error("[SUPABASE] _saveAILearning error:", error.message);

  } catch (err) {
    console.error("[SUPABASE] _saveAILearning exception:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 6. migrateFromTradesJson()
// One-shot migration of existing trades.json into Supabase.
// Run once: node -e "require('./supabaseClient').migrateFromTradesJson()"
// ─────────────────────────────────────────────────────────────

/**
 * Reads existing trades.json and inserts all CLOSE entries into Supabase.
 * Skips entries that already exist (upsert by trade_id).
 * @param {string} filePath  - path to trades.json (default: "./trades.json")
 */
async function migrateFromTradesJson(filePath = "./trades.json") {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) {
    console.error("[MIGRATE] File not found:", filePath);
    return;
  }

  initSupabase();
  if (!isEnabled()) {
    console.error("[MIGRATE] Supabase not enabled. Check SUPABASE_URL + SUPABASE_SERVICE_KEY in .env");
    return;
  }

  let tradeLog;
  try {
    tradeLog = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("[MIGRATE] Failed to parse trades.json:", e.message);
    return;
  }

  const closed = tradeLog.filter(t => t.type === "CLOSE");
  console.log(`[MIGRATE] Found ${closed.length} CLOSE entries to migrate`);

  // Find matching OPEN entry for each CLOSE
  const opens = {};
  for (const t of tradeLog) {
    if (t.type === "OPEN") {
      const key = `${t.side}_${t.time}`;
      opens[key] = t;
    }
  }

  let inserted = 0, skipped = 0;
  for (const close of closed) {
    try {
      // Best-guess open time: match by proximity or use close time as fallback
      const openTime  = close.openTime || close.time;
      const tradeId   = makeTradeId(close.symbol || "PEPEUSDT", openTime);
      const feeUsdt   = estimateFee(close.notionalUSDT || (close.size * close.price) || 0);
      const netProfit = sf((close.pnlUSDT || 0) - feeUsdt, 6);
      const result    = (close.pnlUSDT || 0) > 0 ? "WIN" : (close.pnlUSDT || 0) < 0 ? "LOSS" : "BE";

      const row = {
        trade_id:        tradeId,
        symbol:          close.symbol    || "PEPEUSDT",
        side:            close.side,
        entry_price:     sf(close.entryPrice || close.price, 8),
        exit_price:      sf(close.price, 8),
        size:            sf(close.size, 6),
        leverage:        parseInt(close.leverage) || 5,
        notional_usdt:   sf(close.notionalUSDT, 4),
        open_time:       openTime ? new Date(openTime).toISOString() : new Date(close.time).toISOString(),
        close_time:      new Date(close.time).toISOString(),
        duration_sec:    null,
        pnl_pct:         sf(close.pnlPct || 0, 4),
        pnl_usdt:        sf(close.pnlUSDT || 0, 6),
        fee_usdt:        sf(feeUsdt, 6),
        net_profit_usdt: netProfit,
        result,
        close_reason:    close.reason || null,
        exit_type:       mapExitType(close.reason),
        dry_run:         close.dryRun ?? true,
      };

      const { error } = await supabase
        .from("trades")
        .upsert(row, { onConflict: "trade_id" });

      if (error) {
        console.warn(`[MIGRATE] Skip ${tradeId}: ${error.message}`);
        skipped++;
      } else {
        inserted++;
      }

    } catch (e) {
      console.warn("[MIGRATE] Row error:", e.message);
      skipped++;
    }
  }

  console.log(`[MIGRATE] Done — inserted: ${inserted}, skipped/error: ${skipped}`);
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
module.exports = {
  initSupabase,
  isEnabled,
  // Core functions
  saveTrade,
  saveSignal,
  updateStats,
  saveEquity,
  // Trade tracker
  updateTradeTracker,
  consumeTracker,
  // Migration util
  migrateFromTradesJson,
  // Helpers (exported for testing)
  makeTradeId,
  estimateFee,
  mapExitType,
};
