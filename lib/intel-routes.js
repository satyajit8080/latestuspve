// lib/intel-routes.js — Options Intelligence HTTP API. Reads cached files (zero UW calls) except the explicit scan/refresh actions.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readLatest, readDeep, listSnapshots, readSnapshot, writeDeep, readFlow, intelDir } from '../store/intel-store.js';
import { dataMode, sessionOf } from '../engine/intel/session.js';
import { analyzeTicker } from '../engine/intel/pipeline.js';
import { createIntelAdapter } from '../providers/uw-intel.js';
import { INTEL_ENDPOINTS, ENGINE_VERSION } from '../engine/intel/endpoints.js';
import { safeTicker } from '../ticker.js';

export function registerIntelRoutes(app, { requireAuth, provider, limiter, legacyScanRunning = () => false, scanScript, env = process.env, now = () => Date.now(), cwd = process.cwd() }) {
  const dir = intelDir({ ...env, INTEL_DIR: env.INTEL_DIR || path.join(cwd, 'research-data', 'intel') }); const STATE = { running: false, startedAt: null, finishedAt: null, lastOk: null, message: '', stage: null, done: null, total: null };
  const adapter = createIntelAdapter(provider, { now }); const configured = () => provider && provider.name !== 'null';
  const modeOf = (latest) => dataMode({ nowMs: now(), asOfMs: latest ? Date.parse(latest.generatedAt) : NaN });
  const counts = (rows) => ({ rows: rows.length, deep: rows.filter((r) => r.deep).length, bull: rows.filter((r) => r.state === 'BULL').length, bear: rows.filter((r) => r.state === 'BEAR').length, noTrade: rows.filter((r) => r.state === 'NO_TRADE').length, errors: rows.filter((r) => r.error).length });
  app.get('/api/intel/status', requireAuth, (req, res) => {
    const latest = readLatest(dir); const snaps = listSnapshots(dir); const probe = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'endpoint-probe.json'), 'utf8')); } catch { return null; } })();
    res.json({ ok: true, engine: ENGINE_VERSION, configured: configured(), session: sessionOf(now()), scan: STATE, legacyScanRunning: legacyScanRunning(), limiter: limiter && limiter.stats ? limiter.stats() : null, probeAt: probe ? probe.at : null,
      latest: latest ? { generatedAt: latest.generatedAt, ageSeconds: Math.round((now() - Date.parse(latest.generatedAt)) / 1000), mode: modeOf(latest), partial: !!latest.partial, stage: latest.stage, done: latest.done, total: latest.total, universe: latest.universe, deepN: latest.deepN, schemaWarnings: latest.schemaWarnings || {}, counts: counts(latest.rows || []), scanApi: latest.api || null } : null,
      snapshots: { count: snaps.length, first: snaps[0] ? `${snaps[0].date} ${snaps[0].time}` : null, last: snaps.length ? `${snaps[snaps.length - 1].date} ${snaps[snaps.length - 1].time}` : null } });
  });
  app.get('/api/intel/latest', requireAuth, (req, res) => {
    const snap = typeof req.query.snapshot === 'string' && /^\d{4}-\d{2}-\d{2}\/\d{4}$/.test(req.query.snapshot) ? req.query.snapshot : null;
    let data = null, historical = false; if (snap) { const [d, t] = snap.split('/'); const hit = listSnapshots(dir).find((s) => s.date === d && s.time === t); data = hit ? readSnapshot(hit.file) : null; historical = true; } else data = readLatest(dir);
    if (!data || !Array.isArray(data.rows)) return res.json({ ok: true, available: false, reason: 'No Options Intelligence scan yet. Press “Run scan”.', rows: [] });
    const etag = `"${data.generatedAt}-${data.stage}-${data.done}-${historical ? 'h' : 'l'}"`; res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'no-cache'); if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json({ ok: true, available: true, historical, generatedAt: data.generatedAt, ageSeconds: Math.round((now() - Date.parse(data.generatedAt)) / 1000), mode: historical ? 'HISTORICAL' : modeOf(data), session: data.session, partial: !!data.partial, stage: data.stage, done: data.done, total: data.total, universe: data.universe, deepN: data.deepN, engine: data.engine, schemaWarnings: data.schemaWarnings || {}, counts: counts(data.rows), rows: data.rows,
      note: 'Scores are transparent evidence summaries with prior weights that are not yet validated. They are not predictions, probabilities of profit or trade recommendations.' });
  });
  app.get('/api/intel/flow', requireAuth, (req, res) => {
    const f = readFlow(dir); if (!f) return res.json({ ok: true, available: false, alerts: [], reason: 'No Options Intelligence scan yet.' });
    const etag = `"${f.generatedAt}-${f.count}"`; res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'no-cache'); if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json({ ok: true, available: true, generatedAt: f.generatedAt, ageSeconds: Math.round((now() - Date.parse(f.generatedAt)) / 1000), mode: modeOf(f), count: f.count, alerts: f.alerts, note: 'Top prints by premium from the last scan (latest session per ticker). A print is evidence of activity, not proof of intent.' });
  });
  app.get('/api/intel/snapshots', requireAuth, (req, res) => res.json({ ok: true, snapshots: listSnapshots(dir).map((s) => ({ date: s.date, time: s.time })).slice(-200) }));
  app.get('/api/intel/ticker/:t', requireAuth, (req, res) => {
    const t = safeTicker(req.params.t); if (!t) return res.status(400).json({ ok: false, error: 'bad ticker' }); const d = readDeep(dir, t);
    if (d) return res.json({ ok: true, available: true, ageSeconds: Math.round((now() - d.retrievedAt) / 1000), mode: dataMode({ nowMs: now(), asOfMs: d.retrievedAt }), detail: d });
    const latest = readLatest(dir); const row = latest && (latest.rows || []).find((r) => r.ticker === t); res.json({ ok: true, available: false, shallow: row || null, reason: row ? 'Only screened (not analysed in depth) in the last scan. Press “Refresh live” to analyse it now.' : 'Not in the last scan. Press “Refresh live” to analyse it now.' });
  });
  app.post('/api/intel/ticker/:t/refresh', requireAuth, async (req, res) => {
    if (!configured()) return res.status(400).json({ ok: false, error: 'No options provider configured' }); const t = safeTicker(req.params.t); if (!t) return res.status(400).json({ ok: false, error: 'bad ticker' });
    if (STATE.running) return res.status(409).json({ ok: false, error: 'An Options Intelligence scan is running; refresh after it finishes.' }); if (legacyScanRunning()) return res.status(409).json({ ok: false, error: 'The scanner is running; try again when it finishes.' });
    const gate = limiter && limiter.canRequest ? limiter.canRequest() : { ok: true }; if (!gate.ok) return res.status(429).json({ ok: false, error: 'LIMITER_SATURATED', reason: gate.reason, retryAfterMs: gate.retryAfterMs || null });
    try { const { row, detail } = await analyzeTicker(adapter, t, { nowMs: now(), experimental: req.query.experimental === '1' }); writeDeep(dir, t, detail); res.json({ ok: true, available: true, ageSeconds: 0, mode: detail.mode, detail }); }
    catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });
  app.post('/api/intel/scan', requireAuth, (req, res) => {
    if (!configured()) return res.status(400).json({ ok: false, error: 'No options provider configured', reason: provider && provider.reason || null });
    if (STATE.running) return res.status(409).json({ ok: false, error: 'An Options Intelligence scan is already running', state: STATE }); if (legacyScanRunning()) return res.status(409).json({ ok: false, error: 'The scanner is running; both use the same Unusual Whales rate limit. Wait for it to finish.' });
    if (!scanScript || !fs.existsSync(scanScript)) return res.status(500).json({ ok: false, error: 'intel-scan.js not found' });
    const b = req.body || {}; const deepN = Number.isInteger(b.deepN) ? Math.min(200, Math.max(10, b.deepN)) : Number(env.INTEL_DEEP_N) || 60;
    Object.assign(STATE, { running: true, startedAt: new Date(now()).toISOString(), finishedAt: null, lastOk: null, message: '', stage: 'screen', done: null, total: null });
    const child = spawn(process.execPath, [scanScript], { cwd, env: { ...env, INTEL_DEEP_N: String(deepN) }, stdio: ['ignore', 'pipe', 'pipe'] }); let tail = '';
    const grab = (c) => { tail = (tail + c.toString()).slice(-2000); const m = [...tail.matchAll(/(\d+)\/(\d+) (screened|deep)/g)].pop(); if (m) { STATE.done = Number(m[1]); STATE.total = Number(m[2]); STATE.stage = m[3] === 'deep' ? 'deep' : 'screen'; } };
    child.stdout.on('data', grab); child.stderr.on('data', grab);
    child.on('close', (code) => { Object.assign(STATE, { running: false, finishedAt: new Date(now()).toISOString(), lastOk: code === 0, message: (tail.trim().split('\n').pop() || `exit ${code}`).slice(0, 300) }); });
    child.on('error', (e) => Object.assign(STATE, { running: false, finishedAt: new Date(now()).toISOString(), lastOk: false, message: e.message }));
    res.json({ ok: true, started: true, deepN, state: STATE });
  });
  app.get('/api/intel/endpoints', requireAuth, (req, res) => {
    let probe = null; try { probe = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint-probe.json'), 'utf8')); } catch { /* no probe yet */ }
    res.json({ ok: true, probe, endpoints: Object.entries(INTEL_ENDPOINTS).map(([k, e]) => ({ key: k, verified: e.verified, expect: e.expect, status: probe && probe.results ? probe.results[k] || null : null })) });
  });
  return { dir, state: STATE };
}
