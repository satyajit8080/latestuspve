import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePromotion, applyPromotion, loadPromotion, DEFAULT_PROMOTION } from '../validated/promotion.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('the committed promotion.json keeps primary = "opt" (nothing auto-promotes)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'validated', 'promotion.json'), 'utf8'));
  assert.equal(raw.primary, 'opt');
  assert.equal(loadPromotion(path.join(ROOT, 'validated', 'promotion.json')).primary, 'opt');
});

test('missing/corrupt file falls back to opt', () => {
  assert.equal(loadPromotion('/nonexistent/promotion.json').primary, 'opt');
  assert.deepEqual({ ...DEFAULT_PROMOTION }, { primary: 'opt', approvedBy: null, approvedAt: null, evidence: null });
});

test('v2 is only honoured when approvedBy, approvedAt and evidence are all present', () => {
  assert.equal(normalizePromotion({ primary: 'v2' }).primary, 'opt');
  assert.equal(normalizePromotion({ primary: 'v2', approvedBy: 'a', approvedAt: '2026-01-01' }).primary, 'opt');
  assert.equal(normalizePromotion({ primary: 'v2', approvedBy: 'a', approvedAt: '2026-01-01', evidence: 'report.md' }).primary, 'v2');
  assert.equal(normalizePromotion({ primary: 'bogus' }).primary, 'opt');
});

test('applyPromotion is a no-op by default and never mutates score/dir/tier', () => {
  const sig = { finalScore: 71, dir: 'bull', tier: 'Strong' };
  applyPromotion(sig, { available: true, score: 99, dir: 'bear' }, DEFAULT_PROMOTION);
  assert.deepEqual({ s: sig.finalScore, d: sig.dir, t: sig.tier, p: sig.primaryEngine }, { s: 71, d: 'bull', t: 'Strong', p: 'opt' });
});

test('applyPromotion with an approved v2 publishes v2 and keeps the opt values for audit', () => {
  const sig = { finalScore: 71, dir: 'bull', tier: 'Strong' };
  applyPromotion(sig, { available: true, score: 85, dir: 'bear' }, normalizePromotion({ primary: 'v2', approvedBy: 'me', approvedAt: '2026-01-01', evidence: 'x' }));
  assert.deepEqual({ s: sig.finalScore, d: sig.dir, t: sig.tier, p: sig.primaryEngine, o: sig.optScore }, { s: 85, d: 'bear', t: 'Very Strong', p: 'v2', o: 71 });
  // an unavailable v2 never replaces the score even when promoted
  const s2 = { finalScore: 71, dir: 'bull', tier: 'Strong' };
  applyPromotion(s2, { available: false }, normalizePromotion({ primary: 'v2', approvedBy: 'me', approvedAt: 'x', evidence: 'x' }));
  assert.equal(s2.finalScore, 71); assert.equal(s2.primaryEngine, 'opt');
});

test('no code in the repo writes promotion.json', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'research-data', 'docs'].includes(e.name)) continue; const f = path.join(d, e.name); e.isDirectory() ? walk(f) : /\.(js|mjs)$/.test(e.name) && files.push(f); } };
  walk(ROOT);
  for (const f of files) {
    if (f.includes(path.join('test', ''))) continue;
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/(writeFile|appendFile|rename)(Sync)?\([^)]*promotion\.json/.test(src), `${f} must not write promotion.json`);
  }
});
