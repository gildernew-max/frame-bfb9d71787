#!/usr/bin/env node
// Local preview server: serves docs/ and a locally maintained data.json, and runs the
// same fetcher (scripts/fetcher.mjs) on a 5-minute loop; the fetcher decides what is due.
// Env: PORT (default 8787), DATA_PATH (default .local/data.json), FINNHUB_KEY or FINNHUB_KEY_FILE.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFetch } from './fetcher.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(root, 'docs');
const DATA = process.env.DATA_PATH || join(root, '.local', 'data.json');
const PORT = Number(process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript' };

async function env() {
  const e = { ...process.env };
  if (!e.FINNHUB_KEY && !e.FINNHUB_API_KEY && e.FINNHUB_KEY_FILE) {
    try { e.FINNHUB_KEY = (await readFile(e.FINNHUB_KEY_FILE, 'utf8')).trim(); } catch { /* pending */ }
  }
  return e;
}
let running = false;
async function scheduled(force = false) {
  if (running) return; running = true;
  try {
    let prev = {}; try { prev = JSON.parse(await readFile(DATA, 'utf8')); } catch {}
    const next = await runFetch(prev, await env(), { force });
    await mkdir(dirname(DATA), { recursive: true });
    await writeFile(DATA, JSON.stringify(next, null, 1) + '\n');
    console.log(new Date().toISOString(), 'run:', next.lastRun.ran.join(', ') || 'nothing due');
  } catch (e) { console.error('fetch run failed', e.message); }
  finally { running = false; }
}
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    let file = url.pathname === '/data.json' ? DATA : normalize(join(DOCS, url.pathname === '/' ? 'index.html' : url.pathname));
    if (file !== DATA && !file.startsWith(DOCS)) throw new Error('bad path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
}).listen(PORT, () => console.log(`Frame dashboard preview on http://localhost:${PORT}`));

await scheduled(process.argv.includes('--force'));
setInterval(scheduled, 5 * 60 * 1000);
