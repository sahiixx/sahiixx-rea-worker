#!/usr/bin/env bash
# Run from any directory: bash /path/to/repo/deployment/deploy.sh
# Uses the default wrangler.toml production configuration, NOT --env production.
# Export credentials/secrets as described in .env.example, or use the prompts.
# WORKER_URL accepts the deployed origin or its /health URL. No URL is guessed.
set +x
set -Eeuo pipefail

stage=prerequisites
info() { printf '[REA] %s\n' "$*"; }
fail() { printf '[REA] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "[REA] ERROR during %s; deployment/health success is not confirmed.\n" "$stage" >&2' ERR

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo_root"
config="$repo_root/wrangler.toml"
for program in node npm curl; do
  command -v "$program" >/dev/null 2>&1 || fail "$program is required."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) { console.error("Node.js 18+ is required."); process.exit(1); }'
[[ -f "$config" && -f package.json ]] || fail 'Run the script from a complete repository checkout.'
[[ -f package-lock.json ]] || fail 'package-lock.json is required for reproducible npm ci; obtain the committed lockfile first.'

work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT

# Node is already a project prerequisite. Keep parsing here dependency-free.
# This deliberately supports this repo's one-line TOML string fields and table
# layout; unsupported resource syntax fails instead of guessing resource names.
helper() {
  node - "$@" <<'NODE'
const fs = require('node:fs');
const [mode, ...args] = process.argv.slice(2);
const read = file => fs.readFileSync(file, 'utf8');
const output = value => process.stdout.write(String(value));
const validId = id => /^[0-9a-f]{32}$/i.test(id || '');
const placeholder = id => !id || /placeholder|replace|your[_-]/i.test(id);
function configuration() {
  const source = read('wrangler.toml');
  const sections = [{ name: '', start: 0, end: source.length, fields: {} }];
  let section = sections[0], offset = 0;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const header = line.match(/^[ \t]*(\[\[?[^\]\r\n]+\]\]?)[ \t]*(?:#.*)?\r?\n?$/);
    if (header) {
      section.end = offset;
      section = { name: header[1].replace(/[ \t]/g, ''), start: offset + line.length, end: source.length, fields: {} };
      sections.push(section);
    } else if (['', '[queues]'].includes(section.name) && /^[ \t]*(?:r2_buckets|kv_namespaces|queues(?:\.[\w]+)?|producers|consumers)[ \t]*=/.test(line)) {
      throw new Error('Use resource array tables ([[r2_buckets]], [[kv_namespaces]], [[queues.producers/consumers]]) rather than inline resource arrays.');
    } else if (['', '[[r2_buckets]]', '[[kv_namespaces]]', '[[queues.producers]]', '[[queues.consumers]]'].includes(section.name)) {
      const key = line.match(/^[ \t]*["']?(name|binding|bucket_name|jurisdiction|id|queue|dead_letter_queue)["']?[ \t]*=/)?.[1];
      if (key) {
        const field = line.match(/^[ \t]*[\w]+[ \t]*=[ \t]*("[^"\\\r\n]*"|'[^'\r\n]*')[ \t]*(?:#.*)?\r?\n?$/);
        if (!field || Object.hasOwn(section.fields, key)) throw new Error(`Unsupported or duplicate ${key} in ${section.name || 'root'}; use one plain quoted string.`);
        section.fields[key] = { value: field[1].slice(1, -1), start: offset + field.index + line.indexOf(field[1]), length: field[1].length };
      }
    }
    offset += line.length;
  }
  const value = (s, key) => s.fields[key]?.value;
  const name = value(sections[0], 'name');
  if (!/^[a-z0-9_-]+$/.test(name || '')) throw new Error('Missing or unsupported Worker name in wrangler.toml.');
  const resources = [];
  const bindings = new Set();
  for (const s of sections) {
    if (s.name === '[[r2_buckets]]') {
      const bucket = value(s, 'bucket_name'), jurisdiction = value(s, 'jurisdiction') || '-';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(bucket || '') || !/^[a-z-]+$/.test(jurisdiction)) throw new Error('Unsupported R2 bucket name/jurisdiction.');
      resources.push(['r2', bucket, jurisdiction]);
    } else if (s.name === '[[kv_namespaces]]') {
      const binding = value(s, 'binding'), id = value(s, 'id');
      if (!/^[A-Za-z_][\w]*$/.test(binding || '') || bindings.has(binding)) throw new Error('Missing or duplicate KV binding.');
      bindings.add(binding);
      if (!validId(id) && !(binding === 'REA_CACHE' && placeholder(id))) throw new Error(`Set a valid KV ID for ${binding}; only missing/placeholder REA_CACHE IDs can be patched.`);
      resources.push(['kv', binding, validId(id) ? id : '-']);
    } else if (['[[queues.producers]]', '[[queues.consumers]]'].includes(s.name)) {
      for (const key of ['queue', 'dead_letter_queue']) {
        const queue = value(s, key);
        if (key === 'dead_letter_queue' && queue === undefined) continue;
        if (!/^[a-z0-9_-]+$/.test(queue || '')) throw new Error('Missing or unsupported queue name.');
        resources.push(['queue', queue, '-']);
      }
    }
  }
  return { source, sections, name, resources, value };
}
try {
  if (mode === 'plan') {
    const { source, name, resources } = configuration();
    fs.writeFileSync(args[0], source);
    output([['worker', name, '-'], ...resources].map(row => row.join('\t')).join('\n') + '\n');
  } else if (mode === 'patch-kv') {
    const [id, snapshot] = args;
    const { source, sections, value } = configuration();
    if (!validId(id) || source !== read(snapshot)) throw new Error('Invalid KV ID or wrangler.toml changed during provisioning; refusing to patch.');
    const matches = sections.filter(s => s.name === '[[kv_namespaces]]' && value(s, 'binding') === 'REA_CACHE');
    if (matches.length !== 1 || !placeholder(value(matches[0], 'id')) || validId(value(matches[0], 'id'))) throw new Error('Refusing to overwrite an existing REA_CACHE ID.');
    const section = matches[0], field = section.fields.id;
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const at = field ? field.start : section.end;
    const replacement = field ? `"${id}"` : `${source[at - 1] === '\n' ? '' : eol}id = "${id}"${eol}`;
    const patched = source.slice(0, at) + replacement + source.slice(at + (field?.length || 0));
    const temporary = `wrangler.toml.deploy-${process.pid}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', fs.statSync('wrangler.toml').mode);
    try {
      try {
        fs.writeFileSync(descriptor, patched);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, 'wrangler.toml');
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    fs.writeFileSync(snapshot, patched);
  } else if (mode === 'config-unchanged') {
    if (read('wrangler.toml') !== read(args[0])) throw new Error('wrangler.toml changed during provisioning; refusing to deploy a different configuration.');
  } else if (mode === 'kv-id') {
    const [file, binding, configured, worker] = args;
    const rows = JSON.parse(read(file));
    if (!Array.isArray(rows) || rows.some(row => !validId(row.id) || typeof row.title !== 'string')) throw new Error('Unexpected KV namespace list output.');
    const matches = rows.filter(row => configured === '-' ? row.title === `${worker}-${binding}` : row.id === configured);
    if (matches.length > 1) throw new Error(`Ambiguous KV namespace for ${binding}.`);
    if (configured !== '-' && !matches.length) throw new Error(`Configured KV ID for ${binding} was not found in this account; it was not changed.`);
    output(matches[0]?.id || '');
  } else if (mode === 'r2-exists') {
    // Wrangler 3 prints labelled records, not JSON, for r2 bucket list.
    const text = read(args[0]);
    const names = [...text.matchAll(/^[ \t]*name:[ \t]*(\S+)[ \t]*$/gm)].map(m => m[1]);
    if (!names.length && !/^Listing buckets\.\.\.[ \t]*$/m.test(text)) throw new Error('Unexpected Wrangler R2 bucket list output.');
    output(names.includes(args[1]) ? 'yes' : 'no');
  } else if (mode === 'queue-names') {
    // Wrangler 3 queues list has no --json flag; parse exact table cells.
    const text = read(args[0]).trim();
    if (!text) process.exit(0);
    const rows = text.split('\n').filter(line => /^\s*[│|]/.test(line)).map(line => line.trim().split(/[│|]/).slice(1, -1).map(cell => cell.trim()));
    const index = rows[0]?.indexOf('name') ?? -1;
    if (index < 0 || rows.slice(1).some(row => !/^[a-z0-9_-]+$/.test(row[index] || ''))) throw new Error('Unexpected Wrangler queue table output.');
    output(rows.slice(1).map(row => row[index]).join('\n') + (rows.length > 1 ? '\n' : ''));
  } else if (mode === 'authenticated') {
    output(/You are logged in with /i.test(read(args[0])) ? 'yes' : 'no');
  } else if (mode === 'health-url') {
    const url = new URL(process.env.WORKER_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/', '/health'].includes(url.pathname.replace(/\/$/, ''))) throw new Error('WORKER_URL must be an HTTP(S) origin or /health URL without credentials, query, or fragment.');
    output(`${url.origin}/health`);
  } else if (mode === 'health') {
    const health = JSON.parse(read(args[0]));
    if (health?.status !== 'ok' || ['bucket', 'cache', 'bus'].some(key => health.checks?.[key] !== true)) throw new Error('Health must report status=ok and bucket/cache/bus checks=true.');
    if (process.env.TITANS_MEMORY_URL && health.checks?.memory !== true) throw new Error('Health reports the requested memory binding is missing.');
  } else {
    throw new Error('Unknown deployment helper operation.');
  }
} catch (error) {
  console.error(`[REA] ${error.message}`);
  process.exit(1);
}
NODE
}

info 'Production deploy using the default wrangler.toml configuration.'
helper plan "$work_dir/config.snapshot" > "$work_dir/plan"
health_url=''
if [[ -n "${WORKER_URL:-}" ]]; then
  export WORKER_URL
  health_url=$(helper health-url)
elif [[ ! -t 0 ]]; then
  fail 'Set WORKER_URL for a noninteractive deployment. No health check was performed.'
fi

# Collect values before making any remote changes. Files such as .dev.vars are
# local Wrangler inputs, not a source of production secrets for this script.
for key in BUS_WEBHOOK_URL PROXY_JWT_SECRET TITANS_MEMORY_URL; do
  value=${!key:-}
  if [[ -z "$value" && -t 0 ]]; then
    prompt="$key (required): "
    [[ "$key" != TITANS_MEMORY_URL ]] || prompt="$key (optional; Enter keeps any existing remote value): "
    IFS= read -r -s -p "$prompt" value || fail "Could not read $key."
    printf '\n' >&2
  fi
  if [[ "$key" != TITANS_MEMORY_URL && -z "${value//[[:space:]]/}" ]]; then
    fail "Export $key or run interactively to provide it."
  fi
  printf -v "$key" '%s' "$value"
  export "$key"
done
unset value

stage='dependency installation'
info 'Installing locked dependencies (including local Wrangler)...'
npm ci --include=dev --prefer-offline
wrangler_bin="$repo_root/node_modules/.bin/wrangler"
[[ -x "$wrangler_bin" ]] || fail 'npm ci did not provide the local Wrangler executable.'
wrangler() {
  # Preserve machine-readable output formats used below, irrespective of the
  # caller's color/log preferences. Always target this checkout's config.
  NO_COLOR=1 FORCE_COLOR=0 WRANGLER_LOG=log "$wrangler_bin" "$@" --config "$config"
}
wrangler --version

stage=typecheck
npm run typecheck

stage=authentication
if [[ -n "${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}" || -n "${CLOUDFLARE_API_KEY:-${CF_API_KEY:-}}" ]]; then
  info 'Using supplied Cloudflare credentials; resource commands will validate access.'
else
  authenticated=no
  if wrangler whoami > "$work_dir/whoami"; then
    authenticated=$(helper authenticated "$work_dir/whoami")
  fi
  # Wrangler 3 may exit zero while printing "You are not authenticated".
  if [[ "$authenticated" != yes ]]; then
    [[ -t 0 ]] || fail 'No authenticated Wrangler session. Export CLOUDFLARE_API_TOKEN or run interactively to log in.'
    info 'Logging in to Cloudflare...'
    wrangler login
    wrangler whoami > "$work_dir/whoami"
    [[ $(helper authenticated "$work_dir/whoami") == yes ]] || fail 'Wrangler login did not establish an authenticated session.'
  fi
fi

stage='resource provisioning'
queue_inventory_loaded=no
existing_queues=()
load_queues() {
  local page=1 queue existing
  while :; do
    wrangler queues list --page "$page" > "$work_dir/queues"
    helper queue-names "$work_dir/queues" > "$work_dir/queue-names"
    [[ -s "$work_dir/queue-names" ]] || break
    while IFS= read -r queue; do
      # A repeated name means pagination did not advance; don't loop forever.
      for existing in "${existing_queues[@]+"${existing_queues[@]}"}"; do
        [[ "$existing" != "$queue" ]] || fail 'Queue pagination returned a repeated name.'
      done
      existing_queues+=("$queue")
    done < "$work_dir/queue-names"
    page=$((page + 1))
    [[ "$page" -le 1000 ]] || fail 'Queue pagination exceeded 1000 pages.'
  done
  queue_inventory_loaded=yes
}

while IFS=$'\t' read -r kind name configured; do
  case "$kind" in
    worker) worker_name="$name" ;;
    r2)
      r2_options=()
      [[ "$configured" == '-' ]] || r2_options=(--jurisdiction "$configured")
      wrangler r2 bucket list "${r2_options[@]+"${r2_options[@]}"}" > "$work_dir/r2"
      r2_exists=$(helper r2-exists "$work_dir/r2" "$name")
      if [[ "$r2_exists" == yes ]]; then
        info "Reusing R2 bucket: $name"
      else
        wrangler r2 bucket create "$name" "${r2_options[@]+"${r2_options[@]}"}"
      fi
      ;;
    kv)
      wrangler kv namespace list > "$work_dir/kv"
      kv_id=$(helper kv-id "$work_dir/kv" "$name" "$configured" "$worker_name")
      if [[ -z "$kv_id" ]]; then
        # Wrangler 3 titles this namespace <configured-worker-name>-<binding>.
        wrangler kv namespace create "$name"
        wrangler kv namespace list > "$work_dir/kv"
        kv_id=$(helper kv-id "$work_dir/kv" "$name" "$configured" "$worker_name")
        [[ -n "$kv_id" ]] || fail "Created KV namespace for $name was not found; config was not patched."
      else
        info "Reusing KV namespace for $name"
      fi
      if [[ "$configured" == '-' ]]; then
        helper patch-kv "$kv_id" "$work_dir/config.snapshot"
        info 'Updated only the missing/placeholder REA_CACHE ID in wrangler.toml.'
      fi
      ;;
    queue)
      [[ "$queue_inventory_loaded" == yes ]] || load_queues
      found=no
      for existing in "${existing_queues[@]+"${existing_queues[@]}"}"; do
        [[ "$existing" != "$name" ]] || found=yes
      done
      if [[ "$found" == yes ]]; then
        info "Reusing queue: $name"
      else
        wrangler queues create "$name"
        existing_queues+=("$name")
      fi
      ;;
    *) fail "Unexpected resource type: $kind" ;;
  esac
done < "$work_dir/plan"

helper config-unchanged "$work_dir/config.snapshot"
stage='Worker secret upload'
info 'Uploading Worker runtime secrets (separate from GitHub Actions credentials)...'
for key in BUS_WEBHOOK_URL PROXY_JWT_SECRET TITANS_MEMORY_URL; do
  if [[ -n "${!key}" ]]; then
    # Values go through stdin, never command-line arguments or temporary files.
    printf '%s' "${!key}" | wrangler secret put "$key"
  fi
done

stage=deployment
wrangler deploy
info 'Wrangler deploy succeeded; health has not yet been verified.'

stage='health verification'
if [[ -z "$health_url" ]]; then
  IFS= read -r -p 'Deployed Worker origin or /health URL (from deploy output): ' WORKER_URL || fail 'No health URL supplied; health was not checked.'
  [[ -n "$WORKER_URL" ]] || fail 'No health URL supplied; health was not checked.'
  export WORKER_URL
  health_url=$(helper health-url)
fi
info "Checking $health_url"
http_status=$(curl --silent --show-error --fail --connect-timeout 10 --max-time 30 \
  --retry 3 --retry-delay 2 --output "$work_dir/health.json" --write-out '%{http_code}' -- "$health_url")
[[ "$http_status" == 2[0-9][0-9] ]] || fail "Health returned HTTP $http_status; success is not confirmed."
helper health "$work_dir/health.json"
info "Deployment complete; /health passed at $health_url (status=ok; bucket/cache/bus bindings present)."
# /health checks binding presence, not bus delivery or queue consumption.
