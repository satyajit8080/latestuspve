import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRows, baselineReport, rankIC, crossSectionalIC, dedupeDaily, bootstrapCI, topDecilePrecision } from '../store/evaluation.js';
import { computeLearning, computeCheckpoint } from '../store/journal.js';

const rec = (o) => ({
  id: o.id, ticker: o.ticker || 'AAA', firedAt: o.firedAt, optionsEngineVersion: o.version || 'opt-x',
  composite: { dir: o.dir ?? 'bull', finalScore: o.score ?? 70, optionsEngineVersion: o.version || 'opt-x' },
  v2: o.v2 === undefined ? null : o.v2, legacy: o.legacy || null,
  context: { vwap: o.vwap, atr: o.atr }, entry: { stockPrice: o.px ?? 100 },
  outcomes: { '30m': { status: 'resolved', stockChangePct: o.stock, benchmarkReturnPct: o.spy ?? null, directionalReturnPct: o.dirRet ?? null } },
});

test('v2 return is signed by the v2 direction, not the production direction', () => {
  const rows = toRows([rec({ id: '1', firedAt: '2026-08-24T14:00:00Z', dir: 'bull', stock: 2, v2: { score: 80, dir: 'bear' } })], '30m');
  assert.equal(rows[0].ret, 2);        // production bull: +2%
  assert.equal(rows[0].v2Ret, -2);     // v2 bear: the same +2% stock move is a LOSS for v2
});

test('v2-gated rows (published score 0) are excluded from the v2 evaluation', () => {
  const rows = toRows([rec({ id: '1', firedAt: '2026-08-24T14:00:00Z', stock: 1, v2: { score: 0, dir: 'bull', gated: true } }), rec({ id: '2', firedAt: '2026-08-24T14:00:00Z', stock: 1, v2: { score: 60, dir: 'bull', gated: true } })], '30m');
  assert.equal(rows[0].v2Score, null); assert.equal(rows[1].v2Score, null);
});

test('market-adjusted return subtracts SPY and is signed by direction', () => {
  const rows = toRows([rec({ id: '1', firedAt: '2026-08-24T14:00:00Z', dir: 'bear', stock: -1, spy: -0.4 })], '30m');
  assert.ok(Math.abs(rows[0].ret - 1) < 1e-9);
  assert.ok(Math.abs(rows[0].adjRet - 0.6) < 1e-9);   // bear: (-1 - -0.4) * -1 = 0.6
});

test('pooled IC keeps one observation per ticker per ET day', () => {
  const rows = [
    { ticker: 'A', etDay: '2026-08-24', firedAt: '2026-08-24T14:00:00Z', s: 90, r: 1 },
    { ticker: 'A', etDay: '2026-08-24', firedAt: '2026-08-24T15:00:00Z', s: 10, r: -1 },
    { ticker: 'A', etDay: '2026-08-25', firedAt: '2026-08-25T15:00:00Z', s: 50, r: 0.2 },
  ];
  const d = dedupeDaily(rows, { scoreKey: 's', retKey: 'r' });
  assert.deepEqual(d.map((x) => x.s), [90, 50]);
});

test('cross-sectional IC: mean across scan timestamps with a t-stat; perfect ranking per period', () => {
  const rows = [];
  for (let t = 0; t < 12; t++) for (let i = 0; i < 6; i++) rows.push({ scanKey: t, s: i, r: i + (t % 2 ? 0.1 : 0) });
  const cs = crossSectionalIC(rows, { scoreKey: 's', retKey: 'r' });
  assert.equal(cs.periods, 12); assert.equal(cs.meanIC, 1); assert.equal(cs.gated, false);
  const few = crossSectionalIC(rows.slice(0, 6), { scoreKey: 's', retKey: 'r' });
  assert.equal(few.gated, true);
  assert.equal(crossSectionalIC([{ scanKey: 1, s: 1, r: 1 }], { scoreKey: 's', retKey: 'r' }).meanIC, null);   // thin groups skipped, never 0
});

test('bootstrap CI is deterministic (seeded) and brackets the point estimate; gated when thin', () => {
  const pairs = Array.from({ length: 80 }, (_, i) => ({ score: i, ret: i + ((i * 7) % 13) - 6 }));
  const a = bootstrapCI(pairs, (s) => rankIC(s).ic), b = bootstrapCI(pairs, (s) => rankIC(s).ic);
  assert.deepEqual(a, b);
  const ic = rankIC(pairs).ic;
  assert.ok(a.lo <= ic && ic <= a.hi);
  assert.equal(bootstrapCI(pairs.slice(0, 5), (s) => rankIC(s).ic).gated, true);
  assert.ok(topDecilePrecision(pairs).precision != null);
});

test('baselineReport never pools engine versions and exposes baselines and legacy', () => {
  const recs = [];
  for (let i = 0; i < 40; i++) {
    const day = `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`;
    recs.push(rec({ id: 'a' + i, ticker: 'T' + i, firedAt: `${day}T14:00:00Z`, version: 'opt-1.1.1', score: 50 + i, stock: i / 10 - 2, vwap: 99, atr: 2, legacy: { finalScore: 40 + i, dir: 'bull' } }));
    recs.push(rec({ id: 'b' + i, ticker: 'T' + i, firedAt: `${day}T14:00:00Z`, version: 'opt-1.2.0', score: 90 - i, stock: i / 10 - 2, vwap: 99, atr: 2 }));
  }
  const rep = baselineReport(recs);
  assert.deepEqual(rep.versions, ['opt-1.1.1', 'opt-1.2.0']);
  assert.equal(rep.engineVersion, 'opt-1.2.0');                    // latest version is the headline
  assert.ok(rep.byVersion['opt-1.1.1'].byHorizon['30m'].rankIC.ic > 0.9);   // score rises with return
  assert.ok(rep.byVersion['opt-1.2.0'].byHorizon['30m'].rankIC.ic < -0.9);  // score falls with return: NOT pooled with 1.1.1
  const h = rep.byVersion['opt-1.1.1'].byHorizon['30m'];
  assert.ok(h.legacy.pooledIC && h.baselines.random && h.baselines.momentumOnly);
  assert.ok(Math.abs(h.baselines.random.ic ?? 0) < 0.6);
  assert.ok(h.crossSectionalIC && 'tStat' in h.crossSectionalIC && h.rankICci && h.topDecileCI);
});

test('learning: a directional factor that pointed against the call is not credited; field is avgReturn', () => {
  const mk = (id, ret, factorDir) => ({ id, composite: { dir: 'bull', finalScore: 75 }, scored: { components: [{ key: 'signedPremium', directional: true, avail: 1, dir: factorDir, strength: 0.8, weight: 0.5, value: 1 }] }, outcomes: { '30m': { status: 'resolved', directionalReturnPct: ret } } });
  const L = computeLearning([mk('1', 2, 1), mk('2', 2, 1), mk('3', -1, -1), mk('4', -1, -1), mk('5', 1, 1), mk('6', 1, 1)], { horizon: '30m', minSample: 1 });
  const f = L.factorPerformance.find((x) => x.key === 'signedPremium');
  assert.equal(f.n, 4);                    // only the 4 agreeing samples
  assert.equal(f.winRate, 100);
  assert.ok('avgReturn' in L && !('avg1hReturn' in L));
});

test('horizon-scaled ATR: the daily ATR is not the target for a 15 minute window', () => {
  const bars = [{ t: 10, price: 100.9, high: 101, low: 100 }];
  const full = computeCheckpoint({ entryStock: 100, bars, dir: 'bull', atr: 4, entryTs: 0, horizonMin: 390 });
  const short = computeCheckpoint({ entryStock: 100, bars, dir: 'bull', atr: 4, entryTs: 0, horizonMin: 15 });
  assert.equal(full.targetReached, false);     // 1% move vs a 4% target
  assert.equal(short.targetReached, true);     // 4% * sqrt(15/390) = 0.78% target
});

test('benchmark return is reported (unsigned) when benchmark bars are supplied, else null', () => {
  const bars = [{ t: 10, price: 101 }];
  const a = computeCheckpoint({ entryStock: 100, bars, dir: 'bull', benchmarkBars: [{ t: 0, price: 500 }, { t: 10, price: 505 }] });
  assert.equal(a.benchmarkReturnPct, 1);
  assert.equal(computeCheckpoint({ entryStock: 100, bars, dir: 'bull' }).benchmarkReturnPct, null);
});
