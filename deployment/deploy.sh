#!/bin/bash
set -e
echo "=== SAHIIXX REA OS - Production Deploy ==="
echo "Edge Worker + Bus + Swarm"

cd "$(dirname "$0")/.."
echo "Installing..."
npm install

echo "Checking wrangler..."
npx wrangler --version

echo "Creating R2 bucket if not exists..."
npx wrangler r2 bucket create sahiixx-rea-artifacts || echo "Bucket exists"

echo "Creating KV if not exists..."
npx wrangler kv namespace create REA_CACHE || echo "KV exists - update wrangler.toml with ID"

echo "Deploying worker..."
npx wrangler deploy

echo "Setting secrets (will prompt)..."
echo "Enter BUS_WEBHOOK_URL (your sahiixx-bus endpoint):"
npx wrangler secret put BUS_WEBHOOK_URL
echo "Enter PROXY_JWT_SECRET:"
npx wrangler secret put PROXY_JWT_SECRET

echo "=== Deployed ==="
echo "Test: curl https://sahiixx-rea-worker.<subdomain>.workers.dev/health"
echo "Tail logs: npx wrangler tail"
