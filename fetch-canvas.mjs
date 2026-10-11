#!/usr/bin/env node
// Pulls your Canvas data, encrypts it with your passphrase, and writes the
// ciphertext to site/data.enc.json. Only encrypted data ever leaves this script.
//
// Required environment variables (set as GitHub Actions secrets):
//   CANVAS_BASE_URL   e.g. https://yourschool.instructure.com
//   CANVAS_TOKEN      personal access token from Canvas > Account > Settings
//   DASH_PASSPHRASE   the passphrase you type on the site's lock screen
// Optional:
//   WINDOW_DAYS       how far ahead to look (default 14)
//   INCLUDE_GRADES    "true" to include each course's current score
//
// Run with --sample to write made-up data instead (no Canvas token needed).
//
// NOTE: Actions logs are public on a public repo, so this script only ever
// logs counts, never course or assignment names.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT = process.env.OUT_FILE || 'site/data.enc.json';
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const INCLUDE_GRADES = process.env.INCLUDE_GRADES === 'true';
const PBKDF2_ITERATIONS = 600_000;
const SAMPLE = process.argv.includes('--sample');

const PASSPHRASE = (process.env.DASH_PASSPHRASE || '').normalize('NFKC').trim();
const TOKEN = (process.env.CANVAS_TOKEN || '').trim();
let BASE = (process.env.CANVAS_BASE_URL || '').trim().replace(/\/+$/, '');
if (BASE && !/^https?:\/\//.test(BASE)) BASE = 'https://' + BASE;

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

if (!PASSPHRASE) fail('DASH_PASSPHRASE is not set.');
if (PASSPHRASE.length < 12) fail('DASH_PASSPHRASE is too short. Use at least 12 characters (4-5 random words is ideal).');
if (!SAMPLE && (!BASE || !TOKEN)) fail('CANVAS_BASE_URL and CANVAS_TOKEN must both be set.');

// ---------- Canvas API ----------

async function getAll(path, params = []) {
  const url = new URL(BASE + '/api/v1' + path);
  for (const [k, v] of params) url.searchParams.append(k, v);
  url.searchParams.set('per_page', '100');
  const origin = url.origin;
  const out = [];
  let next = url.toString();
  let pages = 0;
  while (next && pages++ < 50) {
    if (new URL(next).origin !== origin) break; // never send the token to another host
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Canvas returned ${res.status} for ${path.replace(/\d+/g, ':id')}`);
    const body = await res.json();
    if (Array.isArray(body)) out.push(...body);
    else out.push(body);
    const link = res.headers.get('link') || '';
    const m = link.split(',').map((s) => s.match(/<([^>]+)>;\s*rel="next"/)).find(Boolean);
    next = m ? m[1] : null;
  }
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function htmlToText(html, max = 280) {
  const text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

// "2026FA PSY260-J Introduction to Psychology - Fleet, W, 1110am- 150pm"
//   -> "PSY260 · Introduction to Psychology"
export function shortName(name) {
  let s = String(name || '').trim();
  s = s.replace(/^\d{4}\s?[A-Z]{2}\s+/, '');                       // leading term code
  const cut = s.lastIndexOf(' - ');
  if (cut > 0 && /\d{1,2}:?\d{2}\s*[ap]m/i.test(s.slice(cut))) s = s.slice(0, cut); // instructor + meeting time
  const m = s.match(/^([A-Z]{2,5}\s?\d{3}[A-Z]?)(?:-[A-Z0-9]+)?\s+(.+)$/);
  s = m ? `${m[1]} · ${m[2]}` : s;
  return s.trim() || String(name || '');
}

async function fetchCanvas() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 864e5);
  const warnings = [];

  const rawCourses = await getAll('/courses', [
    ['enrollment_state', 'active'],
    ['include[]', 'term'],
    ['include[]', 'total_scores'],
  ]);
  const courses = rawCourses.filter(
    (c) => c && c.name && !c.access_restricted_by_date && !(c.term?.end_at && new Date(c.term.end_at) < now),
  );
  for (const c of courses) c.name = shortName(c.name);
  const courseName = new Map(courses.map((c) => [c.id, c.name]));

  const missing = [];
  const upcoming = [];

  for (const c of courses) {
    let assignments;
    try {
      assignments = await getAll(`/courses/${c.id}/assignments`, [
        ['include[]', 'submission'],
        ['order_by', 'due_at'],
      ]);
    } catch (e) {
      warnings.push('Could not read assignments for one course.');
      console.warn('warn: ' + e.message);
      continue;
    }
    for (const a of assignments) {
      if (!a.due_at || a.published === false) continue;
      const due = new Date(a.due_at);
      const sub = a.submission || {};
      const types = a.submission_types || [];
      const noSubmit = types.some((t) => ['none', 'not_graded', 'on_paper'].includes(t));
      const done = !!sub.excused || !!sub.submitted_at || (sub.workflow_state === 'graded' && sub.score != null);
      const item = {
        id: a.id,
        course: c.name,
        name: a.name,
        dueAt: a.due_at,
        url: a.html_url,
        points: a.points_possible ?? null,
        type: types.includes('online_quiz') ? 'quiz' : types.includes('discussion_topic') ? 'discussion' : 'assignment',
        done,
        noSubmit,
      };
      const isMissing = !done && !noSubmit && (sub.missing === true || (sub.missing == null && due < now));
      if (isMissing) missing.push(item);
      else if (due >= now && due <= windowEnd) upcoming.push(item);
    }
  }

  const codes = courses.map((c) => `course_${c.id}`);
  const fromCode = (code) => courseName.get(Number(String(code || '').replace('course_', ''))) || '';

  const announcements = [];
  const events = [];
  for (const group of chunk(codes, 10)) {
    const ctx = group.map((code) => ['context_codes[]', code]);
    try {
      const list = await getAll('/announcements', [
        ...ctx,
        ['start_date', new Date(now.getTime() - 14 * 864e5).toISOString()],
        ['end_date', now.toISOString()],
      ]);
      for (const n of list) {
        announcements.push({
          id: n.id,
          course: fromCode(n.context_code),
          title: n.title,
          text: htmlToText(n.message),
          postedAt: n.posted_at,
          url: n.html_url,
        });
      }
    } catch (e) {
      warnings.push('Could not read some announcements.');
      console.warn('warn: ' + e.message);
    }
    try {
      const list = await getAll('/calendar_events', [
        ...ctx,
        ['type', 'event'],
        ['start_date', now.toISOString()],
        ['end_date', windowEnd.toISOString()],
      ]);
      for (const ev of list) {
        if (!ev.start_at) continue;
        events.push({
          id: ev.id,
          course: fromCode(ev.context_code),
          title: ev.title,
          startAt: ev.start_at,
          location: ev.location_name || '',
          url: ev.html_url,
        });
      }
    } catch (e) {
      warnings.push('Could not read some calendar events.');
      console.warn('warn: ' + e.message);
    }
  }

  missing.sort((a, b) => new Date(b.dueAt) - new Date(a.dueAt));
  upcoming.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  announcements.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

  return {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      code: '',
      score: INCLUDE_GRADES ? c.enrollments?.[0]?.computed_current_score ?? null : null,
    })),
    missing,
    upcoming,
    events,
    announcements: announcements.slice(0, 12),
    warnings: [...new Set(warnings)],
  };
}

// ---------- Sample data (for trying the site before connecting Canvas) ----------

function sampleData() {
  const now = Date.now();
  const at = (hours) => new Date(now + hours * 36e5).toISOString();
  const u = 'https://example.instructure.com/';
  const mk = (id, course, name, hours, extra = {}) => ({
    id, course, name, dueAt: at(hours), url: u, points: 100, type: 'assignment', done: false, noSubmit: false, ...extra,
  });
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: 14,
    courses: [
      { id: 1, name: 'Sample Course A', code: 'AAA 101', score: null },
      { id: 2, name: 'Sample Course B', code: 'BBB 202', score: null },
      { id: 3, name: 'Sample Course C', code: 'CCC 303', score: null },
    ],
    missing: [mk(10, 'Sample Course B', 'Problem Set 4', -52, { points: 40 })],
    upcoming: [
      mk(11, 'Sample Course A', 'Chapter 6 Quiz', 5, { type: 'quiz', points: 20 }),
      mk(12, 'Sample Course C', 'Discussion: Week 7', 20, { type: 'discussion', points: 10, done: true }),
      mk(13, 'Sample Course B', 'Case Write-up', 44),
      mk(14, 'Sample Course A', 'Midterm Exam (in class)', 96, { noSubmit: true }),
      mk(15, 'Sample Course C', 'Group Project Outline', 150, { points: 50 }),
      mk(16, 'Sample Course B', 'Problem Set 5', 220, { points: 40 }),
    ],
    events: [
      { id: 20, course: 'Sample Course A', title: 'Midterm review session', startAt: at(70), location: 'Room 204', url: u },
    ],
    announcements: [
      { id: 30, course: 'Sample Course B', title: 'Office hours moved this week', text: 'Office hours move to Thursday at 3 PM this week only.', postedAt: at(-6), url: u },
      { id: 31, course: 'Sample Course A', title: 'Midterm covers chapters 1–6', text: 'Bring a calculator. A formula sheet will be provided.', postedAt: at(-30), url: u },
    ],
    markets: [
      { symbol: 'SPY', price: 612.34, changePct: 0.42, spark: [598, 601, 600, 604, 603, 607, 605, 609, 608, 611, 610, 612.34] },
      { symbol: 'QQQ', price: 541.1, changePct: -0.31, spark: [548, 547, 549, 545, 546, 544, 545, 543, 544, 542, 543, 541.1] },
      { symbol: 'DIA', price: 455.02, changePct: 0.12, spark: [450, 451, 452, 451, 453, 452, 454, 453, 454, 455, 454, 455.02] },
      { symbol: 'IWM', price: 231.77, changePct: 1.08, spark: [224, 225, 224, 226, 227, 226, 228, 229, 228, 230, 229, 231.77] },
    ],
    weather: { temp: 61, feels: 59, text: 'Partly cloudy', hi: 66, lo: 49, rain: 20 },
    warnings: ['This is sample data. Run the workflow with your Canvas secrets to see the real thing.'],
  };
}

// ---------- Markets and weather (optional extras; a failure here never blocks the Canvas data) ----------

// TICKERS secret: comma-separated symbols, e.g. "SPY, QQQ, AAPL". Unset = a few index ETFs. "none" = off.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const quote = (symbol, price, closes) => {
  const prev = closes.length > 1 ? closes[closes.length - 2] : null;
  return { symbol, price, changePct: prev ? ((price - prev) / prev) * 100 : null, spark: closes.slice(-22).map((x) => Math.round(x * 100) / 100) };
};

async function yahooQuote(sym, host) {
  const res = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter((x) => typeof x === 'number');
  const price = typeof r?.meta?.regularMarketPrice === 'number' ? r.meta.regularMarketPrice : closes[closes.length - 1];
  if (typeof price !== 'number') throw new Error('yahoo no price');
  if (closes.length) closes[closes.length - 1] = price;
  return quote(sym, price, closes);
}

// Preferred source when ALPACA_KEY_ID and ALPACA_SECRET_KEY are set: Alpaca's market data API
// (US stocks and ETFs, free IEX feed). Two requests cover every symbol at once.
async function alpacaQuotes(symbols) {
  const id = (process.env.ALPACA_KEY_ID || '').trim(), secret = (process.env.ALPACA_SECRET_KEY || '').trim();
  const list = symbols.filter((x) => /^[A-Z][A-Z.]*$/.test(x));
  if (!id || !secret || !list.length) return new Map();
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' };
  const q = encodeURIComponent(list.join(','));
  const get = async (path) => {
    const res = await fetch('https://data.alpaca.markets/v2/stocks/' + path, { headers });
    if (!res.ok) throw new Error(`alpaca ${res.status}`);
    return res.json();
  };
  const snaps = await get(`snapshots?symbols=${q}&feed=iex`);
  let bars = {};
  try {
    const start = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    bars = (await get(`bars?symbols=${q}&timeframe=1Day&start=${start}&limit=1000&adjustment=split&feed=iex`)).bars || {};
  } catch (e) { console.warn('warn: price history unavailable (' + e.message + ')'); }
  const out = new Map();
  for (const sym of list) {
    const sn = (snaps.snapshots || snaps)[sym];
    const price = sn?.latestTrade?.p ?? sn?.dailyBar?.c;
    if (typeof price !== 'number') continue;
    const prev = sn?.prevDailyBar?.c;
    const closes = (bars[sym] || []).map((b) => b.c).filter((x) => typeof x === 'number');
    if (closes.length) closes[closes.length - 1] = price;
    out.set(sym, {
      symbol: sym, price,
      changePct: typeof prev === 'number' && prev ? ((price - prev) / prev) * 100 : null,
      spark: closes.slice(-22).map((x) => Math.round(x * 100) / 100),
    });
  }
  return out;
}

// quotes.json, written by quotes.py (yfinance) earlier in the workflow, if that step ran.
async function fileQuotes() {
  try {
    const list = JSON.parse(await readFile(process.env.QUOTES_FILE || 'quotes.json', 'utf8'));
    return new Map((Array.isArray(list) ? list : [])
      .filter((q) => q && typeof q.symbol === 'string' && typeof q.price === 'number')
      .map((q) => [q.symbol.toUpperCase(), { symbol: q.symbol.toUpperCase(), price: q.price, changePct: typeof q.changePct === 'number' ? q.changePct : null, spark: Array.isArray(q.spark) ? q.spark.filter((x) => typeof x === 'number').slice(-22) : [] }]));
  } catch { return new Map(); }
}

// Finnhub, when the FINNHUB_KEY secret is set: price and day change, no history.
async function finnhubQuote(sym) {
  const key = (process.env.FINNHUB_KEY || '').trim();
  if (!key) throw new Error('finnhub not configured');
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}`, { headers: { 'X-Finnhub-Token': key } });
  if (!res.ok) throw new Error(`finnhub ${res.status}`);
  const j = await res.json();
  if (typeof j.c !== 'number' || j.c <= 0) throw new Error('finnhub no data');
  return { symbol: sym, price: j.c, changePct: typeof j.dp === 'number' ? j.dp : (j.pc ? ((j.c - j.pc) / j.pc) * 100 : null), spark: [] };
}

// Backup source: Stooq end-of-day history (US-listed stocks and ETFs only).
async function stooqQuote(sym) {
  if (!/^[A-Z][A-Z0-9.-]*$/.test(sym)) throw new Error('stooq unsupported symbol');
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase().replace('.', '-'))}.us&i=d`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/);
  if (!/^Date,Open,High,Low,Close/i.test(lines[0] || '')) throw new Error('stooq no data');
  const closes = lines.slice(1).slice(-30).map((l) => Number(l.split(',')[4])).filter((x) => Number.isFinite(x) && x > 0);
  if (!closes.length) throw new Error('stooq no data');
  return quote(sym, closes[closes.length - 1], closes);
}

// TICKERS secret: comma-separated symbols, e.g. "SPY, QQQ, AAPL". Unset = a few index ETFs. "none" = off.
// Returns { quotes, wanted } so the caller can tell "turned off" apart from "source refused".
export async function fetchMarkets() {
  const raw = (process.env.TICKERS || '').trim();
  if (/^(none|off)$/i.test(raw)) return { quotes: [], wanted: 0 };
  const symbols = (raw || 'SPY, QQQ, DIA, IWM').split(/[\s,]+/).map((x) => x.toUpperCase())
    .filter((x) => /^[A-Z0-9.^=-]{1,12}$/.test(x)).slice(0, 12);
  const quotes = [];
  const reasons = new Set();
  let fromAlpaca = new Map();
  try { fromAlpaca = await alpacaQuotes(symbols); } catch (e) { reasons.add(e.message); }
  const fromFile = await fileQuotes();
  for (const sym of symbols) {
    if (fromAlpaca.has(sym)) { quotes.push(fromAlpaca.get(sym)); continue; }
    if (fromFile.has(sym)) { quotes.push(fromFile.get(sym)); continue; }
    const attempts = [() => finnhubQuote(sym), () => yahooQuote(sym, 'query1.finance.yahoo.com'), () => yahooQuote(sym, 'query2.finance.yahoo.com'), () => stooqQuote(sym)];
    for (const attempt of attempts) {
      try { quotes.push(await attempt()); break; } catch (e) { reasons.add(e.message); }
    }
  }
  if (quotes.length < symbols.length) console.warn(`warn: ${symbols.length - quotes.length} of ${symbols.length} quotes failed (${[...reasons].join(', ')})`);
  return { quotes, wanted: symbols.length };
}

const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm' };

// WEATHER_LOCATION secret: "City, State/Country" (e.g. "Smithfield, Rhode Island") or "lat,lon". Unset = off.
export async function fetchWeather() {
  const loc = (process.env.WEATHER_LOCATION || '').trim();
  if (!loc) return null;
  let lat, lon;
  const m = loc.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) { lat = Number(m[1]); lon = Number(m[2]); }
  else {
    const [city, ...rest] = loc.split(',').map((x) => x.trim());
    const hint = rest.join(' ').toLowerCase();
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(city)}`);
    if (!res.ok) throw new Error('geocoding ' + res.status);
    const list = (await res.json()).results || [];
    const pick = list.find((r) => hint && [r.admin1, r.country, r.country_code].filter(Boolean).some((x) => hint.includes(String(x).toLowerCase()) || String(x).toLowerCase().includes(hint))) || list[0];
    if (!pick) throw new Error('location not found');
    lat = pick.latitude; lon = pick.longitude;
  }
  const unit = /^c/i.test(process.env.WEATHER_UNITS || '') ? 'celsius' : 'fahrenheit';
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=${unit}&timezone=auto&forecast_days=1`);
  if (!res.ok) throw new Error('forecast ' + res.status);
  const j = await res.json();
  return {
    temp: Math.round(j.current.temperature_2m),
    feels: Math.round(j.current.apparent_temperature),
    text: WMO[j.current.weather_code] || '',
    hi: Math.round(j.daily.temperature_2m_max[0]),
    lo: Math.round(j.daily.temperature_2m_min[0]),
    rain: j.daily.precipitation_probability_max?.[0] ?? null,
  };
}

// ---------- Encryption (AES-256-GCM, key derived with PBKDF2-SHA256) ----------

async function encrypt(obj, passphrase) {
  const { subtle } = globalThis.crypto;
  const enc = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const material = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

// ---------- Main ----------

if (!process.env.NO_MAIN) try {
  const data = SAMPLE ? sampleData() : await fetchCanvas();
  if (!SAMPLE) {
    try {
      const m = await fetchMarkets();
      data.markets = m.quotes;
      if (m.wanted && !m.quotes.length) data.warnings.push('Market quotes are unavailable right now: every quote source refused the request.');
    } catch (e) { data.markets = []; console.warn('warn: markets: ' + e.message); }
    try { data.weather = await fetchWeather(); } catch (e) { data.weather = null; console.warn('warn: weather: ' + e.message); data.warnings.push('Weather is unavailable right now.'); }
  }
  const blob = await encrypt(data, PASSPHRASE);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(blob));
  console.log(
    `Wrote encrypted data: ${data.courses.length} courses, ${data.upcoming.length} upcoming, ` +
      `${data.missing.length} missing, ${data.events.length} events, ${data.announcements.length} announcements, ` +
      `${(data.markets || []).length} quotes, weather ${data.weather ? 'on' : 'off'}.`,
  );
} catch (e) {
  fail(e.message);
}
