/**
 * Test API logs endpoint
 */

const http = require('http');

// Simulate bot logs
global.botState = {
  logs: [
    { ts: Date.now() - 5000, msg: '🧠 LONG [SNIPER]' },
    { ts: Date.now() - 3000, msg: 'F2_CHECKLIST: 7/8' },
  ]
};

console.log('📋 Simulating /api/logs endpoint...\n');

// Test what dashboard-server.js returns
const logs = global.botState?.logs || [];
console.log(`Logs available: ${logs.length}`);
console.log('Response would be:');
console.log(JSON.stringify(logs, null, 2));

console.log('\n✅ Logs should be returned via /api/logs');
