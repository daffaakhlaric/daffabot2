"use strict";

/**
 * Whale Activity Detector V2 — Institutional-grade detection
 * Pure technical analysis from klines + optional orderbook for spoof detection
 */

// ═══ Module-level state for orderbook snapshot tracking (spoof detection) ═══
const _obSnapshots = [];         // [{ ts, bids: [[price, size], ...], asks: [[price, size], ...] }]
const OB_SNAPSHOT_WINDOW = 10000; // 10 seconds
const OB_WALL_MULTIPLIER  = 5;   // wall is >5x average size
const MAX_SNAPSHOTS = 20;

/**
 * Detect spoof walls in orderbook — large orders that appear/disappear without being filled
 */
function _detectSpoof(orderbook) {
  // Safety: if no orderbook data, return safe defaults
  if (!orderbook || !orderbook.bids || !orderbook.asks) {
    return { spoofDetected: false, spoofSide: null, confidence: 0 };
  }

  const now = Date.now();

  // 1. Store current orderbook snapshot
  _obSnapshots.push({ ts: now, bids: orderbook.bids, asks: orderbook.asks });

  // 2. Prune old snapshots (keep only last 10 seconds)
  while (_obSnapshots.length > 0 && now - _obSnapshots[0].ts > OB_SNAPSHOT_WINDOW) {
    _obSnapshots.shift();
  }

  // Keep max 20 snapshots
  while (_obSnapshots.length > MAX_SNAPSHOTS) {
    _obSnapshots.shift();
  }

  // 3. Look for walls in historical snapshots
  for (let i = 0; i < _obSnapshots.length - 1; i++) {
    const prevSnap = _obSnapshots[i];
    const prevAge = now - prevSnap.ts;

    // Only check snapshots that are 2-10 seconds old
    if (prevAge < 2000 || prevAge > OB_SNAPSHOT_WINDOW) continue;

    // Calculate average bid/ask size from current snapshot (top 5)
    const avgBidSize = orderbook.bids.slice(0, 5).reduce((s, [_, sz]) => s + sz, 0) / Math.max(1, orderbook.bids.slice(0, 5).length);
    const avgAskSize = orderbook.asks.slice(0, 5).reduce((s, [_, sz]) => s + sz, 0) / Math.max(1, orderbook.asks.slice(0, 5).length);

    // Check for large walls in previous snapshot
    for (const [bidPrice, bidSize] of prevSnap.bids.slice(0, 5)) {
      // Was there a huge bid wall (fake buy)?
      if (bidSize > avgBidSize * OB_WALL_MULTIPLIER) {
        // Is that bid level GONE from current orderbook?
        const stillExists = orderbook.bids.some(([p]) => Math.abs(p - bidPrice) < bidPrice * 0.0001);
        if (!stillExists) {
          return { spoofDetected: true, spoofSide: "BID", confidence: 75 };
        }
      }
    }

    for (const [askPrice, askSize] of prevSnap.asks.slice(0, 5)) {
      // Was there a huge ask wall (fake sell)?
      if (askSize > avgAskSize * OB_WALL_MULTIPLIER) {
        const stillExists = orderbook.asks.some(([p]) => Math.abs(p - askPrice) < askPrice * 0.0001);
        if (!stillExists) {
          return { spoofDetected: true, spoofSide: "ASK", confidence: 75 };
        }
      }
    }
  }

  return { spoofDetected: false, spoofSide: null, confidence: 0 };
}

function detectWhaleActivity({ klines, price, orderbook = null }) {
  if (!klines || klines.length < 20) {
    return {
      whaleDetected: false,
      signal: "NEUTRAL",
      confidence: 0,
      type: "INSUFFICIENT_DATA",
      reason: "Not enough klines",
      patterns: [],
      whaleScore: 0,
      spoof: { spoofDetected: false, spoofSide: null, confidence: 0 },
      absorption: { absorbed: false, side: null, confidence: 0 },
      sweep: { sweepDetected: false, direction: null, confidence: 0 },
    };
  }

  const patterns = [];
  const detections = [];
  let whaleScore = 0;  // ← Accumulate institutional activity score (0-100)

  // 1. Volume Spike Detection
  const avgVol = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const currentVol = klines[klines.length - 1].volume;
  const spikeRatio = currentVol / avgVol;

  if (spikeRatio > 6) {
    const signal = klines[klines.length - 1].close > klines[klines.length - 1].open ? "LONG" : "SHORT";
    detections.push({
      type: "VOLUME_SPIKE_HIGH",
      confidence: 85,
      signal,
      pattern: `Vol spike 6x (${spikeRatio.toFixed(1)}x)`,
    });
    patterns.push(`VOLUME_SPIKE ${spikeRatio.toFixed(1)}x`);
    whaleScore += 20;  // ← High spike = 20pts
  } else if (spikeRatio > 4) {
    const signal = klines[klines.length - 1].close > klines[klines.length - 1].open ? "LONG" : "SHORT";
    detections.push({
      type: "VOLUME_SPIKE_MEDIUM",
      confidence: 70,
      signal,
      pattern: `Vol spike 4x (${spikeRatio.toFixed(1)}x)`,
    });
    patterns.push(`VOLUME_SPIKE ${spikeRatio.toFixed(1)}x`);
    whaleScore += 15;  // ← Medium spike = 15pts
  } else if (spikeRatio > 3) {
    const signal = klines[klines.length - 1].close > klines[klines.length - 1].open ? "LONG" : "SHORT";
    detections.push({
      type: "VOLUME_SPIKE_LOW",
      confidence: 60,
      signal,
      pattern: `Vol spike 3x (${spikeRatio.toFixed(1)}x)`,
    });
    patterns.push(`VOLUME_SPIKE ${spikeRatio.toFixed(1)}x`);
    whaleScore += 10;  // ← Low spike = 10pts
  }

  // 2. Large Body Detection (Impulse Candle)
  const current = klines[klines.length - 1];
  const avgBody = klines
    .slice(-20)
    .reduce((s, k) => s + Math.abs(k.close - k.open), 0) / 20;
  const currentBody = Math.abs(current.close - current.open);
  const totalRange = current.high - current.low;

  if (currentBody > 2 * avgBody && currentVol > 2 * avgVol) {
    // Impulse quality improved: close near high (bullish) or low (bearish)
    const closeNearHigh = current.close > current.low + totalRange * 0.7;
    const closeNearLow = current.close < current.high - totalRange * 0.7;

    if (closeNearHigh || closeNearLow) {
      const signal = current.close > current.open ? "LONG" : "SHORT";
      detections.push({
        type: "IMPULSE_CANDLE",
        confidence: 75,
        signal,
        pattern: `Large body (${(currentBody / avgBody).toFixed(1)}x avg)`,
      });
      patterns.push("IMPULSE_CANDLE");
      whaleScore += 15;  // ← Impulse candle = 15pts
    }
  }

  // 3. Absorption Pattern (Wick Analysis)
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bodyRatio = totalRange > 0 ? Math.abs(current.close - current.open) / totalRange : 0;

  if (totalRange > 0) {
    if (lowerWick > 0.6 * totalRange && currentVol > 2 * avgVol && current.close > current.low + totalRange * 0.5) {
      detections.push({
        type: "ABSORPTION_BULL",
        confidence: 80,
        signal: "LONG",
        pattern: "Bull absorption (wick + volume + close high)",
      });
      patterns.push("ABSORPTION_BULL");
      whaleScore += 20;  // ← Absorption = 20pts (strong buyer/seller activity)
    }

    if (upperWick > 0.6 * totalRange && currentVol > 2 * avgVol && current.close < current.high - totalRange * 0.5) {
      detections.push({
        type: "ABSORPTION_BEAR",
        confidence: 80,
        signal: "SHORT",
        pattern: "Bear absorption (wick + volume + close low)",
      });
      patterns.push("ABSORPTION_BEAR");
      whaleScore += 20;  // ← Absorption = 20pts
    }
  }

  // 4. Consecutive Accumulation (last 4 candles)
  if (klines.length >= 4) {
    const last4 = klines.slice(-4);
    const allGreen = last4.every(k => k.close > k.open);
    const volumeIncreasing = last4[0].volume < last4[1].volume &&
                             last4[1].volume < last4[2].volume &&
                             last4[2].volume < last4[3].volume;

    if (allGreen && volumeIncreasing) {
      detections.push({
        type: "ACCUMULATION",
        confidence: 65,
        signal: "LONG",
        pattern: "4 green + vol increasing",
      });
      patterns.push("ACCUMULATION");
    }

    const allRed = last4.every(k => k.close < k.open);
    if (allRed && volumeIncreasing) {
      detections.push({
        type: "DISTRIBUTION",
        confidence: 65,
        signal: "SHORT",
        pattern: "4 red + vol increasing",
      });
      patterns.push("DISTRIBUTION");
    }
  }

  // 5. Stop Hunt Pattern
  if (klines.length >= 6) {
    const last5 = klines.slice(-6, -1);
    const last5Low = Math.min(...last5.map(k => k.low));
    const last5High = Math.max(...last5.map(k => k.high));

    if (current.low < last5Low * (1 - 0.003) && current.close > last5Low) {
      detections.push({
        type: "STOP_HUNT_BULL",
        confidence: 85,
        signal: "LONG",
        pattern: "Below recent low + close recovery",
      });
      patterns.push("STOP_HUNT_BULL");
      whaleScore += 20;  // ← Stop hunt / Liquidity sweep = 20pts
    }

    if (current.high > last5High * (1 + 0.003) && current.close < last5High) {
      detections.push({
        type: "STOP_HUNT_BEAR",
        confidence: 85,
        signal: "SHORT",
        pattern: "Above recent high + close pullback",
      });
      patterns.push("STOP_HUNT_BEAR");
      whaleScore += 20;  // ← Stop hunt / Liquidity sweep = 20pts
    }
  }

  // Resolve conflicts
  if (detections.length === 0) {
    // Still check for spoof even if no TA patterns
    const spoof = _detectSpoof(orderbook);
    return {
      whaleDetected: false,
      signal: "NEUTRAL",
      confidence: 0,
      type: "NO_PATTERN",
      reason: "No whale patterns detected",
      patterns: [],
      whaleScore: 0,
      spoof,
      absorption: { absorbed: false, side: null, confidence: 0 },
      sweep: { sweepDetected: false, direction: null, confidence: 0 },
    };
  }

  // Sum confidence by signal
  const longConfidence = detections
    .filter(d => d.signal === "LONG")
    .reduce((s, d) => s + d.confidence, 0) / Math.max(1, detections.filter(d => d.signal === "LONG").length);

  const shortConfidence = detections
    .filter(d => d.signal === "SHORT")
    .reduce((s, d) => s + d.confidence, 0) / Math.max(1, detections.filter(d => d.signal === "SHORT").length);

  let finalSignal = "NEUTRAL";
  let finalConfidence = 0;
  let finalType = detections[0].type;

  if (longConfidence > shortConfidence + 10) {
    finalSignal = "LONG";
    finalConfidence = Math.round(longConfidence);
    finalType = detections.find(d => d.signal === "LONG")?.type || finalType;
  } else if (shortConfidence > longConfidence + 10) {
    finalSignal = "SHORT";
    finalConfidence = Math.round(shortConfidence);
    finalType = detections.find(d => d.signal === "SHORT")?.type || finalType;
  } else if (Math.abs(longConfidence - shortConfidence) <= 10) {
    finalSignal = "NEUTRAL";
    finalConfidence = Math.round(Math.max(longConfidence, shortConfidence));
  }

  // Spoof detection (check orderbook for walls)
  const spoof = _detectSpoof(orderbook);

  // Absorption detection (wrap existing absorption detection)
  const absorption = {
    absorbed: detections.some(d => d.type === "ABSORPTION_BULL" || d.type === "ABSORPTION_BEAR"),
    side: detections.find(d => d.type.startsWith("ABSORPTION_"))?.signal || null,
    confidence: detections.find(d => d.type.startsWith("ABSORPTION_"))?.confidence || 0,
  };

  // Sweep detection (wrap existing stop hunt as liquidity sweep)
  const sweep = {
    sweepDetected: detections.some(d => d.type === "STOP_HUNT_BULL" || d.type === "STOP_HUNT_BEAR"),
    direction: detections.find(d => d.type.startsWith("STOP_HUNT_"))?.signal || null,
    confidence: detections.find(d => d.type.startsWith("STOP_HUNT_"))?.confidence || 0,
  };

  return {
    whaleDetected: true,
    signal: finalSignal,
    confidence: Math.min(100, finalConfidence),
    type: finalType,
    reason: detections[0].pattern,
    patterns,
    whaleScore: Math.min(100, whaleScore),  // Cap at 100
    spoof,
    absorption,
    sweep,
  };
}

module.exports = { detectWhaleActivity };
