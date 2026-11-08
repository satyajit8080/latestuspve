// engine/intel/normalize.js — raw Unusual Whales payloads -> one provider-neutral internal schema.
// Numbers often arrive as strings. A value that is missing stays null; nothing is defaulted to 0 unless the field means "none".
import { etDate, etMinutes, RTH_OPEN_MIN, RTH_CLOSE_MIN } from '../../lib/time.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const n = (x) => (isNum(x) ? x : (typeof x === 'string' && x.trim() !== '' && Number.isFinite(+x) ? +x : null));
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
export const rowsOf = (j) => { if (Array.isArray(j)) return j; if (j && Array.isArray(j.data)) return j.data; return []; };
export const objOf = (j) => { const d = j && j.data !== undefined ? j.data : j; if (Array.isArray(d)) return d.length ? d[d.length - 1] : null; return d && typeof d === 'object' ? d : null; };
const OCC = /^[.]?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
export function parseOcc(sym) { const m = OCC.exec(String(sym || '').trim()); return m ? { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: parseInt(m[6], 10) / 1000 } : null; }
export const keysOf = (rows) => (rows && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : []);

export function normFlow(rows) {
  const out = [];
  for (const r of rowsOf(rows)) {
    const type = String(r.type || r.option_type || '').toLowerCase(); const right = type.startsWith('c') ? 'call' : type.startsWith('p') ? 'put' : null; if (!right) continue;
    const ts = Date.parse(r.created_at || r.start_time || ''); const ask = n(r.total_ask_side_prem), bid = n(r.total_bid_side_prem);
    out.push({ id: r.id ?? null, ts: Number.isFinite(ts) ? ts : null, right, strike: n(r.strike), expiry: r.expiry || null, premium: n(r.total_premium) ?? ((ask ?? 0) + (bid ?? 0)), askPrem: ask, bidPrem: bid,
      side: ask != null && bid != null ? (ask > bid ? 'ask' : bid > ask ? 'bid' : 'mid') : null, volume: n(r.volume), openInterest: n(r.open_interest), volOi: n(r.volume_oi_ratio), size: n(r.total_size), trades: n(r.trade_count),
      sweep: truthy(r.has_sweep), floor: truthy(r.has_floor), multileg: truthy(r.has_multileg) || (n(r.expiry_count) ?? 1) > 1, opening: truthy(r.all_opening_trades), rule: r.alert_rule || null, spot: n(r.underlying_price), delta: n(r.delta), iv: n(r.iv_end) ?? n(r.iv_start),
      nextEarnings: r.next_earnings_date || null, marketCap: n(r.marketcap), sector: r.sector || null, contract: r.option_chain || null });
  }
  return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}
export const latestSession = (alerts) => { const ts = alerts.map((a) => a.ts).filter(Number.isFinite); if (!ts.length) return { date: null, alerts: [] }; const date = etDate(Math.max(...ts)); return { date, alerts: alerts.filter((a) => a.ts != null && etDate(a.ts) === date) }; };

export function normTape(rows) {
  const timeOf = (r) => { for (const k of ['tape_time', 'timestamp', 'start_time', 'time', 'date']) { const t = Date.parse(r[k] || ''); if (Number.isFinite(t)) return t; } return null; };
  const ticks = rowsOf(rows).map((r) => ({ t: timeOf(r), netCall: n(r.net_call_premium), netPut: n(r.net_put_premium), netDelta: n(r.net_delta) })).filter((x) => x.netCall != null || x.netPut != null || x.netDelta != null);
  if (ticks.some((x) => x.t != null)) ticks.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return ticks;
}
export function normOi(rows) {
  const out = [];
  for (const r of rowsOf(rows)) {
    const o = parseOcc(r.option_symbol || r.symbol); if (!o) continue; const diff = n(r.oi_diff_plain ?? r.oi_change); if (diff == null) continue;
    out.push({ symbol: r.option_symbol || r.symbol, type: o.type, strike: o.strike, expiry: o.expiry, diff, curr: n(r.curr_oi), volume: n(r.volume), avgPrice: n(r.avg_price), trades: n(r.trades), pctOfTotal: n(r.percentage_of_total) });
  }
  return out;
}
export function normGexLevels(j) {
  const o = objOf(j); if (!o) return null; const f = (k) => n(o[k]);
  const lv = { callWall: f('call_wall'), putWall: f('put_wall'), gammaFlip: f('gamma_flip'), gammaMagnet: f('gamma_magnet'), nearbyFlips: Array.isArray(o.nearby_flips) ? o.nearby_flips.map(n).filter(isNum) : [], source: o.source || null, time: o.time || null, date: o.date || null };
  return [lv.callWall, lv.putWall, lv.gammaFlip, lv.gammaMagnet].some(isNum) ? lv : null;
}
export function normGreek(rows) {
  return rowsOf(rows).map((r) => { const cg = n(r.call_gamma), pg = n(r.put_gamma); return { date: String(r.date || '').slice(0, 10), callGamma: cg, putGamma: pg, netGamma: cg != null && pg != null ? cg + pg : null, callDelta: n(r.call_delta), putDelta: n(r.put_delta), callVanna: n(r.call_vanna), putVanna: n(r.put_vanna) }; })
    .filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
}
export function normIvRank(rows) {
  const r = rowsOf(rows).filter((x) => x && x.date).sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1)).pop(); if (!r) return null;
  return { date: String(r.date).slice(0, 10), ivRank: n(r.iv_rank_1y ?? r.iv_rank), iv: n(r.volatility), close: n(r.close), updatedAt: r.updated_at || null };
}
export function normTerm(rows) {
  const all = rowsOf(rows).map((r) => ({ date: String(r.date || '').slice(0, 10), expiry: r.expiry || null, dte: n(r.dte), iv: n(r.volatility), impliedMove: n(r.implied_move), impliedMovePct: n(r.implied_move_perc) })).filter((r) => r.dte != null && r.iv != null);
  const latest = all.reduce((m, r) => (r.date > m ? r.date : m), ''); return all.filter((r) => r.date === latest).sort((a, b) => a.dte - b.dte);
}
export function normSkew(rows) { return rowsOf(rows).map((r) => ({ date: String(r.date || '').slice(0, 10), delta: n(r.delta), rr: n(r.risk_reversal) })).filter((r) => r.rr != null).sort((a, b) => (a.date < b.date ? -1 : 1)); }
export function normBars1d(rows) { return rowsOf(rows).map((r) => ({ d: String(r.date || '').slice(0, 10), o: n(r.open), h: n(r.high), l: n(r.low), c: n(r.close), v: n(r.volume ?? r.total_volume) })).filter((b) => b.d && b.c > 0 && b.h != null && b.l != null).sort((a, b) => (a.d < b.d ? -1 : 1)); }
export function normBars5m(rows) {
  const all = rowsOf(rows).map((r) => { const t = Date.parse(r.start_time || r.end_time || ''); return { t, d: etDate(t), min: etMinutes(t), o: n(r.open), h: n(r.high), l: n(r.low), c: n(r.close), v: n(r.volume) }; }).filter((b) => Number.isFinite(b.t) && b.c > 0 && b.v != null).sort((a, b) => a.t - b.t);
  if (!all.length) return { bars: [], date: null };
  const date = all[all.length - 1].d; return { date, bars: all.filter((b) => b.d === date && b.min >= RTH_OPEN_MIN && b.min < RTH_CLOSE_MIN) };
}
export function normContracts(rows, nowMs = Date.now()) {
  const today = etDate(nowMs); const out = [];
  for (const r of rowsOf(rows)) {
    const o = parseOcc(r.option_symbol); if (!o) continue; const bid = n(r.nbbo_bid), ask = n(r.nbbo_ask); const mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : null;
    const dte = Math.round((Date.parse(`${o.expiry}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
    out.push({ symbol: r.option_symbol, type: o.type, strike: o.strike, expiry: o.expiry, dte, delta: n(r.delta), gamma: n(r.gamma), theta: n(r.theta), vega: n(r.vega), iv: n(r.implied_volatility), bid, ask, mid, spreadPct: mid > 0 ? (ask - bid) / mid : null, volume: n(r.volume), oi: n(r.open_interest), premium: n(r.total_premium), askVol: n(r.ask_volume), bidVol: n(r.bid_volume) });
  }
  return out;
}
export function normInfo(j) { const o = objOf(j); if (!o) return null; return { name: o.full_name || o.short_name || o.name || null, sector: o.sector || null, issueType: o.issue_type || null, marketCap: n(o.marketcap ?? o.market_cap) }; }
