import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradingDays, etDayBounds } from '../research/backfill.js';
import { ranks, spearman, normInv, alertFeatures, tapeFeatures, oiFeatures, buildFeatures, readFeatures, loadPrices, attachLabels, normalize, evaluate } from '../research/backtest.js';

test('stats: average ranks, spearman, normal quantile', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) + 1) < 1e-12);
  assert.ok(Math.abs(normInv(0.975) - 1.95996) < 1e-3);
});

test('alertFeatures: signs, single-leg filter, opening, delta weighting, 15:30 cutoff', () => {
  const [mid] = etDayBounds('2026-11-03'); const cut = Date.parse(mid) + 15.5 * 3600000;
  const at = (min) => new Date(Date.parse(mid) + min * 60000).toISOString();
  const rows = [
    { type: 'call', total_ask_side_prem: '100', total_bid_side_prem: '0', total_premium: '100', delta: '0.5', has_multileg: false, all_opening_trades: true, created_at: at(600) },
    { type: 'put', total_ask_side_prem: '40', total_bid_side_prem: '0', total_premium: '40', delta: '-0.4', has_multileg: false, all_opening_trades: false, created_at: at(700) },
    { type: 'call', total_ask_side_prem: '70', total_bid_side_prem: '0', total_premium: '70', delta: '0.5', has_multileg: true, created_at: at(800) },
    { type: 'call', total_ask_side_prem: '999', total_bid_side_prem: '0', total_premium: '999', delta: '0.5', has_multileg: false, created_at: at(16 * 60) },   // after 15:30 ET
  ];
  const f = alertFeatures(rows, cut);
  assert.equal(f.nAlerts, 3); assert.equal(f.alertRaw, 100 - 40 + 70); assert.equal(f.alertSingle, 100 - 40);
  assert.equal(f.alertOpen, 100); assert.ok(Math.abs(f.alertDelta - (100 * 0.5 - 40 * 0.4)) < 1e-9);
  assert.equal(f.grossSigned, 100 - 40 + 70); assert.equal(f.grossAbs, 210);
  assert.equal(alertFeatures([], cut), null);
});

test('tapeFeatures and oiFeatures', () => {
  const [mid] = etDayBounds('2026-11-03'); const at = (min) => new Date(Date.parse(mid) + min * 60000).toISOString(); const cut = Date.parse(mid) + 15.5 * 3600000;
  const t = tapeFeatures([{ timestamp: at(600), net_call_premium: '10', net_put_premium: '4', net_delta: '2' }, { timestamp: at(660), net_call_premium: '5', net_put_premium: '1', net_delta: '3' }, { timestamp: at(17 * 60), net_call_premium: '999', net_put_premium: '0', net_delta: '99' }], cut);
  assert.equal(t.tapeNetPremSum, 6 + 4); assert.equal(t.tapeNetPremLast, 4); assert.equal(t.tapeDeltaSum, 5); assert.equal(t.tapeDeltaLast, 3);
  const o = oiFeatures([{ option_symbol: 'AAPL261120C00365000', oi_diff_plain: '300', avg_price: '1.5' }, { option_symbol: 'AAPL261120P00350000', oi_diff_plain: '-100', avg_price: '2' }, { option_symbol: 'junk', oi_diff_plain: '5' }]);
  assert.ok(Math.abs(o.oiImb - (300 - -100) / 400) < 1e-12); assert.equal(o.oiAbs, 400); assert.ok(Math.abs(o.oiNetPrem - (300 * 1.5 * 100 + -1 * -100 * 2 * 100)) < 1e-6);
});

// ---- end to end on synthetic files: a planted forward signal is found, a past-only signal and noise are not -------------
function synth({ planted }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')); let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };
  const dates = tradingDays('2026-01-05', '2026-04-24').reverse(); const tickers = Array.from({ length: 40 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  for (const t of tickers) {
    const X = dates.map(() => gauss()); let px = 100; const closes = [];
    for (let i = 0; i < dates.length; i++) {
      closes.push(px);
      const feat = planted === 'forward' ? X[i] : 0;               // return D -> D+1 depends on today's feature
      const past = planted === 'past' ? X[i + 1] ?? 0 : 0;         // return D -> D+1 depends on TOMORROW's feature (feature observed after the move)
      px *= 1 + 0.01 * feat + 0.01 * past + 0.004 * gauss();
    }
    fs.mkdirSync(path.join(dir, 'ohlc1d', t), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ohlc1d', t, 'series.json'), JSON.stringify({ meta: {}, data: { data: dates.map((d, i) => ({ date: d, close: String(closes[i]) })) } }));
    fs.mkdirSync(path.join(dir, 'flow', t), { recursive: true });
    dates.forEach((d, i) => {
      const x = X[i]; const [mid] = etDayBounds(d);
      const a = { type: x >= 0 ? 'call' : 'put', total_ask_side_prem: String(Math.abs(x) * 1e5 + 1), total_bid_side_prem: '0', total_premium: String(Math.abs(x) * 1e5 + 1), has_multileg: false, delta: '0.5', created_at: new Date(Date.parse(mid) + 10 * 3600000).toISOString() };
      fs.writeFileSync(path.join(dir, 'flow', t, `${d}.json`), JSON.stringify({ meta: {}, data: { data: [a] } }));
    });
  }
  return { dir, dates, tickers };
}
function run({ planted }) {
  const { dir, dates, tickers } = synth({ planted }); const out = path.join(dir, 'features.csv');
  buildFeatures({ dir, tickers, dates: dates.slice().reverse(), out });
  const rows = readFeatures(out); const labelled = attachLabels(rows, loadPrices(dir, tickers), [1, 3]); normalize(labelled);
  return evaluate({ rows: labelled, horizons: [1, 3], minNames: 30 });
}

test('end to end: a planted FORWARD signal is detected; random baseline is ~0', () => {
  const rep = run({ planted: 'forward' }); const get = (f, h) => rep.results.find((r) => r.feature === f && r.h === h);
  assert.ok(get('alertSingle', 1).meanIC > 0.4, `IC ${get('alertSingle', 1).meanIC}`); assert.ok(get('alertSingle', 1).tNonOverlap > 5);
  assert.ok(Math.abs(get('random', 1).meanIC) < 0.1, `random IC ${get('random', 1).meanIC}`);
  assert.ok(get('alertSingle', 1).spreadBps > 0);
});

test('end to end: a signal that only explains the PAST move has no forward IC (no look-ahead)', () => {
  const rep = run({ planted: 'past' }); const r = rep.results.find((x) => x.feature === 'alertSingle' && x.h === 1);
  assert.ok(Math.abs(r.meanIC) < 0.15, `forward IC should be ~0, got ${r.meanIC}`);
});

import { compareDailyToBars } from '../research/backtest.js';
test('compareDailyToBars: detects a daily series that is shifted one day vs the 5-minute bars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')); const dates = tradingDays('2026-03-02', '2026-03-27').reverse(); const T = 'AAA';
  const closes = dates.map((_, i) => 100 + i * 2);                       // distinct closes per day (bars truth)
  const shifted = (shift) => dates.map((d, i) => ({ date: d, close: String(closes[Math.min(dates.length - 1, Math.max(0, i + shift))]) }));
  fs.mkdirSync(path.join(dir, 'bars5m', T), { recursive: true });
  dates.forEach((d, i) => { const [mid] = etDayBounds(d); const end = new Date(Date.parse(mid) + 16 * 3600000).toISOString(); fs.writeFileSync(path.join(dir, 'bars5m', T, `${d}.json`), JSON.stringify({ meta: {}, data: { data: [{ end_time: end, close: String(closes[i]), market_time: 'r' }, { end_time: new Date(Date.parse(mid) + 20 * 3600000).toISOString(), close: '999', market_time: 'po' }] } })); });
  const write = (rows) => { fs.mkdirSync(path.join(dir, 'ohlc1d', T), { recursive: true }); fs.writeFileSync(path.join(dir, 'ohlc1d', T, 'series.json'), JSON.stringify({ meta: {}, data: { data: rows } })); };
  write(shifted(0)); let r = compareDailyToBars({ dir, tickers: [T] }); assert.equal(r.same, r.compared); assert.ok(r.compared >= 8);
  write(shifted(-1)); r = compareDailyToBars({ dir, tickers: [T] }); assert.ok(r.prevDay >= r.compared - 1, JSON.stringify(r));
  write(shifted(1)); r = compareDailyToBars({ dir, tickers: [T] }); assert.ok(r.nextDay >= r.compared - 1, JSON.stringify(r));
});
