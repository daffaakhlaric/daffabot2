# 🧪 TESTING MODE SETUP Guide

## Quick Start Testing

**To enable relaxed thresholds for testing:**

```bash
TESTING_MODE=true npm start
```

**Or add to .env:**
```
TESTING_MODE=true
```

---

## ✅ What TESTING_MODE Does

### 1. Reduce HTF Confidence Threshold
```
Normal: ≥70%
Testing: ≥55%
Impact: F1 engine accepts weaker trends
```

### 2. Reduce SMC Confluence Score
```
Normal: ≥65%
Testing: ≥50%
Impact: More SMC entries with fewer checklist items passing
```

### 3. Reduce Decision Score
```
Normal: ≥75%
Testing: ≥60%
Impact: More trades triggered overall
```

### 4. Allow Off-Hours Entry
```
Normal: AVOID sessions blocked
Testing: Off-hours entries allowed
Impact: Trades 24/7 (higher risk!)
```

### 5. Reduce Judas Confidence
```
Normal: ≥80% + HTF ≥65%
Testing: ≥60% + HTF ≥50%
Impact: More Judas sweep entries
```

---

## 📊 Comparison: Normal vs Testing

| Metric | Normal | Testing | Impact |
|--------|--------|---------|--------|
| HTF Min | 70% | 55% | 📈 +30% entries |
| SMC Min | 65% | 50% | 📈 +25% entries |
| Decision Min | 75% | 60% | 📈 +40% trades |
| Kill Zone | BLOCKED | ALLOWED | 📈 24/7 trading |
| Judas Min | 80% | 60% | 📈 +35% sweeps |

**Result: ~3-4x more trades in testing mode**

---

## 🤖 AI Mode vs btcStrategy Fallback

### AI Mode (ORCHESTRATOR)
- Uses Claude AI for all decisions
- Requires: ANTHROPIC_API_KEY set
- Thresholds: Above (normal or testing)
- Quality: High (AI-driven)

### btcStrategy Fallback
- Pure technical analysis
- No API required
- Uses: EMA50, Volume, Pullback zones
- Auto-activates if:
  - ANTHROPIC_API_KEY not set
  - AI timeout >12s
  - API billing error / rate limit

### Dashboard Indicator
```
AI: ✓ ON     → Using ORCHESTRATOR (AI)
AI: ✗ OFF    → Using BTCSTRATEGY (Fallback)
```

---

## 🔧 btcStrategy Parameters

Used when AI is disabled:
```javascript
CONFIG = {
  EMA_PERIOD: 50,
  VOLUME_MIN: 1.2,          // Volume spike >1.2x avg
  PULLBACK_ZONE: 0.3,       // <0.3% from EMA (Sniper)
  SL: 0.7,                  // SL -0.7% from entry
  TRAIL_ACTIVATE: 1.5,      // Trail activates at +1.5%
  TRAIL_DROP: 0.3,          // Trail tightens -0.3%
  PYR_1: 1.5,               // Pyramid target +1.5%
  PYR_2: 3.0,               // Pyramid target +3.0%
};
```

**btcStrategy Signals:**
- TREND: Close > EMA + Volume spike
- SNIPER: Price in pullback zone + bullish candle
- HOLD: No clear signal

---

## 🎯 Testing Workflow

### Step 1: Enable Testing Mode
```bash
TESTING_MODE=true npm start
```

### Step 2: Open Dashboard
```
http://localhost:3000
```

### Step 3: Monitor Overview
- Check AI mode indicator
- Watch decision scores drop
- See more trade entries

### Step 4: Verify btcStrategy
```bash
# In bot logs, look for:
# 🔴 FALLBACK LONG [BTCSTRATEGY] | TREND
```

---

## ⚠️ WARNING: Testing Mode Risks

🚨 **TESTING_MODE INCREASES RISK**:
- Off-hours entries (thin liquidity)
- Lower confidence thresholds (more whipsaws)
- 3-4x trade frequency (bigger drawdowns)

✅ **Only use for development/testing**
❌ **Never enable in live trading**

---

## 🔄 Auto-Fallback Mechanism

Bot automatically switches to btcStrategy if:

```
┌─ AI Enabled?
│  ├─ API Key set?
│  │  └─ YES → Check API health
│  │     ├─ Timeout >12s → FALLBACK
│  │     ├─ Rate limit → FALLBACK  
│  │     ├─ Billing error → FALLBACK
│  │     └─ OK → ORCHESTRATOR ✓
│  └─ NO → BTCSTRATEGY (default)
└─ Dashboard shows mode switch
```

**Logs show:**
```
🤖 AI LONG [SNIPER]          → Using ORCHESTRATOR
🔴 FALLBACK SHORT [TREND]    → Using BTCSTRATEGY
```

---

## 📝 Environment Variables

```bash
# Enable testing thresholds
TESTING_MODE=true

# Enable AI (requires ANTHROPIC_API_KEY)
AI_ENABLED=true

# Require specific session
FORCE_SESSION=LONDON_OPEN

# Dry run (no real trades)
DRY_RUN=true

# Bot mode
BOT_MODE=SAFE          # or FAST
```

---

## ✅ Verification Checklist

- [ ] TESTING_MODE=true in .env or terminal
- [ ] Dashboard shows "AI: ✓ ON" or "AI: ✗ OFF (FALLBACK)"
- [ ] Logs show decision scores ~10-20% lower
- [ ] More entries visible in logs (3-4x normal)
- [ ] btcStrategy logs appear if AI disabled
- [ ] Off-hours entries appear in logs

---

## 🎛️ Fine-Tuning Testing Thresholds

To adjust further, edit **botOrchestrator.js**:

```javascript
// Current testing thresholds:
const minScore = isTesting ? 60 : 75;           // decision score
const htfMin = isTesting ? 55 : 70;             // HTF confidence
const smcMin = isTesting ? 50 : 65;             // SMC confluence

// To make even more relaxed:
const minScore = isTesting ? 50 : 75;           // ← 50 instead of 60
const htfMin = isTesting ? 40 : 70;             // ← 40 instead of 55
```

⚠️ Lower thresholds = more trades but higher risk

---

## 🚀 Next Steps

1. Enable TESTING_MODE
2. Run bot for 1 hour
3. Analyze entries (quality vs quantity)
4. Adjust thresholds based on performance
5. Disable TESTING_MODE for live trading
