// Run: node --test
// Direction invariants for the production engine (opt-1.2.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionsSignal } from '../engine/options-engine.js';
import { FIXTURES_V2 } from './fixtures/engine-fixtures.mjs';

const fx = (name) => FIXTURES_V2.find((f) => f.name === name);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
// mirror of scan-universe.js signalFrom: a CALL/PUT label needs an actionable signal AND score >= 65
function signalFrom(sig) { if (!isNum(sig.finalScore)) return 'DATA UNAVAILABLE'; if (!sig.actionable || sig.finalScore < 65) return 'WATCH'; return sig.dir === 'bull' ? 'CALL' : sig.dir === 'bear' ? 'PUT' : 'WATCH'; }

test('bullish aggressor-signed flow with price confirmation is an actionable CALL', () => {
  const s = buildOptionsSignal(fx('bull').chain, fx('bull').ctx, {});
  assert.equal(s.dir, 'bull'); assert.equal(signalFrom(s), 'CALL');
});

test('a down-trending stock cannot produce an actionable CALL (price below VWAP conflicts with bullish flow)', () => {
  const s = buildOptionsSignal(fx('bull_price_conflict').chain, fx('bull_price_conflict').ctx, {});
  assert.equal(s.dir, 'bull');
  assert.equal(s.actionable, false);
  assert.equal(signalFrom(s), 'WATCH');
  assert.ok(s.finalScore < buildOptionsSignal(fx('bull').chain, fx('bull').ctx, {}).finalScore);
});

test('a rising stock cannot produce an actionable PUT', () => {
  const ctx = { ...fx('bear').ctx, vwap: 96 };            // price 100 is 2 ATR above VWAP
  const s = buildOptionsSignal(fx('bear').chain, ctx, {});
  assert.equal(s.dir, 'bear'); assert.equal(signalFrom(s), 'WATCH');
});

test('bearish signed flow gives a PUT; mirror-image inputs give mirror-image direction', () => {
  const s = buildOptionsSignal(fx('bear').chain, fx('bear').ctx, {});
  assert.equal(s.dir, 'bear'); assert.equal(signalFrom(s), 'PUT');
});

test('a call-heavy chain with NO signed flow and no history has no direction (raw call counts are never a direction)', () => {
  const s = buildOptionsSignal(fx('bull').chain, { now: fx('bull').ctx.now, vwap: 98.5, atr: 2, earningsDaysAway: 30 }, {});
  assert.equal(s.dir, 'neutral'); assert.equal(signalFrom(s), 'WATCH');
});

test('neutral direction is never a call, whatever the score', () => {
  assert.equal(signalFrom({ finalScore: 85, dir: 'neutral', actionable: false }), 'WATCH');
  assert.equal(signalFrom({ finalScore: 85, dir: 'neutral', actionable: true }), 'WATCH');
  assert.equal(signalFrom({ finalScore: 64, dir: 'bull', actionable: true }), 'WATCH');
  assert.equal(signalFrom({ finalScore: 65, dir: 'bull', actionable: true }), 'CALL');
});
