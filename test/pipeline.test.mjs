// One pipeline for server + scan; AI/read-only calls have no research side effects; concurrent builds coalesce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
process.env.SIGNAL_LOG_DIR = path.join(TMP, 'journal');
const BASE_DIR = path.join(TMP, 'baselines');

const { UnusualWhalesOptionsProvider } = await import('../providers/unusualwhales.js');
const { createPipelineContext, computeTickerSignal } = await import('../engine/pipeline.js');
const { BaselineStore } = await import('../store/normalize.js');
const { computeRow } = await import('../research/scan-universe.js');

const J = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o });
const calls = {};
let flowCreatedAt = () => new Date().toISOString();
let infoData = () => ({ next_earnings_date: '2099-01-01', sector: 'Technology' });
const exp = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '').slice(2);
const sym = (cp, k) => `AAPL${exp}${cp}${String(k * 1000).padStart(8, '0')}`;
function route(s) {
  const k = s.replace(/^https?:\/\/[^/]+/, '').split('?')[0]; calls[k] = (calls[k] || 0) + 1;
  if (s.includes('/stock-state')) return J({ data: { close: '218', prev_close: '200', volume: '5000000' } });
  if (s.includes('/option-contracts')) return J({ data: [
    { option_symbol: sym('C', 200), volume: 90000, open_interest: 4000, implied_volatility: 0.45, delta: 0.55, gamma: 0.05, nbbo_bid: 5, nbbo_ask: 5.2 },
    { option_symbol: sym('P', 200), volume: 1200, open_interest: 4000, implied_volatility: 0.42, delta: -0.45, gamma: 0.04, nbbo_bid: 2, nbbo_ask: 2.2 },
    { option_symbol: sym('C', 210), volume: 80000, open_interest: 3000, implied_volatility: 0.44, delta: 0.5, gamma: 0.05, nbbo_bid: 3, nbbo_ask: 3.2 },
    { option_symbol: sym('P', 190), volume: 900, open_interest: 3000, implied_volatility: 0.46, delta: -0.3, gamma: 0.03, nbbo_bid: 1, nbbo_ask: 1.2 },
  ] });
  if (s.includes('/flow-alerts')) return J({ data: [{ type: 'call', total_premium: '400000', total_ask_side_prem: '380000', total_bid_side_prem: '20000', total_size: 50, expiry: '2099-01-01', option_chain: sym('C', 210), created_at: flowCreatedAt() }] });
  if (s.includes('/oi-change')) return J({ data: [{ option_symbol: sym('C', 200), curr_oi: 6000, prev_oi: 4000 }, { option_symbol: sym('P', 200), curr_oi: 4100, prev_oi: 4000 }] });
  if (s.includes('/greek-exposure/strike')) return J({ data: [{ strike: '200', call_gex: '5e8', put_gex: '-2e8', date: '2026-08-24' }, { strike: '210', call_gex: '1e8', put_gex: '-6e8', date: '2026-08-24' }] });
  if (s.includes('/greek-exposure')) return J({ data: [{ call_gamma: '3e8', put_gamma: '-1e8', date: '2026-08-24' }] });
  if (s.includes('/iv-rank')) return J({ data: [{ iv_rank_1y: '55', volatility: '0.4' }] });
  if (s.includes('/info')) return J({ data: infoData() });
  if (s.includes('/ohlc/5m')) return J({ data: Array.from({ length: 12 }, (_, i) => ({ start_time: new Date(Date.UTC(2026, 7, 24, 13, 30 + i * 5)).toISOString(), open: 208, high: 211, low: 207, close: 209 + (i % 3), volume: 100000 })) });
  if (s.includes('/ohlc')) return J({ data: Array.from({ length: 20 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, open: 200, high: 205 + i, low: 198 + i, close: 200 + i, volume: 1e6 })) });
  return J({ data: [] });
}
const real = globalThis.fetch;
globalThis.fetch = async (u) => route(String(u));
const P = () => new UnusualWhalesOptionsProvider({ apiKey: 'k' });
const mkCtx = (name) => createPipelineContext(P(), { baselines: new BaselineStore(path.join(BASE_DIR, name)) });
const strip = (sig) => { const c = JSON.parse(JSON.stringify(sig)); delete c.asOf; return c; };

test('parity: two independent contexts (server-like, scan-like) give identical production + v2 output', async () => {
  const a = await computeTickerSignal(P(), 'AAPL', mkCtx('a'), { sideEffects: false });
  const b = await computeTickerSignal(P(), 'AAPL', mkCtx('b'), { sideEffects: false });
  assert.equal(a.ok, true);
  assert.deepEqual(strip(a.signal), strip(b.signal));
  assert.deepEqual(a.v2 && a.v2.score, b.v2 && b.v2.score);
});

test('parity: scan computeRow and the server pipeline agree on the same payload', async () => {
  const sctx = mkCtx('scan'); const vctx = mkCtx('srv');
  const row = await computeRow(P(), 'AAPL', { sectorMap: {}, ctx: sctx, gap: 0 });
  const srv = await computeTickerSignal(P(), 'AAPL', vctx, {});
  assert.equal(row.productionScore, srv.signal.finalScore);
  assert.equal(row.dir, srv.signal.dir);
  assert.equal(row.v2Score, srv.v2 && srv.v2.available ? srv.v2.score : null);
  assert.equal(row.tier, srv.signal.tier);
});

test('oiChange uses UW daily /oi-change directly and is stable across polls', async () => {
  const ctx = mkCtx('oi');
  const s1 = await computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false });
  const s2 = await computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false });
  const f = (r) => r.signal.features.find((x) => x.key === 'oiChange');
  assert.equal(f(s1).avail, 1);
  assert.equal(f(s1).value, f(s2).value);
  assert.ok(f(s1).value > 0);
});

test('daily-static endpoints are fetched once per ET day per context', async () => {
  const ctx = mkCtx('daily'); for (const k of Object.keys(calls)) delete calls[k];
  await computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false });
  await computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false });
  assert.equal(calls['/api/stock/AAPL/oi-change'], 1);
  assert.equal(calls['/api/stock/AAPL/greek-exposure'], 1);
  assert.equal(calls['/api/stock/AAPL/stock-state'], 2);          // one per chain build (no duplicate getUnderlying)
});

test('sideEffects:false leaves journal, baselines and state byte-identical', async () => {
  const ctx = mkCtx('ro');
  const snap = () => ({
    journal: fs.existsSync(process.env.SIGNAL_LOG_DIR) ? fs.readdirSync(process.env.SIGNAL_LOG_DIR).map((f) => f + fs.readFileSync(path.join(process.env.SIGNAL_LOG_DIR, f), 'utf8')) : [],
    base: fs.existsSync(path.join(BASE_DIR, 'ro')) ? fs.readdirSync(path.join(BASE_DIR, 'ro')).map((f) => fs.readFileSync(path.join(BASE_DIR, 'ro', f), 'utf8')) : [],
    state: JSON.stringify([...ctx.v2State]), prev: JSON.stringify([...ctx.v2PrevFlow]), iv: JSON.stringify([...ctx.ivSkew.prev]), rd: ctx.readiness.size,
  });
  const before = snap();
  await computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false });
  assert.deepEqual(snap(), before);
});

test('sideEffects:true records baselines, state and readiness for that ticker only', async () => {
  const ctx = mkCtx('rw');
  const r = await computeTickerSignal(P(), 'AAPL', ctx, {});
  assert.ok(ctx.baselines.stats().observations > 0);
  assert.ok(ctx.readiness.has('AAPL'));
  assert.equal(ctx.readiness.has('MSFT'), false);
  // every non-neutral signal is journaled (no 70+ write filter), so the read-only test below is not vacuous
  assert.notEqual(r.signal.dir, 'neutral', 'fixture must be directional so the journal row is written');
  assert.ok(fs.readdirSync(process.env.SIGNAL_LOG_DIR).length > 0, 'side-effecting build must journal');
});

test('concurrent identical builds coalesce into one run; read-only joins a side-effecting build', async () => {
  const ctx = mkCtx('co'); for (const k of Object.keys(calls)) delete calls[k];
  const [a, b, c] = await Promise.all([computeTickerSignal(P(), 'AAPL', ctx, {}), computeTickerSignal(P(), 'AAPL', ctx, {}), computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false })]);
  assert.equal(a, b); assert.equal(a, c);
  assert.equal(calls['/api/stock/AAPL/option-contracts'], 1);
});

test('v2 flow input is the CURRENT ET session only: yesterday\'s alerts do not count', async () => {
  flowCreatedAt = () => new Date(Date.now() - 2 * 86400000).toISOString();
  try {
    const r = await computeTickerSignal(P(), 'AAPL', mkCtx('old'), { sideEffects: false });
    assert.equal(r.ok, true);
    assert.ok(r.v2 && r.v2.available === false);              // no same-session flow => no primary flow evidence
  } finally { flowCreatedAt = () => new Date().toISOString(); }
  const fresh = await computeTickerSignal(P(), 'AAPL', mkCtx('new'), { sideEffects: false });
  assert.equal(fresh.v2.available, true);
});

test('earnings gate through the real provider shape: earnings today => published score 0, rawScore kept, journaled gated', async () => {
  const { etDate } = await import('../lib/time.js');
  infoData = () => ({ next_earnings_date: etDate(Date.now()), sector: 'Technology' });
  try {
    const r = await computeTickerSignal(P(), 'GOOG', mkCtx('earn'), {});
    assert.equal(r.signal.gated, true); assert.equal(r.signal.finalScore, 0); assert.ok(r.signal.rawScore > 0);
    const rows = fs.readdirSync(process.env.SIGNAL_LOG_DIR).filter((f) => f.startsWith('signal-log-')).flatMap((f) => fs.readFileSync(path.join(process.env.SIGNAL_LOG_DIR, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    const row = rows.filter((x) => x.composite && x.composite.gated === true).pop();
    assert.ok(row, 'a gated row is still journaled'); assert.equal(row.composite.finalScore, 0); assert.ok(row.composite.rawScore > 0); assert.ok(row.composite.gateReasons.includes('EARNINGS'));
  } finally { infoData = () => ({ next_earnings_date: '2099-01-01', sector: 'Technology' }); }
});

test('journal row carries the frozen legacy score on the same inputs, and max pain only as display', async () => {
  const ctx = mkCtx('legacy');
  const r = await computeTickerSignal(P(), 'MSFT', ctx, {});
  assert.ok(r.ok);
  const rows = fs.readdirSync(process.env.SIGNAL_LOG_DIR).filter((f) => f.startsWith('signal-log-')).flatMap((f) => fs.readFileSync(path.join(process.env.SIGNAL_LOG_DIR, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const row = rows.filter((x) => x.ticker === 'MSFT').pop();
  assert.ok(row && row.legacy, 'legacy block present');
  assert.equal(row.legacy.version, 'opt-1.1.1'); assert.ok(Number.isFinite(row.legacy.finalScore));
  assert.equal(row.composite.optionsEngineVersion, 'opt-1.2.0');
  assert.equal('maxPain' in row.scored, false);                       // scored bucket never carries max pain
  assert.ok('maxPain' in row.displayedNotScored);
});

test('with 10+ prior sessions of baseline, cpVolumeZ becomes available; with fewer it stays unavailable', async () => {
  const young = mkCtx('young');
  const a = await computeTickerSignal(P(), 'AAPL', young, { sideEffects: false });
  assert.equal(a.signal.features.find((f) => f.key === 'cpVolumeZ').avail, 0);
  const old = mkCtx('old');
  // same ET wall-clock time on 12 earlier days (so DST changes cannot move the observations into another time bucket)
  const { etMinutes } = await import('../lib/time.js');
  const sameWallTime = (daysAgo) => { const base = Date.now(); const t = base - daysAgo * 86400000; let diff = etMinutes(base) - etMinutes(t); if (diff > 720) diff -= 1440; if (diff < -720) diff += 1440; return new Date(t + diff * 60000).toISOString(); };
  for (let d = 1; d <= 12; d++) {
    const at = sameWallTime(d);
    await old.baselines.record('AAPL', 'cpVolumeLog', 0.8 + (d % 3) * 0.2, at);
    await old.baselines.record('AAPL', 'signedPremium', 1e5 * (d % 4), at);
    await old.baselines.record('AAPL', 'grossPremium', 1e6, at);
    await old.baselines.record('AAPL', 'oiChangePct', 0.01 * (d % 3), at);
  }
  const b = await computeTickerSignal(P(), 'AAPL', old, { sideEffects: false });
  const f = b.signal.features.find((x) => x.key === 'cpVolumeZ');
  assert.equal(f.avail, 1); assert.match(f.note, /z=/);
  assert.equal(b.signal.features.find((x) => x.key === 'signedPremium').note.includes('raw'), false);   // normalised, not raw
});

test('read-only builds never write baselines even when computing z-scores', async () => {
  const ctx = mkCtx('ro2');
  const before = ctx.baselines.stats().observations;
  await computeTickerSignal(P(), 'AAPL', ctx, { sideEffects: false });
  assert.equal(ctx.baselines.stats().observations, before);
});

test.after(() => { globalThis.fetch = real; });

test('server refuses single-ticker UW calls while a scan is running', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /function scanBusy/);
  assert.match(src, /scanBusy\(res\)\) return;[\s\S]*?buildTickerSignal\(ticker\)/);
  assert.ok(/computeTickerSignal/.test(fs.readFileSync(path.join(import.meta.dirname, '..', 'research', 'scan-universe.js'), 'utf8')), 'scan uses the shared pipeline');
});
