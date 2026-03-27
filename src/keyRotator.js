const logger = require('./logger');
const fs = require('fs');
const path = require('path');

// Global state for rate limits shared across all instances
const globalCooldowns = new Map();
const globalUsageStats = new Map(); // Stores { requests: { [status]: number }, tokens: { in: number, out: number, total: number } }
const globalKeyComments = new Map(); // Stores { [apiKey]: string }
const COOLDOWN_DURATION = 5 * 60 * 1000; // X minutes * 60 * 1000
const STATE_FILE = path.join(process.cwd(), 'state.json');

// Load state from file on startup
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.globalCooldowns) {
        for (const [key, timestamp] of Object.entries(data.globalCooldowns)) {
          // Only load if not expired
          if (Date.now() - timestamp < COOLDOWN_DURATION) {
            globalCooldowns.set(key, timestamp);
          }
        }
        logger.info(`[STATE] Loaded ${globalCooldowns.size} active rate limits from state.json`);
      }
      
      // Load and migrate stats
      if (data.globalUsageStats) {
        for (const [key, stats] of Object.entries(data.globalUsageStats)) {
          globalUsageStats.set(key, stats);
        }
        logger.info(`[STATE] Loaded usage stats for ${globalUsageStats.size} key/model pairs from state.json`);
      } else {
        // Migration path from previous split format
        let migratedCount = 0;
        if (data.globalRequestCounts) {
          for (const [key, counts] of Object.entries(data.globalRequestCounts)) {
            const stats = globalUsageStats.get(key) || { requests: {}, tokens: { in: 0, out: 0, total: 0 } };
            
            // Handle migration from older formats (good/bad, plain numbers, or status dicts)
            if (typeof counts === 'number') {
               stats.requests["200"] = counts;
            } else if (counts.good !== undefined || counts.bad !== undefined) {
               stats.requests["200"] = counts.good || 0;
               stats.requests["error"] = counts.bad || 0;
            } else {
               stats.requests = counts;
            }
            globalUsageStats.set(key, stats);
            migratedCount++;
          }
        }
        if (data.globalTokenCounts) {
          for (const [key, counts] of Object.entries(data.globalTokenCounts)) {
            const stats = globalUsageStats.get(key) || { requests: {}, tokens: { in: 0, out: 0, total: 0 } };
            stats.tokens = counts;
            globalUsageStats.set(key, stats);
            migratedCount++;
          }
        }
        if (migratedCount > 0) {
          logger.info(`[STATE] Migrated usage stats for ${globalUsageStats.size} key/model pairs from older format.`);
        }
      }

      if (data.globalKeyComments) {
        for (const [key, comment] of Object.entries(data.globalKeyComments)) {
          globalKeyComments.set(key, comment);
        }
        logger.info(`[STATE] Loaded ${globalKeyComments.size} key comments from state.json`);
      }

      // Print loaded counts
      for (const [key, stats] of globalUsageStats.entries()) {
        const [apiKey, model] = key.split(':');
        const maskedKey = apiKey ? ('**' + apiKey.substring(Math.max(0, apiKey.length - 4))) : '**';
        const countStr = Object.entries(stats.requests).map(([status, count]) => `${status}:${count}`).join(', ') || 'None';
        const tokenStr = ` | Tokens: In=${stats.tokens.in}, Out=${stats.tokens.out}, Total=${stats.tokens.total}`;
        logger.info(`[STATE] ${maskedKey} : ${model} -> ReqPerHttpCode: ${countStr}${tokenStr}`);
      }
    }
  } catch (error) {
    logger.info(`[STATE] Failed to load state.json: ${error.message}`);
  }
}

// Save state to file
function saveState() {
  try {
    const activeCooldowns = {};
    for (const [key, timestamp] of globalCooldowns.entries()) {
      if (Date.now() - timestamp < COOLDOWN_DURATION) {
        activeCooldowns[key] = timestamp;
      }
    }
    const keyComments = {};
    for (const [key, comment] of globalKeyComments.entries()) {
      keyComments[key] = comment;
    }
    const usageStats = {};
    for (const [key, stats] of globalUsageStats.entries()) {
      usageStats[key] = stats;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ globalCooldowns: activeCooldowns, globalUsageStats: usageStats, globalKeyComments: keyComments }, null, 2));
  } catch (error) {
    logger.info(`[STATE] Failed to save state.json: ${error.message}`);
  }
}

loadState();

class KeyRotator {
  constructor(apiKeys, apiType = 'unknown') {
    this.apiKeys = [...apiKeys];
    this.apiType = apiType;
    this.keyFailureCounts = new Map();
    this.apiKeys.forEach(key => this.keyFailureCounts.set(key, 0));
    logger.info(`[${apiType.toUpperCase()}-ROTATOR] Initialized with ${this.apiKeys.length} API keys`);
  }

  /**
   * Gets the unified usage statistics for a given key and model combination
   */
  static getAllComments() {
    const comments = {};
    for (const [key, comment] of globalKeyComments.entries()) {
      comments[key] = comment;
    }
    return comments;
  }

  static getKeyComment(apiKey) {
    return globalKeyComments.get(apiKey) || '';
  }

  static setKeyComment(apiKey, comment) {
    globalKeyComments.set(apiKey, comment);
    saveState();
  }

  /**
   * Gets the unified usage statistics for a given key and model combination
   */
  static getAllStats() {
    const stats = {};
    for (const [key, value] of globalUsageStats.entries()) {
      stats[key] = value;
    }
    return stats;
  }

  static getUsageStats(apiKey, modelName) {
    const compositeKey = `${apiKey}:${modelName}`;
    return globalUsageStats.get(compositeKey) || { requests: {}, tokens: { in: 0, out: 0, total: 0 } };
  }

  /**
   * Records the HTTP status or error for a given key and model combination
   */
  static recordRequestStatus(apiKey, modelName, status) {
    const compositeKey = `${apiKey}:${modelName}`;
    const current = KeyRotator.getUsageStats(apiKey, modelName);
    const statusKey = String(status);
    current.requests[statusKey] = (current.requests[statusKey] || 0) + 1;
    globalUsageStats.set(compositeKey, current);
    saveState();
    return current;
  }

  /**
   * Records the token usage for a given key and model combination
   */
  static recordTokens(apiKey, modelName, inTokens, outTokens, totalTokens) {
    const compositeKey = `${apiKey}:${modelName}`;
    const current = KeyRotator.getUsageStats(apiKey, modelName);
    current.tokens.in += (inTokens || 0);
    current.tokens.out += (outTokens || 0);
    current.tokens.total += (totalTokens || 0);
    globalUsageStats.set(compositeKey, current);
    saveState();
    return current;
  }

  /**
   * Marks a key and model combination as rate limited
   * @param {string} apiKey The API key
   * @param {string} modelName The model name
   */
  static markRateLimited(apiKey, modelName) {
    const compositeKey = `${apiKey}:${modelName}`;
    globalCooldowns.set(compositeKey, Date.now());
    saveState();
    const maskedKey = KeyRotator.maskKeyStatic(apiKey);
    logger.info(`[RATELIMIT] Key ${maskedKey} for model ${modelName} marked as rate limited for ${COOLDOWN_DURATION / 1000} seconds`);
  }

  /**
   * Checks if a key and model combination is available
   * @param {string} apiKey The API key
   * @param {string} modelName The model name
   * @returns {boolean} True if available, false if in cooldown
   */
  static isAvailable(apiKey, modelName) {
    const compositeKey = `${apiKey}:${modelName}`;
    if (!globalCooldowns.has(compositeKey)) return true;

    const timestamp = globalCooldowns.get(compositeKey);
    const now = Date.now();
    
    if (now - timestamp > COOLDOWN_DURATION) {
      globalCooldowns.delete(compositeKey);
      saveState();
      return true;
    }
    
    return false;
  }

  /**
   * Gets the remaining cooldown time for a key/model combo in ms
   */
  static getRemainingCooldown(apiKey, modelName) {
    const compositeKey = `${apiKey}:${modelName}`;
    if (!globalCooldowns.has(compositeKey)) return 0;
    const timestamp = globalCooldowns.get(compositeKey);
    return Math.max(0, COOLDOWN_DURATION - (Date.now() - timestamp));
  }

  static maskKeyStatic(key) {
    if (!key || key.length < 4) return '**';
    return '**' + key.substring(key.length - 4);
  }

  /**
   * Creates a new request context for per-request key rotation
   * @returns {RequestKeyContext} A new context for managing keys for a single request
   */
  createRequestContext(modelName = null) {
    return new RequestKeyContext(this.apiKeys, this.apiType, this.keyFailureCounts, modelName);
  }

  /**
   * Increments the failure count for a given API key
   * @param {string} apiKey The key that failed
   */
  incrementFailureCount(apiKey) {
    if (this.keyFailureCounts.has(apiKey)) {
      const currentFailures = this.keyFailureCounts.get(apiKey);
      this.keyFailureCounts.set(apiKey, currentFailures + 1);
      const maskedKey = this.maskApiKey(apiKey);
      logger.info(`[${this.apiType.toUpperCase()}-ROTATOR] Failure count for ${maskedKey} incremented to ${currentFailures + 1}`);
    }
  }

  /**
   * Resets the failure count for a given API key to 0
   * @param {string} apiKey The key that succeeded
   */
  resetFailureCount(apiKey) {
    if (this.keyFailureCounts.has(apiKey)) {
      if (this.keyFailureCounts.get(apiKey) > 0) {
        this.keyFailureCounts.set(apiKey, 0);
        const maskedKey = this.maskApiKey(apiKey);
        logger.info(`[${this.apiType.toUpperCase()}-ROTATOR] Failure count for ${maskedKey} reset to 0`);
      }
    }
  }

  getTotalKeysCount() {
    return this.apiKeys.length;
  }

  maskApiKey(key) {
    if (!key || key.length < 4) return '**';
    return '**' + key.substring(key.length - 4);
  }
}

/**
 * Manages API key rotation for a single request
 * Each request gets its own context to try all available keys with smart shuffling
 */
class RequestKeyContext {
  constructor(apiKeys, apiType, keyFailureCounts, modelName = null) {
    this.originalApiKeys = [...apiKeys];
    this.apiType = apiType;
    this.currentIndex = 0;
    this.triedKeys = new Set();
    this.rateLimitedKeys = new Set();
    this.keyStatuses = new Map();
    this.modelName = modelName;
    
    this.apiKeys = this.getPrioritizedKeys(keyFailureCounts);
    logger.info(`[${this.apiType.toUpperCase()}] Request context created with ${this.apiKeys.length} prioritized keys.`);
  }
  
  /**
   * Sorts keys by failure count (ascending) and shuffles keys within each failure group
   * @param {Map<string, number>} keyFailureCounts Map of API key -> failure count
   * @returns {Array<string>} A prioritized and partially shuffled array of API keys
   */
  getPrioritizedKeys(keyFailureCounts) {
    // Group keys by their failure count
    const groups = new Map();
    for (const [key, count] of keyFailureCounts.entries()) {
      if (!groups.has(count)) {
        groups.set(count, []);
      }
      groups.get(count).push(key);
    }
    
    // Get sorted failure counts (ascending)
    const sortedCounts = [...groups.keys()].sort((a, b) => a - b);
    
    const prioritizedKeys = [];
    for (const count of sortedCounts) {
      const keysInGroup = groups.get(count);
      
      // Fisher-Yates shuffle for keys within the same failure group
      for (let i = keysInGroup.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keysInGroup[i], keysInGroup[j]] = [keysInGroup[j], keysInGroup[i]];
      }
      
      prioritizedKeys.push(...keysInGroup);
    }
    
    // Log the prioritized order for debugging
    const maskedOrder = prioritizedKeys.map(key => this.maskApiKey(key));
    logger.info(`[${this.apiType.toUpperCase()}-ROTATOR] Prioritized key order: [${maskedOrder.join(', ')}]`);
    
    return prioritizedKeys;
  }

  maskApiKey(key) {
    if (!key || key.length < 4) return '**';
    return '**' + key.substring(key.length - 4);
  }

  /**
   * Gets the next available key to try for this request
   * @returns {string|null} The next API key to try, or null if all keys have been tried
   */
  getNextKey() {
    while (this.currentIndex < this.apiKeys.length) {
      const key = this.apiKeys[this.currentIndex];
      this.currentIndex++;

      // Check global cooldown if modelName is provided
      if (this.modelName && !KeyRotator.isAvailable(key, this.modelName)) {
        const maskedKey = this.maskApiKey(key);
        const remainingMs = KeyRotator.getRemainingCooldown(key, this.modelName);
        const remainingSec = Math.ceil(remainingMs / 1000);
        logger.info(`[${this.apiType.toUpperCase()}::${maskedKey}] Skipping key - in global cooldown for ${this.modelName} (${remainingSec}s remaining)`);
        continue;
      }

      this.triedKeys.add(key);
      const maskedKey = this.maskApiKey(key);
      logger.info(`[${this.apiType.toUpperCase()}::${maskedKey}] Trying key (${this.triedKeys.size}/${this.apiKeys.length} available)`);
      
      return key;
    }

    return null;
  }

  /**
   * Marks the current key as rate limited for this request
   * @param {string} key The API key that was rate limited
   */
  markKeyAsRateLimited(key) {
    this.rateLimitedKeys.add(key);
    const maskedKey = this.maskApiKey(key);
    logger.info(`[${this.apiType.toUpperCase()}::${maskedKey}] Rate limited for this request (${this.rateLimitedKeys.size}/${this.triedKeys.size} rate limited)`);
  }

  /**
   * Records the status code for a given key
   * @param {string} key The API key
   * @param {number|string} status The HTTP status code or error message
   */
  recordKeyStatus(key, status) {
    this.keyStatuses.set(key, status);
  }

  getWorkingKey() {
    // The "working" key is the last one we tried from getNextKey that *didn't* fail.
    // Since getNextKey increments currentIndex, the last-tried key is at currentIndex - 1.
    const lastTriedIndex = this.currentIndex - 1;
    return this.apiKeys[lastTriedIndex];
  }

  /**
   * Checks if all tried keys were rate limited
   * @returns {boolean} True if all keys that were tried returned 429
   */
  allTriedKeysRateLimited() {
    return this.triedKeys.size > 0 && this.rateLimitedKeys.size === this.triedKeys.size;
  }

  /**
   * Checks if all available keys have been tried
   * @returns {boolean} True if all keys have been attempted
   */
  allKeysTried() {
    return this.triedKeys.size >= this.apiKeys.length;
  }

  /**
   * Gets statistics about this request's key usage
   * @returns {object} Statistics object
   */
  getStats() {
    return {
      totalKeys: this.apiKeys.length,
      triedKeys: this.triedKeys.size,
      rateLimitedKeys: this.rateLimitedKeys.size,
      hasUntriedKeys: this.triedKeys.size < this.apiKeys.length,
      keyStatuses: this.keyStatuses
    };
  }

  maskApiKey(key) {
    if (!key || key.length < 4) return '**';
    return '**' + key.substring(key.length - 4);
  }
}

module.exports = KeyRotator;
