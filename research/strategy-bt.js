// research/strategy-bt.js — rule-based strategy backtests on the lab panel. Signal at the close of day D uses data <= D; entry = close D,
// exit = close D+h; positions rebalance every h days (no overlap); costs are charged per round trip. Blocks: train=explore, validation=validate,
// oos=vault. Out-of-sample can be looked at ONCE per strategy. Pure functions: nothing here touches the network.
import fs from 'node:fs';
import path from 'node:path';
import { validateNode, evalExpr, exprToString, specId, HORIZONS } from './lab.js';
import { mean, sd } from './backtest.js';

const fin = Number.isFinite;
export const BLOCKS = { train: 'explore', validation: 'validate', oos: 'vault' };
const C = (col) => ({ col }); const K = (v) => ({ const: v }); const op = (o, ...args) => ({ op: o, args });
const P_ = (o, p, ...args) => ({ op: o, p, args });

export const PRESETS = [
  { key: 'flow_imbalance', name: 'Flow imbalance', note: 'Long the strongest net call-over-put opening flow, short the weakest.', signal: P_('zts', 20, op('div', C('alertOpen'), op('add', C('grossAbs'), K(1)))) , horizon: 3, side: 'both', topPct: 10 },
  { key: 'oi_confirm', name: 'OI confirmation', note: 'Opening flow direction that the next-morning open-interest change agrees with.', signal: op('mul', op('sign', C('alertOpen')), C('oiImb')), horizon: 3, side: 'both', topPct: 10 },
  { key: 'gex_negative_rvol', name: 'Negative gamma + RVOL', note: 'Long names with net-negative gamma and a volume surge (long only).', signal: C('rvol'), filter: op('lt', C('gexNet'), K(0)), horizon: 3, side: 'long', topPct: 10 },
  { key: 'breakout_flow', name: 'Breakout + bullish flow', note: '20-day breakout confirmed by positive opening flow.', signal: op('mul', C('brk20'), op('sign', C('alertOpen'))), filter: op('gt', C('rvol'), K(1.2)), horizon: 5, side: 'long', topPct: 10 },
  { key: 'reversal_1d', name: '1-day reversal', note: 'Fade yesterday’s move (the effect the earlier backtest found).', signal: op('neg', C('mom1')), horizon: 1, side: 'both', topPct: 10 },
  { key: 'low_vol_flow', name: 'Calm stock, heavy flow', note: 'Large unusual-flow premium on low realized-vol names.', signal: op('mul', op('sign', C('alertOpen')), op('div', op('slog', C('grossAbs')), op('add', C('rv20'), K(0.05)))), horizon: 5, side: 'both', topPct: 10 },
];

export function validateStrategy(s) {
  if (!s || typeof s !== 'object') throw new Error('strategy must be an object');
  const name = String(s.name || '').trim().slice(0, 80); if (!name) throw new Error('name required');
  if (!HORIZONS.includes(s.horizon)) throw new Error('horizon must be 1, 3 or 5');
  const side = ['long', 'short', 'both'].includes(s.side) ? s.side : 'both';
  const topPct = Number(s.topPct); if (!(topPct >= 2 && topPct <= 50)) throw new Error('topPct must be between 2 and 50');
  const costBps = s.costBps == null ? 10 : Number(s.costBps); if (!(costBps >= 0 && costBps <= 200)) throw new Error('costBps must be 0..200');
  const out = { name, horizon: s.horizon, side, topPct, costBps, signal: validateNode(s.signal) }; if (s.filter != null) out.filter = validateNode(s.filter);
  return out;
}
export const strategyId = (s) => specId({ expr: { signal: s.signal, side: s.side, topPct: s.topPct, costBps: s.costBps }, filter: s.filter, horizon: s.horizon });

function periodStats(rets, h) {
  const n = rets.length; if (!n) return { n: 0 };
  const wins = rets.filter((r) => r > 0), losses = rets.filter((r) => r < 0); const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  let eq = 1, peak = 1, mdd = 0; const curve = [1]; for (const r of rets) { eq *= 1 + r; curve.push(eq); peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak); }
  const m = mean(rets), s = sd(rets);
  return { n, winRate: wins.length / n, avgReturn: m, expectancy: m, profitFactor: gl > 0 ? gw / gl : gw > 0 ? null : 0, maxDrawdown: mdd, sharpe: s ? (m / s) * Math.sqrt(252 / h) : null, totalReturn: eq - 1, curve };
}
const tercile = (vals, v) => { const s = vals.slice().sort((a, b) => a - b); const lo = s[Math.floor(s.length / 3)], hi = s[Math.floor((2 * s.length) / 3)]; return v <= lo ? 'low' : v >= hi ? 'high' : 'mid'; };

export function runStrategy(P, strat, blockName, { minNames = 30 } = {}) {
  const block = BLOCKS[blockName] ? blockName : null; if (!block) throw new Error('block must be train, validation or oos');
  return { block, ...simulate(P, strat, P.blockRange[BLOCKS[blockName]]) };
}
export function simulate(P, strat, range, { minNames = 30 } = {}) {
  const h = strat.horizon, x = evalExpr(strat.signal, P), f = strat.filter ? evalExpr(strat.filter, P) : null, y = P.y[h]; const trades = [];
  const ret20 = P.cols.get('ret20'), rv20 = P.cols.get('rv20');
  for (let d = range.start; d + h <= range.end; d += h) {
    const pool = []; for (let t = 0; t < P.T; t++) { const i = t * P.D + d; if (f && f[i] !== 1) continue; if (fin(x[i]) && fin(y[i])) pool.push({ s: x[i], r: y[i], t }); }
    if (pool.length < minNames) continue; pool.sort((a, b) => b.s - a.s); const k = Math.max(1, Math.round(pool.length * strat.topPct / 100));
    const longs = pool.slice(0, k), shorts = pool.slice(-k); const legs = [];
    if (strat.side !== 'short') legs.push(mean(longs.map((q) => q.r))); if (strat.side !== 'long') legs.push(-mean(shorts.map((q) => q.r)));
    const gross = mean(legs); const turnoverLegs = legs.length; const cost = strat.costBps * 2 / 1e4;   // costBps is per side; a round trip pays it twice
    let mk = null, vv = null; if (ret20 && rv20) { const r = [], v = []; for (let t = 0; t < P.T; t++) { const a = ret20[t * P.D + d], b = rv20[t * P.D + d]; if (fin(a)) r.push(a); if (fin(b)) v.push(b); } if (r.length > 20) mk = mean(r); if (v.length > 20) vv = mean(v); }
    trades.push({ d, date: P.dates[d], gross, net: gross - cost, n: pool.length, mk, vv });
  }
  const rets = trades.map((q) => q.net); const all = periodStats(rets, h); const grossStats = periodStats(trades.map((q) => q.gross), h);
  const vols = trades.map((q) => q.vv).filter((v) => v != null); const byRegime = {};
  for (const q of trades) { const tr = q.mk == null ? null : q.mk > 0.01 ? 'up' : q.mk < -0.01 ? 'down' : 'flat'; const vl = q.vv == null || vols.length < 9 ? null : tercile(vols, q.vv); for (const [dim, key] of [['trend', tr], ['vol', vl]]) { if (!key) continue; const g = `${dim}:${key}`; (byRegime[g] ||= []).push(q.net); } }
  const regimes = Object.fromEntries(Object.entries(byRegime).map(([k, v]) => { const s = periodStats(v, h); delete s.curve; return [k, s]; }));
  const { curve, ...core } = all; const { curve: _c, ...gcore } = grossStats;
  return { stats: core, grossAvg: gcore.avgReturn ?? null, costBps: strat.costBps, curve: (curve || []).filter((_, i) => i % Math.max(1, Math.ceil((curve || []).length / 120)) === 0), curveDates: trades.map((q) => q.date), regimes, nPeriods: trades.length };
}

export class StrategyBook {
  constructor(dir) { this.file = path.join(dir, 'strategy-ledger.jsonl'); fs.mkdirSync(dir, { recursive: true }); }
  all() { try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
  oosDone(id) { return this.all().find((e) => e.id === id && e.block === 'oos') || null; }
  append(e) { fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); }
  trials() { return new Set(this.all().filter((e) => e.block === 'train').map((e) => e.id)).size; }
}

// one call: train + validation always; OOS only on explicit confirm, once per strategy, and only after train+validation both net-positive.
export function backtest({ P, splits, book, raw, confirmOos = false }) {
  const strat = validateStrategy(raw); const id = strategyId(strat); P.blockRange = splits;
  const train = runStrategy(P, strat, 'train'); const validation = runStrategy(P, strat, 'validation');
  book.append({ id, block: 'train', name: strat.name, avg: train.stats.avgReturn }); book.append({ id, block: 'validation', name: strat.name, avg: validation.stats.avgReturn });
  const out = { id, strategy: { ...strat, signal: exprToString(strat.signal), filter: strat.filter ? exprToString(strat.filter) : null }, train, validation, oos: null, oosState: 'sealed', trials: book.trials(), notes: [] };
  const done = book.oosDone(id);
  if (done) { out.oos = done.result; out.oosState = 'opened'; out.oosOpenedAt = done.ts; out.notes.push('Out-of-sample was already opened for this exact strategy; the stored result is shown.'); }
  else if (confirmOos) {
    if (!(train.stats.avgReturn > 0 && validation.stats.avgReturn > 0)) { out.oosState = 'refused'; out.notes.push('Out-of-sample not opened: the strategy must be net-positive in train and validation first.'); }
    else { const oos = runStrategy(P, strat, 'oos'); book.append({ id, block: 'oos', name: strat.name, result: oos }); out.oos = oos; out.oosState = 'opened'; }
  }
  if (train.stats.n < 20) out.notes.push('Fewer than 20 trading periods in the train block: treat every statistic as noise.');
  out.notes.push(`${out.trials} strategies tried so far; the more you try, the more likely a good-looking result is luck.`, 'Universe is the current index list (survivorship bias); costs are a flat round-trip estimate, not real fills.');
  return out;
}
