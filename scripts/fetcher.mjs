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

// ---------- NWS alerts for the primary dashboard location ----------
async function fetchNwsAlerts() {
  const c = CITIES.atlanta;
  const raw = await getJSON(`https://api.weather.gov/alerts/active?point=${c.lat},${c.lon}`, { accept: 'application/geo+json' });
  const items = (raw.features || []).map(f => {
    const p = f.properties || {};
    return {
      id: p.id || f.id || '',
      event: p.event || '',
      headline: p.headline || p.event || '',
      severity: p.severity || '',
      status: p.status || '',
      ends: p.ends || p.expires || null,
      onset: p.onset || p.effective || null
    };
  }).filter(x => x.status === 'Actual' && /Watch|Warning$/i.test(x.event || ''));
  return { provider: 'NWS', point: { name: c.name, lat: c.lat, lon: c.lon }, items };
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
    id: String(t.id || ''),
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
function teamIdFromRef(ref) {
  const m = String(ref || '').match(/\/teams\/(\d+)/);
  return m ? m[1] : '';
}
function parseApRanks(raw) {
  return (raw?.ranks || []).map(r => {
    const team = r.team || {};
    const id = String(team.id || teamIdFromRef(team.$ref) || '');
    const n = Number(r.current || r.rank);
    if (!id || !Number.isFinite(n) || n < 1 || n > 25) return null;
    return { rank: n, id, abbrev: team.abbreviation || '' };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank);
}
function apRanksFromGames(games) {
  const m = new Map();
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const t = g[side], n = Number(t?.rank);
      if (Number.isFinite(n) && n >= 1 && n <= 25 && !m.has(n)) m.set(n, { rank: n, id: String(t.id || ''), abbrev: t.abbrev || '' });
    }
  }
  return [...m.values()].sort((a, b) => a.rank - b.rank);
}
function selectCfbByAp(games, apRanks) {
  const ranks = (apRanks && apRanks.length) ? apRanks : apRanksFromGames(games);
  const byTeam = new Map();
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const t = g[side];
      if (t?.id) byTeam.set(String(t.id), g);
      if (t?.abbrev) byTeam.set(String(t.abbrev).toUpperCase(), g);
    }
  }
  const included = [], seen = new Set();
  let covered = 0;
  for (const t of ranks) {
    if (covered >= 20) break;
    const g = byTeam.get(String(t.id)) || byTeam.get(String(t.abbrev || '').toUpperCase());
    if (!g) continue; // bye
    if (!seen.has(g.id)) { included.push(g); seen.add(g.id); }
    covered += 1;
  }
  if (apRanks && apRanks.length) {
    const byId = new Map(apRanks.map(t => [String(t.id), t.rank]));
    const byAb = new Map(apRanks.filter(t => t.abbrev).map(t => [String(t.abbrev).toUpperCase(), t.rank]));
    const apply = t => {
      if (!t) return;
      const r = byId.get(String(t.id)) || byAb.get(String(t.abbrev || '').toUpperCase());
      t.rank = Number.isFinite(r) ? r : null;
    };
    for (const g of included) { apply(g.away); apply(g.home); }
  }
  return included;
}
async function loadApRanks() {
  const j = await getJSON('https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings');
  const avail = j.availableRankings || [];
  const ap = avail.find(r => String(r.id) === '1' || /AP Top 25/i.test(r.name || '')) || avail.find(r => /\bAP\b/i.test(r.name || ''));
  const week = ap?.week || j.requestedSeason?.week?.number || j.latestWeek?.number;
  const year = j.requestedSeason?.year || j.latestSeason?.year;
  const typ = ap?.seasonType || 2;
  if (!year || !week) throw new Error('no AP week');
  const ranks = parseApRanks(await getJSON(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${year}/types/${typ}/weeks/${week}/rankings/1?lang=en&region=us`));
  if (!ranks.length) throw new Error('empty AP ranks');
  return ranks;
}
async function fetchCFBScoreboard() {
  const raw = await getJSON('https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300');
  const parsed = parseNflScoreboard(raw);
  if (!parsed.games.length && !parsed.week) throw new Error('ESPN college scoreboard empty');
  let ap = null;
  try { ap = await loadApRanks(); } catch (e) { /* curatedRank walk still applies */ }
  parsed.games = selectCfbByAp(parsed.games, ap);
  parsed.poll = ap && ap.length ? 'AP' : (parsed.games.length ? 'ranked' : '');
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

// ---------- headlines (AI business/tech + per-ticker stock stories: free RSS/Atom feeds) ----------
// Google News items carry the real publisher in <source>; that name is shown instead.
// Both lists keep 7 days of stories (merged with the previous run so a story outlives its
// feed window), newest first, near-duplicates collapsed, with a short plain-text summary.
const GN = q => 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent(q);
const siteOr = sites => '(' + sites.map(s => 'site:' + s).join(' OR ') + ')';
const AI_Q = '(AI OR "artificial intelligence" OR OpenAI OR Anthropic OR Nvidia)';
const FEEDS = [
  { src: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { src: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { src: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
  { src: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/' },
  { src: 'CNBC', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
  { src: 'The Information', url: 'https://www.theinformation.com/feed' },
  { src: 'VentureBeat', url: 'https://venturebeat.com/category/ai/feed/' },
  { src: 'Wired', url: 'https://www.wired.com/feed/tag/ai/latest/rss' },
  { src: 'Google News', gnews: true, url: GN(`${AI_Q} ${siteOr(['reuters.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'axios.com', 'businessinsider.com', 'fortune.com'])} when:7d`) },
  { src: 'Reuters (Google News)', gnews: true, url: GN(`${AI_Q} site:reuters.com when:7d`) },
  { src: 'Bloomberg (Google News)', gnews: true, url: GN(`${AI_Q} site:bloomberg.com when:7d`) },
  { src: 'Axios (Google News)', gnews: true, url: GN(`${AI_Q} site:axios.com when:7d`) }
];
const STORY_DAYS = 7, AI_CAP = 30, AI_PER_SRC = 6, GNEWS_MAX = 12, SUM_MAX = 400;
const RSS_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml';
export const NEWS_KIND = 'ai';
// Case-sensitive acronyms are matched separately so "AI" doesn't hit "said"/"Thailand".
const AI_ACRONYM = /\b(AI|A\.I\.|AGI|LLMs?|GPUs?|xAI)\b/;
const AI_WORDS = /\b(artificial intelligence|machine learning|deep learning|generative|genai|openai|anthropic|chatgpt|gpt-?\d|claude|gemini|copilot|deepmind|mistral|perplexity|hugging ?face|grok|llama|nvidia|chatbots?|neural|large language models?|data ?cent(er|re)s?|hyperscalers?|superintelligence|agentic|ai agents?|sam altman|altman|dario amodei|jensen huang|tsmc|blackwell|coreweave|stargate|midjourney)\b/i;
export const isAI = x => AI_ACRONYM.test(`${x.hd} ${x.sum}`) || AI_WORDS.test(`${x.hd} ${x.sum}`);
const newsKey = hd => hd.toLowerCase().replace(/[^a-z0-9]/g, '');
const ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', amp: '&', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', eacute: 'é', trade: '™', reg: '®', copy: '©', bull: '•' };
const codePoint = n => { try { return String.fromCodePoint(n); } catch { return ''; } };
const decodeEntities = s => s.replace(/&#(\d+);/g, (_, n) => codePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
// Twice: feeds double-encode (&amp;rsquo;) and embed escaped HTML in descriptions.
function decode(s) {
  const t = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(decodeEntities(t)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,.;:!?’])/g, '$1').trim();
}
function trimText(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:\-–—]+$/, '') + '…';
}
function cleanSum(raw, hd) {
  const s = String(raw || '').replace(/^Key Points\s*/i, '')
    .replace(/\s*(\[(…|\.\.\.)\]|Read More\.?|Continue reading.*|The post .* appeared first on .*)$/i, '').trim();
  if (!s || newsKey(s) === newsKey(hd) || s.length < 25) return '';
  return trimText(s, SUM_MAX);
}
function itemUrl(raw, tag) {
  const links = [...raw.matchAll(/<link\b([^>]*?)\/?>/g)].map(m => m[1]).filter(a => /href="/.test(a));
  const alt = links.find(a => /rel="alternate"/.test(a)) || links.find(a => !/rel="/.test(a));
  const u = alt ? alt.match(/href="([^"]+)"/)[1] : (decode(tag('link') || '') || decode(tag('guid') || ''));
  return /^https?:\/\//.test(u) ? decodeEntities(u).trim() : '';
}
// Handles RSS <item> and Atom <entry> (The Verge, The Information).
export function parseRSS(xml, src, gnews = false) {
  return [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map(m => {
    const tag = n => (m[0].match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1];
    let hd = decode(tag('title') || ''); const pub = tag('pubDate') || tag('published') || tag('updated') || tag('dc:date');
    let itemSrc = src, sum = '';
    if (gnews) {
      const pubName = decode(tag('source') || '');
      if (pubName) { itemSrc = pubName.replace(/\.com$/i, ''); if (hd.endsWith(' - ' + pubName)) hd = hd.slice(0, -(pubName.length + 3)).trim(); }
    } else sum = cleanSum(decode(tag('description') || tag('summary') || tag('content') || ''), hd);
    const d = pub ? new Date(decode(pub)) : null;
    return { src: itemSrc, hd, sum, url: itemUrl(m[0], tag), pub: d && !isNaN(d) ? d.toISOString() : null, by: decode(tag('dc:creator') || '') };
  }).filter(x => x.hd);
}
// Promo / listicle / holdings-filing noise that free finance feeds are full of.
const JUNK_SRC = /^(the )?(motley fool|fool\.com|zacks( investment research)?|marketbeat|investorplace|insider monkey|simply wall st\.?|gurufocus|24\/7 wall st\.?|stocktwits|defense world|etf daily news|ticker report|american banking news|baystreet\.ca|stock titan|accesswire|globe ?newswire|pr ?newswire|business ?wire)$/i;
const JUNK_HD = /\b(should you buy|buy (it )?now\b|too late to buy|millionaire|billionaires? (are|is|just) (buying|selling|dumping|loading)|warren buffett|stocks? to (buy|watch|own|hold)\b|top \d+ (ai |tech |growth )?stocks|best (ai |tech |growth )?stocks?\b|\d+ (ai |tech |growth |magnificent )?stocks? (to|that|i'?d|for|you)\b|prediction:|sponsored|paid content|press release|shares (sold|bought|acquired) by|(acquires|buys|sells|trims|raises|lowers|boosts|cuts|increases|decreases) (new )?(stake|position|holdings?) in|position in .*\b(inc|corp|llc|n\.?v)\b|unusual options|options (activity|traders)|if you('d| had)? invested|stock market today|dow jones futures:|stocks making the biggest moves|(trending|hot) stocks?|\bquiz\b|insider[- ]owned|buy, hold or sell|upgrades\/downgrades|huge news for .* fans)/i;
const JUNK_HD_START = /^(etfs? (are )?(buying|bought|selling|sold)\b|\d+ [^:]*\bstocks\b|not [^.]{2,30}\. not )/i;
const isJunk = x => JUNK_SRC.test(x.src || '') || JUNK_SRC.test(x.by || '') || JUNK_HD.test(x.hd || '') || JUNK_HD_START.test(x.hd || '');
const wordSet = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
function similar(a, b, min = 0.5) {
  const A = wordSet(a), B = wordSet(b); if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= min;
}
// Newest first; near-identical titles (same wire story re-run by several outlets) collapse into
// the newest copy, which inherits a summary from a duplicate when it has none.
export function dedupeStories(list) {
  const out = [];
  for (const x of [...list].sort((a, b) => b.pub.localeCompare(a.pub))) {
    const k = newsKey(x.hd);
    const dup = out.find(o => newsKey(o.hd) === k || (wordSet(o.hd).size >= 3 && similar(o.hd, x.hd, 0.6)));
    if (dup) { if (!dup.sum && x.sum) dup.sum = x.sum; if (!dup.url && x.url) dup.url = x.url; continue; }
    out.push({ ...x });
  }
  return out;
}
const freshStory = (x, now) => x.pub && ageMin(x.pub, now) > -60 && ageMin(x.pub, now) < STORY_DAYS * 24 * 60;
const compact = x => ({ hd: x.hd, src: x.src, url: x.url || '', pub: x.pub, sum: x.sum || '' });
async function fetchNews(now = new Date(), prevItems = []) {
  const results = await Promise.allSettled(FEEDS.map(async f => parseRSS(await getText(f.url, { accept: RSS_ACCEPT }), f.src, f.gnews)));
  const failed = [], all = [], feeds = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length) { all.push(...r.value.map(x => ({ ...x, gnews: !!FEEDS[i].gnews }))); feeds.push(FEEDS[i].src.replace(/ \(Google News\)$/, '')); }
    else failed.push(`${FEEDS[i].src}: ${clean(r.reason?.message || 'no items')}`);
  });
  if (!all.length) throw new Error(failed.join('; '));
  // Max AI_PER_SRC per outlet and GNEWS_MAX from Google News so one busy feed can't fill the list.
  const perSrc = {};
  let gn = 0;
  const items = dedupeStories([...all, ...prevItems.filter(x => x && x.hd).map(x => ({ ...x, gnews: false }))]
      .filter(x => freshStory(x, now) && isAI(x) && !isJunk(x)))
    .filter(x => (perSrc[x.src] = (perSrc[x.src] || 0) + 1) <= AI_PER_SRC && (!x.gnews || ++gn <= GNEWS_MAX))
    .slice(0, AI_CAP)
    .map(compact);
  if (!items.length) throw new Error(`no AI headlines in ${all.length} items${failed.length ? '; ' + failed.join('; ') : ''}`);
  return { kind: NEWS_KIND, items, feeds: [...new Set(feeds)], feedErrors: failed };
}

// Per-ticker stories for the watchlist / spotlight overlays. `match` decides relevance: the
// headline for search feeds, headline or summary for the ticker-specific feeds.
const STOCK_CAP = 25, STOCK_PER_SRC = 8;
const QUALITY_SITES = ['reuters.com', 'bloomberg.com', 'cnbc.com', 'wsj.com', 'marketwatch.com', 'barrons.com', 'ft.com',
  'apnews.com', 'theverge.com', 'techcrunch.com', 'axios.com', 'nytimes.com', 'theinformation.com'];
export const STOCK_NEWS = [
  { key: 'NVDA', sym: 'NVDA', q: '(Nvidia OR NVDA)', sites: ['tomshardware.com', 'arstechnica.com'],
    match: /\b(nvidia|nvda|jensen huang|geforce|blackwell|rubin|cuda)\b/i },
  { key: 'TSLA', sym: 'TSLA', q: '(Tesla OR TSLA)', sites: ['electrek.co', 'arstechnica.com'],
    match: /\b(tesla|tsla|cybertruck|cybercab|robotaxi|gigafactory|model [3sxy])\b/i },
  { key: 'SPCX', sym: 'SPCX', q: '(SpaceX OR SPCX OR Starlink OR Starship)', sites: ['spacenews.com', 'space.com', 'arstechnica.com'],
    match: /\b(spacex|space x|spcx|starlink|starship|falcon (9|heavy)|dragon capsule)\b/i },
  { key: 'ANT', sym: 'ANT', q: 'Anthropic', sites: ['wired.com', 'arstechnica.com'],
    match: /\b(anthropic|claude (code|opus|sonnet|haiku|ai|models?))\b/i }
];
const FH_SRC = { yahoo: 'Yahoo Finance', seekingalpha: 'Seeking Alpha', marketwatch: 'MarketWatch', cnbc: 'CNBC', reuters: 'Reuters', bloomberg: 'Bloomberg' };
const browserRss = () => ({ accept: RSS_ACCEPT, headers: { 'User-Agent': YAHOO_UA } });
async function tickerStories(t, key, now, prevItems) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const sources = [
    ['Finnhub', key ? async () => {
      const arr = await finnhub(`company-news?symbol=${encodeURIComponent(t.sym)}&from=${day(+now - STORY_DAYS * 864e5)}&to=${day(+now)}`, key);
      return (Array.isArray(arr) ? arr : []).map(n => {
        const hd = decode(n.headline || '');
        const src = FH_SRC[String(n.source || '').toLowerCase()] || n.source || 'Finnhub';
        return { hd, src, url: n.url || '', pub: n.datetime ? new Date(n.datetime * 1000).toISOString() : null, sum: cleanSum(decode(n.summary || ''), hd), spec: true };
      });
    } : null],
    ['Yahoo', async () => parseRSS(await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${t.sym}&region=US&lang=en-US`, browserRss()), 'Yahoo Finance').map(x => ({ ...x, spec: true }))],
    ['Google News', async () => parseRSS(await getText(GN(`${t.q} ${siteOr([...QUALITY_SITES, ...t.sites])} when:${STORY_DAYS}d`), browserRss()), 'Google News', true)],
    ['Nasdaq', async () => parseRSS(await getText(`https://www.nasdaq.com/feed/rssoutbound?symbol=${t.sym}`, browserRss()), 'Nasdaq').map(x => ({ ...x, spec: true }))],
    ['Seeking Alpha', async () => parseRSS(await getText(`https://seekingalpha.com/api/sa/combined/${t.sym}.xml`, browserRss()), 'Seeking Alpha').map(x => ({ ...x, spec: true }))]
  ].filter(s => s[1]);
  const results = await Promise.allSettled(sources.map(s => s[1]()));
  const fetched = {}, errors = [], all = [];
  results.forEach((r, i) => {
    const name = sources[i][0];
    if (r.status === 'fulfilled') {
      const rel = r.value.filter(x => x.hd && freshStory(x, now) && (t.match.test(x.hd) || (x.spec && t.match.test(x.sum))));
      fetched[name] = rel.length; all.push(...rel);
    } else errors.push(`${name}: ${why(r.reason)}`);
  });
  const perSrc = {};
  const items = dedupeStories([...all, ...(prevItems || []).filter(x => x && x.hd && freshStory(x, now) && t.match.test(`${x.hd} ${x.sum || ''}`))]
      .filter(x => !isJunk(x)))
    .filter(x => (perSrc[x.src] = (perSrc[x.src] || 0) + 1) <= STOCK_PER_SRC)
    .slice(0, STOCK_CAP)
    .map(compact);
  return { items, fetched, errors, ok: errors.length < sources.length };
}
async function fetchStockNews(prev, key, now) {
  const tickers = {}, errors = [];
  let anyOk = false;
  for (const t of STOCK_NEWS) {
    const pt = prev?.tickers?.[t.key] || {};
    try {
      const r = await tickerStories(t, key, now, pt.items);
      tickers[t.key] = { items: r.items, fetched: r.fetched, ...(r.errors.length ? { errors: r.errors } : {}) };
      if (r.ok) anyOk = true;
    } catch (e) { errors.push(`${t.key}: ${why(e)}`); if (pt.items) tickers[t.key] = pt; }
  }
  if (!anyOk) throw new Error(errors.join('; ') || 'every stock-news source failed');
  return { provider: 'Finnhub · Yahoo Finance · Google News · Nasdaq · Seeking Alpha', days: STORY_DAYS, tickers, ...(errors.length ? { tickerErrors: errors } : {}) };
}

// ---------- world / geopolitics headlines (ticker) ----------
const WORLD_FEEDS = [
  { src: 'Google News', url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en' },
  { src: 'Reuters', url: 'https://news.google.com/rss/search?q=site:reuters.com/world+when:1d&hl=en-US&gl=US&ceid=US:en' },
  { src: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { src: 'NPR', url: 'https://feeds.npr.org/1004/rss.xml' }
];
const GEO_RE = /\b(war|wars|ceasefire|truce|peace|troops?|military|army|missiles?|drones?|strikes?|airstrikes?|attacks?|invasion|offensive|shelling|bomb\w*|hostages?|rebels?|militants?|coup|sanction\w*|tariffs?|embargo|diplomat\w*|summit|peace talks|trade talks|treaty|negotiat\w*|envoy|ambassador|minister|president|premier|pm|parliament|election\w*|vote|referendum|opposition|protests?|nato|un|u\.n\.|eu|g7|g20|kremlin|pentagon|nuclear|border|refugees?|humanitarian|ukraine|ukrainian|russia|russian|putin|zelensky\w*|gaza|israel\w*|hamas|hezbollah|iran\w*|houthis?|yemen|syria\w*|china|chinese|xi|taiwan|korea\w*|venezuela\w*|sudan\w*|crimea|beijing|moscow|kyiv|tehran)\b/i;
const NOT_GEO_RE = /^(commentary|opinion|analysis|breakingviews|explainer|quiz|watch|live:|in pictures)\b|\b(dies at|dies aged|age \d+|obituary|recipe|celebrity|football|soccer|tennis|golf|cricket|nba|nfl|ceo|startups?|acquisitions?|shares|stocks?|earnings|ipo|investors?|ai)\b/i;
function worldItems(xml, feed) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].map(m => {
    const tag = n => (m[0].match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1];
    let hd = decode(tag('title') || '');
    let src = feed.src;
    const gsrc = decode(tag('source') || '');
    if (feed.url.includes('news.google.com')) {
      if (gsrc) { src = gsrc.replace(/\.com$/i, ''); hd = hd.replace(new RegExp(`\\s+[-–—]\\s+${gsrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''); }
      else hd = hd.replace(/\s+[-–—]\s+[^-–—]{2,40}$/, '');
    }
    const pub = tag('pubDate');
    const t = pub ? Date.parse(decode(pub)) : NaN;
    return { src, hd: hd.trim(), pub: Number.isFinite(t) ? new Date(t).toISOString() : null };
  }).filter(x => x.hd && x.pub);
}
export function pickWorld(all, now = new Date(), count = 3) {
  const fresh = all.filter(x => now - new Date(x.pub) < 20 * 60 * MIN && new Date(x.pub) - now < 10 * MIN)
    .sort((a, b) => b.pub.localeCompare(a.pub));
  const geo = fresh.filter(x => GEO_RE.test(x.hd) && !NOT_GEO_RE.test(x.hd));
  const picked = [], srcCount = {};
  const take = (pool, maxPerSrc) => {
    for (const x of pool) {
      if (picked.length >= count) return;
      if (picked.some(p => p.hd === x.hd || similar(p.hd, x.hd))) continue;
      if ((srcCount[x.src] || 0) >= maxPerSrc) continue;
      picked.push(x); srcCount[x.src] = (srcCount[x.src] || 0) + 1;
    }
  };
  take(geo, 1); take(geo, count); take(fresh.filter(x => !NOT_GEO_RE.test(x.hd)), count);
  return picked;
}
async function fetchWorld(now) {
  const results = await Promise.allSettled(WORLD_FEEDS.map(async f => worldItems(await getText(f.url, { accept: 'application/rss+xml', headers: { 'User-Agent': YAHOO_UA } }), f)));
  const failed = [], all = [];
  results.forEach((r, i) => r.status === 'fulfilled' && r.value.length ? all.push(...r.value) : failed.push(`${WORLD_FEEDS[i].src}: ${clean(r.reason?.message || 'no items')}`));
  const items = pickWorld(all, now);
  if (!items.length) throw new Error(failed.join('; ') || 'no recent world headlines');
  return { items, feedErrors: failed };
}

// ---------- top movers (Yahoo Finance predefined screeners) ----------
const MOVER_MIN_CAP = 2e9;
async function yahooScreener(scrId) {
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const j = await getJSON(`https://${host}/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=25`, { headers: { 'User-Agent': YAHOO_UA } });
      const quotes = j?.finance?.result?.[0]?.quotes;
      if (!Array.isArray(quotes)) throw new Error(`Yahoo ${scrId}: no quotes`);
      return quotes;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
export function pickMovers(quotes, dir, n = 5) {
  return quotes.filter(q => q && q.symbol && q.quoteType === 'EQUITY' && q.marketCap >= MOVER_MIN_CAP &&
      Number.isFinite(q.regularMarketChangePercent) && (dir > 0 ? q.regularMarketChangePercent > 0 : q.regularMarketChangePercent < 0))
    .sort((a, b) => dir > 0 ? b.regularMarketChangePercent - a.regularMarketChangePercent : a.regularMarketChangePercent - b.regularMarketChangePercent)
    .slice(0, n)
    .map(q => ({ s: q.symbol, n: q.shortName || q.longName || q.symbol, ch: +q.regularMarketChangePercent.toFixed(2),
      px: Number.isFinite(q.regularMarketPrice) ? q.regularMarketPrice : null, cap: q.marketCap, t: q.regularMarketTime || null }));
}
async function fetchMovers() {
  const [g, l] = await Promise.all([yahooScreener('day_gainers'), yahooScreener('day_losers')]);
  const gainers = pickMovers(g, 1), losers = pickMovers(l, -1);
  if (!gainers.length && !losers.length) throw new Error('Yahoo screeners: no movers above $2B');
  const t = Math.max(...gainers.concat(losers).map(q => q.t || 0));
  const state = (g.concat(l).find(q => q.marketState) || {}).marketState || null;
  return { provider: 'Yahoo Finance', credit: 'Movers: Yahoo Finance', minCap: MOVER_MIN_CAP, marketState: state,
    sessionTime: t ? new Date(t * 1000).toISOString() : null, sessionDate: t ? etParts(new Date(t * 1000)).dateKey : null, gainers, losers };
}

// ---------- S&P 500 sector heat map (Yahoo chart, SPDR sector ETFs) ----------
export const SECTORS = [
  ['XLK', 'Technology'], ['XLC', 'Communication'], ['XLY', 'Cons. Discretionary'], ['XLF', 'Financials'],
  ['XLV', 'Health Care'], ['XLI', 'Industrials'], ['XLP', 'Cons. Staples'], ['XLE', 'Energy'],
  ['XLU', 'Utilities'], ['XLRE', 'Real Estate'], ['XLB', 'Materials']
];
export async function fetchSectors(prevSec = {}) {
  const items = [], symbolErrors = [];
  for (const [s, n] of SECTORS) {
    try {
      const r = await yahooChartResult(s);
      const px = r.meta.regularMarketPrice, pc = yahooPrevClose(r);
      if (!(px > 0) || !(pc > 0)) throw new Error('no price/prev close');
      items.push({ s, n, px: Math.round(px * 100) / 100, d: Math.round((px / pc - 1) * 10000) / 100, t: r.meta.regularMarketTime });
    } catch (e) {
      symbolErrors.push(`${s}: ${why(e)}`);
      const old = (prevSec.items || []).find(i => i.s === s);
      if (old) items.push(old);
    }
  }
  if (symbolErrors.length === SECTORS.length) throw new Error('All sector ETFs failed: ' + symbolErrors.join('; '));
  const t = Math.max(...items.map(i => i.t || 0));
  return { provider: 'Yahoo Finance', credit: 'Sectors: Yahoo Finance (SPDR ETFs)', items,
    sessionTime: t ? new Date(t * 1000).toISOString() : null, sessionDate: t ? etParts(new Date(t * 1000)).dateKey : null,
    ...(symbolErrors.length ? { symbolErrors } : {}) };
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
    quotes[id] = { ...base, px: q.c, ch: q.dp, d: q.d, pc: q.pc, t: q.t, vol: Number.isFinite(q.v) ? q.v : null, quoteTime: new Date(q.t * 1000).toISOString() };
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

// Spotlight price line (Yahoo chart API): daily closes for the last ~90 days; while the
// session is open Yahoo's last daily bar carries the live price.
const SPOT_SERIES = ['NVDA', 'TSLA', 'SPCX'];
const SERIES_MODE = '90d';
const SERIES_MAX_POINTS = 80;
function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * (arr.length - 1) / (max - 1))]);
  return out;
}
async function fetchSeriesItem(symbol) {
  const result = await yahooChartResult(symbol, 'interval=1d&range=3mo');
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  let pts = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null && Number.isFinite(closes[i])) pts.push([ts[i], closes[i]]);
  const px = result.meta?.regularMarketPrice, pxT = result.meta?.regularMarketTime;
  if (pts.length && px > 0 && pxT > 0) {
    const lastKey = etParts(new Date(pts[pts.length - 1][0] * 1000)).dateKey, pxKey = etParts(new Date(pxT * 1000)).dateKey;
    if (pxKey === lastKey) pts[pts.length - 1][1] = px;
    else if (pxKey > lastKey) pts.push([pxT, px]);
  }
  if (pts.length < 2) throw new Error('Yahoo: too few bars');
  pts = downsample(pts, SERIES_MAX_POINTS);
  const dp = Math.abs(pts[pts.length - 1][1]) >= 1000 ? 1 : 2;
  return {
    mode: SERIES_MODE, interval: '1d',
    session: etParts(new Date(pts[pts.length - 1][0] * 1000)).dateKey,
    t: pts.map(p => p[0]), c: pts.map(p => Number(p[1].toFixed(dp)))
  };
}
async function fetchSpotSeries(prevSeries, nowIso) {
  const items = { ...(prevSeries?.items || {}) };
  const errors = [];
  for (const s of SPOT_SERIES) {
    try { items[s] = await fetchSeriesItem(s); }
    catch (e) { errors.push(`${s}: ${why(e)}`); }
  }
  const okAny = errors.length < SPOT_SERIES.length;
  return {
    provider: 'Yahoo Finance', mode: SERIES_MODE,
    asOf: okAny ? nowIso : (prevSeries?.asOf || null), lastAttempt: nowIso, items,
    ...(errors.length ? { symbolErrors: errors } : {})
  };
}

const OVERLAY_SYMS = [
  { key: 'NVDA', yahoo: 'NVDA', fh: 'NVDA', name: 'NVIDIA' },
  { key: 'TSLA', yahoo: 'TSLA', fh: 'TSLA', name: 'Tesla' },
  { key: 'SPCX', yahoo: 'SPCX', fh: 'SPCX', name: 'SpaceX' },
  { key: 'ANT', yahoo: 'ANT', fh: 'ANT', name: 'Anthropic' },
  { key: 'DOW', yahoo: '^DJI', fh: null, name: 'Dow Jones' },
  { key: 'SPX', yahoo: '^GSPC', fh: null, name: 'S&P 500' },
  { key: 'NASDAQ', yahoo: '^IXIC', fh: null, name: 'Nasdaq Composite' }
];
const numOrNull = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
async function yahooHistory6mo(symbol) {
  const result = await yahooChartResult(symbol, 'interval=1d&range=6mo');
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const vols = result.indicators?.quote?.[0]?.volume || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null || !Number.isFinite(closes[i])) continue;
    points.push({ t: ts[i], c: closes[i], v: Number.isFinite(vols[i]) ? vols[i] : null });
  }
  const meta = result.meta || {};
  const last = points[points.length - 1];
  return {
    history6mo: points,
    volume: numOrNull(meta.regularMarketVolume) ?? last?.v ?? null,
    week52High: numOrNull(meta.fiftyTwoWeekHigh),
    week52Low: numOrNull(meta.fiftyTwoWeekLow)
  };
}

function newsMentionsCompany(headline, sp) {
  const hd = String(headline || '');
  const needles = [sp.yahoo, sp.fh, sp.key, sp.name, ...(
    { NVDA: ['NVIDIA'], TSLA: ['Tesla'], SPCX: ['SpaceX', 'Space X'], ANT: ['Anthropic'] }[sp.key] || []
  )].filter(Boolean);
  return needles.some(nd => {
    const n = String(nd);
    if (/^[A-Z0-9.^]{1,6}$/.test(n)) return new RegExp(`\\b${n.replace(/[.^]/g, '\\$&')}\\b`, 'i').test(hd);
    return hd.toLowerCase().includes(n.toLowerCase());
  });
}

async function fetchOverlayDetails(prevDetails, key, quotes) {
  const details = { ...(prevDetails || {}) };
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(+now - 21 * 864e5).toISOString().slice(0, 10);
  for (const sp of OVERLAY_SYMS) {
    const prevD = details[sp.key] || {};
    const upcoming = sp.key === 'ANT' && quotes?.ANT?.upcoming !== false;
    if (upcoming) {
      details[sp.key] = {
        upcoming: true, name: 'Anthropic', firstTrade: ANT_FIRST_TRADE,
        range: quotes?.ANT?.range || '$70–78', note: quotes?.ANT?.note || 'IPO Nov 19 · $70–78 range'
      };
      continue;
    }
    const d = { upcoming: false, name: sp.name, symbol: sp.yahoo };
    try {
      const hist = await yahooHistory6mo(sp.yahoo);
      d.history6mo = hist.history6mo;
      if (hist.volume != null) d.volume = hist.volume;
      if (hist.week52High != null) d.week52High = hist.week52High;
      if (hist.week52Low != null) d.week52Low = hist.week52Low;
    } catch (e) {
      if (prevD.history6mo?.length) d.history6mo = prevD.history6mo;
      if (prevD.volume != null) d.volume = prevD.volume;
      if (prevD.week52High != null) d.week52High = prevD.week52High;
      if (prevD.week52Low != null) d.week52Low = prevD.week52Low;
    }
    if (quotes?.[sp.key]?.vol != null) d.volume = quotes[sp.key].vol;
    if (key && sp.fh) {
      try {
        const m = await finnhub(`stock/metric?symbol=${encodeURIComponent(sp.fh)}&metric=all`, key);
        const met = m.metric || {};
        d.peTTM = numOrNull(met.peTTM);
        const hi = numOrNull(met['52WeekHigh']); const lo = numOrNull(met['52WeekLow']);
        if (hi != null) d.week52High = hi;
        if (lo != null) d.week52Low = lo;
        const avg = numOrNull(met['10DayAverageTradingVolume']);
        if (avg != null) d.avgVolume = avg;
      } catch (_) { /* keep yahoo / prior */ }
      try {
        const p = await finnhub(`stock/profile2?symbol=${encodeURIComponent(sp.fh)}`, key);
        const cap = numOrNull(p.marketCapitalization);
        if (cap != null) d.marketCap = cap; // Finnhub: millions USD
        if (p.exchange) d.exchange = p.exchange;
        if (p.name) d.name = p.name;
      } catch (_) {}
      try {
        const news = await finnhub(`company-news?symbol=${encodeURIComponent(sp.fh)}&from=${from}&to=${to}`, key);
        d.news = (Array.isArray(news) ? news : [])
          .filter(n => n && n.headline && newsMentionsCompany(n.headline, sp))
          .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
          .slice(0, 5)
          .map(n => ({ hd: String(n.headline).trim(), src: n.source || '', pub: n.datetime ? new Date(n.datetime * 1000).toISOString() : null }));
      } catch (_) { if (prevD.news) d.news = prevD.news; }
    } else if (prevD.news) d.news = prevD.news;
    details[sp.key] = d;
  }
  return details;
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
// `index` is the cash-index card the contract maps to; RTY has no card, so it settles
// against the S&P quote's session and gets no expected-open figure.
const FUTURES = [
  { sym: 'ES=F', key: 'SPX', index: 'SPX', label: 'ES', name: 'S&P 500' },
  { sym: 'NQ=F', key: 'NASDAQ', index: 'NASDAQ', label: 'NQ', name: 'Nasdaq 100' },
  { sym: 'YM=F', key: 'DOW', index: 'DOW', label: 'YM', name: 'Dow' },
  { sym: 'RTY=F', key: 'RUT', index: null, label: 'RTY', name: 'Russell 2000' }
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
  const base = { symbol: f.sym, label: f.label, name: f.name, last, lastTime, settle, settleDate, indexClose };
  const settleMoment = Date.parse(settleDate + 'T16:00:00-05:00'); // approx ET, DST not modeled (matches Stooq above)
  if (!(lastTime * 1000 > settleMoment)) return { ...base, change: null, changePct: null, expectedOpen: null, valid: false };
  const changePct = (last - settle) / settle * 100;
  return { ...base, change: last - settle, changePct, expectedOpen: indexClose > 0 ? indexClose * (1 + changePct / 100) : null, valid: true };
}
// Most recent weekday (Mon-Fri) whose 16:00 ET cash close has already happened, as a dateKey.
function lastCashCloseDateKey(et) {
  let dk = et.dateKey;
  if (isWeekday(et.weekday) && et.mins >= 960) return dk;
  do { dk = addDaysKey(dk, -1); } while (!isWeekday(weekdayOf(dk)));
  return dk;
}

// ---------- extended hours (Yahoo chart API with includePrePost, no key) ----------
// Pre-market 4:00-9:30 ET, after hours 16:00-20:00 ET. The newest bar is used only when it
// falls in one of those windows; the reference is the regular close that precedes it.
const EXT_SYMS = ['NVDA', 'TSLA', 'SPCX', 'ANT'];
export function extSession(tSec) {
  const { weekday, mins } = etParts(new Date(tSec * 1000));
  if (!isWeekday(weekday)) return null;
  if (mins >= 240 && mins < 570) return 'pre';
  if (mins >= 960 && mins < 1200) return 'post';
  return null;
}
async function fetchExtendedItem(sym) {
  const result = await yahooChartResult(sym, 'interval=5m&range=5d&includePrePost=true');
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  let i = ts.length - 1;
  while (i >= 0 && !(closes[i] > 0)) i--;
  if (i < 0) throw new Error('Yahoo: no bars');
  const time = ts[i], price = closes[i], session = extSession(time);
  const ref = result.meta?.regularMarketPrice, refTime = result.meta?.regularMarketTime;
  if (!session || !(ref > 0) || !(refTime > 0) || refTime >= time) return null;
  return { session, price, time, ref, refTime, change: price - ref, changePct: (price - ref) / ref * 100 };
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


async function fetchUsTempGrid() {
  const lat0 = 24.5, lat1 = 49.5, dlat = 1.5;
  const lon0 = -125, lon1 = -66.5, dlon = 1.5;
  const nlat = Math.round((lat1 - lat0) / dlat) + 1;
  const nlon = Math.round((lon1 - lon0) / dlon) + 1;
  const lats = [], lons = [];
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      lats.push(+(lat0 + i * dlat).toFixed(2));
      lons.push(+(lon0 + j * dlon).toFixed(2));
    }
  }
  const temps = new Array(lats.length).fill(null);
  const chunk = 80;
  for (let i = 0; i < lats.length; i += chunk) {
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: lats.slice(i, i + chunk).join(','),
      longitude: lons.slice(i, i + chunk).join(','),
      current: 'temperature_2m',
      temperature_unit: 'fahrenheit'
    });
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Open-Meteo grid ${r.status}`);
    const body = await r.json();
    const rows = Array.isArray(body) ? body : [body];
    rows.forEach((row, k) => {
      const t = row && row.current ? row.current.temperature_2m : null;
      temps[i + k] = Number.isFinite(t) ? Math.round(t * 10) / 10 : null;
    });
  }
  const got = temps.filter((t) => t != null).length;
  if (got < nlat * nlon * 0.5) throw new Error(`Open-Meteo grid too sparse (${got}/${temps.length})`);
  return { provider: 'Open-Meteo', credit: 'Temperatures: Open-Meteo', lat0, lon0, dlat, dlon, nlat, nlon, temps };
}

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
  if (force || !prev.alerts?.asOf || ageMin(prev.alerts.asOf, now) >= 12) {
    ran.push('alerts');
    try { out.alerts = ok(await fetchNwsAlerts(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.alerts = { ...(prev.alerts || {}), lastAttempt: nowIso, lastError: `NWS: ${why(e)}` }; }
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
  const prevNewsAI = prev.news?.kind === NEWS_KIND;
  const newsOldFormat = prevNewsAI && (prev.news.items || []).some(x => !('url' in x));
  if (force || !prevNewsAI || newsOldFormat || sectionDue(prev.news, now, et, 'hourly')) {
    ran.push('news');
    try {
      const n = await fetchNews(now, prevNewsAI ? prev.news.items || [] : []);
      out.news = ok(n, { asOf: nowIso, lastAttempt: nowIso, credit: n.feeds.join(' · ') });
    } catch (e) {
      // Last good AI items survive a failed fetch; older non-AI (BBC/NPR) items never do.
      out.news = prevNewsAI ? { ...prev.news, lastAttempt: nowIso, lastError: clean(e.message) }
        : { kind: NEWS_KIND, items: [], asOf: null, lastAttempt: nowIso, lastError: clean(e.message) };
    }
  }
  // Stock stories: every ~25 min from 6 a.m. to 8 p.m. ET on weekdays, hourly otherwise.
  {
    const psn = prev.stockNews || {};
    const busy = isWeekday(et.weekday) && et.mins >= 360 && et.mins < 1200;
    const due = force || !psn.asOf || (psn.lastError ? ageMin(psn.lastAttempt, now) >= 30 : ageMin(psn.asOf, now) >= (busy ? 25 : 55));
    if (due) {
      ran.push('stockNews');
      try { out.stockNews = ok(await fetchStockNews(psn, key, now), { asOf: nowIso, lastAttempt: nowIso }); }
      catch (e) { out.stockNews = { ...psn, lastAttempt: nowIso, lastError: why(e) }; }
    }
  }
  if (force || sectionDue(prev.world, now, et, 'hourly')) {
    ran.push('world');
    try { out.world = ok(await fetchWorld(now), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.world = { ...(prev.world || {}), lastAttempt: nowIso, lastError: why(e) }; }
  }
  // Movers: every ~15 min in the cash session; after the close once the new session's
  // numbers exist (retry hourly, e.g. holidays); otherwise hold the last session.
  {
    const pm = prev.movers || {};
    const inSess = isWeekday(et.weekday) && et.mins >= 575 && et.mins <= 965;
    const age = ageMin(pm.asOf, now), tried = ageMin(pm.lastAttempt, now);
    const lastClose = lastCashCloseDateKey(et);
    const behind = !pm.sessionDate || pm.sessionDate < lastClose;
    const at = pm.asOf ? etParts(new Date(pm.asOf)) : null;
    const fetchedSinceClose = at && (at.dateKey > lastClose || (at.dateKey === lastClose && at.mins >= 962));
    const due = force || !pm.asOf || (pm.lastError ? tried >= 30 :
      inSess ? age >= 12 : !fetchedSinceClose ? true : behind ? age >= 60 : age >= 12 * 60);
    if (due) {
      ran.push('movers');
      try { out.movers = ok(await fetchMovers(), { asOf: nowIso, lastAttempt: nowIso }); }
      catch (e) { out.movers = { ...pm, lastAttempt: nowIso, lastError: why(e) }; }
    }
  }
  // Sector heat map: same cadence as movers (session ~12 min, once after the close, then hold).
  {
    const ps = prev.sectors || {};
    const inSess = isWeekday(et.weekday) && et.mins >= 575 && et.mins <= 965;
    const age = ageMin(ps.asOf, now), tried = ageMin(ps.lastAttempt, now);
    const lastClose = lastCashCloseDateKey(et);
    const behind = !ps.sessionDate || ps.sessionDate < lastClose;
    const at = ps.asOf ? etParts(new Date(ps.asOf)) : null;
    const fetchedSinceClose = at && (at.dateKey > lastClose || (at.dateKey === lastClose && at.mins >= 962));
    const due = force || !ps.asOf || (ps.lastError ? tried >= 30 :
      inSess ? age >= 12 : !fetchedSinceClose ? true : behind ? age >= 60 : age >= 12 * 60);
    if (due) {
      ran.push('sectors');
      try { out.sectors = ok(await fetchSectors(ps), { asOf: nowIso, lastAttempt: nowIso }); }
      catch (e) { out.sectors = { ...ps, lastAttempt: nowIso, lastError: why(e) }; }
    }
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
  // Spotlight series: refreshed with the quotes, once after each close, and whenever it is
  // missing or in an older format; a failed symbol keeps its last-good series.
  {
    const ss = ps.series;
    const closeInstant = Date.parse(lastCashCloseDateKey(et) + 'T16:05:00-05:00');
    const missing = !ss || !ss.asOf || !SPOT_SERIES.every(s => ss.items?.[s]?.mode === SERIES_MODE && ss.items[s].c?.length >= 2);
    const seriesDue = force || reason || (missing && ageMin(ss?.lastAttempt, now) >= 12) ||
      (!missing && !inSession && new Date(ss.asOf).getTime() < closeInstant && ageMin(ss.asOf, now) >= 60);
    if (seriesDue) {
      ran.push('series');
      stocks.series = await fetchSpotSeries(ss, nowIso);
    }
  }
  if (!stocks.quotes) stocks.quotes = { ANT: { s: 'ANT', n: 'Anthropic', upcoming: true, note: 'IPO Nov 19 · $70–78 range' } };
  const hasHist = k => (stocks.details?.[k]?.history6mo || []).length >= 2 || stocks.details?.[k]?.upcoming;
  const needDetails = force || !stocks.details || !['NVDA', 'TSLA', 'SPCX', 'DOW', 'SPX', 'NASDAQ'].every(hasHist);
  if (reason || needDetails) {
    try { stocks.details = await fetchOverlayDetails(ps.details || stocks.details || {}, key, stocks.quotes); }
    catch (e) { stocks.details = ps.details || stocks.details || {}; }
  }
  out.stocks = { provider: 'Finnhub', ...stocks };

  // Extended-hours stock prices: every run (15-min cron) during pre-market and after hours,
  // plus one catch-up shortly after each window so the last bar is captured.
  const prevExt = prev.extended || {};
  const extWindow = weekday && ((et.mins >= 240 && et.mins < 575) || (et.mins >= 960 && et.mins < 1215));
  if (force || !prevExt.asOf || (extWindow && ageMin(prevExt.asOf, now) >= 12)) {
    ran.push('extended');
    const items = {}, symbolErrors = [];
    for (const sym of EXT_SYMS) {
      if (sym === 'ANT' && out.stocks.quotes?.ANT?.upcoming !== false) continue;
      try { const it = await fetchExtendedItem(sym); if (it) items[sym] = it; else if (prevExt.items?.[sym]) items[sym] = prevExt.items[sym]; }
      catch (e) { symbolErrors.push(`${sym}: ${why(e)}`); if (prevExt.items?.[sym]) items[sym] = prevExt.items[sym]; }
    }
    out.extended = { provider: 'Yahoo Finance', asOf: nowIso, lastAttempt: nowIso, items, ...(symbolErrors.length ? { symbolErrors } : {}) };
  }

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
        const quote = out.stocks.quotes?.[f.index || 'SPX'];
        const settleDate = quote?.kind === 'index' && quote.t ? etParts(new Date(quote.t * 1000)).dateKey : null;
        try {
          if (!settleDate) throw new Error(`${f.key}: no index quote`);
          items[f.key] = await fetchFuturesItem(f, settleDate, f.index ? quote.px : null);
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
  // US temperature grid for the Radar & Map field: every 30 minutes.
  if (force || !prev.usTempGrid?.asOf || ageMin(prev.usTempGrid.asOf, now) >= 30) {
    ran.push('usTempGrid');
    try { out.usTempGrid = ok(await fetchUsTempGrid(), { asOf: nowIso, lastAttempt: nowIso }); }
    catch (e) { out.usTempGrid = { ...(prev.usTempGrid || {}), lastAttempt: nowIso, lastError: `Open-Meteo: ${why(e)}` }; }
  }
  if (ran.length) out.generatedAt = nowIso;
  out.lastRun = { at: nowIso, ran };
  return out;
}
