"use strict";

/**
 * TIME UTILITIES — Time/date helper functions
 */

/**
 * Get time to nearest round time (next minute boundary)
 */
function getTimeToNextMinute() {
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  return Math.max(0, msToNextMinute);
}

/**
 * Sleep/delay for N milliseconds
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Get today's start timestamp (00:00:00)
 */
function getTodayStart() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

/**
 * Get today's end timestamp (23:59:59)
 */
function getTodayEnd() {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return today.getTime();
}

/**
 * Check if time is within session window
 * @param {number} utcHour - UTC hour (0-23)
 * @returns {string} Session name: LONDON, NEW_YORK, or ASIA
 */
function getSessionByUTCHour(utcHour = null) {
  const hour = utcHour ?? new Date().getUTCHours();

  if (hour >= 7 && hour < 16) return "LONDON";
  if (hour >= 12 && hour < 21) return "NEW_YORK";
  return "ASIA"; // 22-7 UTC
}

/**
 * Format milliseconds to human readable (e.g., "2m 30s")
 */
function formatMs(ms) {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Get elapsed time since start (human readable)
 */
function getElapsedTime(startMs) {
  const elapsed = Date.now() - startMs;
  return formatMs(elapsed);
}

module.exports = {
  getTimeToNextMinute,
  sleep,
  getTodayStart,
  getTodayEnd,
  getSessionByUTCHour,
  formatMs,
  getElapsedTime,
};
