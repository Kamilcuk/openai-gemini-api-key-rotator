const Config = require('./src/config');
const KeyRotator = require('./src/keyRotator');
const GeminiClient = require('./src/geminiClient');
const OpenAIClient = require('./src/openaiClient');
const ProxyServer = require('./src/server');
const logger = require('./src/logger');

function parseArgs() {
  const args = process.argv.slice(2);
  let useTor = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      logger.info('OpenAI / Gemini API Key Rotator Proxy');
      logger.info('\nUsage: node index.js [options]');
      logger.info('\nOptions:');
      logger.info('  -h, --help    Show this help message and exit');
      logger.info('  --tor         Forward outbound requests through local Tor SOCKS proxy (socks5://127.0.0.1:9050)');
      process.exit(0);
    } else if (arg === '--tor') {
      useTor = true;
    } else {
      logger.info(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return { useTor };
}

function main() {
  try {
    const { useTor } = parseArgs();
    
    let proxyAgent = null;
    if (useTor) {
      try {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        proxyAgent = new SocksProxyAgent('socks5://127.0.0.1:9050');
        logger.info('[INIT] Tor proxy routing enabled (socks5://127.0.0.1:9050)');
      } catch (e) {
        logger.error('[ERROR] Could not initialize Tor proxy agent. Please run "npm install socks-proxy-agent" first.');
        process.exit(1);
      }
    }

    const config = new Config();
    
    // Initialize legacy clients for backward compatibility
    let geminiClient = null;
    let openaiClient = null;
    
    if (config.hasGeminiKeys()) {
      const geminiKeyRotator = new KeyRotator(config.getGeminiApiKeys(), 'gemini');
      geminiClient = new GeminiClient(geminiKeyRotator, config.getGeminiBaseUrl(), proxyAgent);
      logger.info('[INIT] Legacy Gemini client initialized');
    } else if (config.hasAdminPassword()) {
      logger.info('[INIT] No legacy Gemini keys found - can be configured via admin panel');
    }
    
    if (config.hasOpenaiKeys()) {
      const openaiKeyRotator = new KeyRotator(config.getOpenaiApiKeys(), 'openai');
      openaiClient = new OpenAIClient(openaiKeyRotator, config.getOpenaiBaseUrl(), proxyAgent);
      logger.info('[INIT] Legacy OpenAI client initialized');
    } else if (config.hasAdminPassword()) {
      logger.info('[INIT] No legacy OpenAI keys found - can be configured via admin panel');
    }
    
    const server = new ProxyServer(config, geminiClient, openaiClient, proxyAgent);
    server.start();
    
    process.on('SIGINT', () => {
      logger.info('\nShutting down server...');
      server.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { Config, KeyRotator, GeminiClient, OpenAIClient, ProxyServer };