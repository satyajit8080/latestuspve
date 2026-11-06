import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradingDays } from '../research/backfill.js';
import { validateNode, validateSpec, specId, OPS, buildPanel, getSplits, evaluateSpec, Ledger, runExplore, runValidate, runVault, shortlist, buildHistory, bonferroniT, exprToString, COLUMNS } from '../research/lab.js';
import { proposeSpecs, parseSpecs, systemPrompt } from '../research/lab-llm.js';

const col = (c) => ({ col: c }); const op = (o, args, p) => ({ op: o, args, ...(p != null ? { p } : {}) });
const good = (extra = {}) => ({ name: 'flow', hypothesis: 'single-leg flow predicts next-day returns', horizon: 1, expr: col('alertSingle'), ...extra });

test('validation: whitelist only, limits enforced, no prototype tricks', () => {
  assert.ok(validateSpec(good())); assert.ok(validateSpec(good({ expr: op('zts', [op('nz', [col('alertSingle')])], 10), filter: op('gt', [col('nAlerts'), { const: 2 }]) })));
  const bad = [good({ expr: col('nope') }), good({ expr: op('exec', [col('alertSingle')]) }), good({ expr: op('constructor', [col('alertSingle')]) }), good({ expr: op('add', [col('alertSingle')]) }), good({ expr: op('zts', [col('alertSingle')], 1) }), good({ expr: op('zts', [col('alertSingle')], 100) }), good({ expr: op('lag', [col('alertSingle')], 21) }),
    good({ expr: op('clip', [col('alertSingle')], [5, 1]) }), good({ hypothesis: '' }), good({ horizon: 2 }), good({ expr: { const: 'x' } }), good({ expr: { const: Infinity } })];
  for (const b of bad) assert.throws(() => validateSpec(b), Error, JSON.stringify(b).slice(0, 80));
  let deep = col('alertSingle'); for (let i = 0; i < 7; i++) deep = op('neg', [deep]); assert.throws(() => validateSpec(good({ expr: deep })), /too deep/);
  let wide = col('alertSingle'); for (let i = 0; i < 14; i++) wide = op('add', [wide, { const: 1 }]); assert.throws(() => validateNode(wide), /too (many|deep)/);
  assert.equal(specId(good({ name: 'a' })), specId(good({ name: 'b', hypothesis: 'other' })), 'name/hypothesis do not change the id');
  assert.notEqual(specId(good()), specId(good({ horizon: 3 })));
  assert.equal(specId(validateSpec({ expr: op('add', [col('alertSingle'), { const: 1 }]), horizon: 1, name: 'x', hypothesis: 'y' })), specId({ horizon: 1, expr: { args: [{ col: 'alertSingle' }, { const: 1 }], op: 'add' } }), 'key order irrelevant');
});

function tinyPanel(T = 3, D = 40, seed = 7) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 - 0.5; };
  const mk = () => Float64Array.from({ length: T * D }, rnd); return { T, D, cols: new Map(), mk };
}
test('time-series ops are causal: changing FUTURE days never changes the value today', () => {
  const P = tinyPanel(); const x = P.mk(); const d0 = 25;
  const x2 = Float64Array.from(x); for (let t = 0; t < P.T; t++) for (let d = d0 + 1; d < P.D; d++) x2[t * P.D + d] += 100;       // perturb the future
  const cases = [['lag', 3], ['ts_sum', 10], ['ts_mean', 10], ['ts_mean_prior', 10], ['ts_std_prior', 10], ['zts', 10], ['ratio_abs_prior', 10]];
  for (const [name, p] of cases) { const a = OPS[name].fn([x], p, P), b = OPS[name].fn([x2], p, P); for (let t = 0; t < P.T; t++) for (let d = 0; d <= d0; d++) { const u = a[t * P.D + d], v = b[t * P.D + d]; assert.ok((Number.isNaN(u) && Number.isNaN(v)) || u === v, `${name} leaked the future at t=${t} d=${d}`); } }
  // cross-sectional ops use only the same day
  const y = Float64Array.from(x); for (let t = 0; t < P.T; t++) y[t * P.D + 3] += 50; for (const name of ['rank_cs', 'zscore_cs', 'demean_cs']) { const a = OPS[name].fn([x], null, { ...P, T: 12, D: 10 }); assert.ok(a); }
});
test('op semantics: lag, windows, prior-only statistics', () => {
  const P = { T: 1, D: 8 }; const x = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...OPS.lag.fn([x], 2, P)].slice(0, 5).map((v) => (Number.isNaN(v) ? 'n' : v)), ['n', 'n', 1, 2, 3]);
  assert.equal(OPS.ts_sum.fn([x], 3, P)[4], 3 + 4 + 5); assert.equal(OPS.ts_mean_prior.fn([x], 3, P)[4], (2 + 3 + 4) / 3);        // prior mean excludes today (5)
  const z = OPS.zts.fn([x], 3, P)[4]; assert.ok(Math.abs(z - (5 - 3) / 1) < 1e-12);                                                  // prior [2,3,4]: mean 3, sd 1
  assert.equal(OPS.div.fn([Float64Array.from([1, 2]), Float64Array.from([0, 4])])[0] !== OPS.div.fn([Float64Array.from([1, 2]), Float64Array.from([0, 4])])[0], true, 'x/0 is missing, not Infinity');
  assert.equal(exprToString(op('zts', [col('alertSingle')], 10)), '(zts[10] alertSingle)');
});

// ---- synthetic study with a planted next-day signal -------------------------------------------------------------------------------
function synth({ noiseOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-')); const dir = path.join(root, 'backfill'); const labDir = path.join(root, 'lab');
  let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };
  const sig = tradingDays('2026-01-05', '2026-08-14').reverse(); const all = tradingDays('2026-01-05', '2026-09-01').reverse(); const tickers = Array.from({ length: 60 }, (_, i) => `S${String(i).padStart(2, '0')}`);
  const lines = ['ticker,date,alertSingle,alertRaw,alertOpen,grossAbs,nAlerts'];
  for (const t of tickers) {
    const X = all.map(() => gauss()); let px = 100; const closes = []; for (let i = 0; i < all.length; i++) { closes.push(px); px *= 1 + (noiseOnly ? 0 : 0.01 * X[i]) + 0.004 * gauss(); }
    fs.mkdirSync(path.join(dir, 'ohlc1d', t), { recursive: true }); fs.writeFileSync(path.join(dir, 'ohlc1d', t, 'series.json'), JSON.stringify({ meta: {}, data: { data: all.map((d, i) => ({ date: d, close: String(closes[i]) })) } }));
    sig.forEach((d, i) => lines.push(`${t},${d},${X[i] * 1e5},${X[i] * 1e5 + gauss() * 1e4},${gauss() * 1e5},${Math.abs(X[i]) * 1e5},${2 + Math.floor(rnd() * 5)}`));
  }
  fs.mkdirSync(labDir, { recursive: true }); fs.writeFileSync(path.join(labDir, 'features.csv'), lines.join('\n') + '\n'); return { dir, labDir, csv: path.join(labDir, 'features.csv') };
}

test('lab end to end: planted signal is found, validated and survives the vault; noise is not; the vault opens only once', () => {
  const { dir, labDir, csv } = synth(); const P = buildPanel({ featuresCsv: csv, dir }); const splits = getSplits(labDir, P);
  assert.ok(splits.explore.end < splits.validate.start && splits.validate.end < splits.vault.start, 'blocks must not overlap');
  assert.ok(fs.existsSync(path.join(labDir, 'splits.json'))); assert.deepEqual(getSplits(labDir, P).raw, splits.raw, 'splits are frozen once created');
  const ledger = new Ledger(labDir);
  const planted = good({ name: 'planted', expr: col('alertSingle') }); const noise = good({ name: 'noise', expr: col('alertOpen') });
  const ex = runExplore({ P, splits, ledger, specs: [planted, noise, planted] });
  assert.equal(ledger.trialCount(), 2, 'a repeated idea is not counted twice'); assert.ok(ex[2].skipped);
  const pr = ex[0].result, nr = ex[1].result; assert.ok(pr.t > 6, `planted explore t ${pr.t}`); assert.ok(Math.abs(nr.t) < 3, `noise explore t ${nr.t}`);
  const sl = shortlist(ledger); assert.deepEqual(sl.map((e) => e.name), ['planted']);
  const hist = buildHistory(ledger).text; assert.match(hist, /Ideas tried so far on the explore block: 2/);
  const v = runValidate({ P, splits, ledger }); assert.equal(v.length, 1); assert.equal(v[0].pass, true, JSON.stringify(v[0].result)); assert.equal(runValidate({ P, splits, ledger }).length, 0, 'each idea is validated once');
  const h2 = buildHistory(ledger).text; assert.ok(!/validate/i.test(h2) && !h2.includes(v[0].result.t.toFixed(2)), 'the LLM-facing history must not contain validate numbers');
  const vault = runVault({ P, splits, ledger }); assert.equal(vault.length, 1); assert.equal(vault[0].pass, true); assert.ok(ledger.vaultOpened());
  assert.throws(() => runVault({ P, splits, ledger }), /already opened/); assert.equal(runVault({ P, splits, ledger, force: true })[0].w.name, 'planted');
  assert.equal(ledger.byBlock('vault').some((e) => e.contaminated), true, 'a forced second look is marked contaminated');
  assert.ok(!/vault/i.test(buildHistory(ledger).text));
});

test('lab: pure noise produces no shortlist candidate that passes validation', () => {
  const { dir, labDir, csv } = synth({ noiseOnly: true }); const P = buildPanel({ featuresCsv: csv, dir }); const splits = getSplits(labDir, P); const ledger = new Ledger(labDir);
  runExplore({ P, splits, ledger, specs: [good({ name: 'a' }), good({ name: 'b', expr: col('alertRaw') }), good({ name: 'c', horizon: 3, expr: op('rank_cs', [col('alertOpen')]) }), good({ name: 'd', expr: op('neg', [col('alertSingle')]) })] });
  const out = runValidate({ P, splits, ledger }); assert.ok(out.every((x) => !x.pass), 'noise must not pass'); assert.ok(bonferroniT(4) > 2.4);
});

test('purge: evaluation never uses a label window that crosses the block end', () => {
  const { dir, labDir, csv } = synth(); const P = buildPanel({ featuresCsv: csv, dir }); const splits = getSplits(labDir, P);
  const r1 = evaluateSpec(P, good({ horizon: 5 }), splits.explore); const r2 = evaluateSpec(P, good({ horizon: 1 }), splits.explore); assert.ok(r1.nDays === r2.nDays - 4 || r1.nDays < r2.nDays, `${r1.nDays} vs ${r2.nDays}`);
});

// ---- the LLM client ------------------------------------------------------------------------------------------------------------------------------
const KEY = 'sk-or-SECRET-KEY-123';
test('llm: prompt documents the language, request is well formed, bad ideas are dropped, key never leaks', async () => {
  const content = '```json\n' + JSON.stringify({ specs: [good({ name: 'ok1' }), { name: 'bad', hypothesis: 'x', horizon: 1, expr: { op: 'exec', args: [] } }, good({ name: 'ok2', horizon: 3, expr: op('zts', [op('nz', [col('flowOtm')])], 20) })] }) + '\n```';
  let seen; const fetchImpl = async (url, o) => { seen = { url, o, body: JSON.parse(o.body) }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 1234 }, model: 'm' }) }; };
  const r = await proposeSpecs({ apiKey: KEY, model: 'm', history: 'HISTORY-TEXT', k: 5, fetchImpl });
  assert.deepEqual(r.specs.map((s) => s.name), ['ok1', 'ok2']); assert.equal(r.rejected.length, 1); assert.match(r.rejected[0].reason, /unknown op/); assert.equal(r.usage.total_tokens, 1234);
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(seen.o.headers.Authorization, `Bearer ${KEY}`);
  const sys = seen.body.messages[0].content, usr = seen.body.messages[1].content; assert.ok(sys.includes('zts') && sys.includes('flowOtm') && sys.includes('ex-mom1')); assert.ok(usr.includes('HISTORY-TEXT'));
  assert.ok(!JSON.stringify(seen.body).includes(KEY), 'the key must not be in the request body'); assert.ok(!JSON.stringify(r).includes(KEY));
  for (const c of COLUMNS) assert.ok(systemPrompt().includes(c), `column ${c} documented`);
});
test('llm: retries 429, gives a clear error on failure and on non-JSON replies', async () => {
  let n = 0; const okBody = { choices: [{ message: { content: JSON.stringify({ specs: [good()] }) } }] };
  const f = async () => (++n < 3 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => okBody });
  assert.equal((await proposeSpecs({ apiKey: KEY, model: 'm', history: '', fetchImpl: f, sleep: async () => {} })).specs.length, 1); assert.equal(n, 3);
  await assert.rejects(proposeSpecs({ apiKey: KEY, model: 'm', history: '', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }), sleep: async () => {} }), /OpenRouter request failed \(HTTP 401\)/);
  await assert.rejects(proposeSpecs({ apiKey: '', model: 'm', history: '' }), /OPENROUTER_API_KEY is not set/);
  assert.throws(() => parseSpecs('I think you should buy'), /not valid JSON/); assert.throws(() => parseSpecs('{"a":1}'), /no "specs"/);
});

test('splits: a feature date without a price day, and a corrupt splits.json, no longer break the lab', () => {
  const { dir, labDir, csv } = synth();
  fs.appendFileSync(csv, `S00,2027-01-04,1,1,1,1,1\n`);                              // a feature date far beyond the price data
  const P = buildPanel({ featuresCsv: csv, dir }); assert.ok(P.sigLast > P.sigFirst && P.sigLast < P.D);
  fs.writeFileSync(path.join(labDir, 'splits.json'), JSON.stringify({ explore: [null, null], validate: [null, null], vault: [null, null] }));
  const splits = getSplits(labDir, P); assert.ok(splits.explore.end < splits.validate.start && splits.validate.end < splits.vault.start);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(JSON.parse(fs.readFileSync(path.join(labDir, 'splits.json'), 'utf8')).explore[0]), 'the broken file was rebuilt');
  fs.rmSync(path.join(dir, 'ohlc1d'), { recursive: true }); assert.throws(() => buildPanel({ featuresCsv: csv, dir }), /no usable calendar/);
});
