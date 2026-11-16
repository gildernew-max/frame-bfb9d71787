#!/usr/bin/env node
// Rotating "business slot" data (mockup branch). Free, keyless sources only:
//   Nasdaq public JSON (earnings, IPOs, Nasdaq-100 movers, economic events),
//   federalreserve.gov (FOMC dates), Yahoo chart v8 (sector ETFs, crypto, futures).
// Usage: node scripts/slots.mjs [--out docs/slots.json]
// Each section keeps its previous value when a source fails; nothing is invented.
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/slots.json';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TZ = 'America/New_York';
const WATCH = ['NVDA', 'TSLA', 'SPCX', 'ANT'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, { tries = 2 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json,text/plain,*/*' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) { err = e; await sleep(800); }
  }
  throw err;
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
function addDays(key, n) { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dow = key => new Date(key + 'T12:00:00Z').getUTCDay();
const num = s => { const v = parseFloat(String(s ?? '').replace(/[$,%+]/g, '')); return Number.isFinite(v) ? v : null; };
const mdyToKey = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s || ''); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
function weekDays(from) {
  // Mon..Fri of the trading week containing `from` (Sat/Sun roll forward to next week).
  let k = from; const d = dow(k);
  if (d === 6) k = addDays(k, 2); else if (d === 0) k = addDays(k, 1); else k = addDays(k, 1 - d);
  return [0, 1, 2, 3, 4].map(i => addDays(k, i));
}
function cleanName(n) {
  let s = String(n || '').trim(), prev;
  do { prev = s; s = s.replace(/,?\s+(Inc\.?|Incorporated|Corporation|Corp\.?|Ltd\.?|Limited|Company|PBC|plc|N\.V\.|Holdings?|Common Stock|Ordinary Shares|Class [A-C]\b.*|\(The\))$/i, '').replace(/,\s*$/, '').trim(); } while (s !== prev);
  return s;
}

async function earnings() {
  const days = weekDays(todayKey());
  const rows = [];
  for (const day of days) {
    const j = await getJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${day}`);
    for (const r of j?.data?.rows || []) {
      rows.push({
        date: day, s: r.symbol, n: cleanName(r.name),
        when: r.time === 'time-pre-market' ? 'BMO' : r.time === 'time-after-hours' ? 'AMC' : 'TBD',
        eps: num(r.epsForecast), cap: num(r.marketCap), watch: WATCH.includes(r.symbol)
      });
    }
    await sleep(300);
  }
  if (!rows.length) throw new Error('no earnings rows');
  const pick = [...rows.filter(r => r.watch), ...rows.filter(r => !r.watch).sort((a, b) => (b.cap || 0) - (a.cap || 0))].slice(0, 7);
  pick.sort((a, b) => a.date.localeCompare(b.date) || (a.when === 'BMO' ? -1 : 1));
  return { provider: 'Nasdaq', week: [days[0], days[4]], items: pick.map(({ cap, ...r }) => r) };
}

async function movers() {
  const j = await getJSON('https://api.nasdaq.com/api/marketmovers?assetclass=stocks');
  const t = j?.data?.STOCKS?.Nasdaq100Movers;
  const rows = (t?.table?.rows || []).map(r => ({ s: r.symbol, n: cleanName(r.name), px: num(r.lastSalePrice), d: num(r.change) })).filter(r => r.d != null);
  // GOOG/GOOGL style share classes: keep one row per company.
  const seen = new Set();
  const uniq = rows.filter(r => { const k = r.n.split(/\s/)[0]; if (seen.has(k)) return false; seen.add(k); return true; });
  if (uniq.length < 4) throw new Error('too few movers');
  uniq.sort((a, b) => b.d - a.d);
  return { provider: 'Nasdaq', universe: 'Nasdaq-100', dataAsOf: t.dataAsOf || null, gainers: uniq.filter(r => r.d > 0).slice(0, 3), losers: uniq.filter(r => r.d < 0).slice(-3).reverse() };
}

const ECON_KEYS = [
  { re: /^Nonfarm Payrolls$/, label: 'Jobs report', tag: 'NFP' },
  { re: /^CPI \(YoY\)$|^CPI$/, label: 'Consumer prices', tag: 'CPI' },
  { re: /^Core PCE Price Index \(MoM\)$/, label: 'Core PCE', tag: 'PCE' },
  { re: /^GDP \(QoQ\)$/, label: 'GDP', tag: 'GDP' },
  { re: /^Retail Sales \(MoM\)$|^Retail Sales$/, label: 'Retail sales', tag: 'RETAIL' },
  { re: /^Fed Interest Rate Decision$/, label: 'Fed rate decision', tag: 'FOMC' }
];
async function fomcDates() {
  const html = await getText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
  const out = [];
  for (const block of html.split(/<h4>\s*<a[^>]*>\s*|<h4>/).slice(1)) {
    const y = /(\d{4}) FOMC Meetings/.exec(block)?.[1]; if (!y) continue;
    const re = /fomc-meeting__month[^>]*><strong>(\w+)[^<]*<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)/g;
    let m;
    while ((m = re.exec(block))) {
      const months = m[1].split('/'); const days = m[2].trim();
      const dm = /^(\d+)(?:-(\d+))?(\*)?/.exec(days); if (!dm || /notation/i.test(days)) continue;
      const endDay = dm[2] || dm[1];
      const mon = months[months.length - 1];
      const mi = new Date(`${mon} 1, ${y}`).getMonth(); if (Number.isNaN(mi)) continue;
      out.push({ date: `${y}-${String(mi + 1).padStart(2, '0')}-${endDay.padStart(2, '0')}`, range: `${m[1]} ${dm[1]}${dm[2] ? '–' + dm[2] : ''}`, sep: !!dm[3] });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
async function econ() {
  const start = todayKey();
  const events = [];
  // Nasdaq's ?date=D returns the previous calendar day's events, so ask for D+1.
  for (let i = 0; i < 35; i++) {
    const day = addDays(start, i); if ([0, 6].includes(dow(day))) continue;
    let j; try { j = await getJSON(`https://api.nasdaq.com/api/calendar/economicevents?date=${addDays(day, 1)}`, { tries: 1 }); } catch { continue; }
    for (const r of j?.data?.rows || []) {
      if (r.country !== 'United States') continue;
      const k = ECON_KEYS.find(k => k.re.test(r.eventName.trim())); if (!k) continue;
      if (events.some(e => e.tag === k.tag && e.date === day)) continue;
      events.push({ date: day, time: r.gmt, label: k.label, tag: k.tag, cons: (r.consensus || '').trim() || null, prev: (r.previous || '').replace('&nbsp;', '').trim() || null });
    }
    await sleep(250);
  }
  let fomc = [];
  try { fomc = (await fomcDates()).filter(f => f.date >= start).slice(0, 3); } catch (e) { console.warn('fomc:', e.message); }
  for (const f of fomc) {
    const ex = events.find(e => e.tag === 'FOMC' && e.date === f.date);
    if (ex) Object.assign(ex, { range: f.range, sep: f.sep });
    else events.push({ date: f.date, time: '14:00', label: 'Fed rate decision', tag: 'FOMC', range: f.range, sep: f.sep, cons: null, prev: null });
  }
  if (!events.length) throw new Error('no econ events');
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  return { provider: 'Nasdaq + Federal Reserve', items: events.slice(0, 7) };
}

async function ipos() {
  const k = todayKey(); const ym = k.slice(0, 7); const next = addDays(ym + '-28', 7).slice(0, 7);
  const items = []; const seen = new Set();
  for (const m of [ym, next]) {
    const j = await getJSON(`https://api.nasdaq.com/api/ipo/calendar?date=${m}`);
    for (const r of j?.data?.upcoming?.upcomingTable?.rows || []) {
      const date = mdyToKey(r.expectedPriceDate);
      if (!date || date < k || seen.has(r.dealID)) continue; seen.add(r.dealID);
      items.push({ s: r.proposedTickerSymbol, n: cleanName(r.companyName), date, range: r.proposedSharePrice || null, raise: num(r.dollarValueOfSharesOffered), ex: (r.proposedExchange || '').split(' ')[0] || null });
    }
    if (m === ym) {
      const filed = (j?.data?.filed?.rows || []).filter(r => !/acquisition|capital corp|merger|\bspac\b|\bcorp\.? [ivx]+$/i.test(r.companyName || '')).map(r => ({ s: r.proposedTickerSymbol, n: cleanName(r.companyName), date: null, filed: mdyToKey(r.filedDate), range: null, raise: num(r.dollarValueOfSharesOffered) }));
      filed.sort((a, b) => (b.raise || 0) - (a.raise || 0));
      items.filedTop = filed.slice(0, 4);
    }
    await sleep(300);
  }
  const upcoming = items.sort((a, b) => a.date.localeCompare(b.date) || (b.raise || 0) - (a.raise || 0));
  const out = [...upcoming.slice(0, 5)];
  for (const f of items.filedTop || []) if (out.length < 5) out.push(f);
  if (!out.length) throw new Error('no IPOs');
  return { provider: 'Nasdaq', items: out };
}

async function yahooChange(symbol) {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const j = await getJSON(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, { tries: 1 });
      const r = j?.chart?.result?.[0]; const m = r?.meta; if (!m) continue;
      const closes = (r.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      const px = m.regularMarketPrice ?? closes.at(-1);
      // chartPreviousClose is the close before the 5-day window; use the prior bar instead.
      const pc = closes.length >= 2 ? closes.at(-2) : m.previousClose ?? m.chartPreviousClose;
      if (!(px > 0 && pc > 0)) continue;
      return { px, d: (px / pc - 1) * 100, t: m.regularMarketTime || null };
    } catch { /* try next host */ }
  }
  throw new Error('yahoo ' + symbol);
}
const SECTORS = [
  ['XLK', 'Technology'], ['XLC', 'Communication'], ['XLY', 'Cons. Discretionary'], ['XLF', 'Financials'],
  ['XLV', 'Health Care'], ['XLI', 'Industrials'], ['XLP', 'Cons. Staples'], ['XLE', 'Energy'],
  ['XLU', 'Utilities'], ['XLRE', 'Real Estate'], ['XLB', 'Materials']
];
async function sectors() {
  const items = [];
  for (const [s, n] of SECTORS) { try { items.push({ s, n, ...(await yahooChange(s)) }); } catch (e) { console.warn(e.message); } await sleep(200); }
  if (items.length < 8) throw new Error('too few sectors');
  return { provider: 'Yahoo Finance (SPDR sector ETFs)', items };
}
const COMMODS = [
  ['BTC-USD', 'BTC', 'Bitcoin'], ['ETH-USD', 'ETH', 'Ether'], ['CL=F', 'WTI', 'WTI crude'],
  ['BZ=F', 'BRENT', 'Brent crude'], ['GC=F', 'GOLD', 'Gold']
];
async function commods() {
  const items = [];
  for (const [y, s, n] of COMMODS) { try { items.push({ s, n, y, ...(await yahooChange(y)) }); } catch (e) { console.warn(e.message); } await sleep(200); }
  if (items.length < 3) throw new Error('too few commodities');
  return { provider: 'Yahoo Finance', items };
}

let prev = {};
try { prev = JSON.parse(await readFile(outPath, 'utf8')); } catch { /* first run */ }
const out = { version: 1, generatedAt: new Date().toISOString() };
for (const [k, fn] of Object.entries({ earnings, movers, econ, sectors, ipos, commods })) {
  try { out[k] = { ...(await fn()), asOf: new Date().toISOString() }; console.log(`${k}: ok`); }
  catch (e) { out[k] = prev[k] ? { ...prev[k], lastError: e.message } : { lastError: e.message }; console.log(`${k}: FAILED ${e.message}`); }
}
await writeFile(outPath, JSON.stringify(out, null, 1) + '\n');
