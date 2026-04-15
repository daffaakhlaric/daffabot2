"use strict";

/**
 * SERVICES MODULE — External integrations (AI, Whale Tracking, Analytics)
 */

const aiService = require("./ai");
const whaleService = require("./whale");
const analyticsService = require("./analytics");

module.exports = {
  ai: aiService,
  whale: whaleService,
  analytics: analyticsService,

  // Direct exports for backward compatibility
  prompts: aiService.prompts,
  whaleTracker: whaleService.whaleTracker,
  analytics: analyticsService.analytics,
};
