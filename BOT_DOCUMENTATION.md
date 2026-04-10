# 🤖 DaffaBot - BTC Futures Trading Bot v5.0 HYBRID AI

## 📊 Overview

| Parameter | Value |
|-----------|-------|
| **Symbol** | BTCUSDT |
| **Timeframe** | 15m |
| **Exchange** | Bitget USDT-M Perpetual |
| **Mode** | BTC Only |
| **AI Version** | v5.0 HYBRID AI |
| **Philosophy** | TREND FOLLOWING + ADAPTIVE AI + SELF-LEARNING |

---

## 🧠 HYBRID AI ARCHITECTURE

```
┌─────────────────────────────────────────────────────────┐
│                    HYBRID AI FLOW                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [Market Data]                                          │
│       ↓                                                 │
│  ┌─────────────────────────────────┐                   │
│  │  LAYER 1: RULE ENGINE          │ → HARD BLOCK      │
│  │  • ATR < 0.12% → BLOCK                                 │
│  │  • Volume < 1.0x → BLOCK                              │
│  │  • Weak Trend → BLOCK                                 │
│  │  • EMA Flat → BLOCK                                  │
│  └─────────────────────────────────┘                   │
│       ↓                                                 │
│  ┌─────────────────────────────────┐                   │
│  │  LAYER 2: AI DECISION ENGINE    │                   │
│  │  • Scoring + Confidence                                  │
│  │  • Whale Boost                                          │
│  │  • Self-Learning Adjustments                            │
│  └─────────────────────────────────┘                   │
│       ↓                                                 │
│  ┌─────────────────────────────────┐                   │
│  │  LAYER 3: ML-LITE              │ → Weight Adaptation │
│  │  • Feature-based learning                               │
│  │  • No neural network                                   │
│  └─────────────────────────────────┘                   │
│       ↓                                                 │
│  [Final Decision: LONG / SHORT / HOLD]                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 🎯 CORE PHILOSOPHY

```
- TREND FOLLOWING ONLY (NO mean reversion)
- NO FOMO, NO OVERFILTER
- BALANCED ENTRY (not too early, not too late)
- CATCH MOVE WITHOUT CHASING
- ADAPTIVE to market conditions
- SELF-LEARNING from trade history
- DETERMINISTIC (no random decisions)
```

---

## ⚙️ 1. LAYER 1: RULE ENGINE (Hard Filters)

**HARD BLOCK - NO TRADE IF:**

| Filter | Threshold | Action |
|--------|-----------|--------|
| ATR | < 0.12% | HARD BLOCK |
| Volume | < 1.0x avg | HARD BLOCK |
| Trend | WEAK | HARD BLOCK |
| EMA Gap | < 0.05% | HARD BLOCK (flat) |

**CHOP Mode Handling:**
- EMA gap < 0.10% AND RSI 45-55 = CHOP
- If CHOP + P1 (STRONG breakout) → ALLOW (size 50%)
- Otherwise → HOLD

---

## 🐋 2. WHALE TRACKING ENGINE

### Detection Signals

| Signal | Detection | Score |
|--------|-----------|-------|
| **Volume Spike** | Volume ≥ 1.5x 20-bar avg | +20 |
| **Sudden Move** | Candle move ≥ 0.5% | +20 |
| **Absorption** | High volume + small body (<30% range) | +15 |
| **Liquidation Cluster** | Wick > 60% of candle range | +15 |

### Whale Score Usage

| Whale Score | Effect |
|-------------|--------|
| ≥ 40 | Confidence boost +0.10 |
| ≥ 60 | Confidence boost +0.15, allow aggressive entry |

### Whale Output Structure
```javascript
whale: {
  score: 0-100,
  level: "NORMAL" | "ACTIVE" | "AGGRESSIVE",
  volumeSpike: boolean,
  suddenMove: boolean,
  absorption: boolean,
  liquidationCluster: boolean,
  signals: ["Vol spike +20", ...]
}
```

---

## 🧮 3. EXPECTANCY OPTIMIZER

### Formula
```
expectancy = (winRate × avgWin) - ((1 - winRate) × avgLoss)
```

### Status Rules

| Status | Condition | Position Size |
|--------|-----------|---------------|
| **BULLISH** | expectancy > 0.5 | ×1.20 |
| **NORMAL** | 0 < expectancy ≤ 0.5 | ×1.00 |
| **CAUTIOUS** | expectancy ≤ 0 | ×0.85 |
| **DEFENSIVE** | 3+ consecutive losses | ×0.70 |

### Tracker
```javascript
expectancy: {
  trades: [],           // Last 50 trades
  winRate: 0.63,        // 63%
  avgWin: 1.2,          // Average win %
  avgLoss: 0.6,         // Average loss %
  expectancy: 0.42,     // Calculated value
  consecutiveLosses: 0,
  consecutiveWins: 0
}
```

---

## ⚙️ 4. ML-LITE WEIGHT ADAPTATION

### Initial Weights
```javascript
ML_WEIGHTS = {
  trend: 20,      // Trend direction
  momentum: 15,   // RSI pullback/exhaustion
  volume: 15,     // Volume confirmation
  structure: 20,   // Breakout detection
  whale: 10       // Whale activity
}
```

### Adaptation Rules
```
IF feature leads to WIN:
  weight += 1

IF feature leads to LOSS:
  weight -= 1

CLAMP: weight = max(5, min(30, weight))
```

### Weight Application
```javascript
applyMLWeights(context) → {
  score: 0-100,
  factors: [
    { feature: "trend", value: +20, type: "positive", text: "Bullish trend (+20)" },
    { feature: "volume", value: +15, type: "positive", text: "Volume OK (+15)" },
    ...
  ]
}
```

---

## 📊 5. SELF-LEARNING ENGINE

### Learning Data Structure
```javascript
SelfLearnState = {
  tradeLog: [],                    // Last 100 trades
  scoreRangePerformance: {
    "70": { wins: 5, total: 8, winRate: 0.625 },
    "75": { wins: 3, total: 6, winRate: 0.500 },
    ...
  },
  marketPhasePerformance: {
    "TREND": { wins: 12, total: 15, winRate: 0.80 },
    "CHOP": { wins: 2, total: 8, winRate: 0.25 },
    ...
  }
}
```

### Learning Rules

**1. Score Range Learning:**
- Minimum 10 trades before learning activates
- If score range WR < 45% → increase min score +5

**2. Phase Performance:**
- If CHOP phase WR < 45% → reduce confidence -0.10
- If TREND phase WR > 55% → boost confidence +0.05

**3. Adjustment Output:**
```javascript
getSelfLearnAdjustment(entryScore, marketPhase) → {
  scoreModifier: 0,        // +5 if score range losing
  confidenceModifier: 0,    // -0.10 if phase losing
  reasons: ["Score range 70-75 WR 40% - need higher score"]
}
```

---

## 🎯 6. ENTRY TIMING ENGINE (CRITICAL)

**NEW PHILOSOPHY: "Better miss trade than enter noise"**

```
ENTRY = AI Score PASS + ENTRY TIMING PASS
ENTRY = HOLD (even if score is high, if timing fails)
```

### Timing Checks (ALL must pass)

| Check | Rule | Action if Fail |
|-------|------|----------------|
| **Candle Expansion** | Body ≥ 60% of range OR size ≥ 1.3x prev | HOLD |
| **Breakout Confirmation** | Close above prev high (LONG) / below prev low (SHORT) | BLOCK |
| **Micro Noise** | Last 3 candles < 0.15% avg | HOLD |
| **Minimum Momentum** | Price move ≥ 0.25% BEFORE entry | WAIT |
| **Anti Re-entry** | Last trade < 3 min ago | BLOCK |
| **Overtrading** | 2 trades in 5 min | FORCE cooldown 10min |
| **Fake Breakout** | Wick > body OR no follow-through | BLOCK |

### Candle Expansion Rules
```
valid = bodyPercent >= 60% OR sizeRatio >= 1.3x
```

### Breakout Confirmation Rules
```
LONG: close > prevHigh AND NOT just wick
SHORT: close < prevLow AND NOT just wick
```

### Micro Noise Detection
```
avgMove = avg(last 3 candle moves)
if avgMove < 0.15% → sideways → BLOCK
```

### Minimum Momentum
```
LONG momentum = (close - prevClose) / prevClose * 100
SHORT momentum = (prevClose - close) / prevClose * 100
if momentum < 0.25% → HOLD
```

### Anti-Reentry Rule
```
if lastTradeTime exists AND minutesSince < 3min → BLOCK
```

### Overtrading Protection
```
if 2+ trades in 5min window → FORCE cooldown 10min
```

### Fake Breakout Filter
```
BLOCK if:
- Wick > body
- Volume spike but no follow-through
- Immediate rejection candle
```

### Entry Timing Result
```javascript
timing_valid: true/false,
timing: {
  candleExpansion: { valid: true, bodyPercent: 0.72, ... },
  breakout: { valid: true, ... },
  microNoise: { valid: true, ... },
  momentum: { valid: true, momentum: 0.32, ... },
  antiReentry: { valid: true, ... },
  overtrading: { valid: true, ... },
  fakeBreakout: { valid: true, ... }
}
```

### CRITICAL: Even P1 must pass timing!

```
EVEN PRIORITY 1 (STRONG breakout) MUST pass ENTRY TIMING
NO EXCEPTION - even perfect setups can be bad timing
```

---

## 🧠 7. AI DECISION ENGINE

### Scoring Flow
```
1. Base Score = ML weighted sum
   - trend: ±20
   - momentum: ±15
   - volume: +15
   - structure: ±20
   - whale: +10

2. + Self-Learning modifier

3. + Whale boost (if score ≥ 40)

4. = Final Score

5. + Expectancy position multiplier
```

### Confidence Calculation
```
confidence = (score / 100)
  - 0.10 if CHOP phase
  - 0.10 if fake breakout risk > 50%
  - 0.10 if volume low
  - 0.10 if anti-FOMO triggered
  - 0.15 if exhaustion detected
  + whale boost (0.10 or 0.15)
  + self-learning confidence modifier
```

### Decision Thresholds
| Confidence | Action |
|------------|--------|
| ≥ 75% | FULL_ENTRY |
| ≥ 60% | REDUCED_ENTRY |
| ≥ 50% | SCALP_ENTRY |
| < 50% | NO_TRADE |

### Priority System
| Priority | Condition |
|----------|-----------|
| **P1** | STRONG trend + breakout + whale active |
| **P2** | NORMAL trend + high score |
| **P3** | After WIN (post-win cooldown) |
| **P4** | Defense mode |

---

## 📋 FULL CONFIG

### Entry Parameters
| Parameter | Value |
|-----------|-------|
| MIN_ENTRY_SCORE | 75 |
| SCORE_GAP | 25 |
| RSI_LONG | 45-65 |
| RSI_SHORT | 40-55 |
| EMA_GAP_TREND | ≥ 0.15% |
| EMA_GAP_CHOP | < 0.10% |

### Position Sizing
| Trend | Size |
|-------|------|
| STRONG | +30% |
| NORMAL | base |
| WEAK | -30% |
| DEFENSE | -50% |

### Exit Rules
| Profit | Action |
|--------|--------|
| 0.5% | Trailing starts (0.5% offset) |
| 1.0% | Lock 30%, Partial close 30% |
| 2.0% | Lock 50%, Partial close 30% |
| 3.0% | Lock 70% |
| Peak -25% | EXIT |

### Hard Blocks
```
NO TRADE IF:
• ATR < 0.12%
• Volume < 1.0x
• EMA flat (< 0.05%)
• WEAK trend
• CHOP (except P1 with 50% size)
• RSI exhaustion (RSI > 70 + far from EMA)
• Anti-FOMO (move > 0.8% without pullback)
```

---

## 🔄 EXECUTION FLOW

```
1. fetchKlines()
         ↓
2. calculateIndicators()
   • EMA20, EMA50, RSI, ATR, Volume
         ↓
3. LAYER 1: applyRuleEngine()
   → BLOCK if failed
         ↓
4. detectWhaleActivity()
   → whaleScore
         ↓
5. applyMLWeights()
   → baseScore + factors
         ↓
6. getSelfLearnAdjustment()
   → scoreModifier + confidenceModifier
         ↓
7. applyWhaleBoost()
   → finalScore + confidence
         ↓
8. ENTRY TIMING ENGINE (NEW!)
   → checkCandleExpansion()
   → checkBreakoutConfirmation()
   → checkMicroNoise()
   → checkMinimumMomentum()
   → checkAntiReentry()
   → checkOvertrading()
   → checkFakeBreakout()
         ↓
9. getExpectancyStatus()
   → positionMultiplier
         ↓
10. FINAL DECISION (PASS only if timing_valid)
```

---

## 📊 OUTPUT FORMAT

```javascript
{
  // Core Decision
  action: "LONG",              // LONG | SHORT | HOLD
  confidence: 78,              // 0-100
  reason: "FAST ENTRY P1...",

  // Market Context
  trend: "BULLISH",
  trend_strength: "STRONG",
  market_phase: "TREND",
  priority: "P1",

  // Indicators
  indicators: {
    ema20: "67250.00",
    ema50: "67100.00",
    ema_gap: "0.223",
    rsi: "52.3",
    atr: "145.32",
    atrPct: "0.216",
    volumeRatio: "1.45"
  },

  // Whale
  whale: {
    score: 55,
    level: "ACTIVE",
    signals: ["Vol spike 1.5x (+20)", "Sudden move 0.6% (+20)"],
    volumeSpike: true,
    suddenMove: true,
    absorption: false,
    liquidationCluster: false
  },

  // ML
  mlWeights: {
    trend: 21,
    momentum: 15,
    volume: 15,
    structure: 22,
    whale: 10
  },
  mlFactors: [
    { feature: "trend", value: 21, type: "positive", text: "Bullish trend (+21)" },
    { feature: "momentum", value: 15, type: "positive", text: "RSI pullback (+15)" },
    ...
  ],

  // Self-Learning
  selfLearn: {
    adjustments: {
      scoreModifier: 0,
      confidenceModifier: 0.05,
      reasons: ["TREND phase WR 80% - boosting confidence"]
    }
  },

  // Expectancy
  expectancy: {
    winRate: 0.63,
    avgWin: 1.2,
    avgLoss: 0.6,
    expectancy: 0.42
  },
  expectancyStatus: {
    status: "BULLISH",
    sizeMultiplier: 1.20,
    consecutiveLosses: 0
  },

  // Position
  position_multiplier: "1.20",
  breakout: { valid: true, bodyPercent: "0.72", direction: "LONG" },

  // Entry Timing
  timing_valid: true,
  timing: {
    candleExpansion: { valid: true, bodyPercent: 0.72, sizeRatio: 1.1 },
    breakout: { valid: true },
    microNoise: { valid: true, avgMove: 0.32 },
    momentum: { valid: true, momentum: 0.35 },
    antiReentry: { valid: true, minutesSince: 15 },
    overtrading: { valid: true, tradesInWindow: 1 },
    fakeBreakout: { valid: true }
  },

  // Validation
  validation: {
    trendValid: true,
    volumeValid: true,
    atrValid: true,
    notChop: true,
    breakoutValid: true,
    timingValid: true,
    blocked: false
  },

  // Risk
  exit_rules: {
    sl_percent: 1.5,
    peak_drop_percent: 25,
    trailing_start: 0.5,
    locks: { "1.0%": "30%", "2.0%": "50%", "3.0%": "70%" },
    partials: { "1.0%": "30%", "2.0%": "30%" }
  }
}
```

---

## 🛡️ RISK GUARD

```
IF expectancy < 0 AND last trades losing:
  → reduce position size 30%

IF abnormal volatility:
  → reduce exposure

IF whale detected opposite direction:
  → block trade
```

---

## 📈 DASHBOARD PANELS

### 1. 🤖 AI DECISION CARD
- Action: LONG / SHORT / HOLD
- Confidence: 0-100%
- Score: 0-100
- Priority: P1/P2/P3/P4
- Mode badge: NORMAL / DEFENSE / SAFE / AGGRESSIVE

### 2. 📊 MARKET CONTEXT
- Trend (BULLISH/BEARISH/NEUTRAL)
- Phase (TREND/CHOP)
- Trend Strength bar
- EMA Gap %
- RSI
- ATR %
- Volume ratio
- Price

### 3. 🐋 WHALE ACTIVITY
- Whale Score (0-100)
- Status badge: NORMAL / WHALE ACTIVE / HIGH MANIPULATION
- Badges: VOL SPIKE, SUDDEN MOVE, ABSORPTION, LIQUIDATION ZONE

### 4. 🧠 AI REASONING
- List of factors with values
- Green = positive, Red = negative

### 5. ✅ ENTRY VALIDATION
- Checklist: Trend, Volume, ATR, Not CHOP, Breakout
- Final status: READY / BLOCKED

### 6. 💰 EXPECTANCY
- Winrate %
- Expectancy value
- Avg Win %
- Avg Loss %
- Status badge

### 7. ⚙️ SYSTEM STATUS
- Cooldown (ON/OFF + remaining)
- Defense (ON/OFF + remaining)
- State badge
- Last trade time
- Trades today
- Consecutive wins/losses

### 8. 🛡️ RISK ENGINE
- Position Size %
- Leverage
- Stop Loss %
- Take Profit %
- Position multiplier bar

### 9. ⚙️ ML WEIGHTS
- Trend bar
- Momentum bar
- Volume bar
- Structure bar
- Whale bar
- Min: 5, Max: 30

### 10. 🧠 SELF-LEARNING
- Total trades
- Learning active badge
- Score range performance
- Phase performance

### 11. 🤖 HYBRID AI STATUS
- All 6 layers active indicator
- Trade history (recent 8 scores)

---

## 🛡️ AUTO PAUSE AFTER LOSS STREAK (Defense Mode)

### Rules

| Consecutive Losses | Action |
|--------------------|--------|
| ≥ 2 | DEFENSE MODE: Min score 85, Size 50%, No scalp |
| ≥ 3 | HARD PAUSE 30 min (NO TRADE) |
| ≥ 4 | HARD PAUSE 60 min + Trend Reset Required |

### Defense Mode Behavior

- Min score = 85
- Only STRONG trend allowed
- Position size = 50%
- SCALP trades BLOCKED

---

## 🧠 AI TRADE CLASSIFIER (SCALP vs TREND)

### Classification Logic

**SCALP MODE:**
- EMA gap < 0.20%
- ATR < 0.18%
- No strong breakout
→ Market is weak / short move

**TREND MODE:**
- EMA gap ≥ 0.20%
- ATR ≥ 0.18%
- Breakout or strong structure
→ Market trending

### Execution Rules

| Mode | Target | SL | Entry | Volume |
|------|--------|-----|-------|--------|
| SCALP | 0.3% – 0.6% | Tight | HIGH precision | ≥ 1.3x |
| TREND | 1% – 2.5% | Normal | Normal | Normal |

### CRITICAL
- If SCALP but no perfect entry → **DO NOT TRADE**

---

## 🌏 SESSION FILTER (Anti-Asia Chop)

### Session Detection (UTC)

| Session | Hours | Mode | Rules |
|---------|-------|------|-------|
| ASIA | 00:00 – 07:00 | STRICT | Only STRONG trend + Vol ≥ 1.5x + Breakout |
| LONDON | 07:00 – 13:00 | NORMAL | Standard rules |
| NY | 13:00 – 22:00 | NORMAL | Standard rules |
| DEAD ZONE | 22:00 – 00:00 | LOW LIQ | Only if Whale detected or Breakout |

### ASIA Session Rules
→ BLOCK ALL unless:
- STRONG trend
- Volume ≥ 1.5x
- Breakout confirmed

---

## 🐋 WHALE TRAP DETECTION

### Trap Types

**LONG TRAP:**
- Price breaks high
- BUT: Long upper wick, Volume spike but no continuation
→ FAKE BREAKOUT

**SHORT TRAP:**
- Price breaks low
- BUT: Long lower wick, No continuation
→ FAKE BREAKOUT

### Trap Rules

| Detection | Action |
|-----------|--------|
| Trap detected | BLOCK trade |
| Opposite trap | ALLOW reverse (optional) |

### Advanced Trap Filter

BLOCK if:
- Candle wick > 60% of range
- Next candle reverses direction
- Volume spike without follow-through

---

## 🚀 GLOBAL ENTRY CONTROL

A trade is ONLY valid if:

1. ✅ Rule Engine PASS
2. ✅ AI Score PASS
3. ✅ Entry Timing PASS
4. ✅ Session Filter PASS
5. ✅ NOT in cooldown / pause
6. ✅ NOT whale trap
7. ✅ Defense Mode rules PASS (if active)

**IF ANY FAIL → HOLD**

### PRIORITY UPDATE

**PRIORITY 1 (STRONG BREAKOUT):**
→ STILL MUST pass:
- Timing checks
- Trap filter
- Session filter

**NO BLIND ENTRY**

---

## 🚀 SYSTEM GOALS

```
✓ Catch BIG trend moves
✓ Avoid chop completely
✓ Detect smart money (whales)
✓ Adapt to market conditions
✓ Learn from trade history
✓ Maximize long-term expectancy
✓ No random - fully deterministic
✓ No black box - fully explainable
```

---

## 🔧 TROUBLESHOOTING

### Bot Stuck in HOLD
1. Check ATR % - must be ≥ 0.15%
2. Check Volume - must be ≥ 1.2x
3. Check EMA gap - must be ≥ 0.10%
4. Check RSI - must be in pullback range

### No Trades All Day
1. Check ATR block - if < 0.12% → all blocked
2. Check volume - if < 1.0x → all blocked
3. Check cooldown - may be in post-win cooldown
4. Check defense mode - 2 consecutive losses triggers defense

### Losses Increasing
1. Check expectancy value - if < 0 → reduce size
2. Check whale detection - false signals
3. Check self-learning adjustments - may need reset
4. Run resetLearning() to clear all learning data

### Dashboard Not Updating
1. Check SSE connection on port 4000
2. Check bot is running
3. Check browser console for errors

---

## 📝 CHANGELOG v5.0

### Added v5.0 Features
- Hybrid AI Architecture (3 layers)
- Whale Tracking Engine
- Expectancy Optimizer
- Self-Learning Engine
- ML-Lite Weight Adaptation
- 11 new dashboard panels

### Added v5.1 Features
- Auto Pause After Loss Streak (Defense Mode)
- AI Trade Classifier (SCALP vs TREND)
- Session Filter (Anti-Asia Chop)
- Whale Trap Detection
- Global Entry Control
- Updated OUTPUT format with mode/session/filters

### Changed
- Scoring system now uses ML weights
- Confidence includes whale boost
- Position size includes expectancy multiplier

### Removed
- Hardcoded score thresholds (replaced with adaptive)
