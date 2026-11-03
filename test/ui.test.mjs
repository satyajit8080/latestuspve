// UI unit tests (pure modules; no browser needed) + repository rules for public/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { num, signed, pct, usd, compact, times, ago, etClock, countdown, DASH } from '../public/app/fmt.js';
import { marketSession, etParts } from '../public/app/session.js';
import { freshness } from '../public/app/freshness.js';
import { cadenceMs, backoff, jitter, POLLABLE } from '../public/app/poller.js';
import { diffRows } from '../public/ui/table-diff.js';
import { adaptScanRow, adaptScanRows } from '../public/adapt/scanRow.js';
import { parseHash, buildHash } from '../public/app/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'nyse-calendar.json'), 'utf8'));
const at = (iso) => Date.parse(iso);

test('formatters: null/NaN/undefined are the dash, never 0; signs use a true minus', () => {
  for (const f of [num, (v) => signed(v), pct, usd, compact, times, (v) => ago(v)]) for (const v of [null, undefined, NaN, Infinity]) assert.equal(f(v), DASH);
  assert.equal(signed(1.236, 2, '%'), '+1.24%'); assert.equal(signed(-0.8, 2, '%'), '−0.80%'); assert.equal(signed(0, 1), '0.0');
  assert.equal(compact(-1500000, true), '−1.50M'); assert.equal(compact(12300), '12.3K'); assert.equal(pct(0.5), '50%'); assert.equal(usd(12.3), '$12.30');
  assert.equal(countdown(3725000), '1:02:05'); assert.equal(countdown(-1), DASH);
});

test('ET formatting is DST-correct', () => {
  assert.equal(etClock(at('2026-07-15T14:30:00Z')), '10:30:00');      // EDT = UTC-4
  assert.equal(etClock(at('2026-12-15T14:30:00Z')), '09:30:00');      // EST = UTC-5
});

test('market session: pre / RTH / post / closed / weekend / holiday / half day, across DST', () => {
  const s = (iso) => marketSession(at(iso), CAL);
  assert.equal(s('2026-08-25T12:00:00Z').state, 'PRE');               // 08:00 EDT Tue
  assert.equal(s('2026-08-25T13:30:00Z').state, 'RTH');               // 09:30 EDT
  assert.equal(s('2026-08-25T19:59:00Z').state, 'RTH'); assert.equal(s('2026-08-25T20:00:00Z').state, 'POST');   // 16:00 EDT
  assert.equal(s('2026-08-25T23:30:00Z').state, 'POST');              // 19:30 EDT
  assert.equal(s('2026-08-26T00:30:00Z').state, 'CLOSED');            // 20:30 EDT: after-hours ended at 20:00
  assert.equal(s('2026-08-22T15:00:00Z').state, 'CLOSED');            // Saturday
  assert.equal(s('2026-12-15T14:30:00Z').state, 'RTH');               // 09:30 EST: RTH starts at the right UTC hour in winter
  assert.equal(s('2026-12-15T14:29:00Z').state, 'PRE');
  assert.equal(s('2026-11-26T15:00:00Z').state, 'HOLIDAY');           // Thanksgiving
  const half = s('2026-11-27T17:30:00Z');                              // 12:30 EST on the half day
  assert.equal(half.state, 'HALF'); assert.equal(half.rth, true);
  assert.equal(s('2026-11-27T18:30:00Z').state, 'POST');              // 13:30 EST: half-day RTH already ended at 13:00
  const open = s('2026-08-25T19:00:00Z');                              // 15:00 EDT: closes in 1h
  assert.equal(open.nextLabel, 'closes'); assert.equal(open.nextChangeMs, 3600000);
  assert.equal(etParts(at('2026-03-08T07:30:00Z')).date, '2026-03-08');   // spring-forward day parses
});

test('freshness: manual scans get generous thresholds; a closed market never shows red "expired"', () => {
  const m = 60000;
  assert.equal(freshness(2 * m, 'RTH').level, 'live'); assert.equal(freshness(20 * m, 'RTH').level, 'stale'); assert.equal(freshness(45 * m, 'RTH').level, 'offline');
  assert.equal(freshness(60 * m, 'POST').level, 'stale'); assert.notEqual(freshness(10 * 60 * m, 'CLOSED').level, 'offline'); assert.notEqual(freshness(5 * 24 * 60 * m, 'HOLIDAY').level, 'offline');
  assert.equal(freshness(null, 'RTH').level, 'idle');
});

test('poller: cadence follows the session, scanning speeds up polling, closed signals are on-demand, backoff is capped', () => {
  assert.equal(cadenceMs('scan', 'RTH', false), 15000); assert.equal(cadenceMs('scan', 'POST', false), 30000); assert.equal(cadenceMs('scan', 'CLOSED', false), 120000); assert.equal(cadenceMs('scan', 'RTH', true), 2000);
  assert.equal(cadenceMs('signals', 'RTH', false), 30000); assert.equal(cadenceMs('signals', 'CLOSED', false), 0); assert.equal(cadenceMs('readiness', 'RTH', true), 5000);
  assert.equal(backoff(15000, 0), 15000); assert.equal(backoff(15000, 1), 30000); assert.equal(backoff(15000, 5), 60000); assert.equal(backoff(2000, 1), 4000);
  for (let i = 0; i < 50; i++) { const j = jitter(10000); assert.ok(j >= 9000 && j <= 11000); }
});

test('polling budget: only zero-UW-cost endpoints are pollable, and the sources never auto-fetch spending routes', () => {
  assert.deepEqual(POLLABLE.slice().sort(), ['/api/journal/resolve/status', '/api/research/readiness', '/api/scan/status', '/api/signals/us', '/auth/status']);
  const main = fs.readFileSync(path.join(ROOT, 'public', 'app', 'main.js'), 'utf8');
  const polled = [...main.matchAll(/async function poll\w+\(.*?\n/gs)].join('') + main.slice(main.indexOf('jobs: ['), main.indexOf('jobs: [') + 400);
  for (const bad of ['/api/options', '/api/ai', '/api/validated', '/api/shadow', '/refresh']) assert.ok(!polled.includes(bad), `poller must not touch ${bad}`);
});

test('table diff: new / dropped / changed fields / rank movement', () => {
  const a = [{ t: 'A', s: 90 }, { t: 'B', s: 80 }, { t: 'C', s: 70 }];
  const b = [{ t: 'B', s: 85 }, { t: 'A', s: 90 }, { t: 'D', s: 60 }];
  const d = diffRows(a, b, (r) => r.t, ['s']);
  assert.deepEqual(d.added, ['D']); assert.deepEqual(d.removed, ['C']);
  assert.deepEqual([...d.changed], [['B', ['s']]]);
  assert.equal(d.rankDelta.get('B'), 1); assert.equal(d.rankDelta.get('A'), -1);
  assert.deepEqual(diffRows(null, b, (r) => r.t, ['s']).added, []);       // first snapshot: nothing is "new"
});

test('adapter: today\'s scan row and the planned row map to the same view model; nulls stay null', () => {
  const today = { ticker: 'NVDA', productionScore: 82, signal: 'CALL', dir: 'bull', dataQuality: 100, price: 100, changePct: 1.2, relativeVolume: 1.5, ivRank: 40, oiChangeNet: 500, updatedAt: '2026-08-25T15:00:00Z', v2Score: 70, v2Dir: 'bull' };
  const planned = { ticker: 'NVDA', productionScore: 82, signal: 'CALL', dir: 'bull', coverage: 1, gated: false, gateReasons: [], actionable: true, price: 100, changePct: 1.2, relativeVolume: 1.5, ivRank: 40, oiChangeNet: 500, updatedAt: '2026-08-25T15:00:00Z', v2Score: 70, v2Dir: 'bull' };
  const x = adaptScanRow(today), y = adaptScanRow(planned);
  for (const k of ['ticker', 'dir', 'score', 'coverage', 'price', 'changePct', 'rvol', 'ivr', 'oiNet', 'updatedAt']) assert.deepEqual(x[k], y[k], k);
  const sparse = adaptScanRow({ ticker: 'X', productionScore: null, price: null, vsVwapPct: undefined });
  assert.equal(sparse.score, null); assert.equal(sparse.price, null); assert.equal(sparse.vsVwapPct, null); assert.equal(sparse.dir, 'neutral');
  const gated = adaptScanRow({ ticker: 'G', productionScore: 0, gated: true, rawScore: 77, dir: 'bull', gateReasons: ['EARNINGS'] });
  assert.equal(gated.gated, true); assert.equal(gated.rawScore, 77); assert.deepEqual(gated.gates, ['EARNINGS']);
  assert.equal(adaptScanRows([{ ticker: 'E', error: 'x' }, today]).length, 1);
});

test('router: hash round trip', () => {
  assert.deepEqual(parseHash('#/t/NVDA'), { view: 't', param: 'NVDA', query: {} });
  assert.deepEqual(parseHash('#/journal?tab=evaluation&min=80'), { view: 'journal', param: null, query: { tab: 'evaluation', min: '80' } });
  assert.equal(parseHash('').view, 'scan');
  assert.equal(buildHash('scan', null, { min: '70', q: '' }), '#/scan?min=70');
});

// ---------------------------------------------------------------------------- repository rules for public/
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const PUB = walk(path.join(ROOT, 'public'));
const text = (f) => fs.readFileSync(f, 'utf8');

test('public/ has no scoring math, no PVE/prediction-market branding and no removed modules', () => {
  const js = PUB.filter((f) => f.endsWith('.js'));
  const bad = new RegExp(['combineScores', 'optCombine', 'buildSignal', 'emitDecision', 'scoreTier', 'createOverviewSim', 'scoreFeatures', 'scoreOptions'].join('|'));
  for (const f of js) assert.ok(!bad.test(text(f)), `${f} contains scoring code`);
  for (const f of PUB.filter((x) => /\.(js|html|css)$/.test(x))) assert.ok(!/pve|prediction.market|polymarket/i.test(text(f).replace(/localStorage\.removeItem[^\n]*\n/g, '').replace(/'pve_[a-z]+'/g, '')), `${f} mentions removed vendor/features`);
  for (const gone of ['engine.js', 'options-engine.js', 'overview-sim.js', 'app.js']) assert.equal(fs.existsSync(path.join(ROOT, 'public', gone)), false, gone);
});

test('no inline style attributes in templates (CSS custom properties via vars only); no colour literals outside tokens.css', () => {
  for (const f of PUB.filter((x) => x.endsWith('.js'))) {
    const src = text(f);
    assert.ok(!/style=["'`]/.test(src), `${f} has an inline style attribute`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src.replace(/&#\d+;/g, '').replace(/'#\/[a-z]*'/g, '').replace(/href: '#\/?[a-z]*'/g, '').replace(/#\/(scan|t)/g, '').replace(/'#main'|"#main"|'#'/g, '').replace(/\$\('#[a-z-]+'/g, '')), `${f} has a hex colour literal`);
  }
  assert.ok(!/style=/.test(text(path.join(ROOT, 'public', 'index.html'))));
  for (const f of PUB.filter((x) => x.endsWith('.css') && !x.endsWith('tokens.css'))) assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text(f).replace(/rgba?\([^)]*\)/g, '')), `${f} has a colour literal outside tokens.css`);
});

test('type scale stays within tokens (>= 11px) and numbers are tabular', () => {
  for (const f of PUB.filter((x) => x.endsWith('.css') && !x.endsWith('tokens.css'))) { const m = [...text(f).matchAll(/font-size:\s*(\d+)px/g)].map((x) => Number(x[1])); assert.ok(m.every((n) => n >= 11), `${f}: font-size below 11px`); }
  assert.match(text(path.join(ROOT, 'public', 'styles', 'base.css')), /tabular-nums/);
});

test('motion: the only perpetual animations are the live-dot breath and the scan indeterminate bar/skeleton, all reduced-motion safe', () => {
  const css = PUB.filter((x) => x.endsWith('.css')).map(text).join('\n');
  const infinite = [...css.matchAll(/animation:[^;]*infinite/g)].map((m) => m[0]);
  assert.equal(infinite.length, 3);                                   // breath, indeterminate progress, skeleton
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.ok(!/scanline|backdrop-filter|background-clip:\s*text/.test(css));
});

test('accessibility basics: landmarks, aria-sort, dialog role, labelled login form, skip link', () => {
  const html = text(path.join(ROOT, 'public', 'index.html'));
  assert.match(html, /href="#main"/); assert.match(html, /<html lang="en">/);
  assert.match(text(path.join(ROOT, 'public', 'ui', 'data-table.js')), /aria-sort|'aria-sort'/);
  assert.match(text(path.join(ROOT, 'public', 'ui', 'dialog.js')), /role: 'dialog'[\s\S]*aria: \{ modal: 'true'/);
  const login = text(path.join(ROOT, 'public', 'views', 'login.js'));
  assert.match(login, /h\('form'/); assert.match(login, /h\('label', \{ for: 'pw' \}/); assert.match(login, /autocomplete: 'current-password'/);
  assert.match(text(path.join(ROOT, 'public', 'app', 'main.js')), /aria-label': 'Primary'|'aria-label', 'Primary'|"Primary"|'Primary'/);
});

test('the scan table has exactly the 13 specified columns, and the primary UI omits shadow/v2/delta columns', () => {
  const src = text(path.join(ROOT, 'public', 'views', 'scan.js'));
  const keys = [...src.matchAll(/\{ key: '([a-zA-Z]+)',(?: hideM: true,)? label:/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['rank', 'ticker', 'dir', 'score', 'coverage', 'gates', 'price', 'changePct', 'vsVwapPct', 'rvol', 'oiNet', 'ivr', 'updatedAt']);
  assert.ok(!/v2|shadow|agree|marketBias|scoreDelta/i.test(src.replace(/\/\/.*$/gm, '')), 'primary scan view must not show shadow data');
});
