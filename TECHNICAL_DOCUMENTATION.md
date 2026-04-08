# 🤖 DaffaBot2 - Technical Documentation

## AI Self-Learning Futures Trading System (BTC Only)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Core Components](#core-components)
4. [Trading Strategy](#trading-strategy)
5. [Risk Management](#risk-management)
6. [AI & Machine Learning](#ai--machine-learning)
7. [Order Execution](#order-execution)
8. [Data Layer](#data-layer)
9. [Configuration](#configuration)
10. [API Integrations](#api-integrations)
11. [Dashboard](#dashboard)

---

## 1. System Overview

**DaffaBot** is an AI-powered BTC futures trading bot for Bitget USDT-M perpetual contracts. It combines:
- **Smart Money Concepts (SMC)** for market structure analysis
- **BTC Strategy** for trend pullback trading
- **Claude AI** for decision making and sentiment analysis
- **Self-Learning Engine** that improves from historical trades
- **Professional Risk Management** with dynamic position sizing

### Supported Assets
| Asset | Symbol | Timeframe | Status |
|-------|--------|-----------|--------|
| Bitcoin | BTCUSDT | 15m | ✅ Active (BTC Only) |
| Pepe | PEPEUSDT | 1m | ❌ Disabled |

### Trading Mode
- **DRY RUN**: Simulation (default)
- **LIVE**: Real trading with real funds

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        DaffaBot Architecture                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Dashboard  │    │   Supabase   │    │    Claude    │
│  │    (HTML)    │◄──►│   (Cloud)    │    │     AI       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                  │                   │               │
│         ▼                  ▼                   ▼               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │                  pepe-futures-bot.js                   │     │
│  │                    (Main Engine)                       │     │
│  └──────────────────────────┬───────────────────────────┘     │
│                             │                                  │
│     ┌───────────────────────┼───────────────────────┐        │
│     │                       │                       │        │
│     ▼                       ▼                       ▼        │
│  ┌────────┐           ┌────────────┐          ┌──────────┐   │
│  │  SMC   │           │  Learning  │          │  Phase   │   │
│  │ Engine │           │   Engine   │          │ Indicator│   │
│  └────────┘           └────────────┘          └──────────┘   │
│                                                                 │
│     ┌───────────────────────┼───────────────────────┐        │
│     │                       │                       │        │
│     ▼                       ▼                       ▼        │
│  ┌────────┐           ┌────────────┐          ┌──────────┐   │
│  │  btc   │           │   phase   │          │  entry   │   │
│  │strategy│           │  analysis │          │  filters │   │
│  └────────┘           └────────────┘          └──────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

External APIs:
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Bitget    │  │  CoinGecko   │  │  Fear&Greed │
│   Futures   │  │   (Price)    │  │   (Index)   │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## 3. Core Components

### Main Files

| File | Purpose |
|------|---------|
| `pepe-futures-bot.js` | Main trading engine (7000+ lines) |
| `btcStrategy.js` | BTC 15m strategy with pullback logic |
| `learningEngine.js` | Self-learning from profitable trades |
| `supabaseClient.js` | Cloud data persistence |
| `phaseIndicator.js` | Market phase detection |

---

## 4. Trading Strategy

### Entry Conditions (BTC Pullback Strategy)

```
LONG Entry:
├── HTF BULLISH (EMA20 > EMA50 on 15m)
├── EMA9 > EMA21 (short-term trend)
├── RSI pullback: 42-52 (oversold recovery)
├── Price near EMA21
└── Volume ≥ 0.8x average

SHORT Entry:
├── HTF BEARISH (EMA20 < EMA50 on 15m)
├── EMA9 < EMA21
├── RSI pullback: 48-58 (overbought recovery)
├── Price near EMA21
└── Volume ≥ 0.8x average
```

### Anti-Counter-Trend Filters
- Block entries when momentum contradicts HTF trend
- Require price action confirmation (3+ green/red candles)
- Funding rate alignment check

### ATR Gate
- Block entry if ATR < 0.15% (insufficient volatility)
- Higher ATR = higher confidence

### Loss Streak Protection
| Streak | Action |
|--------|--------|
| 2 losses | 50% size, +10% confidence |
| 3 losses | 50% size, +15% confidence, 1h cooldown |
| 4 losses | 40% size, +20% confidence, test trade only |
| 5 losses | 30% size, +25% confidence, ultra-defensive |

---

## 5. Risk Management

### Position Sizing (Dynamic)
```
Base notional by balance:
├─ ≤ $60   → $4
├─ ≤ $80   → $5
├─ ≤ $100  → $6.5
├─ ≤ $150  → $9
└─ > $150  → 6% of balance

Phase multiplier:
├─ TRAINING   → 0.7x
├─ STABLE     → 1.0x
├─ PROFIT     → 1.3x
└─ MARKET_BAD → 0.5x

Confidence multiplier:
├─ <50% → 0.6x
├─ 50-70% → 1.0x
└─ >70% → 1.2x
```

### Stop Loss & Take Profit (BTC)

| Asset | SL | TP1 | TP2 | Trailing |
|-------|----|----|----|----------|
| BTC | 1.5% | 0.5% | 2.0% | 0.5% |

### Exit Rules

1. **Fee Gate**: Never close with profit < 0.24% (2x fee)
2. **Hard SL**: Force close if loss > 3.0% raw
3. **Breakeven**: Move SL to entry + 0.03% at 0.15% profit
4. **Runner Mode**: Activate at 0.4% profit (tight trailing)
5. **Timeout**: 45min normal, 60min max hold
6. **Dead Trade**: Exit if no momentum after confirmation

---

## 6. AI & Machine Learning

### Claude AI Integration

**Model**: Claude Haiku 4.5

**Input Data**:
- Price, Bid/Ask, Volume 24h, Change 24h
- RSI, EMA9, EMA21, Volume Ratio
- Orderbook bid/ask ratio, spread
- Funding rate
- Fear & Greed Index (value, classification, avg7d, trend)
- BTC context (trend, EMA, ATR, momentum)
- Multi-timeframe analysis (1m, 5m, 15m)
- Bollinger Bands (%B, squeeze status)
- VWAP deviation

**Output**:
```json
{
  "action": "LONG|SHORT|CLOSE|HOLD",
  "leverage": "3-10",
  "confidence": 0-100,
  "sentiment": "BULLISH|BEARISH|NEUTRAL|VOLATILE",
  "stop_loss_pct": "0.5-2.0",
  "take_profit_pct": "1.5-3.0",
  "reasoning": "<30 kata"
}
```

### Self-Learning Engine (SAFE MODE)

**Data Requirements**:
- Minimum 50 total trades
- Minimum 30 valid trades (profit ≥ 0.25%, duration > 30s)
- Minimum 10 winning trades

**Data Quality Checks**:
- Win rate ≥ 45%
- Average profit > average loss
- No excessive micro trades
- Multiple sessions (London, NY)
- Both LONG and SHORT trades
- Multiple RSI ranges

**Learning Output**:
```json
{
  "favorable_conditions": [
    { "condition": "RSI_UNDER_40", "winRate": "75%", "trades": 8 }
  ],
  "avoid_conditions": [
    { "condition": "VOL_LOW", "winRate": "30%", "trades": 5 }
  ],
  "weight_adjustments": {
    "trend": 5,
    "volume": 3,
    "rsi": -2
  },
  "confidence": 65
}
```

**Weight Adjustment Limits**:
- Maximum ±10% per cycle
- Update every 30 minutes
- Only runs in DRY RUN mode

### Phase Indicator

| Phase | Description | Risk Multiplier |
|-------|-------------|-----------------|
| TRAINING | < 10 trades | 0.7x |
| STABLE | 10+ trades, reasonable WR | 1.0x |
| PROFIT | Consistent wins | 1.3x |
| MARKET_BAD | 3+ consecutive losses | 0.5x |

---

## 7. Order Execution

### Maker Order Optimization

1. **Spread Filter**: Max 0.03% spread allowed
2. **Price Calculation**:
   - LONG: Place at best bid (maker)
   - SHORT: Place at best ask (maker)
3. **Slippage Control**: Max 0.05% deviation
4. **Timeout**: Wait 8 seconds for fill
5. **Fallback**: Market order if confidence > 70%

### Order Flow
```
1. Calculate quantity (risk-based)
2. Check spread (skip if > 0.03%)
3. Calculate limit price (best bid/ask)
4. Place limit order (postOnly)
5. Wait 8s for fill
6. If not filled and conf > 70% → market order
7. If not filled and conf ≤ 70% → skip trade
```

---

## 8. Data Layer

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `trades` | Closed position records |
| `signals_log` | Every entry evaluation |
| `bot_stats` | Rolling session stats |
| `ai_learning` | ML feature rows per trade |
| `equity_history` | Balance curve snapshots |

### Trade Record Schema
```sql
trade_id, symbol, side, pair_mode, regime
entry_price, exit_price, size, leverage, notional_usdt
open_time, close_time, duration_sec
pnl_pct, pnl_usdt, fee_usdt, net_profit_usdt, result
entry_rsi, entry_ema9, entry_ema21, entry_volume_ratio
entry_session, entry_funding_rate, entry_fear_greed
ai_confidence, ai_decision, ai_risk
phase, entry_smc_score, entry_htf_trend
```

---

## 9. Configuration

### Key Parameters (BTC Mode)

```javascript
// Trading
SYMBOL: "BTCUSDT"              // BTC only
PRODUCT_TYPE: "usdt-futures"
DEFAULT_LEVERAGE: 7
MAX_LEVERAGE: 10

// Position
POSITION_SIZE_USDT: 15
MAX_POSITIONS: 1

// Risk (BTC-Optimized)
STOP_LOSS_PCT: 1.5
TAKE_PROFIT_PCT: 2.0
TP1_PCT: 0.5
MAX_LOSS_PCT: 3.0
HARD_STOP_TOTAL: 20.0
MIN_SL_PCT: 0.3

// Entry
SNIPER_MODE: true
OPEN_CONFIDENCE: 65
MIN_VOLUME_RATIO: 0.8
ATR_MIN_PERCENT: 0.15

// Timing
CHECK_INTERVAL_MS: 10000  // 10 seconds
CLAUDE_ANALYSIS_INTERVAL: 6  // every 60 seconds

// BTC Strategy
BTC_SPECIFIC_CONFIG: {
  STOP_LOSS_PCT: 1.5,
  TAKE_PROFIT_PCT: 2.0,
  TP1_PCT: 0.5,
  TRAILING_OFFSET: 0.5,
  POSITION_SIZE_USDT: 15,
  MIN_SL_PCT: 0.3,
  MAX_SL_PCT: 2.0,
}
```

---

## 10. API Integrations

### Bitget Futures API

| Endpoint | Usage |
|----------|-------|
| `/mix/market/ticker` | Current price, volume |
| `/mix/market/candles` | OHLCV data |
| `/mix/market/merge-depth` | Orderbook |
| `/mix/market/current-fund-rate` | Funding rate |
| `/mix/account/account` | Balance info |
| `/mix/position/single-position` | Open positions |
| `/mix/order/place-order` | Open/close positions |
| `/mix/order/close-positions` | Close all positions |

### External APIs

| API | Data |
|-----|------|
| CoinGecko | Market data |
| alternative.me | Fear & Greed Index |

---

## 11. Dashboard

### Features
- Real-time price chart (Lightweight Charts)
- Position monitoring with P&L
- Bot status (Phase, Risk Multiplier)
- Trade log with timestamps
- Equity curve (Chart.js)
- SSE live updates

### Access
```
http://localhost:4000
```

---

## Technical Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| HTTP Client | native https |
| Database | Supabase (PostgreSQL) |
| AI | Anthropic Claude Haiku |
| Charts | Lightweight Charts, Chart.js |
| UI | Vanilla JS (no framework) |

---

## Safety Features

1. **DNS Bypass**: Cloudflare/Google DNS for ISP blocking
2. **Position Sync**: Real-time sync with exchange
3. **Graceful Shutdown**: Close positions before exit
4. **Error Recovery**: Try-catch with fallbacks
5. **Dry Run First**: Default mode is simulation
6. **Learning Gate**: Only activate with sufficient data
7. **BTC Only Mode**: Simplified focus for better results

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Win Rate | >60% |
| Risk/Reward | 1:2 minimum |
| Max Drawdown | <30% |
| Monthly Return | 10-20% |

---

*Documentation Version: 3.0*
*Last Updated: 2026-04-08*
