# Gemini CLI Instructions

- NEVER execute `killall node` or similar global process killing commands. The Gemini CLI is a Node.js process, and doing so will kill the CLI itself. Use precise PIDs to manage background processes instead.