const https = require('https');
const { URL } = require('url');
const logger = require('./logger');
const { resolveModelChain } = require('./modelAliases');

class OpenAIClient {
  constructor(keyRotator, baseUrl = 'https://api.openai.com', proxyAgent = null) {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    this.proxyAgent = proxyAgent;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null) {
    let parsedBody = typeof body === 'string' ? {} : (body || {});
    if (typeof body === 'string' && body.trim() !== '') {
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {
        logger.error(`[OPENAI] Failed to parse request body: ${e.message}`);
      }
    }

    // Identify requested model and determine fallback chain
    let requestedModel = parsedBody.model || 'unknown';

    let modelsToTry = resolveModelChain(requestedModel);
    if (modelsToTry.length > 1) {
      logger.info(`[OPENAI] Alias "${requestedModel}" requested. Fallback chain: ${modelsToTry.join(' -> ')}`);
    }

    const rotationStatusCodes = customStatusCodes || new Set([429, 403]);
    let lastError = null;
    let lastResponse = null;

    // Retry loop for the entire chain
    for (let retryLoop = 0; retryLoop < 2; retryLoop++) {
      let isFirstAttempt = true;
      let allModelsExhausted = true;

      for (const model of modelsToTry) {
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
          logger.info(`[OPENAI::${maskedKey}] Attempting ${method} ${this.baseUrl}${path} with model ${model} (ReqPerHttpCode: ${countStr}${tokenStr})`);

          try {
            const newBody = typeof parsedBody === 'object' ? { ...parsedBody, model: model } : parsedBody;
            const response = await this.sendRequest(method, path, newBody, headers, apiKey);
            
            requestContext.recordKeyStatus(apiKey, response.statusCode);

            if (rotationStatusCodes.has(response.statusCode)) {
              this.keyRotator.constructor.recordRequestStatus(apiKey, model, response.statusCode);
              this.keyRotator.constructor.markRateLimited(apiKey, model);
              logger.info(`[OPENAI::${maskedKey}] Status ${response.statusCode} triggers rotation. Trying next key.`);
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
                if (parsed.usage) {
                  const { prompt_tokens, completion_tokens, total_tokens } = parsed.usage;
                  this.keyRotator.constructor.recordTokens(apiKey, model, prompt_tokens, completion_tokens, total_tokens);
                  const updatedStats = this.keyRotator.constructor.getUsageStats(apiKey, model);
                  tokenInfo = ` [Tokens: In=${prompt_tokens || 0}, Out=${completion_tokens || 0}, Total=${total_tokens || 0}] [SumTokens: In=${updatedStats.tokens.in}, Out=${updatedStats.tokens.out}, Total=${updatedStats.tokens.total}]`;
                }
              } catch (e) { /* ignore parse error */ }
            }

            logger.info(`[OPENAI::${maskedKey}] Success (${response.statusCode})${tokenInfo}`);
            this.keyRotator.resetFailureCount(apiKey);
            return response;

          } catch (error) {
            this.keyRotator.constructor.recordRequestStatus(apiKey, model, 'error');
            logger.info(`[OPENAI::${maskedKey}] Request failed: ${error.message}`);
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
          logger.info(`[OPENAI] All available keys tried for ${model}. Statuses: [${statusLog.join(', ')}]`);
        }
      }

      // Global Waiting Strategy
      if (allModelsExhausted && retryLoop === 0) {
        let minWait = 60 * 60 * 1000;
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
          logger.info(`[OPENAI] All keys for all models in chain are in cooldown. Waiting ${Math.ceil(minWait/1000)}s for next available...`);
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

  sendRequest(method, path, body, headers, apiKey) {
    return new Promise((resolve, reject) => {
      // Construct full URL - handle cases where path might be empty or just "/"
      let fullUrl;
      if (!path || path === '/') {
        fullUrl = this.baseUrl;
      } else if (path.startsWith('/')) {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path.substring(1) : this.baseUrl + path;
      } else {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
      }
      
      const url = new URL(fullUrl);
      
      // Build headers, ensuring Authorization header is properly set
      const finalHeaders = {
        'Content-Type': 'application/json',
        ...headers
      };

      // Only set Authorization if not already provided in headers
      if (!headers || !headers.authorization) {
        finalHeaders['Authorization'] = `Bearer ${apiKey}`;
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: finalHeaders,
        agent: this.proxyAgent
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
        logger.error(`[OPENAI::${maskedKey}] HTTP request error: ${error.message}`);
        reject(error);
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

  getTargetUrl(method, path) {
    let fullUrl;
    if (!path || path === '/') {
      fullUrl = this.baseUrl;
    } else if (path.startsWith('/')) {
      fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path.substring(1) : this.baseUrl + path;
    } else {
      fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
    }
    return fullUrl;
  }
}

module.exports = OpenAIClient;