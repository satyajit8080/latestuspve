// research/backfill.js — raw point-in-time backfill of Unusual Whales history, for OFFLINE research only.
// Nothing here is imported by the server or the engines. It stores RAW responses (never transforms them) so any
// later analysis can be reproduced. Files are immutable: an existing 200 response is never refetched or overwritten.
//
// Layout:  <out>/<endpoint>/<TICKER>/<YYYY-MM-DD>.json   {meta:{...}, data:<raw response>}   (per-date endpoints)
//          <out>/<endpoint>/<TICKER>/series.json          (once-per-ticker series endpoints)
//          <out>/market/<endpoint>/<YYYY-MM-DD>.json      (market-wide, per date)
//          <out>/manifest.jsonl                           one line per call: no payload, no token
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
export const DEFAULT_ENDPOINTS = ['flow', 'tape', 'oi', 'series', 'market'];
// Opt-in extras (not in the default run). 'fulltape' is HUGE (whole-market trades per day): run it for a few days only.
export const EXTRA_ENDPOINTS = ['chain', 'gexlevels', 'bars5m', 'darkpool', 'termstructure', 'earnings', 'insider', 'congress'];
export const SECTORS = ['Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical', 'Consumer Defensive', 'Industrials', 'Energy', 'Utilities', 'Real Estate', 'Basic Materials', 'Communication Services'];
const slug = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// ---- dates ----------------------------------------------------------------------------------------------------
export function tradingDays(from, to) {              // Mon–Fri between from..to inclusive, NEWEST FIRST. Holidays return empty data.
  const out = []; const end = Date.parse(`${to}T12:00:00Z`);
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= end; t += 86400000) { const d = new Date(t); const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); }
  return out.reverse();
}
const etHour = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
export function etDayBounds(date) {                  // [start, end) of an ET calendar day as ISO UTC strings (DST-safe)
  const [y, m, d] = date.split('-').map(Number);
  const at = (day) => { for (const off of [4, 5]) { const ms = Date.UTC(y, m - 1, day, off); if (etHour(ms) === 0) return ms; } return Date.UTC(y, m - 1, day, 5); };
  return [new Date(at(d)).toISOString(), new Date(at(d + 1)).toISOString()];
}

// ---- plan -----------------------------------------------------------------------------------------------------
export function buildPlan({ tickers, dates, endpoints = DEFAULT_ENDPOINTS }) {
  const has = (e) => endpoints.includes(e); const jobs = [];
  for (const date of dates) {                         // newest first so a history-limit 403 only costs the oldest days
    if (has('market')) { jobs.push({ key: `market/market-tide/${date}`, endpoint: 'market-tide', scope: 'market', date, path: `/api/market/market-tide?date=${date}` }); for (const sec of SECTORS) jobs.push({ key: `market/sector-tide-${slug(sec)}/${date}`, endpoint: `sector-tide-${slug(sec)}`, scope: 'market', date, path: `/api/market/${enc(sec)}/sector-tide?date=${date}` }); }
    if (has('fulltape')) jobs.push({ key: `fulltape/${date}`, endpoint: 'fulltape', scope: 'market', date, kind: 'file', path: `/api/option-trades/full-tape/${date}` });
    for (const t of tickers) {
      if (has('chain')) jobs.push({ key: `chain/${t}/${date}`, endpoint: 'chain', scope: 'ticker', ticker: t, date, dateSensitive: true, limit: 500, path: `/api/stock/${enc(t)}/option-contracts?date=${date}` });
      if (has('gexlevels')) for (const src of ['oi', 'vol']) jobs.push({ key: `gexlevels-${src}/${t}/${date}`, endpoint: `gexlevels-${src}`, scope: 'ticker', ticker: t, date, dateSensitive: true, path: `/api/stock/${enc(t)}/gex-levels?date=${date}&source=${src}` });
      if (has('bars5m')) jobs.push({ key: `bars5m/${t}/${date}`, endpoint: 'bars5m', scope: 'ticker', ticker: t, date, dateSensitive: true, limit: 200, path: `/api/stock/${enc(t)}/ohlc/5m?date=${date}&limit=200` });
      if (has('darkpool')) jobs.push({ key: `darkpool/${t}/${date}`, endpoint: 'darkpool', scope: 'ticker', ticker: t, date, dateSensitive: true, limit: 500, path: `/api/darkpool/${enc(t)}?date=${date}&limit=500` });
      if (has('termstructure')) jobs.push({ key: `termstructure/${t}/${date}`, endpoint: 'termstructure', scope: 'ticker', ticker: t, date, dateSensitive: true, path: `/api/stock/${enc(t)}/volatility/term-structure?date=${date}` });
      if (has('flow')) jobs.push({ key: `flow/${t}/${date}`, endpoint: 'flow', scope: 'ticker', ticker: t, date, paged: true });
      if (has('tape')) jobs.push({ key: `tape/${t}/${date}`, endpoint: 'tape', scope: 'ticker', ticker: t, date, path: `/api/stock/${enc(t)}/net-prem-ticks?date=${date}` });
      if (has('oi')) jobs.push({ key: `oi/${t}/${date}`, endpoint: 'oi', scope: 'ticker', ticker: t, date, path: `/api/stock/${enc(t)}/oi-change?date=${date}` });
    }
  }
  if (has('series')) for (const t of tickers) {
    jobs.push({ key: `gex/${t}/series`, endpoint: 'gex', scope: 'ticker', ticker: t, date: 'series', path: `/api/stock/${enc(t)}/greek-exposure?timeframe=2Y` });
    jobs.push({ key: `ohlc1d/${t}/series`, endpoint: 'ohlc1d', scope: 'ticker', ticker: t, date: 'series', path: `/api/stock/${enc(t)}/ohlc/1d?limit=600` });
    jobs.push({ key: `skew/${t}/series`, endpoint: 'skew', scope: 'ticker', ticker: t, date: 'series', path: `/api/stock/${enc(t)}/historical-risk-reversal-skew` });
    jobs.push({ key: `ivrank/${t}/series`, endpoint: 'ivrank', scope: 'ticker', ticker: t, date: 'series', path: `/api/stock/${enc(t)}/iv-rank` });
  }
  for (const t of tickers) {
    if (has('earnings')) jobs.push({ key: `earnings/${t}/series`, endpoint: 'earnings', scope: 'ticker', ticker: t, date: 'series', path: `/api/earnings/${enc(t)}` });
    if (has('insider')) jobs.push({ key: `insider/${t}/series`, endpoint: 'insider', scope: 'ticker', ticker: t, date: 'series', path: `/api/insider/${enc(t)}` });
    if (has('congress')) jobs.push({ key: `congress/${t}/series`, endpoint: 'congress', scope: 'ticker', ticker: t, date: 'series', path: `/api/congress/recent-trades?ticker=${enc(t)}&limit=500` });
  }
  return jobs;
}
const fileFor = (out, j) => (j.kind === 'file' ? path.join(out, j.endpoint, `${j.date}.bin`) : j.scope === 'market' ? path.join(out, 'market', j.endpoint, `${j.date}.json`) : path.join(out, j.endpoint, j.ticker, `${j.date}.json`));

// ---- one HTTP call (retry/backoff; the token is never logged or stored) --------------------------------------
export async function getJson(pathq, { base, token, fetchImpl = fetch, sleep = sleepDefault, maxAttempts = 5, onThrottle = null }) {
  let last = { status: 0, error: 'no attempt' };
  for (let a = 0; a < maxAttempts; a++) {
    let res;
    try { res = await fetchImpl(`${base}${pathq}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); }
    catch { last = { status: 0, error: 'network' }; await sleep(Math.min(30000, 1000 * 2 ** a)); continue; }
    if (res.status === 429) { const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')); last = { status: 429, error: 'rate limited' }; const w429 = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 5000 * (a + 1)); if (onThrottle) onThrottle(w429); await sleep(w429); continue; }
    if (res.status >= 500) { last = { status: res.status, error: `server ${res.status}` }; await sleep(Math.min(30000, 1000 * 2 ** a)); continue; }
    let body = null; let text = '';
    try { text = await res.text(); body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) return { status: res.status, error: (body && (body.code || body.message || body.error)) || text.slice(0, 160), body };
    return { status: res.status, body };
  }
  return last;
}
export async function downloadFile(pathq, dest, { base, token, fetchImpl = fetch, sleep = sleepDefault, maxAttempts = 3, onThrottle = null }) {
  let last = { status: 0, error: 'no attempt' };
  for (let a = 0; a < maxAttempts; a++) {
    let res;
    try { res = await fetchImpl(`${base}${pathq}`, { headers: { Authorization: `Bearer ${token}`, Accept: '*/*' } }); }
    catch { last = { status: 0, error: 'network' }; await sleep(Math.min(30000, 1000 * 2 ** a)); continue; }
    if (res.status === 429) { const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')); const w = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 5000 * (a + 1)); last = { status: 429, error: 'rate limited' }; if (onThrottle) onThrottle(w); await sleep(w); continue; }
    if (res.status >= 500) { last = { status: res.status, error: `server ${res.status}` }; await sleep(Math.min(30000, 1000 * 2 ** a)); continue; }
    if (!res.ok) { let t = ''; try { t = (await res.text()).slice(0, 160); } catch { /* ignore */ } return { status: res.status, error: t }; }
    fs.mkdirSync(path.dirname(dest), { recursive: true }); const tmp = `${dest}.tmp`;
    try {
      if (res.body && Readable.fromWeb) await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      else fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer ? await res.arrayBuffer() : await res.text()));
    } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } last = { status: 0, error: 'stream failed' }; await sleep(1000); continue; }
    fs.renameSync(tmp, dest);
    return { status: 200, bytes: fs.statSync(dest).size, contentType: (res.headers && res.headers.get && res.headers.get('content-type')) || null };
  }
  return last;
}
const rowsOf = (b) => (Array.isArray(b) ? b : b && Array.isArray(b.data) ? b.data : b && b.data && typeof b.data === 'object' && Object.keys(b.data).length ? [b.data] : []);   // a single-object payload counts as 1 row, not 0
const isHistoryLimit = (r) => r.status === 403 && /historic|history|lookback|access/i.test(String(r.error || JSON.stringify(r.body || '')));

// flow alerts have no per-ticker date filter: page backwards inside the ET day with newer_than / older_than.
async function fetchFlowDay(job, ctx) {
  const [start, end] = etDayBounds(job.date); const limit = 200; const maxPages = Number(ctx.maxFlowPages || 15);
  let older = end; const rows = []; let pages = 0; let truncated = false;
  for (; pages < maxPages;) {
    const p = `/api/option-trades/flow-alerts?ticker_symbol=${enc(job.ticker)}&newer_than=${enc(start)}&older_than=${enc(older)}&limit=${limit}`;
    const r = await ctx.get(p); pages++;
    if (r.status !== 200) return { ...r, pages, rows: rows.length };
    const got = rowsOf(r.body); rows.push(...got);
    if (got.length < limit) return { status: 200, body: { data: rows }, pages, rows: rows.length, truncated: false };
    const times = got.map((x) => Date.parse(x.created_at || x.timestamp || '')).filter(Number.isFinite);
    if (!times.length) { truncated = true; break; }
    const oldest = Math.min(...times); if (oldest <= Date.parse(start)) return { status: 200, body: { data: rows }, pages, rows: rows.length, truncated: false };
    older = new Date(oldest).toISOString();
  }
  return { status: 200, body: { data: rows }, pages, rows: rows.length, truncated: truncated || pages >= maxPages };
}

// ---- runner ---------------------------------------------------------------------------------------------------
export async function runBackfill({ jobs, out, base = 'https://api.unusualwhales.com', token, rpm = 100, fetchImpl = fetch, sleep = sleepDefault, now = () => Date.now(), log = () => {}, maxFlowPages, gzip = false, concurrency = 1, minFreeGb = 0, freeBytes = defaultFreeBytes }) {
  fs.mkdirSync(out, { recursive: true });
  const manifest = path.join(out, 'manifest.jsonl'); const spacing = Math.ceil(60000 / Math.max(1, rpm));
  let lastAt = 0; let pauseUntil = 0;
  // Reserve the next request slot BEFORE waiting, so N workers still share one rpm budget; a 429 pauses every worker.
  const get = async (p) => {
    const slot = Math.max(lastAt + spacing, pauseUntil, now()); lastAt = slot;
    const wait = slot - now(); if (wait > 0) await sleep(wait);
    return getJson(p, { base, token, fetchImpl, sleep, onThrottle: (ms) => { pauseUntil = Math.max(pauseUntil, now() + ms); } });
  };
  const ctx = { get, maxFlowPages }; const stopped = new Set(); const stats = {};
  const bump = (ep, k) => { (stats[ep] ||= { ok: 0, empty: 0, skipped: 0, error: 0, limit: 0 })[k]++; };
  let next = 0; let halted = false; let sinceDiskCheck = 24;   // 24 => the very first job triggers a disk check, then every 25 jobs
  const fails = new Map(); const lastHash = new Map(); const suspects = new Map();
  const diskOk = () => { if (!minFreeGb) return true; if (++sinceDiskCheck < 25) return true; sinceDiskCheck = 0; const free = freeBytes(out); if (free < minFreeGb * 1e9) { halted = true; log(`STOPPED: only ${(free / 1e9).toFixed(1)} GB free (< ${minFreeGb} GB). Free space or lower --min-free-gb, then re-run to resume.`); return false; } return true; };
  const worker = async () => { for (;;) { if (halted) return; const idx = next++; if (idx >= jobs.length) return; if (!diskOk()) return; await doJob(jobs[idx]); } };
  async function doJob(j) {
    const f = fileFor(out, j);
    if (stopped.has(j.endpoint)) { bump(j.endpoint, 'limit'); return; }
    // only complete 200 responses are ever written (atomic rename), so existence of either form means "done"
    if (fs.existsSync(f) || fs.existsSync(`${f}.gz`)) { bump(j.endpoint, 'skipped'); return; }
    const requestedAt = new Date(now()).toISOString();
    let r;
    if (j.paged) r = await fetchFlowDay(j, ctx);
    else if (j.kind === 'file') { const slot = Math.max(lastAt + spacing, pauseUntil, now()); lastAt = slot; if (slot - now() > 0) await sleep(slot - now()); r = await downloadFile(j.path, f, { base, token, fetchImpl, sleep, onThrottle: (ms) => { pauseUntil = Math.max(pauseUntil, now() + ms); } }); }
    else r = await get(j.path);
    const rows = r.rows ?? rowsOf(r.body).length;
    const meta = { endpoint: j.endpoint, ticker: j.ticker || null, date: j.date, path: j.paged ? '/api/option-trades/flow-alerts' : j.path, requestedAt, status: r.status, rows, pages: r.pages ?? 1, truncated: !!r.truncated || (j.limit != null && rows >= j.limit), error: r.status === 200 ? null : String(r.error || '').slice(0, 200) };
    if (r.status === 200 && j.dateSensitive && rows > 0) {      // a date parameter the API silently ignores returns the SAME payload for every date
      const h = crypto.createHash('sha1').update(JSON.stringify(r.body)).digest('hex'); const k = `${j.endpoint}|${j.ticker}`; const prev = lastHash.get(k);
      lastHash.set(k, { h, date: j.date });
      if (prev && prev.h === h && prev.date !== j.date) { const n = (suspects.get(j.endpoint) || 0) + 1; suspects.set(j.endpoint, n); r = { status: 200, suspect: true, body: null }; if (n >= 5) { stopped.add(j.endpoint); log(`${j.endpoint}: identical payload returned for different dates — the date parameter is being IGNORED. Stopped; files already saved for this endpoint are NOT point-in-time. Delete research-data/backfill/${j.endpoint}.`); } }
    }
    if (r.suspect) { meta.status = 200; meta.error = 'suspect_identical_payload'; meta.rows = 0; bump(j.endpoint, 'error'); fs.appendFileSync(manifest, JSON.stringify(meta) + '\n'); return; }
    if (r.status === 200 && j.kind === 'file') { meta.bytes = r.bytes; meta.contentType = r.contentType; meta.rows = 1; bump(j.endpoint, 'ok'); }
    else if (r.status === 200) { fs.mkdirSync(path.dirname(f), { recursive: true }); const body = JSON.stringify({ meta, data: r.body }); const dest = gzip ? `${f}.gz` : f; const tmp = `${dest}.tmp`; fs.writeFileSync(tmp, gzip ? zlib.gzipSync(body) : body); fs.renameSync(tmp, dest); bump(j.endpoint, rows ? 'ok' : 'empty'); }
    else bump(j.endpoint, isHistoryLimit(r) ? 'limit' : 'error');
    fs.appendFileSync(manifest, JSON.stringify(meta) + '\n');
    // fail fast: an endpoint/path this plan does not serve must not burn thousands of calls
    const fl = fails.get(j.endpoint) || { consec: 0, ok: 0 }; fails.set(j.endpoint, fl);
    if (r.status === 200) { fl.ok++; fl.consec = 0; } else if (r.status !== 429 && !isHistoryLimit(r)) { fl.consec++; if (fl.consec >= 25 && fl.ok === 0 && !stopped.has(j.endpoint)) { stopped.add(j.endpoint); log(`${j.endpoint}: first ${fl.consec} calls all failed (last HTTP ${r.status} ${meta.error || ''}) — not available on this plan or the path is wrong. Skipped.`); } }
    if (isHistoryLimit(r) && j.date !== 'series') { stopped.add(j.endpoint); log(`${j.endpoint}: history limit reached at ${j.date} (HTTP 403) — older dates for this endpoint skipped`); }
    else if (r.status !== 200) log(`${j.key}: HTTP ${r.status} ${meta.error || ''}`);
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(32, concurrency)) }, worker));
  return stats;
}

function defaultFreeBytes(dir) { try { fs.mkdirSync(dir, { recursive: true }); const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch { return Infinity; } }

// ---- probe: what does THIS subscription actually allow? (safe to paste: no token, values truncated) -----------
export async function probe({ base = 'https://api.unusualwhales.com', token, ticker = 'AAPL', dates, fetchImpl = fetch, sleep = sleepDefault }) {
  const get = (p) => getJson(p, { base, token, fetchImpl, sleep, maxAttempts: 2 });
  const lines = []; const short = (v) => { const s = JSON.stringify(v); return s && s.length > 200 ? `${s.slice(0, 200)}…` : s; };
  for (const date of dates) {
    const r = await get(`/api/stock/${enc(ticker)}/net-prem-ticks?date=${date}`);
    lines.push(`net-prem-ticks ${ticker} ${date}: HTTP ${r.status}${r.status === 200 ? ` rows=${rowsOf(r.body).length}` : ` ${r.error || ''}`}`);
  }
  const d0 = dates[0]; const [s, e] = etDayBounds(d0);
  const checks = [
    ['flow-alerts (ticker, one ET day)', `/api/option-trades/flow-alerts?ticker_symbol=${ticker}&newer_than=${enc(s)}&older_than=${enc(e)}&limit=3`],
    ['net-prem-ticks', `/api/stock/${ticker}/net-prem-ticks?date=${d0}`], ['oi-change (ticker, date)', `/api/stock/${ticker}/oi-change?date=${d0}`],
    ['greek-exposure 2Y series', `/api/stock/${ticker}/greek-exposure?timeframe=2Y`], ['ohlc 1d', `/api/stock/${ticker}/ohlc/1d?limit=3`],
    ['historical-risk-reversal-skew', `/api/stock/${ticker}/historical-risk-reversal-skew`], ['iv-rank', `/api/stock/${ticker}/iv-rank`],
    ['market-tide', `/api/market/market-tide?date=${d0}`], ['sector-tide (Technology)', `/api/market/Technology/sector-tide?date=${d0}`],
    // --- candidates for completeness: does the plan serve these for a PAST date / longer history? ---
    ['gex-levels (date)', `/api/stock/${ticker}/gex-levels?date=${d0}`], ['greek-exposure/strike (date)', `/api/stock/${ticker}/greek-exposure/strike?date=${d0}`],
    ['iv-rank (timeframe=2Y)', `/api/stock/${ticker}/iv-rank?timeframe=2Y`], ['risk-reversal-skew (timeframe=2Y)', `/api/stock/${ticker}/historical-risk-reversal-skew?timeframe=2Y`],
    ['term-structure (date)', `/api/stock/${ticker}/volatility/term-structure?date=${d0}`], ['ohlc 5m (date)', `/api/stock/${ticker}/ohlc/5m?date=${d0}&limit=100`],
    ['option-contracts (date)', `/api/stock/${ticker}/option-contracts?date=${d0}`], ['darkpool (date)', `/api/darkpool/${ticker}?date=${d0}`],
    ['earnings history', `/api/earnings/${ticker}`], ['insider trades', `/api/insider/${ticker}`], ['congress trades', `/api/congress/recent-trades?ticker=${ticker}&limit=3`],
  ];
  for (const [label, p] of checks) {
    const r = await get(p);
    if (r.status !== 200) { lines.push(`\n${label}: HTTP ${r.status} ${r.error || ''}`); continue; }
    const rows = rowsOf(r.body); const first = rows[0] || (r.body && typeof r.body === 'object' ? r.body : null);
    lines.push(`\n${label}: HTTP 200 rows=${rows.length}\n  keys: ${first && typeof first === 'object' ? JSON.stringify(Object.keys(first)) : typeof first}\n  sample: ${short(first)}`);
  }
  // The full option tape can be hundreds of MB: look at the status, headers and the first bytes ONLY, then abort.
  try {
    const ac = new AbortController();
    const r = await fetchImpl(`${base}/api/option-trades/full-tape/${d0}`, { headers: { Authorization: `Bearer ${token}`, Accept: '*/*' }, signal: ac.signal });
    const h = (k) => (r.headers && r.headers.get ? r.headers.get(k) : null);
    let head = '';
    if (r.ok && r.body && r.body.getReader) { const { value } = await r.body.getReader().read(); head = Buffer.from(value || []).subarray(0, 200).toString('latin1').replace(/[^\x20-\x7e]/g, '.'); ac.abort(); }
    else if (typeof r.text === 'function') head = String(await r.text()).slice(0, 200);
    lines.push(`\nfull option tape (${d0}): HTTP ${r.status} type=${h('content-type')} length=${h('content-length')}\n  first bytes: ${head}`);
  } catch (e) { lines.push(`\nfull option tape: ${e && e.name === 'AbortError' ? 'aborted after first bytes' : 'error'}`); }
  return lines.join('\n');
}

// ---- status from the manifest -----------------------------------------------------------------------------------
export function summarize(out) {
  const f = path.join(out, 'manifest.jsonl'); if (!fs.existsSync(f)) return 'no manifest yet';
  const by = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    const s = (by[m.endpoint] ||= { ok: 0, empty: 0, http403: 0, other: 0, truncated: 0, min: null, max: null });
    if (m.status === 200) { m.rows ? s.ok++ : s.empty++; if (m.truncated) s.truncated++; if (/^\d{4}-/.test(m.date)) { s.min = !s.min || m.date < s.min ? m.date : s.min; s.max = !s.max || m.date > s.max ? m.date : s.max; } }
    else if (m.status === 403) s.http403++; else s.other++;
  }
  return Object.entries(by).map(([k, s]) => `${k.padEnd(12)} ok=${s.ok} empty=${s.empty} 403=${s.http403} other=${s.other} truncatedDays=${s.truncated} dates=${s.min || '-'}..${s.max || '-'}`).join('\n');
}
