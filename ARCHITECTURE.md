# Production-Ready Exchange-Native Multi-Pair Trading System
## Architecture Document

---

## 1. SYSTEM ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           TRADING SYSTEM ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐              │
│  │   DATA LAYER    │     │  DECISION LAYER │     │ EXECUTION LAYER │              │
│  ├─────────────────┤     ├─────────────────┤     ├─────────────────┤              │
│  │                 │     │                 │     │                 │              │
│  │ WebSocket       │────▶│ Regime Detector │────▶│ Order Manager   │              │
│  │ Manager         │     │                 │     │                 │              │
│  │                 │     │ MTF Engine      │────▶│ Position Mgr    │              │
│  │ REST API        │     │                 │     │                 │              │
│  │ Fallback        │     │ Signal Scorer   │────▶│ Risk Manager    │              │
│  │                 │     │                 │     │                 │              │
│  │ Data Cache      │     │ SMC Validator  │────▶│ Cooldown Mgr   │              │
│  │                 │     │                 │     │                 │              │
│  └─────────────────┘     │ Entry Quality  │────▶│ TP/SL Manager   │              │
│                           │ Filter          │     │                 │              │
│                           │                 │     └─────────────────┘              │
│                           └─────────────────┘                                      │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. MODULES TO BUILD

### 2.1 Data Ingestion Layer

| Module | File | Purpose |
|--------|------|---------|
| WebSocket Manager | `services/websocket/WebSocketManager.js` | Real-time price/candle streams with reconnection |
| REST API Fallback | `services/data/restDataProvider.js` | REST API when WebSocket unavailable |
| Data Cache | `services/data/dataCache.js` | In-memory cache for all pair data |

### 2.2 Decision Layer

| Module | File | Purpose |
|--------|------|---------|
| Regime Detector | `strategy/enhancedRegimeDetector.js` | Pair-specific regime classification |
| MTF Engine | `strategy/mtfEngine.js` | HTF + LTF multi-timeframe analysis |
| SMC Validator | `strategy/smcValidator.js` | BOS/CHoCH/FVG/Liquidity validation |
| Entry Quality Filter | `strategy/entryQualityFilter.js` | High-quality entry enforcement |
| Signal Scorer | `strategy/signalScoringEngine.js` | A/A+ setup scoring |
| Fast Trade Fix | `strategy/fastTradeFix.js` | Minimum hold enforcement |
| Cooldown Manager | `strategy/cooldownManager.js` | Reentry protection |
| Session Filter | `strategy/enhancedSessionFilter.js` | Trading window optimization |

### 2.3 Execution Layer

| Module | File | Purpose |
|--------|------|---------|
| Order Manager | `execution/orderManager.js` | Order placement/cancellation |
| Position Manager | `execution/positionManager.js` | Position tracking/updates |
| Risk Manager | `execution/riskManager.js` | Risk per trade, daily DD |
| TP/SL Manager | `execution/tpSlManager.js` | Partial TP, trailing stops |
| Pair Rotator | `execution/pairRotator.js` | Multi-pair fund management |

---

## 3. BEST INDICATOR SETTINGS PER PAIR CLASS

### 3.1 MAJOR (BTC, ETH)

| Indicator | Setting | Rationale |
|-----------|---------|-----------|
| EMA | 20, 50, 200 | Standard trend definition |
| ATR Period | 14 | Standard volatility |
| ADX Min | 20 | Weak trend threshold |
| Min Hold | 120s (2 min) | Fast but not instant |
| Max ATR | 2.0% | Upper volatility limit |
| Sessions | LONDON, NY, OVERLAP | Best liquidity |

### 3.2 MID CAP (SOL, BNB, LINK)

| Indicator | Setting | Rationale |
|-----------|---------|-----------|
| EMA | 20, 50, 100 | Shorter term bias |
| ATR Period | 14 | Standard |
| ADX Min | 25 | Stricter trend requirement |
| Min Hold | 150s (2.5 min) | More patience |
| Max ATR | 3.0% | Higher volatility OK |
| Sessions | NY, OVERLAP | Exclude low liquidity |
| Min Score | 75 | Higher quality |

### 3.3 MEME (PEPE, WIF, BONK)

| Indicator | Setting | Rationale |
|-----------|---------|-----------|
| EMA | 20, 50, 100 | Short-term focus |
| ATR Period | 14 | Standard |
| ADX Min | 30 | Strong trend only |
| Min Hold | 180s (3 min) | High noise filter |
| Max ATR | 5.0% | Wide volatility range |
| Sessions | NY ONLY | Highest volume only |
| Min Score | 85 | A- grade minimum |
| Volume Spike | 1.5x | Mandatory |
| Leverage | 15x max | Reduced risk |

---

## 4. WEBSOCKET DESIGN

### 4.1 Connection Management

```
┌─────────────────────────────────────────────────────────────┐
│                   WebSocket Connection Flow                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  START                                                       │
│    │                                                         │
│    ▼                                                         │
│  ┌──────────────────┐                                        │
│  │ Connect to WS    │                                        │
│  │ (wss://ws...)    │                                        │
│  └────────┬─────────┘                                        │
│           │                                                  │
│    ┌──────┴──────┐                                          │
│    ▼             ▼                                          │
│ SUCCESS    FAILURE                                          │
│    │             │                                          │
│    ▼             ▼                                          │
│ Subscribe    Retry (exponential backoff)                   │
│    │             │                                          │
│    ▼             │                                          │
│ Heartbeat ──────┘                                          │
│    │                                                         │
│    ▼                                                         │
│  ┌──────────────────────┐                                   │
│  │ Handle Messages      │                                   │
│  │ - ticker             │                                   │
│  │ - kline_1m/5m/15m/1H │                                   │
│  │ - trade              │                                   │
│  └──────────┬───────────┘                                    │
│             │                                               │
│             ▼                                               │
│  ┌──────────────────────┐                                   │
│  │ Update Data Cache    │                                   │
│  │ + Emit Events        │                                   │
│  └──────────┬───────────┘                                    │
│             │                                                │
│             ▼                                                │
│  Monitor: Check every 1s                                    │
│  - Last update timestamp                                    │
│  - If >5s stale → mark as stale                             │
│  - If >30s no heartbeat → reconnect                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Channels per Pair

| Channel | Symbol | Granularity | Data |
|---------|--------|-------------|------|
| `spot:BTCUSDT:ticker` | BTCUSDT | real-time | bid/ask/volume |
| `spot:BTCUSDT:kline_1m` | BTCUSDT | 1m | OHLCV |
| `spot:ETHUSDT:ticker` | ETHUSDT | real-time | bid/ask/volume |
| `spot:ETHUSDT:kline_5m` | ETHUSDT | 5m | OHLCV |
| `spot:SOLUSDT:kline_1H` | SOLUSDT | 1H | OHLCV |

### 4.3 Reconnection Logic

```javascript
const RECONNECT_DELAYS = [3000, 4500, 6750, 10125, 15000]; // Exponential
const MAX_RECONNECT_ATTEMPTS = 10;
const HEARTBEAT_INTERVAL = 30000;
const STALE_DATA_THRESHOLD = 5000;
```

---

## 5. MULTI-PAIR EXECUTION LOGIC

### 5.1 Pair Selection Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Pair Selection Process                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. SCORE ALL PAIRS                                         │
│     - Fetch klines for all enabled pairs                    │
│     - Calculate regime score per pair                       │
│     - Calculate signal score per pair                       │
│     - Factor in:                                            │
│       • Regime quality (TREND_UP/DOWN preferred)            │
│       • Volume spike presence                               │
│       • Session quality                                     │
│       • Recent cooldown status                              │
│                                                              │
│  2. RANK PAIRS                                              │
│     - Sort by total score descending                        │
│     - Apply category multipliers                             │
│       • MAJOR: 1.0x                                         │
│       • MID: 0.7x                                           │
│       • MEME: 0.3x                                          │
│                                                              │
│  3. SELECT BEST PAIR                                        │
│     - Choose highest scoring pair                            │
│     - Must meet min score threshold                          │
│     - Must not be in cooldown                                │
│     - Must pass session filter                               │
│                                                              │
│  4. SWITCH CONDITIONS                                       │
│     - Current pair score drops >15pts from peak             │
│     - Current pair becomes saturated                         │
│     - Better pair gap >20pts                                │
│     - Current pair hits SL (immediate reeval)               │
│     - Whale exit signal detected                            │
│                                                              │
│  5. COOLDOWN AFTER SWITCH                                   │
│     - Minimum 3 min after position close                    │
│     - Same pair cannot be re-selected immediately           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Position Sizing by Category

| Category | Leverage | Position Size | Risk Multiplier |
|----------|----------|---------------|-----------------|
| MAJOR | 50x | 100% | 1.0x |
| MID | 20x | 70% | 0.7x |
| MEME | 15x | 30% | 0.3x |

---

## 6. ANTI-FAKEOUT PROTECTIONS

### 6.1 Required Entry Validations (ALL must pass)

| Check | Description | Weight |
|-------|-------------|--------|
| Candle Close | Signal candle must close (not wick) | Required |
| Displacement | Candle must move 1.3x average range | Required |
| BOS | Break of structure confirmed | Required |
| CHoCH | Change of character (MEME only) | Required for MEME |
| Liquidity Sweep | Recent swing high/low swept | Required for MID/MEME |
| FVG | Fair value gap present (MEME only) | Required for MEME |
| Volume Spike | 1.2x+ average volume | Required |
| Micro Range | No consolidation range | Required |
| Wick Fakeout | Not wick-only breakout | Required |
| ATR Threshold | ATR in optimal range | Required |

### 6.2 Minimum Hold Enforcement

| Category | Min Hold Time | Rationale |
|----------|---------------|-----------|
| MAJOR | 120s (2 min) | Allow trend continuation |
| MID | 150s (2.5 min) | More filtering |
| MEME | 180s (3 min) | High noise filter |

### 6.3 Cooldown Rules

| Event | Cooldown | Type |
|-------|----------|------|
| SL Hit | 10-15 min | Same pair |
| WIN | 3 min | Same pair |
| LOSS (non-SL) | 10 min | Same pair |
| Same Direction | 15 min | Same pair |
| Fast Loss Streak | 30 min | Same pair |

---

## 7. PSEUDOCODE FOR LIVE DEPLOYMENT

### 7.1 Main Trading Loop

```javascript
async function mainLoop() {
  // Initialize
  await initWebSocket();
  await initState();
  
  while (running) {
    try {
      // 1. Fetch data
      const klinesMap = await fetchAllKlines();
      const prices = await fetchAllPrices();
      
      // 2. For each active/evaluating pair
      for (const pair of enabledPairs) {
        const klines = klinesMap[pair];
        const regime = detectPairRegime(klines, pair);
        
        // Skip if regime blocks entry
        if (!regime.canEnter) continue;
        
        // 3. Check session
        const sessionCheck = checkSession(pair);
        if (!sessionCheck.canTrade) continue;
        
        // 4. Calculate signal score
        const htf = analyzeHTF(klinesHTF, pair);
        const ltf = analyzeLTF(klines, htf.bias);
        const signalScore = calculateSignalScore({
          klinesHTF, klinesLTF: klines, pair, direction
        });
        
        // 5. Check cooldown
        const cooldown = checkCooldown(pair, direction);
        if (!cooldown.allowed) continue;
        
        // 6. SMC Validation
        const smc = validateEntry(klines, direction, pair);
        if (!smc.canEnter) continue;
        
        // 7. Fast trade fix
        const fastTrade = fastTradeFix.validate({
          pair, klines, direction
        });
        if (!fastTrade.canEnter) continue;
        
        // 8. Entry
        if (signalScore.canTrade && signalScore.grade >= "B") {
          await openPosition(pair, direction);
        }
      }
      
      // 9. Monitor positions
      for (const pos of activePositions) {
        await checkExitConditions(pos);
      }
      
    } catch (e) {
      log(`Error: ${e.message}`);
    }
    
    await sleep(CHECK_INTERVAL);
  }
}
```

### 7.2 Position Exit Logic

```javascript
async function checkExitConditions(position) {
  const price = await getCurrentPrice(position.symbol);
  const pnlPct = calculatePnL(position, price);
  const holdMs = Date.now() - position.openedAt;
  
  // 1. SL Check
  if (pnlPct <= -position.slPct) {
    await closePosition("STOP_LOSS");
    recordExit(position.symbol, "SL", pnl, position.side);
    return;
  }
  
  // 2. Min hold enforcement
  const minHold = getMinHoldTime(position.symbol);
  if (holdMs < minHold) {
    // Only allow emergency exits
    if (pnlPct <= -position.slPct * 0.5) {
      await closePosition("EMERGENCY_EXIT");
    }
    return;
  }
  
  // 3. TP Levels (partial closes)
  if (pnlPct >= position.tp1Pct && !position.tp1Hit) {
    await partialClose(40, "TP1");
    await moveSLToBreakEven();
  }
  
  // 4. Trailing stop
  if (pnlPct >= position.trailActivate) {
    const trailPct = pnlPct >= 1.2 ? 0.4 : 0.2;
    await updateTrailingSL(trailPct);
  }
  
  // 5. Max hold timeout
  if (holdMs >= position.maxHoldMs) {
    if (pnlPct > 0) {
      await closePosition("TIMEOUT_PROFIT");
    } else {
      await closePosition("TIMEOUT_LOSS");
    }
  }
}
```

---

## 8. RISK MANAGEMENT PARAMETERS

| Parameter | Value | Description |
|-----------|-------|-------------|
| Max Risk/Trade | 2% | Max risk per trade |
| Max Daily DD | 6% | Daily drawdown limit |
| Max Open Positions | 3 | Concurrent positions |
| Max Pairs Traded | 5 | Pairs in rotation |
| Min RR Ratio | 2.0 | Risk/reward minimum |
| Partial TP1 | 40% @ 1.5R | First target |
| Partial TP2 | 30% @ 2.5R | Second target |
| Runner | 30% @ 4R | Final target |
| Break Even | After TP1 | Move SL to entry |

---

## 9. KEY METRICS TARGETS

| Metric | Target | Current Problem |
|--------|--------|-----------------|
| Win Rate | >45% | Too many false entries |
| Profit Factor | >1.5 | Poor RR |
| SL Hit Rate | <40% | Fast stopouts |
| Avg Hold Time | >2 min | <20 sec bug |
| Daily Trades | 3-8 | Overtrading |
| Session Filter | 70% | Asia chop entries |

---

## 10. DEPLOYMENT CHECKLIST

- [ ] WebSocket connection with reconnection
- [ ] Data caching for all pairs
- [ ] Regime detector with proper indicators
- [ ] MTF engine (1H/4H + 1m/5m)
- [ ] SMC validator (BOS/CHoCH/FVG)
- [ ] Entry quality filter
- [ ] Signal scorer (A/A+ only)
- [ ] Fast trade fix (min hold)
- [ ] Cooldown manager
- [ ] Session filter
- [ ] Risk manager
- [ ] TP/SL with partials
- [ ] Multi-pair rotator

---

## 11. FILES CREATED

| File | Purpose |
|------|---------|
| `services/websocket/WebSocketManager.js` | Real-time data ingestion |
| `strategy/enhancedRegimeDetector.js` | Pair-specific regime detection |
| `strategy/mtfEngine.js` | Multi-timeframe analysis |
| `strategy/smcValidator.js` | SMC validation |
| `strategy/fastTradeFix.js` | Min hold enforcement |
| `strategy/cooldownManager.js` | Reentry protection |
| `strategy/enhancedSessionFilter.js` | Session optimization |
| `strategy/signalScoringEngine.js` | A/A+ scoring |

---

*Architecture Version: 2.0*
*Created: 2026-04-16*
*Purpose: Production-ready multi-pair crypto futures trading system*