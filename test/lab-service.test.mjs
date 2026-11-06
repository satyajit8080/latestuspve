import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLabService } from '../research/lab-service.js';
import { labSynth } from './fixtures/lab-synth.mjs';

const col = (c) => ({ col: c });
const spec = (name, expr, extra = {}) => ({ name, hypothesis: `${name} should predict returns`, horizon: 1, expr, ...extra });
const llm = (specs, note = null) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ specs, note }) } }], usage: { total_tokens: 900 }, model: 'm' }) });

test('service.ask: a plain-language request becomes tests that run on the explore block, with honest verdicts', async () => {
  const { dir, labDir } = labSynth(); let body; const fetchImpl = async (u, o) => { body = JSON.parse(o.body); return llm([spec('planted flow', col('alertSingle')), spec('noise flow', col('alertOpen')), spec('bad', { op: 'exec', args: [] })], 'read as: single-leg flow')(u, o); };
  const svc = createLabService({ dir, labDir, env: { OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'm' }, fetchImpl });
  const r = await svc.ask({ prompt: 'Does single-leg flow predict the next day?' });
  assert.match(body.messages[1].content, /RESEARCHER REQUEST[\s\S]*Does single-leg flow predict the next day\?/); assert.ok(!JSON.stringify(body).includes('"k"') || !body.messages.some((m) => m.content.includes('OPENROUTER')));
  assert.equal(r.results.length, 2); assert.equal(r.rejected.length, 1); assert.equal(r.note, 'read as: single-leg flow'); assert.equal(r.trials, 2);
  const planted = r.results.find((x) => x.name === 'planted flow'), noise = r.results.find((x) => x.name === 'noise flow');
  assert.ok(planted.result.t > 5); assert.notEqual(planted.verdict.level, 'noise'); assert.equal(noise.verdict.level, 'noise');
  const again = await svc.ask({ prompt: 'Does single-leg flow predict the next day? (again)' }); assert.ok(again.results.every((x) => x.repeated), 'same ideas are flagged as already tried'); assert.equal(again.trials, 2, 'and not counted twice');
  const st = await svc.status(); assert.equal(st.trials, 2); assert.equal(st.keyConfigured, true); assert.equal(st.ideas[0].name, 'planted flow'); assert.deepEqual(st.shortlist, ['planted flow']);
});

test('service: validate then vault only on request, vault needs explicit confirmation and opens once', async () => {
  const { dir, labDir } = labSynth(); const svc = createLabService({ dir, labDir, env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: llm([spec('planted flow', col('alertSingle'))]) });
  await svc.ask({ prompt: 'test single leg flow please' }); const v = await svc.validate(); assert.equal(v.results[0].pass, true);
  await assert.rejects(svc.vault({}), /explicit confirmation/); const vv = await svc.vault({ confirm: true }); assert.equal(vv.results[0].pass, true);
  await assert.rejects(svc.vault({ confirm: true }), /already opened/); assert.equal((await svc.status()).vaultOpened, true);
});

test('service: clear errors for a short prompt, a missing dataset and an LLM that says it cannot', async () => {
  const { dir, labDir } = labSynth(); const svc = createLabService({ dir, labDir, env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: llm([], 'needs RSI which we do not have') });
  await assert.rejects(svc.ask({ prompt: 'hi' }), /at least a sentence/);
  const r = await svc.ask({ prompt: 'test RSI oversold bounce on 3 day returns' }); assert.equal(r.results.length, 0); assert.match(r.note, /RSI/);
  const empty = createLabService({ dir, labDir: `${labDir}-none`, env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: llm([]) });
  await assert.rejects(empty.ask({ prompt: 'anything at all, please' }), /dataset is not built yet/); assert.equal((await empty.status()).dataBuilt, false);
});

import fs from 'node:fs';
import path from 'node:path';
import { exportDataset } from '../research/export.js';
import { buildPanel, getSplits } from '../research/lab.js';
test('export: withholds the vault by default, contains no secrets, has checksums and a protocol', () => {
  const { dir, labDir } = labSynth(); const P = buildPanel({ featuresCsv: path.join(labDir, 'features.csv'), dir }); const s = getSplits(labDir, P); const out = path.join(labDir, '..', 'export');
  const r = exportDataset({ labDir, dir, out }); assert.equal(r.vaultIncluded, false); assert.equal(r.cutoff, s.raw.validate[1]);
  const rows = fs.readFileSync(path.join(out, 'features.csv'), 'utf8').split('\n').filter(Boolean).slice(1); assert.ok(rows.length > 1000); assert.ok(rows.every((l) => l.split(',')[1] <= s.raw.validate[1]), 'no vault-period rows');
  const px = fs.readFileSync(path.join(out, 'prices.csv'), 'utf8').split('\n').filter(Boolean).slice(1); assert.ok(px.every((l) => l.split(',')[1] <= s.raw.validate[1]), 'no vault-period prices');
  const dict = fs.readFileSync(path.join(out, 'DATA_DICTIONARY.md'), 'utf8'); assert.match(dict, /WITHHELD on purpose/); assert.match(dict, /Timing rules/); assert.ok(fs.readFileSync(path.join(out, 'PROMPT_FOR_AI.md'), 'utf8').includes('"specs"'));
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'); for (const f of ['features.csv', 'prices.csv', 'DATA_DICTIONARY.md', 'PROMPT_FOR_AI.md']) assert.ok(sums.includes(f));
  for (const f of fs.readdirSync(out)) assert.ok(!/OPENROUTER|UNUSUAL_WHALES|SESSION_SECRET|DASHBOARD_PASSWORD|sk-or-/.test(fs.readFileSync(path.join(out, f), 'utf8')), `${f} must not contain secrets`);
  const withV = exportDataset({ labDir, dir, out: `${out}-v`, includeVault: true }); assert.ok(withV.rows > r.rows); assert.equal(withV.vaultIncluded, true);
  assert.throws(() => exportDataset({ labDir: `${labDir}-none`, dir, out }), /no .*features\.csv/);
});
