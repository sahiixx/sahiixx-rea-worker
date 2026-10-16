#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const workerUrl = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const busUrl = process.env.BUS_URL || 'http://127.0.0.1:4010/bus';
const artifactDir = process.env.ARTIFACT_DIR || './artifacts';

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return { res, json: JSON.parse(text) };
  } catch {
    return { res, json: text };
  }
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });

  const bus = spawn(process.execPath, ['scripts/local-bus.mjs'], { stdio: 'inherit' });
  const busReady = await fetchJson('http://127.0.0.1:4010/health').catch(() => null);
  // give the local bus a moment to bind before sending the sample file
  await wait(300);

  const sample = Buffer.from(`
    const bayut_live_key = 'bayut_live_0123456789abcdef';
    export function clusterProperties(props, bounds, zoom) {
      const gridSize = zoom > 14 ? 50 : 100;
      const points = props.filter((p) => p.lat > 25.0 && p.lat < 25.4 && p.lon > 55.1 && p.lon < 55.5);
      return { gridSize, count: points.length, bounds };
    }
  `);

  const form = new FormData();
  form.append('file', new Blob([sample]), 'bayut-sample.js');

  const result = await fetchJson(`${workerUrl}/analyze`, { method: 'POST', body: form });

  console.log('worker status:', result.res.status);
  console.log('worker payload keys:', result.json && typeof result.json === 'object' ? Object.keys(result.json).slice(0, 10) : result.json);

  if (result.json && result.json.evidence) {
    console.log('evidence sample:', result.json.evidence.slice(0, 3));
  }

  const busResult = await fetchJson(busUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'rea.analysis.completed', source: 'smoke-e2e', payload: result.json }) });
  console.log('bus status:', busResult.res.status);
  console.log('bus response:', busResult.json);

  fs.writeFileSync(path.join(artifactDir, 'e2e-result.json'), JSON.stringify(result.json, null, 2));

  bus.kill('SIGTERM');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
