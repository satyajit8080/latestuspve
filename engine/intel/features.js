// engine/intel/features.js — features from normalized data. Pure functions; every feature is null when its inputs are missing.
import { etDate, etCalendarDaysUntil } from '../../lib/time.js';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + (f(x) ?? 0), 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const stdev = (a) => { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(sum(a, (x) => (x - m) ** 2) / (a.length - 1)); };
export const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
export const MIN_FLOW_PREMIUM = 250000;     // below this the flow evidence is scaled down: a small print is not a signal

export function flowFeatures(alerts) {
  if (!alerts || !alerts.length) return null;
  const single = alerts.filter((a) => !a.multileg); const multi = alerts.filter((a) => a.multileg);
  const callAsk = sum(single.filter((a) => a.right === 'call'), (a) => a.askPrem), callBid = sum(single.filter((a) => a.right === 'call'), (a) => a.bidPrem);
  const putAsk = sum(single.filter((a) => a.right === 'put'), (a) => a.askPrem), putBid = sum(single.filter((a) => a.right === 'put'), (a) => a.bidPrem);
  const singlePrem = sum(single, (a) => a.premium), multiPrem = sum(multi, (a) => a.premium), total = singlePrem + multiPrem;
  const signed = callAsk - callBid - (putAsk - putBid);             // calls bought/puts sold = +, puts bought/calls sold = -
  const gross = callAsk + callBid + putAsk + putBid;
  const openPrem = sum(single.filter((a) => a.opening), (a) => a.premium);
  const callPrem = sum(alerts.filter((a) => a.right === 'call'), (a) => a.premium), putPrem = sum(alerts.filter((a) => a.right === 'put'), (a) => a.premium);
  const earn = alerts.map((a) => a.nextEarnings).filter(Boolean); let daysToEarnings = null; for (const e of earn) { const d = etCalendarDaysUntil(e, alerts[alerts.length - 1].ts || Date.now()); if (d != null && d >= 0 && (daysToEarnings == null || d < daysToEarnings)) daysToEarnings = d; }
  return { n: alerts.length, nSingle: single.length, nMulti: multi.length, totalPremium: total, singlePremium: singlePrem, multiPremium: multiPrem, callPremium: callPrem, putPremium: putPrem, callAsk, callBid, putAsk, putBid, signedPremium: signed,
    imbalance: gross > 0 ? clamp(signed / gross, -1, 1) : null, openingShare: singlePrem > 0 ? openPrem / singlePrem : null, sweepShare: total > 0 ? sum(alerts.filter((a) => a.sweep), (a) => a.premium) / total : null, largeShare: total > 0 ? sum(alerts.filter((a) => a.premium >= 500000), (a) => a.premium) / total : null,
    multiLegShare: total > 0 ? multiPrem / total : null, unusualCount: alerts.filter((a) => a.volOi != null && a.volOi >= 1 && a.opening && !a.multileg).length, callPutRatio: putPrem > 0 ? callPrem / putPrem : null, daysToEarnings,
    lastAlertAt: alerts[alerts.length - 1].ts, spot: [...alerts].reverse().map((a) => a.spot).find(isNum) ?? null, marketCap: alerts.map((a) => a.marketCap).find(isNum) ?? null, sector: alerts.map((a) => a.sector).find(Boolean) ?? null,
    topPrints: [...alerts].sort((a, b) => b.premium - a.premium).slice(0, 10) };
}
export function tapeFeatures(ticks, { nowMs = Date.now() } = {}) {
  if (!ticks || !ticks.length) return null;
  const net = ticks.map((x) => (x.netCall ?? 0) - (x.netPut ?? 0)); const gross = sum(ticks, (x) => Math.abs(x.netCall ?? 0) + Math.abs(x.netPut ?? 0));
  const total = sum(net); const timed = ticks.filter((x) => x.t != null); const recent = timed.filter((x) => x.t >= nowMs - 30 * 60000);
  const recentNet = recent.length ? sum(recent, (x) => (x.netCall ?? 0) - (x.netPut ?? 0)) : null;
  const cum = []; let c = 0, cc = 0, cp = 0; for (const x of ticks) { c += (x.netCall ?? 0) - (x.netPut ?? 0); cc += x.netCall ?? 0; cp += x.netPut ?? 0; cum.push({ t: x.t, net: c, call: cc, put: cp }); }
  return { n: ticks.length, netPremium: total, recentNet30m: recentNet, imbalance: gross > 0 ? clamp(total / gross, -1, 1) : null, netDelta: ticks.some((x) => x.netDelta != null) ? sum(ticks, (x) => x.netDelta) : null, series: cum.length > 120 ? cum.filter((_, i) => i % Math.ceil(cum.length / 120) === 0 || i === cum.length - 1) : cum };
}
export function oiFeatures(contracts) {
  if (!contracts || !contracts.length) return null;
  const calls = contracts.filter((c) => c.type === 'call'), puts = contracts.filter((c) => c.type === 'put');
  const cd = sum(calls, (c) => c.diff), pd = sum(puts, (c) => c.diff), abs = sum(contracts, (c) => Math.abs(c.diff));
  const hits = contracts.filter((c) => c.volume != null && c.curr > 0 && c.volume / c.curr >= 1 && c.volume >= 500);
  return { n: contracts.length, callChange: cd, putChange: pd, net: cd - pd, imbalance: abs > 0 ? clamp((cd - pd) / abs, -1, 1) : null, volOiHits: hits.length, top: [...contracts].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 12) };
}
export function gexFeatures({ levels, greek, price }) {
  if (!levels && !(greek && greek.length)) return null;
  const g = greek && greek.length ? greek[greek.length - 1] : null; const lv = levels || {};
  const dist = (L) => (isNum(L) && isNum(price) && price > 0 ? (L - price) / price : null);
  const d = { callWall: dist(lv.callWall), putWall: dist(lv.putWall), gammaFlip: dist(lv.gammaFlip), gammaMagnet: dist(lv.gammaMagnet) };
  const near = Object.entries(d).filter(([, v]) => v != null && Math.abs(v) <= 0.015).map(([k]) => k);
  return { callWall: lv.callWall ?? null, putWall: lv.putWall ?? null, gammaFlip: lv.gammaFlip ?? null, gammaMagnet: lv.gammaMagnet ?? null, nearbyFlips: lv.nearbyFlips || [], levelsAsOf: lv.time || lv.date || null, dist: d, approaching: near,
    netGamma: g ? g.netGamma : null, callGamma: g ? g.callGamma : null, putGamma: g ? g.putGamma : null, greekDate: g ? g.date : null, regime: g && g.netGamma != null ? (g.netGamma > 0 ? 'positive' : g.netGamma < 0 ? 'negative' : 'neutral') : null,
    series: (greek || []).slice(-60) };
}
export function priceFeatures({ bars1d = [], bars5m = { bars: [], date: null }, nowMs = Date.now(), session = 'closed' }) {
  const today = etDate(nowMs); const complete = bars1d.filter((b) => b.d < today || session !== 'open'); if (complete.length < 6) return null;
  const sess = bars5m.bars || []; const live = session === 'open' && sess.length ? sess[sess.length - 1].c : null; const last = complete[complete.length - 1];
  const price = live ?? last.c; const prevClose = session === 'open' ? last.c : (complete[complete.length - 2] ? complete[complete.length - 2].c : null);
  const closes = complete.map((b) => b.c); const rets = []; for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const tr = []; for (let i = 1; i < complete.length; i++) tr.push(Math.max(complete[i].h - complete[i].l, Math.abs(complete[i].h - complete[i - 1].c), Math.abs(complete[i].l - complete[i - 1].c)));
  const atr = tr.length >= 14 ? mean(tr.slice(-14)) : null; const prior20 = complete.slice(-(session === 'open' ? 20 : 21), session === 'open' ? undefined : -1);
  const hi20 = prior20.length >= 10 ? Math.max(...prior20.map((b) => b.h)) : null, lo20 = prior20.length >= 10 ? Math.min(...prior20.map((b) => b.l)) : null;
  const vols = complete.slice(-20).map((b) => b.v).filter(isNum); const avgVol = vols.length >= 10 ? mean(vols) : null;
  let rvol = null, rvolBasis = null; if (avgVol > 0) { if (session === 'open' && sess.length) { const el = clamp(sess.length * 5 / 390, 0.05, 1); rvol = sum(sess, (b) => b.v) / (avgVol * el); rvolBasis = 'session so far vs 20-day average'; } else if (isNum(last.v)) { rvol = last.v / avgVol; rvolBasis = 'last full day vs 20-day average'; } }
  let vwap = null; if (sess.length) { const pv = sum(sess, (b) => ((b.h + b.l + b.c) / 3) * b.v), v = sum(sess, (b) => b.v); vwap = v > 0 ? pv / v : null; }
  const r20 = rets.slice(-20); const sd = stdev(r20);
  return { price, asOf: live != null ? sess[sess.length - 1].t : null, lastCloseDate: last.d, prevClose, chgPct: isNum(prevClose) && prevClose > 0 ? price / prevClose - 1 : null, atr, atrPct: isNum(atr) ? atr / price : null, mom5: closes.length > 5 ? closes[closes.length - 1] / closes[closes.length - 6] - 1 : null,
    ret20: closes.length > 20 ? closes[closes.length - 1] / closes[closes.length - 21] - 1 : null, hi20, lo20, breakoutUp: isNum(hi20) ? price > hi20 : null, breakoutDown: isNum(lo20) ? price < lo20 : null, rvol, rvolBasis, vwap, vsVwapPct: isNum(vwap) && vwap > 0 ? price / vwap - 1 : null, rv20: sd != null ? sd * Math.sqrt(252) : null,
    closes: complete.slice(-60).map((b) => ({ d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })), session5m: sess.map((b) => ({ t: b.t, c: b.c, v: b.v })) };
}
export function volFeatures({ iv, term, skew, rv20 }) {
  if (!iv && !(term && term.length) && !(skew && skew.length)) return null;
  const front = (term || []).find((r) => r.dte >= 5) || null; const back = (term || []).find((r) => r.dte >= 25) || null; const m30 = (term || []).find((r) => r.dte >= 20 && r.dte <= 45) || back;
  const rr = skew && skew.length ? skew[skew.length - 1].rr : null; const ivNow = m30 ? m30.iv : (iv ? iv.iv : null);
  return { ivRank: iv ? iv.ivRank : null, iv: ivNow, ivDate: iv ? iv.date : null, termSlope: front && back && back.dte > front.dte ? back.iv - front.iv : null, term: term || [], impliedMovePct: front ? front.impliedMovePct : null, impliedMoveDte: front ? front.dte : null, rr25: rr, rv20: rv20 ?? null, ivRvRatio: isNum(ivNow) && isNum(rv20) && rv20 > 0 ? ivNow / rv20 : null };
}
export function liquidityFeatures(contracts) {
  if (!contracts || !contracts.length) return null;
  const pool = contracts.filter((c) => c.dte >= 5 && c.dte <= 60 && c.delta != null); const pick = (type) => pool.filter((c) => c.type === type && c.spreadPct != null && c.mid > 0).sort((a, b) => Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5))[0] || null;
  const c = pick('call'), p = pick('put'); const sp = [c, p].filter(Boolean).map((x) => x.spreadPct); const spread = sp.length ? mean(sp) : null;
  const vol = sum(contracts, (x) => x.volume), oi = sum(contracts, (x) => x.oi);
  const level = spread == null ? null : spread <= 0.05 && vol >= 20000 ? 'HIGH' : spread <= 0.12 && vol >= 3000 ? 'MED' : 'LOW';
  return { atmSpreadPct: spread, optVolume: vol, optOI: oi, level, atmCall: c ? { symbol: c.symbol, mid: c.mid, spreadPct: c.spreadPct } : null, atmPut: p ? { symbol: p.symbol, mid: p.mid, spreadPct: p.spreadPct } : null };
}
export function greeksSummary(contracts) {
  const pool = (contracts || []).filter((c) => c.delta != null && c.volume > 0); if (!pool.length) return null;
  const w = (f) => sum(pool, (c) => (f(c) ?? 0) * c.volume * 100); const calls = pool.filter((c) => c.type === 'call'), puts = pool.filter((c) => c.type === 'put');
  return { deltaExposure: w((c) => c.delta), gammaExposure: w((c) => c.gamma), vegaExposure: w((c) => c.vega), thetaExposure: w((c) => c.theta), callVolume: sum(calls, (c) => c.volume), putVolume: sum(puts, (c) => c.volume), contracts: pool.length };
}
export function oiHeatmap(contracts, spot, { maxStrikes = 14, maxExpiries = 6 } = {}) {
  if (!contracts || !contracts.length) return null; const byExp = new Map(); for (const c of contracts) byExp.set(c.expiry, (byExp.get(c.expiry) || 0) + Math.abs(c.diff));
  const expiries = [...byExp.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxExpiries).map(([e]) => e).sort();
  const byStrike = new Map(); for (const c of contracts) if (expiries.includes(c.expiry)) byStrike.set(c.strike, (byStrike.get(c.strike) || 0) + Math.abs(c.diff));
  let strikes = [...byStrike.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxStrikes).map(([s]) => s).sort((a, b) => a - b);
  const cell = new Map(); for (const c of contracts) { if (!expiries.includes(c.expiry) || !strikes.includes(c.strike)) continue; const k = `${c.strike}|${c.expiry}`; cell.set(k, (cell.get(k) || 0) + (c.type === 'call' ? c.diff : -c.diff)); }
  const mx = Math.max(1, ...[...cell.values()].map(Math.abs));
  return { expiries, strikes, cells: strikes.map((s) => expiries.map((e) => { const v = cell.get(`${s}|${e}`); return v == null ? null : { net: v, intensity: Math.min(1, Math.abs(v) / mx) }; })), spot: spot ?? null };
}
