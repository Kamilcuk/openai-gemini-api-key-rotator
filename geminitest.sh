#!/usr/bin/env bash
model=${1:-gemini-3.1-pro-preview}
set -x
curl -X POST "http://localhost:8990/gemini/models/${model}:generateContent" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Hello! Please say hello back."
          }
        ]
      }
    ]
  }'
