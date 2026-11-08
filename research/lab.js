// research/lab.js — a disciplined "idea lab" on the backfill: a restricted expression language, three sealed time blocks,
// a ledger of every idea ever tried, and multiplicity-aware thresholds. An LLM (research/lab-llm.js) may PROPOSE ideas, but it
// can only emit JSON expressions from the whitelist below: it never runs code, never sees raw data, and never sees validate or
// vault results. Nothing here is imported by the server or the engines.
//
//   explore  (first 40% of days)  — ideas are tried here; the LLM sees these results (counts + threshold included)
//   validate (next 30%)           — each shortlisted idea is tested ONCE; the LLM never sees the numbers
//   vault    (last 30%)           — opened ONCE for ideas that passed validate; guarded by vault.json
//
// Timing: signal on day D uses only data dated <= D (every op is causal; tested); entry = close of D; label = close D -> D+h;
// signals whose label window would cross a block boundary are purged (no leakage between blocks).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ranks, spearman, partialSpearman, mean, sd, normInv, num, decileSpread, loadPrices, loadJson, rowsOf as rowsOfJson, FEATURE_COLS, LAB_COLS } from './backtest.js';

// ---- the expression language -----------------------------------------------------------------------------------------------
export const LIMITS = { maxDepth: 6, maxNodes: 25, maxWin: 60, maxLag: 20 };
export const HORIZONS = [1, 3, 5];
const fin = Number.isFinite;
const mapU = (f) => (a) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = fin(a[i]) ? f(a[i]) : NaN; return o; };
const mapB = (f) => (a, b) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = fin(a[i]) && fin(b[i]) ? f(a[i], b[i]) : NaN; return o; };
// per-ticker time-series helper: fn(window values array of finite numbers, current value) -> number | NaN
function tsOp(P, x, win, { prior = false, minCount, fn }) {
  const o = new Float64Array(x.length).fill(NaN); const need = minCount ?? Math.max(2, Math.floor(win / 3));
  for (let t = 0; t < P.T; t++) {
    const base = t * P.D;
    for (let d = 0; d < P.D; d++) {
      const from = Math.max(0, prior ? d - win : d - win + 1), to = prior ? d - 1 : d; const vals = [];
      for (let k = from; k <= to; k++) { const v = x[base + k]; if (fin(v)) vals.push(v); }
      if (vals.length >= need) o[base + d] = fn(vals, x[base + d]);
    }
  }
  return o;
}
const avg = (v) => v.reduce((s, q) => s + q, 0) / v.length;
const stdv = (v) => { const m = avg(v); return Math.sqrt(v.reduce((s, q) => s + (q - m) ** 2, 0) / (v.length - 1)); };
function csOp(P, x, fn) {                                           // per-day cross-section across tickers
  const o = new Float64Array(x.length).fill(NaN);
  for (let d = 0; d < P.D; d++) { const idx = [], vals = []; for (let t = 0; t < P.T; t++) { const v = x[t * P.D + d]; if (fin(v)) { idx.push(t * P.D + d); vals.push(v); } } if (vals.length >= 5) { const r = fn(vals); for (let k = 0; k < idx.length; k++) o[idx[k]] = r[k]; } }
  return o;
}
export const OPS = {
  // unary
  neg: { arity: 1, doc: 'negate', fn: ([a]) => mapU((v) => -v)(a) },
  abs: { arity: 1, doc: 'absolute value', fn: ([a]) => mapU(Math.abs)(a) },
  sign: { arity: 1, doc: 'sign: -1, 0 or 1', fn: ([a]) => mapU(Math.sign)(a) },
  ssqrt: { arity: 1, doc: 'signed square root (tames huge values)', fn: ([a]) => mapU((v) => Math.sign(v) * Math.sqrt(Math.abs(v)))(a) },
  slog: { arity: 1, doc: 'signed log1p (tames huge values)', fn: ([a]) => mapU((v) => Math.sign(v) * Math.log1p(Math.abs(v)))(a) },
  nz: { arity: 1, doc: 'missing value -> 0 (use for flow columns: a day with no alerts means zero flow)', fn: ([a]) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = fin(a[i]) ? a[i] : 0; return o; } },
  clip: { arity: 1, p: 'range', doc: 'clip to [lo,hi]; p=[lo,hi]', fn: ([a], p) => mapU((v) => Math.min(p[1], Math.max(p[0], v)))(a) },
  // binary
  add: { arity: 2, doc: 'a+b', fn: ([a, b]) => mapB((x, y) => x + y)(a, b) },
  sub: { arity: 2, doc: 'a-b', fn: ([a, b]) => mapB((x, y) => x - y)(a, b) },
  mul: { arity: 2, doc: 'a*b', fn: ([a, b]) => mapB((x, y) => x * y)(a, b) },
  div: { arity: 2, doc: 'a/b (missing when b is 0)', fn: ([a, b]) => mapB((x, y) => (y === 0 ? NaN : x / y))(a, b) },
  min2: { arity: 2, doc: 'smaller of a,b', fn: ([a, b]) => mapB(Math.min)(a, b) },
  max2: { arity: 2, doc: 'larger of a,b', fn: ([a, b]) => mapB(Math.max)(a, b) },
  gt: { arity: 2, doc: '1 if a>b else 0', fn: ([a, b]) => mapB((x, y) => (x > y ? 1 : 0))(a, b) },
  lt: { arity: 2, doc: '1 if a<b else 0', fn: ([a, b]) => mapB((x, y) => (x < y ? 1 : 0))(a, b) },
  and2: { arity: 2, doc: '1 if a==1 and b==1', fn: ([a, b]) => mapB((x, y) => (x === 1 && y === 1 ? 1 : 0))(a, b) },
  where: { arity: 3, doc: 'where(cond,a,b): a if cond==1 else b', fn: ([c, a, b]) => { const o = new Float64Array(c.length); for (let i = 0; i < c.length; i++) o[i] = fin(c[i]) ? (c[i] === 1 ? a[i] : b[i]) : NaN; return o; } },
  // time-series (per ticker, causal: use only days <= today)
  lag: { arity: 1, p: 'lag', doc: 'value k days ago; p=k (1..20)', fn: ([a], k, P) => { const o = new Float64Array(a.length).fill(NaN); for (let t = 0; t < P.T; t++) for (let d = k; d < P.D; d++) o[t * P.D + d] = a[t * P.D + d - k]; return o; } },
  ts_sum: { arity: 1, p: 'win', doc: 'sum over the last p days incl. today (missing days skipped)', fn: ([a], w, P) => tsOp(P, a, w, { minCount: 1, fn: (v) => v.reduce((s, q) => s + q, 0) }) },
  ts_mean: { arity: 1, p: 'win', doc: 'mean over the last p days incl. today (missing days skipped)', fn: ([a], w, P) => tsOp(P, a, w, { fn: avg }) },
  ts_mean_prior: { arity: 1, p: 'win', doc: 'mean of the p days BEFORE today', fn: ([a], w, P) => tsOp(P, a, w, { prior: true, minCount: Math.max(3, Math.floor(w / 3)), fn: avg }) },
  ts_std_prior: { arity: 1, p: 'win', doc: 'std dev of the p days BEFORE today', fn: ([a], w, P) => tsOp(P, a, w, { prior: true, minCount: Math.max(3, Math.floor(w / 3)), fn: stdv }) },
  zts: { arity: 1, p: 'win', doc: "today's value as a z-score vs the ticker's own previous p days", fn: ([a], w, P) => tsOp(P, a, w, { prior: true, minCount: Math.max(3, Math.floor(w / 3)), fn: (v, cur) => { const s = stdv(v); return s > 0 && fin(cur) ? (cur - avg(v)) / s : NaN; } }) },
  ratio_abs_prior: { arity: 1, p: 'win', doc: "today's value divided by the mean |value| of the previous p days", fn: ([a], w, P) => tsOp(P, a, w, { prior: true, minCount: Math.max(3, Math.floor(w / 3)), fn: (v, cur) => { const m = avg(v.map(Math.abs)); return m > 0 && fin(cur) ? cur / m : NaN; } }) },
  // cross-sectional (per day, across tickers)
  rank_cs: { arity: 1, doc: "today's percentile rank (0..1) across all tickers", fn: ([a], _p, P) => csOp(P, a, (v) => { const r = ranks(v); return r.map((q) => (q - 0.5) / v.length); }) },
  zscore_cs: { arity: 1, doc: "today's cross-sectional z-score", fn: ([a], _p, P) => csOp(P, a, (v) => { const m = avg(v), s = stdv(v); return v.map((q) => (s > 0 ? (q - m) / s : NaN)); }) },
  demean_cs: { arity: 1, doc: "subtract today's cross-sectional mean", fn: ([a], _p, P) => csOp(P, a, (v) => { const m = avg(v); return v.map((q) => q - m); }) },
};
export const COLUMN_DOC = {
  alertRaw: 'signed ask-minus-bid premium of all flow alerts (calls +, puts -), $', alertSingle: 'same, single-leg alerts only', alertOpen: 'same, single-leg alerts flagged all-opening only',
  alertDelta: 'single-leg signed flow weighted by |delta| (often missing for older dates)', grossSigned: 'call premium minus put premium ignoring ask/bid, $', grossAbs: 'total alert premium, $ (size)', nAlerts: 'number of alerts (size)',
  tapeNetPremSum: 'net call-minus-put premium from the minute tape, summed to 15:30 ET', tapeNetPremLast: 'last tape value before 15:30 ET', tapeDeltaSum: 'net delta from the tape, summed', tapeDeltaLast: 'last tape net delta',
  oiImb: 'open-interest change: (call change - put change)/total |change| (published the morning of the day; reflects the PREVIOUS day)', oiNetPrem: 'OI change weighted by price, signed, $', oiAbs: 'total |OI change| (size)',
  callAsk: 'single-leg call premium bought at ask, $', callBid: 'single-leg call premium sold at bid, $', putAsk: 'single-leg put premium bought at ask, $', putBid: 'single-leg put premium sold at bid, $', nSingle: 'number of single-leg alerts', nMulti: 'number of multi-leg alerts',
  flowDteS: 'signed single-leg flow, expiries <= 7 days', flowDteM: 'signed single-leg flow, expiries 8-45 days', flowDteL: 'signed single-leg flow, expiries > 45 days', flowOtm: 'signed single-leg flow, |delta| < 0.3', flowMid: 'signed single-leg flow, |delta| 0.3-0.7', flowItm: 'signed single-leg flow, |delta| > 0.7',
  flowSweep: 'signed single-leg flow, sweeps only', flowFloor: 'signed single-leg flow, floor trades only', flowRepeat: 'signed single-leg flow, repeated-hit alerts only', flowBig: 'signed single-leg flow, alerts with premium >= $100k', daysToEarn: 'days until the next earnings date (smallest across the day\'s alerts; missing if unknown)',
  mom1: "the signal day's own return (close vs previous close)", mom5: 'return over the previous 5 days',
  rvol: "the signal day's volume divided by the average of the previous 20 days", rv20: 'realized volatility over 20 days (annualized)', ret5: '5-day return', ret20: '20-day return', brk20: '+1 if the close is above the prior 20-day closing high, -1 if below the prior 20-day low, else 0', gexNet: "net gamma exposure (call + put) as of the PREVIOUS day's end (lagged one day)",
};
export const COLUMNS = Object.keys(COLUMN_DOC);

export function validateNode(node, depth = 1, st = { nodes: 0 }, cols = COLUMNS) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('node must be an object');
  if (depth > LIMITS.maxDepth) throw new Error(`too deep (max ${LIMITS.maxDepth})`);
  if (++st.nodes > LIMITS.maxNodes) throw new Error(`too many nodes (max ${LIMITS.maxNodes})`);
  if ('col' in node) { if (!cols.includes(node.col)) throw new Error(`unknown column ${JSON.stringify(node.col)}`); return { col: node.col }; }
  if ('const' in node) { if (typeof node.const !== 'number' || !fin(node.const)) throw new Error('const must be a finite number'); return { const: node.const }; }
  const op = OPS[node.op]; if (!op || !Object.prototype.hasOwnProperty.call(OPS, node.op)) throw new Error(`unknown op ${JSON.stringify(node.op)}`);
  if (!Array.isArray(node.args) || node.args.length !== op.arity) throw new Error(`${node.op} needs ${op.arity} argument(s)`);
  const out = { op: node.op, args: node.args.map((a) => validateNode(a, depth + 1, st, cols)) };
  if (op.p === 'win') { if (!Number.isInteger(node.p) || node.p < 2 || node.p > LIMITS.maxWin) throw new Error(`${node.op}: p must be an integer 2..${LIMITS.maxWin}`); out.p = node.p; }
  else if (op.p === 'lag') { if (!Number.isInteger(node.p) || node.p < 1 || node.p > LIMITS.maxLag) throw new Error(`lag: p must be an integer 1..${LIMITS.maxLag}`); out.p = node.p; }
  else if (op.p === 'range') { if (!Array.isArray(node.p) || node.p.length !== 2 || !node.p.every((q) => typeof q === 'number' && fin(q)) || node.p[0] >= node.p[1]) throw new Error('clip: p must be [lo,hi] with lo<hi'); out.p = node.p; }
  return out;
}
export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  const name = String(spec.name || '').trim().slice(0, 80); if (!name) throw new Error('name required');
  const hypothesis = String(spec.hypothesis || '').trim().slice(0, 240); if (!hypothesis) throw new Error('hypothesis (one sentence) required');
  if (!HORIZONS.includes(spec.horizon)) throw new Error('horizon must be 1, 3 or 5');
  const out = { name, hypothesis, horizon: spec.horizon, expr: validateNode(spec.expr) }; if (spec.filter != null) out.filter = validateNode(spec.filter);
  return out;
}
const canon = (n) => (n && typeof n === 'object' ? (Array.isArray(n) ? n.map(canon) : Object.fromEntries(Object.keys(n).sort().map((k) => [k, canon(n[k])]))) : n);
export const specId = (spec) => crypto.createHash('sha1').update(JSON.stringify(canon({ expr: spec.expr, filter: spec.filter || null, horizon: spec.horizon }))).digest('hex').slice(0, 12);
export function exprToString(n) { if (n.col) return n.col; if ('const' in n) return String(n.const); return `(${n.op}${n.p != null ? `[${[].concat(n.p).join(',')}]` : ''} ${n.args.map(exprToString).join(' ')})`; }
export function evalExpr(node, P, memo = new Map()) {
  const key = JSON.stringify(node); if (memo.has(key)) return memo.get(key); let out;
  if ('col' in node) { out = P.cols.get(node.col); if (!out) throw new Error(`column ${node.col} not in the panel`); }
  else if ('const' in node) out = new Float64Array(P.T * P.D).fill(node.const);
  else out = OPS[node.op].fn(node.args.map((a) => evalExpr(a, P, memo)), node.p, P);
  memo.set(key, out); return out;
}

// ---- panel: dense tickers x days arrays ---------------------------------------------------------------------------------------
export function buildPanel({ featuresCsv, dir, horizons = HORIZONS }) {
  const lines = fs.readFileSync(featuresCsv, 'utf8').split('\n').filter(Boolean); const head = lines[0].split(',');
  const names = head.slice(2); const tickerSet = new Set(), dateSet = new Set(); const recs = [];
  for (const l of lines.slice(1)) { const c = l.split(','); tickerSet.add(c[0]); dateSet.add(c[1]); recs.push(c); }
  const tickers = [...tickerSet].sort(); const prices = loadPrices(dir, tickers); const sigDates = [...dateSet].sort();
  const lastSig = sigDates[sigDates.length - 1]; const limit = new Date(Date.parse(`${lastSig}T12:00:00Z`) + 25 * 86400000).toISOString().slice(0, 10);
  const calSet = new Set(); for (const p of prices.values()) for (const d of p.dates) if (d >= sigDates[0] && d <= limit) calSet.add(d);
  const dates = [...calSet].sort(); const D = dates.length, T = tickers.length; const dIdx = new Map(dates.map((d, i) => [d, i])), tIdx = new Map(tickers.map((t, i) => [t, i]));
  const mk = () => new Float64Array(T * D).fill(NaN); const cols = new Map(names.map((n) => [n, mk()]));
  for (const c of recs) { const t = tIdx.get(c[0]), d = dIdx.get(c[1]); if (t == null || d == null) continue; for (let k = 0; k < names.length; k++) { const v = c[k + 2] === '' ? NaN : num(c[k + 2]); if (v != null) cols.get(names[k])[t * D + d] = v; } }
  const close = mk(); for (const [tk, p] of prices) { const t = tIdx.get(tk); for (let i = 0; i < p.dates.length; i++) { const d = dIdx.get(p.dates[i]); if (d != null) close[t * D + d] = p.close[i]; } }
  const y = {}; for (const h of horizons) { y[h] = mk(); for (let t = 0; t < T; t++) for (let d = 0; d + h < D; d++) { const a = close[t * D + d], b = close[t * D + d + h]; if (fin(a) && fin(b) && a > 0) y[h][t * D + d] = b / a - 1; } }
  const mom1 = mk(), mom5 = mk(); for (let t = 0; t < T; t++) for (let d = 1; d < D; d++) { const a = close[t * D + d], b = close[t * D + d - 1]; if (fin(a) && fin(b) && b > 0) mom1[t * D + d] = a / b - 1; if (d >= 5) { const c5 = close[t * D + d - 5]; if (fin(a) && fin(c5) && c5 > 0) mom5[t * D + d] = a / c5 - 1; } }
  cols.set('mom1', mom1); cols.set('mom5', mom5);
  // ---- point-in-time columns derived from the daily bars and the 2-year gamma series (all known at the close of the signal day) ----
  const vol = mk(), rvol = mk(), rv20 = mk(), ret5 = mk(), ret20 = mk(), brk20 = mk(), gexNet = mk();
  for (const [tk, p] of prices) { const t = tIdx.get(tk); for (let i = 0; i < p.dates.length; i++) { const d = dIdx.get(p.dates[i]); if (d != null && fin(p.volume[i])) vol[t * D + d] = p.volume[i]; } }
  for (let t = 0; t < T; t++) {
    const b = t * D;
    for (let d = 1; d < D; d++) {
      const c = close[b + d]; if (!fin(c)) continue;
      let sv = 0, nv = 0; for (let k = Math.max(0, d - 20); k < d; k++) { const v = vol[b + k]; if (fin(v)) { sv += v; nv++; } } if (nv >= 10 && fin(vol[b + d]) && sv > 0) rvol[b + d] = vol[b + d] / (sv / nv);
      if (d >= 5 && fin(close[b + d - 5]) && close[b + d - 5] > 0) ret5[b + d] = c / close[b + d - 5] - 1; if (d >= 20 && fin(close[b + d - 20]) && close[b + d - 20] > 0) ret20[b + d] = c / close[b + d - 20] - 1;
      if (d >= 21) { const r = []; for (let k = d - 19; k <= d; k++) { const a = close[b + k], q = close[b + k - 1]; if (fin(a) && fin(q) && q > 0) r.push(Math.log(a / q)); } if (r.length >= 15) { const m = r.reduce((x, y) => x + y, 0) / r.length; rv20[b + d] = Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252); } }
      if (d >= 21) { let hi = -Infinity, lo = Infinity, n = 0; for (let k = d - 20; k < d; k++) { const q = close[b + k]; if (fin(q)) { hi = Math.max(hi, q); lo = Math.min(lo, q); n++; } } if (n >= 15) brk20[b + d] = c > hi ? 1 : c < lo ? -1 : 0; }
    }
  }
  for (const tk of tickers) {                                    // gamma series: the value dated D is an end-of-day estimate, so it is used from D+1 on (lagged one day)
    const j = loadJson(path.join(dir, 'gex', tk, 'series.json')); const rows = rowsOfJson(j); if (!rows.length) continue; const t = tIdx.get(tk); const byDate = new Map();
    for (const r of rows) { const cg = num(r.call_gamma), pg = num(r.put_gamma); if (cg != null && pg != null && r.date) byDate.set(String(r.date).slice(0, 10), cg + pg); }
    for (let d = 1; d < D; d++) { const v = byDate.get(dates[d - 1]); if (v != null) gexNet[t * D + d] = v; }
  }
  for (const [k, a] of [['rvol', rvol], ['rv20', rv20], ['ret5', ret5], ['ret20', ret20], ['brk20', brk20], ['gexNet', gexNet]]) cols.set(k, a);
  // signal range = first/last calendar day inside the feature dates (a feature date without a price day must not break the splits)
  let sigFirst = dates.findIndex((d) => d >= sigDates[0]); let sigLast = -1; for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= lastSig) { sigLast = i; break; }
  if (D === 0 || prices.size === 0 || sigFirst < 0 || sigLast < sigFirst) throw new Error(`no usable calendar: prices for ${prices.size}/${tickers.length} tickers, calendar days ${D}, feature dates ${sigDates[0]}..${lastSig}. Check that research-data/backfill/ohlc1d exists.`);
  return { T, D, tickers, dates, cols, y, mom1, sigFirst, sigLast };
}
export function getSplits(labDir, P, fractions = [0.4, 0.3, 0.3]) {
  const f = path.join(labDir, 'splits.json'); fs.mkdirSync(labDir, { recursive: true });
  let s; const okSplits = (x) => x && ['explore', 'validate', 'vault'].every((b) => Array.isArray(x[b]) && x[b].length === 2 && x[b].every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)));
  if (fs.existsSync(f)) { try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { s = null; } if (!okSplits(s)) s = null; }   // a broken file is rebuilt, never trusted
  if (!s) {
    const n = P.sigLast - P.sigFirst + 1; const e1 = P.sigFirst + Math.floor(n * fractions[0]) - 1, e2 = e1 + Math.floor(n * fractions[1]);
    s = { created: new Date().toISOString(), explore: [P.dates[P.sigFirst], P.dates[e1]], validate: [P.dates[e1 + 1], P.dates[e2]], vault: [P.dates[e2 + 1], P.dates[P.sigLast]] };
    if (!okSplits(s)) throw new Error(`could not compute the time blocks (signal days ${P.sigFirst}..${P.sigLast} of ${P.D}); need at least ~30 signal days`);
    fs.writeFileSync(f, JSON.stringify(s, null, 1));
  }
  const at = (d) => { const i = P.dates.indexOf(d); if (i < 0) throw new Error(`split date ${d} not in panel`); return i; };
  return { raw: s, explore: { start: at(s.explore[0]), end: at(s.explore[1]) }, validate: { start: at(s.validate[0]), end: at(s.validate[1]) }, vault: { start: at(s.vault[0]), end: Math.max(at(s.vault[1]), P.sigLast) } };
}

// ---- evaluating one spec on one block ---------------------------------------------------------------------------------------------
export function evaluateSpec(P, spec, block, { minNames = 30, costBps = 10 } = {}) {
  const h = spec.horizon; const memo = new Map(); const x = evalExpr(spec.expr, P, memo); const f = spec.filter ? evalExpr(spec.filter, P, memo) : null; const y = P.y[h]; const days = [];
  for (let d = block.start; d + h <= block.end; d++) {                       // purge: the label window must end inside the block
    const xs = [], ys = [], px = [], py = [], pm = [];
    for (let t = 0; t < P.T; t++) { const i = t * P.D + d; if (f && f[i] !== 1) continue; const xv = x[i], yv = y[i]; if (!fin(xv) || !fin(yv)) continue; xs.push(xv); ys.push(yv); const m = P.mom1[i]; if (fin(m)) { px.push(xv); py.push(yv); pm.push(m); } }
    if (xs.length < minNames) continue; const ic = spearman(xs, ys); if (ic == null) continue;
    days.push({ d, ic, pic: px.length >= minNames ? partialSpearman(px, py, pm) : null, spread: decileSpread(xs, ys), n: xs.length });
  }
  const res = { nDays: days.length, nIndep: 0, avgNames: days.length ? Math.round(mean(days.map((q) => q.n))) : 0, meanIC: null, t: null, pIC: null, pT: null, icFirstHalf: null, icSecondHalf: null, spreadBps: null, netSpreadBps: null };
  if (days.length < 10) return res;
  const non = days.filter((_, i) => i % h === 0); const ics = non.map((q) => q.ic); const s1 = sd(ics); res.nIndep = non.length; res.meanIC = mean(days.map((q) => q.ic)); res.t = s1 ? mean(ics) / (s1 / Math.sqrt(ics.length)) : null;
  const pv = days.filter((q) => q.pic != null); const pn = pv.filter((_, i) => i % h === 0).map((q) => q.pic); const s2 = sd(pn); if (pv.length >= 10) { res.pIC = mean(pv.map((q) => q.pic)); res.pT = s2 ? mean(pn) / (s2 / Math.sqrt(pn.length)) : null; }
  const half = Math.floor(days.length / 2); res.icFirstHalf = mean(days.slice(0, half).map((q) => q.ic)); res.icSecondHalf = mean(days.slice(half).map((q) => q.ic));
  const sp = non.map((q) => q.spread * 1e4); res.spreadBps = mean(sp); res.netSpreadBps = (res.t != null && res.t < 0 ? -mean(sp) : mean(sp)) - costBps; return res;   // trade the direction the t-stat points to
}

// ---- ledger, thresholds, vault guard ------------------------------------------------------------------------------------------------
export class Ledger {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'ledger.jsonl'); this.vaultFile = path.join(dir, 'vault.json'); fs.mkdirSync(dir, { recursive: true }); }
  all() { try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
  append(e) { fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); }
  has(id, block) { return this.all().some((e) => e.id === id && e.block === block); }
  byBlock(block) { const m = new Map(); for (const e of this.all()) if (e.block === block) m.set(e.id, e); return [...m.values()]; }
  trialCount() { return this.byBlock('explore').length; }
  vaultOpened() { try { return JSON.parse(fs.readFileSync(this.vaultFile, 'utf8')); } catch { return null; } }
}
export const bonferroniT = (k, alpha = 0.05) => (k > 0 ? normInv(1 - alpha / (2 * k)) : null);
export const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export function shortlist(ledger, { max = 5, minAbsT = 2.5 } = {}) {
  const done = new Set(ledger.byBlock('validate').map((e) => e.id));
  return ledger.byBlock('explore').filter((e) => !done.has(e.id) && e.result.t != null && Math.abs(e.result.t) >= minAbsT && sgn(e.result.icFirstHalf) === sgn(e.result.t) && sgn(e.result.icSecondHalf) === sgn(e.result.t) && e.result.pT != null && sgn(e.result.pT) === sgn(e.result.t) && Math.abs(e.result.pT) >= 1.5)
    .sort((a, b) => Math.abs(b.result.t) - Math.abs(a.result.t)).slice(0, max);
}
export function passRule(exploreT, r, k) { const thr = bonferroniT(k); return { thr, pass: r.t != null && sgn(r.t) === sgn(exploreT) && Math.abs(r.t) >= thr && r.pT != null && sgn(r.pT) === sgn(exploreT) }; }
export function runExplore({ P, splits, ledger, specs, round = null, minNames = 30 }) {
  const out = [];
  for (const raw of specs) {
    const spec = validateSpec(raw); const id = specId(spec); if (ledger.has(id, 'explore')) { out.push({ id, skipped: 'already tried' }); continue; }
    const result = evaluateSpec(P, spec, splits.explore, { minNames }); ledger.append({ id, block: 'explore', round, name: spec.name, hypothesis: spec.hypothesis, horizon: spec.horizon, expr: spec.expr, filter: spec.filter || null, result }); out.push({ id, spec, result });
  }
  return out;
}
export function runValidate({ P, splits, ledger, minNames = 30 }) {
  const cands = shortlist(ledger); const out = [];
  for (const c of cands) {
    const spec = { name: c.name, hypothesis: c.hypothesis, horizon: c.horizon, expr: c.expr, filter: c.filter || undefined };
    const result = evaluateSpec(P, spec, splits.validate, { minNames }); const k = new Set([...ledger.byBlock('validate').map((e) => e.id), c.id]).size; const v = passRule(c.result.t, result, k);
    ledger.append({ id: c.id, block: 'validate', name: c.name, hypothesis: c.hypothesis, horizon: c.horizon, expr: c.expr, filter: c.filter || null, result, exploreT: c.result.t, thr: v.thr, pass: v.pass }); out.push({ c, result, ...v });
  }
  return out;
}
export function runVault({ P, splits, ledger, force = false, minNames = 30 }) {
  const opened = ledger.vaultOpened(); if (opened && !force) throw new Error(`the vault was already opened on ${opened.openedAt}; a second look is contaminated (use force only to inspect, never to select)`);
  const winners = ledger.byBlock('validate').filter((e) => e.pass); const out = [];
  for (const w of winners) {
    const spec = { name: w.name, hypothesis: w.hypothesis, horizon: w.horizon, expr: w.expr, filter: w.filter || undefined };
    const result = evaluateSpec(P, spec, splits.vault, { minNames }); const v = passRule(w.exploreT, result, winners.length);
    ledger.append({ id: w.id, block: 'vault', name: w.name, horizon: w.horizon, expr: w.expr, filter: w.filter || null, result, thr: v.thr, pass: v.pass, contaminated: !!opened }); out.push({ w, result, ...v });
  }
  if (!opened) fs.writeFileSync(ledger.vaultFile, JSON.stringify({ openedAt: new Date().toISOString(), ids: winners.map((w) => w.id) }));
  return out;
}
// what the LLM may see: EXPLORE results only (never validate or vault), the number of trials so far and the current threshold
export function verdictFor(result, nTrials) {
  const t = result && result.t; if (t == null) return { level: 'unknown', text: 'not enough data to judge' };
  const bar = bonferroniT(Math.max(1, nTrials)); const same = sgn(result.icFirstHalf) === sgn(t) && sgn(result.icSecondHalf) === sgn(t) && result.pT != null && sgn(result.pT) === sgn(t);
  if (Math.abs(t) >= bar && same) return { level: 'strong', text: `clears the multiple-testing bar (|t| ${Math.abs(t).toFixed(1)} >= ${bar.toFixed(1)}); still needs the validate block` };
  if (Math.abs(t) >= 2.5 && same) return { level: 'promising', text: `|t| ${Math.abs(t).toFixed(1)}; consistent in both halves and after removing yesterday's move; worth one validation` };
  return { level: 'noise', text: `|t| ${Math.abs(t).toFixed(1)} is below 2.5 or not consistent; treat as noise (bar for ${nTrials} ideas is ${bar.toFixed(1)})` };
}
export function buildHistory(ledger, { top = 15, summaryOnly = false } = {}) {
  const ex = ledger.byBlock('explore'); const n = ex.length; const thr = bonferroniT(Math.max(1, n)); const f = (v, d = 3) => (v == null ? 'n/a' : v.toFixed(d));
  if (summaryOnly) return { trials: n, bonferroniT: thr, text: `Ideas tried so far on the explore block: ${n}. Current Bonferroni |t| threshold: ${f(thr, 2)}.` };
  const rows = ex.slice().sort((a, b) => Math.abs(b.result.t ?? 0) - Math.abs(a.result.t ?? 0)).slice(0, top).map((e) => `- ${e.name} | h=${e.horizon} | ${exprToString(e.expr)}${e.filter ? ` | filter ${exprToString(e.filter)}` : ''} | IC ${f(e.result.meanIC)} t ${f(e.result.t, 2)} | IC ex-mom1 ${f(e.result.pIC)} t ${f(e.result.pT, 2)} | halves ${f(e.result.icFirstHalf)}/${f(e.result.icSecondHalf)}`);
  return { trials: n, bonferroniT: thr, text: n ? `Ideas tried so far on the explore block: ${n}. Current Bonferroni |t| threshold: ${f(thr, 2)}.\nBest so far (by |t|):\n${rows.join('\n')}` : 'No ideas tried yet.' };
}
export const ALL_BASE_COLS = [...FEATURE_COLS, ...LAB_COLS];
