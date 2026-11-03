// v2-0.2.0 (shadow): matched deltas, gamma multipliers, computed intraday inputs, actionable needs flow AND price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedFlow, gammaRegime, intradayMetrics } from '../engine/features.js';
import { scoreV2, V2_VERSION } from '../engine/v2.js';

const tr = (right, ask, bid, extra = {}) => ({ right, side: right, premium: ask + bid, askPremium: ask, bidPremium: bid, ...extra });

test('version bump', () => assert.equal(V2_VERSION, 'v2-0.2.0'));

test('delta weighting uses the MATCHED contract delta; unmatched trades are excluded and counted (no imputed 0.5)', () => {
  const r = signedFlow([tr('call', 100000, 0, { delta: 0.5 }), tr('call', 100000, 0, { delta: null }), tr('call', 100000, 0)]);
  assert.equal(r.deltaWeightedSignedFlow, 50000);                     // only the matched trade: 100000 x 0.5
  assert.equal(r.deltaMissing, 2); assert.equal(r.deltaExcluded, 2);
  assert.equal(r.quality, 'partial_delta');
  assert.equal(r.signedPremium, 300000);                              // premium aggregates still include every classified trade
});

test('far-OTM lottery tickets (small |delta|) cannot dominate delta-weighted flow', () => {
  const r = signedFlow([tr('call', 1000000, 0, { delta: 0.02 }), tr('put', 200000, 0, { delta: -0.5 })]);
  assert.ok(r.deltaWeightedSignedFlow < 0);                           // the small-delta call does not outweigh the near-the-money put
});

test('with NO matched delta the delta-weighted figures are null (never 0), premium imbalance still reported', () => {
  const r = signedFlow([tr('call', 100000, 0), tr('put', 0, 40000)]);
  assert.equal(r.deltaWeightedSignedFlow, null); assert.equal(r.openingDeltaFlow, null);
  assert.equal(r.available, true); assert.ok(r.imbalance > 0);
  assert.equal(r.deltaMissing, 2);
});

test('gamma regime multipliers: positive attenuates (0.85), negative boosts at most 1.15, dead-band is 1.0; no reversion boost exists', () => {
  const pos = gammaRegime({ spot: 120, gammaFlip: 110, atr: 2 });
  const neg = gammaRegime({ spot: 100, gammaFlip: 110, atr: 2 });
  const band = gammaRegime({ spot: 110.1, gammaFlip: 110, atr: 4 });
  assert.equal(pos.momentumMultiplier, 0.85); assert.equal(neg.momentumMultiplier, 1.15); assert.equal(band.momentumMultiplier, 1.0);
  for (const g of [pos, neg, band]) { assert.equal('reversionMultiplier' in g, false); assert.ok(g.momentumMultiplier <= 1.15); }
});

const NORM = { deltaWeightedSignedFlow: { available: true, z: 2.5 }, openingDeltaFlow: { available: false } };
const BASE = { ticker: 'X', trades: [tr('call', 5e6, 0, { delta: 0.5 })], normalized: NORM, spot: 100, atr: 2, gammaFlip: 105, gex: -1, market: {}, events: {} };

test('negative gamma boosts only PRICE-CONFIRMED flow; conflicting flow gets 1.0, never a boost', () => {
  const confirmed = scoreV2({ ...BASE, vwap: 98 });                   // bull flow, price above vwap
  const conflict = scoreV2({ ...BASE, vwap: 103 });                   // bull flow, price below vwap
  assert.equal(confirmed.multipliers.regime, 1.15);
  assert.equal(conflict.multipliers.regime, 1.0);
  assert.ok(conflict.multipliers.regime <= 1);
});

test('positive gamma attenuates (0.85) whether or not price confirms', () => {
  const pos = { ...BASE, gammaFlip: 95, gex: 1 };                      // spot above the flip
  assert.equal(scoreV2({ ...pos, vwap: 98 }).multipliers.regime, 0.85);
  assert.equal(scoreV2({ ...pos, vwap: 103 }).multipliers.regime, 0.85);
});

test('v2 is not actionable unless BOTH flow and price evidence are available', () => {
  assert.equal(scoreV2({ ...BASE, vwap: 98 }).actionable, true);
  const noPrice = scoreV2({ ...BASE, vwap: null });
  assert.equal(noPrice.available, true); assert.equal(noPrice.components.price, null); assert.equal(noPrice.actionable, false);
  assert.equal(scoreV2({ ...BASE, trades: [], vwap: 98 }).available, false);
});

test('intradayMetrics: returns, VWAP slope and first-30m return come from RTH session bars; thin data stays null', () => {
  const bars = Array.from({ length: 8 }, (_, i) => ({ t: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i + 1, price: 100 + i + 1, volume: 1000 }));
  const m = intradayMetrics(bars);
  assert.equal(m.ret5m, Math.round(((108 - 107) / 107) * 10000) / 100);
  assert.ok(m.ret15m > m.ret5m && m.ret30m > m.ret15m);
  assert.ok(m.vwapSlope > 0);
  assert.ok(m.first30mReturn > 0);
  const thin = intradayMetrics([{ close: 100, high: 101, low: 99, volume: 10 }]);
  assert.deepEqual([thin.ret5m, thin.ret15m, thin.ret30m, thin.vwapSlope, thin.first30mReturn], [null, null, null, null, null]);
  assert.equal(intradayMetrics(null).bars, 0);
});
