# 🤖 DaffaBot - Advanced BTC/PEPE Futures Trading Bot

## 📊 AI Level Analysis

### Current Level: **PROFESSIONAL (Grade A)**

Bot ini sudah termasuk **advanced quantitative trading system** dengan fitur-fitur yang biasa digunakan di hedge fund profesional:

| Aspect | Level | Description |
|--------|-------|-------------|
| **Entry Strategy** | ⭐⭐⭐⭐⭐ | SMC + AI + Multi-timeframe |
| **Risk Management** | ⭐⭐⭐⭐⭐ | Dynamic sizing + Breakeven + Trailing |
| **Order Execution** | ⭐⭐⭐⭐⭐ | Maker orders + Spread filter |
| **Market Analysis** | ⭐⭐⭐⭐⭐ | Multi-pair + Cross-asset |
| **Fee Awareness** | ⭐⭐⭐⭐⭐ | Smart exit + Maker optimization |
| **Position Sync** | ⭐⭐⭐⭐ | Real-time exchange sync |

---

## 🔧 Feature Documentation

### 1. 🎯 Smart Money Concept (SMC) Engine

| Feature | Status | Description |
|---------|--------|-------------|
| **Liquidity Grab Detection** | ✅ | Detects stop hunts above/below swing levels |
| **CHoCH Detection** | ✅ | Change of Character - trend reversal detection |
| **FVG (Fair Value Gap)** | ✅ | Identifies imbalance zones |
| **Liquidity Sweep** | ✅ | Detects wick rejections at support/resistance |
| **Break of Structure** | ✅ | Validates trend continuation |
| **Equal Highs/Lows** | ✅ | Identifies liquidity pools |
| **Fake Breakout Filter** | ✅ | Filters false breakouts |
| **Confluence System** | ✅ | Requires 2+ confirmations |

### 2. 🤖 AI Integration

| Feature | Status | Description |
|---------|--------|-------------|
| **Claude API** | ✅ | Market analysis & sentiment |
| **Confidence Scoring** | ✅ | Entry quality assessment |
| **Adaptive Risk** | ✅ | Loss streak protection |
| **Reversal Score** | ✅ | Institutional flow detection |

### 3. 📈 Technical Indicators

| Indicator | Status | Usage |
|-----------|--------|-------|
| RSI | ✅ | Momentum |
| EMA 9/21 | ✅ | Trend alignment |
| Bollinger Bands | ✅ | Volatility & squeeze |
| VWAP | ✅ | Fair value |
| ATR | ✅ | Position sizing |
| Volume Ratio | ✅ | Momentum confirmation |
| Fractal Swings | ✅ | Support/Resistance |

### 4. 💰 Risk Management

| Feature | Status | Parameters |
|---------|--------|------------|
| **Dynamic Position Sizing** | ✅ | Phase-based |
| **Stop Loss** | ✅ | 0.5% - 2.5% |
| **Take Profit** | ✅ | 3% - 5% |
| **Trailing Stop** | ✅ | Dynamic based on regime |
| **Breakeven** | ✅ | 0.25% - 0.5% |
| **Hard Stop** | ✅ | Total loss threshold |
| **Auto Pause** | ✅ | Crash protection |

### 5. 💵 Fee-Aware Trading

| Feature | Status | Description |
|---------|--------|-------------|
| **Min Profit Threshold** | ✅ | 0.24% (2x fee) |
| **Fee Gate** | ✅ | Prevents micro-profit closes |
| **Runner Protection** | ✅ | Activates at 0.4% profit |
| **Dead Trade Timeout** | ✅ | 60 min max hold |

### 6. ⚡ Order Execution (Maker Optimization)

| Feature | Status | Description |
|---------|--------|-------------|
| **Spread Filter** | ✅ | Max 0.03% for BTC |
| **Maker Orders** | ✅ | Place at best bid/ask |
| **Post-Only** | ✅ | Ensures maker fee |
| **Fallback to Market** | ✅ | 8s timeout, confidence > 70 |
| **Slippage Control** | ✅ | Max 0.05% deviation |

### 7. 🔄 Position Sync

| Feature | Status | Description |
|---------|--------|-------------|
| **Real-time Sync** | ✅ | Fetches from Bitget API |
| **External Close Detection** | ✅ | Handles manual closes |
| **Entry Prevention** | ✅ | Blocks duplicate entries |

### 8. 🌍 Market Sessions

| Session | Status | Best For |
|---------|--------|----------|
| London | ✅ | 07:00 - 16:00 UTC |
| New York | ✅ | 13:00 - 22:00 UTC |
| Overlap | ✅ | 13:00 - 16:00 UTC |

### 9. 📱 Multi-Asset Support

| Asset | Status | Config |
|-------|--------|--------|
| BTC/USDT | ✅ | Higher volatility |
| PEPE/USDT | ✅ | Higher frequency |

### 10. 🔀 Adaptive Pair Selection

| Feature | Status | Description |
|---------|--------|-------------|
| **Dual Mode** | ✅ | BTC + PEPE |
| **Pair Switching** | ✅ | Based on regime |
| **Session Filtering** | ✅ | Only trade in active sessions |

---

## 📋 Configuration Parameters

### Entry Settings
```javascript
ENTRY_SCORE_MIN: 70          // Minimum entry score
OPEN_CONFIDENCE: 60          // Minimum AI confidence
MIN_CONFIDENCE: 55           // Skip if below this
ATR_MIN_PERCENT: 0.15        // Minimum volatility
EXPECTED_MOVE_MIN: 0.3%     // Min expected move
```

### Risk Parameters
```javascript
STOP_LOSS_PCT: 0.5-2.5%     // Based on asset
TAKE_PROFIT_PCT: 3-5%        // Based on asset
MAX_LOSS_PCT: 15%            // Max single trade loss
HARD_STOP_TOTAL: 30%         // Total account loss
TRAILING_OFFSET: 0.5-0.8%    // Trailing distance
```

### Fee & Timing
```javascript
MIN_PROFIT_PCT: 0.24%        // 2x estimated fee
TIMEOUT_MINUTES: 45          // Normal timeout
DEAD_TRADE_TIMEOUT: 60       // Force close
RUNNER_THRESHOLD: 0.4%      // Activate trailing
```

### Order Execution
```javascript
MAX_SPREAD: 0.03%            // Max spread filter
MAX_SLIPPAGE: 0.05%          // Max slippage
LIMIT_TIMEOUT: 8000ms         // Maker order wait
FALLBACK_CONFIDENCE: 70       // Market order threshold
```

---

## 🎯 Entry Logic Flow

```
1. Fetch Market Data
   ├── Ticker (price, volume)
   ├── Klines (OHLCV)
   ├── Orderbook (bid/ask)
   └── Funding Rate

2. Calculate Indicators
   ├── RSI, EMA9/21
   ├── Bollinger Bands
   ├── VWAP, ATR
   └── Volume Ratio

3. SMC Analysis
   ├── Detect Swings
   ├── Find Liquidity Zones
   ├── Check CHoCH
   ├── Identify FVG
   ├── Detect Liquidity Sweep
   └── Validate BOS

4. Apply Filters
   ├── Spread Check (>0.03% = SKIP)
   ├── Fake Breakout Filter
   ├── Confluence Check (2+ factors)
   ├── Expected Move Check (>0.3%)
   └── Confidence Check (>55%)

5. AI Analysis (Claude)
   ├── Market Sentiment
   ├── Risk Assessment
   └── Confidence Score

6. Execute Order
   ├── Calculate Position Size
   ├── Place Maker Order
   │   ├── LONG: bestBid price
   │   └── SHORT: bestAsk price
   ├── Wait 8s for fill
   └── Fallback to market if needed

7. Set Risk Management
   ├── Stop Loss
   ├── Take Profit
   └── Trailing Parameters
```

---

## 🛡️ Exit Logic Flow

```
1. Fee Gate Check
   └── Profit < 0.24% = HOLD

2. Hard Stop Check
   └── Total loss > 30% = CLOSE ALL

3. Stop Loss Check
   └── Price hits SL = CLOSE

4. Take Profit Check
   ├── Initial TP hit
   └── Trailing TP activation

5. Timeout Checks
   ├── >45min with profit >= 0.24% = CLOSE
   └── >60min with profit < 0.24% = FORCE CLOSE

6. Runner Protection
   └── Profit > 0.4% = Tighter trailing

7. Momentum Check
   └── Weak momentum = EARLY EXIT (if profit > min)
```

---

## 📈 Performance Features

| Metric | Target |
|--------|--------|
| Win Rate | >60% |
| Risk/Reward | 1:2 minimum |
| Max Drawdown | <30% |
| Monthly Target | 10-20% |

---

## 🔐 Safety Features

1. **Position Sync** - Always in sync with exchange
2. **Fee Gate** - Never close at loss
3. **Cooldowns** - Prevent over-trading
4. **Loss Streak Guard** - Reduce size on losing streak
5. **Session Filter** - Only trade when liquid

---

## 📝 Summary

Bot ini sudah sangat advance dengan:

- ✅ **SMC-based entries** dengan multiple confirmation
- ✅ **AI-powered** decision making
- ✅ **Fee-aware** trading (maker orders + smart exits)
- ✅ **Real-time position sync** dengan exchange
- ✅ **Professional risk management**
- ✅ **Multi-pair & multi-timeframe** analysis

Level: **PROFESSIONAL GRADE A** - Suitable untuk live trading dengan modal yang dikelola dengan baik.
