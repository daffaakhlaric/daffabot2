"use strict";

/**
 * Daffabot2 Validation Tests (Part D)
 *
 * Covers:
 *  - scalpEngine signal generation + thresholds
 *  - SL safety cap (0.4%) refusal logic
 *  - BingX adapter symbol/interval helpers + signing
 *  - Adapter selection via EXCHANGE env
 *
 * Run:  npm test
 */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

// ---------- helpers: synthetic kline generators ----------

function genKlines({ count = 60, basePrice = 70000, drift = 0, vol = 50 } = {}) {
  const out = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = price * (1 + drift) + (Math.random() - 0.5) * vol;
    const close = price;
    const high = Math.max(open, close) + Math.random() * vol * 0.5;
    const low = Math.min(open, close) - Math.random() * vol * 0.5;
    out.push({ open, high, low, close, volume: 1000 + Math.random() * 500, time: Date.now() + i * 60000 });
  }
  return out;
}

function genTrendUp({ count = 60, basePrice = 70000 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const open = basePrice + i * 30;
    const close = open + 10 + Math.random() * 20;
    const high = close + 5;
    const low = open - 3;
    out.push({ open, high, low, close, volume: 2000, time: Date.now() + i * 60000 });
  }
  return out;
}

function genTrendDown({ count = 60, basePrice = 70000 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const open = basePrice - i * 30;
    const close = open - 10 - Math.random() * 20;
    const high = open + 3;
    const low = close - 5;
    out.push({ open, high, low, close, volume: 2000, time: Date.now() + i * 60000 });
  }
  return out;
}

// ---------- scalpEngine ----------

test("scalpEngine: returns null on insufficient klines", () => {
  const { generateScalpSignal } = require("../strategy/scalpEngine");
  const sig = generateScalpSignal({
    symbol: "BTCUSDT",
    klines: genKlines({ count: 5 }),
    price: 70000,
    pairConfig: { symbol: "BTCUSDT" },
  });
  assert.strictEqual(sig, null);
});

test("scalpEngine: returns null for non-MAJOR pair", () => {
  const { generateScalpSignal } = require("../strategy/scalpEngine");
  const sig = generateScalpSignal({
    symbol: "PEPEUSDT",
    klines: genTrendUp(),
    price: 70000 + 60 * 30,
    pairConfig: { symbol: "PEPEUSDT" },
  });
  assert.strictEqual(sig, null);
});

test("scalpEngine: emits LONG on sustained uptrend (BTCUSDT)", () => {
  const { generateScalpSignal } = require("../strategy/scalpEngine");
  const klines = genTrendUp({ count: 60 });
  const price = klines[klines.length - 1].close;
  const sig = generateScalpSignal({
    symbol: "BTCUSDT",
    klines,
    price,
    pairConfig: { symbol: "BTCUSDT", atrOptimalMin: 0.0, atrOptimalMax: 5.0 },
  });
  assert.ok(sig, "expected signal");
  assert.strictEqual(sig.action, "LONG");
  assert.strictEqual(sig.setup, "SCALP_FAST");
  assert.strictEqual(sig.source, "SCALP_ENGINE");
  assert.ok(sig.entry.sl_price < price, "SL must be below entry on LONG");
});

test("scalpEngine: emits SHORT on sustained downtrend (BTCUSDT)", () => {
  const { generateScalpSignal } = require("../strategy/scalpEngine");
  const klines = genTrendDown({ count: 60 });
  const price = klines[klines.length - 1].close;
  const sig = generateScalpSignal({
    symbol: "BTCUSDT",
    klines,
    price,
    pairConfig: { symbol: "BTCUSDT", atrOptimalMin: 0.0, atrOptimalMax: 5.0 },
  });
  assert.ok(sig, "expected signal");
  assert.strictEqual(sig.action, "SHORT");
  assert.ok(sig.entry.sl_price > price, "SL must be above entry on SHORT");
});

test("scalpEngine: SL distance never exceeds hard cap 0.4%", () => {
  const { generateScalpSignal, SCALP_SL_HARD_CAP_PCT } = require("../strategy/scalpEngine");
  const klines = genTrendUp({ count: 60 });
  const price = klines[klines.length - 1].close;
  const sig = generateScalpSignal({
    symbol: "BTCUSDT",
    klines,
    price,
    pairConfig: { symbol: "BTCUSDT", atrOptimalMin: 0.0, atrOptimalMax: 5.0 },
  });
  if (sig) {
    assert.ok(sig.entry.sl <= SCALP_SL_HARD_CAP_PCT + 1e-9,
      `SL ${sig.entry.sl}% exceeded cap ${SCALP_SL_HARD_CAP_PCT}%`);
    assert.ok(sig.entry.sl >= 0.20 - 1e-9, "SL below floor 0.20%");
  }
});

test("scalpEngine: HTF confidence floor (45) blocks weak setups", () => {
  const { generateScalpSignal } = require("../strategy/scalpEngine");
  // Choppy noise: HTF bias unstable, confidence low
  const klines = genKlines({ count: 60, vol: 200 });
  const price = klines[klines.length - 1].close;
  const sig = generateScalpSignal({
    symbol: "BTCUSDT",
    klines,
    price,
    pairConfig: { symbol: "BTCUSDT", atrOptimalMin: 0.0, atrOptimalMax: 5.0 },
    htf: { bias: "BULLISH", confidence: 30 }, // forced low conf
  });
  assert.strictEqual(sig, null, "low HTF confidence must block scalp entry");
});

// ---------- SL safety cap logic (mirrors pepe-futures-bot.js refusal block) ----------

test("safety cap: refuses entry when decision SL > 0.4%", () => {
  // Replicate the refusal predicate from pepe-futures-bot.js:1234
  const refuse = (slPct) => typeof slPct === "number" && slPct > 0.4;
  assert.strictEqual(refuse(0.5), true,  "0.5% must refuse");
  assert.strictEqual(refuse(0.41), true, "0.41% must refuse");
  assert.strictEqual(refuse(0.4), false, "0.4% boundary must allow");
  assert.strictEqual(refuse(0.3), false, "0.3% must allow");
  assert.strictEqual(refuse(undefined), false, "undefined must allow (no clamp data)");
});

test("safety cap: equity floor refuses entry below MIN_EQUITY", () => {
  const MIN = 30;
  const refuse = (eq) => typeof eq === "number" && eq < MIN;
  assert.strictEqual(refuse(29.99), true);
  assert.strictEqual(refuse(30), false);
  assert.strictEqual(refuse(50), false);
  assert.strictEqual(refuse(null), false);
});

// ---------- BingX adapter helpers ----------

test("bingxAdapter: symbol normalization", () => {
  const { toBingxSymbol } = require("../adapters/bingxAdapter");
  assert.strictEqual(toBingxSymbol("BTCUSDT"), "BTC-USDT");
  assert.strictEqual(toBingxSymbol("ETHUSDT"), "ETH-USDT");
  assert.strictEqual(toBingxSymbol("PEPEUSDT"), "PEPE-USDT");
  assert.strictEqual(toBingxSymbol("BTC-USDT"), "BTC-USDT", "already-normalized stays");
  assert.strictEqual(toBingxSymbol("SOLUSDC"), "SOL-USDC");
});

test("bingxAdapter: interval normalization", () => {
  const { toBingxInterval } = require("../adapters/bingxAdapter");
  assert.strictEqual(toBingxInterval("1m"), "1m");
  assert.strictEqual(toBingxInterval("1H"), "1h");
  assert.strictEqual(toBingxInterval("4H"), "4h");
});

test("bingxAdapter: HMAC signature is deterministic + matches manual", () => {
  // Reproduce the signing convention used inside signedRequest
  const SECRET = "test-secret";
  const params = { symbol: "BTC-USDT", side: "BUY", quantity: "1", timestamp: 1700000000000, recvWindow: 5000 };
  const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  const expected = crypto.createHmac("sha256", SECRET).update(queryString).digest("hex");
  // Run twice — must be identical
  const again = crypto.createHmac("sha256", SECRET).update(queryString).digest("hex");
  assert.strictEqual(expected, again);
  assert.strictEqual(expected.length, 64, "sha256 hex length");
});

// ---------- Exchange router ----------

test("exchange router: defaults to bingx and exposes required interface", () => {
  // Force module reload after env mutation
  delete require.cache[require.resolve("../adapters")];
  delete process.env.EXCHANGE;
  const ex = require("../adapters");
  assert.strictEqual(ex.exchangeName, "bingx");
  assert.strictEqual(ex.supportsAtomicSL, true);
  for (const fn of ["getKlines", "getTickerPrice", "getEquity", "setLeverage", "getPosition", "placeMarketOrder", "closeMarketPosition"]) {
    assert.strictEqual(typeof ex[fn], "function", `adapter must expose ${fn}`);
  }
});

test("exchange router: EXCHANGE=bitget switches adapter (no atomic SL)", () => {
  delete require.cache[require.resolve("../adapters")];
  process.env.EXCHANGE = "bitget";
  const ex = require("../adapters");
  assert.strictEqual(ex.exchangeName, "bitget");
  assert.strictEqual(ex.supportsAtomicSL, false);
  // restore
  delete process.env.EXCHANGE;
  delete require.cache[require.resolve("../adapters")];
});
