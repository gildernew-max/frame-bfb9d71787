#!/usr/bin/env node
// Usage: node scripts/update.mjs [--force] [--out docs/data.json]
// Reads the previous data.json, fetches whatever is due, merges, writes it back.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runFetch } from './fetcher.mjs';

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/data.json';
let prev = {};
try { prev = JSON.parse(await readFile(outPath, 'utf8')); } catch { /* first run */ }
const env = { ...process.env };
if (!env.FINNHUB_KEY && env.FINNHUB_KEY_FILE) {
  try { env.FINNHUB_KEY = (await readFile(env.FINNHUB_KEY_FILE, 'utf8')).trim(); } catch { /* key pending */ }
}
const next = await runFetch(prev, env, { force: args.includes('--force') });
if (next.lastRun.ran.length || !prev.version) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(next, null, 1) + '\n');
} else console.log('nothing due; data.json left unchanged');
const s = k => next[k]?.lastError ? `FAILED (${next[k].lastError})` : (next[k]?.asOf ? `ok as of ${next[k].asOf}` : 'none');
console.log(`ran: ${next.lastRun.ran.join(', ') || 'nothing due'}`);
for (const k of ['weather', 'alerts', 'nfl', 'nflScoreboard', 'cfbScoreboard', 'news', 'stocks']) console.log(`${k}: ${s(k)}${next[k]?.status ? ' [' + next[k].status + ']' : ''}`);
