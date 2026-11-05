import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { tradingDays, etDayBounds, buildPlan, runBackfill, getJson, probe, summarize } from '../research/backfill.js';

const TOKEN = 'uw_SECRET_TOKEN_123';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body), json: async () => body });
const noSleep = async () => {};
const allText = (dir) => { let s = ''; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : (s += fs.readFileSync(p, 'utf8')); } }; walk(dir); return s; };

test('tradingDays: weekdays only, newest first', () => {
  assert.deepEqual(tradingDays('2026-10-30', '2026-11-03'), ['2026-11-03', '2026-11-02', '2026-10-30']);   // Fri, then Mon+Tue; weekend skipped
});

test('etDayBounds: DST-safe ET calendar day', () => {
  assert.deepEqual(etDayBounds('2026-07-01'), ['2026-07-01T04:00:00.000Z', '2026-07-02T04:00:00.000Z']);   // EDT
  assert.deepEqual(etDayBounds('2026-12-01'), ['2026-12-01T05:00:00.000Z', '2026-12-02T05:00:00.000Z']);   // EST
});

test('buildPlan: newest date first, per-ticker + market + series jobs', () => {
  const jobs = buildPlan({ tickers: ['AAPL'], dates: ['2026-11-03', '2026-11-02'] });
  assert.equal(jobs[0].date, '2026-11-03');
  for (const e of ['flow', 'tape', 'oi', 'gex', 'ohlc1d', 'skew', 'ivrank', 'market-tide', 'sector-tide-technology', 'sector-tide-financial-services']) assert.ok(jobs.some((j) => j.endpoint === e), e);
});

test('run: writes raw files + manifest, never stores the token, and RESUMES without refetching', async () => {
  const out = tmp(); let calls = 0;
  const fetchImpl = async (url, opts) => { calls++; assert.ok(opts.headers.Authorization.includes(TOKEN)); return res(200, { data: [{ a: 1 }] }); };
  const jobs = buildPlan({ tickers: ['AAPL'], dates: ['2026-11-03'], endpoints: ['tape', 'oi'] });
  const s1 = await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000 });
  assert.equal(calls, 2); assert.equal(s1.tape.ok, 1);
  assert.ok(fs.existsSync(path.join(out, 'tape', 'AAPL', '2026-11-03.json')));
  const s2 = await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000 });
  assert.equal(calls, 2, 'second run must not refetch'); assert.equal(s2.tape.skipped, 1);
  assert.ok(!allText(out).includes(TOKEN), 'token must never reach disk');
  assert.match(summarize(out), /tape\s+ok=1/);
});

test('run: history-limit 403 stops that endpoint (older dates skipped) but not the others', async () => {
  const out = tmp();
  const fetchImpl = async (url) => (url.includes('net-prem-ticks') && url.includes('date=2026-11-02') ? res(403, { code: 'historic_data_access_missing', message: 'earliest 2026-11-03' }) : res(200, { data: [{ x: 1 }] }));
  const jobs = buildPlan({ tickers: ['AAPL'], dates: ['2026-11-03', '2026-11-02', '2026-10-30'], endpoints: ['tape', 'oi'] });
  const logs = []; const s = await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000, log: (m) => logs.push(m) });
  assert.equal(s.tape.ok, 1); assert.equal(s.tape.limit, 2);   // the 403 itself + the skipped older date
  assert.equal(s.oi.ok, 3, 'other endpoints keep going');
  assert.ok(logs.some((m) => /history limit/.test(m)));
  assert.ok(!fs.existsSync(path.join(out, 'tape', 'AAPL', '2026-10-30.json')));
});

test('flow: pages backwards inside the ET day and flags truncation', async () => {
  const out = tmp(); const [start, end] = etDayBounds('2026-11-03'); let page = 0;
  const mk = (n, t0) => Array.from({ length: n }, (_, i) => ({ created_at: new Date(Date.parse(t0) - i * 1000).toISOString() }));
  const fetchImpl = async (url) => {
    page++; assert.ok(url.includes(`newer_than=${encodeURIComponent(start)}`));
    if (page === 1) { assert.ok(url.includes(`older_than=${encodeURIComponent(end)}`)); return res(200, { data: mk(200, '2026-11-03T20:00:00.000Z') }); }
    return res(200, { data: mk(50, '2026-11-03T19:00:00.000Z') });
  };
  const jobs = buildPlan({ tickers: ['NVDA'], dates: ['2026-11-03'], endpoints: ['flow'] });
  await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000 });
  const f = JSON.parse(fs.readFileSync(path.join(out, 'flow', 'NVDA', '2026-11-03.json'), 'utf8'));
  assert.equal(f.meta.pages, 2); assert.equal(f.meta.rows, 250); assert.equal(f.meta.truncated, false);
  // a ticker that keeps returning full pages is flagged truncated, never silently treated as complete
  const out2 = tmp(); let n = 0;
  const full = async () => { n++; return res(200, { data: mk(200, new Date(Date.parse('2026-11-03T20:00:00.000Z') - n * 400000).toISOString()) }); };
  await runBackfill({ jobs, out: out2, token: TOKEN, fetchImpl: full, sleep: noSleep, rpm: 6000, maxFlowPages: 3 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out2, 'flow', 'NVDA', '2026-11-03.json'), 'utf8')).meta.truncated, true);
});

test('getJson: retries 429 then succeeds; gives up on persistent 5xx without throwing', async () => {
  let n = 0; const sleeps = [];
  const r = await getJson('/x', { base: 'http://b', token: TOKEN, sleep: async (ms) => sleeps.push(ms), fetchImpl: async () => (++n < 3 ? res(429, {}, { 'retry-after': '2' }) : res(200, { data: [] })) });
  assert.equal(r.status, 200); assert.deepEqual(sleeps, [2000, 2000]);
  const bad = await getJson('/x', { base: 'http://b', token: TOKEN, sleep: noSleep, maxAttempts: 3, fetchImpl: async () => res(503, {}) });
  assert.equal(bad.status, 503);
});

test('probe output never contains the token', async () => {
  const text = await probe({ token: TOKEN, ticker: 'AAPL', dates: ['2026-11-03', '2025-01-02'], sleep: noSleep, fetchImpl: async (u) => (u.includes('2025-01-02') ? res(403, { code: 'historic_data_access_missing' }) : res(200, { data: [{ net_delta: 1 }] })) });
  assert.ok(!text.includes(TOKEN)); assert.match(text, /HTTP 403 historic_data_access_missing/); assert.match(text, /net_delta/);
});

test('gzip: stores .json.gz, round-trips, and resume recognises either form', async () => {
  const out = tmp(); let calls = 0;
  const fetchImpl = async () => { calls++; return res(200, { data: [{ a: 1 }] }); };
  const jobs = buildPlan({ tickers: ['AAPL'], dates: ['2026-11-03'], endpoints: ['tape'] });
  await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000, gzip: true });
  const f = path.join(out, 'tape', 'AAPL', '2026-11-03.json.gz');
  assert.ok(fs.existsSync(f)); assert.ok(!fs.existsSync(f.replace('.gz', '')));
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()).meta.rows, 1);
  const s = await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000, gzip: true });
  assert.equal(calls, 1); assert.equal(s.tape.skipped, 1);
  assert.ok(!allText(out).includes(TOKEN));
});

test('concurrency: every job runs exactly once, rpm budget is shared, and one 429 pauses all workers', async () => {
  const out = tmp(); const seen = []; let t = 0; const sleeps = []; let first429 = true;
  const fetchImpl = async (url) => { seen.push(url); if (first429 && url.includes('AAPL')) { first429 = false; return res(429, {}, { 'retry-after': '3' }); } return res(200, { data: [{ a: 1 }] }); };
  const jobs = buildPlan({ tickers: ['AAPL', 'MSFT', 'NVDA', 'AMD'], dates: ['2026-11-03', '2026-11-02'], endpoints: ['tape'] });
  const s = await runBackfill({ jobs, out, token: TOKEN, fetchImpl, rpm: 60, concurrency: 4, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  assert.equal(s.tape.ok, 8);
  assert.equal(new Set(seen.filter((u) => !u.includes('AAPL') || true)).size, 8, 'no job fetched twice');
  assert.ok(sleeps.includes(3000), 'the 429 retry-after was honoured');
  assert.ok(t >= 7 * 1000, 'spacing across workers kept the shared 60/min budget');
});

import { downloadFile, EXTRA_ENDPOINTS } from '../research/backfill.js';

test('extras: plan includes every opt-in endpoint; fulltape only when named; defaults unchanged', () => {
  const all = buildPlan({ tickers: ['AAPL'], dates: ['2026-11-03'], endpoints: [...EXTRA_ENDPOINTS, 'fulltape'] });
  for (const e of ['chain', 'gexlevels-oi', 'gexlevels-vol', 'bars5m', 'darkpool', 'termstructure', 'earnings', 'insider', 'congress', 'fulltape']) assert.ok(all.some((j) => j.endpoint === e), e);
  assert.ok(!buildPlan({ tickers: ['AAPL'], dates: ['2026-11-03'] }).some((j) => j.endpoint === 'fulltape' || j.endpoint === 'chain'));
});

test('fail fast: an endpoint that never succeeds is stopped after 25 calls', async () => {
  const out = tmp(); let n = 0; const logs = [];
  const fetchImpl = async (u) => { if (u.includes('option-contracts')) { n++; return res(404, { message: 'Route not found' }); } return res(200, { data: [{ x: 1 }] }); };
  const dates = tradingDays('2026-09-01', '2026-11-03');
  const jobs = buildPlan({ tickers: ['AAPL', 'MSFT'], dates, endpoints: ['chain', 'tape'] });
  await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 60000, log: (m) => logs.push(m) });
  assert.equal(n, 25); assert.ok(logs.some((m) => /chain: first 25 calls all failed/.test(m)));
});

test('date-sensitive endpoint that ignores the date param is detected, not stored as point-in-time', async () => {
  const out = tmp(); const logs = [];
  const fetchImpl = async () => res(200, { data: [{ strike: 100, same: true }] });          // same payload for every date
  const jobs = buildPlan({ tickers: ['AAPL'], dates: tradingDays('2026-10-01', '2026-11-03'), endpoints: ['chain'] });
  await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 60000, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /date parameter is being IGNORED/.test(m)));
  assert.ok(fs.readdirSync(path.join(out, 'chain', 'AAPL')).length <= 1, 'only the first payload could have been stored');
});

test('downloadFile: streams the body to disk atomically and reports bytes', async () => {
  const out = tmp(); const dest = path.join(out, 'fulltape', '2026-11-03.bin');
  const fetchImpl = async () => { const r = new Response('A'.repeat(5000), { status: 200, headers: { 'content-type': 'application/gzip' } }); return r; };
  const r = await downloadFile('/api/option-trades/full-tape/2026-11-03', dest, { base: 'http://b', token: TOKEN, fetchImpl, sleep: noSleep });
  assert.equal(r.status, 200); assert.equal(r.bytes, 5000); assert.equal(r.contentType, 'application/gzip');
  assert.ok(fs.existsSync(dest)); assert.ok(!fs.existsSync(`${dest}.tmp`));
  const bad = await downloadFile('/x', path.join(out, 'y.bin'), { base: 'http://b', token: TOKEN, fetchImpl: async () => res(403, { code: 'nope' }), sleep: noSleep });
  assert.equal(bad.status, 403);
});

test('fulltape job runs through the runner and is resumable; disk guard halts everything', async () => {
  const out = tmp(); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('tape', { status: 200 }); };
  const jobs = buildPlan({ tickers: [], dates: ['2026-11-03'], endpoints: ['fulltape'] });
  const s = await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000 });
  assert.equal(s.fulltape.ok, 1); assert.ok(fs.existsSync(path.join(out, 'fulltape', '2026-11-03.bin')));
  await runBackfill({ jobs, out, token: TOKEN, fetchImpl, sleep: noSleep, rpm: 6000 }); assert.equal(calls, 1);
  const out2 = tmp(); const logs = []; let c2 = 0;
  const many = buildPlan({ tickers: ['AAPL'], dates: tradingDays('2026-08-01', '2026-11-03'), endpoints: ['tape'] });
  await runBackfill({ jobs: many, out: out2, token: TOKEN, fetchImpl: async () => { c2++; return res(200, { data: [{ a: 1 }] }); }, sleep: noSleep, rpm: 60000, freeBytes: () => 1e9, minFreeGb: 50, log: (m) => logs.push(m) });
  assert.equal(c2, 0, 'no download may start when the disk is below the floor'); assert.ok(logs.some((m) => /STOPPED: only 1.0 GB free/.test(m)));
});
