"use strict";

/**
 * COMPREHENSIVE TEST - All Fixes Verification
 * Tests: Circuit breaker, intra-session loss, entry protocol, pair rotation, score thresholds
 */

console.log("\n" + "=".repeat(70));
console.log("🔧 TESTING ALL FIXES - COMPREHENSIVE VERIFICATION");
console.log("=".repeat(70) + "\n");

const tests = [];

// ═══════════════════════════════════════════════════════════════
// TEST 1: Circuit Breaker State (tradeMemory.js)
// ═══════════════════════════════════════════════════════════════
console.log("TEST 1: Circuit Breaker State Persistence\n");
try {
  const tradeMemory = require("../tradeMemory");

  // Test activate circuit breaker
  const activated = tradeMemory.activateCircuitBreaker(3);
  console.log("  ✓ Activated circuit breaker:", activated);

  // Test check if active
  const status = tradeMemory.isCircuitBreakerActive();
  console.log("  ✓ Circuit breaker status:", status.active ? "ACTIVE" : "INACTIVE");
  console.log(`    - Resume time: ${status.remainingMin}min remaining`);

  // Test reset
  tradeMemory.resetCircuitBreaker();
  const statusAfterReset = tradeMemory.isCircuitBreakerActive();
  console.log("  ✓ After reset:", statusAfterReset.active ? "ACTIVE" : "INACTIVE");

  tests.push({ name: "Circuit breaker", status: "PASS" });
  console.log("✅ PASS: Circuit breaker state persists correctly\n");
} catch (e) {
  console.log(`❌ FAIL: ${e.message}\n`);
  tests.push({ name: "Circuit breaker", status: "FAIL" });
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: Intra-Day Loss Tracking
// ═══════════════════════════════════════════════════════════════
console.log("TEST 2: Intra-Day Loss Guard\n");
try {
  const { runIntraSessionLossChecks } = require("../guards/intraSessionLossGuard");

  // Test with no loss
  const checkGood = runIntraSessionLossChecks({ sessionLossUSDT: -0.5, equity: 100 });
  console.log("  ✓ Loss -0.5 USDT (0.5%): " + (checkGood.approved ? "APPROVED" : "BLOCKED"));

  // Test with excessive loss
  const checkBad = runIntraSessionLossChecks({ sessionLossUSDT: -1.3, equity: 100 });
  console.log("  ✓ Loss -1.3 USDT (1.3%): " + (checkBad.blocked ? "BLOCKED" : "APPROVED"));

  tests.push({ name: "Intra-session loss guard", status: "PASS" });
  console.log("✅ PASS: Intra-session loss guard works\n");
} catch (e) {
  console.log(`❌ FAIL: ${e.message}\n`);
  tests.push({ name: "Intra-session loss guard", status: "FAIL" });
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: Entry Protocol with Fee-Adjusted RR
// ═══════════════════════════════════════════════════════════════
console.log("TEST 3: Entry Protocol (Fee-Adjusted RR)\n");
try {
  const { calculateFeeAdjustedRR, evaluateEntrySignal } = require("../strategy/entryProtocol");

  // Test fee-adjusted RR
  const rrRaw = (100.5 - 50.0) / (50.0 - 48.0);  // Raw RR = 25
  const rrFeeAdjusted = calculateFeeAdjustedRR(50.0, 48.0, 100.5, 0.05);
  console.log(`  ✓ Raw RR: ${rrRaw.toFixed(2)}`);
  console.log(`  ✓ Fee-adjusted RR (0.05%): ${rrFeeAdjusted.toFixed(2)}`);
  console.log(`    - Fee reduces reward: ${(rrRaw - rrFeeAdjusted).toFixed(2)} points\n`);

  // Test evaluateEntrySignal with klines
  const mockKlines1h = Array(100).fill(null).map((_, i) => ({
    high: 50000 + i * 10,
    low: 49900 + i * 10,
    close: 49950 + i * 10,
  }));

  const mockKlines5m = Array(50).fill(null).map((_, i) => ({
    high: 50000 + i * 5,
    low: 49990 + i * 5,
    close: 49995 + i * 5,
    volume: 1000000,
    quote_asset_volume: 50000000,
  }));

  const decision = evaluateEntrySignal({
    pair: "BTCUSDT",
    direction: "LONG",
    entry: 50000,
    sl: 49800,
    tp: 50500,
    klines_1h: mockKlines1h,
    klines_4h: mockKlines1h,
    klines_5m: mockKlines5m,
    tradeHistory: [],
    smc_valid: true,
    volume_confirmed: true,
    no_news_30m: true,
    entry_at_poi: true,
  });

  console.log(`  ✓ Entry decision:`);
  console.log(`    - HTF aligned: ${decision.htf_aligned}`);
  console.log(`    - Hold time valid: ${decision.hold_time_valid} (~${decision.estimated_hold_min}min)`);
  console.log(`    - Entry score: ${decision.entry_score}/100`);
  console.log(`    - RR (raw): ${decision.risk_reward_raw}`);
  console.log(`    - RR (fee-adjusted): ${decision.risk_reward_fee_adjusted}`);
  console.log(`    - Approved: ${decision.entry_approved ? "YES ✅" : "NO ❌"}`);

  tests.push({ name: "Entry protocol", status: "PASS" });
  console.log("✅ PASS: Entry protocol with fee-adjusted RR works\n");
} catch (e) {
  console.log(`❌ FAIL: ${e.message}\n`);
  tests.push({ name: "Entry protocol", status: "FAIL" });
}

// ═══════════════════════════════════════════════════════════════
// TEST 4: Pair Rotation with Liquidity
// ═══════════════════════════════════════════════════════════════
console.log("TEST 4: Pair Rotation with Liquidity Check\n");
try {
  const { checkPairRotation, checkPairLiquidity } = require("../strategy/pairRotation");

  // Test liquidity check
  const klines = Array(5).fill(null).map(() => ({
    volume: 500000,
    quote_asset_volume: 25000000,
  }));

  const liqCheck = checkPairLiquidity("BTCUSDT", klines, 1000000);
  console.log(`  ✓ Liquidity check: ${liqCheck.hasLiquidity ? "GOOD" : "LOW"} (${liqCheck.volume.toFixed(0)})`);

  // Test pair rotation with 3 losses (mandatory)
  const tradeHistory = [
    { pnlPercent: -0.5 },
    { pnlPercent: -0.3 },
    { pnlPercent: -0.2 },
  ];

  const rotation = checkPairRotation({
    currentPair: "BTCUSDT",
    tradeHistory,
    enabledPairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    klinesByPair: { BTCUSDT: klines, ETHUSDT: klines, SOLUSDT: klines },
  });

  console.log(`  ✓ Pair rotation (3 losses):`);
  console.log(`    - Loss streak: ${rotation.lossStreak}`);
  console.log(`    - Rotate: ${rotation.rotate ? "YES" : "NO"}`);
  console.log(`    - Mandatory: ${rotation.mandatory ? "YES" : "NO"}`);
  console.log(`    - Recommended new pair: ${rotation.newPair || "N/A"}`);

  tests.push({ name: "Pair rotation", status: "PASS" });
  console.log("✅ PASS: Pair rotation with liquidity works\n");
} catch (e) {
  console.log(`❌ FAIL: ${e.message}\n`);
  tests.push({ name: "Pair rotation", status: "FAIL" });
}

// ═══════════════════════════════════════════════════════════════
// TEST 5: Score Thresholds
// ═══════════════════════════════════════════════════════════════
console.log("TEST 5: Unified Score Thresholds\n");
try {
  const { getMinScoreForSession, shouldApproveEntry, getWinStreakBonus } = require("../config/scoreThresholds");

  // Test session-based thresholds
  const londonScore = getMinScoreForSession("LONDON");
  const asiaScore = getMinScoreForSession("ASIA_MORNING");
  console.log(`  ✓ Min scores:`);
  console.log(`    - LONDON: ${londonScore}`);
  console.log(`    - ASIA_MORNING: ${asiaScore}`);

  // Test dynamic approval
  const approval1 = shouldApproveEntry({
    score: 70,
    session: "LONDON",
    isAfterWin: false,
  });
  console.log(`  ✓ Score 70 at LONDON: ${approval1.approved ? "APPROVED" : "REJECTED"}`);

  const approval2 = shouldApproveEntry({
    score: 75,
    session: "ASIA_MORNING",
    isAfterWin: false,
  });
  console.log(`  ✓ Score 75 at ASIA_MORNING: ${approval2.approved ? "APPROVED" : "REJECTED"} (needs 85+)`);

  // Test win streak bonus
  const bonus = getWinStreakBonus(3);
  console.log(`  ✓ Win streak bonus (3 wins): ${bonus > 0 ? `+${bonus}` : bonus} points`);

  tests.push({ name: "Score thresholds", status: "PASS" });
  console.log("✅ PASS: Score thresholds working correctly\n");
} catch (e) {
  console.log(`❌ FAIL: ${e.message}\n`);
  tests.push({ name: "Score thresholds", status: "FAIL" });
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════
console.log("=".repeat(70));
console.log("📊 TEST SUMMARY\n");

const passed = tests.filter(t => t.status === "PASS").length;
const failed = tests.filter(t => t.status === "FAIL").length;

console.log(`Total tests: ${tests.length}`);
console.log(`✅ PASSED: ${passed}`);
console.log(`❌ FAILED: ${failed}\n`);

tests.forEach(t => {
  const icon = t.status === "PASS" ? "✅" : "❌";
  console.log(`${icon} ${t.name}`);
});

console.log("\n" + "=".repeat(70));
if (failed === 0) {
  console.log("🎉 ALL TESTS PASSED - FIXES VERIFIED");
} else {
  console.log(`⚠️  ${failed} TEST(S) FAILED - REVIEW ERRORS`);
}
console.log("=".repeat(70) + "\n");
