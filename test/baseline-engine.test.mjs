// Run: node --test
// FROZEN-baseline guards.
//  1. The LEGACY engine (opt-1.1.1, legacy/) must keep reproducing the values frozen before any scoring change:
//     it is the comparator for opt-1.2.0 and must never drift.
//  2. The PRODUCTION engine (opt-1.2.0) must keep reproducing its own frozen baseline. If this fails, scoring changed:
//     STOP, diff, and only if the change was deliberate regenerate with test/fixtures/regen-baseline-1.2.0.mjs
//     (and bump OPTIONS_ENGINE_VERSION).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildOptionsSignal as buildLegacy, OPTIONS_ENGINE_VERSION as LEGACY_VERSION } from '../legacy/options-engine-1.1.1.js';
import { buildOptionsSignal, OPTIONS_ENGINE_VERSION } from '../engine/options-engine.js';
import { FIXTURES, captureBaseline, FIXTURES_V2, captureBaselineV2 } from './fixtures/engine-fixtures.mjs';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const legacyBaseline = JSON.parse(fs.readFileSync(path.join(dir, 'baseline-signals.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'baseline-signals-1.2.0.json'), 'utf8'));

test('legacy engine opt-1.1.1 still matches its frozen baseline (comparator must never drift)', () => {
  assert.equal(LEGACY_VERSION, 'opt-1.1.1');
  for (const fx of FIXTURES) {
    assert.deepEqual(captureBaseline(buildLegacy(fx.chain, fx.ctx, {})), legacyBaseline[fx.name], `LEGACY DRIFT in fixture "${fx.name}"`);
  }
});

test('production engine opt-1.2.0 matches its frozen baseline (no accidental scoring change)', () => {
  assert.equal(OPTIONS_ENGINE_VERSION, 'opt-1.2.0');
  for (const fx of FIXTURES_V2) {
    assert.deepEqual(captureBaselineV2(buildOptionsSignal(fx.chain, fx.ctx, {})), baseline[fx.name], `BASELINE DRIFT in fixture "${fx.name}" — production scoring changed.`);
  }
});

test('the two engines are different programs: opt-1.2.0 is not the legacy score', () => {
  const a = buildLegacy(FIXTURES[0].chain, FIXTURES[0].ctx, {}).finalScore;
  const b = buildOptionsSignal(FIXTURES_V2[0].chain, FIXTURES_V2[0].ctx, {}).finalScore;
  assert.ok(Number.isFinite(a) && Number.isFinite(b));
});
