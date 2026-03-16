const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

class GeminiClient {
  constructor(keyRotator, baseUrl = 'https://generativelanguage.googleapis.com', proxyAgent = null) {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    this.proxyAgent = proxyAgent;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null) {
    // Identify requested model and determine fallback chain
    let requestedModel = 'unknown';
    const modelMatch = path.match(/\/models\/([^:]+):/);
    if (modelMatch) requestedModel = modelMatch[1];

    let modelsToTry = [requestedModel];
    if (requestedModel === 'mypro') {
      modelsToTry = [ 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'];
      logger.info(`[GEMINI] "mypro" requested. Fallback chain: ${modelsToTry.join(' -> ')}`);
    } else if (requestedModel === 'my') {
      modelsToTry = [ 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
      logger.info(`[GEMINI] "my" requested. Fallback chain: ${modelsToTry.join(' -> ')}`);
    }

    const rotationStatusCodes = customStatusCodes || new Set([429, 403]);
    let lastError = null;
    let lastResponse = null;

    // Retry loop for the entire chain
    for (let retryLoop = 0; retryLoop < 2; retryLoop++) {
      let isFirstAttempt = true;
      let allModelsExhausted = true;

      for (const model of modelsToTry) {
        const currentPath = path.replace(/\/models\/[^:]+:/, `/models/${model}:`);
        const requestContext = this.keyRotator.createRequestContext(model);
        let apiKey;
        
        // Try each available key for the current model
        while ((apiKey = requestContext.getNextKey()) !== null) {
          allModelsExhausted = false;
          if (!isFirstAttempt) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          isFirstAttempt = false;

          const stats = this.keyRotator.constructor.getUsageStats(apiKey, model);
          const countStr = Object.entries(stats.requests).map(([status, count]) => `${status}:${count}`).join(', ') || 'None';
          const tokenStr = ` | Tokens: In=${stats.tokens.in}, Out=${stats.tokens.out}, Total=${stats.tokens.total}`;
          const maskedKey = this.maskApiKey(apiKey);
          logger.info(`[GEMINI::${maskedKey}] Attempting ${method} ${model} (ReqPerHttpCode: ${countStr}${tokenStr})`);

          try {
            let response = await this.sendRequest(method, currentPath, body, headers, apiKey, false);
            
            // Handle 503 Service Unavailable (High Demand)
            if (response.statusCode === 503 && response.data && response.data.includes('high demand')) {
              this.keyRotator.constructor.recordRequestStatus(apiKey, model, 503);
              logger.info(`[GEMINI::${maskedKey}] Model overloaded (503). Waiting 1s and rotating key...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              requestContext.recordKeyStatus(apiKey, '503 (High Demand)');
              lastResponse = response;
              continue; // Move to next key for same model
            }
            
            requestContext.recordKeyStatus(apiKey, response.statusCode);

            // Handle 429 Too Many Requests (Rate Limit)
            if (rotationStatusCodes.has(response.statusCode)) {
              this.keyRotator.constructor.recordRequestStatus(apiKey, model, response.statusCode);
              this.keyRotator.constructor.markRateLimited(apiKey, model);
              logger.info(`[GEMINI::${maskedKey}] Status ${response.statusCode} triggers rotation. Trying next key.`);
              if (response.statusCode === 403) {
                const responseData = response.data ? (typeof response.data === 'string' ? response.data : JSON.stringify(response.data)) : '';
                const oneLineData = responseData.replace(/\r?\n|\r/g, '');
                logger.info(`[GEMINI::${maskedKey}] ccc ${oneLineData}`);
              }
              requestContext.markKeyAsRateLimited(apiKey);
              this.keyRotator.incrementFailureCount(apiKey);
              lastResponse = response;
              continue;
            }

            this.keyRotator.constructor.recordRequestStatus(apiKey, model, response.statusCode);
            
            let tokenInfo = '';
            if (response.statusCode >= 200 && response.statusCode < 300 && response.data) {
              try {
                const parsed = JSON.parse(response.data);
                if (parsed.usageMetadata) {
                  const { promptTokenCount, candidatesTokenCount, totalTokenCount } = parsed.usageMetadata;
                  this.keyRotator.constructor.recordTokens(apiKey, model, promptTokenCount, candidatesTokenCount, totalTokenCount);
                  const updatedStats = this.keyRotator.constructor.getUsageStats(apiKey, model);
                  tokenInfo = ` [Tokens: In=${promptTokenCount || 0}, Out=${candidatesTokenCount || 0}, Total=${totalTokenCount || 0}] [SumTokens: In=${updatedStats.tokens.in}, Out=${updatedStats.tokens.out}, Total=${updatedStats.tokens.total}]`;
                }
              } catch (e) { /* ignore parse error */ }
            }

            logger.info(`[GEMINI::${maskedKey}] Success (${response.statusCode})${tokenInfo}`);
            this.keyRotator.resetFailureCount(apiKey);
            return response;

          } catch (error) {
            this.keyRotator.constructor.recordRequestStatus(apiKey, model, 'error');
            logger.info(`[GEMINI::${maskedKey}] Request failed: ${error.message}`);
            lastError = error;
            requestContext.recordKeyStatus(apiKey, error.message);
            this.keyRotator.incrementFailureCount(apiKey);
            continue;
          }
        }
        
        const stats = requestContext.getStats();
        if (stats.triedKeys > 0) {
          let statusLog = [];
          for (const [key, status] of stats.keyStatuses.entries()) {
            statusLog.push(`${this.maskApiKey(key)}=${status}`);
          }
          logger.info(`[GEMINI] All available keys tried for ${model}. Statuses: [${statusLog.join(', ')}]`);
        }
      }

      // Step 5: Global Waiting Strategy
      if (allModelsExhausted && retryLoop === 0) {
        let minWait = 60 * 60 * 1000; // Start with max possible cooldown (10m)
        let foundCooldown = false;
        for (const model of modelsToTry) {
          for (const key of this.keyRotator.apiKeys) {
            const wait = this.keyRotator.constructor.getRemainingCooldown(key, model);
            if (wait > 0) {
              if (wait < minWait) minWait = wait;
              foundCooldown = true;
            }
          }
        }
        
        if (foundCooldown && minWait < 60000) {
          logger.info(`[GEMINI] All keys for all models in chain are in cooldown. Waiting ${Math.ceil(minWait/1000)}s for next available...`);
          await new Promise(resolve => setTimeout(resolve, minWait + 500));
          continue; // Retry the entire chain
        }
      }
      
      break; // Exit retry loop
    }

    // Final failure handling
    if (lastResponse || lastError) {
      return lastResponse || {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ error: { message: lastError ? lastError.message : 'All keys exhausted' } })
      };
    }

    throw new Error('All API keys exhausted without clear error');
  }

  sendRequest(method, path, body, headers, apiKey, useHeader = false) {
    return new Promise((resolve, reject) => {
      // Construct full URL with smart version handling
      let fullUrl;
      if (!path || path === '/') {
        fullUrl = this.baseUrl;
      } else if (path.startsWith('/')) {
        // Handle version replacement if needed
        let effectiveBaseUrl = this.baseUrl;

        // Extract version from path (anything that looks like /vXXX/)
        const pathVersionMatch = path.match(/^\/v[^\/]+\//);
        // Extract version from base URL (anything that ends with /vXXX)
        const baseVersionMatch = this.baseUrl.match(/\/v[^\/]+$/);

        if (pathVersionMatch && baseVersionMatch) {
          const pathVersion = pathVersionMatch[0].slice(0, -1); // Remove trailing /
          const baseVersion = baseVersionMatch[0];

          // If versions are different, replace base URL version with path version
          if (pathVersion !== baseVersion) {
            effectiveBaseUrl = this.baseUrl.replace(baseVersion, pathVersion);
            // Remove the version from path since it's now in the base URL
            path = path.substring(pathVersion.length);
          }
        }

        fullUrl = effectiveBaseUrl.endsWith('/') ? effectiveBaseUrl + path.substring(1) : effectiveBaseUrl + path;
      } else {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
      }

      const url = new URL(fullUrl);

      // Set up headers
      const finalHeaders = {
        'Content-Type': 'application/json',
        ...headers
      };

      // Add API key either as header or URL parameter
      if (useHeader) {
        // Use x-goog-api-key header (official Gemini way)
        finalHeaders['x-goog-api-key'] = apiKey;
      } else {
        // Use URL parameter for backward compatibility
        url.searchParams.append('key', apiKey);
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: finalHeaders,
        agent: this.proxyAgent,
        timeout: 60000
      };

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        options.headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: data
          });
        });
      });

      req.on('error', (error) => {
        const maskedKey = this.maskApiKey(apiKey);
        logger.info(`[GEMINI::${maskedKey}] HTTP request error: ${error.message}`);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy(new Error('Request timeout after 60000ms'));
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  maskApiKey(key) {
    if (!key || key.length < 4) return '**';
    return '**' + key.substring(key.length - 4);
  }
}

module.exports = GeminiClient;
