// Synthetic Unusual Whales payloads in the SHAPES observed from live responses (field names verified on 2026-11-05).
import { schemaMissing } from '../../providers/uw-intel.js';
export const NOW = Date.parse('2026-11-04T16:30:00Z');            // Wednesday 11:30 ET, regular session open
const iso = (ms) => new Date(ms).toISOString();
export function weekdaysBack(endDate, n) { const out = []; let t = Date.parse(`${endDate}T12:00:00Z`); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10)); t -= 86400000; } return out; }
export function payloads(t = 'XYZ', o = {}) {
  const dir = o.dir || 'bull'; const s = dir === 'bull' ? 1 : -1; const days = weekdaysBack('2026-11-03', 80);
  const bars1d = days.map((d, i) => { const c = 100 + s * i * 0.25 + (i % 3) * 0.2; return { date: d, open: String(c - 0.2), high: String(c * 1.01), low: String(c * 0.99), close: String(c), volume: 1000000 + (i % 5) * 20000, total_volume: 1000000 }; });
  const last = Number(bars1d[bars1d.length - 1].close); const px = last * (1 + s * 0.02);
  const bars5m = Array.from({ length: 24 }, (_, i) => { const st = Date.parse('2026-11-04T14:30:00Z') + i * 300000; const c = last + (px - last) * (i / 23); return { start_time: iso(st), end_time: iso(st + 300000), open: String(c - 0.1), high: String(c + 0.2), low: String(c - 0.2), close: String(c), volume: 50000, market_time: 'r' }; });
  const exp = '2026-11-20'; const mk = (right, ask, bid, extra = {}) => ({ id: `${right}${ask}${bid}${Math.random()}`, created_at: iso(NOW - 3600000 + Math.floor(Math.random() * 1800000)), type: right, strike: String(Math.round(px)), expiry: exp, total_premium: String(ask + bid), total_ask_side_prem: String(ask), total_bid_side_prem: String(bid), volume: 2500, open_interest: 900, volume_oi_ratio: '2.7', has_sweep: true, has_floor: false, has_multileg: false, has_singleleg: true, all_opening_trades: true, alert_rule: 'RepeatedHits', underlying_price: String(px), delta: '0.5', next_earnings_date: o.earnings || '2026-12-15', marketcap: '5000000000', sector: 'Technology', total_size: 1000, trade_count: 4, ...extra });
  const big = o.small ? 20000 : 600000; const winner = dir === 'bull' ? 'call' : 'put', loser = dir === 'bull' ? 'put' : 'call';
  const flow = [...Array(6)].map(() => mk(winner, big, 0)).concat([mk(loser, 0, big), mk(loser, 20000, 0, { has_multileg: true, has_singleleg: false })]);
  const tape = Array.from({ length: 30 }, (_, i) => ({ timestamp: iso(Date.parse('2026-11-04T14:30:00Z') + i * 60000), net_call_premium: String(dir === 'bull' ? 90000 : 10000), net_put_premium: String(dir === 'bull' ? 10000 : 90000), net_delta: String(s * 500) }));
  const occ = (r, k) => `${t}261120${r}${String(Math.round(k * 1000)).padStart(8, '0')}`;
  const oi = [{ option_symbol: occ('C', Math.round(px)), oi_diff_plain: s > 0 ? 5000 : 500, curr_oi: 9000, volume: 3000, avg_price: '2.5', trades: 40, percentage_of_total: '0.3' }, { option_symbol: occ('P', Math.round(px) - 5), oi_diff_plain: s > 0 ? 400 : 5000, curr_oi: 8000, volume: 600, avg_price: '1.2', trades: 20, percentage_of_total: '0.1' }];
  const gamma = o.negGamma ? -1 : 1;
  const base = { flow: { data: flow }, tape: { data: tape }, oi: { data: oi },
    gexLevels: { data: { call_wall: String(Math.round(last * 1.06)), put_wall: String(Math.round(last * 0.96)), gamma_flip: String(Math.round(last * 0.99)), gamma_magnet: String(Math.round(last * 1.03)), nearby_flips: [String(Math.round(last * 0.99))], source: 'oi', time: '2026-11-03T20:59:59Z', date: '2026-11-03' } },
    greek: { data: [{ date: '2026-11-02', call_gamma: '1000000', put_gamma: '-900000' }, { date: '2026-11-03', call_gamma: String(2000000 * gamma), put_gamma: String(-1000000 * gamma), call_delta: '1', put_delta: '-1' }] },
    ivRank: { data: [{ date: '2026-11-03', volatility: '0.31', iv_rank_1y: String(o.ivRank ?? 45), close: String(last), updated_at: '2026-11-03T22:00:00Z' }] },
    term: { data: [0, 7, 14, 30, 60, 90].map((d) => ({ date: '2026-11-03', ticker: t, volatility: String(0.3 + d * 0.0005), expiry: '2026-12-01', dte: d, implied_move: String(px * 0.01 * Math.sqrt(Math.max(1, d))), implied_move_perc: String(0.01 * Math.sqrt(Math.max(1, d)) / 5) })) },
    skew: { data: [{ date: '2026-11-03', ticker: t, delta: 25, risk_reversal: '0.012' }] }, bars1d: { data: bars1d }, bars5m: { data: bars5m },
    contracts: { data: [['C', 0], ['C', 5], ['P', 0], ['P', -5]].map(([r, d]) => { const k = Math.round(px) + d; const mid = 3 - Math.abs(d) * 0.2; const sp = o.wide ? mid * 0.4 : mid * 0.03; return { option_symbol: occ(r, k), delta: String(r === 'C' ? 0.5 - d * 0.02 : -0.5 - d * 0.02), gamma: '0.05', theta: '-0.1', vega: '0.2', implied_volatility: '0.31', nbbo_bid: String(mid - sp / 2), nbbo_ask: String(mid + sp / 2), volume: 30000, open_interest: 12000, total_premium: '100000' }; }) },
    info: { data: { full_name: 'Xyz Corporation', sector: 'Technology', marketcap: '5000000000' } } };
  return { ...base, _px: px, _last: last };
}
export function fakeAdapter(by = {}, { fail = [], rateLimited = [], onCall } = {}) {
  const calls = [];
  return { calls, stats: () => ({ requestsThisScan: calls.length }), async fetch(key, ticker, ...rest) {
    calls.push(`${key}:${ticker}`); if (onCall) onCall(key, ticker);
    if (rateLimited.includes(ticker)) return { ok: false, key, error: 'UW 429', rateLimited: true, retrievedAt: NOW };
    const p = typeof by === 'function' ? by(ticker) : (by[ticker] || by.default); if (!p || fail.includes(key) || fail.includes(`${key}:${ticker}`) || p[key] === undefined) return { ok: false, key, error: `UW 404 on ${key}`, retrievedAt: NOW, verified: true };
    let json = p[key]; if (key === 'gexLevels' && rest[0] && p.gexLevelsDated) json = p.gexLevelsDated;
    const rows = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []); return { ok: true, key, json, rows: rows.length, retrievedAt: NOW, verified: true, schemaMissing: schemaMissing(key, json) };
  } };
}
