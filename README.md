# sahiixx-rea-worker

Cloudflare Worker for SAHIIXX REA OS: edge-native triage for competitor APKs, JS bundles, WASM, ELF, and PE files.

This project is intentionally narrow and honest: it performs fast static triage at the edge, extracts evidence with byte offsets, and publishes a `rea.analysis.completed` event for downstream bus/memory/agent workflows. It is not a full decompiler. Deep disassembly and function reconstruction stay local to the REA toolchain.

## Purpose

In Dubai real-estate product research, the feature war is real:

- Bayut and similar apps ship clustering, search behavior, and geo heuristics quickly
- Manual reverse engineering is slow and repetitive
- You need evidence, not just “it exists” claims
- You need a triage layer that can route promising files to deep analysis and rebuild workflows

This worker provides the first layer of that pipeline:

- detect file type by magic bytes
- measure entropy per 1KB blocks
- extract ASCII and UTF-16LE strings
- classify likely API keys, URLs, and real-estate patterns
- emit evidence with offsets and confidence
- push the result to the REA bus for orchestration and agent follow-up

## What it does

The worker performs:

- magic-byte detection for `PE`, `ELF`, `WASM`, `ZIP_APK`, `DEX`, and JS/TS bundles
- Shannon entropy analysis over 1KB blocks
- string extraction with ASCII and UTF-16LE handling
- category scoring such as:
  - BAYUT
  - DUBIZZLE
  - PROPERTYFINDER
  - API key / token pattern detection
  - URL detection
  - Dubai property domain indicators
- evidence chaining with offset + confidence
- optional cache + R2 storage + bus event publication
- heuristic rebuild skeleton generation for downstream analysis

## Why this exists

This repository is the edge triage worker in the broader SAHIIXX REA OS stack:

- `sahiixx-rea-worker` = quick static triage at the edge
- `sahiixx-bus` = orchestration and event fanout
- `sahiixx-titans-memory` = surprise-weighted persistence and dedupe
- `agency-agents` = swarm-based rebuild and verification
- `sovereign-revenue-os` = convert evidence into pipeline value

This repo is designed to answer questions like:

- What kind of file was uploaded?
- Is it packed or high-entropy?
- Does it contain likely API keys or Bayut/Dubizzle strings?
- Where are the promising strings and evidence offsets?
- What should an agent investigate next?

## Architecture

The worker is intentionally small and fast.

### Core flow

1. Receive file upload or raw bytes
2. Validate size (`<= 50MB`)
3. Compute SHA-256 and check cache
4. Detect file magic and type
5. Compute entropy blocks
6. Extract strings and classify them
7. Build evidence chain with offsets
8. Produce a heuristic rebuild skeleton
9. Publish `rea.analysis.completed` to the bus
10. Store result in cache and R2 when enabled

### Files

- `src/index.ts` — Hono app, routing, orchestration, cache, upload handling
- `src/lib/fileRecon.ts` — magic detection, entropy, hash
- `src/lib/stringExtractor.ts` — string extraction and pattern detection
- `src/lib/evidence.ts` — evidence chain generation
- `src/lib/busPublisher.ts` — JWT bus publication and queue fallback
- `scripts/run_triage.mjs` — local smoke triage script
- `scripts/local-bus.mjs` — local test bus stub
- `scripts/e2e-smoke.mjs` — worker + bus smoke flow

## API

### Health

```bash
curl http://127.0.0.1:8787/health
```

Returns status and environment binding checks.

### Analyze

```bash
curl -X POST http://127.0.0.1:8787/analyze \
  -F "file=@some.apk"
```

Or with explicit filename:

```bash
curl -X POST http://127.0.0.1:8787/analyze?filename=sample.js \
  -F "file=@sample.js"
```

Response shape includes:

- `id`
- `fileName`
- `fileType`
- `fileSize`
- `sha256`
- `recon`
- `strings`
- `imports`
- `functions`
- `evidence`
- `confidence`
- `rebuild`
- `bus`

## Local development

1. Install dependencies:

```bash
npm install
```

2. Start local dev mode:

```bash
npx wrangler dev --local --port 8787
```

3. Upload a file:

```bash
curl -X POST http://127.0.0.1:8787/analyze \
  -F "file=@./sample.js" \
  -F "filename=sample.js"
```

## Local smoke test

This repo includes a local smoke flow for a Bayut-like bundle.

```bash
npm run smoke:e2e
```

Start the Worker separately with `npm run dev:local` before running this script.
The existing smoke script:

- boots the local bus stub
- uploads a synthetic bundle with a Bayut-like key and clustering logic
- prints the Worker response and manually forwards it to the bus stub
- writes artifacts to `./artifacts`

This is not an assertion-based verification of the Worker's own signed bus
publication. Use the local evidence validator below for deterministic assertions.

Artifacts:

- `./artifacts/e2e-result.json`
- `./artifacts/bus-events.jsonl`

## Deploy

This project is built for Cloudflare Workers.

### Reproducible local checks and deployment helper

```bash
npm ci
npm run typecheck
npm run validate
npm run test:tooling
# Only analyze files you own or are authorized to inspect:
npm run validate -- /path/to/authorized.apk ./artifacts/authorized-check
```

`validate` defaults to a synthetic sample. It checks actual SHA-256, byte offsets,
schema, confidence and entropy, and writes `triage_result.json` plus a redacted
`evidence-summary.md` to `artifacts/validate-smoke/`. Unknown/empty files are valid
triage inputs; vendor-key and clustering assertions apply only to the built-in
sample. The local runner does not generate or verify rebuild output. Full JSON
can contain sensitive strings; local artifacts and environment files are ignored.
`test:tooling` runs offline Node checks; `test` remains the existing Vitest command,
which currently has no application suites.

For the first production deployment, use `bash deployment/deploy.sh` (or
`npm run deploy:script`). It installs the locked dependencies, authenticates,
creates/reuses R2, KV and the configured queue, patches the placeholder REA_CACHE
ID, prompts for runtime secrets, deploys, and checks the supplied Worker URL.
See `.env.example` for export/prompt behavior; do not source placeholders or
commit real secrets. The default `wrangler.toml` is production: no named
`[env.production]` exists. Resource creation may incur Cloudflare charges.

The Actions workflow runs typecheck, offline tooling checks and synthetic validation on every push/PR.
Same-repository PRs receive a redacted evidence comment; fork/Dependabot PRs skip
that write-only step. Manual dispatch on main or a published release can deploy.
Before using CI deployment, provision resources/runtime secrets once and commit
the real KV ID (not a credential). Configure GitHub secrets
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and optionally `WORKER_URL`
(which can also be a repository variable). Protect the `production` environment
with required reviewers. GitHub credentials do not provision Worker secrets.
A missing WORKER_URL explicitly skips CI health verification.

`bash PUSH_TO_REPO.sh` prepares a separate feature-branch clone and prints review
and push commands without publishing. `--push` explicitly opts into a commit and
normal feature-branch push; there is no forced or direct-main push.

### Manual alternative

1. Log in to Wrangler:

```bash
wrangler login
```

2. Create required resources once:

```bash
wrangler r2 bucket create sahiixx-rea-artifacts
wrangler kv namespace create REA_CACHE
wrangler queues create rea-analysis-queue
```

Replace the REA_CACHE placeholder ID in `wrangler.toml` with the returned ID.

3. Set secrets:

```bash
wrangler secret put BUS_WEBHOOK_URL
wrangler secret put PROXY_JWT_SECRET
```

Optional:

```bash
wrangler secret put TITANS_MEMORY_URL
```

4. Deploy:

```bash
npm run deploy
```

## Config / environment

The worker expects the following bindings where available:

- `REA_BUCKET` — R2 bucket
- `REA_CACHE` — KV cache
- `REA_QUEUE` — queue fallback
- `BUS_WEBHOOK_URL` — webhook to sahiixx-bus
- `PROXY_JWT_SECRET` — JWT secret for event signing
- `TITANS_MEMORY_URL` — optional memory service endpoint

## Honest limits

This worker is intentionally not a full decompiler.

- It does static triage only
- Function names are heuristic placeholders (`FUN_...`)
- “Rebuild” output is a scaffold, not a verified binary reconstruction
- Full decompilation still belongs in the local REA toolchain (Ghidra/Hopper/IDA style workflows)
- Edge CPU and time are limited
- Only analyze software you own or are authorized to inspect

## Typical use cases

- upload a competitor APK or JS bundle for rapid triage
- detect suspicious entropy blocks and likely key material
- locate patterns such as `bayut_live_*` or `clusterProperties`
- fan out evidence to the REA bus and memory graph
- decide when to escalate to deeper local analysis

## Roadmap

Planned next steps:

- stronger vendor-specific pattern detection
- artifact-level dedupe with SHA indexing + memory recall
- deeper local verification hooks for REA agents
- richer event schemas for bus and downstream analysis
- more formal test fixtures for Bayut/Dubizzle/PropertyFinder bundles

## License

This repository does not currently declare a license in the repo metadata. Use only under the terms appropriate to your authorized research and compliance environment.

## Summary

This project is the edge triage layer of SAHIIXX REA OS: fast, evidence-driven, static, and intentionally bounded. It is designed to find signals quickly, route promising files to deeper analysis, and feed the bus-driven REA pipeline with actionable, offset-based evidence.

"Proof not promises. Fast triage, real evidence, deeper analysis only where it matters."
