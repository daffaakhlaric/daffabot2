# 🤖 BTC AI TRADING ENGINE — FINAL CLEAN VERSION

## 🎯 CORE PHILOSOPHY

- **TREND FOLLOWING ONLY (NO MEAN REVERSION)**
- **QUALITY > QUANTITY**
- **BIG WIN > MANY SMALL TRADES**
- **OPPORTUNITY WITH CONTROL (NOT OVERTRADING)**

---

## 🧠 DECISION OUTPUT FORMAT

```json
{
  "action": "LONG | SHORT | HOLD",
  "confidence": 0-100,
  "trend": "BULLISH | BEARISH | NEUTRAL",
  "trend_strength": "WEAK | NORMAL | STRONG",
  "reason": "clear explanation"
}
```

---

## ⚠️ MASTER RULE: SINGLE FLOW ONLY (NO CONFLICT)

**ALL decisions MUST follow this EXACT order:**

1. MARKET PHASE
2. PRIORITY DETECTION
3. ENTRY FILTERS
4. OVERRIDE CHECK (MAX 1)
5. RISK ADJUSTMENT
6. FINAL DECISION

---

## 1️⃣ MARKET PHASE (FIRST FILTER — ABSOLUTE)

**TREND:**
- EMA gap ≥ 0.15%
- ATR ≥ 0.15%

**CHOP:**
- EMA gap < 0.10%
- RSI ranging 45–55

**RULE:**
```
IF CHOP:
  IF STRONG TREND + BREAKOUT:
    → ALLOW (size 50%)
  ELSE:
    → HOLD (BLOCK ALL)
```

---

## 2️⃣ PRIORITY DETECTION

**PRIORITY 1 (HIGHEST):**
- STRONG TREND + BREAKOUT
- (EMA gap > 0.25% + volume ≥1.5x + momentum up)

**PRIORITY 2:**
- NORMAL TREND + HIGH SCORE

**PRIORITY 3:**
- AFTER WIN / SAFE MODE

**PRIORITY 4:**
- DEFENSE MODE

---

## 3️⃣ ENTRY FILTERS (MANDATORY)

### TREND RULE (NO EXCEPTION)

**LONG:**
- EMA20 > EMA50
- Price above EMA20 & EMA50

**SHORT:**
- EMA20 < EMA50
- Price below EMA20 & EMA50

### RSI PULLBACK ONLY

**LONG:** RSI 45–60
**SHORT:** RSI 40–55

### CORE FILTER

- Volume ≥ 1.2x
- ATR ≥ 0.15%

### EXPECTED MOVE (CLEAN VERSION)

- **STRONG trend:** ≥ 0.30%
- **NORMAL trend:** ≥ 0.40%
- **WEAK trend:** BLOCK

### ENTRY QUALITY

- Score ≥ 75 (dynamic allowed min 70 ONLY for PRIORITY 1)
- Score gap ≥ 25

### CONFIRMATION

**LONG:**
- bullish candle
- higher low confirmed

**SHORT:**
- bearish candle
- lower high confirmed

---

## 4️⃣ OVERRIDE SYSTEM (STRICT LIMIT)

**MAX 1 OVERRIDE PER TRADE**

Allowed override ONLY if:

**STRONG BREAKOUT:**
- volume ≥ 1.5x
- EMA gap widening
- momentum accelerating

If override used:
- confidence -10
- position size -20%
- DISABLE all other overrides

---

## 5️⃣ POST-WIN HARD FILTER (ANTI OVERTRADE)

IF last trade = WIN:
```
→ NO ENTRY for 15 minutes
→ EXCEPTION:
    ONLY if PRIORITY 1 (STRONG TREND)

→ REQUIRE:
    fresh pullback + new confirmation candle
```

---

## 6️⃣ POSITION SIZING (CLEAN)

- **STRONG trend:** +30%
- **NORMAL:** base size
- **WEAK:** -30%
- **DEFENSE MODE:** size -50%

---

## 7️⃣ FINAL DECISION

```
IF all filters pass:
  → EXECUTE TRADE

ELSE:
  → HOLD
```

---

## 🛡️ EXIT ENGINE (SINGLE SYSTEM — NO OVERLAP)

**FOLLOW THIS EXACT ORDER:**

1. **STOP LOSS (1.5%)**

2. **PEAK DROP EXIT**
   - Exit if profit drops >25% from peak

3. **TRAILING ACTIVATION**
   - Start at 0.5%

4. **PROFIT LOCK**
   - 1.0% → lock 30%
   - 2.0% → lock 50%
   - 3.0% → lock 70%

5. **PARTIAL CLOSE**
   - 1.0% → close 30%
   - 2.0% → close 30%

6. **INTELLIGENT ADJUSTMENT**
   - breakout → hold longer
   - rejection → exit early
   - volume drop → tighten trailing

---

## 🚫 HARD BLOCK CONDITIONS

**DO NOT TRADE IF:**
- ATR < 0.12%
- Volume < 1.0x
- EMA20 ≈ EMA50
- WEAK trend

---

## ⚡ TRADE DISCIPLINE

- **MAX 3 trades/day**
- **MAX 1 trade/hour**

After 2 losses:
→ DEFENSE MODE ON

---

## 💎 FINAL RULE

```
NO SIGNAL = NO TRADE
NO FORCE ENTRY
NO OVERTRADING

WAIT → CONFIRM → EXECUTE
```

---

## 🚀 SYSTEM GOAL

- Catch BIG trend moves
- Avoid chop completely
- Reduce fake entries
- Maximize runner profit
- Maintain consistency

---

## 📊 CONFIG SUMMARY

| Parameter | Value |
|-----------|-------|
| **Symbol** | BTCUSDT |
| **Timeframe** | 15m |
| **Stop Loss** | 1.5% |
| **Trailing Offset** | 0.5% |
| **Peak Drop Exit** | 25% |
| **MAX Trades/Day** | 3 |
| **MAX Trades/Hour** | 1 |
| **Defense Mode** | After 2 losses |
| **ATR Hard Block** | < 0.12% |
| **Volume Min** | 1.2x |
| **RSI LONG** | 45-60 |
| **RSI SHORT** | 40-55 |

---

## 🔒 KILLER EXIT LEVELS

```
Trailing Start:    0.5% profit
Lock 30%:          1.0% profit
Lock 50%:          2.0% profit
Lock 70%:          3.0% profit
Peak Drop Exit:    25% from peak
```

---

## 🎯 PARTIAL CLOSE

```
LEVEL 1: 1.0% profit → Close 30%
LEVEL 2: 2.0% profit → Close 30%
RUNNER:  Remaining 40% → Let it run!

SKIP if STRONG + BREAKOUT at ≥1.5%
→ Hold for bigger move
```

---

## 🛡️ DEFENSE MODE

After 2 consecutive losses:
```
→ Entry score: 85 (minimum)
→ Position size: -50%
→ MAX trades/hour: 1
→ Duration: 1 hour
```

---

## 📝 DOCUMENTED BEHAVIOR

✅ TREND FOLLOWING ONLY (no mean reversion)
✅ RSI PULLBACK entry (45-60 LONG, 40-55 SHORT)
✅ VOLUME ≥ 1.2x required
✅ ATR HARD BLOCK < 0.12%
✅ CHOP BLOCK (except P1 with 50% size)
✅ MAX 3 trades/day, 1 trade/hour
✅ 15 min post-win cooldown (P1 exception only)
✅ DEFENSE after 2 losses
✅ MAX 1 override per trade
✅ Stop Loss 1.5%
✅ Peak Drop 25% exit
✅ Trailing 0.5% offset
✅ Profit Lock 30%/50%/70% at 1%/2%/3%
