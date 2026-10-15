# sahiixx-rea-worker

Edge triage worker for **SAHIIXX REA OS**.

Static analysis only at Cloudflare edge:

- Magic byte detection (PE / ELF / WASM / APK / DEX / JS)
- Shannon entropy per 1 KB blocks
- ASCII + UTF-16LE string extraction with category scoring (API keys, Bayut/Dubizzle patterns, endpoints, etc.)
- Evidence chain with offsets + confidence + limitations
- JWT publish of `rea.analysis.completed` to bus
- Optional R2 + KV cache + queue fallback

**Not** a full decompiler. Function recovery and clean rebuilds stay with local REA agents / Hermes / Ghidra.

## Deploy

```bash
npm install
wrangler login

# Create resources once
wrangler r2 bucket create sahiixx-rea-artifacts
wrangler kv namespace create REA_CACHE   # then paste the id into wrangler.toml

# Secrets
wrangler secret put BUS_WEBHOOK_URL
wrangler secret put PROXY_JWT_SECRET
# optional
wrangler secret put TITANS_MEMORY_URL

npm run deploy
```

Or use `./deployment/deploy.sh`.

## Test

```bash
curl -X POST https://<worker>.workers.dev/analyze \
  -F "file=@some.apk"

# or Bayut bundle scrape
WORKER_URL=https://<worker>.workers.dev ./deployment/test_e2e.sh bayut
```

## Honest limits

- `functions` array is heuristic placeholders (random FUN_ addresses). Real disasm requires Ghidra/Hopper via REA agents.
- Rebuild code is template + string evidence, not verified reconstruction.
- 50 MB hard limit. Edge CPU is short.
- Analyze only software you own or are authorized to examine.

## Next real work

1. Replace KV placeholder id in `wrangler.toml`
2. Wire `agency-agents` StringHunter to the real `rea.analysis.completed` payload
3. Keep full Ghidra / REA agent path local
