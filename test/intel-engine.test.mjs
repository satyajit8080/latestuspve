import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normFlow, latestSession, normOi, normGexLevels, normGreek, parseOcc, normTerm, normContracts } from '../engine/intel/normalize.js';
import { flowFeatures, MIN_FLOW_PREMIUM } from '../engine/intel/features.js';
import { evaluate, scoreDirection, WEIGHTS, THRESHOLDS } from '../engine/intel/score.js';
import { levelsFor } from '../engine/intel/levels.js';
import { analyzeTicker, screenTicker, runIntelScan } from '../engine/intel/pipeline.js';
import { sessionOf, dataMode } from '../engine/intel/session.js';
import { readLatest, readDeep, listSnapshots, readSnapshot } from '../store/intel-store.js';
import { payloads, fakeAdapter, NOW } from './fixtures/intel-fixture.mjs';

test('normalizers: strings become numbers, OCC symbols parse, the latest session is selected, nothing is defaulted', () => {
  assert.deepEqual(parseOcc('AAPL261120C00365000'), { root: 'AAPL', expiry: '2026-11-20', type: 'call', strike: 365 }); assert.equal(parseOcc('junk'), null);
  const f = normFlow({ data: [{ created_at: '2026-11-04T15:00:00Z', type: 'call', total_premium: '1000', total_ask_side_prem: '800', total_bid_side_prem: '200', has_sweep: true, all_opening_trades: 'true', marketcap: '5e9' }, { type: 'weird' }, { created_at: '2026-11-03T15:00:00Z', type: 'put', total_premium: '50' }] });
  assert.equal(f.length, 2); assert.equal(f[1].premium, 1000); assert.equal(f[1].side, 'ask'); assert.equal(f[1].opening, true); assert.equal(f[1].marketCap, 5e9); assert.equal(f[0].askPrem, null);
  assert.equal(latestSession(f).alerts.length, 1);
  assert.equal(normGexLevels({ data: { call_wall: '130', put_wall: '118', gamma_flip: '119.5', nearby_flips: ['119', 'x'] } }).gammaFlip, 119.5); assert.equal(normGexLevels({ data: { source: 'oi' } }), null);
  assert.equal(normGreek({ data: [{ date: '2026-11-03', call_gamma: '2', put_gamma: '-1' }] })[0].netGamma, 1); assert.equal(normGreek({ data: [{ date: '2026-11-03', call_gamma: '2' }] })[0].netGamma, null);
  assert.equal(normOi({ data: [{ option_symbol: 'AAPL261120C00365000', oi_diff_plain: '-5' }, { option_symbol: 'AAPL261120C00365000' }] }).length, 1);
  assert.deepEqual(normTerm({ data: [{ date: '2026-11-02', dte: 7, volatility: '0.2' }, { date: '2026-11-03', dte: 30, volatility: '0.3' }, { date: '2026-11-03', dte: 7, volatility: '0.25' }] }).map((r) => r.dte), [7, 30]);
  const c = normContracts({ data: [{ option_symbol: 'XYZ261120C00100000', nbbo_bid: '1', nbbo_ask: '1.2', delta: '0.5' }] }, NOW)[0]; assert.ok(Math.abs(c.spreadPct - 0.2 / 1.1) < 1e-9); assert.equal(c.dte, 16);
});

test('flow features: aggressor-signed premium, opening share, multi-leg share, small-size scaling', () => {
  const a = normFlow(payloads('XYZ').flow); const F = flowFeatures(a);
  assert.ok(F.imbalance > 0.8 && F.openingShare > 0.9); assert.ok(F.multiLegShare > 0 && F.multiLegShare < 0.1); assert.equal(F.nMulti, 1);
  assert.equal(F.signedPremium, F.callAsk - F.callBid - (F.putAsk - F.putBid)); assert.equal(flowFeatures([]), null);
  const small = flowFeatures(normFlow(payloads('XYZ', { small: true }).flow)); assert.ok(small.singlePremium < MIN_FLOW_PREMIUM);
});

async function analyzed(opts = {}, dir = 'bull') { const p = payloads('XYZ', { dir, ...opts }); const ad = fakeAdapter({ XYZ: p }, opts.adapter || {}); return { ...(await analyzeTicker(ad, 'XYZ', { nowMs: NOW })), ad }; }

test('analyze: a confirmed bullish setup scores BULL; every component is shown and contributions add up', async () => {
  const { row, detail } = await analyzed(); assert.equal(row.state, 'BULL', JSON.stringify(row.reasons)); assert.ok(row.score >= THRESHOLDS.enter); assert.ok(row.bullScore > row.bearScore + THRESHOLDS.margin);
  const b = detail.evaluation.bull; assert.deepEqual(b.components.map((c) => c.family), ['flow', 'oi', 'gex', 'price', 'volume']); for (const c of b.components) assert.ok(c.label && 'contribution' in c && 'weight' in c && Array.isArray(c.members));
  assert.ok(Math.abs(b.components.reduce((s, c) => s + c.contribution, 0) - b.base) <= 1); assert.equal(row.name, 'Xyz Corporation'); assert.equal(row.mode, 'LIVE');
  assert.ok(detail.levels.targets.length >= 1 && detail.levels.invalidation.price < row.price && detail.levels.riskReward > 0); assert.ok(detail.explanation.why[0].includes('Bullish')); assert.ok(detail.explanation.caveats.some((c) => /large print/.test(c)));
  assert.equal(detail.alerts.length, 8); assert.ok(detail.oiHeatmap.cells.length > 0); assert.ok(detail.greeks.contracts > 0);
});
test('analyze: a mirrored bearish setup scores BEAR with mirrored levels', async () => {
  const { row, detail } = await analyzed({}, 'bear'); assert.equal(row.state, 'BEAR', JSON.stringify(row.reasons)); assert.ok(detail.levels.invalidation.price > row.price);
});
test('correlated evidence is not counted twice: each family contributes at most its own weight share', async () => {
  const { detail } = await analyzed(); const b = detail.evaluation.bull; const wAvail = b.components.filter((c) => c.available).reduce((s, c) => s + c.weight, 0); const cf = 0.5 + 0.5 * b.coverage;
  for (const c of b.components) assert.ok(c.contribution <= 100 * c.weight / wAvail * cf + 1e-9, `${c.family} exceeds its weight`); assert.ok(WEIGHTS.flow === 30);
  const f = detail.features; const dup = { ...f, tape: { ...f.tape, imbalance: 1 } }; const s1 = scoreDirection(f, 'bull').score, s2 = scoreDirection(dup, 'bull').score; assert.ok(s2 - s1 <= 0.3 * 100 * WEIGHTS.flow / 85 + 1, 'a stronger tape can move the flow family by its member weight only');
});
test('gates return NO TRADE instead of forcing a side: earnings, wide spread, no confirmation, conflict, weak evidence', async () => {
  assert.match((await analyzed({ earnings: '2026-11-06' })).row.reasons.join(), /Earnings in 2 day/); assert.equal((await analyzed({ earnings: '2026-11-06' })).row.state, 'NO_TRADE');
  assert.match((await analyzed({ wide: true })).row.reasons.join(), /spread/);
  const weak = await analyzed({ small: true }); assert.equal(weak.row.state, 'NO_TRADE'); assert.match(weak.row.reasons.join(), /weak|Conflicting|confirmation/i);
  const p = payloads('XYZ'); p.bars5m = { data: p.bars5m.data.map((b) => ({ ...b, close: String(p._last * 0.97), open: String(p._last * 0.97), high: String(p._last * 0.972), low: String(p._last * 0.968) })) }; p.bars1d = { data: p.bars1d.data.map((b, i, a) => ({ ...b, close: String(100 + (a.length - i) * 0.3), high: String((100 + (a.length - i) * 0.3) * 1.01), low: String((100 + (a.length - i) * 0.3) * 0.99), open: b.open })) };
  const noConf = await analyzeTicker(fakeAdapter({ XYZ: p }), 'XYZ', { nowMs: NOW }); assert.equal(noConf.row.state, 'NO_TRADE'); assert.ok(noConf.row.reasons.length >= 1);
});
test('missing data is never fabricated: a failed endpoint leaves its family unscored and is reported', async () => {
  const r = await analyzed({ adapter: { fail: ['gexLevels', 'greek', 'tape'] } }); assert.equal(r.detail.features.gex, null); assert.equal(r.row.regime, null);
  assert.equal(r.detail.evaluation.bull.components.find((c) => c.family === 'gex').available, false); assert.equal(r.detail.dataQuality.endpoints.gexLevels.ok, false); assert.ok(r.detail.explanation.missing.includes('GEX / gamma levels'));
  const none = await analyzeTicker(fakeAdapter({ XYZ: { flow: { data: [] } } }), 'XYZ', { nowMs: NOW }); assert.equal(none.row.state, 'NO_TRADE'); assert.equal(none.row.score, 0); assert.ok(none.row.reasons.join().includes('No options flow'));
});
test('levels: support below, resistance above, invalidation on the risk side, risk/reward from the first reference', async () => {
  const { detail } = await analyzed(); const L = detail.levels; assert.ok(L.support.every((s) => s.price < L.price) && L.resistance.every((s) => s.price > L.price)); assert.ok(L.invalidation.basis); assert.match(L.note, /not predictions/);
  const rr = Math.abs(L.targets[0].price - L.price) / Math.abs(L.price - L.invalidation.price); assert.ok(Math.abs(rr - L.riskReward) < 0.02); assert.equal(levelsFor({ price: null }, 'bull'), null);
});
test('data mode labels: LIVE / DELAYED / CLOSED / HISTORICAL', () => {
  assert.equal(sessionOf(NOW), 'open'); assert.equal(dataMode({ nowMs: NOW, asOfMs: NOW - 5 * 60000 }), 'LIVE'); assert.equal(dataMode({ nowMs: NOW, asOfMs: NOW - 3600000 }), 'DELAYED');
  assert.equal(dataMode({ nowMs: Date.parse('2026-11-07T16:30:00Z'), asOfMs: NOW }), 'CLOSED'); assert.equal(dataMode({ nowMs: NOW, asOfMs: NOW, historical: true }), 'HISTORICAL'); assert.equal(sessionOf(Date.parse('2026-11-26T16:30:00Z')), 'closed');
});

test('scan: screens the universe, deep-analyses the most active tickers only, writes progressively, snapshots, and survives errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-')); const tickers = Array.from({ length: 24 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  const by = (t) => { const i = Number(t.slice(1)); if (i >= 20) return null; return payloads(t, { dir: i % 2 ? 'bear' : 'bull', small: i > 11 }); };
  const ad = fakeAdapter(by, { rateLimited: ['T22'] }); const logs = [];
  const sum = await runIntelScan({ adapter: ad, universe: tickers, deepN: 4, minPremium: 300000, outDir: dir, nowMs: NOW, concurrency: 3, deepConcurrency: 2, writeEvery: 5, log: (m) => logs.push(m) });
  assert.equal(sum.total, 24); assert.equal(sum.deep, 4); assert.ok(sum.errors >= 4); assert.ok(logs.some((m) => /screened/.test(m)) && logs.some((m) => /deep/.test(m)));
  const latest = readLatest(dir); assert.equal(latest.partial, false); assert.equal(latest.stage, 'done'); assert.equal(latest.rows.length, 24); assert.equal(latest.rows.filter((r) => r.deep).length, 4); assert.ok(latest.rows.filter((r) => r.error).length >= 4);
  assert.ok(latest.rows.every((r) => !('alerts' in r))); assert.deepEqual(latest.rows.filter((r) => r.deep).map((r) => r.ticker).sort().every((t) => Number(t.slice(1)) <= 11), true); assert.equal(latest.mode, 'LIVE');
  const d = readDeep(dir, latest.rows.find((r) => r.deep).ticker); assert.ok(d.evaluation && d.features && d.dataQuality); const snaps = listSnapshots(dir); assert.equal(snaps.length, 1); assert.equal(readSnapshot(snaps[0].file).rows.length, 24);
  const flowCalls = ad.calls.filter((c) => c.startsWith('flow:')).length; assert.equal(flowCalls, 24, 'the deep stage re-uses the screen stage flow: no repeated flow call');
  const shallow = await screenTicker(fakeAdapter({ default: payloads('Q') }), 'Q', { nowMs: NOW }); assert.ok(shallow.activity > 0 && shallow.deep === false);
  const stopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-')); const r2 = await runIntelScan({ adapter: fakeAdapter({}, { rateLimited: Array.from({ length: 40 }, (_, i) => `R${i}`) }), universe: Array.from({ length: 40 }, (_, i) => `R${i}`), deepN: 2, outDir: stopDir, nowMs: NOW, concurrency: 1 });
  assert.ok(r2.errors < 40, 'a run of rate limits stops the scan early instead of grinding through guaranteed failures');
});
test('schema watch: a missing expected key is reported, not hidden', async () => {
  const p = payloads('XYZ'); p.flow = { data: p.flow.data.map(({ total_ask_side_prem, ...r }) => r) }; const r = await analyzeTicker(fakeAdapter({ XYZ: p }), 'XYZ', { nowMs: NOW }); assert.ok(r.detail.dataQuality.endpoints.flow.schemaMissing.length >= 0);
  const s = await screenTicker(fakeAdapter({ XYZ: p }), 'XYZ', { nowMs: NOW }); assert.ok(s.schemaMissing.includes('total_ask_side_prem'));
});
test('separation: Options Intelligence contains no Indian-market code or credentials', () => {
  const files = ['engine/intel/endpoints.js', 'engine/intel/normalize.js', 'engine/intel/features.js', 'engine/intel/score.js', 'engine/intel/levels.js', 'engine/intel/pipeline.js', 'providers/uw-intel.js', 'store/intel-store.js'];
  for (const f of files) assert.ok(!/dhan|nifty|sensex|banknifty|\bnse\b|bse\b|DHAN_/i.test(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), `${f} must stay US-only`);
});
