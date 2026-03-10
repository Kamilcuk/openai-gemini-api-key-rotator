class KeyRotator {
  constructor(apiKeys, apiType = 'unknown') {
    this.apiKeys = [...apiKeys];
    this.apiType = apiType;
    this.keyFailureCounts = new Map();
    this.apiKeys.forEach(key => this.keyFailureCounts.set(key, 0));
    console.log(`[${apiType.toUpperCase()}-ROTATOR] Initialized with ${this.apiKeys.length} API keys`);
  }

  /**
   * Creates a new request context for per-request key rotation
   * @returns {RequestKeyContext} A new context for managing keys for a single request
   */
  createRequestContext() {
    return new RequestKeyContext(this.apiKeys, this.apiType, this.keyFailureCounts);
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
      console.log(`[${this.apiType.toUpperCase()}-ROTATOR] Failure count for ${maskedKey} incremented to ${currentFailures + 1}`);
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
        console.log(`[${this.apiType.toUpperCase()}-ROTATOR] Failure count for ${maskedKey} reset to 0`);
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
  constructor(apiKeys, apiType, keyFailureCounts) {
    this.originalApiKeys = [...apiKeys];
    this.apiType = apiType;
    this.currentIndex = 0;
    this.triedKeys = new Set();
    this.rateLimitedKeys = new Set();
    this.keyStatuses = new Map();
    
    this.apiKeys = this.getPrioritizedKeys(keyFailureCounts);
    console.log(`[${this.apiType.toUpperCase()}] Request context created with ${this.apiKeys.length} prioritized keys.`);
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
    console.log(`[${this.apiType.toUpperCase()}-ROTATOR] Prioritized key order: [${maskedOrder.join(', ')}]`);
    
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
    if (this.currentIndex >= this.apiKeys.length) {
      return null;
    }

    const key = this.apiKeys[this.currentIndex];
    this.triedKeys.add(key);
    const maskedKey = this.maskApiKey(key);
    console.log(`[${this.apiType.toUpperCase()}::${maskedKey}] Trying key (${this.triedKeys.size}/${this.apiKeys.length} tried for this request)`);
    
    this.currentIndex++;
    return key;
  }

  /**
   * Marks the current key as rate limited for this request
   * @param {string} key The API key that was rate limited
   */
  markKeyAsRateLimited(key) {
    this.rateLimitedKeys.add(key);
    const maskedKey = this.maskApiKey(key);
    console.log(`[${this.apiType.toUpperCase()}::${maskedKey}] Rate limited for this request (${this.rateLimitedKeys.size}/${this.triedKeys.size} rate limited)`);
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