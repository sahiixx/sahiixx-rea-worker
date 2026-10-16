#!/usr/bin/env node
/**
 * Local triage runner — same logic as edge Worker:
 * magic, entropy per 1KB, ASCII strings, categories, evidence offsets.
 * Usage: node scripts/run_triage.mjs <file> [outDir]
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

function detectMagic(buffer) {
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return { type: 'PE', desc: 'PE executable (MZ)', confidence: 1.0 };
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46)
    return { type: 'ELF', desc: 'ELF executable', confidence: 1.0 };
  if (buffer[0] === 0x00 && buffer[1] === 0x61 && buffer[2] === 0x73 && buffer[3] === 0x6d)
    return { type: 'WASM', desc: 'WASM module', confidence: 1.0 };
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return { type: 'APK', desc: 'APK/ZIP (PK)', confidence: 0.9 };
  const text = buffer.toString('utf8', 0, Math.min(100, buffer.length));
  if (text.includes('import') || text.includes('export') || text.includes('function'))
    return { type: 'JS', desc: 'JS/TS Bundle', confidence: 0.95 };
  return { type: 'UNKNOWN', desc: 'Unknown', confidence: 0.5 };
}

function shannonEntropy(buffer) {
  const freq = new Array(256).fill(0);
  for (let i = 0; i < buffer.length; i++) freq[buffer[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / buffer.length;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

function extractStrings(buffer, minLength = 5) {
  const strings = [];
  let current = '';
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 32 && byte <= 126) {
      if (current.length === 0) start = i;
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) {
        strings.push({ value: current, offset: start, encoding: 'ASCII', length: current.length });
      }
      current = '';
    }
  }
  if (current.length >= minLength) {
    strings.push({ value: current, offset: start, encoding: 'ASCII', length: current.length });
  }
  return strings.slice(0, 500);
}

function categorizeString(str) {
  const categories = [];
  const value = str.value;
  if (/bayut/i.test(value)) categories.push('BAYUT');
  if (/dubizzle/i.test(value)) categories.push('DUBIZZLE');
  if (/propertyfinder/i.test(value)) categories.push('PROPERTYFINDER');
  if (/dubai/i.test(value) || /clusterProperties/i.test(value) || /gridSize/i.test(value))
    categories.push('DUBAI_RE');
  if (/https?:\/\//i.test(value)) categories.push('URL');
  if (/api\./i.test(value) || /\/v1\//i.test(value)) categories.push('ENDPOINT');
  if (/bayut_live_[a-z0-9]+/i.test(value) || (/^[a-zA-Z0-9_\-]{20,}$/.test(value) && /[0-9]/.test(value)))
    categories.push('POTENTIAL_KEY');
  if (/ghp_[a-zA-Z0-9]+/i.test(value)) categories.push('GH_TOKEN');
  return categories;
}

function buildEvidence(strings, magic, entropy) {
  const evidence = [];
  evidence.push({
    type: 'header',
    offset: 0,
    value: `Magic: ${magic.desc}`,
    confidence: magic.confidence,
    references: ['MAGIC'],
  });
  if (entropy > 7.2) {
    evidence.push({
      type: 'entropy',
      offset: 0,
      value: `High entropy ${entropy.toFixed(3)}`,
      confidence: 0.85,
      references: ['ENTROPY'],
    });
  }
  for (const s of strings.slice(0, 20)) {
    const cats = categorizeString(s);
    if (cats.length > 0) {
      evidence.push({
        type: 'string',
        offset: s.offset,
        value: `${cats.join(' + ')}  ${s.value.slice(0, 50)}`,
        confidence: cats.includes('BAYUT') || cats.includes('URL') ? 0.9 : 0.8,
        references: cats,
      });
    }
  }
  return evidence;
}

async function triage(filePath) {
  const buffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const magic = detectMagic(buffer);
  const blockSize = 1024;
  const blocks = [];
  for (let i = 0; i < buffer.length; i += blockSize) {
    const block = buffer.slice(i, Math.min(i + blockSize, buffer.length));
    const ent = shannonEntropy(block);
    blocks.push({ offset: i, entropy: ent, suspicious: ent > 7.2 });
  }
  const overallEntropy = shannonEntropy(buffer);
  const strings = extractStrings(buffer);
  const categorized = strings
    .map((s) => ({
      ...s,
      categories: categorizeString(s),
      confidence: categorizeString(s).length > 0 ? 0.9 : 0.5,
    }))
    .filter((s) => s.categories.length > 0 || s.value.length > 10)
    .slice(0, 100);
  const evidence = buildEvidence(categorized, magic, overallEntropy);
  const result = {
    id: `rea_${path.basename(filePath, path.extname(filePath))}_${sha256.slice(0, 8)}`,
    fileType: magic.type,
    fileName: path.basename(filePath),
    fileSize: buffer.length,
    sha256,
    recon: {
      magic: magic.desc,
      type: magic.type,
      entropy: { overall: overallEntropy, blocks: blocks.slice(0, 10) },
      headers: {},
    },
    strings: categorized,
    evidence,
    unknowns: ['Full decompilation requires Ghidra/Hopper locally'],
    confidence: {
      overall: evidence.length > 2 ? 0.88 : 0.6,
      breakdown: { magic: magic.confidence, strings: categorized.length > 0 ? 0.9 : 0.5 },
    },
    timestamp: new Date().toISOString(),
  };
  console.log(`type: ${result.fileType} | size: ${buffer.length} | entropy: ${overallEntropy.toFixed(3)}`);
  console.log(`sha256: ${sha256}`);
  console.log('\nEvidence:');
  for (const e of evidence.slice(0, 10)) {
    console.log(`  0x${e.offset.toString(16)}  ${e.references.join(' + ')}  ${e.value.slice(0, 60)}`);
  }
  return result;
}

const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: node scripts/run_triage.mjs <file> [outDir]');
  process.exit(1);
}

triage(filePath).then((result) => {
  const outDir = process.argv[3] || './artifacts';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'triage_result.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nResult file: ${outPath}`);
});
