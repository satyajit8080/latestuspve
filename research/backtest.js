// research/backtest.js — OFFLINE evaluation of candidate options-flow features on the raw backfill.
// Reads only files written by research/backfill.js. Nothing here is imported by the server or the engines.
//
// Timing rules (no look-ahead):
//   * A signal for trading day D uses ONLY files dated D: flow alerts and net-prem-ticks cut off at 15:30 ET, and the
//     oi-change file published on the morning of D (it reflects trades of D-1, so it is stale-but-legitimate on D).
//   * Entry is the CLOSE of D; the label is the close-to-close return from D to D+h trading days (h = 1, 3, 5).
//   * Cross-sectional Spearman IC per day, so a common market move cancels out (no SPY series needed).
//   * t-stats use NON-overlapping days (every h-th day) so overlapping multi-day labels do not inflate them.
//   * A Bonferroni threshold over every (feature, horizon) pair is printed; below it a result is a candidate, not a finding.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { etDayBounds } from './backfill.js';

export const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
export function loadJson(file) {
  for (const f of [file, `${file}.gz`]) {
    try { if (!fs.existsSync(f)) continue; const b = fs.readFileSync(f); return JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8')); } catch { return null; }
  }
  return null;
}
export const rowsOf = (j) => { const d = j && j.data !== undefined ? j.data : j; if (Array.isArray(d)) return d; if (d && Array.isArray(d.data)) return d.data; return []; };

// ---- statistics ----------------------------------------------------------------------------------------------
export function ranks(a) {                                  // average ranks (ties share the mean rank)
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const m = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = m; i = j + 1; }
  return r;
}
export function pearson(x, y) {
  const n = x.length; if (n < 3) return null; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
export const spearman = (x, y) => (x.length >= 3 ? pearson(ranks(x), ranks(y)) : null);
export function partialSpearman(x, y, z) {            // rank correlation of x and y after removing the rank of z (e.g. yesterday's return)
  const rx = ranks(x), ry = ranks(y), rz = ranks(z); const xy = pearson(rx, ry), xz = pearson(rx, rz), yz = pearson(ry, rz);
  if (xy == null || xz == null || yz == null) return null; const den = Math.sqrt((1 - xz * xz) * (1 - yz * yz)); return den > 1e-12 ? (xy - xz * yz) / den : null;
}
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
export function sd(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }
export function normInv(p) {                                // Acklam's approximation of the standard normal quantile
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
const winsor = (a, lo = 0.01, hi = 0.99) => { if (a.length < 20) return a; const s = a.slice().sort((p, q) => p - q); const L = s[Math.floor(lo * (s.length - 1))], H = s[Math.floor(hi * (s.length - 1))]; return a.map((v) => Math.min(H, Math.max(L, v))); };

// ---- feature extractors (one ticker-day) -------------------------------------------------------------------------
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
export function alertFeatures(rows, cutoffMs = null) {
  let n = 0, raw = 0, single = 0, open = 0, delta = 0, grossSigned = 0, grossAbs = 0;
  for (const a of rows) {
    const t = Date.parse(a.created_at || a.timestamp || ''); if (cutoffMs != null && Number.isFinite(t) && t > cutoffMs) continue;
    const type = String(a.type || a.option_type || '').toLowerCase(); const sgn = type === 'call' ? 1 : type === 'put' ? -1 : 0; if (!sgn) continue;
    const ask = num(a.total_ask_side_prem) ?? 0, bid = num(a.total_bid_side_prem) ?? 0, tot = num(a.total_premium) ?? (ask + bid);
    const flow = ask - bid; n++; raw += sgn * flow; grossSigned += sgn * tot; grossAbs += tot;
    const multi = truthy(a.has_multileg) || (num(a.expiry_count) ?? 1) > 1;
    if (!multi) {
      single += sgn * flow; const dl = Math.abs(num(a.delta) ?? NaN); if (Number.isFinite(dl)) delta += sgn * flow * dl;
      if (truthy(a.all_opening_trades)) open += sgn * flow;
    }
  }
  return n ? { nAlerts: n, alertRaw: raw, alertSingle: single, alertOpen: open, alertDelta: delta, grossSigned, grossAbs } : null;
}
export function tapeFeatures(rows, cutoffMs = null) {
  const pick = (r, k) => num(r[k]);
  const timeOf = (r) => { for (const k of ['tape_time', 'timestamp', 'start_time', 'time', 'date']) { const t = Date.parse(r[k] || ''); if (Number.isFinite(t)) return t; } return null; };
  let items = rows.map((r) => ({ t: timeOf(r), c: pick(r, 'net_call_premium'), p: pick(r, 'net_put_premium'), d: pick(r, 'net_delta') }));
  if (items.some((x) => x.t != null)) { items.sort((a, b) => (a.t ?? 0) - (b.t ?? 0)); if (cutoffMs != null) items = items.filter((x) => x.t == null || x.t <= cutoffMs); }
  if (!items.length) return null;
  let sNP = 0, sD = 0, aNP = false, aD = false, lNP = null, lD = null;
  for (const x of items) { if (x.c != null || x.p != null) { const v = (x.c ?? 0) - (x.p ?? 0); sNP += v; aNP = true; lNP = v; } if (x.d != null) { sD += x.d; aD = true; lD = x.d; } }
  return { tapeNetPremSum: aNP ? sNP : null, tapeNetPremLast: lNP, tapeDeltaSum: aD ? sD : null, tapeDeltaLast: lD };
}
const OCC = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/;
export function oiFeatures(rows) {
  let call = 0, put = 0, abs = 0, prem = 0, n = 0;
  for (const r of rows) {
    const m = OCC.exec(String(r.option_symbol || '')); if (!m) continue; const diff = num(r.oi_diff_plain ?? r.oi_change); if (diff == null) continue;
    const s = m[3] === 'C' ? 1 : -1; n++; abs += Math.abs(diff); if (s > 0) call += diff; else put += diff; prem += s * diff * (num(r.avg_price) ?? 0) * 100;
  }
  return n && abs > 0 ? { oiImb: (call - put) / abs, oiNetPrem: prem, oiAbs: abs } : null;
}

export const FEATURE_COLS = ['nAlerts', 'alertRaw', 'alertSingle', 'alertOpen', 'alertDelta', 'grossSigned', 'grossAbs', 'tapeNetPremSum', 'tapeNetPremLast', 'tapeDeltaSum', 'tapeDeltaLast', 'oiImb', 'oiNetPrem', 'oiAbs'];
const SIZE_COLS = new Set(['nAlerts', 'grossAbs', 'oiAbs']);          // size/activity measures: kept as columns, not tested as direction

// ---- step 1: raw files -> one feature row per ticker-day (CSV) ---------------------------------------------------------
export function buildFeatures({ dir, tickers, dates, cutoff = '15:30', out, log = () => {} }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, 'w'); fs.writeSync(fd, `ticker,date,${FEATURE_COLS.join(',')}\n`);
  const [hh, mm] = cutoff.split(':').map(Number); let written = 0, di = 0;
  const get = (ep, t, d) => rowsOf(loadJson(path.join(dir, ep, t, `${d}.json`)));
  for (const date of dates) {
    const cutoffMs = Date.parse(etDayBounds(date)[0]) + (hh * 60 + mm) * 60000;
    for (const t of tickers) {
      const f = { ...(alertFeatures(get('flow', t, date), cutoffMs) || {}), ...(tapeFeatures(get('tape', t, date), cutoffMs) || {}), ...(oiFeatures(get('oi', t, date)) || {}) };
      if (!Object.keys(f).length) continue;
      fs.writeSync(fd, `${t},${date},${FEATURE_COLS.map((c) => (f[c] == null ? '' : f[c])).join(',')}\n`); written++;
    }
    if (++di % 20 === 0) log(`features: ${di}/${dates.length} days, ${written} rows`);
  }
  fs.closeSync(fd); return written;
}

// ---- step 2: labels, normalisation, IC --------------------------------------------------------------------------------
export function readFeatures(csv) {
  const lines = fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean); const head = lines[0].split(','); const rows = [];
  for (const l of lines.slice(1)) { const c = l.split(','); const v = {}; for (let i = 2; i < head.length; i++) v[head[i]] = c[i] === '' || c[i] == null ? null : num(c[i]); rows.push({ ticker: c[0], date: c[1], v, y: {} }); }
  return rows;
}
export function loadPrices(dir, tickers) {
  const out = new Map();
  for (const t of tickers) {
    const j = loadJson(path.join(dir, 'ohlc1d', t, 'series.json')); const rows = rowsOf(j).map((r) => ({ d: String(r.date || '').slice(0, 10), c: num(r.close) })).filter((r) => r.d && r.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1));
    if (rows.length > 10) out.set(t, { dates: rows.map((r) => r.d), close: rows.map((r) => r.c), idx: new Map(rows.map((r, i) => [r.d, i])) });
  }
  return out;
}
const hash01 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000003) / 1000003; };
export function attachLabels(rows, prices, horizons) {
  const kept = [];
  for (const r of rows) {
    const p = prices.get(r.ticker); const i = p && p.idx.get(r.date); if (i == null) continue;
    let any = false; for (const h of horizons) { r.y[h] = i + h < p.close.length ? p.close[i + h] / p.close[i] - 1 : null; if (r.y[h] != null) any = true; }
    if (!any) continue;
    r.v.mom1 = i >= 1 ? p.close[i] / p.close[i - 1] - 1 : null; r.v.mom5 = i >= 5 ? p.close[i] / p.close[i - 5] - 1 : null; r.v.random = hash01(`${r.ticker}|${r.date}`);
    kept.push(r);
  }
  return kept;
}
export function normalize(rows, win = 20, minHist = 5) {          // value / mean(|value|) over the ticker's own PRIOR sessions
  const by = new Map(); for (const r of rows) { if (!by.has(r.ticker)) by.set(r.ticker, []); by.get(r.ticker).push(r); }
  for (const list of by.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const c of FEATURE_COLS) {
      if (SIZE_COLS.has(c)) continue; const hist = [];
      for (const r of list) {
        const v = r.v[c]; const prev = hist.slice(-win);
        r.v[`${c}_n`] = v != null && prev.length >= minHist ? v / (mean(prev.map(Math.abs)) || NaN) : null;
        if (r.v[`${c}_n`] != null && !Number.isFinite(r.v[`${c}_n`])) r.v[`${c}_n`] = null;
        if (v != null) hist.push(v);
      }
    }
  }
}
function decileSpread(xs, ys) {
  const n = xs.length; const k = Math.max(3, Math.floor(n * 0.1)); const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const yw = winsor(ys); const top = order.slice(n - k).map((i) => yw[i]), bot = order.slice(0, k).map((i) => yw[i]); return mean(top) - mean(bot);
}
export function evaluate({ rows, horizons = [1, 3, 5], minNames = 30, costBps = 10, alpha = 0.05 }) {
  const byDate = new Map(); for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
  const dates = [...byDate.keys()].sort();
  const cols = new Set(); for (const r of rows) for (const k of Object.keys(r.v)) if (!SIZE_COLS.has(k)) cols.add(k);
  const feats = [...cols].sort(); const results = [];
  for (const f of feats) for (const h of horizons) {
    const days = [];
    for (const d of dates) {
      const xs = [], ys = [], px = [], py = [], pm = [];
      for (const r of byDate.get(d)) {
        const x = r.v[f], y = r.y[h]; if (x != null && y != null && Number.isFinite(x)) { xs.push(x); ys.push(y); const m = r.v.mom1; if (m != null && Number.isFinite(m)) { px.push(x); py.push(y); pm.push(m); } }
      }
      if (xs.length < minNames) continue;
      days.push({ d, ic: spearman(xs, ys), pic: f === 'mom1' || px.length < minNames ? null : partialSpearman(px, py, pm), spread: decileSpread(xs, ys), n: xs.length });
    }
    const valid = days.filter((x) => x.ic != null); if (valid.length < 10) continue;
    const non = valid.filter((_, i) => i % h === 0); const ics = non.map((x) => x.ic); const sdv = sd(ics);
    const t = sdv ? mean(ics) / (sdv / Math.sqrt(ics.length)) : null; const all = valid.map((x) => x.ic); const sdAll = sd(all);
    const half = Math.floor(valid.length / 2); const sp = non.map((x) => x.spread * 1e4);
    const pv = valid.filter((x) => x.pic != null); const pNon = pv.filter((_, i) => i % h === 0).map((x) => x.pic); const pSd = sd(pNon);
    results.push({ feature: f, h, pIC: pv.length >= 10 ? mean(pv.map((x) => x.pic)) : null, pT: pSd ? mean(pNon) / (pSd / Math.sqrt(pNon.length)) : null, nDays: valid.length, nIndep: non.length, avgNames: Math.round(mean(valid.map((x) => x.n))), meanIC: mean(all), tNonOverlap: t, tNaive: sdAll ? mean(all) / (sdAll / Math.sqrt(all.length)) : null, posDays: valid.filter((x) => x.ic > 0).length / valid.length, icFirstHalf: mean(valid.slice(0, half).map((x) => x.ic)), icSecondHalf: mean(valid.slice(half).map((x) => x.ic)), spreadBps: mean(sp), netSpreadBps: mean(sp) - costBps });
  }
  const nTests = results.length; const thr = nTests ? normInv(1 - alpha / (2 * nTests)) : null;
  for (const r of results) { r.significant = r.tNonOverlap != null && thr != null && Math.abs(r.tNonOverlap) > thr; r.significantPartial = r.pT != null && thr != null && Math.abs(r.pT) > thr; }
  return { results, nTests, bonferroniT: thr, nRows: rows.length, nDays: dates.length, firstDate: dates[0], lastDate: dates[dates.length - 1] };
}
export function formatReport(rep, { top = 12 } = {}) {
  const f = (v, d = 3) => (v == null ? '   n/a' : v.toFixed(d).padStart(7)); const lines = [];
  lines.push(`Backtest: ${rep.nRows} ticker-days, ${rep.nDays} days (${rep.firstDate}..${rep.lastDate}); ${rep.nTests} tests; Bonferroni |t| threshold = ${rep.bonferroniT ? rep.bonferroniT.toFixed(2) : 'n/a'}`);
  lines.push("IC = daily cross-sectional Spearman vs close-to-close return from the signal day close. t = non-overlapping days. spread = top minus bottom decile (bps), net of the cost assumption. IC ex-mom1 = same IC after removing the effect of the signal day's own return (1-day reversal).\n");
  for (const h of [...new Set(rep.results.map((r) => r.h))]) {
    lines.push(`--- horizon ${h} trading day(s) ---`); lines.push('feature            meanIC   t(non-ov)  days  +days%  IC 1st/2nd half     spread  net   | IC ex-mom1  t   sig');
    const rs = rep.results.filter((r) => r.h === h && !['mom1', 'mom5', 'random'].includes(r.feature)).sort((a, b) => Math.abs(b.tNonOverlap ?? 0) - Math.abs(a.tNonOverlap ?? 0)).slice(0, top);
    const base = rep.results.filter((r) => r.h === h && ['mom1', 'mom5', 'random'].includes(r.feature));
    for (const r of [...rs, ...base]) lines.push(`${r.feature.padEnd(18)} ${f(r.meanIC)} ${f(r.tNonOverlap, 2)} ${String(r.nDays).padStart(5)} ${(r.posDays * 100).toFixed(0).padStart(6)}%  ${f(r.icFirstHalf)} /${f(r.icSecondHalf)} ${f(r.spreadBps, 1)} ${f(r.netSpreadBps, 1)}   | ${f(r.pIC)} ${f(r.pT, 2)}   ${r.significant ? 'YES' : r.significantPartial ? 'YES(p)' : '-'}${['mom1', 'mom5', 'random'].includes(r.feature) ? '  (baseline)' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- data-quality check: do the daily closes agree with the 5-minute bars' regular-session close? -------------------------
export function compareDailyToBars({ dir, tickers, maxTickers = 80, tol = 0.003 }) {
  const out = { tickers: 0, compared: 0, same: 0, prevDay: 0, nextDay: 0, other: 0, medianAbsDiffPct: null, worst: [], marketTime: {} };
  const diffs = []; const worst = [];
  for (const t of tickers.slice(0, maxTickers)) {
    const dp = loadPrices(dir, [t]).get(t); if (!dp) continue;
    const j = loadJson(path.join(dir, 'ohlc1d', t, 'series.json')); for (const r of rowsOf(j)) { const k = String(r.market_time ?? 'none'); out.marketTime[k] = (out.marketTime[k] || 0) + 1; }
    let files = []; try { files = fs.readdirSync(path.join(dir, 'bars5m', t)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json/.test(f)); } catch { continue; }
    const rth = new Map();
    for (const f of files) {
      const d = f.slice(0, 10); const cutoff = Date.parse(etDayBounds(d)[0]) + 16 * 3600000; let best = null;
      for (const b of rowsOf(loadJson(path.join(dir, 'bars5m', t, `${d}.json`)))) { const e = Date.parse(b.end_time || ''); const c = num(b.close); if (Number.isFinite(e) && c > 0 && e <= cutoff && e > cutoff - 24 * 3600000 && (!best || e > best.e)) best = { e, c }; }
      if (best) rth.set(d, best.c);
    }
    let any = false;
    for (const [d, bc] of rth) {
      const i = dp.idx.get(d); if (i == null) continue; any = true; const daily = dp.close[i]; const diff = Math.abs(daily / bc - 1); diffs.push(diff); out.compared++;
      const pv = i > 0 ? rth.get(dp.dates[i - 1]) : null, nx = i + 1 < dp.dates.length ? rth.get(dp.dates[i + 1]) : null;
      if (diff < tol) out.same++; else if (pv && Math.abs(daily / pv - 1) < tol) out.prevDay++; else if (nx && Math.abs(daily / nx - 1) < tol) out.nextDay++; else out.other++;
      worst.push({ t, d, daily, bars: bc, diffPct: diff * 100 });
    }
    if (any) out.tickers++;
  }
  diffs.sort((a, b) => a - b); out.medianAbsDiffPct = diffs.length ? diffs[Math.floor(diffs.length / 2)] * 100 : null;
  out.worst = worst.sort((a, b) => b.diffPct - a.diffPct).slice(0, 6); return out;
}

// ---- pre-registered single hypothesis ---------------------------------------------------------------------------------------
export function normCdf(z) {                                  // Abramowitz-Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p;
}
export function primaryVerdict(rep, feature, h, { tCrit = 1.96 } = {}) {
  const r = rep.results.find((x) => x.feature === feature && x.h === h); if (!r) return null;
  const p = r.tNonOverlap == null ? null : 2 * (1 - normCdf(Math.abs(r.tNonOverlap)));
  return { feature, h, nDays: r.nDays, nIndep: r.nIndep, meanIC: r.meanIC, t: r.tNonOverlap, pTwoSided: p, partialIC: r.pIC, partialT: r.pT, icFirstHalf: r.icFirstHalf, icSecondHalf: r.icSecondHalf, netSpreadBps: r.netSpreadBps, pass: r.meanIC > 0 && r.tNonOverlap != null && r.tNonOverlap >= tCrit };
}
