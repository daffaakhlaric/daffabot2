# ⚡ QUICK REFERENCE - All New Functions

## 🔐 Circuit Breaker (tradeMemory.js)

```javascript
const tm = require("./tradeMemory");

// Activate pause (call when 3 consecutive losses detected)
tm.activateCircuitBreaker(3); // Returns { active: true, resumeTime: ..., reason: "..." }

// Check if currently paused (call before every entry)
const status = tm.isCircuitBreakerActive();
if (status.active) {
  console.log(`Paused for ${status.remainingMin}min`);
  return; // Don't trade
}

// Manual reset (shouldn't need this normally)
tm.resetCircuitBreaker();
```

---

## 📉 Intra-Session Loss Guard (guards/intraSessionLossGuard.js)

```javascript
const { runIntraSessionLossChecks } = require("./guards/intraSessionLossGuard");
const tm = require("./tradeMemory");

// Record a loss after closing trade
tm.recordIntraDayLoss(trade.pnlUSDT); // e.g., -2.5

// Check before entry if session loss limit exceeded
const status = tm.getIntraDayLossStatus();
const check = runIntraSessionLossChecks({
  sessionLossUSDT: status.sessionLossUSDT,
  maxDrawdownUSDT: status.sessionMaxDrawdown,
  equity: 100,
  tradeHistory: recentTrades,
});

if (check.blocked) {
  console.log(`❌ Session loss limit: ${check.blocks[0]}`);
  return; // Don't trade
}

// Reset at session end (daily)
tm.resetIntraDayLoss();
```

---

## 🎯 Entry Protocol (strategy/entryProtocol.js)

```javascript
const ep = require("./strategy/entryProtocol");

// Main entry check (call before EVERY order)
const decision = ep.evaluateEntrySignal({
  pair: "BTCUSDT",
  direction: "LONG",
  entry: 50000,
  sl: 49800,
  tp: 50500,
  klines_1h: [...],      // Required (100+ candles)
  klines_4h: [...],      // Required (100+ candles)
  klines_5m: [...],      // ⭐ NEW REQUIRED (50+ candles for ATR)
  tradeHistory: [...],   // All trades for checks
  smc_valid: true,
  volume_confirmed: true,
  no_news_30m: true,
  entry_at_poi: true,
});

// Check approval
if (!decision.entry_approved) {
  console.log(`❌ REJECTED: ${decision.rejection_reasons}`);
  return;
}

// Use details for logging
console.log(`✅ Score: ${decision.entry_score}/100`);
console.log(`   RR (raw): ${decision.risk_reward_raw}`);
console.log(`   RR (fee-adjusted): ${decision.risk_reward_fee_adjusted}`);
console.log(`   Hold time: ~${decision.estimated_hold_min}min`);
```

**Output Keys:**
- `entry_approved` (boolean) - Final decision
- `entry_score` (0-100) - Quality score
- `risk_reward_raw` - Before fees
- `risk_reward_fee_adjusted` - After 0.05% fees
- `hold_time_valid` (boolean) - Min 10min met
- `rejection_reasons` (string[]) - Why blocked

---

## 🔄 Pair Rotation (strategy/pairRotation.js)

```javascript
const pr = require("./strategy/pairRotation");

// Check if need to rotate pairs (call once per loss streak)
const rotation = pr.checkPairRotation({
  currentPair: "BTCUSDT",
  tradeHistory: allTrades,
  enabledPairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  klinesByPair: {
    "BTCUSDT": klines_5m_btc,
    "ETHUSDT": klines_5m_eth,
    "SOLUSDT": klines_5m_sol,
  },
});

if (rotation.rotate) {
  if (rotation.mandatory) {
    // 3+ losses: MUST switch
    tm.activateCircuitBreaker(rotation.lossStreak);
    tm.setMandatorySwitchState(rotation.currentPair, rotation.newPair);
    pairManager.switchPair(rotation.newPair);
  } else {
    // 2 losses + 20pt improvement: consider switching
    pairManager.switchPair(rotation.newPair);
  }
}

// Check liquidity of specific pair
const liquidity = pr.checkPairLiquidity("ETHUSDT", klines_5m, 100000);
if (!liquidity.hasLiquidity) {
  console.log(`⚠️ Low liquidity: ${liquidity.volume}`);
}
```

**Thresholds:**
- **1 loss:** Monitor, no action
- **2 losses:** Switch if better pair is >20pt better
- **3+ losses:** MANDATORY switch + circuit breaker

---

## 📊 Score Thresholds (config/scoreThresholds.js)

```javascript
const st = require("./config/scoreThresholds");

// Get minimum score for session
const minScore = st.getMinScoreForSession("LONDON");      // 70
const minScore = st.getMinScoreForSession("ASIA_MORNING"); // 85

// Dynamic approval check
const approval = st.shouldApproveEntry({
  score: 75,
  session: "LONDON",
  volatility: "NORMAL",        // or "LOW_ATR", "HIGH_ATR"
  mode: "SAFE",                // or "SNIPER", "TREND"
  isAfterWin: false,
  consecutiveLosses: 0,
});

console.log(`Score ${approval.score} >= ${approval.minRequired}: ${approval.approved}`);

// Win streak adjustment
const bonus = st.getWinStreakBonus(2);  // Returns -5 (can do 5pts lower quality)
const penalty = st.getLossStreakPenalty(3); // Returns 20 (need 20pts higher)
```

**Session Scores:**
| Session | Min | Notes |
|---------|-----|-------|
| LONDON | 70 | Best |
| NEW_YORK | 70 | Good |
| ASIA_MORNING | 85 | Strict |
| ASIA_EVENING | 80 | Moderate |
| OFF_HOURS | 85 | Strict |

---

## 🛡️ Pair Rotation State (tradeMemory.js)

```javascript
const tm = require("./tradeMemory");

// After mandatory pair switch
tm.setMandatorySwitchState("BTCUSDT", "ETHUSDT", 60*60*1000); // 1h cooldown

// Check if switch active (prevent instant re-switch)
const switchState = tm.isMandatorySwitchActive();
if (switchState.active) {
  console.log(`Can't switch back for ${switchState.remainingMin}min`);
}

// Can we switch to a specific pair?
const canSwitch = tm.canSwitchToPair("BTCUSDT");
if (!canSwitch.allowed) {
  console.log(`Cannot switch: ${canSwitch.reason}`);
}
```

---

## 💰 Fee-Adjusted Risk:Reward

```javascript
const ep = require("./strategy/entryProtocol");

// Calculate RR with fee impact (0.05% Bitget maker fee)
const rawRR = (tp - entry) / (entry - sl); // e.g., 2.0
const feeAdjRR = ep.calculateFeeAdjustedRR(entry, sl, tp, 0.05); // e.g., 1.87

// Fees reduce BOTH sides:
// - Entry fee added to risk
// - Exit fee subtracted from reward
```

---

## 🔍 Complete Decision Flow Example

```javascript
// This is the order of checks (do them in this sequence):

// 1. Circuit breaker
if (tm.isCircuitBreakerActive().active) return HOLD;

// 2. Session loss limit
if (intraSessionLossGuard.check().blocked) return HOLD;

// 3. Profit protection
if (!profitProtector.check().approved) return HOLD;

// 4. Entry signal (from strategy)
const signal = await btcStrategy.analyze({...});
if (!signal) return HOLD;

// 5. Pair rotation
if (pairRotation.check().mandatory) {
  tm.activateCircuitBreaker(...);
  return HOLD; // Will resume after CB
}

// 6. Entry protocol (6 rules)
const protocol = ep.evaluateEntrySignal({...});
if (!protocol.entry_approved) return HOLD;

// 7. Score threshold (session-aware)
const score = st.shouldApproveEntry({...});
if (!score.approved) return HOLD;

// ✅ ALL CHECKS PASSED
return ENTER;
```

---

## 📝 Common Patterns

### Before Entry Decision
```javascript
const decision = orchestrate({
  // ... market data ...
  tradeHistory,
  equity,
  session: getCurrentSession(),
  volatilityRegime: detectVolatility(),
});

if (decision.action === "ENTER") {
  executeOrder(decision);
} else {
  console.log(`REJECTED: ${decision.blocks}`);
}
```

### After Closing Trade
```javascript
const trade = await closePosition();

// Track loss
if (trade.pnlUSDT < 0) {
  tm.recordIntraDayLoss(trade.pnlUSDT);
}

// Update setup stats
tm.updateSetupStats(trade.setup, trade.pnlUSDT);

// Check if need circuit breaker
const losses = countConsecutiveLosses(tradeHistory);
if (losses >= 3) {
  tm.activateCircuitBreaker(losses);
}
```

### At Session Boundary
```javascript
// Reset intraday tracking
tm.resetIntraDayLoss();
```

---

## 🚨 Required Parameters

These are NOW REQUIRED (weren't before):

### entryProtocol.evaluateEntrySignal()
- ✅ `klines_5m` - Needed for ATR-based hold time estimation
- (Must have 20+ candles for accurate ATR)

### pairRotation.checkPairRotation()
- ✅ `klinesByPair` - Needed for liquidity checks before switching
- (Optional but recommended)

---

**Print this page or keep it open for reference while integrating! 🚀**
