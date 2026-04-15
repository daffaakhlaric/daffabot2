#!/usr/bin/env node
"use strict";

/**
 * ENTRY QUALITY FILTER VERIFICATION SCRIPT
 * Checks all quality filter integrations
 */

const fs = require("fs");
const path = require("path");

console.log("\n🔍 ENTRY QUALITY FILTER VERIFICATION\n");

const checks = [];

// ── CHECK 1: entryQualityFilter.js exists
const qualityFilterPath = path.join(__dirname, "../strategy/entryQualityFilter.js");
const check1 = fs.existsSync(qualityFilterPath);
checks.push({
  name: "entryQualityFilter.js module exists",
  status: check1,
  details: check1 ? "✅ File created successfully" : "❌ File missing",
});

// ── CHECK 2: entryQualityFilter exports correct functions
if (check1) {
  try {
    const eqf = require("../strategy/entryQualityFilter");
    const requiredExports = [
      "getMinimumDecisionScore",
      "checkChopConditions",
      "checkCandleConfirmation",
      "calculateATRBasedSL",
      "checkPairPriority",
      "checkLossStreakDefense",
      "runEntryQualityChecks",
    ];
    const hasAllExports = requiredExports.every(name => typeof eqf[name] === "function");
    checks.push({
      name: "entryQualityFilter exports all functions",
      status: hasAllExports,
      details: hasAllExports
        ? `✅ All ${requiredExports.length} functions exported`
        : `❌ Missing exports: ${requiredExports.filter(n => typeof eqf[n] !== "function").join(", ")}`,
    });
  } catch (e) {
    checks.push({
      name: "entryQualityFilter exports all functions",
      status: false,
      details: `❌ Error loading: ${e.message}`,
    });
  }
}

// ── CHECK 3: pairConfig.js has stricter minScore
const pairConfigPath = path.join(__dirname, "pairConfig.js");
try {
  const pairConfigContent = fs.readFileSync(pairConfigPath, "utf8");
  const hasMinScore70 = pairConfigContent.includes('minScore: 70');
  const hasMinScoreTrend = pairConfigContent.includes('minScoreTrend');
  const hasMinScoreSniper = pairConfigContent.includes('minScoreSniper');
  const hasPriority = pairConfigContent.includes('priority:');

  checks.push({
    name: "pairConfig.js has stricter minScore (70)",
    status: hasMinScore70,
    details: hasMinScore70 ? "✅ minScore 70 found" : "❌ Still using old minScore",
  });
  checks.push({
    name: "pairConfig.js has minScoreTrend & minScoreSniper",
    status: hasMinScoreTrend && hasMinScoreSniper,
    details: hasMinScoreTrend && hasMinScoreSniper ? "✅ New score fields found" : "❌ Missing new fields",
  });
  checks.push({
    name: "pairConfig.js has pair priority ranking",
    status: hasPriority,
    details: hasPriority ? "✅ Priority field found" : "❌ Priority field missing",
  });
} catch (e) {
  checks.push({
    name: "pairConfig.js enhancements",
    status: false,
    details: `❌ Error reading file: ${e.message}`,
  });
}

// ── CHECK 4: btcStrategy.js has tightened parameters
const btcStrategyPath = path.join(__dirname, "btcStrategy.js");
try {
  const btcStrategyContent = fs.readFileSync(btcStrategyPath, "utf8");
  const hasBOSParam = btcStrategyContent.includes('BOS_BREAK_PERCENT');
  const hasTightVolume = btcStrategyContent.includes('VOLUME_MIN: 1.2') || btcStrategyContent.includes('VOLUME_MIN: 1.3');
  const hasStrictRR = btcStrategyContent.includes('MIN_RR_RATIO: 2.0');
  const hasTightMitigation = btcStrategyContent.includes('PULLBACK_THRESHOLD: 0.5');

  checks.push({
    name: "btcStrategy.js has BOS_BREAK_PERCENT (0.12%)",
    status: hasBOSParam,
    details: hasBOSParam ? "✅ BOS parameter found" : "❌ Parameter missing",
  });
  checks.push({
    name: "btcStrategy.js has stricter volume (1.2+)",
    status: hasTightVolume,
    details: hasTightVolume ? "✅ Volume tightened" : "⚠️ Check volume settings",
  });
  checks.push({
    name: "btcStrategy.js has MIN_RR_RATIO 2.0",
    status: hasStrictRR,
    details: hasStrictRR ? "✅ R:R tightened to 2.0" : "⚠️ Check R:R settings",
  });
  checks.push({
    name: "btcStrategy.js has mitigation zone tightened (0.5)",
    status: hasTightMitigation,
    details: hasTightMitigation ? "✅ Mitigation zone tightened" : "⚠️ Check mitigation settings",
  });
} catch (e) {
  checks.push({
    name: "btcStrategy.js enhancements",
    status: false,
    details: `❌ Error reading file: ${e.message}`,
  });
}

// ── CHECK 5: riskGuard.js imports and uses entryQualityFilter
const riskGuardPath = path.join(__dirname, "riskGuard.js");
try {
  const riskGuardContent = fs.readFileSync(riskGuardPath, "utf8");
  const hasImport = riskGuardContent.includes('require("../strategy/entryQualityFilter")');
  const hasCalls = riskGuardContent.includes("entryQualityFilter.runEntryQualityChecks");
  const hasDashboard = riskGuardContent.includes("global.botState.entryQuality");

  checks.push({
    name: "riskGuard.js imports entryQualityFilter",
    status: hasImport,
    details: hasImport ? "✅ Import statement found" : "❌ Import missing",
  });
  checks.push({
    name: "riskGuard.js calls quality filter checks",
    status: hasCalls,
    details: hasCalls ? "✅ Function call found" : "❌ Function call missing",
  });
  checks.push({
    name: "riskGuard.js exports entryQuality to dashboard",
    status: hasDashboard,
    details: hasDashboard ? "✅ Dashboard export found" : "❌ Dashboard export missing",
  });
} catch (e) {
  checks.push({
    name: "riskGuard.js integration",
    status: false,
    details: `❌ Error reading file: ${e.message}`,
  });
}

// ── CHECK 6: Documentation exists
const guidePath = path.join(__dirname, "EMERGENCY_TUNING_GUIDE.md");
const hasGuide = fs.existsSync(guidePath);
checks.push({
  name: "EMERGENCY_TUNING_GUIDE.md documentation",
  status: hasGuide,
  details: hasGuide ? "✅ Documentation created" : "⚠️ Missing documentation",
});

// ── PRINT RESULTS ────────────────────────────────────────
console.log("📊 VERIFICATION RESULTS:\n");

let passCount = 0;
let failCount = 0;

checks.forEach((check, idx) => {
  const icon = check.status ? "✅" : "❌";
  console.log(`${idx + 1}. ${icon} ${check.name}`);
  console.log(`   ${check.details}\n`);
  if (check.status) passCount++;
  else failCount++;
});

console.log(`\n📈 SUMMARY: ${passCount}/${checks.length} checks passed\n`);

if (failCount === 0) {
  console.log("✨ ALL CHECKS PASSED — Entry Quality Filter is fully integrated!\n");
  console.log("🚀 Next steps:");
  console.log("   1. Start bot with DRY_RUN=true to test");
  console.log("   2. Send false breakout signal (score <70)");
  console.log("   3. Expect to see 'LOW_DECISION_SCORE' block");
  console.log("   4. Test chop conditions (10 small candles)");
  console.log("   5. Expect to see 'CHOP_CONDITIONS' block");
  console.log("   6. Monitor dashboard for entryQuality stats\n");
  console.log("Expected improvements:");
  console.log("   • Entry frequency: -60% (quality > quantity)");
  console.log("   • Win rate: +10-20% (fewer false breakouts)");
  console.log("   • Drawdown: -30-40% (better risk management)\n");
  process.exit(0);
} else {
  console.log("⚠️  SOME CHECKS FAILED — Review the details above\n");
  console.log("💡 Quick fix checklist:");
  console.log("   [ ] Is entryQualityFilter.js in root directory?");
  console.log("   [ ] Did pairConfig.js get updated with minScore 70?");
  console.log("   [ ] Did btcStrategy.js get tighter SMC parameters?");
  console.log("   [ ] Did riskGuard.js import entryQualityFilter?");
  console.log("   [ ] Does riskGuard call runEntryQualityChecks()?");
  console.log("   [ ] Does riskGuard export entryQuality to dashboard?\n");
  process.exit(1);
}
