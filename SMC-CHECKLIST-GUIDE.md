# 📊 SMC Checklist Guide (F2 Engine)

## The 8 SMC Requirements

For a trade to get a HIGH confluence score (≥65%), the F2 engine checks these 8 conditions:

### 1. **HTF Bias Clear** ✓/✗
- **What**: Higher timeframe (4H) shows clear trend direction
- **Why**: Need macro direction confirmation
- **Fails when**: 4H is choppy/ranging
- **Fix**: Wait for 4H trend to establish

### 2. **Liquidity Swept** ✓/✗
- **What**: Previous Buy/Sell Side Liquidity (BSL/SSL) has been taken out
- **Why**: Shows institutional accumulation/distribution
- **Fails when**: No clear swing levels or recent liquidity grab
- **Fix**: Need recent swing highs/lows to be broken

### 3. **Structure Break** ✓/✗
- **What**: Break of Structure (BoS) or Major Structure (MSS) confirmed
- **Why**: Signals trend continuation/reversal
- **Fails when**: Price hasn't broken key levels
- **Fix**: Wait for BoS/MSS on 1H/4H

### 4. **Mitigation Zone** ✓/✗
- **What**: Price retrace into Order Block/Fair Value Gap (OB/FVG)
- **Why**: Institutional re-entry zone
- **Fails when**: No clear OB/FVG or price nowhere near
- **Fix**: Need price retrace into supply/demand zone

### 5. **CHoCH Confirmed** ✓/✗
- **What**: Change of Character confirmed (trend structure change)
- **Why**: Signals new trend direction
- **Fails when**: No clear structure character change
- **Fix**: Need lower lows (downtrend) or higher highs (uptrend)

### 6. **Entry Candle Valid** ✓/✗
- **What**: Entry candle shows proper pattern (Engulfing, Pin bar, Inside bar)
- **Why**: Reduces whipsaw, shows momentum
- **Fails when**: Random candle patterns
- **Fix**: Wait for clean entry pattern

### 7. **RR Minimum Met** ✓/✗
- **What**: Risk:Reward ratio is at least 1:2
- **Why**: Positive expectancy over time
- **Fails when**: SL too close or TP too far
- **Fix**: Adjust SL/TP placement

### 8. **No HTF Resistance** ✓/✗
- **What**: Entry zone is NOT blocked by HTF resistance/support
- **Why**: Avoid trading into brick walls
- **Fails when**: Entry in HTF supply zone or below HTF support
- **Fix**: Find entry below HTF support or above HTF resistance

---

## Typical Score Scenarios

| Scenario | Checklist | Score | Status |
|----------|-----------|-------|--------|
| All 8 pass | 8/8 | 85-95% | 🟢 EXCELLENT |
| 6-7 pass | 6-7/8 | 70-80% | 🟡 GOOD |
| 4-5 pass | 4-5/8 | 50-65% | 🟠 MARGINAL |
| <4 pass | <4/8 | <50% | 🔴 POOR |

---

## Session Quality Impact

### High-Quality Sessions (London 07:00-09:00 UTC / NY 13:30-15:30 UTC)
```
✅ High liquidity → Sweeps are clear
✅ Big moves → Structure breaks easily
✅ Volume spike → Candle patterns are clean
→ SMC score typically 70-85%
```

### Low-Quality Sessions (Off-hours, Asian hours)
```
❌ Low liquidity → Fake sweeps
❌ Choppy price → No clear structure
❌ Thin volume → Candle noise
→ SMC score typically 30-50%
```

---

## Why Your Current Scores Are Low

**Time: ~20:30 UTC (NY Close)**
```
Session Quality: 🔴 AVOID
Liquidity: LOW (end of day)
Structure: CHOPPY (no clear direction)
Volume: THIN (market winding down)

Result: SMC checks fail (especially #2, #3, #5)
Confluence Score: 30-45%
```

---

## What To Do

### ✅ Wait for Prime Sessions
```
London Open (07:00-09:00 UTC)
   → 14:00-16:00 WIB — Best Asian exposure

NY Open (13:30-15:30 UTC)
   → 20:30-22:30 WIB — Best USD liquidity
```

### ❌ Avoid Trading Off-Hours
```
23:00-07:00 UTC (11:00-14:00 WIB)
   → Asian hours, thin liquidity
   → Fake sweeps, low confidence
```

### 📊 Monitor via Dashboard
```
Overview Tab → AI Confidence Scores
↓
Watch for:
✅ HTF ≥70%
✅ SMC ≥65%
✅ Session = PRIME
→ Then expect entries
```

---

## Quick Debug Checklist

When SMC score is low, check:

1. **Is it off-hours?**
   - If yes → Normal behavior, wait for next session

2. **What's the HTF bias?**
   - If unclear → F1 hasn't confirmed trend yet
   - Solution: Wait for 4H trend to establish

3. **How many checklist items pass?**
   - Check bot logs: `F2_CHECKLIST: X/8 passed`
   - If <4 → Not enough confluence, hold

4. **Is it a ranging market?**
   - If `RANGING` regime → SMC will score low
   - Solution: Wait for `TRENDING_BULL` or `TRENDING_BEAR`

---

## Expected Behavior

```
Normal Operation:
14:00-16:00 WIB (London): SMC 60-80% expected ✅
20:30-22:30 WIB (NY): SMC 65-85% expected ✅
23:00-06:00 WIB (Off): SMC 20-40% expected (wait) ⏸️

Bad Signs:
SMC always <30% → Check if API key is set
SMC never changes → Check if F2 cache is stuck (restart bot)
HTF missing → Check if F1 failed (AI timeout)
```

---

## Confluence Score Thresholds

The decision score combines:
- HTF confidence (40% weight)
- SMC confluence (30% weight)
- Momentum (20% weight)
- Judas sweep (10% weight)

```
Decision Score = (HTF×0.4) + (SMC×0.3) + (Mom×0.2) + (Judas×0.1)

Target: ≥75% for entry

If Decision <75% but SMC good:
→ HTF or Momentum is weak
→ Bot correctly blocks entry
→ This is feature, not bug
```
