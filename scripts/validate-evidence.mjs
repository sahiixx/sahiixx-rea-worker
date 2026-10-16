#!/usr/bin/env node
/** Static local validation. Input files are read, never imported or executed. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const highValueCategories = new Set(['BAYUT', 'NZP_LIVE', 'POTENTIAL_KEY', 'GENERIC_API_KEY', 'SUSPICIOUS']);
export const syntheticSample = `export const bayut_live_key = 'bayut_live_0123456789abcdef';
const api_url = 'https://api.bayut.com/v1/properties?city=dubai';
export function clusterProperties(props, bounds, zoom) {
  const gridSize = zoom > 14 ? 50 : 100;
  const points = props.filter(p => p.lat > 25.0 && p.lat < 25.4 && p.lon > 55.1 && p.lon < 55.5);
  return { gridSize, count: points.length, bounds };
}
`;

// Reports can be shared; full triage JSON stays in the ignored local artifacts.
export function safeText(value) {
  return String(value ?? '')
    .replace(/(?:bayut_live_|nzp_live_|ghp_|github_pat_|sk_live_)[a-z0-9_\-]+/gi,
      match => `${match.match(/^(?:bayut_live_|nzp_live_|ghp_|github_pat_|sk_live_)/i)[0]}[REDACTED]`)
    .replace(/((?:api[_-]?key|secret|token|password)\s*['"]?\s*[:=]\s*['"]?)[^\s'";,]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function keyHits(result) {
  return (result.strings || []).filter(s =>
    s.confidence >= 0.85 && s.categories?.some(c => highValueCategories.has(c)));
}

export function validateResult(result, bytes, synthetic = false) {
  const checks = [];
  const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const confidence = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const offset = value => Number.isSafeInteger(value) && value >= 0 && (value < bytes.length || (bytes.length === 0 && value === 0));
  check('result is an object', record(result));
  if (!record(result)) return checks;
  check('id present', typeof result.id === 'string' && result.id.length > 0);
  check('fileType present (UNKNOWN is valid for arbitrary inputs)', typeof result.fileType === 'string' && result.fileType.length > 0);
  check('file size matches input', result.fileSize === bytes.length);
  check('SHA-256 matches input', result.sha256 === crypto.createHash('sha256').update(bytes).digest('hex'));
  check('strings have byte offsets and confidence', Array.isArray(result.strings) && result.strings.every(s =>
    record(s) && typeof s.value === 'string' && offset(s.offset) && confidence(s.confidence) &&
    Array.isArray(s.categories) && s.categories.every(c => typeof c === 'string') &&
    s.encoding === 'ASCII' && bytes.subarray(s.offset, s.offset + s.value.length).toString('ascii') === s.value));
  check('evidence chain has valid byte offsets', Array.isArray(result.evidence) && result.evidence.length > 0 && result.evidence.every(e =>
    record(e) && offset(e.offset) && typeof e.type === 'string' && typeof e.value === 'string' && confidence(e.confidence)));
  check('overall confidence in range', confidence(result.confidence?.overall));
  const entropy = result.recon?.entropy;
  check('entropy is finite and in range', Number.isFinite(entropy?.overall) && entropy.overall >= 0 && entropy.overall <= 8);
  check('entropy blocks have valid offsets', Array.isArray(entropy?.blocks) && entropy.blocks.every(b =>
    record(b) && offset(b.offset) && Number.isFinite(b.entropy) && b.entropy >= 0 && b.entropy <= 8 && typeof b.suspicious === 'boolean'));
  if (synthetic && checks.every(c => c.pass)) {
    check('synthetic JavaScript detected', result.fileType === 'JS');
    check('synthetic bayut_live key found', keyHits(result).some(s => s.value.includes('bayut_live_0123456789abcdef')));
    check('synthetic cluster evidence found', result.evidence.some(e => /cluster/i.test(e.value)));
  }
  // The local runner does not generate rebuild output. Do not fabricate it or
  // require worker-only fields. Empty/unknown files may legitimately lack strings.
  return checks;
}

export function markdownReport(result, checks) {
  const cell = value => safeText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, "'").replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 160);
  const hex = n => `0x${n.toString(16).toUpperCase()}`;
  const rows = result.evidence.slice(0, 30).map(e =>
    `| \`${hex(e.offset)}\` | ${cell(e.type)} | ${e.confidence.toFixed(2)} | ${cell(e.value)} |`);
  const passed = checks.filter(c => c.pass).length;
  const lines = [
    '<!-- rea-evidence -->',
    '## REA triage — local evidence validation',
    '',
    `**File:** ${cell(result.fileName)} · **Type:** ${cell(result.fileType)} · **Bytes:** ${result.fileSize}`,
    `**SHA-256:** \`${result.sha256}\``,
    `**Entropy:** ${result.recon.entropy.overall.toFixed(3)} · **Strings:** ${result.strings.length} · **Evidence:** ${result.evidence.length}`,
    '',
    '| Byte offset | Type | Confidence | Value |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Offsets identify source records (for strings, the start of the printable run), not necessarily the exact key substring.',
    'Key-like values are redacted in this summary; full JSON can contain sensitive input. Do not publish real target artifacts.',
  ];
  const hits = keyHits(result);
  if (hits.length) {
    lines.push('', '### High-value hits (confidence >= 0.85)');
    for (const s of hits.slice(0, 10)) lines.push(`- \`${hex(s.offset)}\` [${cell(s.categories.join('+'))}] ${cell(s.value)}`);
  }
  const blocks = result.recon.entropy.blocks.filter(b => b.suspicious);
  if (blocks.length) {
    lines.push('', '### High-entropy blocks (possible packing/encryption, not proof)');
    for (const b of blocks.slice(0, 5)) lines.push(`- \`${hex(b.offset)}\`: entropy ${b.entropy.toFixed(3)}`);
  }
  lines.push('', `**Assertions:** ${passed} passed, ${checks.length - passed} failed.`, '',
    'Static local-runner triage only; no full decompilation, Worker/R2/KV/bus verification, or rebuild verification.', '');
  return lines.join('\n');
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === '--help') {
    console.log('Usage: node scripts/validate-evidence.mjs [file] [output-directory]');
    console.log('No file: validate the built-in synthetic Bayut-like sample. Files are never executed.');
    return 0;
  }
  if (args.length > 2) throw new Error('Expected an input file and optional output directory; use --help.');
  const synthetic = args.length === 0;
  const output = path.resolve(args[1] || path.join(repoRoot, 'artifacts', 'validate-smoke'));
  const target = synthetic ? path.join(output, 'synthetic-bayut.js') : path.resolve(args[0]);
  const triageScript = path.join(repoRoot, 'scripts', 'run_triage.mjs');
  if (!fs.existsSync(triageScript)) throw new Error('scripts/run_triage.mjs is missing; use a complete repository checkout.');
  if (!synthetic && !fs.statSync(target).isFile()) throw new Error('Input must be a regular file.');
  fs.mkdirSync(output, { recursive: true });
  if (synthetic) fs.writeFileSync(target, syntheticSample);
  const bytes = fs.readFileSync(target);
  const resultPath = path.join(output, 'triage_result.json');
  if (path.resolve(target) === resultPath) throw new Error('Input file cannot also be the triage output.');
  // Never accept stale output from a prior run. Arguments bypass the shell so
  // spaces, quotes, dollar signs and other filename characters remain literal.
  fs.rmSync(resultPath, { force: true });
  fs.rmSync(path.join(output, 'evidence-summary.md'), { force: true });
  const child = spawnSync(process.execPath, [triageScript, target, output], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) throw new Error('Local triage failed or timed out; no validation passed.');
  // Do not forward runner stdout: it may include raw key material from input.
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const checks = validateResult(result, bytes, synthetic);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
  const failed = checks.filter(c => !c.pass).length;
  if (failed) {
    console.error(`Validation failed: ${failed} assertion(s).`);
    return 1;
  }
  const report = markdownReport(result, checks);
  const summaryPath = path.join(output, 'evidence-summary.md');
  fs.writeFileSync(summaryPath, report);
  console.log('\n' + report);
  console.log(`JSON (may contain sensitive input): ${safeText(resultPath)}`);
  console.log(`Summary: ${safeText(summaryPath)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[validate] ${safeText(error.message)}`);
    process.exitCode = 1;
  }
}
