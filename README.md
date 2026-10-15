# sahiixx-rea-worker

Edge triage worker for **SAHIIXX REA OS**.

Runs on Cloudflare Workers (Hono). Does **local-only** lightweight analysis:

- Magic byte detection (PE / ELF / WASM / APK / DEX / JS heuristic)
- Shannon entropy
- ASCII string extraction + lightweight classification (api_key_candidate, url, geo_or_portal, auth_header)
- SHA-256
- Publishes `rea.analysis.completed` event to `sahiixx-bus` via JWT + proxy token

**No binary is uploaded beyond the edge request.** Full Ghidra / REA agent work stays on Hermes / local agents.

## Deploy

```bash
npm i
wrangler secret put JWT_SECRET
wrangler secret put PROXY_TOKEN
npm run deploy
```

## Usage

```bash
curl -X POST https://rea-worker.sahiixx.dev/analyze \
  -H "Content-Type: application/octet-stream" \
  --data-binary @some.apk
```

or multipart:

```bash
curl -X POST https://rea-worker.sahiixx.dev/analyze \
  -F "file=@bayut.apk"
```

Response includes sha256, magic, entropy, candidate counts. Full event (including strings) is published to the bus for the swarm.

## Limits

- 8 MB max body (edge constraint)
- 500 strings max returned
- ASCII only

## Next

- Wire `agency-agents` StringHunter / PseudocodeCleaner / RebuildTester to consume `rea.analysis.completed`
- titans-memory + graph-sight indexing
- friday-os voice intent

Built for Dubai RE vertical. Evidence first.
