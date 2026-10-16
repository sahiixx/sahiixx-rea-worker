#!/bin/bash
set -e
echo "=== SAHIIXX REA Worker - Cloudflare Deploy ==="
cd "$(dirname "$0")/.."
npm install
if ! wrangler whoami >/dev/null 2>&1; then
  wrangler login
fi
wrangler r2 bucket create sahiixx-rea-artifacts || true
wrangler kv namespace create REA_CACHE || true
echo "Paste KV id into wrangler.toml if new"
wrangler secret put BUS_WEBHOOK_URL
wrangler secret put PROXY_JWT_SECRET
wrangler deploy
echo "Test: curl \$(wrangler deployments list 2>/dev/null | head -1) /health"
