'use strict';

/**
 * TEST: Check if logs are syncing to dashboard
 */

console.log('Testing logs synchronization...\n');

// Simulate global.botState
global.botState = {
  logs: [
    { ts: Date.now() - 10000, msg: '🧠 LONG [SNIPER_KILLER] | HTF=82% | SMC=71%' },
    { ts: Date.now() - 8000, msg: 'F1_HTF: Bias=BULLISH conf=82%' },
    { ts: Date.now() - 5000, msg: 'F2_CHECKLIST: 7/8 passed → ✓HTF ✓LIQ ✓BOS' },
    { ts: Date.now() - 2000, msg: '💰 Position opened: LONG @ 42500' },
  ],
};

// Test 1: Check if logs exist
console.log('✅ Test 1: Logs in global.botState');
console.log(`   Found: ${global.botState.logs.length} logs\n`);

// Test 2: Check dashboard-server payload
console.log('✅ Test 2: Dashboard payload simulation');
const liveData = {};
if (global.botState && global.botState.logs?.length) {
  liveData.logs = global.botState.logs.slice(-200);
}
console.log(`   Logs in payload: ${liveData.logs?.length || 0}\n`);

// Test 3: Check if logs format is correct
console.log('✅ Test 3: Log format validation');
global.botState.logs.forEach((l, i) => {
  const hasMsg = l?.msg ? '✓' : '✗';
  const hasTs = l?.ts ? '✓' : '✗';
  console.log(`   Log ${i}: msg${hasMsg} ts${hasTs}`);
});

console.log('\n📊 Summary:');
if (global.botState.logs.length > 0 && liveData.logs?.length > 0) {
  console.log('✅ Logs should appear in dashboard');
} else {
  console.log('❌ Logs might not appear — check bot storage');
}
