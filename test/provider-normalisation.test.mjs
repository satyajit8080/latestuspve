// Provider normalisation: aggressor-side flow, OI aliasing, intraday timestamps/RTH, earnings shape, null handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnusualWhalesOptionsProvider } from '../providers/unusualwhales.js';
import { signedFlow, eventGates } from '../engine/features.js';
import { etCalendarDaysUntil, etDate, isRth } from '../lib/time.js';

const J = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o });
async function withUW(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { const s = String(u); for (const [k, v] of Object.entries(routes)) if (s.includes(k)) return J(typeof v === 'function' ? v(s) : v); return J({ data: [] }); };
  try { return await fn(new UnusualWhalesOptionsProvider({ apiKey: 'k' })); } finally { globalThis.fetch = real; }
}
const alert = (type, ask, bid, extra = {}) => ({ type, total_premium: String(ask + bid), total_ask_side_prem: String(ask), total_bid_side_prem: String(bid), total_size: 10, expiry: '2099-01-01', ...extra });

test('flow-alerts: direction is aggressor side only; signedFlow sign table (call/put x ask/bid)', async () => {
  await withUW({ '/flow-alerts': { data: [alert('call', 100000, 0), alert('put', 100000, 0), alert('call', 0, 100000), alert('put', 0, 100000)] } }, async (p) => {
    const f = await p.getFlowDetailed('X');
    assert.deepEqual(f.trades.map((t) => t.direction), ['ask', 'ask', 'bid', 'bid']);
    for (const t of f.trades) assert.ok(t.askPremium != null && t.bidPremium != null);
    const one = (i) => signedFlow([f.trades[i].constructor === Object ? { ...f.trades[i], delta: 0.5 } : null]).deltaWeightedSignedFlow;
    assert.ok(one(0) > 0, 'ask-side call bullish');
    assert.ok(one(1) < 0, 'ask-side put bearish');
    assert.ok(one(2) < 0, 'bid-side call bearish');
    assert.ok(one(3) > 0, 'bid-side put bullish');
  });
});

test('signedFlow: unknown aggressor side is excluded and counted; bullish/bearish labels are not accepted', () => {
  const r = signedFlow([{ premium: 1000, side: 'call', delta: 0.5, direction: 'bullish' }, { premium: 1000, side: 'put', delta: 0.5 }, { premium: 5000, side: 'call', delta: 0.5, direction: 'ask' }]);
  assert.equal(r.sideUnknown, 2);
  assert.equal(r.trades, 1);
});

test('flow-alerts: unknown option type is skipped, never defaulted to call', async () => {
  await withUW({ '/flow-alerts': { data: [alert('', 100, 0), alert('put', 100, 0)] } }, async (p) => {
    const f = await p.getFlowDetailed('X');
    assert.equal(f.trades.length, 1);
    assert.equal(f.trades[0].right, 'put');
  });
});

test('chain: open_interest_change is NOT used as open interest', async () => {
  await withUW({ '/option-contracts': { data: [{ option_symbol: 'AAPL260918C00200000', open_interest_change: 500, volume: 10 }] } }, async (p) => {
    const c = await p.getChain('AAPL');
    assert.equal(c.chain.contracts[0].openInterest, null);
  });
});

test('intraday: a dropped row does not shift timestamps; sessionBars are latest-session RTH only', async () => {
  // 2026-08-24 (Mon) and 2026-08-25. EDT = UTC-4. 13:00Z = 09:00 ET (pre-market), 13:30Z = 09:30 ET.
  const row = (iso, c, v, extra = {}) => ({ start_time: iso, open: c, high: c + 1, low: c - 1, close: c, volume: v, ...extra });
  const data = [
    row('2026-08-24T14:00:00Z', 100, 1000),                 // prior session
    row('2026-08-25T13:00:00Z', 50, 777),                   // pre-market: excluded from session
    { start_time: '2026-08-25T13:30:00Z', open: 1, high: 1, low: 1 },   // dropped (no close/volume)
    row('2026-08-25T13:35:00Z', 101, 2000),
    row('2026-08-25T13:40:00Z', 103, 3000),
    row('2026-08-25T20:30:00Z', 104, 4000),                 // 16:30 ET after-hours: excluded
  ];
  await withUW({ '/ohlc/5m': { data } }, async (p) => {
    const iv = await p.getIntraday('X');
    assert.equal(iv.sessionDate, '2026-08-25');
    assert.deepEqual(iv.sessionBars.map((b) => b.volume), [2000, 3000]);
    assert.equal(iv.sessionVolume, 5000);
    const t = Date.parse('2026-08-25T13:35:00Z');
    const rb = iv.rawBars.find((b) => b.price === 101);
    assert.equal(rb.t, t);                                   // timestamp stayed attached to its own bar
    assert.equal(iv.rawBars.length, 5);
    const tp = (b) => (b.high + b.low + b.close) / 3;
    assert.ok(Math.abs(iv.vwap - (tp({ high: 102, low: 100, close: 101 }) * 2000 + tp({ high: 104, low: 102, close: 103 }) * 3000) / 5000) < 1e-9);
  });
});

test('earnings: provider returns ET calendar days; past dates are negative and do not gate', async () => {
  const today = etDate(Date.now());
  await withUW({ '/info': { data: { next_earnings_date: today, sector: 'Tech' } } }, async (p) => {
    const e = await p.getEarnings('X');
    assert.equal(e.available, true); assert.equal(e.daysToEarnings, 0);
  });
  assert.equal(etCalendarDaysUntil('2026-08-25', Date.parse('2026-08-24T23:30:00-04:00')), 1);   // 23:30 ET Aug 24 -> 1 day to Aug 25
  assert.equal(etCalendarDaysUntil('2026-08-24', Date.parse('2026-08-25T02:00:00Z')), 0);        // 22:00 ET Aug 24 is still Aug 24
  assert.equal(eventGates({ earningsDaysAway: -5 }).blocked, false);
  assert.equal(eventGates({ earningsDaysAway: 0 }).blocked, true);
  assert.equal(eventGates({ earningsDaysAway: 2 }).blocked, true);
  assert.equal(eventGates({ earningsDaysAway: 3 }).blocked, false);
  assert.equal(isRth(Date.parse('2026-08-25T13:30:00Z')), true);
});

test('/info is fetched once per ET day and shared by getCompanies + getEarnings', async () => {
  let n = 0;
  await withUW({ '/info': () => { n++; return { data: { sector: 'Tech', next_earnings_date: '2099-01-01' } }; } }, async (p) => {
    await p.getCompanies(['X']); await p.getEarnings('X'); await p.getCompanies(['X']);
    assert.equal(n, 1);
  });
});

test('screener: net premium is null unless BOTH sides are present', async () => {
  await withUW({ '/screener/stocks': { data: [{ ticker: 'A', net_call_premium: '100' }, { ticker: 'B', net_call_premium: '100', net_put_premium: '30' }] } }, async (p) => {
    const s = await p.getScreener();
    const by = Object.fromEntries(s.rows.map((r) => [r.ticker, r]));
    assert.equal(by.A.netPremium, null); assert.equal(by.A.net_premium, null);
    assert.equal(by.B.netPremium, 70);
  });
});

test('every normaliser returns null (never 0) for missing or empty-string fields', async () => {
  await withUW({
    '/stock-state': { data: { close: '', prev_close: '  ', volume: null } },
    '/greek-exposure/strike': { data: [{ strike: '', call_gex: '', put_gex: null }] },
    '/greek-exposure': { data: [{ call_gamma: '', put_gamma: null }] },
    '/iv-rank': { data: [{ iv_rank_1y: '', volatility: null }] },
    '/oi-change': { data: [{ option_symbol: 'AAPL260918C00200000', curr_oi: '', prev_oi: '' }] },
    '/net-prem-ticks': { data: [{ net_call_premium: '', net_put_premium: null }] },
  }, async (p) => {
    const u = await p.getUnderlying('X');
    assert.equal(u.available, false); assert.equal(u.underlying.price, null); assert.equal(u.underlying.prevClose, null); assert.equal(u.underlying.volume, null);
    const g = await p.getGex('X'); assert.equal(g.available, false); assert.equal(g.net_gex, null);
    const iv = await p.getIvRank('X'); assert.equal(iv.available === true ? iv.iv_rank : null, null);
    const oc = await p.getOiChange('X'); assert.equal(oc.available, false);
    const np = await p.getNetPremium('X'); assert.equal(np.available, false); assert.equal(np.total_net_premium, null);
  });
});
