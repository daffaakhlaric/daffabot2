'use strict';

/**
 * LIVE SCORE MONITOR
 * Real-time tracking of F1 (HTF) dan F2 (SMC) confidence scores
 *
 * Usage: node monitor-scores.js
 */

const http = require('http');

console.log('🟢 Connecting to dashboard server at localhost:3000...\n');

// Fetch live data every 3 seconds
let lastScores = {};
let sessionStats = { prime: 0, good: 0, avoid: 0 };

setInterval(async () => {
  try {
    const response = await fetch('http://localhost:3000/api/data');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const sb = data.live?.scoreBoard || {};
    const regime = data.live?.marketState || '—';

    // Color codes
    const colorize = (val, targets) => {
      if (val === null || val === undefined) return '—'.padStart(3);
      const [warn, danger] = targets;
      if (val >= warn) return `\x1b[32m${val}\x1b[0m`.padStart(10);
      if (val >= danger) return `\x1b[33m${val}\x1b[0m`.padStart(10);
      return `\x1b[31m${val}\x1b[0m`.padStart(10);
    };

    // Session quality
    let kzQuality = '—';
    const hour = new Date().getUTCHours();
    if ((hour >= 7 && hour < 9) || (hour >= 13 && hour < 16)) {
      kzQuality = '🟢 PRIME';
      sessionStats.prime++;
    } else if ((hour >= 11 && hour < 12) || (hour >= 17 && hour < 18)) {
      kzQuality = '🟡 GOOD';
      sessionStats.good++;
    } else {
      kzQuality = '🔴 AVOID';
      sessionStats.avoid++;
    }

    // Clear and redraw
    console.clear();
    console.log('╔═══════════════════════════════════════════════════════════════════════╗');
    console.log('║           📊 DAFFABOT2 LIVE SCORE MONITOR                             ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

    console.log(`⏰ Time: ${new Date().toLocaleTimeString('id-ID')} WIB  |  Session: ${kzQuality}\n`);

    console.log('┌─────────────────────────────────────────────────────────────────────┐');
    console.log('│ AI CONFIDENCE SCORES                                                │');
    console.log('├─────────────────────────────────────────────────────────────────────┤');
    console.log(`│ HTF Confidence       ${colorize(sb.htf_confidence, [70, 55])}  /  100   (Target: ≥70%)      │`);
    console.log(`│ SMC Confluence       ${colorize(sb.smc_confluence_score, [65, 50])}  /  100   (Target: ≥65%)      │`);
    console.log(`│ Decision Score       ${colorize(sb.decision_score, [75, 60])}  /  100   (Target: ≥75%)      │`);
    console.log(`│ Momentum             ${colorize(sb.momentum_confidence, [70, 55])}  /  100                         │`);
    console.log(`│ Judas Sweep          ${colorize(sb.judas_confidence, [70, 55])}  /  100                         │`);
    console.log('├─────────────────────────────────────────────────────────────────────┤');

    // Status indicators
    const htfOk = sb.htf_confidence >= 70 ? '✅' : sb.htf_confidence >= 55 ? '⚠️' : '❌';
    const smcOk = sb.smc_confluence_score >= 65 ? '✅' : sb.smc_confluence_score >= 50 ? '⚠️' : '❌';
    const decOk = sb.decision_score >= 75 ? '✅' : sb.decision_score >= 60 ? '⚠️' : '❌';

    console.log(`│ Status  HTF: ${htfOk}  SMC: ${smcOk}  DECISION: ${decOk}                                      │`);
    console.log('└─────────────────────────────────────────────────────────────────────┘\n');

    // Market regime
    console.log(`📈 Market Regime: ${regime || '—'}`);
    console.log(`🔄 Session Quality: ${kzQuality}\n`);

    // Entry readiness
    const bothOk = (sb.htf_confidence >= 70 && sb.smc_confluence_score >= 65 && sb.decision_score >= 75);
    const partialOk = (sb.htf_confidence >= 55 && sb.smc_confluence_score >= 50 && sb.decision_score >= 60);

    console.log('┌─────────────────────────────────────────────────────────────────────┐');
    console.log('│ ENTRY READINESS                                                     │');
    console.log('├─────────────────────────────────────────────────────────────────────┤');

    if (bothOk) {
      console.log('│ ✅ ALL TARGETS MET                                                   │');
      console.log('│    → Bot is ready for entry signal                                  │');
    } else if (partialOk) {
      console.log('│ ⚠️  PARTIAL CONDITIONS MET                                            │');
      console.log('│    → Waiting for stronger confirmation                              │');
    } else {
      console.log('│ ❌ BELOW TARGETS                                                      │');
      console.log('│    → Market conditions not favorable — no entry expected             │');
      console.log('│    → Likely off-hours or low liquidity session                       │');
    }

    console.log('└─────────────────────────────────────────────────────────────────────┘\n');

    // Session statistics
    const total = sessionStats.prime + sessionStats.good + sessionStats.avoid;
    console.log('📊 Session Distribution (this run):');
    console.log(`   🟢 PRIME (London/NY): ${sessionStats.prime}  |  🟡 GOOD: ${sessionStats.good}  |  🔴 AVOID: ${sessionStats.avoid}\n`);

    // Recommendations
    console.log('💡 Recommendations:');
    if (sb.htf_confidence < 60) {
      console.log('   ⚠️  HTF Confidence too low — wait for clearer trend');
    }
    if (sb.smc_confluence_score < 50) {
      console.log('   ⚠️  SMC Confluence low — not enough checklist items passing');
    }
    if (kzQuality === '🔴 AVOID') {
      console.log('   ⚠️  In OFF-HOURS session — wait for London/NY session');
    }

    if (bothOk && kzQuality.includes('PRIME')) {
      console.log('   ✅ Excellent conditions — bot should be active and ready');
    }

  } catch (err) {
    console.error('❌ Error fetching data:', err.message);
    console.log('   Is the dashboard server running? (npm start)');
  }

}, 2000); // Update every 2 seconds

console.log('\n🔄 Fetching data... (Press Ctrl+C to stop)\n');
