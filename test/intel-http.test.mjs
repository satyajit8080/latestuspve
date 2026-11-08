import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIntelScan } from '../engine/intel/pipeline.js';
import { probeEndpoints } from '../engine/intel/probe.js';
import { payloads, fakeAdapter, NOW } from './fixtures/intel-fixture.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'intelhttp-')); fs.mkdirSync(path.join(TMP, 'scan')); fs.mkdirSync(path.join(TMP, 'j'));
Object.assign(process.env, { PORT: '4320', DASHBOARD_PASSWORD: 'intel-test-password-1', SESSION_SECRET: 'x'.repeat(40), OPTIONS_PROVIDER: 'null', SCAN_DIR: path.join(TMP, 'scan'), SIGNAL_LOG_DIR: path.join(TMP, 'j'), BASELINE_DIR: path.join(TMP, 'b'), INTEL_DIR: path.join(TMP, 'intel') });
const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch { /* ignore */ } setTimeout(() => process.exit(0), 50).unref(); });
const B = 'http://127.0.0.1:4320';
const cookie = (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"intel-test-password-1"}' })).headers.get('set-cookie').split(';')[0];
const get = (p, h = {}) => fetch(B + p, { headers: { cookie, ...h } }); const post = (p, b = {}) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(b) });

test('intel routes require sign-in', async () => { for (const [m, p] of [['GET', '/api/intel/status'], ['GET', '/api/intel/latest'], ['GET', '/api/intel/ticker/AAPL'], ['POST', '/api/intel/scan'], ['POST', '/api/intel/ticker/AAPL/refresh'], ['GET', '/api/intel/endpoints'], ['GET', '/api/intel/snapshots'], ['GET', '/api/intel/flow']]) assert.equal((await fetch(B + p, { method: m })).status, 401, p); });
test('before any scan: honest empty states, no fabricated data, scan refuses without a provider', async () => {
  const st = await (await get('/api/intel/status')).json(); assert.equal(st.ok, true); assert.equal(st.configured, false); assert.equal(st.latest, null); assert.equal(st.snapshots.count, 0);
  const l = await (await get('/api/intel/latest')).json(); assert.equal(l.available, false); assert.deepEqual(l.rows, []);
  const t = await (await get('/api/intel/ticker/AAPL')).json(); assert.equal(t.available, false); assert.equal(t.shallow, null);
  assert.equal((await post('/api/intel/scan')).status, 400); assert.equal((await post('/api/intel/ticker/AAPL/refresh')).status, 400); assert.equal((await get('/api/intel/ticker/%24%24')).status, 400);
});
test('after a scan: latest (with ETag), snapshot, ticker detail, status counts and data mode are served from cache', async () => {
  const dir = path.join(TMP, 'intel'); const tickers = ['AAA', 'BBB', 'CCC', 'DDD']; const by = (t) => payloads(t, { dir: t === 'BBB' ? 'bear' : 'bull' });
  await runIntelScan({ adapter: fakeAdapter(by), universe: tickers, deepN: 3, outDir: dir, nowMs: Date.now(), concurrency: 2 });
  const r = await get('/api/intel/latest'); const j = await r.json(); assert.equal(j.available, true); assert.equal(j.rows.length, 4); assert.ok(j.counts.deep >= 1); assert.match(j.note, /not predictions/); assert.ok(['LIVE', 'CLOSED', 'DELAYED'].includes(j.mode));
  assert.equal((await get('/api/intel/latest', { 'if-none-match': r.headers.get('etag') })).status, 304);
  const snaps = await (await get('/api/intel/snapshots')).json(); assert.equal(snaps.snapshots.length, 1); const h = await (await get(`/api/intel/latest?snapshot=${snaps.snapshots[0].date}/${snaps.snapshots[0].time}`)).json(); assert.equal(h.mode, 'HISTORICAL'); assert.equal(h.historical, true);
  assert.equal((await (await get('/api/intel/latest?snapshot=../../etc/passwd')).json()).historical, false);
  const fl = await (await get('/api/intel/flow')).json(); assert.equal(fl.available, true); assert.ok(fl.alerts.length > 0 && fl.alerts[0].premium >= fl.alerts[fl.alerts.length - 1].premium); assert.match(fl.note, /not proof of intent/);
  const deepT = j.rows.find((x) => x.deep).ticker; const d = await (await get(`/api/intel/ticker/${deepT}`)).json(); assert.equal(d.available, true); assert.ok(d.detail.evaluation.bull.components.length === 5 && d.detail.levels);
  const st = await (await get('/api/intel/status')).json(); assert.equal(st.snapshots.count, 1); assert.ok(st.latest.counts.rows === 4);
});
test('endpoint registry marks experimental paths and never claims they are verified', async () => {
  const e = await (await get('/api/intel/endpoints')).json(); const ml = e.endpoints.find((x) => x.key === 'multiLeg'), fl = e.endpoints.find((x) => x.key === 'flow'); assert.equal(ml.verified, false); assert.equal(fl.verified, true);
  const probe = await probeEndpoints(fakeAdapter({ default: payloads('Z') }), 'Z', { now: () => NOW }); assert.equal(probe.results.flow.ok, true); assert.equal(probe.results.multiLeg.ok, false); assert.ok(probe.results.flow.keys.includes('total_premium'));
});
