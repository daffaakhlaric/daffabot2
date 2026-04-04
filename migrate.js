/**
 * DAFFABOT2 — MIGRATION SCRIPT
 * ─────────────────────────────────────────────────────────────
 * Migrates local JSON data → Supabase
 *
 * Migrates:
 *   trades.json  → table: trades + ai_learning
 *   stats.json   → table: bot_stats
 *   state.json   → table: equity_history (balance history snapshots)
 *
 * Usage:
 *   node migrate.js             → migrate semua file
 *   node migrate.js --trades    → hanya trades.json
 *   node migrate.js --stats     → hanya stats.json
 *   node migrate.js --equity    → hanya state.json (balance history)
 *   node migrate.js --dry       → preview saja, tidak insert
 *   node migrate.js --clean     → hapus semua data di Supabase dulu, lalu migrate ulang (fresh)
 *
 * Aman dijalankan berkali-kali — upsert by trade_id, tidak duplikat.
 */

"use strict";

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const db   = require("./supabaseClient");

// ── CLI flags ─────────────────────────────────────────────────
const args        = process.argv.slice(2);
const DRY_PREVIEW = args.includes("--dry");
const ONLY_TRADES = args.includes("--trades");
const ONLY_STATS  = args.includes("--stats");
const ONLY_EQUITY = args.includes("--equity");
const CLEAN_FIRST = args.includes("--clean");
const ALL         = !ONLY_TRADES && !ONLY_STATS && !ONLY_EQUITY;

// ── File paths ────────────────────────────────────────────────
const TRADES_FILE = path.resolve("./trades.json");
const STATS_FILE  = path.resolve("./stats.json");
const STATE_FILE  = path.resolve("./state.json");

// ── Helpers ───────────────────────────────────────────────────
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠  File tidak ditemukan: ${filePath} — skip`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`  ✗  Gagal parse ${filePath}: ${e.message}`);
    return null;
  }
}

function fmt(n, d = 4) {
  const v = parseFloat(n);
  return isNaN(v) ? null : parseFloat(v.toFixed(d));
}

function mapExitType(reason) {
  if (!reason) return "UNKNOWN";
  const r = reason.toUpperCase();
  if (r.includes("HARD_STOP"))      return "HARD_SL";
  if (r.includes("STOP_LOSS"))      return "VIRTUAL_SL";
  if (r.includes("TRAILING"))       return "TRAILING_TP";
  if (r.includes("TAKE_PROFIT"))    return "TAKE_PROFIT";
  if (r.includes("TIMEOUT") || r.includes("DEAD_TRADE")) return "TIMEOUT";
  if (r.includes("RUNNER"))         return "RUNNER";
  if (r.includes("PROFIT_RETURN"))  return "PROFIT_RETURN";
  if (r.includes("MICRO_PROFIT"))   return "MICRO_PROFIT";
  if (r.includes("MOMENTUM"))       return "EARLY_EXIT";
  if (r.includes("FORCE_CLOSE"))    return "FORCE_CLOSE";
  if (r.includes("PARTIAL"))        return "PARTIAL";
  return "OTHER";
}

// ─────────────────────────────────────────────────────────────
// MIGRATE TRADES
// ─────────────────────────────────────────────────────────────
async function migrateTrades(supabase) {
  console.log("\n📦 Migrasi trades.json → Supabase...");

  const raw = loadJSON(TRADES_FILE);
  if (!raw || !Array.isArray(raw)) {
    console.log("  — Tidak ada data trades.json");
    return { inserted: 0, skipped: 0 };
  }

  // ── FIFO pairing: pair OPENs with CLOSEs in sequential order ──
  // Walk the log in chronological order.
  // Each OPEN pushes onto a queue per side.
  // Each CLOSE pops the oldest unmatched OPEN with the same side.
  // This prevents the same OPEN from being used for multiple CLOSEs.
  const openQueues = {}; // side → [ openEntry, ... ]
  const pairs = [];      // [ { open, close }, ... ]

  for (const t of raw) {
    if (t.type === "OPEN") {
      if (!openQueues[t.side]) openQueues[t.side] = [];
      openQueues[t.side].push(t);
    } else if (t.type === "CLOSE") {
      const queue = openQueues[t.side] || [];
      const matchedOpen = queue.length > 0 ? queue.shift() : null;
      pairs.push({ open: matchedOpen, close: t });
    }
  }

  const closes = pairs.map(p => p.close);
  console.log(`  → ${closes.length} CLOSE trade ditemukan`);
  console.log(`  → ${pairs.filter(p => p.open).length} pasangan OPEN/CLOSE berhasil`);
  console.log(`  → ${pairs.filter(p => !p.open).length} CLOSE tanpa OPEN (pakai fallback)`);

  if (DRY_PREVIEW) {
    console.log("  [DRY PREVIEW] Contoh 3 baris pertama:");
    pairs.slice(0, 3).forEach(({ open: o, close: c }, i) => {
      const entry = o ? o.price : c.price;
      console.log(`    [${i+1}] ${c.side} entry=${entry} exit=${c.price} | PnL: ${c.pnlUSDT} USDT | Reason: ${c.reason || "?"}`);
    });
    return { inserted: 0, skipped: 0, preview: true };
  }

  let inserted = 0, skipped = 0;

  for (const { open: matchedOpen, close } of pairs) {
    try {
      const closeTs = new Date(close.time);

      const openTime    = matchedOpen?.time || close.openTime || close.time;
      const entryPrice  = matchedOpen?.price || close.entryPrice || close.price;
      // tradeId: use openTime as primary key. If two CLOSEs somehow
      // map to the same openTime (orphan), append closeTime ms as suffix.
      const baseId  = db.makeTradeId(close.symbol || "PEPEUSDT", openTime);
      const tradeId = matchedOpen ? baseId : baseId + "_c" + new Date(close.time).getTime();
      const feeUsdt     = db.estimateFee(close.notionalUSDT || (close.size * close.price) || 0);
      const netProfit   = fmt((close.pnlUSDT || 0) - feeUsdt, 6);
      const pnlUSDT     = close.pnlUSDT || 0;
      const result      = pnlUSDT > 0 ? "WIN" : pnlUSDT < 0 ? "LOSS" : "BE";

      const durationSec = matchedOpen
        ? Math.round((closeTs - new Date(matchedOpen.time)) / 1000)
        : null;

      const symbol   = close.symbol || "PEPEUSDT";
      const isPepe   = symbol.includes("PEPE");
      const leverage = parseInt(close.leverage) || 5;
      const pnlPct   = close.pnlUSDT != null && close.notionalUSDT
        ? fmt(close.pnlUSDT / (close.notionalUSDT / leverage) * 100, 4)
        : null;

      const row = {
        trade_id:        tradeId,
        symbol,
        side:            close.side,
        entry_price:     fmt(entryPrice, 8),
        exit_price:      fmt(close.price, 8),
        size:            fmt(close.size, 6),
        leverage,
        notional_usdt:   fmt(close.notionalUSDT, 4),
        open_time:       new Date(openTime).toISOString(),
        close_time:      closeTs.toISOString(),
        duration_sec:    durationSec,
        pnl_pct:         pnlPct,
        pnl_usdt:        fmt(pnlUSDT, 6),
        fee_usdt:        fmt(feeUsdt, 6),
        net_profit_usdt: netProfit,
        result,
        close_reason:    close.reason || null,
        exit_type:       mapExitType(close.reason),
        // Entry context (stored in position)
        entry_rsi:       fmt(matchedOpen?.rsi, 2),
        entry_ema9:      fmt(matchedOpen?.ema9, 8),
        entry_ema21:     fmt(matchedOpen?.ema21, 8),
        entry_volume_ratio: fmt(matchedOpen?.volumeRatio, 4),
        phase:           close.phase || null,
        regime:          close.regime || null,
        dry_run:         close.dryRun ?? true,
      };

      const { error } = await supabase
        .from("trades")
        .upsert(row, { onConflict: "trade_id" });

      if (error) {
        console.warn(`  ✗ Skip ${tradeId}: ${error.message}`);
        skipped++;
      } else {
        // Save AI learning row
        await saveAILearningRow(supabase, row, tradeId);
        inserted++;
        process.stdout.write(`  ✓ ${inserted}/${closes.length} ${result.padEnd(4)} ${symbol} ${fmt(pnlUSDT, 4)} USDT\r`);
      }

    } catch (e) {
      console.warn(`\n  ✗ Row error: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\n  ✅ Selesai: ${inserted} inserted, ${skipped} skipped/error`);
  return { inserted, skipped };
}

async function saveAILearningRow(supabase, tradeRow, tradeId) {
  try {
    const openTs  = new Date(tradeRow.open_time);
    const hourWIB = (openTs.getUTCHours() + 7) % 24;
    const dow     = openTs.getUTCDay();

    const row = {
      trade_id:        tradeId,
      result:          tradeRow.result,
      pnl_usdt:        tradeRow.pnl_usdt,
      pnl_pct:         tradeRow.pnl_pct,
      rsi_norm:        tradeRow.entry_rsi != null ? fmt(tradeRow.entry_rsi / 100, 4) : null,
      ema_diff_pct:    tradeRow.entry_ema9 && tradeRow.entry_ema21
                         ? fmt((tradeRow.entry_ema9 - tradeRow.entry_ema21) / tradeRow.entry_ema21 * 100, 6)
                         : null,
      volume_ratio:    tradeRow.entry_volume_ratio,
      side:            tradeRow.side,
      session:         tradeRow.entry_session || null,
      regime:          tradeRow.regime || null,
      phase:           tradeRow.phase  || null,
      duration_sec:    tradeRow.duration_sec,
      close_reason:    tradeRow.close_reason,
      hour_wib:        hourWIB,
      day_of_week:     dow,
      symbol:          tradeRow.symbol,
      dry_run:         tradeRow.dry_run,
    };

    await supabase.from("ai_learning").upsert(row, { onConflict: "trade_id" });
  } catch (e) {
    // silent — AI learning is non-critical
  }
}

// ─────────────────────────────────────────────────────────────
// MIGRATE STATS
// ─────────────────────────────────────────────────────────────
async function migrateStats(supabase) {
  console.log("\n📊 Migrasi stats.json → Supabase...");

  const raw = loadJSON(STATS_FILE);
  if (!raw) {
    console.log("  — Tidak ada data stats.json");
    return;
  }

  if (DRY_PREVIEW) {
    console.log("  [DRY PREVIEW] Stats:");
    console.log(`    Trades: ${raw.totalTrades} | Wins: ${raw.wins} | Losses: ${raw.losses}`);
    console.log(`    PnL: ${raw.totalPnL} | MaxDD: ${raw.maxDrawdown}`);
    return;
  }

  const totalTrades = raw.totalTrades || 0;
  const wins        = raw.wins        || 0;
  const losses      = raw.losses      || 0;
  const winRate     = totalTrades > 0 ? fmt(wins / totalTrades * 100, 1) : 0;

  const key = (raw.dryRun === false) ? "live" : "dry_run";

  const row = {
    stat_key:          key,
    total_trades:      totalTrades,
    wins,
    losses,
    win_rate:          winRate,
    total_pnl_usdt:    fmt(raw.totalPnL, 4),
    max_drawdown_usdt: fmt(Math.abs(raw.maxDrawdown || 0), 4),
    win_streak:        raw.winStreak  || 0,
    loss_streak:       raw.lossStreak || 0,
    max_win_streak:    raw.maxWinStreak  || 0,
    max_loss_streak:   raw.maxLossStreak || 0,
    avg_profit_pct:    fmt(raw.avgProfitPct, 2),
    avg_loss_pct:      fmt(raw.avgLossPct, 2),
    start_time:        raw.startTime  ? new Date(raw.startTime).toISOString()  : null,
    updated_at:        new Date().toISOString(),
  };

  const { error } = await supabase
    .from("bot_stats")
    .upsert(row, { onConflict: "stat_key" });

  if (error) {
    console.error(`  ✗ Gagal insert stats: ${error.message}`);
  } else {
    console.log(`  ✅ Stats migrated: ${totalTrades} trades | WR: ${winRate}% | PnL: ${raw.totalPnL} USDT`);
  }
}

// ─────────────────────────────────────────────────────────────
// MIGRATE EQUITY (from state.json balanceHistory)
// ─────────────────────────────────────────────────────────────
async function migrateEquity(supabase) {
  console.log("\n📈 Migrasi state.json (balanceHistory) → Supabase...");

  const raw = loadJSON(STATE_FILE);
  if (!raw) {
    console.log("  — Tidak ada data state.json");
    return;
  }

  const history = raw.balanceHistory || [];
  if (history.length === 0) {
    console.log("  — balanceHistory kosong di state.json");
    return;
  }

  console.log(`  → ${history.length} balance snapshot ditemukan`);

  if (DRY_PREVIEW) {
    console.log("  [DRY PREVIEW] Contoh 3 snapshot:");
    history.slice(0, 3).forEach((h, i) => {
      const ts = h.time ? new Date(h.time).toLocaleString("id-ID") : "?";
      console.log(`    [${i+1}] ${ts} → ${h.balance} USDT`);
    });
    return;
  }

  const initial = raw.initialBalance || history[0]?.balance || 0;
  const peak    = raw.peakBalance    || Math.max(...history.map(h => h.balance || 0));

  let inserted = 0, skipped = 0;
  for (const snap of history) {
    try {
      const balance  = snap.balance || 0;
      const ddUsdt   = fmt(peak - balance, 4);
      const ddPct    = initial > 0 ? fmt((peak - balance) / initial * 100, 2) : 0;
      const eqPct    = initial > 0 ? fmt((balance - initial) / initial * 100, 2) : 0;

      const row = {
        ts:              snap.time ? new Date(snap.time).toISOString() : new Date().toISOString(),
        symbol:          raw.currentPair || "PEPEUSDT",
        balance:         fmt(balance, 4),
        initial_balance: fmt(initial, 4),
        equity_pct:      eqPct,
        total_pnl:       fmt(balance - initial, 4),
        unrealized_pnl:  0,
        peak_balance:    fmt(peak, 4),
        drawdown_usdt:   ddUsdt,
        drawdown_pct:    ddPct,
        has_position:    !!raw.activePosition,
        position_side:   raw.activePosition?.side || null,
        position_pnl_pct: null,
        phase:           raw.phase?.phase || null,
        loss_streak:     0,
        tick_count:      0,
        dry_run:         raw.dryRun ?? true,
      };

      const { error } = await supabase
        .from("equity_history")
        .insert(row);

      if (error) {
        skipped++;
      } else {
        inserted++;
      }

    } catch (e) {
      skipped++;
    }
  }

  console.log(`  ✅ Equity migrated: ${inserted} inserted, ${skipped} skipped`);
}

// ─────────────────────────────────────────────────────────────
// CLEAN TABLES (--clean flag)
// ─────────────────────────────────────────────────────────────
async function cleanTables(supabase) {
  console.log("\n🗑  --clean: Menghapus semua data lama di Supabase...");
  const tables = ["ai_learning", "trades", "equity_history"];
  for (const tbl of tables) {
    // DELETE WHERE id IS NOT NULL = delete all rows
    const { error, count } = await supabase
      .from(tbl)
      .delete()
      .not("id", "is", null);
    if (error) {
      console.warn(`  ⚠  Gagal clean ${tbl}: ${error.message}`);
    } else {
      console.log(`  ✓  ${tbl}: semua baris dihapus`);
    }
  }
  console.log("  ✅ Clean selesai — siap import ulang\n");
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  DAFFABOT2 — MIGRATION: JSON → SUPABASE");
  console.log("═══════════════════════════════════════════════════");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("\n✗ ERROR: SUPABASE_URL atau SUPABASE_SERVICE_KEY tidak ada di .env");
    console.error("  Isi terlebih dahulu di .env:\n  SUPABASE_URL=https://xxxx.supabase.co\n  SUPABASE_SERVICE_KEY=eyJhbGc...");
    process.exit(1);
  }

  if (DRY_PREVIEW) {
    console.log("  ⚠  DRY PREVIEW mode — tidak ada data yang di-insert");
  }
  if (CLEAN_FIRST && !DRY_PREVIEW) {
    console.log("  ⚠  --clean: data lama akan DIHAPUS sebelum import ulang");
  }

  db.initSupabase();

  // Akses internal supabase client
  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // Clean dulu kalau --clean
  if (CLEAN_FIRST && !DRY_PREVIEW) {
    await cleanTables(supabase);
  }

  if (ALL || ONLY_TRADES) await migrateTrades(supabase);
  if (ALL || ONLY_STATS)  await migrateStats(supabase);
  if (ALL || ONLY_EQUITY) await migrateEquity(supabase);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ✅ Migrasi selesai!");
  if (!DRY_PREVIEW) {
    console.log("  Cek data di: https://app.supabase.com → Table Editor");
  }
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
