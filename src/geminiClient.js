const https = require('https');
const { URL } = require('url');

class GeminiClient {
  constructor(keyRotator, baseUrl = 'https://generativelanguage.googleapis.com') {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null) {
    let pathsToTry = [path];
    
    if (path && path.includes('/models/mypro:')) {
      pathsToTry = [
        path.replace(/\/models\/mypro:/, '/models/gemini-3.1-pro-preview:'),
        path.replace(/\/models\/mypro:/, '/models/gemini-3-pro-preview:'),
        path.replace(/\/models\/mypro:/, '/models/gemini-2.5-pro:')
      ];
      console.log(`[GEMINI] "pro" model requested. Will try fallback strategy: ${pathsToTry.join(' then ')}`);
    }

    const rotationStatusCodes = customStatusCodes || new Set([429]);
    let lastError = null;
    let lastResponse = null;

    let isFirstAttempt = true;
    for (let pathIndex = 0; pathIndex < pathsToTry.length; pathIndex++) {
      const currentPath = pathsToTry[pathIndex];
      const requestContext = this.keyRotator.createRequestContext();
      let apiKey;
      
      while ((apiKey = requestContext.getNextKey()) !== null) {
        if (!isFirstAttempt) {
          console.log('[GEMINI] Waiting 1 second before trying next key...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        isFirstAttempt = false;

        const maskedKey = this.maskApiKey(apiKey);

        console.log(`[GEMINI::${maskedKey}] Attempting ${method} ${currentPath}`);

        try {
          let response = await this.sendRequest(method, currentPath, body, headers, apiKey, false);
          
          if (response.statusCode === 503 && response.data && response.data.includes('high demand')) {
            console.log(`[GEMINI::${maskedKey}] Model overloaded (503). Waiting 10 seconds before retrying...`);
            await new Promise(resolve => setTimeout(resolve, 20000));
            console.log(`[GEMINI::${maskedKey}] Retrying ${method} ${currentPath} after delay...`);
            response = await this.sendRequest(method, currentPath, body, headers, apiKey, false);
          }
          
          requestContext.recordKeyStatus(apiKey, response.statusCode);

          if (rotationStatusCodes.has(response.statusCode)) {
            console.log(`[GEMINI::${maskedKey}] Status ${response.statusCode} triggers rotation - trying next key. Response: ${response.data}`);
            requestContext.markKeyAsRateLimited(apiKey);
            this.keyRotator.incrementFailureCount(apiKey);
            lastResponse = response;
            continue;
          }

          console.log(`[GEMINI::${maskedKey}] Success (${response.statusCode})`);
          this.keyRotator.resetFailureCount(requestContext.getWorkingKey());
          return response;
        } catch (error) {
          console.log(`[GEMINI::${maskedKey}] Request failed: ${error.message}`);
          lastError = error;
          requestContext.recordKeyStatus(apiKey, error.message);
          this.keyRotator.incrementFailureCount(apiKey);
          continue;
        }
      }
      
      const stats = requestContext.getStats();
      let statusLog = [];
      if (stats.keyStatuses) {
        for (const [key, status] of stats.keyStatuses.entries()) {
          statusLog.push(`${this.maskApiKey(key)}=${status}`);
        }
      }
      const statusString = statusLog.length > 0 ? ` Statuses: [${statusLog.join(', ')}]` : '';
      console.log(`[GEMINI] All ${stats.totalKeys} keys tried for ${currentPath}. ${stats.rateLimitedKeys} were rate limited.${statusString}`);
      
      if (requestContext.allTriedKeysRateLimited()) {
        if (pathIndex < pathsToTry.length - 1) {
          console.log(`[GEMINI] All keys rate limited for ${currentPath}, falling back to next model in sequence...`);
          continue;
        } else {
          console.log('[GEMINI] All keys rate limited for all models - returning 429');
          return lastResponse || {
            statusCode: 429,
            headers: { 'content-type': 'application/json' },
            data: JSON.stringify({
              error: {
                code: 429,
                message: 'All API keys have been rate limited for this request',
                status: 'RESOURCE_EXHAUSTED'
              }
            })
          };
        }
      }
      
      if (lastError && pathIndex === pathsToTry.length - 1) {
        throw lastError;
      }
      
      if (pathIndex === pathsToTry.length - 1) {
        throw new Error('All API keys exhausted without clear error');
      }
    }
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
        headers: finalHeaders
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
        console.log(`[GEMINI::${maskedKey}] HTTP request error: ${error.message}`);
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
}

module.exports = GeminiClient;
