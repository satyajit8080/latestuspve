// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateChain, extractOptionsFeatures, scoreOptions, dataQualityScore, computeMaxPain, signedPremiumFromTrades,
  buildOptionsSignal, captureOptionsSnapshot, replayOptionsSignal, scoreTier, OPTIONS_ENGINE_VERSION, OPTIONS_FEATURE_DEFS, DEFAULT_OPTIONS_CFG,
} from '../engine/options-engine.js';

const NOW = Date.parse('2026-08-25T15:00:00Z');          // 11:00 ET, regular trading hours
const SUN = Date.parse('2026-08-25T23:30:00Z');          // 19:30 ET, outside RTH

function chainFixture(over = {}, spread = 0.1) {
  const mk = (type, strike, volume, oi, iv, gamma, bid, ask) => ({ type, strike, expiration: '2026-09-18', volume, openInterest: oi, iv, delta: type === 'call' ? 0.5 : -0.5, gamma, theta: -0.01, vega: 0.1, bid, ask, mid: (bid + ask) / 2 });
  const contracts = [
    mk('call', 95, 5000, 10000, 0.40, 0.02, 5.0, 5.0 + spread),
    mk('call', 100, 30000, 20000, 0.45, 0.05, 2.0, 2.0 + spread),
    mk('call', 105, 15000, 8000, 0.50, 0.03, 0.8, 0.8 + spread),
    mk('put', 95, 4000, 15000, 0.55, 0.03, 0.7, 0.7 + spread),
    mk('put', 100, 8000, 12000, 0.48, 0.05, 1.8, 1.8 + spread),
    mk('put', 105, 3000, 6000, 0.52, 0.02, 4.5, 4.5 + spread),
  ];
  return {
    ticker: 'TEST', asOf: '2026-08-25T15:00:00Z', underlying: { price: 100, volume: 1_000_000, available: true }, contracts,
    fieldsAvailable: { chain: true, greeks: true, iv: true, oi: true, quotes: true, underlying: true, trades: false, sweeps: false },
    flow: { available: false, largeTrades: [] }, ...over,
  };
}
const trade = (right, ask, bid) => ({ right, side: right, askPremium: ask, bidPremium: bid, premium: ask + bid });
const z = (zv, n = 20) => ({ z: zv, n, available: true });
const BULL_CTX = () => ({
  flow: { trades: [trade('call', 6000000, 0), trade('call', 4000000, 0), trade('put', 0, 1000000)] },
  oiChange: { callOIChange: 6000, putOIChange: -1000 },
  norm: { signedPremium: z(3), grossPremium: { mean: 1000000, n: 20, available: true }, oiChange: z(2.5), cpVolumeLog: z(2.5) },
  vwap: 98, atr: 2, now: NOW, earningsDaysAway: 30,
});

test('feature registry: exactly three weighted, directional features; weights sum to 1', () => {
  assert.deepEqual(Object.keys(OPTIONS_FEATURE_DEFS), ['signedPremium', 'oiChange', 'cpVolumeZ']);
  assert.ok(Object.values(OPTIONS_FEATURE_DEFS).every((d) => d.directional));
  assert.ok(Math.abs(Object.values(DEFAULT_OPTIONS_CFG.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(OPTIONS_ENGINE_VERSION, 'opt-1.2.0');
});

test('aggregate: call/put volume + ratios (hand-computed); display ratio finite or null, never Infinity', () => {
  const a = aggregateChain(chainFixture());
  assert.equal(a.callVol, 50000); assert.equal(a.putVol, 15000);
  assert.equal(a.cpVolRatio, 50000 / 15000);
  assert.equal(a.callOI, 38000); assert.equal(a.putOI, 33000); assert.equal(a.totVol, 65000);
  assert.ok(Math.abs(a.cpVolLog - Math.log(50001 / 15001)) < 1e-12);
  const allCalls = chainFixture(); allCalls.contracts = allCalls.contracts.filter((c) => c.type === 'call');
  const b = aggregateChain(allCalls);
  assert.equal(b.cpVolRatio, null);                      // was Infinity (and then treated as "neutral")
  assert.ok(Number.isFinite(b.cpVolLog) && b.cpVolLog > 5);   // the smoothed log ratio stays finite and strongly bullish
});

test('max pain is display-only: not in the scoring aggregate, and a real strike when computed', () => {
  assert.equal('maxPain' in aggregateChain(chainFixture()), false);
  assert.ok([95, 100, 105].includes(computeMaxPain(chainFixture())));
  assert.equal(computeMaxPain({ contracts: [] }), null);
});

test('no fabrication: missing greeks/iv/quotes → GEX / ATM IV / spreads are null', () => {
  const bare = chainFixture({ fieldsAvailable: { chain: true, greeks: false, iv: false, oi: true, quotes: false, underlying: true } });
  const a = aggregateChain(bare);
  assert.equal(a.gex, null); assert.equal(a.atmIV, null); assert.equal(a.avgSpread, null);
});

test('signedPremium sign table: ask call +, ask put -, bid call -, bid put +', () => {
  const sp = (t) => signedPremiumFromTrades([t]).signed;
  assert.ok(sp(trade('call', 100000, 0)) > 0);
  assert.ok(sp(trade('put', 100000, 0)) < 0);
  assert.ok(sp(trade('call', 0, 100000)) < 0);
  assert.ok(sp(trade('put', 0, 100000)) > 0);
  assert.equal(signedPremiumFromTrades([{ right: 'call', premium: 5 }]), null);      // no ask/bid split => not used
});

test('signedPremium feature: direction, floor, net-prem-ticks fallback, shrinkage', () => {
  const f = (ctx) => extractOptionsFeatures(chainFixture(), ctx).features.find((x) => x.key === 'signedPremium');
  const bull = f({ flow: { trades: [trade('call', 400000, 0)] } });
  assert.equal(bull.avail, 1); assert.equal(bull.dir, 1);
  assert.match(bull.note, /raw, no baseline/);
  const bear = f({ flow: { trades: [trade('put', 400000, 0)] } });
  assert.equal(bear.dir, -1);
  const thin = f({ flow: { trades: [trade('call', 20000, 0)] } });
  assert.equal(thin.avail, 0); assert.equal(thin.strength, 0);               // below the premium floor => unavailable, not tiny
  const fb = f({ flow: { trades: [], netPrem: { callNet: 600000, putNet: -100000 } } });
  assert.equal(fb.avail, 1); assert.equal(fb.flowSource, 'net-prem-ticks'); assert.equal(fb.dir, 1);
  const small = f({ flow: { trades: [trade('call', 150000, 0)] } }), big = f({ flow: { trades: [trade('call', 5000000, 0)] } });
  assert.ok(big.strength > small.strength);                                    // shrinkage: more premium => stronger
  const withZ = f({ flow: { trades: [trade('call', 400000, 0), trade('put', 0, 10)] }, norm: { signedPremium: z(-2) } });
  assert.equal(withZ.dir, -1);                                                 // the ticker's own history says this flow is unusually BEARISH
});

test('cpVolumeZ: unavailable without history (raw call/put is never a direction); z drives it otherwise', () => {
  const noHist = extractOptionsFeatures(chainFixture(), {}).features.find((x) => x.key === 'cpVolumeZ');
  assert.equal(noHist.avail, 0);                                                // call-heavy chain, still no direction
  const young = extractOptionsFeatures(chainFixture(), { norm: { cpVolumeLog: z(3, 4) } }).features.find((x) => x.key === 'cpVolumeZ');
  assert.equal(young.avail, 0);                                                 // only 4 sessions
  const ok = extractOptionsFeatures(chainFixture(), { norm: { cpVolumeLog: z(-2.2, 15) } }).features.find((x) => x.key === 'cpVolumeZ');
  assert.equal(ok.avail, 1); assert.equal(ok.dir, -1);                          // call-heavy, but LESS call-heavy than this ticker's norm => bearish
  const quiet = chainFixture(); quiet.contracts.forEach((c) => { c.volume = 10; });
  assert.equal(extractOptionsFeatures(quiet, { norm: { cpVolumeLog: z(3, 15) } }).features.find((x) => x.key === 'cpVolumeZ').avail, 0);   // activity floor
});

test('oiChange: from UW daily change; floors; z when a baseline exists', () => {
  const f = (ctx, chain = chainFixture()) => extractOptionsFeatures(chain, ctx).features.find((x) => x.key === 'oiChange');
  assert.equal(f({}).avail, 0);
  const up = f({ oiChange: { callOIChange: 600, putOIChange: 0 } });
  assert.equal(up.avail, 1); assert.equal(up.dir, 1);
  assert.equal(f({ oiChange: { callOIChange: 5, putOIChange: 0 } }).avail, 0);                        // below the 100 contract floor
  assert.equal(f({ oiChange: { callOIChange: 600, putOIChange: 0 }, norm: { oiChange: z(-2) } }).dir, -1);
  assert.deepEqual(f({ oiChange: { callOIChange: 600, putOIChange: 0 } }), f({ oiChange: { callOIChange: 600, putOIChange: 0 } }));   // same value on every poll
});

test('scoreOptions: score = 100 x |net| x coverage; direction needs a non-neutral net', () => {
  const { features } = extractOptionsFeatures(chainFixture(), BULL_CTX());
  const r = scoreOptions(features);
  assert.equal(r.nAvailable, 3); assert.equal(r.coverage, 1);
  assert.equal(r.dir, 'bull');
  assert.equal(r.optionsScore, Math.round(100 * Math.abs(r.net) * r.coverage));
  assert.ok(r.optionsScore > 80);
  const none = scoreOptions(extractOptionsFeatures(chainFixture(), {}).features);
  assert.equal(none.nAvailable, 0); assert.equal(none.dir, 'neutral'); assert.equal(none.optionsScore, 0);
});

test('fewer than 2 of 3 directional features => watch-only (score capped at 60)', () => {
  const ctx = { flow: { trades: [trade('call', 9000000, 0)] }, norm: { signedPremium: z(5), grossPremium: { mean: 1000000, n: 20 } }, vwap: 99, atr: 2, now: NOW, earningsDaysAway: 30 };
  const s = buildOptionsSignal(chainFixture(), ctx);
  assert.equal(s.availableDirectional, 1);
  assert.equal(s.finalScore, Math.min(60, Math.round(s.optionsScore)));
  assert.ok(s.finalScore <= 60);
  assert.ok(s.gateReasons.includes('INSUFFICIENT_DIRECTIONAL_EVIDENCE'));
  assert.equal(s.actionable, false);
});

test('price gate: conflict x0.75 and not actionable; confirmation adds NOTHING; missing VWAP flagged, multiplier 1', () => {
  const base = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), vwap: 99.9, atr: 2 });                 // 0.05 ATR: neutral
  const confirm = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), vwap: 97, atr: 2 });                 // +1.5 ATR above VWAP
  const conflict = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), vwap: 104, atr: 2 });               // -2 ATR below VWAP
  const missing = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), vwap: null, atr: null });
  assert.equal(confirm.finalScore, base.finalScore);                                                         // no boost
  assert.equal(confirm.stockConfirm, 1); assert.equal(confirm.priceGate.multiplier, 1);
  assert.equal(conflict.priceGate.multiplier, 0.75); assert.equal(conflict.stockConfirm, -1);
  assert.equal(conflict.finalScore, Math.round(base.optionsScore * 0.75));
  assert.equal(conflict.actionable, false);                                                                  // a down-trending stock cannot produce an actionable CALL
  assert.ok(conflict.gateReasons.includes('PRICE_CONFLICT'));
  assert.equal(missing.priceGate.multiplier, 1); assert.ok(missing.flags.includes('PRICE_GATE_UNAVAILABLE'));
  assert.equal(missing.finalScore, base.finalScore);
});

test('bear signal: price ABOVE vwap conflicts with a put', () => {
  const ctx = { ...BULL_CTX(), flow: { trades: [trade('put', 6000000, 0), trade('put', 4000000, 0)] }, oiChange: { callOIChange: -1000, putOIChange: 6000 }, norm: { signedPremium: z(-3), grossPremium: { mean: 1000000, n: 20 }, oiChange: z(-2.5), cpVolumeLog: z(-2.5) }, vwap: 97, atr: 2 };
  const s = buildOptionsSignal(chainFixture(), ctx);
  assert.equal(s.dir, 'bear'); assert.equal(s.priceGate.state, 'conflict'); assert.equal(s.actionable, false);
});

test('regular trading hours: outside RTH is capped and not actionable; unknown time is flagged, not assumed', () => {
  const rth = buildOptionsSignal(chainFixture(), BULL_CTX());
  const after = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), now: SUN });
  const unknown = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), now: null });
  assert.equal(rth.actionable, true); assert.equal(rth.outsideRth, false);
  assert.equal(after.outsideRth, true); assert.equal(after.actionable, false); assert.ok(after.finalScore <= 60);
  assert.ok(after.flags.includes('OUTSIDE_RTH'));
  assert.ok(unknown.flags.includes('RTH_UNKNOWN')); assert.equal(unknown.finalScore, rth.finalScore);
});

test('earnings gate: 0..2 ET days away => published score 0 with rawScore kept; past/unknown never gate', () => {
  const live = buildOptionsSignal(chainFixture(), BULL_CTX());
  for (const d of [0, 1, 2]) {
    const g = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), earningsDaysAway: d });
    assert.equal(g.gated, true); assert.equal(g.finalScore, 0); assert.equal(g.rawScore, live.finalScore); assert.ok(g.gateReasons.includes('EARNINGS')); assert.equal(g.actionable, false);
  }
  assert.equal(buildOptionsSignal(chainFixture(), { ...BULL_CTX(), earningsDaysAway: 3 }).gated, false);
  assert.equal(buildOptionsSignal(chainFixture(), { ...BULL_CTX(), earningsDaysAway: -4 }).gated, false);   // a past date must not block forever
  const unk = buildOptionsSignal(chainFixture(), { ...BULL_CTX(), earningsDaysAway: null });
  assert.equal(unk.gated, false); assert.ok(unk.flags.includes('EARNINGS_UNKNOWN'));
});

test('liquidity gate (not a weight): wide ATM spread or thin ATM OI => untradeable and capped; unknown liquidity is flagged', () => {
  const wide = buildOptionsSignal(chainFixture({}, 3), BULL_CTX());                  // ~100%+ spreads
  assert.equal(wide.tradeable, false); assert.ok(wide.gateReasons.includes('WIDE_ATM_SPREAD')); assert.ok(wide.finalScore <= 60); assert.equal(wide.actionable, false);
  const thin = chainFixture(); thin.contracts.forEach((c) => { c.openInterest = 10; });
  const t = buildOptionsSignal(thin, BULL_CTX());
  assert.equal(t.tradeable, false); assert.ok(t.gateReasons.includes('LOW_ATM_OI'));
  const noQuotes = chainFixture({ fieldsAvailable: { chain: true, oi: false, quotes: false, underlying: true } });
  const u = buildOptionsSignal(noQuotes, BULL_CTX());
  assert.ok(u.flags.includes('LIQUIDITY_UNKNOWN')); assert.equal(u.tradeable, true);
});

test('missing data never becomes a direction: a sparse chain with no flow is neutral, evidence 0, every feature unavailable', () => {
  const sparse = { ticker: 'S', underlying: { price: 50, available: true }, fieldsAvailable: { chain: true, underlying: true, greeks: false, oi: true, iv: false, quotes: false }, contracts: [{ type: 'call', strike: 50, expiration: '2026-09-18', volume: 1000, openInterest: 2000 }, { type: 'put', strike: 50, expiration: '2026-09-18', volume: 100, openInterest: 1800 }] };
  const s = buildOptionsSignal(sparse, { now: NOW });
  assert.equal(s.dir, 'neutral'); assert.equal(s.availableDirectional, 0);
  assert.ok(s.features.every((f) => f.avail === 0 && f.value === null));
});

test('buildOptionsSignal: insufficient when no real chain; tier maps from the published score', () => {
  const none = buildOptionsSignal({ ticker: 'X', fieldsAvailable: { chain: false }, contracts: [], underlying: { available: false } });
  assert.equal(none.insufficient, true); assert.equal(none.dataQualityStatus, 'UNAVAILABLE'); assert.equal(none.actionable, false);
  const s = buildOptionsSignal(chainFixture(), BULL_CTX());
  assert.equal(s.tier, scoreTier(s.finalScore));
  assert.ok(s.finalScore >= 0 && s.finalScore <= 100);
});

test('replay determinism: a snapshot reproduces the identical signal without any live API', () => {
  const sig = buildOptionsSignal(chainFixture(), BULL_CTX());
  const rep = replayOptionsSignal(captureOptionsSnapshot(chainFixture(), BULL_CTX(), {}, NOW));
  const view = (s) => JSON.stringify({ f: s.finalScore, o: s.optionsScore, d: s.dir, t: s.tier, g: s.gateReasons, p: s.priceGate });
  assert.equal(view(rep), view(sig));
  assert.equal(captureOptionsSnapshot(chainFixture(), {}, {}, 1).optionsEngineVersion, OPTIONS_ENGINE_VERSION);
});

test('dataQuality: informational only (no multiplier): coverage is the single data-quality mechanism', () => {
  assert.equal(dataQualityScore(chainFixture()).status, 'AVAILABLE');
  assert.equal(dataQualityScore(chainFixture({ fieldsAvailable: { chain: true, oi: true } })).status, 'PARTIAL');
  assert.equal(dataQualityScore({ fieldsAvailable: {} }).status, 'UNAVAILABLE');
  const full = buildOptionsSignal(chainFixture(), BULL_CTX());
  const partial = buildOptionsSignal(chainFixture({ fieldsAvailable: { chain: true, oi: true, underlying: true, quotes: true, iv: true } }), BULL_CTX());
  assert.equal(partial.finalScore, full.finalScore);
});

test('the engine is pure: inputs are not mutated', () => {
  const chain = chainFixture(), ctx = BULL_CTX();
  const before = JSON.stringify([chain, ctx]);
  buildOptionsSignal(chain, ctx);
  assert.equal(JSON.stringify([chain, ctx]), before);
});
