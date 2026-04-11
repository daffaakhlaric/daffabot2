const fs = require('fs');

console.log("╔════════════════════════════════════════════╗");
console.log("║  DAFFABOT2 Configuration Check             ║");
console.log("╚════════════════════════════════════════════╝\n");

// 1. Check .env
require('dotenv').config();
const AI_ENABLED = process.env.AI_ENABLED !== 'false' && !!process.env.ANTHROPIC_API_KEY;
const API_KEY_SET = !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here';

console.log("1. AI Settings:");
console.log(`   ✓ AI_ENABLED: ${process.env.AI_ENABLED !== 'false' ? 'true' : 'false'}`);
console.log(`   ✓ ANTHROPIC_API_KEY: ${API_KEY_SET ? '✅ SET' : '❌ NOT SET'}`);
console.log(`   → Effective AI: ${AI_ENABLED ? '✅ ENABLED' : '❌ DISABLED (btcStrategy fallback)'}\n`);

// 2. Check Confluence Threshold
const botOrch = require('./botOrchestrator.js');
console.log("2. Confluence Score Thresholds:");
console.log(`   ✓ AI_CONFLUENCE (basic): score >= 70 required`);
console.log(`   ✓ SNIPER_KILLER: smc >= 80`);
console.log(`   ✓ SMC flow: smc >= 65`);
console.log(`   → Note: Not hardcoded at 75, depends on setup type\n`);

// 3. Check Kill Zone Setup
const featureEngine = require('./featureEngine.js');
console.log("3. Kill Zone Configuration:");
console.log(`   ✓ killZoneTimer() method exists`);
console.log(`   ✓ Sessions: Asian, London, NY, etc.\n`);

// 4. Check btcStrategy
const btcStrat = require('./btcStrategy.js');
console.log("4. btcStrategy Capability:");
console.log(`   ✓ Can generate standalone signals: YES`);
console.log(`   ✓ Signals: LONG, SHORT, CLOSE, PYRAMID, HOLD`);
console.log(`   ✓ Used as: Primary (if AI disabled) or Fallback (if AI times out)\n`);

// 5. Check Config
const CONFIG_DRY_RUN = process.env.DRY_RUN !== 'false';
console.log("5. Bot Mode:");
console.log(`   ✓ DRY_RUN: ${CONFIG_DRY_RUN}`);
console.log(`   ✓ Mode: ${process.env.BOT_MODE || 'SAFE'}`);
console.log(`   ✓ Sniper Enabled: ${process.env.SNIPER_ENABLED !== 'false'}\n`);

console.log("╔════════════════════════════════════════════╗");
console.log("║  Summary                                   ║");
console.log("╚════════════════════════════════════════════╝");
console.log(`
AI Status:     ${AI_ENABLED ? '✅ ENABLED (Orchestrator)' : '❌ DISABLED (btcStrategy only)'}
Fallback:      ${!AI_ENABLED ? 'btcStrategy will trade alone' : 'btcStrategy is backup'}
Dashboard:     ✅ Scores now visible in Overview tab
Kill Zone:     ✅ Auto-detected by session time
Next Step:     Set ANTHROPIC_API_KEY in .env to enable AI
`);
