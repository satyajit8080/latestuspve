import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, bandWithHysteresis, DEFAULT_CONFIG as C } from '../engine/state.js';

const at = (min) => new Date(Date.UTC(2026, 7, 24, 14, 0) + min * 60000).toISOString();
const run = (s, seq, t0 = 0) => { let t = t0; for (const [score, dir] of seq) s = step(s, { score, dir, at: at(t += 5) }); return s; };

test('a slow climb promotes BULL -> STRONG_BULL (the old deadband kept it stuck at BULL)', () => {
  let s = null;
  const seq = []; for (let sc = 66; sc <= 95; sc += 1) seq.push([sc, 'bull']);
  const states = new Set();
  let t = 0;
  for (const [score, dir] of seq) { s = step(s, { score, dir, at: at(t += 5) }); states.add(s.state); }
  assert.ok(states.has('BULL'));
  assert.equal(s.state, 'STRONG_BULL');
  assert.ok(s.smoothedScore >= C.strongThreshold);
});

test('hysteresis: a band is entered at its threshold and left only below threshold - deadband', () => {
  assert.equal(bandWithHysteresis(80, 0), 3);
  assert.equal(bandWithHysteresis(79, 0), 2);
  assert.equal(bandWithHysteresis(76, 3), 3);       // inside the hysteresis zone: STRONG is held
  assert.equal(bandWithHysteresis(74.9, 3), 2);     // below 80 - 5: leaves STRONG
  assert.equal(bandWithHysteresis(61, 2), 2);       // BULL held down to 65 - 5 = 60
  assert.equal(bandWithHysteresis(59, 2), 1);
  assert.equal(bandWithHysteresis(50, 1), 1);       // WATCH held down to 55 - 5
  assert.equal(bandWithHysteresis(49, 1), 0);
});

test('small wiggles inside the hysteresis zone do not flap the state', () => {
  let s = run(null, Array.from({ length: 12 }, () => [88, 'bull']));
  assert.equal(s.state, 'STRONG_BULL');
  s = run(s, [[77, 'bull'], [78, 'bull'], [77, 'bull'], [79, 'bull'], [78, 'bull'], [77, 'bull']], 100);
  assert.equal(s.state, 'STRONG_BULL');
});

test('the smoothed score is signed: bull -> bear passes through zero', () => {
  let s = run(null, Array.from({ length: 6 }, () => [80, 'bull']));
  assert.ok(s.smoothedSigned > 0);
  s = run(s, [[80, 'bear']], 60);
  assert.ok(s.smoothedSigned < s.smoothedSigned + 1);
  let crossed = false;
  for (let i = 0; i < 8; i++) { s = run(s, [[80, 'bear']], 70 + i * 5); if (s.smoothedSigned < 0) crossed = true; }
  assert.ok(crossed);
});

test('BULL -> NEUTRAL -> BEAR respects the same cooldown and flip margin as a direct flip', () => {
  let s = run(null, Array.from({ length: 8 }, () => [85, 'bull']));
  assert.equal(s.state, 'STRONG_BULL');
  // fade to neutral (score 0)
  let t = 100;
  for (let i = 0; i < 12; i++) s = step(s, { score: 0, dir: 'neutral', at: at(t += 5) });
  assert.equal(s.state, 'NEUTRAL');
  assert.equal(s.lastSide, 'bull');
  // an immediate strong bear: cooldown (3 polls after leaving bull) and the margin both guard the opposite side
  const reasons = [];
  s = { ...s, cooldown: 3, smoothedSigned: -60 };     // a bear signal already building: the cooldown is what stops it
  for (let i = 0; i < 2; i++) { s = step(s, { score: 100, dir: 'bear', at: at(t += 5) }); reasons.push(s.reason); }
  assert.equal(reasons[0], 'cooldown', reasons.join(','));
  assert.equal(s.state, 'NEUTRAL');
  // a weak bear (below the 75 margin) never gets in, even after the cooldown
  let s2 = { ...s, cooldown: 0, smoothedSigned: -60 };
  for (let i = 0; i < 10; i++) s2 = step(s2, { score: 70, dir: 'bear', at: at(t += 5) });
  assert.equal(s2.state, 'NEUTRAL');
  assert.equal(s2.reason, 'flip_margin_not_met');
  // re-entering the SAME side after neutral is not a flip
  let s3 = { ...s, cooldown: 3, smoothedSigned: 0, state: 'NEUTRAL', lastSide: 'bull', pendingState: null, pendingCount: 0 };
  for (let i = 0; i < 12; i++) s3 = step(s3, { score: 90, dir: 'bull', at: at(t += 5) });
  assert.ok(s3.state.includes('BULL'));
});

test('a stale gap between polls resets the machine (manual polling)', () => {
  let s = run(null, Array.from({ length: 8 }, () => [85, 'bull']));
  assert.equal(s.state, 'STRONG_BULL');
  const later = new Date(Date.parse(s.at) + C.maxGapMs + 60000).toISOString();
  const r = step(s, { score: 85, dir: 'bull', at: later });
  assert.equal(r.reset, true);
  assert.equal(r.resetReason, 'stale_gap');
  assert.equal(r.state, 'NEUTRAL');           // one confirming poll after a reset, not a carried-over STRONG_BULL
  assert.equal(r.polls, 1);
  // within the allowed gap nothing resets
  const soon = step(s, { score: 85, dir: 'bull', at: new Date(Date.parse(s.at) + 10 * 60000).toISOString() });
  assert.equal(soon.reset, false); assert.equal(soon.state, 'STRONG_BULL');
});

test('one noisy opposing poll cannot flip a strong state', () => {
  let s = run(null, Array.from({ length: 8 }, () => [88, 'bull']));
  s = run(s, [[95, 'bear']], 100);
  assert.equal(s.state, 'STRONG_BULL');
});
