# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- **Install dependencies:** `npm install`
- **Start proxy server:** `npm start` (defaults to port 8990, configure via `.env`).
  - Run with Tor proxy routing: `node index.js --tor` (requires local Tor SOCKS proxy at 127.0.0.1:9050).
- **Restarting the service:** **NEVER try to restart the service automatically.** The user will restart the service manually when needed.
- **Run Tests:** The test scripts defined in `package.json` point to a missing `tests/` directory. For manual API testing against the local server, use the included bash scripts:
  - `./openaitest.sh`
  - `./geminitest.sh`
  - `./list_models.sh`

## High-Level Architecture
- **Proxy Server (`src/server.js`)**: The core HTTP router. It dynamically routes requests matching `/<provider_name>/*` to the appropriate upstream provider. It intercepts custom headers for access control and custom rotation triggers (e.g., `[STATUS_CODES:429][ACCESS_KEY:...]`) and serves the admin panel at `/admin`.
- **Key Rotation & Persistence (`src/keyRotator.js`)**: Manages API key pools, tracks usage statistics (tokens and HTTP response codes), and applies global cooldowns (default 60 minutes) for rate-limited keys. State and stats are persisted to `state.json` to survive server restarts.
- **Provider Clients (`src/openaiClient.js`, `src/geminiClient.js`)**: Provider-specific adapters that handle request formatting and communication. They utilize `KeyRotator` to fetch an available key, execute the upstream API request, and automatically retry with a different key if a rotation-triggering status code (like 429) is returned.
- **Hot Configuration (`src/config.js`)**: Handles dynamic provider setups, including base URLs, access keys, and API keys. Changes made via the admin panel are hot-reloaded and take effect immediately without requiring a server restart.