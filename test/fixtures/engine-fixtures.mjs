// Deterministic fixtures for the FROZEN production-engine baseline (req 6).
// These feed buildOptionsSignal directly (no network). If the Signal Journal ever changes
// production scoring, test/baseline-engine.test.mjs will fail against test/fixtures/baseline-signals.json.
const mk = (type, strike, { vol = 0, oi = 0, iv = 0.4, gamma = 0.04, bid = 1, ask = 1.1, exp = '2026-02-20' } = {}) =>
  ({ type, strike, expiration: exp, volume: vol, openInterest: oi, iv, gamma, delta: type === 'call' ? 0.5 : -0.5, theta: -0.01, vega: 0.1, bid, ask, mid: (bid + ask) / 2 });

const FA_FULL = { chain: true, underlying: true, greeks: true, oi: true, iv: true, quotes: true };

// 1) Bull: call volume + OI dominate
const bull = {
  ticker: 'FIX_BULL', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 100, prevClose: 98, volume: 5_000_000, available: true }, fieldsAvailable: FA_FULL,
  contracts: [
    mk('call', 95, { vol: 4000, oi: 6000, iv: 0.42, bid: 6, ask: 6.2 }),
    mk('call', 100, { vol: 9000, oi: 8000, iv: 0.40, bid: 2, ask: 2.1 }),
    mk('call', 105, { vol: 6000, oi: 5000, iv: 0.45, bid: 0.8, ask: 0.9 }),
    mk('put', 95, { vol: 1500, oi: 2500, iv: 0.44, bid: 0.7, ask: 0.8 }),
    mk('put', 100, { vol: 2000, oi: 3000, iv: 0.41, bid: 1.8, ask: 1.9 }),
    mk('put', 105, { vol: 800, oi: 1200, iv: 0.46, bid: 5, ask: 5.2 }),
  ],
};
// 2) Bear: put volume + OI dominate, price down vs prev close
const bear = {
  ticker: 'FIX_BEAR', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 100, prevClose: 104, volume: 4_000_000, available: true }, fieldsAvailable: FA_FULL,
  contracts: [
    mk('call', 95, { vol: 900, oi: 1500, iv: 0.40, bid: 6, ask: 6.2 }),
    mk('call', 100, { vol: 1500, oi: 2500, iv: 0.39, bid: 2, ask: 2.1 }),
    mk('call', 105, { vol: 700, oi: 1000, iv: 0.43, bid: 0.8, ask: 0.9 }),
    mk('put', 95, { vol: 5000, oi: 6000, iv: 0.47, bid: 0.7, ask: 0.8 }),
    mk('put', 100, { vol: 9000, oi: 9000, iv: 0.45, bid: 1.8, ask: 1.9 }),
    mk('put', 105, { vol: 6500, oi: 5500, iv: 0.50, bid: 5, ask: 5.2 }),
  ],
};
// 3) Neutral: balanced
const neutral = {
  ticker: 'FIX_NEUTRAL', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 100, prevClose: 100, volume: 3_000_000, available: true }, fieldsAvailable: FA_FULL,
  contracts: [
    mk('call', 100, { vol: 3000, oi: 4000, iv: 0.40, bid: 2, ask: 2.1 }),
    mk('put', 100, { vol: 3000, oi: 4000, iv: 0.40, bid: 1.9, ask: 2.0 }),
    mk('call', 105, { vol: 1500, oi: 2000, iv: 0.42, bid: 0.8, ask: 0.9 }),
    mk('put', 95, { vol: 1500, oi: 2000, iv: 0.42, bid: 0.7, ask: 0.8 }),
  ],
};
// 4) Sparse: no greeks / no iv / no quotes → low data quality, exercises null-safety
const sparse = {
  ticker: 'FIX_SPARSE', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 50, available: true }, fieldsAvailable: { chain: true, underlying: true, greeks: false, oi: true, iv: false, quotes: false },
  contracts: [
    { type: 'call', strike: 50, expiration: '2026-02-20', volume: 1000, openInterest: 2000 },
    { type: 'put', strike: 50, expiration: '2026-02-20', volume: 1200, openInterest: 1800 },
  ],
};

// 5) Bull WITH prior snapshot (exercises oiChange) + underlyingHist (exercises momentum)
const withPrev = {
  chain: { ...bull, ticker: 'FIX_WITHPREV' },
  ctx: { prevAgg: { callOI: 15000, putOI: 8000, atmIV: 0.38 }, underlyingHist: [96, 98] },
};

export const FIXTURES = [
  { name: 'bull', chain: bull, ctx: {} },
  { name: 'bear', chain: bear, ctx: {} },
  { name: 'neutral', chain: neutral, ctx: {} },
  { name: 'sparse', chain: sparse, ctx: {} },
  { name: 'withPrev', chain: withPrev.chain, ctx: withPrev.ctx },
];

// The production fields we freeze (req 6): composite outputs + factors + relevant aggregates.
export function captureBaseline(sig) {
  const a = sig.agg || {};
  return {
    finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier,
    optionsScore: sig.optionsScore, stockScore: sig.stockScore, dataQuality: sig.dataQuality, primary: sig.primary,
    agg: { gex: a.gex, gammaFlip: a.gammaFlip, maxPain: a.maxPain, cpVolRatio: a.cpVolRatio, cpOIRatio: a.cpOIRatio, volOIRatio: a.volOIRatio, atmIV: a.atmIV, strikeConcentration: a.strikeConcentration, avgSpread: a.avgSpread },
  };
}

// ---------------------------------------------------------------------------------------------
// opt-1.2.0 baseline fixtures (context carries signed flow, daily OI change and per-ticker baselines).
// Regenerate the frozen values ONLY on a deliberate scoring change: `node test/fixtures/regen-baseline-1.2.0.mjs`
// and bump OPTIONS_ENGINE_VERSION.
const NOW_RTH = Date.parse('2026-01-15T16:00:00Z');   // 11:00 ET
const t = (right, ask, bid) => ({ right, side: right, askPremium: ask, bidPremium: bid, premium: ask + bid });
const zz = (z, n = 20) => ({ z, n, available: true });
const CTX_BULL = { flow: { trades: [t('call', 6e6, 0), t('call', 3e6, 0), t('put', 0, 5e5)] }, oiChange: { callOIChange: 9000, putOIChange: -1500 }, norm: { signedPremium: zz(2.8), grossPremium: { mean: 2e6, n: 20, available: true }, oiChange: zz(2.2), cpVolumeLog: zz(2.4) }, vwap: 98.5, atr: 2, now: NOW_RTH, earningsDaysAway: 30 };
const CTX_BEAR = { flow: { trades: [t('put', 6e6, 0), t('put', 3e6, 0), t('call', 0, 5e5)] }, oiChange: { callOIChange: -1500, putOIChange: 9000 }, norm: { signedPremium: zz(-2.8), grossPremium: { mean: 2e6, n: 20, available: true }, oiChange: zz(-2.2), cpVolumeLog: zz(-2.4) }, vwap: 101.5, atr: 2, now: NOW_RTH, earningsDaysAway: 30 };
export const FIXTURES_V2 = [
  { name: 'bull', chain: bull, ctx: CTX_BULL },
  { name: 'bull_price_conflict', chain: { ...bull, ticker: 'FIX_BULL_PC' }, ctx: { ...CTX_BULL, vwap: 103.5 } },
  { name: 'bear', chain: bear, ctx: CTX_BEAR },
  { name: 'neutral', chain: neutral, ctx: { now: NOW_RTH, earningsDaysAway: 30, vwap: 100, atr: 2 } },
  { name: 'sparse', chain: sparse, ctx: { now: NOW_RTH } },
  { name: 'bull_earnings_gated', chain: { ...bull, ticker: 'FIX_BULL_ER' }, ctx: { ...CTX_BULL, earningsDaysAway: 1 } },
  { name: 'bull_after_hours', chain: { ...bull, ticker: 'FIX_BULL_AH' }, ctx: { ...CTX_BULL, now: Date.parse('2026-01-15T23:30:00Z') } },
  { name: 'bull_cold_start', chain: { ...bull, ticker: 'FIX_BULL_CS' }, ctx: { flow: CTX_BULL.flow, oiChange: CTX_BULL.oiChange, vwap: 98.5, atr: 2, now: NOW_RTH, earningsDaysAway: 30 } },
];
export function captureBaselineV2(sig) {
  const a = sig.agg || {};
  return {
    finalScore: sig.finalScore, rawScore: sig.rawScore, gated: sig.gated, dir: sig.dir, tier: sig.tier, optionsScore: sig.optionsScore, actionable: sig.actionable, tradeable: sig.tradeable,
    stockConfirm: sig.stockConfirm, priceGate: sig.priceGate, gateReasons: sig.gateReasons, flags: sig.flags, availableDirectional: sig.availableDirectional,
    coverage: Math.round(sig.coverage * 1000) / 1000, dataQuality: sig.dataQuality,
    features: sig.features.map((f) => [f.key, f.avail, f.dir, Math.round(f.strength * 1000) / 1000]),
    agg: { cpVolRatio: a.cpVolRatio, cpOIRatio: a.cpOIRatio, volOIRatio: a.volOIRatio, atmIV: a.atmIV, gex: a.gex, gammaFlip: a.gammaFlip, atmSpread: a.atmSpread, atmOI: a.atmOI },
  };
}
