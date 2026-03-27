# Makefile for openai-gemini-api-key-rotator

.PHONY: start start-tor install test-openai test-gemini help test

# Default target
help:
	@echo "Available commands:"
	@echo "  make start         - Start the proxy server (default port 8990)"
	@echo "  make start-tor     - Start the proxy server with Tor SOCKS routing"
	@echo "  make install       - Install dependencies"
	@echo "  make test          - Run all tests"
	@echo "  make test-openai   - Test an OpenAI-compatible request"
	@echo "  make test-gemini   - Test a Gemini request"

# Start the server normally
start:
	npm start

# Start the server with Tor routing
start-tor:
	node index.js --tor

# Install dependencies
install:
	npm install

# Run manual tests using the bash scripts
test-openai:
	./openaitest.sh

test-gemini:
	./geminitest.sh

# Run all test scripts (Node tests + bash scripts)
test: test-openai test-gemini
	@echo "\nAll manual tests completed."
