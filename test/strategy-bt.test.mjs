import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStrategy, simulate, backtest, StrategyBook, PRESETS, strategyId } from '../research/strategy-bt.js';

function panel(T = 40, D = 120, signalEdge = 0.01) {
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const dates = Array.from({ length: D }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)); const cols = new Map(); const x = new Float64Array(T * D), y1 = new Float64Array(T * D).fill(NaN), y3 = new Float64Array(T * D).fill(NaN);
  for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) { const s = rnd(); x[t * D + d] = s; if (d + 1 < D) y1[t * D + d] = s * signalEdge + rnd() * 0.01; if (d + 3 < D) y3[t * D + d] = s * signalEdge + rnd() * 0.01; }
  cols.set('mom5', x); cols.set('ret20', new Float64Array(T * D).fill(0.02)); cols.set('rv20', Float64Array.from({ length: T * D }, (_, i) => 0.2 + (i % 7) * 0.01));
  return { T, D, dates, cols, y: { 1: y1, 3: y3, 5: y3 }, tickers: Array.from({ length: T }, (_, i) => `T${i}`), mom1: new Float64Array(T * D) };
}
const strat = { name: 't', horizon: 1, side: 'both', topPct: 20, costBps: 0, signal: { col: 'mom5' } };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-'));

test('validateStrategy rejects bad input and unknown columns', () => {
  assert.throws(() => validateStrategy({ ...strat, horizon: 2 }), /horizon/);
  assert.throws(() => validateStrategy({ ...strat, topPct: 90 }), /topPct/);
  assert.throws(() => validateStrategy({ ...strat, signal: { col: 'nope' } }));
  assert.equal(validateStrategy(strat).costBps, 0);
});
test('a real edge shows positive net return; no edge is not hugely positive', () => {
  const good = simulate(panel(40, 120, 0.05), validateStrategy(strat), { start: 0, end: 119 }); assert.ok(good.stats.avgReturn > 0.005 && good.stats.winRate > 0.7);
  const none = simulate(panel(40, 120, 0), validateStrategy(strat), { start: 0, end: 119 }); assert.ok(Math.abs(none.stats.avgReturn) < 0.004);
});
test('costs reduce returns exactly by round trip', () => {
  const P = panel(40, 120, 0.05); const a = simulate(P, validateStrategy(strat), { start: 0, end: 119 }); const b = simulate(P, validateStrategy({ ...strat, costBps: 10 }), { start: 0, end: 119 });
  assert.ok(Math.abs((a.stats.avgReturn - b.stats.avgReturn) - 0.002) < 1e-9);
});
test('metrics are internally consistent and regimes reported', () => {
  const r = simulate(panel(), validateStrategy(strat), { start: 0, end: 119 }); assert.ok(r.stats.maxDrawdown >= 0 && r.stats.maxDrawdown <= 1); assert.ok(r.regimes['trend:up'].n === r.stats.n);
});
test('OOS opens once per strategy, only after train+validation net-positive', () => {
  const P = panel(40, 120, 0.05); const splits = { explore: { start: 0, end: 49 }, validate: { start: 50, end: 84 }, vault: { start: 85, end: 119 } }; const book = new StrategyBook(dir());
  const a = backtest({ P, splits, book, raw: strat }); assert.equal(a.oosState, 'sealed'); assert.equal(a.oos, null);
  const b = backtest({ P, splits, book, raw: strat, confirmOos: true }); assert.equal(b.oosState, 'opened'); assert.ok(b.oos.stats.n > 0);
  const c = backtest({ P, splits, book, raw: strat }); assert.equal(c.oosState, 'opened'); assert.deepEqual(c.oos, b.oos);
  const bad = panel(40, 120, -0.05); const d = backtest({ P: bad, splits, book: new StrategyBook(dir()), raw: strat, confirmOos: true }); assert.equal(d.oosState, 'refused'); assert.equal(d.oos, null);
});
test('presets all validate; ids are stable', () => {
  for (const p of PRESETS) assert.doesNotThrow(() => validateStrategy({ ...p, costBps: 10 }), p.key);
  assert.equal(strategyId(validateStrategy(strat)), strategyId(validateStrategy({ ...strat })));
});
