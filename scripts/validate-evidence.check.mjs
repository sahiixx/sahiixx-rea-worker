import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { markdownReport, safeText, syntheticSample, validateResult } from './validate-evidence.mjs';

const script = fileURLToPath(new URL('./validate-evidence.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea validation '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
}
function resultFor(bytes) {
  return {
    id: 'test', fileName: 'test.bin', fileType: 'UNKNOWN', fileSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    strings: [], evidence: [{ type: 'header', offset: 0, value: 'Unknown', confidence: 0.5 }],
    recon: { entropy: { overall: 0, blocks: [] } }, confidence: { overall: 0.5 },
  };
}

test('synthetic CLI validates real local-runner output without a fabricated rebuild', t => {
  const root = fixture(t);
  const input = path.join(root, 'synthetic.js');
  fs.writeFileSync(input, syntheticSample);
  const child = run([input, path.join(root, 'output')], root);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'output', 'triage_result.json')));
  assert.equal(result.fileType, 'JS');
  assert.equal(result.rebuild, undefined);
  const checks = validateResult(result, Buffer.from(syntheticSample), true);
  assert.equal(checks.length, 13);
  assert.ok(checks.every(c => c.pass), JSON.stringify(checks));
  const report = fs.readFileSync(path.join(root, 'output', 'evidence-summary.md'), 'utf8');
  assert.match(report, /\| Byte offset \|/);
  assert.match(report, /bayut_live_\[REDACTED\]/);
  assert.doesNotMatch(report + child.stdout, /0123456789abcdef/);
  assert.match(report, /no full decompilation/);
});

test('relative paths resolve from caller cwd; shell metacharacters remain literal', t => {
  const root = fixture(t);
  const name = 'bundle $(whoami) "quoted".js';
  fs.writeFileSync(path.join(root, name), syntheticSample + '\nthrow new Error("never execute target");');
  const child = run([name, 'output with spaces'], root);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.existsSync(path.join(root, 'output with spaces', 'evidence-summary.md')));
});

for (const [name, bytes] of [['empty', Buffer.alloc(0)], ['unknown', Buffer.from([1, 2, 3, 4])]]) {
  test(`${name} file can be validated without requiring strings or known magic`, t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'input.bin'), bytes);
    const child = run(['input.bin', 'out'], root);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /UNKNOWN/);
  });
}

test('missing input fails without reporting success', t => {
  const root = fixture(t);
  const child = run(['missing.apk', 'out'], root);
  assert.equal(child.status, 1);
  assert.doesNotMatch(child.stdout, /Assertions|PASS/);
});

test('input cannot be overwritten by the fixed output filename', t => {
  const root = fixture(t);
  const input = path.join(root, 'triage_result.json');
  fs.writeFileSync(input, syntheticSample);
  const child = run([input, root], root);
  assert.equal(child.status, 1);
  assert.equal(fs.readFileSync(input, 'utf8'), syntheticSample);
});

test('schema rejects wrong digest, offsets, confidence, arrays and entropy', async t => {
  const bytes = Buffer.from('hello');
  const cases = [
    ['wrong digest', r => { r.sha256 = '0'.repeat(64); }],
    ['wrong size', r => { r.fileSize = 99; }],
    ['offset out of bounds', r => { r.evidence[0].offset = bytes.length; }],
    ['negative offset', r => { r.evidence[0].offset = -1; }],
    ['fractional offset', r => { r.evidence[0].offset = 0.2; }],
    ['missing strings array', r => { r.strings = null; }],
    ['missing evidence array', r => { r.evidence = {}; }],
    ['confidence out of range', r => { r.confidence.overall = 1.1; }],
    ['invalid entropy', r => { r.recon.entropy.overall = NaN; }],
    ['invalid entropy blocks', r => { r.recon.entropy.blocks = null; }],
    ['string bytes do not match', r => { r.strings = [{ value: 'wrong', offset: 0, encoding: 'ASCII', categories: [], confidence: 0.5 }]; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const result = resultFor(bytes);
      mutate(result);
      assert.ok(validateResult(result, bytes).some(c => !c.pass));
    });
  }
  assert.ok(validateResult(null, bytes).some(c => !c.pass));
});

test('reports escape Markdown and terminal controls and redact common key forms', () => {
  const bytes = Buffer.from('hello');
  const result = resultFor(bytes);
  result.evidence[0].value = 'x | `unsafe` <script>\x1b ghp_FAKE_TEST_TOKEN api_key="fake-value"';
  result.recon.entropy.blocks = [{ offset: 0, entropy: 7.8, suspicious: true }];
  const report = markdownReport(result, validateResult(result, bytes));
  assert.match(report, /\\\|/);
  assert.match(report, /&lt;script&gt;/);
  assert.match(report, /High-entropy blocks/);
  assert.doesNotMatch(report, /FAKE_TEST_TOKEN|fake-value|\x1b/);
  assert.equal(safeText('bayut_live_abcdef'), 'bayut_live_[REDACTED]');
});
