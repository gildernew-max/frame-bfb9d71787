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

// ---------- network ----------
let SECRET = '';
const clean = s => (SECRET ? String(s).split(SECRET).join('***') : String(s)).slice(0, 300);
async function getText(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: opts.accept || '*/*' }, signal: ctl.signal });
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
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', timezone: 'auto', forecast_days: '4'
  });
  const arr = await getJSON(url);
  const out = {};
  keys.forEach((k, i) => {
    const d = arr[i]; const [icon, cond] = wmo(d.current.weather_code);
    const days = d.daily.time.map((t, j) => {
      const [ic, tx] = wmo(d.daily.weather_code[j]);
      return { date: t, d: dayLabel(t), i: ic, text: tx, h: Math.round(d.daily.temperature_2m_max[j]), l: Math.round(d.daily.temperature_2m_min[j]) };
    });
    if (!days.length || d.current.temperature_2m == null) throw new Error('Open-Meteo returned empty data');
    out[k] = {
      name: CITIES[k].name, tz: d.timezone,
      now: { temp: Math.round(d.current.temperature_2m), i: icon, cond,
        windMph: Math.round(d.current.wind_speed_10m), windDir: compass(d.current.wind_direction_10m), observed: d.current.time },
      today: { h: days[0].h, l: days[0].l, sunrise: hhmm(d.daily.sunrise[0]), sunset: hhmm(d.daily.sunset[0]) },
      forecast: days.slice(1, 4)
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
    const tempC = o.temperature?.value;
    if (tempC == null) throw new Error('NWS observation missing temperature');
    out[k] = {
      name: c.name, tz: c.tz,
      now: { temp: Math.round(tempC * 9 / 5 + 32), i: nwsIcon(o.textDescription), cond: o.textDescription || '—',
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
    return { src, hd, pub: pub ? new Date(decode(pub)).toISOString() : null };
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
    .slice(0, 5);
  return { items, feedErrors: failed };
}

// ---------- stocks (Finnhub) ----------
const STOCKS = [
  { s: 'NVDA', n: 'NVIDIA' }, { s: 'TSLA', n: 'Tesla' }, { s: 'SPCX', n: 'SpaceX' }
];
const INDEXES = [
  { key: 'DOW', index: '^DJI', fund: 'DIA', n: 'Dow Jones', label: 'DJIA' },
  { key: 'SPX', index: '^GSPC', fund: 'SPY', n: 'S&P 500', label: 'SPX' },
  { key: 'NASDAQ', index: '^IXIC', fund: 'QQQ', n: 'Nasdaq', label: 'NASDAQ' }
];
export const ANT_FIRST_TRADE = '2026-11-19';
async function finnhub(path, key) {
  const j = await getJSON(`https://finnhub.io/api/v1/${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(key)}`);
  if (j && j.error) throw new Error(`Finnhub: ${j.error}`);
  return j;
}
const validQuote = q => q && typeof q.c === 'number' && q.c > 0 && q.t > 0;

async function fetchStocks(prev, key, et, now) {
  const quotes = { ...(prev.quotes || {}) };
  const history = { ...(prev.history || {}) };
  const errors = [];
  const put = (id, base, q) => {
    quotes[id] = { ...base, px: q.c, ch: q.dp, d: q.d, pc: q.pc, t: q.t, quoteTime: new Date(q.t * 1000).toISOString() };
    const h = (history[id] || []).filter(p => p.t !== q.t);
    h.push({ t: q.t, c: q.c });
    history[id] = h.sort((a, b) => a.t - b.t).slice(-80);
  };
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
  for (const ix of INDEXES) {
    let done = false;
    try { const q = await finnhub(`quote?symbol=${encodeURIComponent(ix.index)}`, key); if (validQuote(q)) { put(ix.key, { s: ix.label, n: ix.n, kind: 'index', symbol: ix.index }, q); done = true; } }
    catch { /* index needs a paid plan on Finnhub free tier: fall back to fund */ }
    if (!done) {
      try { const q = await finnhub(`quote?symbol=${ix.fund}`, key); if (!validQuote(q)) throw new Error('empty quote'); put(ix.key, { s: ix.fund, n: `${ix.n} fund`, kind: 'fund', tracks: ix.n, symbol: ix.fund }, q); }
      catch (e) { errors.push(`${ix.fund}: ${clean(e.message)}`); }
    }
  }
  return { quotes, history, errors };
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
      try { out.weather = ok(await weatherNWS(now), { asOf: nowIso, lastAttempt: nowIso, note: `Open-Meteo failed: ${clean(e1.message)}` }); }
      catch (e2) { out.weather = { ...(prev.weather || {}), lastAttempt: nowIso, lastError: `Open-Meteo: ${clean(e1.message)}; NWS: ${clean(e2.message)}` }; }
    }
  }
  if (force || sectionDue(prev.nfl, now, et, 'daily6')) {
    ran.push('nfl');
    try { out.nfl = ok(await fetchNFL(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.nfl = { ...(prev.nfl || {}), lastAttempt: nowIso, lastError: `ESPN: ${clean(e.message)}` }; }
  }
  if (force || sectionDue(prev.news, now, et, 'hourly')) {
    ran.push('news');
    try { out.news = ok(await fetchNews(), { asOf: nowIso, lastAttempt: nowIso, credit: 'BBC News · NPR' }); }
    catch (e) { out.news = { ...(prev.news || {}), lastAttempt: nowIso, lastError: clean(e.message) }; }
  }

  // Stocks: every 15 min while the US market is open, one close fetch ~4:05 ET, else hold last close.
  const ps = prev.stocks || {};
  const stocks = { ...ps };
  if (!key) {
    stocks.status = 'key-pending';
    stocks.lastError = 'No Finnhub key configured (FINNHUB_KEY secret)';
  } else {
    let reason = null, market = ps.market || null;
    const weekday = isWeekday(et.weekday);
    const neverFetched = !ps.asOf || !ps.quotes || !Object.keys(ps.quotes).some(k => ps.quotes[k].px);
    const inSession = weekday && et.mins >= 570 && et.mins <= 960;
    const closeWindow = weekday && et.mins >= 964 && ps.closeFetchedFor !== et.dateKey;
    if (inSession || closeWindow || neverFetched || force) {
      try { const m = await finnhub('stock/market-status?exchange=US', key); market = { isOpen: !!m.isOpen, session: m.session || null, holiday: m.holiday || null, checkedAt: nowIso }; }
      catch (e) { stocks.lastError = `market-status: ${clean(e.message)}`; }
      if (market?.checkedAt === nowIso) {
        if (inSession && market.isOpen && ageMin(ps.asOf, now) >= 12) reason = 'session';
        else if (closeWindow && !market.holiday) reason = 'close';
        else if (neverFetched || force) reason = 'initial';
      } else if (neverFetched || force) reason = 'initial';
    }
    stocks.market = market;
    if (reason) {
      ran.push(`stocks:${reason}`);
      const r = await fetchStocks(ps, key, et, now);
      stocks.quotes = r.quotes; stocks.history = r.history; stocks.lastAttempt = nowIso;
      if (r.errors.length) stocks.symbolErrors = r.errors; else delete stocks.symbolErrors;
      const anyOk = r.errors.length < STOCKS.length + INDEXES.length;
      if (anyOk) { stocks.asOf = nowIso; stocks.lastError = null; stocks.status = 'live'; }
      else stocks.lastError = 'All quotes failed: ' + r.errors.join('; ');
      if (reason === 'close') stocks.closeFetchedFor = et.dateKey;
    } else if (stocks.quotes) stocks.status = 'live';
    if (!stocks.quotes) stocks.quotes = { ANT: { s: 'ANT', n: 'Anthropic', upcoming: true, note: 'IPO Nov 19 · $70–78 range' } };
  }
  out.stocks = { provider: 'Finnhub', ...stocks };
  if (ran.length) out.generatedAt = nowIso;
  out.lastRun = { at: nowIso, ran };
  return out;
}
