-- ─────────────────────────────────────────────────────────────
-- DAFFABOT2 — SUPABASE SCHEMA
-- Run this in Supabase SQL Editor → New Query
-- ─────────────────────────────────────────────────────────────

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- TABLE 1: trades
-- Every closed position. One row per trade.
-- ─────────────────────────────────────────────────────────────
create table if not exists trades (
  id                uuid        primary key default gen_random_uuid(),
  trade_id          text        unique,          -- local unique ID (symbol+openTime)

  -- Identity
  symbol            text        not null,        -- BTCUSDT | PEPEUSDT
  side              text        not null,        -- LONG | SHORT
  pair_mode         text,                        -- BTC | PEPE | DUAL
  regime            text,                        -- TREND | RANGE

  -- Execution
  entry_price       numeric     not null,
  exit_price        numeric     not null,
  size              numeric     not null,        -- qty (BTC or PEPE tokens)
  leverage          integer     not null,
  notional_usdt     numeric,                     -- margin * leverage ≈ position value
  order_type        text,                        -- market | limit
  order_mode        text,                        -- MARKET | LIMIT | MARKET_FALLBACK

  -- Timing
  open_time         timestamptz not null,
  close_time        timestamptz not null,
  duration_sec      integer,                     -- computed: close - open

  -- PnL
  pnl_pct           numeric,                     -- leveraged %
  pnl_usdt          numeric,                     -- net usdt change
  fee_usdt          numeric,                     -- estimated fees (0.06% taker both sides)
  net_profit_usdt   numeric,                     -- pnl_usdt - fee_usdt

  -- Classification
  result            text,                        -- WIN | LOSS | BE
  close_reason      text,                        -- STOP_LOSS | TAKE_PROFIT | TRAILING | TIMEOUT | etc.
  exit_type         text,                        -- HARD_SL | VIRTUAL_SL | TRAILING_TP | TIMEOUT | RUNNER | etc.

  -- Trade lifecycle flags
  breakeven_set     boolean     default false,
  runner_activated  boolean     default false,
  partial_closed    boolean     default false,
  lock_level        integer,                     -- 1-4 Dynamic Lock V2 level reached
  was_profitable    boolean,                     -- was in profit at some point

  -- Peak tracking (updated during trade)
  max_profit_pct    numeric,                     -- highest raw profit% reached
  max_drawdown_pct  numeric,                     -- deepest raw drawdown% reached

  -- ── ENTRY SNAPSHOT ───────────────────────────────────────
  entry_rsi         numeric,
  entry_ema9        numeric,
  entry_ema21       numeric,
  entry_ema_trend   text,                        -- BULLISH | BEARISH (ema9 vs ema21)
  entry_volume_ratio numeric,
  entry_atr_pct     numeric,
  entry_bb_pct_b    numeric,                     -- BB %B position (0-1)
  entry_bb_bandwidth numeric,
  entry_bb_position text,                        -- UPPER | LOWER | MIDDLE
  entry_vwap_pct    numeric,                     -- % price vs VWAP
  entry_squeeze     boolean,                     -- BB squeeze active at entry?

  -- Context at entry
  entry_session     text,                        -- LONDON | NEW_YORK | ASIA | OFF
  entry_fear_greed  integer,                     -- 0-100
  entry_fear_greed_class text,                   -- Extreme Fear | Fear | Neutral | Greed | Extreme Greed
  entry_funding_rate numeric,
  entry_orderbook_bid_ask_ratio numeric,
  entry_orderbook_spread numeric,

  -- SMC at entry
  entry_smc_mode    text,                        -- SD_ZONE | FULL_SMC | BOS_DIRECT | BTC_PULLBACK | REVERSAL_ONLY
  entry_htf_trend   text,                        -- BULLISH | BEARISH | SIDEWAYS
  entry_htf_strength text,                       -- STRONG | WEAK | NEUTRAL
  entry_inducement  boolean,
  entry_liq_grab    boolean,
  entry_choch       boolean,
  entry_in_fvg      boolean,
  entry_candle_ok   boolean,
  entry_bos         boolean,
  entry_sweep       boolean,
  entry_sd_zone     boolean,
  entry_smc_score   integer,                     -- 0-5
  entry_rev_score   integer,                     -- 0-100
  entry_rev_grade   text,                        -- A | B | C | D

  -- AI/Score at entry
  entry_score       integer,                     -- 0-100 composite entry score
  entry_mode        text,                        -- TREND_PULLBACK | MOMENTUM
  ai_confidence     integer,                     -- claudeFilter.confidence
  ai_decision       text,                        -- LONG | SHORT | HOLD
  ai_risk           text,                        -- LOW | MEDIUM | HIGH
  ai_direct_entry   boolean,                     -- true = no Claude call (BOS/SD direct)
  ai_reasoning      text,                        -- claudeFilter.reason (short)

  -- Phase at entry
  phase             text,                        -- TRAINING | STABLE | PROFIT | MARKET_BAD
  phase_risk_mult   numeric,                     -- riskMultiplier from phase
  loss_streak_at_entry integer,

  -- ── EXIT SNAPSHOT ────────────────────────────────────────
  exit_rsi          numeric,
  exit_ema_trend    text,                        -- BULLISH | BEARISH
  exit_volume_ratio numeric,
  exit_momentum     text,                        -- STRONG | WEAK | NEUTRAL
  exit_hold_minutes numeric,

  -- Metadata
  dry_run           boolean     default true,
  created_at        timestamptz default now()
);

-- Indexes for common queries
create index if not exists trades_symbol_idx      on trades (symbol);
create index if not exists trades_open_time_idx   on trades (open_time desc);
create index if not exists trades_result_idx      on trades (result);
create index if not exists trades_close_reason_idx on trades (close_reason);
create index if not exists trades_dry_run_idx     on trades (dry_run);


-- ─────────────────────────────────────────────────────────────
-- TABLE 2: signals_log
-- Every time bot evaluates entry (both approved and rejected).
-- Used for AI learning — even HOLD signals matter.
-- ─────────────────────────────────────────────────────────────
create table if not exists signals_log (
  id              uuid        primary key default gen_random_uuid(),
  signal_id       text        unique,            -- symbol+timestamp

  -- Timing
  signal_time     timestamptz not null default now(),
  symbol          text        not null,
  pair_mode       text,
  session         text,

  -- Signal result
  action          text,                          -- LONG | SHORT | HOLD
  approved        boolean,                       -- did bot open a position?
  reject_reason   text,                          -- why rejected (if !approved)

  -- Market state
  price           numeric,
  rsi             numeric,
  ema9            numeric,
  ema21           numeric,
  ema_trend       text,
  volume_ratio    numeric,
  atr_pct         numeric,
  bb_pct_b        numeric,
  bb_bandwidth    numeric,
  bb_squeeze      boolean,
  vwap_pct        numeric,
  funding_rate    numeric,
  fear_greed      integer,
  fear_greed_class text,
  orderbook_bid_ask_ratio numeric,
  orderbook_spread numeric,
  regime          text,

  -- SMC signals
  htf_trend       text,
  htf_strength    text,
  trade_side      text,                          -- BULLISH | BEARISH
  inducement      boolean,
  liq_grab        boolean,
  choch           boolean,
  in_fvg          boolean,
  candle_ok       boolean,
  bos             boolean,
  sweep           boolean,
  sd_zone         boolean,
  smc_score       integer,
  smc_mode        text,
  rev_score       integer,
  rev_grade       text,

  -- Entry quality
  entry_score     integer,
  entry_mode      text,
  ai_confidence   integer,
  ai_direct       boolean,
  ai_reasoning    text,
  conf_threshold  integer,

  -- Phase
  phase           text,
  loss_streak     integer,

  -- Did trade open?
  opened_trade_id text,                          -- FK reference to trades.trade_id

  dry_run         boolean     default true,
  created_at      timestamptz default now()
);

create index if not exists signals_time_idx    on signals_log (signal_time desc);
create index if not exists signals_symbol_idx  on signals_log (symbol);
create index if not exists signals_action_idx  on signals_log (action);
create index if not exists signals_approved_idx on signals_log (approved);


-- ─────────────────────────────────────────────────────────────
-- TABLE 3: bot_stats
-- Single rolling row per bot session + cumulative totals.
-- Upserted on every loop (every ~10s).
-- ─────────────────────────────────────────────────────────────
create table if not exists bot_stats (
  id                  uuid        primary key default gen_random_uuid(),
  stat_key            text        unique not null,  -- 'live' | 'dry_run'

  -- Cumulative
  total_trades        integer     default 0,
  wins                integer     default 0,
  losses              integer     default 0,
  win_rate            numeric,                      -- %
  total_pnl_usdt      numeric     default 0,
  total_net_profit    numeric     default 0,        -- after fees
  max_drawdown_usdt   numeric     default 0,
  profit_factor       numeric,                      -- gross_win / gross_loss

  -- Streaks
  win_streak          integer     default 0,
  loss_streak         integer     default 0,
  max_win_streak      integer     default 0,
  max_loss_streak     integer     default 0,

  -- Averages
  avg_profit_pct      numeric,
  avg_loss_pct        numeric,
  avg_duration_sec    integer,
  avg_entry_score     numeric,
  avg_ai_confidence   numeric,

  -- By close reason
  count_stop_loss     integer     default 0,
  count_take_profit   integer     default 0,
  count_timeout       integer     default 0,
  count_trailing_tp   integer     default 0,
  count_hard_sl       integer     default 0,
  count_breakeven     integer     default 0,
  count_runner        integer     default 0,

  -- Session breakdown
  pnl_london          numeric     default 0,
  pnl_new_york        numeric     default 0,
  pnl_asia            numeric     default 0,

  -- Symbol breakdown
  pnl_btc             numeric     default 0,
  pnl_pepe            numeric     default 0,
  trades_btc          integer     default 0,
  trades_pepe         integer     default 0,

  -- Phase breakdown
  trades_training     integer     default 0,
  trades_stable       integer     default 0,
  trades_profit       integer     default 0,
  trades_market_bad   integer     default 0,

  -- Current state
  current_phase       text,
  current_balance     numeric,
  peak_balance        numeric,
  current_drawdown    numeric,
  active_position     boolean     default false,

  -- Bot health
  uptime_sec          integer,
  tick_count          integer,
  last_trade_time     timestamptz,
  start_time          timestamptz,

  updated_at          timestamptz default now()
);


-- ─────────────────────────────────────────────────────────────
-- TABLE 4: ai_learning
-- Per-trade ML features + label. Used for pattern analysis.
-- Inserted when trade closes.
-- ─────────────────────────────────────────────────────────────
create table if not exists ai_learning (
  id              uuid        primary key default gen_random_uuid(),
  trade_id        text        references trades(trade_id) on delete cascade,

  -- Label (target variable)
  result          text        not null,           -- WIN | LOSS | BE
  pnl_usdt        numeric,
  pnl_pct         numeric,

  -- Feature set (normalized 0-1 where applicable)
  rsi_norm        numeric,                        -- rsi / 100
  ema_diff_pct    numeric,                        -- (ema9 - ema21) / ema21 * 100
  volume_ratio    numeric,
  atr_pct         numeric,
  bb_pct_b        numeric,
  vwap_pct        numeric,
  funding_rate    numeric,
  fear_greed_norm numeric,                        -- fear_greed / 100
  bid_ask_ratio   numeric,

  -- Binary features
  htf_bullish     boolean,
  liq_grab        boolean,
  choch           boolean,
  in_fvg          boolean,
  bos             boolean,
  bb_squeeze      boolean,

  -- Categorical → one-hot friendly
  session         text,
  regime          text,
  phase           text,
  smc_mode        text,
  side            text,

  -- Scores
  smc_score       integer,
  entry_score     integer,
  ai_confidence   integer,
  rev_score       integer,

  -- Timing features
  hour_wib        integer,                        -- 0-23 (WIB = UTC+7)
  day_of_week     integer,                        -- 0=Sun … 6=Sat
  duration_sec    integer,

  -- Outcome details
  hit_breakeven   boolean,
  hit_runner      boolean,
  close_reason    text,
  max_profit_pct  numeric,
  max_drawdown_pct numeric,

  symbol          text,
  dry_run         boolean,
  created_at      timestamptz default now()
);

create index if not exists ai_result_idx    on ai_learning (result);
create index if not exists ai_trade_id_idx  on ai_learning (trade_id);
create index if not exists ai_symbol_idx    on ai_learning (symbol);
create index if not exists ai_session_idx   on ai_learning (session);


-- ─────────────────────────────────────────────────────────────
-- TABLE 5: equity_history
-- Balance snapshot every loop tick (~10s).
-- Used for equity curve chart, drawdown tracking.
-- ─────────────────────────────────────────────────────────────
create table if not exists equity_history (
  id              uuid        primary key default gen_random_uuid(),
  ts              timestamptz not null default now(),
  symbol          text,

  -- Balance
  balance         numeric,                        -- current balance
  initial_balance numeric,                        -- starting balance
  equity_pct      numeric,                        -- % change from initial

  -- Running PnL
  total_pnl       numeric,
  unrealized_pnl  numeric,

  -- Drawdown
  peak_balance    numeric,
  drawdown_usdt   numeric,
  drawdown_pct    numeric,

  -- Position state
  has_position    boolean     default false,
  position_side   text,
  position_pnl_pct numeric,

  -- Bot state
  phase           text,
  loss_streak     integer,
  tick_count      integer,

  dry_run         boolean     default true,
  created_at      timestamptz default now()
);

create index if not exists equity_ts_idx on equity_history (ts desc);

-- Partitioning hint (optional): equity_history will grow fast.
-- Consider adding a cleanup policy in Supabase → keep last 7 days.
