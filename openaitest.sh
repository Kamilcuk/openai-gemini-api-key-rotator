#!/bin/bash
set -x

# This version uses backslashes `` to correctly handle a multi-line curl command.
# This ensures all -H (header) and -d (data) flags are part of the single command.

curl "http://localhost:8990/geminiopenai/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "messages": [
      {
        "role": "user",
        "content": "Explain to me how AI works"
      }
    ]
  }'
