// Frame dashboard fetcher: pure functions, no dependencies (Node 18+ global fetch).
// Builds the next data.json from the previous one. Every section keeps its last good
// data when a source fails; nothing is ever invented.

export const TZ = 'America/New_York';
const UA = 'FrameDashboard/1.0 (personal TV dashboard; kalesi@users.noreply.github.com)';
const MIN = 60 * 1000;

// ---------- time helpers (Eastern) ----------
export function etParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  const g = t => p.find(x => x.type === t)?.value;
  return {
    dateKey: `${g('year')}-${g('month')}-${g('day')}`,
    mins: Number(g('hour')) * 60 + Number(g('minute')),
    weekday: g('weekday') // Mon..Sun
  };
}
const isWeekday = wd => !['Sat', 'Sun'].includes(wd);
const ageMin = (iso, now) => iso ? (now - new Date(iso)) / MIN : Infinity;
// Calendar-date-only helpers (time-zone independent once you have a YYYY-MM-DD key).
const weekdayOf = dateKey => new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
function addDaysKey(dateKey, delta) {
  const d = new Date(dateKey + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
// Equity index futures trade Sun 18:00 -> Fri 17:00 ET, minus the daily 17:00-18:00 break (Mon-Thu).
export function futuresTradingAt(date) {
  const { weekday, mins } = etParts(date);
  const breakStart = 17 * 60, breakEnd = 18 * 60;
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun') return mins >= breakEnd;
  if (weekday === 'Fri') return mins < breakStart;
  return mins < breakStart || mins >= breakEnd;
}

// ---------- network ----------
let SECRET = '';
const clean = s => (SECRET ? String(s).split(SECRET).join('***') : String(s)).slice(0, 300);
const why = e => clean(`${e?.message || e}${e?.cause?.code ? ' (' + e.cause.code + ')' : e?.cause?.message ? ' (' + e.cause.message + ')' : ''}`);
async function getText(url, opts = {}) {
  try { return await getTextOnce(url, opts); }
  catch (e) { // one retry for transient network errors / 5xx
    if (!/fetch failed|aborted|HTTP 5\d\d|ECONN|ETIMEDOUT/i.test(String(e.message) + String(e.cause?.code || ''))) throw e;
    await new Promise(r => setTimeout(r, 3000));
    return await getTextOnce(url, opts);
  }
}
async function getTextOnce(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: opts.accept || '*/*', ...opts.headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}
const getJSON = async (url, opts) => JSON.parse(await getText(url, { accept: 'application/json', ...opts }));

// ---------- weather ----------
const CITIES = {
  atlanta: { name: 'Atlanta, GA', lat: 33.749, lon: -84.388, tz: 'America/New_York' },
  saintPaul: { name: 'Saint Paul, MN', lat: 44.954, lon: -93.090, tz: 'America/Chicago' }
};
// WMO weather code -> [icon, text]
function wmo(code) {
  const c = Number(code);
  if (c === 0) return ['sun', 'Clear'];
  if (c === 1) return ['sun', 'Mostly clear'];
  if (c === 2) return ['partly', 'Partly cloudy'];
  if (c === 3) return ['cloud', 'Overcast'];
  if (c === 45 || c === 48) return ['cloud', 'Fog'];
  if (c >= 51 && c <= 57) return ['rain', 'Drizzle'];
  if (c >= 61 && c <= 67) return ['rain', c === 61 ? 'Light rain' : c === 65 ? 'Heavy rain' : 'Rain'];
  if (c >= 71 && c <= 77) return ['snow', c === 71 ? 'Light snow' : c === 75 ? 'Heavy snow' : 'Snow'];
  if (c >= 80 && c <= 82) return ['rain', 'Showers'];
  if (c === 85 || c === 86) return ['snow', 'Snow showers'];
  if (c >= 95) return ['rain', 'Thunderstorms'];
  return ['cloud', 'Cloudy'];
}
const compass = deg => deg == null ? '' : ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(deg / 22.5) % 16];
const dayLabel = (dateKey) => new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const hhmm = local => local ? local.slice(11, 16) : null; // "2026-11-15T07:09" -> "07:09"

export async function weatherOpenMeteo() {
  const keys = Object.keys(CITIES);
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: keys.map(k => CITIES[k].lat).join(','), longitude: keys.map(k => CITIES[k].lon).join(','),
    current: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', timezone: 'auto', forecast_days: '8'
  });
  const arr = await getJSON(url);
  const out = {};
  keys.forEach((k, i) => {
    const d = arr[i]; const [icon, cond] = wmo(d.current.weather_code);
    const popAt = (arr, j) => { const v = arr?.[j]; return Number.isFinite(v) ? Math.round(v) : null; };
    const days = d.daily.time.map((t, j) => {
      const [ic, tx] = wmo(d.daily.weather_code[j]);
      return { date: t, d: dayLabel(t), i: ic, text: tx, h: Math.round(d.daily.temperature_2m_max[j]), l: Math.round(d.daily.temperature_2m_min[j]),
        pop: popAt(d.daily.precipitation_probability_max, j) };
    });
    if (!days.length || d.current.temperature_2m == null) throw new Error('Open-Meteo returned empty data');
    const observed = d.current.time;
    const hours = [];
    for (let j = 0; j < (d.hourly?.time || []).length; j++) {
      const t = d.hourly.time[j];
      if (observed && t < observed) continue;
      const [ic, tx] = wmo(d.hourly.weather_code[j]);
      hours.push({ t, i: ic, text: tx, temp: Math.round(d.hourly.temperature_2m[j]), pop: popAt(d.hourly.precipitation_probability, j) });
      if (hours.length >= 12) break;
    }
    out[k] = {
      name: CITIES[k].name, tz: d.timezone,
      now: { temp: Math.round(d.current.temperature_2m), i: icon, cond,
        windMph: Math.round(d.current.wind_speed_10m), windDir: compass(d.current.wind_direction_10m), observed: d.current.time },
      today: { h: days[0].h, l: days[0].l, sunrise: hhmm(d.daily.sunrise[0]), sunset: hhmm(d.daily.sunset[0]) },
      forecast: days.slice(1, 4),
      days7: days.slice(0, 7),
      hourly: hours
    };
  });
  return { provider: 'Open-Meteo', credit: 'Weather: Open-Meteo', cities: out };
}

// NOAA-style sunrise/sunset (local clock "HH:MM" in tz) for the NWS fallback.
function sunTimes(lat, lon, dateKey, tz) {
  const rad = Math.PI / 180, d = new Date(dateKey + 'T12:00:00Z');
  const n = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const g = 2 * Math.PI / 365 * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
  const fmt = utcMin => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + utcMin * MIN));
  return { sunrise: fmt(720 - 4 * (lon + ha) - eq), sunset: fmt(720 - 4 * (lon - ha) - eq) };
}
function nwsIcon(text = '') {
  const t = text.toLowerCase();
  if (/snow|sleet|flurr|ice/.test(t)) return 'snow';
  if (/rain|shower|storm|drizzle/.test(t)) return 'rain';
  if (/wind|breez|blust/.test(t)) return 'wind';
  if (/partly|mostly sunny|mostly clear/.test(t)) return 'partly';
  if (/cloud|overcast|fog/.test(t)) return 'cloud';
  return 'sun';
}
export async function weatherNWS(now) {
  const out = {};
  for (const [k, c] of Object.entries(CITIES)) {
    const pt = await getJSON(`https://api.weather.gov/points/${c.lat},${c.lon}`, { accept: 'application/geo+json' });
    const fc = await getJSON(pt.properties.forecast, { accept: 'application/geo+json' });
    const st = await getJSON(pt.properties.observationStations, { accept: 'application/geo+json' });
    const obs = await getJSON(`${st.features[0].id}/observations/latest`, { accept: 'application/geo+json' });
    const o = obs.properties;
    const byDate = {};
    for (const p of fc.properties.periods) {
      const key = p.startTime.slice(0, 10);
      byDate[key] ||= {};
      if (p.isDaytime) Object.assign(byDate[key], { h: p.temperature, text: p.shortForecast });
      else byDate[key].l ??= p.temperature;
    }
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: c.tz }).format(now);
    const keys = Object.keys(byDate).sort().filter(x => x >= todayKey);
    const days = keys.filter(x => byDate[x].h != null && byDate[x].l != null)
      .map(x => ({ date: x, d: dayLabel(x), i: nwsIcon(byDate[x].text), text: byDate[x].text, h: byDate[x].h, l: byDate[x].l }));
    const today = byDate[todayKey] || {};
    const first = fc.properties.periods[0] || {};
    const desc = (o.textDescription || '').trim() || first.shortForecast || '';
    const tempC = o.temperature?.value;
    if (tempC == null) throw new Error('NWS observation missing temperature');
    out[k] = {
      name: c.name, tz: c.tz,
      now: { temp: Math.round(tempC * 9 / 5 + 32), i: nwsIcon(desc), cond: desc || '—',
        windMph: o.windSpeed?.value == null ? null : Math.round(o.windSpeed.value * 0.621371), windDir: compass(o.windDirection?.value), observed: o.timestamp },
      today: { h: today.h ?? null, l: today.l ?? null, ...sunTimes(c.lat, c.lon, todayKey, c.tz) },
      forecast: days.filter(x => x.date > todayKey).slice(0, 3)
    };
  }
  return { provider: 'National Weather Service', credit: 'Weather: NWS', cities: out };
}

// ---------- NFL (ESPN public JSON) ----------
const TEAMS = [
  { code: 'PIT', id: 23, team: 'Pittsburgh Steelers', color: '#272727', gold: '#FFB612' },
  { code: 'MIN', id: 16, team: 'Minnesota Vikings', color: '#6A3CA0', gold: '#FFC62F' },
  { code: 'GB', id: 9, team: 'Green Bay Packers', color: '#227052', gold: '#FFB612' }
];
const shortRank = s => (s || '').replace(/^(\d+\w\w) in /, '$1 ');
async function fetchNFL() {
  const standings = await getJSON('https://site.api.espn.com/apis/v2/sports/football/nfl/standings');
  const streaks = {};
  for (const conf of standings.children || [])
    for (const e of conf.standings?.entries || [])
      streaks[e.team.abbreviation] = Object.fromEntries((e.stats || []).map(s => [s.name, s.displayValue]));
  const rows = [];
  for (const t of TEAMS) {
    const [sched, info] = await Promise.all([
      getJSON(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${t.id}/schedule`),
      getJSON(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${t.id}`)
    ]);
    const st = streaks[t.code] || {};
    const record = st.overall || sched.team?.recordSummary;
    if (!record) throw new Error(`No record for ${t.code}`);
    let next = null;
    const ev = (info.team?.nextEvent || [])[0];
    if (ev) {
      const comp = ev.competitions?.[0];
      const me = comp?.competitors?.find(c => c.team?.abbreviation === t.code);
      const opp = comp?.competitors?.find(c => c.team?.abbreviation !== t.code);
      const state = comp?.status?.type?.state;
      if (opp && state !== 'post') next = { date: ev.date, homeAway: me?.homeAway || 'home', opponent: opp.team.shortDisplayName || opp.team.displayName, oppCode: opp.team.abbreviation, state };
    }
    rows.push({ ...t, record: record.replace(/-/g, '–'), rank: shortRank(sched.team?.standingSummary), streak: st.streak || '—', next,
      season: sched.season?.displayName || null });
  }
  return { provider: 'ESPN', teams: rows };
}

// ---------- NFL scoreboard (ESPN public JSON; fallback for the live overlay) ----------
function scoreboardTeam(c) {
  const t = c.team || {};
  const rec = (c.records || []).find(r => r.type === 'total' || r.name === 'overall');
  const color = t.color ? `#${String(t.color).replace(/^#/, '')}` : '';
  const logo = t.logo || t.logos?.[0]?.href || '';
  return {
    name: t.displayName || t.name || '',
    short: t.shortDisplayName || t.name || '',
    abbrev: t.abbreviation || '',
    score: c.score == null || c.score === '' ? null : String(c.score),
    logo,
    record: rec?.summary || '',
    winner: !!c.winner,
    color,
    rank: (() => { const n = Number(c.curatedRank?.current); return Number.isFinite(n) && n >= 1 && n <= 25 ? n : null; })()
  };
}
function scoreboardStatus(ev, comp, etFmt) {
  const st = comp?.status || ev.status || {};
  const type = st.type || {};
  const state = type.state || 'pre';
  if (state === 'post') {
    const d = type.shortDetail || type.description || 'Final';
    return /final/i.test(d) ? d : 'Final';
  }
  if (state === 'in') {
    const name = type.name || '';
    const detail = type.shortDetail || type.detail || '';
    if (/HALFTIME/i.test(name) || /halftime/i.test(detail)) return 'Halftime';
    if (/END_PERIOD/i.test(name)) {
      if (st.period === 2 || /half/i.test(detail)) return 'Halftime';
      return st.period > 4 ? 'End OT' : `End Q${st.period}`;
    }
    const clock = st.displayClock && st.displayClock !== '0:00' ? st.displayClock : '';
    const period = st.period || 0;
    if (period > 4) return clock ? `OT ${clock}` : (detail || 'OT');
    if (period >= 1) return clock ? `Q${period} ${clock}` : (detail || `Q${period}`);
    return detail || 'Live';
  }
  const when = new Date(comp?.date || ev.date);
  if (Number.isNaN(+when)) return type.shortDetail || 'Scheduled';
  return etFmt(when);
}
export function parseNflScoreboard(raw) {
  const etFmt = when => {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(when);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(when);
    return `${day} ${time} ET`;
  };
  const games = (raw.events || []).map(ev => {
    const comp = ev.competitions?.[0] || {};
    const st = comp.status || ev.status || {};
    const type = st.type || {};
    const away = (comp.competitors || []).find(c => c.homeAway === 'away');
    const home = (comp.competitors || []).find(c => c.homeAway === 'home');
    if (!away || !home) return null;
    return {
      id: String(ev.id || comp.id || ''),
      start: comp.date || ev.date,
      state: type.state || 'pre',
      status: scoreboardStatus(ev, comp, etFmt),
      period: st.period || 0,
      clock: st.displayClock || '',
      completed: !!type.completed,
      away: scoreboardTeam(away),
      home: scoreboardTeam(home)
    };
  }).filter(Boolean);
  const order = { in: 0, pre: 1, post: 2 };
  games.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || new Date(a.start) - new Date(b.start) || String(a.id).localeCompare(String(b.id)));
  return {
    provider: 'ESPN',
    week: raw.week?.number ?? null,
    season: raw.season?.year ?? null,
    byes: (raw.week?.teamsOnBye || []).map(t => t.abbreviation).filter(Boolean),
    games
  };
}
async function fetchNFLScoreboard() {
  const raw = await getJSON('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  const parsed = parseNflScoreboard(raw);
  if (!parsed.games.length && !parsed.week) throw new Error('ESPN scoreboard empty');
  return parsed;
}
function scoreboardDue(sec, now, et) {
  if (!sec || !sec.asOf) return true;
  if (sec.lastError && ageMin(sec.lastAttempt, now) < 50) return false;
  const games = sec.games || [];
  const liveOrSoon = games.some(g => {
    if (g.state === 'in') return true;
    if (g.state !== 'pre') return false;
    const start = new Date(g.start).getTime();
    return Number.isFinite(start) && start - now <= 30 * MIN && start + 4 * 60 * MIN >= +now;
  });
  const window = (et.weekday === 'Sun' && et.mins >= 9 * 60)
    || (['Thu', 'Mon'].includes(et.weekday) && et.mins >= 18 * 60)
    || (et.weekday === 'Sat' && et.mins >= 12 * 60);
  if (liveOrSoon || window) return ageMin(sec.asOf, now) >= 12;
  return ageMin(sec.asOf, now) >= 6 * 60;
}
async function fetchCFBScoreboard() {
  const raw = await getJSON('https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard');
  const parsed = parseNflScoreboard(raw);
  if (!parsed.games.length && !parsed.week) throw new Error('ESPN college scoreboard empty');
  const ranked = g => (g.away?.rank >= 1 && g.away.rank <= 25) || (g.home?.rank >= 1 && g.home.rank <= 25);
  if (parsed.games.length > 24) {
    const keep = parsed.games.filter(g => g.state === 'in' || ranked(g));
    if (keep.length >= 8) parsed.games = keep;
    else parsed.games = parsed.games.slice(0, 24);
  }
  return parsed;
}
function cfbScoreboardDue(sec, now, et) {
  if (!sec || !sec.asOf) return true;
  if (sec.lastError && ageMin(sec.lastAttempt, now) < 50) return false;
  const games = sec.games || [];
  const liveOrSoon = games.some(g => {
    if (g.state === 'in') return true;
    if (g.state !== 'pre') return false;
    const start = new Date(g.start).getTime();
    return Number.isFinite(start) && start - now <= 30 * MIN && start + 4 * 60 * MIN >= +now;
  });
  const window = (['Thu', 'Fri'].includes(et.weekday) && et.mins >= 18 * 60)
    || (et.weekday === 'Sat' && et.mins >= 9 * 60)
    || (et.weekday === 'Sun' && et.mins < 3 * 60);
  if (liveOrSoon || window) return ageMin(sec.asOf, now) >= 12;
  return ageMin(sec.asOf, now) >= 6 * 60;
}

// ---------- headlines (BBC News + NPR RSS) ----------
const FEEDS = [
  { src: 'BBC News', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { src: 'NPR', url: 'https://feeds.npr.org/1006/rss.xml' }
];
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function parseRSS(xml, src) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].map(m => {
    const tag = n => (m[0].match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1];
    const hd = decode(tag('title') || ''); const pub = tag('pubDate');
    const rawSum = decode(tag('description') || tag('summary') || '');
    const sum = rawSum && rawSum !== hd ? rawSum.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
    return { src, hd, sum, pub: pub ? new Date(decode(pub)).toISOString() : null };
  }).filter(x => x.hd);
}
async function fetchNews() {
  const results = await Promise.allSettled(FEEDS.map(async f => parseRSS(await getText(f.url, { accept: 'application/rss+xml' }), f.src)));
  const failed = [], all = [];
  results.forEach((r, i) => r.status === 'fulfilled' && r.value.length ? all.push(...r.value) : failed.push(`${FEEDS[i].src}: ${clean(r.reason?.message || 'no items')}`));
  if (!all.length) throw new Error(failed.join('; '));
  const seen = new Set();
  const items = all.sort((a, b) => (b.pub || '').localeCompare(a.pub || ''))
    .filter(x => { const k = x.hd.toLowerCase().replace(/[^a-z0-9]/g, ''); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 12);
  return { items, feedErrors: failed };
}

// ---------- stocks (Finnhub) + indexes (Yahoo Finance / Stooq / Finnhub fund) ----------
const STOCKS = [
  { s: 'NVDA', n: 'NVIDIA' }, { s: 'TSLA', n: 'Tesla' }, { s: 'SPCX', n: 'SpaceX' }
];
const INDEXES = [
  { key: 'DOW', index: '^DJI', stooq: '^dji', fund: 'DIA', n: 'Dow Jones', label: 'DJIA' },
  { key: 'SPX', index: '^GSPC', stooq: '^spx', fund: 'SPY', n: 'S&P 500', label: 'SPX' },
  { key: 'NASDAQ', index: '^IXIC', stooq: '^ndq', fund: 'QQQ', n: 'Nasdaq', label: 'NASDAQ' }
];
export const ANT_FIRST_TRADE = '2026-11-19';
async function finnhub(path, key) {
  const j = await getJSON(`https://finnhub.io/api/v1/${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(key)}`);
  if (j && j.error) throw new Error(`Finnhub: ${j.error}`);
  return j;
}
const validQuote = q => q && typeof q.c === 'number' && q.c > 0 && q.t > 0;

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
async function yahooChartResult(symbol, params = 'interval=1d&range=5d') {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const j = await getJSON(`https://${host}${path}`, { headers: { 'User-Agent': YAHOO_UA } });
      const result = j?.chart?.result?.[0];
      if (!result || !result.meta) throw new Error('Yahoo: no chart result');
      return result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
// Prior trading day's close: last daily bar whose ET date is before the quote's ET date
// (meta.chartPreviousClose is the close before the whole 5-day window, not yesterday's).
function yahooPrevClose(result) {
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const quoteDateKey = etParts(new Date(result.meta.regularMarketTime * 1000)).dateKey;
  let best = null;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    const dateKey = etParts(new Date(ts[i] * 1000)).dateKey;
    if (dateKey < quoteDateKey && (!best || dateKey > best.dateKey)) best = { dateKey, c };
  }
  return best?.c ?? null;
}
async function fetchYahooIndex(symbol) {
  const result = await yahooChartResult(symbol);
  const price = result.meta?.regularMarketPrice;
  const t = result.meta?.regularMarketTime;
  const pc = yahooPrevClose(result);
  if (!(price > 0) || !Number.isFinite(price) || !(pc > 0) || !Number.isFinite(pc) || !(t > 0)) throw new Error('Yahoo: invalid data');
  return { c: price, pc, d: price - pc, dp: (price - pc) / pc * 100, t };
}
async function fetchStooqIndex(symbol) {
  const csv = await getText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcp&h&e=csv`, { accept: 'text/csv' });
  const trimmed = csv.trim();
  const lines = trimmed.split(/\r?\n/);
  if (trimmed.startsWith('<') || lines.length < 2) throw new Error('Stooq: bad response');
  const row = lines[1].split(',');
  if (row.length < 8) throw new Error('Stooq: bad row');
  const close = Number(row[6]), prev = Number(row[7]);
  if (!(close > 0) || !Number.isFinite(close) || !(prev > 0) || !Number.isFinite(prev)) throw new Error('Stooq: invalid numbers');
  let t = Math.floor(Date.now() / 1000);
  const parsed = row[1] && row[2] ? Date.parse(`${row[1]}T${row[2]}-05:00`) : NaN; // approx exchange-local (ET); DST not modeled
  if (Number.isFinite(parsed)) t = Math.floor(parsed / 1000);
  return { c: close, pc: prev, d: close - prev, dp: (close - prev) / prev * 100, t };
}

async function fetchStocks(prev, key, et, now) {
  const quotes = { ...(prev.quotes || {}) };
  const history = { ...(prev.history || {}) };
  const errors = [];
  const indexSources = [];
  const put = (id, base, q) => {
    const prevKind = quotes[id]?.kind;
    quotes[id] = { ...base, px: q.c, ch: q.dp, d: q.d, pc: q.pc, t: q.t, quoteTime: new Date(q.t * 1000).toISOString() };
    let h = prevKind && prevKind !== base.kind ? [] : (history[id] || []); // fund <-> index are different scales
    h = h.filter(p => p.t !== q.t);
    h.push({ t: q.t, c: q.c });
    history[id] = h.sort((a, b) => a.t - b.t).slice(-80);
  };
  if (key) {
    for (const st of STOCKS) {
      try { const q = await finnhub(`quote?symbol=${st.s}`, key); if (!validQuote(q)) throw new Error('empty quote'); put(st.s, { s: st.s, n: st.n, kind: 'stock' }, q); }
      catch (e) { errors.push(`${st.s}: ${clean(e.message)}`); }
    }
    // ANT: stays "Upcoming" until a real quote appears on/after its first trading day.
    const antBase = { s: 'ANT', n: 'Anthropic', kind: 'stock', firstTrade: ANT_FIRST_TRADE, range: '$70–78', note: 'IPO Nov 19 · $70–78 range' };
    if (et.dateKey >= ANT_FIRST_TRADE) {
      try { const q = await finnhub('quote?symbol=ANT', key); if (validQuote(q) && q.t * 1000 >= Date.parse(ANT_FIRST_TRADE + 'T00:00:00-05:00')) put('ANT', { ...antBase, upcoming: false }, q); else if (!quotes.ANT || quotes.ANT.upcoming !== false) quotes.ANT = { ...antBase, upcoming: true }; }
      catch (e) { errors.push(`ANT: ${clean(e.message)}`); if (!quotes.ANT) quotes.ANT = { ...antBase, upcoming: true }; }
    } else quotes.ANT = { ...antBase, upcoming: true };
  } else if (!quotes.ANT) {
    quotes.ANT = { s: 'ANT', n: 'Anthropic', kind: 'stock', upcoming: true, firstTrade: ANT_FIRST_TRADE, range: '$70–78', note: 'IPO Nov 19 · $70–78 range' };
  }
  for (const ix of INDEXES) {
    const base = { s: ix.label, n: ix.n, kind: 'index', symbol: ix.index };
    try { const q = await fetchYahooIndex(ix.index); put(ix.key, { ...base, source: 'Yahoo Finance' }, q); indexSources.push('Yahoo Finance'); continue; }
    catch (e1) {
      try { const q = await fetchStooqIndex(ix.stooq); put(ix.key, { ...base, source: 'Stooq' }, q); indexSources.push('Stooq'); continue; }
      catch (e2) {
        if (key) {
          try {
            const q = await finnhub(`quote?symbol=${ix.fund}`, key);
            if (!validQuote(q)) throw new Error('empty quote');
            put(ix.key, { s: ix.fund, n: `${ix.n} fund`, kind: 'fund', tracks: ix.n, symbol: ix.fund, source: 'Finnhub' }, q);
            indexSources.push('funds (Finnhub)'); continue;
          } catch (e3) { errors.push(`${ix.key}: Yahoo: ${clean(e1.message)}; Stooq: ${clean(e2.message)}; Finnhub: ${clean(e3.message)}`); continue; }
        }
        errors.push(`${ix.key}: Yahoo: ${clean(e1.message)}; Stooq: ${clean(e2.message)}`);
      }
    }
  }
  const uniqSources = [...new Set(indexSources)];
  const indexSource = uniqSources.length > 1
    ? uniqSources.map(s => s === 'funds (Finnhub)' ? 'funds' : s).join(' + ')
    : (uniqSources[0] || null);
  return { quotes, history, errors, indexSource };
}

// ---------- rates (FRED CSV, Treasury.gov XML fallback for DGS10) ----------
const FRED_SERIES = [
  { id: 'DGS10', name: '10-Year Treasury', history: true },
  { id: 'DGS7', name: '7-Year Treasury', history: true },
  { id: 'DFF', name: 'Fed funds (effective)' },
  { id: 'MORTGAGE30US', name: '30-yr mortgage' }
];
function parseFredCSV(csv, id) {
  const lines = csv.trim().split(/\r?\n/);
  const header = (lines[0] || '').split(',');
  if (header[0] !== 'observation_date' || header[1] !== id) throw new Error(`FRED: unexpected response for ${id}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(',');
    if (!date) continue;
    const v = raw === '.' || raw === '' || raw == null ? NaN : Number(raw);
    if (Number.isFinite(v)) rows.push({ date, v });
  }
  if (!rows.length) throw new Error(`FRED: no observations for ${id}`);
  return rows;
}
async function fetchFredSeries(id) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { timeout: 40000 });
  return parseFredCSV(csv, id);
}
// Last observation on or before (latestDate - 365 days).
function yearAgoObs(rows, latestDate) {
  const d = new Date(latestDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 365);
  const targetKey = d.toISOString().slice(0, 10);
  let best = null;
  for (const r of rows) if (r.date <= targetKey && (!best || r.date > best.date)) best = r;
  return best;
}
function lastYears(rows, latestDate, years) {
  const d = new Date(latestDate + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - years);
  const key = d.toISOString().slice(0, 10);
  return rows.filter(r => r.date >= key);
}
const last5y = (rows, latestDate) => lastYears(rows, latestDate, 5);
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
// Last observation of each ISO week (rows must be date-ascending).
function downsampleWeekly(rows) {
  const byWeek = new Map();
  for (const r of rows) byWeek.set(isoWeekKey(r.date), r);
  return [...byWeek.values()].map(r => [r.date, r.v]);
}
function parseTreasuryXML(xml) {
  return [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => {
    const date = (m[0].match(/<d:NEW_DATE[^>]*>([^<]+)</) || [])[1];
    const yld = (m[0].match(/<d:BC_10YEAR[^>]*>([^<]+)</) || [])[1];
    const v = Number(yld);
    return date && Number.isFinite(v) ? { date: date.slice(0, 10), v } : null;
  }).filter(Boolean);
}
async function fetchTreasuryYieldCurve(yyyymm) {
  const xml = await getText(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}`, { accept: 'application/xml' });
  return parseTreasuryXML(xml);
}
async function fetchTreasuryDGS10(et) {
  const [y, m] = et.dateKey.split('-').map(Number);
  let rows = await fetchTreasuryYieldCurve(`${y}${String(m).padStart(2, '0')}`);
  if (rows.length < 2) {
    const prevMonth = new Date(Date.UTC(y, m - 2, 1)); // m is 1-based; m-2 -> previous month index
    const prevRows = await fetchTreasuryYieldCurve(`${prevMonth.getUTCFullYear()}${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`);
    rows = [...prevRows, ...rows];
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 1) throw new Error('Treasury: no entries');
  return rows;
}
async function fetchRates(prevRates, et) {
  const prevSeries = prevRates.series || {};
  const series = {};
  const seriesErrors = [];
  let usedTreasury = false;
  for (const s of FRED_SERIES) {
    try {
      const rows = await fetchFredSeries(s.id);
      const latest = rows[rows.length - 1];
      const prior = rows[rows.length - 2] || null;
      const entry = { id: s.id, name: s.name, latest, prior, yearAgo: yearAgoObs(rows, latest.date) };
      if (s.history) {
        entry.history5y = downsampleWeekly(lastYears(rows, latest.date, 5));
        entry.history10y = downsampleWeekly(lastYears(rows, latest.date, 10));
      }
      series[s.id] = entry;
    } catch (e1) {
      if (s.id === 'DGS10') {
        try {
          const rows = await fetchTreasuryDGS10(et);
          const latest = rows[rows.length - 1];
          const prior = rows[rows.length - 2] || null;
          const prevEntry = prevSeries.DGS10 || {};
          series.DGS10 = { id: 'DGS10', name: '10-Year Treasury', latest, prior, yearAgo: prevEntry.yearAgo || null, history5y: prevEntry.history5y || [], history10y: prevEntry.history10y || [] };
          usedTreasury = true;
          continue;
        } catch (e2) {
          seriesErrors.push(`${s.id}: FRED: ${why(e1)}; Treasury: ${why(e2)}`);
          if (prevSeries[s.id]) series[s.id] = prevSeries[s.id];
          continue;
        }
      }
      seriesErrors.push(`${s.id}: ${why(e1)}`);
      if (prevSeries[s.id]) series[s.id] = prevSeries[s.id];
    }
  }
  return { series, seriesErrors, usedTreasury };
}

// ---------- futures (Yahoo chart API, 5-minute bars) ----------
const FUTURES = [
  { sym: 'YM=F', key: 'DOW' },
  { sym: 'ES=F', key: 'SPX' },
  { sym: 'NQ=F', key: 'NASDAQ' }
];
// Close of the 5-minute bar ending at/just before 16:00 ET (starts 15:55) on dateKey;
// falls back to the latest non-null bar starting in [15:45, 16:00) if that bar is missing.
function yahooSettleBar(result, dateKey) {
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  let onTime = null, fallback = null;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    const p = etParts(new Date(ts[i] * 1000));
    if (p.dateKey !== dateKey) continue;
    if (p.mins === 955) onTime = c;
    if (p.mins >= 945 && p.mins <= 959) fallback = c;
  }
  return onTime ?? fallback ?? null;
}
async function fetchFuturesItem(f, settleDate, indexClose) {
  const result = await yahooChartResult(f.sym, 'interval=5m&range=5d');
  const last = result.meta?.regularMarketPrice;
  const lastTime = result.meta?.regularMarketTime;
  if (!(last > 0) || !Number.isFinite(last) || !(lastTime > 0)) throw new Error('Yahoo: invalid futures quote');
  const settle = yahooSettleBar(result, settleDate);
  if (!(settle > 0) || !Number.isFinite(settle)) throw new Error(`Yahoo: no settle bar for ${settleDate}`);
  const base = { symbol: f.sym, last, lastTime, settle, settleDate, indexClose };
  const settleMoment = Date.parse(settleDate + 'T16:00:00-05:00'); // approx ET, DST not modeled (matches Stooq above)
  if (!(lastTime * 1000 > settleMoment)) return { ...base, changePct: null, expectedOpen: null, valid: false };
  const changePct = (last - settle) / settle * 100;
  return { ...base, changePct, expectedOpen: indexClose * (1 + changePct / 100), valid: true };
}
// Most recent weekday (Mon-Fri) whose 16:00 ET cash close has already happened, as a dateKey.
function lastCashCloseDateKey(et) {
  let dk = et.dateKey;
  if (isWeekday(et.weekday) && et.mins >= 960) return dk;
  do { dk = addDaysKey(dk, -1); } while (!isWeekday(weekdayOf(dk)));
  return dk;
}

// ---------- orchestration ----------
function sectionDue(sec, now, et, rule) {
  if (!sec || !sec.asOf) return true;
  const failedRecently = sec.lastError && ageMin(sec.lastAttempt, now) < 50;
  if (failedRecently) return false;
  if (rule === 'daily6') return et.mins >= 360 && etParts(new Date(sec.asOf)).dateKey !== et.dateKey || ageMin(sec.asOf, now) > 26 * 60;
  if (rule === 'hourly') return ageMin(sec.asOf, now) >= 50;
  return false;
}
const ok = (data, extra) => ({ ...data, ...extra, lastError: null });

export async function runFetch(prevData = {}, env = {}, opts = {}) {
  const now = opts.now || new Date();
  const force = opts.force || false;
  const et = etParts(now);
  const prev = prevData || {};
  const nowIso = now.toISOString();
  const out = { version: 1, generatedAt: prev.generatedAt || null, timezone: TZ, ...prev };
  const ran = [];
  const key = (env.FINNHUB_KEY || env.FINNHUB_API_KEY || '').trim();
  SECRET = key;

  // Weather: daily at 6 a.m. ET, retry hourly on failure; Open-Meteo then NWS.
  if (force || sectionDue(prev.weather, now, et, 'daily6')) {
    ran.push('weather');
    try { out.weather = ok(await weatherOpenMeteo(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e1) {
      try { out.weather = ok(await weatherNWS(now), { asOf: nowIso, lastAttempt: nowIso, note: `Open-Meteo failed: ${why(e1)}` }); }
      catch (e2) { out.weather = { ...(prev.weather || {}), lastAttempt: nowIso, lastError: `Open-Meteo: ${why(e1)}; NWS: ${why(e2)}` }; }
    }
  }
  if (force || sectionDue(prev.nfl, now, et, 'daily6')) {
    ran.push('nfl');
    try { out.nfl = ok(await fetchNFL(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.nfl = { ...(prev.nfl || {}), lastAttempt: nowIso, lastError: `ESPN: ${clean(e.message)}` }; }
  }
  if (force || scoreboardDue(prev.nflScoreboard, now, et)) {
    ran.push('nflScoreboard');
    try { out.nflScoreboard = ok(await fetchNFLScoreboard(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.nflScoreboard = { ...(prev.nflScoreboard || {}), lastAttempt: nowIso, lastError: `ESPN: ${clean(e.message)}` }; }
  }
  if (force || cfbScoreboardDue(prev.cfbScoreboard, now, et)) {
    ran.push('cfbScoreboard');
    try { out.cfbScoreboard = ok(await fetchCFBScoreboard(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.cfbScoreboard = { ...(prev.cfbScoreboard || {}), lastAttempt: nowIso, lastError: `ESPN: ${clean(e.message)}` }; }
  }
  if (force || sectionDue(prev.news, now, et, 'hourly')) {
    ran.push('news');
    try { out.news = ok(await fetchNews(), { asOf: nowIso, lastAttempt: nowIso, credit: 'BBC News · NPR' }); }
    catch (e) { out.news = { ...(prev.news || {}), lastAttempt: nowIso, lastError: clean(e.message) }; }
  }
  if (force || sectionDue(prev.rates, now, et, 'daily6')) {
    ran.push('rates');
    const r = await fetchRates(prev.rates || {}, et);
    if (r.seriesErrors.length < FRED_SERIES.length) {
      out.rates = ok({ provider: r.usedTreasury ? 'FRED + U.S. Treasury' : 'FRED', credit: 'Rates: FRED', series: r.series,
        ...(r.seriesErrors.length ? { seriesErrors: r.seriesErrors } : {}) }, { asOf: nowIso, lastAttempt: nowIso });
    } else out.rates = { ...(prev.rates || {}), lastAttempt: nowIso, lastError: r.seriesErrors.join('; ') };
  }

  // Stocks: every 15 min while the US market is open, one close fetch ~4:05 ET, else hold last close.
  // Indexes (Yahoo/Stooq) run on the same cadence regardless of whether a Finnhub key is present.
  const ps = prev.stocks || {};
  const stocks = { ...ps };
  const weekday = isWeekday(et.weekday);
  const neverFetchedStocks = !ps.asOf || !ps.quotes || !Object.keys(ps.quotes).some(k => ps.quotes[k].px);
  const neverFetchedIndexes = !ps.quotes || !INDEXES.some(ix => ps.quotes[ix.key]?.px);
  const inSession = weekday && et.mins >= 570 && et.mins <= 960;
  const closeWindow = weekday && et.mins >= 964 && ps.closeFetchedFor !== et.dateKey;
  let reason = null, market = ps.market || null;
  if (!key) {
    stocks.status = 'key-pending';
    stocks.lastError = 'No Finnhub key configured (FINNHUB_KEY secret)';
    if (inSession && ageMin(ps.asOf, now) >= 12) reason = 'session';
    else if (closeWindow) reason = 'close';
    else if (neverFetchedIndexes || force) reason = 'initial';
  } else {
    if (inSession || closeWindow || neverFetchedStocks || force) {
      try { const m = await finnhub('stock/market-status?exchange=US', key); market = { isOpen: !!m.isOpen, session: m.session || null, holiday: m.holiday || null, checkedAt: nowIso }; }
      catch (e) { stocks.lastError = `market-status: ${clean(e.message)}`; }
      if (market?.checkedAt === nowIso) {
        if (inSession && market.isOpen && ageMin(ps.asOf, now) >= 12) reason = 'session';
        else if (closeWindow && !market.holiday) reason = 'close';
        else if (neverFetchedStocks || force) reason = 'initial';
      } else if (neverFetchedStocks || force) reason = 'initial';
    }
    stocks.market = market;
  }
  if (reason) {
    ran.push(`stocks:${reason}`);
    const r = await fetchStocks(ps, key, et, now);
    stocks.quotes = r.quotes; stocks.history = r.history; stocks.lastAttempt = nowIso;
    if (r.errors.length) stocks.symbolErrors = r.errors; else delete stocks.symbolErrors;
    if (r.indexSource) stocks.indexSource = r.indexSource;
    const attempted = (key ? STOCKS.length : 0) + INDEXES.length;
    const anyOk = r.errors.length < attempted;
    if (anyOk) { stocks.asOf = nowIso; stocks.lastError = null; if (key) stocks.status = 'live'; }
    else stocks.lastError = (key ? 'All quotes failed: ' : 'All index quotes failed: ') + r.errors.join('; ');
    if (reason === 'close') stocks.closeFetchedFor = et.dateKey;
  } else if (key && stocks.quotes) stocks.status = 'live';
  if (!stocks.quotes) stocks.quotes = { ANT: { s: 'ANT', n: 'Anthropic', upcoming: true, note: 'IPO Nov 19 · $70–78 range' } };
  out.stocks = { provider: 'Finnhub', ...stocks };

  // Futures ("expected open" note): only while the cash market is closed; never during the session.
  const prevFut = prev.futures || {};
  if (!inSession) {
    const futTrading = futuresTradingAt(now);
    const closeInstant = Date.parse(lastCashCloseDateKey(et) + 'T16:00:00-05:00');
    const due = force || !prevFut.asOf || (futTrading && ageMin(prevFut.asOf, now) >= 12) ||
      new Date(prevFut.asOf).getTime() < closeInstant;
    if (due) {
      ran.push('futures');
      const items = {};
      const symbolErrors = [];
      for (const f of FUTURES) {
        const quote = out.stocks.quotes?.[f.key];
        const settleDate = quote?.kind === 'index' && quote.t ? etParts(new Date(quote.t * 1000)).dateKey : null;
        try {
          if (!settleDate) throw new Error(`${f.key}: no index quote`);
          items[f.key] = await fetchFuturesItem(f, settleDate, quote.px);
        } catch (e) {
          symbolErrors.push(`${f.key}: ${why(e)}`);
          const prevItem = prevFut.items?.[f.key];
          if (prevItem && settleDate && prevItem.settleDate === settleDate) items[f.key] = prevItem;
        }
      }
      out.futures = { provider: 'Yahoo Finance', asOf: nowIso, lastAttempt: nowIso, items, tradingNow: futTrading,
        ...(symbolErrors.length ? { symbolErrors } : {}) };
    }
  }
  if (ran.length) out.generatedAt = nowIso;
  out.lastRun = { at: nowIso, ran };
  return out;
}
