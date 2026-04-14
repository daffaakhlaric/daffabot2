"use strict";

/**
 * Whale Activity Detector — Detects unusual large transactions
 * Pure technical analysis from klines only
 */

function detectWhaleActivity({ klines, price }) {
  if (!klines || klines.length < 20) {
    return {
      whaleDetected: false,
      signal: "NEUTRAL",
      confidence: 0,
      type: "INSUFFICIENT_DATA",
      reason: "Not enough klines",
      patterns: [],
    };
  }

  const patterns = [];
  const detections = [];

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
  } else if (spikeRatio > 4) {
    const signal = klines[klines.length - 1].close > klines[klines.length - 1].open ? "LONG" : "SHORT";
    detections.push({
      type: "VOLUME_SPIKE_MEDIUM",
      confidence: 70,
      signal,
      pattern: `Vol spike 4x (${spikeRatio.toFixed(1)}x)`,
    });
    patterns.push(`VOLUME_SPIKE ${spikeRatio.toFixed(1)}x`);
  } else if (spikeRatio > 3) {
    const signal = klines[klines.length - 1].close > klines[klines.length - 1].open ? "LONG" : "SHORT";
    detections.push({
      type: "VOLUME_SPIKE_LOW",
      confidence: 60,
      signal,
      pattern: `Vol spike 3x (${spikeRatio.toFixed(1)}x)`,
    });
    patterns.push(`VOLUME_SPIKE ${spikeRatio.toFixed(1)}x`);
  }

  // 2. Large Body Detection
  const current = klines[klines.length - 1];
  const avgBody = klines
    .slice(-20)
    .reduce((s, k) => s + Math.abs(k.close - k.open), 0) / 20;
  const currentBody = Math.abs(current.close - current.open);

  if (currentBody > 2 * avgBody && currentVol > 2 * avgVol) {
    const signal = current.close > current.open ? "LONG" : "SHORT";
    detections.push({
      type: "IMPULSE_CANDLE",
      confidence: 75,
      signal,
      pattern: `Large body (${(currentBody / avgBody).toFixed(1)}x avg)`,
    });
    patterns.push("IMPULSE_CANDLE");
  }

  // 3. Absorption Pattern (Wick Analysis)
  const totalRange = current.high - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bodyRatio = Math.abs(current.close - current.open) / totalRange;

  if (totalRange > 0) {
    if (lowerWick > 0.6 * totalRange && currentVol > 2 * avgVol && current.close > current.low + totalRange * 0.5) {
      detections.push({
        type: "ABSORPTION_BULL",
        confidence: 80,
        signal: "LONG",
        pattern: "Bull absorption (wick + volume + close high)",
      });
      patterns.push("ABSORPTION_BULL");
    }

    if (upperWick > 0.6 * totalRange && currentVol > 2 * avgVol && current.close < current.high - totalRange * 0.5) {
      detections.push({
        type: "ABSORPTION_BEAR",
        confidence: 80,
        signal: "SHORT",
        pattern: "Bear absorption (wick + volume + close low)",
      });
      patterns.push("ABSORPTION_BEAR");
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
    }

    if (current.high > last5High * (1 + 0.003) && current.close < last5High) {
      detections.push({
        type: "STOP_HUNT_BEAR",
        confidence: 85,
        signal: "SHORT",
        pattern: "Above recent high + close pullback",
      });
      patterns.push("STOP_HUNT_BEAR");
    }
  }

  // Resolve conflicts
  if (detections.length === 0) {
    return {
      whaleDetected: false,
      signal: "NEUTRAL",
      confidence: 0,
      type: "NO_PATTERN",
      reason: "No whale patterns detected",
      patterns: [],
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

  return {
    whaleDetected: true,
    signal: finalSignal,
    confidence: Math.min(100, finalConfidence),
    type: finalType,
    reason: detections[0].pattern,
    patterns,
  };
}

module.exports = { detectWhaleActivity };
