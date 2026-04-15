#!/usr/bin/env node
"use strict";

/**
 * PROFIT PROTECTOR VERIFICATION SCRIPT
 * Checks all integrations and module functions
 */

const fs = require("fs");
const path = require("path");

console.log("\n🔍 PROFIT PROTECTOR INTEGRATION VERIFICATION\n");

const checks = [];

// ── CHECK 1: profitProtector.js exists
const profitProtectorPath = path.join(__dirname, "../guards/profitProtector.js");
const check1 = fs.existsSync(profitProtectorPath);
checks.push({
  name: "profitProtector.js module exists",
  status: check1,
  details: check1 ? "✅ File created successfully" : "❌ File missing",
});

// ── CHECK 2: profitProtector exports correct functions
if (check1) {
  try {
    const pp = require("../guards/profitProtector");
    const requiredExports = [
      "checkSessionProfitLock",
      "checkPostWinCooldown",
      "checkWinStreakProtection",
      "checkMaxTradesPerHour",
      "checkMaxTradesPerSession",
      "checkQualityFilterBoost",
      "runProfitProtectionChecks",
    ];
    const hasAllExports = requiredExports.every(name => typeof pp[name] === "function");
    checks.push({
      name: "profitProtector exports all functions",
      status: hasAllExports,
      details: hasAllExports
        ? `✅ All ${requiredExports.length} functions exported`
        : `❌ Missing exports: ${requiredExports.filter(n => typeof pp[n] !== "function").join(", ")}`,
    });
  } catch (e) {
    checks.push({
      name: "profitProtector exports all functions",
      status: false,
      details: `❌ Error loading: ${e.message}`,
    });
  }
}

// ── CHECK 3: riskGuard.js imports profitProtector
const riskGuardPath = path.join(__dirname, "riskGuard.js");
try {
  const riskGuardContent = fs.readFileSync(riskGuardPath, "utf8");
  const hasImport = riskGuardContent.includes('require("../guards/profitProtector")');
  const hasCalls = riskGuardContent.includes("profitProtector.runProfitProtectionChecks");
  checks.push({
    name: "riskGuard.js imports profitProtector",
    status: hasImport,
    details: hasImport ? "✅ Import statement found" : "❌ Import missing",
  });
  checks.push({
    name: "riskGuard.js calls profitProtector checks",
    status: hasCalls,
    details: hasCalls ? "✅ Function call found" : "❌ Function call missing",
  });
} catch (e) {
  checks.push({
    name: "riskGuard.js integration",
    status: false,
    details: `❌ Error reading file: ${e.message}`,
  });
}

// ── CHECK 4: psychGuard.js has BOT_EUPHORIA enhancement
const psychGuardPath = path.join(__dirname, "psychGuard.js");
try {
  const psychGuardContent = fs.readFileSync(psychGuardPath, "utf8");
  const hasEuphoriaEnhance = psychGuardContent.includes("BOT_EUPHORIA");
  const hasEuphoriaTrigger = psychGuardContent.includes("consecutive_wins >= 2");
  checks.push({
    name: "psychGuard.js has BOT_EUPHORIA state",
    status: hasEuphoriaEnhance,
    details: hasEuphoriaEnhance ? "✅ BOT_EUPHORIA logic found" : "❌ BOT_EUPHORIA missing",
  });
  checks.push({
    name: "psychGuard.js has 2-win euphoria trigger",
    status: hasEuphoriaTrigger,
    details: hasEuphoriaTrigger ? "✅ 2+ win trigger found" : "❌ Trigger may be old version",
  });
} catch (e) {
  checks.push({
    name: "psychGuard.js enhancement",
    status: false,
    details: `❌ Error reading file: ${e.message}`,
  });
}

// ── CHECK 5: dashboard-server.js exports profit stats
const dashboardPath = path.join(__dirname, "dashboard-server.js");
try {
  const dashboardContent = fs.readFileSync(dashboardPath, "utf8");
  const hasProfit = dashboardContent.includes("liveData.profitProtection");
  const haspsych = dashboardContent.includes("liveData.psychState");
  checks.push({
    name: "dashboard-server.js exports profitProtection",
    status: hasProfit,
    details: hasProfit ? "✅ Export statement found" : "❌ Export missing",
  });
  checks.push({
    name: "dashboard-server.js exports psychState",
    status: haspsych,
    details: haspsych ? "✅ Export statement found" : "❌ Export missing",
  });
} catch (e) {
  checks.push({
    name: "dashboard-server.js integration",
    status: false,
    details: `❌ Error reading file: ${e.message}`,
  });
}

// ── CHECK 6: PROFIT_PROTECTOR_GUIDE.md exists
const guidePath = path.join(__dirname, "PROFIT_PROTECTOR_GUIDE.md");
const hasGuide = fs.existsSync(guidePath);
checks.push({
  name: "PROFIT_PROTECTOR_GUIDE.md documentation",
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
  console.log("✨ ALL CHECKS PASSED — Profit Protector is fully integrated!\n");
  console.log("🚀 Next steps:");
  console.log("   1. Start bot with DRY_RUN=true to test");
  console.log("   2. Run 3+ winning trades to trigger BOT_EUPHORIA");
  console.log("   3. Monitor logs for:");
  console.log("      - POST_WIN_COOLDOWN blocks");
  console.log("      - BOT_EUPHORIA state changes");
  console.log("      - SESSION_LOCKED when daily +2.5%");
  console.log("   4. Check dashboard for profitProtection stats\n");
  process.exit(0);
} else {
  console.log("⚠️  SOME CHECKS FAILED — Review the details above\n");
  console.log("💡 Quick fix checklist:");
  console.log("   [ ] Is profitProtector.js in the root directory?");
  console.log("   [ ] Did you run 'npm install' after adding new file?");
  console.log("   [ ] Check riskGuard.js line 10 for require statement");
  console.log("   [ ] Check riskGuard.js line 393 for function call");
  console.log("   [ ] Check psychGuard.js line 261 for BOT_EUPHORIA logic\n");
  process.exit(1);
}
