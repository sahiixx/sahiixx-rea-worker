#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.BUS_PORT || 4010);
const outDir = process.env.OUT_DIR || './artifacts';
const outPath = path.join(outDir, 'bus-events.jsonl');

fs.mkdirSync(outDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/bus') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      const entry = { received_at: new Date().toISOString(), body: JSON.parse(body || '{}') };
      fs.appendFileSync(outPath, `${JSON.stringify(entry)}\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: outPath }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`local bus listening on http://127.0.0.1:${PORT}`);
  console.log(`event log: ${outPath}`);
});
