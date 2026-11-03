// Baseline evaluation harness. Pure functions: measures engines, never feeds back into scoring.
//
// Honest-evaluation rules implemented here:
//  - production, v2 and the frozen legacy score are each evaluated with returns signed by THEIR OWN direction;
//  - returns can be market-adjusted (SPY over the same window, signed by direction);
//  - rank IC is reported pooled AND cross-sectionally per scan timestamp (Fama-MacBeth style mean + t-stat);
//  - the pooled IC uses at most one observation per ticker per ET day per horizon (clustered signals are not independent);
//  - bootstrap 95% CIs (seeded, deterministic) for IC and top-decile precision;
//  - baselines to beat: a seeded random score and a momentum-only score;
//  - records are grouped by optionsEngineVersion so different engine versions are never pooled.
import { etDate } from '../lib/time.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (isNum(x) ? Math.round(x * 10000) / 10000 : null);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => { if (xs.length < 2) return null; const m = avg(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
const sgn = (d) => (d === 'bull' ? 1 : d === 'bear' ? -1 : 0);

// deterministic PRNG so reports are reproducible
export function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Spearman rank IC between score and forward return.
export function rankIC(pairs) {
  const p = pairs.filter((x) => isNum(x.score) && isNum(x.ret));
  const n = p.length;
  if (n < 3) return { ic: null, n, gated: true, reason: 'need >= 3 observations' };
  const rank = (key) => {
    const idx = p.map((v, i) => ({ i, v: v[key] })).sort((a, b) => a.v - b.v);
    const r = new Array(n);
    let k = 0;
    while (k < n) {                                  // average ranks for ties
      let j = k; while (j + 1 < n && idx[j + 1].v === idx[k].v) j++;
      const mean = (k + j) / 2 + 1;
      for (let m = k; m <= j; m++) r[idx[m].i] = mean;
      k = j + 1;
    }
    return r;
  };
  const rs = rank('score'), rr = rank('ret');
  const ms = avg(rs), mr = avg(rr);
  let num = 0, ds = 0, dr = 0;
  for (let i = 0; i < n; i++) { const a = rs[i] - ms, b = rr[i] - mr; num += a * b; ds += a * a; dr += b * b; }
  const ic = ds > 0 && dr > 0 ? num / Math.sqrt(ds * dr) : null;
  return { ic: r4(ic), n, gated: n < 30, note: n < 30 ? 'low sample — treat as indicative only' : (isNum(ic) && Math.abs(ic) > 0.10 ? 'IC > 0.10 is suspicious; check for look-ahead/overfitting' : null) };
}

// Precision of the top decile by score (fraction with positive forward return).
export function topDecilePrecision(pairs) {
  const p = pairs.filter((x) => isNum(x.score) && isNum(x.ret)).sort((a, b) => b.score - a.score);
  if (p.length < 10) return { precision: null, n: p.length, gated: true };
  const k = Math.max(1, Math.floor(p.length / 10));
  const top = p.slice(0, k);
  return { precision: r2((top.filter((x) => x.ret > 0).length / k) * 100), n: k, baseline: r2((p.filter((x) => x.ret > 0).length / p.length) * 100), gated: p.length < 50 };
}

// Calibration: does a score of ~80 win ~80% of the time?
export function calibration(pairs, buckets = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]]) {
  return buckets.map(([lo, hi]) => {
    const inB = pairs.filter((x) => isNum(x.score) && isNum(x.ret) && x.score >= lo && x.score < hi);
    return { range: `${lo}-${hi === 101 ? 100 : hi - 1}`, n: inB.length, hitRate: inB.length ? r2((inB.filter((x) => x.ret > 0).length / inB.length) * 100) : null, avgReturn: r2(avg(inB.map((x) => x.ret))), gated: inB.length < 30 };
  });
}

// Seeded bootstrap 95% CI for a pair statistic (rankIC.ic or topDecile.precision).
export function bootstrapCI(pairs, stat, { B = 300, seed = 7 } = {}) {
  const p = pairs.filter((x) => isNum(x.score) && isNum(x.ret));
  if (p.length < 20) return { lo: null, hi: null, n: p.length, gated: true };
  const rnd = mulberry32(seed), vals = [];
  for (let b = 0; b < B; b++) {
    const s = new Array(p.length); for (let i = 0; i < p.length; i++) s[i] = p[Math.floor(rnd() * p.length)];
    const v = stat(s); if (isNum(v)) vals.push(v);
  }
  if (vals.length < B / 2) return { lo: null, hi: null, n: p.length, gated: true };
  vals.sort((a, b) => a - b);
  return { lo: r4(vals[Math.floor(0.025 * vals.length)]), hi: r4(vals[Math.min(vals.length - 1, Math.floor(0.975 * vals.length))]), n: p.length, B, gated: false };
}

// Cross-sectional rank IC per scan timestamp, averaged across timestamps with a t-stat (Fama-MacBeth style).
export function crossSectionalIC(rows, { scoreKey, retKey, minPerGroup = 5, groupKey = 'scanKey' } = {}) {
  const groups = new Map();
  for (const r of rows) { if (!isNum(r[scoreKey]) || !isNum(r[retKey]) || r[groupKey] == null) continue; if (!groups.has(r[groupKey])) groups.set(r[groupKey], []); groups.get(r[groupKey]).push({ score: r[scoreKey], ret: r[retKey] }); }
  const ics = [];
  for (const g of groups.values()) { if (g.length < minPerGroup) continue; const ic = rankIC(g).ic; if (isNum(ic)) ics.push(ic); }
  const T = ics.length, m = avg(ics), s = sd(ics);
  return { meanIC: T ? r4(m) : null, tStat: T >= 3 && s > 0 ? r2(m / (s / Math.sqrt(T))) : null, periods: T, gated: T < 10 };
}

function statsOf(rows) {
  const rets = rows.map((r) => r.ret).filter(isNum);
  const wins = rets.filter((r) => r > 0).length, losses = rets.filter((r) => r <= 0).length;
  return {
    n: rows.length, hitRate: rets.length ? r2((wins / rets.length) * 100) : null,
    avgReturn: r2(avg(rets)), winLossRatio: losses ? r2(wins / losses) : null,
    avgMFE: r2(avg(rows.map((r) => r.mfe).filter(isNum))), avgMAE: r2(avg(rows.map((r) => r.mae).filter(isNum))),
    avgAtrReturn: r2(avg(rows.map((r) => r.atrRet).filter(isNum))),
    targetRate: r2((rows.filter((r) => r.outcome === 'TARGET').length / (rows.length || 1)) * 100),
    stopRate: r2((rows.filter((r) => r.outcome === 'STOP').length / (rows.length || 1)) * 100),
    gated: rows.length < 30,
  };
}

const groupBy = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([key, rs]) => ({ key, ...statsOf(rs) })).sort((a, b) => (b.avgReturn ?? -999) - (a.avgReturn ?? -999));
};

// Flatten journal records into evaluation rows for one horizon. Each engine's return is signed by ITS OWN direction.
export function toRows(records, horizon = '30m') {
  const out = [];
  for (const r of records || []) {
    const o = r.outcomes && r.outcomes[horizon];
    if (!o || o.status !== 'resolved') continue;
    const ctx = r.context || {}, comp = r.composite || {};
    const stockRet = isNum(o.stockChangePct) ? o.stockChangePct : null;          // unsigned stock return over the window
    const bench = isNum(o.benchmarkReturnPct) ? o.benchmarkReturnPct : null;     // SPY over the same window (unsigned)
    const signed = (dir) => { const s = sgn(dir); return stockRet != null && s !== 0 ? stockRet * s : null; };
    const adj = (dir) => { const s = sgn(dir); return stockRet != null && bench != null && s !== 0 ? (stockRet - bench) * s : null; };
    const prodDir = comp.dir;
    const prodRet = signed(prodDir) ?? (sgn(prodDir) !== 0 && isNum(o.directionalReturnPct) ? o.directionalReturnPct : null);
    const v2 = r.v2 && isNum(r.v2.score) && !r.v2.gated && r.v2.score > 0 ? r.v2 : null;     // gated rows (published score 0) are excluded
    const legacy = r.legacy && isNum(r.legacy.finalScore) ? r.legacy : null;
    const fired = Date.parse(r.firedAt);
    const px = r.entry && isNum(r.entry.stockPrice) ? r.entry.stockPrice : null;
    const vwapDistAtr = (px != null && isNum(ctx.vwap) && isNum(ctx.atr) && ctx.atr > 0) ? (px - ctx.vwap) / ctx.atr : null;
    out.push({
      id: r.id, ticker: r.ticker, firedAt: r.firedAt, version: comp.optionsEngineVersion || r.optionsEngineVersion || 'unknown',
      etDay: etDate(fired), scanKey: Number.isFinite(fired) ? Math.floor(fired / 1800000) : null,
      score: sgn(prodDir) !== 0 ? comp.finalScore : null, dir: prodDir,
      ret: prodRet, adjRet: adj(prodDir),
      v2Score: v2 ? v2.score : null, v2Dir: v2 ? v2.dir : null, v2Ret: v2 ? signed(v2.dir) : null, v2AdjRet: v2 ? adj(v2.dir) : null, v2State: r.v2 ? r.v2.state : null,
      legacyScore: legacy && sgn(legacy.dir) !== 0 ? legacy.finalScore : null, legacyRet: legacy ? signed(legacy.dir) : null,
      momScore: vwapDistAtr != null && sgn(prodDir) !== 0 ? vwapDistAtr * sgn(prodDir) : null,
      atrRet: o.atrNormalizedReturn, mfe: o.maxFavorablePct, mae: o.maxAdversePct, outcome: o.outcome,
      gammaRegime: ctx.gammaRegime || null, timeOfDay: ctx.timeOfDayBucket || null,
      marketRegime: ctx.marketRegime || null, rvolBucket: isNum(ctx.rvol) ? (ctx.rvol >= 1.5 ? 'high' : 'normal/low') : null,
    });
  }
  return out;
}

// One observation per ticker per ET day (the earliest): clustered same-day signals are not independent samples.
export function dedupeDaily(rows, { scoreKey, retKey }) {
  const seen = new Set(), out = [];
  for (const r of [...rows].sort((a, b) => String(a.firedAt).localeCompare(String(b.firedAt)))) {
    if (!isNum(r[scoreKey]) || !isNum(r[retKey])) continue;
    const k = `${r.ticker}|${r.etDay}`; if (seen.has(k)) continue; seen.add(k); out.push(r);
  }
  return out;
}

function metricsFor(rows, scoreKey, retKey) {
  const dd = dedupeDaily(rows, { scoreKey, retKey });
  const pairs = dd.map((r) => ({ score: r[scoreKey], ret: r[retKey] }));
  return {
    pooledIC: rankIC(pairs),                                         // deduped: <= 1 obs / ticker / ET day
    pooledICci: bootstrapCI(pairs, (s) => rankIC(s).ic),
    crossSectional: crossSectionalIC(rows, { scoreKey, retKey }),    // per scan timestamp, mean + t-stat
    topDecile: topDecilePrecision(pairs),
    topDecileCI: bootstrapCI(pairs, (s) => { const t = topDecilePrecision(s); return t.precision; }),
    nDeduped: pairs.length,
  };
}

function horizonReport(rows) {
  const s = statsOf(rows.filter((r) => isNum(r.ret)));
  const prodPairs = rows.filter((r) => isNum(r.score) && isNum(r.ret)).map((r) => ({ score: r.score, ret: r.ret }));
  const prod = metricsFor(rows, 'score', 'ret');
  const v2m = metricsFor(rows, 'v2Score', 'v2Ret');
  const rnd = mulberry32(12345);
  const randomRows = rows.filter((r) => isNum(r.score) && isNum(r.ret)).map((r) => ({ ...r, randScore: rnd() }));
  return {
    ...s,
    rankIC: prod.pooledIC, rankICci: prod.pooledICci, crossSectionalIC: prod.crossSectional, topDecile: prod.topDecile, topDecileCI: prod.topDecileCI, nDeduped: prod.nDeduped,
    calibration: calibration(prodPairs),
    adjusted: { rankIC: metricsFor(rows, 'score', 'adjRet').pooledIC, avgReturn: r2(avg(rows.map((r) => r.adjRet).filter(isNum))) },
    v2: v2m,
    v2RankIC: v2m.pooledIC,                                           // kept for the promotion gate
    v2TopDecile: v2m.topDecile,
    legacy: metricsFor(rows, 'legacyScore', 'legacyRet'),
    baselines: {
      random: metricsFor(randomRows, 'randScore', 'ret').pooledIC,    // should be ~0; a score that cannot beat this has no signal
      momentumOnly: metricsFor(rows, 'momScore', 'ret'),              // price-vs-VWAP in ATR only
    },
  };
}

function reportFor(records, horizons) {
  const byHorizon = {};
  for (const h of horizons) byHorizon[h] = horizonReport(toRows(records, h));
  const primary = toRows(records, '30m').filter((r) => isNum(r.ret));
  return {
    generatedAt: new Date().toISOString(),
    totals: { signals: (records || []).length, evaluated: primary.length, bullish: primary.filter((r) => r.dir === 'bull').length, bearish: primary.filter((r) => r.dir === 'bear').length },
    byHorizon,
    byScoreBucket: byHorizon['30m'] ? byHorizon['30m'].calibration : [],
    byGammaRegime: groupBy(primary, (r) => r.gammaRegime),
    byTimeOfDay: groupBy(primary, (r) => r.timeOfDay),
    byMarketRegime: groupBy(primary, (r) => r.marketRegime),
    byRvol: groupBy(primary, (r) => r.rvolBucket),
    byV2State: groupBy(toRows(records, '30m').filter((r) => isNum(r.v2Ret)).map((r) => ({ ...r, ret: r.v2Ret })), (r) => r.v2State),
    byTicker: groupBy(primary, (r) => r.ticker).slice(0, 25),
  };
}

// Full report. Records are split by optionsEngineVersion so versions are NEVER pooled; the top-level fields are the
// latest version's report (existing consumers keep working), and `byVersion` has every version.
export function baselineReport(records, { horizons = ['15m', '30m', '60m', 'close'], version = null } = {}) {
  const all = records || [];
  const verOf = (r) => (r.composite && r.composite.optionsEngineVersion) || r.optionsEngineVersion || 'unknown';
  const versions = [...new Set(all.map(verOf))].sort();
  const byVersion = {};
  for (const v of versions) byVersion[v] = reportFor(all.filter((r) => verOf(r) === v), horizons);
  const pick = version && byVersion[version] ? version : (versions[versions.length - 1] || null);
  const main = pick ? byVersion[pick] : reportFor([], horizons);
  return {
    ...main, engineVersion: pick, versions, byVersion,
    note: 'Engine versions are never pooled. Pooled IC keeps one observation per ticker per ET day; cross-sectional IC is per scan timestamp. Groups with n < 30 are gated as indicative only. Rank IC above 0.10 usually means look-ahead bias, not skill.',
  };
}

export { statsOf };
