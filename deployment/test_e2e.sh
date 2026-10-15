#!/bin/bash
set -e
TARGET=${1:-"bayut"}
WORKER_URL=${WORKER_URL:-"https://sahiixx-rea-worker.workers.dev"}

echo "=== E2E Test: $TARGET ==="

if [ "$TARGET" = "bayut" ]; then
  echo "Fetching Bayut main bundle..."
  curl -sL https://www.bayut.com/ -o /tmp/bayut.html
  # Extract script src
  SCRIPT=$(grep -o 'src="[^"]*main[^"]*\.js"' /tmp/bayut.html | head -1 | cut -d'"' -f2)
  echo "Found: $SCRIPT"
  if [ ! -z "$SCRIPT" ]; then
    curl -sL "https://www.bayut.com$SCRIPT" -o /tmp/bayut-main.js
    echo "Analyzing $(wc -c < /tmp/bayut-main.js) bytes..."
    curl -X POST "$WORKER_URL/analyze?filename=bayut-main.js" --data-binary @/tmp/bayut-main.js | jq '.confidence, .strings[:3], .evidence[:2]'
  fi
else
  echo "Analyzing local file: $TARGET"
  curl -X POST "$WORKER_URL/analyze?filename=$(basename $TARGET)" --data-binary "@$TARGET" | jq
fi

echo "=== Check bus ==="
echo "Events should be in sahiixx-bus logs"
echo "Check titans-memory: stored analysis with hash"

echo "=== E2E Done ==="
