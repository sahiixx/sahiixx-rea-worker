// Run with Node's built-in runner via npm run test:tooling (not Vitest).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// All install/auth/provision/deploy/HTTP operations below are local stubs.
// The real Node binary only executes this test and the script's pure helpers.
const script = fileURLToPath(new URL('../deployment/deploy.sh', import.meta.url));
const original = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const kvId = '1234567890abcdef1234567890abcdef';
const otherId = 'abcdef1234567890abcdef1234567890';
const placeholder = 'rea_cache_kv_placeholder_replace_with_real_id';
const json = file => JSON.parse(readFileSync(file, 'utf8'));

const stub = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
let args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.DEPLOY_TEST_STATE, 'utf8'));
const record = { tool, args, cwd: process.cwd() };
if (tool === 'wrangler' && args[0] === 'secret') record.input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(record) + '\n');
const save = () => fs.writeFileSync(process.env.DEPLOY_TEST_STATE, JSON.stringify(state));
const out = value => process.stdout.write(value);
const die = message => { console.error(message); process.exit(31); };
if (tool === 'npx') die('Unexpected npx invocation: network fetching is forbidden');
if (tool === 'npm') {
  if (args.join(' ') === 'ci --include=dev --prefer-offline') {
    if (state.installFailure) die('stub npm ci failure');
  } else if (args.join(' ') === 'run typecheck') {
    if (state.typecheckFailure) die('stub typecheck failure');
  } else die('Unexpected npm command');
} else if (tool === 'curl') {
  if (state.curlFailure) die('stub HTTP/network failure');
  const target = args[args.length - 1];
  if (target !== 'https://worker.example.invalid/health') die('Unexpected health target');
  fs.writeFileSync(args[args.indexOf('--output') + 1], state.healthBody);
  out(state.httpStatus || '200');
} else if (tool === 'wrangler') {
  if (args[args.length - 2] !== '--config' || args[args.length - 1] !== path.join(process.cwd(), 'wrangler.toml')) die('Wrong config/cwd');
  args = args.slice(0, -2);
  if (state.failCommand && args.join(' ') === state.failCommand) die('stub resource/secret/deploy failure');
  switch (args.slice(0, 3).join(' ')) {
    case 'r2 bucket list':
      if (state.r2Output !== undefined) out(state.r2Output);
      else out('Listing buckets...\n' + state.buckets.map(name => 'name:          ' + name + '\ncreation_date: 2026-01-01\n').join('\n'));
      break;
    case 'r2 bucket create':
      if (state.buckets.includes(args[3])) die('Bucket already exists');
      state.buckets.push(args[3]); save(); break;
    case 'kv namespace list': out(state.kvOutput ?? JSON.stringify(state.namespaces)); break;
    case 'kv namespace create':
      if (state.mutateConfig) fs.appendFileSync('wrangler.toml', '# external concurrent edit\n');
      state.namespaces.push({ id: '${kvId}', title: state.workerName + '-' + args[3] }); save(); break;
    default:
      if (args[0] === '--version') out('3.90.0\n');
      else if (args[0] === 'whoami') {
        out(state.loggedIn ? 'You are logged in with an OAuth Token.\n' : 'You are not authenticated. Please run wrangler login.\n');
        if (state.whoamiFailure) process.exit(32);
      } else if (args[0] === 'login') { state.loggedIn = !state.loginIneffective; save(); }
      else if (args[0] === 'queues' && args[1] === 'list') {
        if (state.queueOutput !== undefined) out(state.queueOutput);
        else {
          const page = Number(args[args.indexOf('--page') + 1]);
          const names = state.queues.slice((page - 1) * 2, page * 2);
          if (names.length) out('┌────┬──────┬────────────┐\n│ id │ name │ created_on │\n├────┼──────┼────────────┤\n' + names.map(name => '│ id │ ' + name + ' │ 2026-01-01 │').join('\n') + '\n└────┴──────┴────────────┘\n');
        }
      } else if (args[0] === 'queues' && args[1] === 'create') {
        if (state.queues.includes(args[2])) die('Queue already exists');
        state.queues.push(args[2]); save();
      } else if (args[0] === 'secret' && args[1] === 'put') {
        if (!record.input) die('Empty secret');
      } else if (args[0] === 'deploy') out('Deployed at https://worker.example.invalid\n');
      else die('Unexpected Wrangler command: ' + args.join(' '));
  }
} else die('Unexpected executable');
`;

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'REA deploy offline spaces '));
  const repo = path.join(root, 'repo with spaces');
  const bin = path.join(root, 'stub bin');
  const cwd = path.join(root, 'unrelated cwd');
  for (const dir of [repo, bin, cwd, path.join(repo, 'deployment'), path.join(repo, 'node_modules'), path.join(repo, 'node_modules/.bin')]) mkdirSync(dir);
  copyFileSync(script, path.join(repo, 'deployment/deploy.sh'));
  const config = options.config ?? original;
  writeFileSync(path.join(repo, 'wrangler.toml'), config);
  writeFileSync(path.join(repo, 'package.json'), '{"private":true}');
  if (!options.noLock) writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  for (const tool of ['npm', 'curl', 'npx']) writeFileSync(path.join(bin, tool), stub, { mode: 0o755 });
  if (!options.noWrangler) writeFileSync(path.join(repo, 'node_modules/.bin/wrangler'), stub, { mode: 0o755 });
  // Keep helper execution real, while preventing reliance on any global Wrangler.
  writeFileSync(path.join(bin, 'node'), `#!/bin/bash\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'calls.jsonl');
  const state = {
    workerName: 'sahiixx-rea-worker', buckets: [], namespaces: [], queues: [], loggedIn: false,
    healthBody: JSON.stringify({ status: 'ok', checks: { bucket: true, cache: true, bus: true, memory: false } }),
    ...options.state,
  };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(logFile, '');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, LANG: 'C.UTF-8',
    DEPLOY_TEST_STATE: stateFile, DEPLOY_TEST_LOG: logFile,
    CLOUDFLARE_API_TOKEN: 'fixture-api-token', CLOUDFLARE_ACCOUNT_ID: 'fixture-account',
    WORKER_URL: 'https://worker.example.invalid',
    BUS_WEBHOOK_URL: 'https://bus.example.invalid/ingest', PROXY_JWT_SECRET: 'fixture signing secret',
    ...options.env,
  };
  const entry = path.relative(cwd, path.join(repo, 'deployment/deploy.sh'));
  const invoke = (extraEnv = {}, direct = false) => spawnSync(direct ? entry : '/bin/bash', direct ? [] : [entry], {
    cwd, env: { ...env, ...extraEnv }, input: '', encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  const interactive = input => spawnSync('/usr/bin/script', ['--quiet', '--return', '--command', 'bash "$DEPLOY_TEST_SCRIPT"', '/dev/null'], {
    cwd, env: { ...env, DEPLOY_TEST_SCRIPT: path.join(repo, 'deployment/deploy.sh') },
    input, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    repo, cwd, env, invoke, interactive, config,
    calls: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    currentConfig: () => readFileSync(path.join(repo, 'wrangler.toml'), 'utf8'),
    state: () => json(stateFile),
  };
}
const command = call => call.args.slice(0, -2).join(' ');
const has = (f, prefix) => f.calls().some(call => call.tool === 'wrangler' && command(call).startsWith(prefix));
function succeeds(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Deployment complete; \/health passed/);
}
function fails(result) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Deployment complete; \/health passed/);
}

test('installs reproducibly, provisions all configured resources, uploads secrets, and verifies health from any cwd', t => {
  const f = fixture(t);
  const result = f.invoke();
  succeeds(result);
  assert.equal(f.currentConfig(), original.replace(`"${placeholder}"`, `"${kvId}"`));
  assert.deepEqual(f.state().buckets, ['sahiixx-rea-artifacts']);
  assert.deepEqual(f.state().queues, ['rea-analysis-queue']);
  assert.deepEqual(f.state().namespaces, [{ id: kvId, title: 'sahiixx-rea-worker-REA_CACHE' }]);
  const calls = f.calls();
  assert.ok(calls.every(call => call.cwd === f.repo));
  assert.deepEqual(calls.filter(call => call.tool === 'npm').map(call => call.args), [
    ['ci', '--include=dev', '--prefer-offline'], ['run', 'typecheck'],
  ]);
  assert.ok(!has(f, 'login') && !has(f, 'whoami') && !has(f, 'deployments'));
  assert.ok(calls.every(call => !call.args.includes('--env')));
  const secrets = calls.filter(call => call.args[0] === 'secret');
  assert.deepEqual(secrets.map(call => [call.args[2], call.input]), [
    ['BUS_WEBHOOK_URL', f.env.BUS_WEBHOOK_URL], ['PROXY_JWT_SECRET', f.env.PROXY_JWT_SECRET],
  ]);
  for (const value of [f.env.CLOUDFLARE_API_TOKEN, f.env.PROXY_JWT_SECRET, f.env.BUS_WEBHOOK_URL]) {
    assert.ok(!(result.stdout + result.stderr).includes(value));
    assert.ok(calls.every(call => !call.args.includes(value)));
  }
  assert.ok(calls.findIndex(call => call.args[0] === 'deploy') > calls.findIndex(call => call.args[0] === 'secret'));
  // Rerunning with a real ID must reuse resources and leave config byte-identical.
  const deployedConfig = f.currentConfig();
  succeeds(f.invoke({}, true));
  assert.equal(f.currentConfig(), deployedConfig);
  assert.equal(f.calls().filter(call => command(call).startsWith('r2 bucket create')).length, 1);
  assert.equal(f.calls().filter(call => command(call).startsWith('kv namespace create')).length, 1);
  assert.equal(f.calls().filter(call => command(call).startsWith('queues create')).length, 1);
});

test('uses configured names, reuses exact matches across queue pages, preserves other IDs/environments/comments', t => {
  const config = original.replace('sahiixx-rea-worker', 'renamed-worker')
    .replace('sahiixx-rea-artifacts', 'custom-artifacts').replace('rea-analysis-queue', 'custom-queue')
    .replace(`id = "${placeholder}"`, `id = '${placeholder}' # preserve this comment`)
    + `\n[[r2_buckets]]\nbinding = "SECOND_BUCKET"\nbucket_name = "other-artifacts"\n`
    + `\n[[kv_namespaces]]\nbinding = "SECOND_CACHE"\nid = "${otherId}"\n`
    + '\n[[queues.consumers]]\nqueue = "consumer-queue"\ndead_letter_queue = "dead-letter"\n'
    + '\n[env.preview]\nname = "preview-only"\n[[env.preview.kv_namespaces]]\nbinding = "REA_CACHE"\nid = "preview_placeholder"\n';
  const f = fixture(t, { config, state: {
    workerName: 'renamed-worker', buckets: ['custom-artifacts', 'other-artifacts'],
    queues: ['unrelated', 'custom-queue-extra', 'custom-queue', 'consumer-queue', 'dead-letter'],
    namespaces: [{ id: kvId, title: 'renamed-worker-REA_CACHE' }, { id: otherId, title: 'existing-other' }],
  } });
  succeeds(f.invoke());
  assert.equal(f.currentConfig(), config.replace(`'${placeholder}'`, `"${kvId}"`));
  assert.ok(!f.calls().some(call => / create(?: |$)/.test(command(call))));
  assert.ok(has(f, 'queues list --page 4'));
});

for (const idLine of ['', 'id = ""', "id = '' # empty", 'id = "YOUR_KV_ID"']) {
  test(`patches only REA_CACHE when its ID is missing/empty/placeholder: ${idLine || '(missing)'}`, t => {
    const config = original.replace(`id = "${placeholder}"`, idLine);
    const f = fixture(t, { config });
    succeeds(f.invoke());
    assert.equal((f.currentConfig().match(new RegExp(kvId, 'g')) || []).length, 1);
    assert.match(f.currentConfig(), /binding = "REA_CACHE"\n/);
  });
}

test('preserves a valid configured KV ID even when its title differs; never silently replaces a missing real ID', t => {
  const config = original.replace(placeholder, otherId);
  const f = fixture(t, { config, state: { namespaces: [{ id: otherId, title: 'renamed-existing-namespace' }] } });
  succeeds(f.invoke());
  assert.equal(f.currentConfig(), config);
  const missing = fixture(t, { config });
  fails(missing.invoke());
  assert.equal(missing.currentConfig(), config);
  assert.ok(!has(missing, 'kv namespace create') && !has(missing, 'deploy'));
});

test('an existing Wrangler session avoids login; zero-exit unauthenticated whoami fails noninteractively', t => {
  const f = fixture(t, { env: { CLOUDFLARE_API_TOKEN: '' }, state: { loggedIn: true } });
  succeeds(f.invoke());
  assert.ok(has(f, 'whoami') && !has(f, 'login'));
  const unauthenticated = fixture(t, { env: { CLOUDFLARE_API_TOKEN: '' } });
  const result = unauthenticated.invoke();
  fails(result);
  assert.match(result.stderr, /No authenticated Wrangler session/);
  assert.ok(!has(unauthenticated, 'login') && !has(unauthenticated, 'r2 bucket'));
});

test('interactive fallback logs in and accepts a health URL after deploy', t => {
  if (!existsSync('/usr/bin/script')) return t.skip('PTY utility unavailable');
  const f = fixture(t, { env: { CLOUDFLARE_API_TOKEN: '', WORKER_URL: '', TITANS_MEMORY_URL: 'https://memory.example.invalid' }, state: {
    healthBody: JSON.stringify({ status: 'ok', checks: { bucket: true, cache: true, bus: true, memory: true } }),
  } });
  succeeds(f.interactive('https://worker.example.invalid/health\n'));
  assert.ok(has(f, 'login'));
  assert.equal(f.calls().filter(call => call.args[0] === 'whoami').length, 2);
  assert.ok(has(f, 'secret put TITANS_MEMORY_URL'));
});

test('interactive login failure and a missing health URL cannot report success', t => {
  if (!existsSync('/usr/bin/script')) return t.skip('PTY utility unavailable');
  for (const state of [{ loginIneffective: true }, { failCommand: 'login' }]) {
    const f = fixture(t, { env: { CLOUDFLARE_API_TOKEN: '', TITANS_MEMORY_URL: 'https://memory.example.invalid' }, state });
    fails(f.interactive(''));
    assert.ok(has(f, 'login') && !has(f, 'r2 bucket'));
  }
  const f = fixture(t, { env: { WORKER_URL: '', TITANS_MEMORY_URL: 'https://memory.example.invalid' } });
  const result = f.interactive('\n');
  fails(result);
  assert.match(result.stdout, /No health URL supplied; health was not checked/);
  assert.ok(has(f, 'deploy'));
  assert.ok(!f.calls().some(call => call.tool === 'curl'));
});

test('R2 substring matches do not count as the configured bucket', t => {
  const f = fixture(t, { state: { buckets: ['sahiixx-rea-artifacts-extra'] } });
  succeeds(f.invoke());
  assert.ok(has(f, 'r2 bucket create sahiixx-rea-artifacts'));
});

test('a concurrent configuration edit prevents KV patching and deployment', t => {
  const f = fixture(t, { state: { mutateConfig: true } });
  const result = f.invoke();
  fails(result);
  assert.match(result.stderr, /changed during provisioning/);
  assert.equal(f.currentConfig(), `${f.config}# external concurrent edit\n`);
  assert.ok(!has(f, 'secret put') && !has(f, 'deploy'));
});

test('unsupported resource syntax, invalid IDs, and duplicate bindings fail before install', t => {
  for (const config of [
    `r2_buckets = [{ bucket_name = "inline-bucket" }]\n${original}`,
    original.replace(`"${placeholder}"`, '123'),
    original.replace(`id = "${placeholder}"`, `"id" = "${otherId}"`),
    original.replace(placeholder, 'not-a-real-id'),
    original + `\n[[kv_namespaces]]\nbinding = "REA_CACHE"\nid = "${otherId}"\n`,
    original + '\n[[kv_namespaces]]\nbinding = "OTHER_CACHE"\nid = ""\n',
  ]) {
    const f = fixture(t, { config });
    fails(f.invoke());
    assert.deepEqual(f.calls(), []);
    assert.equal(f.currentConfig(), config);
  }
});

for (const options of [
  { noLock: true },
  { noWrangler: true },
  { state: { installFailure: true } },
  { state: { typecheckFailure: true } },
  { env: { PROXY_JWT_SECRET: '' } },
  { env: { WORKER_URL: '' } },
  { env: { WORKER_URL: 'https://worker.example.invalid/other-path' } },
]) {
  test(`preflight/install/typecheck failure stops before provisioning: ${JSON.stringify(options)}`, t => {
    const f = fixture(t, options);
    fails(f.invoke());
    assert.ok(!has(f, 'r2 bucket') && !has(f, 'secret put') && !has(f, 'deploy'));
    assert.ok(!f.calls().some(call => call.tool === 'npx' || call.args[0] === 'install'));
    assert.equal(f.currentConfig(), f.config);
  });
}

for (const failCommand of [
  'r2 bucket list', 'r2 bucket create sahiixx-rea-artifacts',
  'kv namespace list', 'kv namespace create REA_CACHE',
  'queues list --page 1', 'queues create rea-analysis-queue',
  'secret put BUS_WEBHOOK_URL', 'secret put PROXY_JWT_SECRET', 'deploy',
]) {
  test(`remote command failure is fatal: ${failCommand}`, t => {
    const f = fixture(t, { state: { failCommand } });
    fails(f.invoke());
    assert.ok(f.calls().some(call => call.tool === 'wrangler' && command(call) === failCommand), 'must reach the intended failure');
    if (failCommand !== 'deploy') assert.ok(!has(f, 'deploy'));
    assert.ok(!f.calls().some(call => call.tool === 'curl'));
  });
}

for (const state of [
  { curlFailure: true }, { httpStatus: '302' }, { httpStatus: '503' },
  { healthBody: '' }, { healthBody: '<html>not health</html>' },
  { healthBody: '{"status":"error"}' },
  { healthBody: '{"status":"ok","checks":{"bucket":true,"cache":false,"bus":true}}' },
  { healthBody: '{"status":"ok","checks":{"bucket":true,"cache":true,"bus":false}}' },
]) {
  test(`bad health never reports success: ${JSON.stringify(state)}`, t => {
    const f = fixture(t, { state });
    const result = f.invoke();
    fails(result);
    assert.ok(has(f, 'deploy'));
    assert.match(result.stdout, /health has not yet been verified/);
  });
}

test('optional memory must appear in health when requested, and no local env file is sourced', t => {
  const f = fixture(t, { env: { TITANS_MEMORY_URL: 'https://memory.example.invalid' } });
  const marker = path.join(f.repo, 'local-file-was-sourced');
  for (const file of ['.env', '.env.local', '.dev.vars']) {
    writeFileSync(path.join(f.repo, file), `touch "${marker}"\nPROXY_JWT_SECRET=wrong-local-value\n`);
  }
  fails(f.invoke());
  assert.ok(has(f, 'secret put TITANS_MEMORY_URL'));
  assert.equal(existsSync(marker), false);
  assert.equal(f.calls().find(call => call.args[2] === 'PROXY_JWT_SECRET').input, f.env.PROXY_JWT_SECRET);
});

test('malformed/ambiguous resource discovery fails without deploying or corrupting config', t => {
  for (const state of [
    { r2Output: 'unrecognized R2 output' },
    { kvOutput: 'not JSON' },
    { namespaces: [{ id: kvId, title: 'sahiixx-rea-worker-REA_CACHE' }, { id: otherId, title: 'sahiixx-rea-worker-REA_CACHE' }] },
    { queueOutput: 'unrecognized table' },
  ]) {
    const f = fixture(t, { state });
    fails(f.invoke());
    assert.ok(!has(f, 'deploy'));
    if (!state.queueOutput) assert.equal(f.currentConfig(), f.config);
  }
});
