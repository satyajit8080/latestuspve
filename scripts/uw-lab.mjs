#!/usr/bin/env node
// scripts/uw-lab.mjs — the AI idea lab (RUN ON THE SERVER; needs the backfill and OPENROUTER_API_KEY in .env for `round`).
//   features                      build research-data/lab/features.csv for the whole backfill (once; ~20 min)
//   info                          show the three sealed time blocks and the ledger counts
//   ask "your request in plain words"   the AI turns your request into tests and runs them on the explore block
//   round [--k 8] [--rounds 1]    the LLM proposes ideas; they are evaluated on the EXPLORE block only
//   eval --file specs.json        evaluate ideas you wrote yourself (explore block), no LLM
//   shortlist                     ideas strong enough on explore to be worth ONE validation
//   validate                      test the shortlist once on the VALIDATE block (multiplicity-corrected)
//   vault --yes-open-vault        open the sealed VAULT once for ideas that passed validate
//   status                        every idea tried, best first
// Options: --dir research-data/backfill  --lab research-data/lab  --file research-data/sp500.txt  --model <openrouter model>
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '../lib/env.js';
import { tradingDays } from '../research/backfill.js';
import { buildFeatures } from '../research/backtest.js';
import { buildPanel, getSplits, Ledger, runExplore, runValidate, runVault, shortlist, buildHistory, bonferroniT, exprToString } from '../research/lab.js';
import { proposeSpecs } from '../research/lab-llm.js';
import { createLabService } from '../research/lab-service.js';

loadEnvFile(path.join(process.cwd(), '.env'), process.env, fs);
const [cmd = 'help', ...rest] = process.argv.slice(2); const flags = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
const dir = flags.dir || path.join('research-data', 'backfill'); const labDir = flags.lab || path.join('research-data', 'lab'); const csv = path.join(labDir, 'features.csv');
const f3 = (v, d = 3) => (v == null ? '  n/a' : v.toFixed(d)); const row = (e) => `${(e.name || '').slice(0, 34).padEnd(34)} h${e.horizon} IC ${f3(e.result.meanIC)} t ${f3(e.result.t, 2).padStart(6)} | ex-mom1 IC ${f3(e.result.pIC)} t ${f3(e.result.pT, 2).padStart(6)} | halves ${f3(e.result.icFirstHalf)}/${f3(e.result.icSecondHalf)} | days ${e.result.nDays}`;
const load = () => { if (!fs.existsSync(csv)) { console.error(`No ${csv}. Run: node scripts/uw-lab.mjs features`); process.exit(1); } const P = buildPanel({ featuresCsv: csv, dir }); return { P, splits: getSplits(labDir, P), ledger: new Ledger(labDir) }; };

if (cmd === 'features') {
  const tk = fs.readFileSync(flags.file || path.join('research-data', 'sp500.txt'), 'utf8').split(/[\s,;]+/).filter(Boolean); const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); const to = flags.to || shift(todayEt, -1); const from = flags.from || '2024-12-04';
  console.log(`Building lab features: ${tk.length} tickers, ${from}..${to}`); fs.mkdirSync(labDir, { recursive: true });
  console.log(`wrote ${buildFeatures({ dir, tickers: tk, dates: tradingDays(from, to).reverse(), out: csv, log: (m) => console.log(m) })} rows → ${csv}`);
} else if (cmd === 'info') {
  const { P, splits, ledger } = load(); console.log(`panel: ${P.T} tickers x ${P.D} days; columns: ${[...P.cols.keys()].length}`); for (const b of ['explore', 'validate', 'vault']) console.log(`${b.padEnd(9)} ${splits.raw[b][0]} .. ${splits.raw[b][1]}   ideas tested: ${ledger.byBlock(b).length}`);
  console.log(`vault opened: ${ledger.vaultOpened() ? ledger.vaultOpened().openedAt : 'no'} | Bonferroni |t| for ${ledger.trialCount()} explore ideas: ${f3(bonferroniT(Math.max(1, ledger.trialCount())), 2)}`);
} else if (cmd === 'round') {
  const { P, splits, ledger } = load(); const model = flags.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'; const k = Math.min(15, Number(flags.k || 8)); const rounds = Math.min(5, Number(flags.rounds || 1));
  for (let r = 1; r <= rounds; r++) {
    const h = buildHistory(ledger); console.log(`\n--- round ${r}/${rounds} (model ${model}; ideas so far ${h.trials}) ---`);
    const out = await proposeSpecs({ apiKey: process.env.OPENROUTER_API_KEY, model, history: h.text, k }); console.log(`model proposed ${out.specs.length} valid ideas${out.rejected.length ? `, ${out.rejected.length} rejected (${out.rejected.map((x) => x.reason).slice(0, 3).join('; ')})` : ''}${out.usage ? `; tokens ${out.usage.total_tokens ?? '?'}` : ''}`);
    for (const x of runExplore({ P, splits, ledger, specs: out.specs, round: `${Date.now()}` })) { if (x.skipped) { console.log(`  (skipped, ${x.skipped})`); continue; } console.log(`  ${row({ name: x.spec.name, horizon: x.spec.horizon, result: x.result })}\n      ${exprToString(x.spec.expr)}  — ${x.spec.hypothesis}`); }
  }
  console.log(`\nIdeas tried on explore: ${ledger.trialCount()}; Bonferroni |t| = ${f3(bonferroniT(Math.max(1, ledger.trialCount())), 2)}. Next: node scripts/uw-lab.mjs shortlist`);
} else if (cmd === 'ask') {
  const prompt = rest.filter((x) => !x.startsWith('--')).join(' ').trim(); if (!prompt) { console.error('Usage: node scripts/uw-lab.mjs ask "does opening flow predict 3-day returns?"'); process.exit(1); }
  const svc = createLabService({ dir, labDir }); const r = await svc.ask({ prompt, k: Number(flags.k || 6) });
  if (r.note) console.log(`note: ${r.note}`); if (!r.results.length) console.log('The AI produced no testable idea.');
  for (const x of r.results) console.log(`\n${x.name}  [${x.verdict.level}]${x.repeated ? ' (already tried)' : ''}\n  ${x.expr}${x.filter ? `  only when ${x.filter}` : ''}  h${x.horizon}\n  ${row(x)}\n  ${x.verdict.text}`);
  console.log(`\nIdeas tried: ${r.trials}; bar for "real": |t| >= ${f3(r.bonferroniT, 2)}`);
} else if (cmd === 'eval') {
  const { P, splits, ledger } = load(); const specs = JSON.parse(fs.readFileSync(flags.file, 'utf8')); const list = Array.isArray(specs) ? specs : specs.specs;
  for (const x of runExplore({ P, splits, ledger, specs: list, round: 'manual' })) console.log(x.skipped ? `(skipped, ${x.skipped})` : row({ name: x.spec.name, horizon: x.spec.horizon, result: x.result }));
} else if (cmd === 'shortlist') {
  const { ledger } = load(); const s = shortlist(ledger); console.log(`${s.length} idea(s) strong enough on explore (|t|>=2.5, both halves and ex-mom1 agree):`); for (const e of s) console.log(`  ${row(e)}\n      ${exprToString(e.expr)}`); if (s.length) console.log('Next: node scripts/uw-lab.mjs validate  (each is tested ONCE)');
} else if (cmd === 'validate') {
  const { P, splits, ledger } = load(); const out = runValidate({ P, splits, ledger }); if (!out.length) console.log('Nothing to validate.');
  for (const x of out) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.c.name}: explore t ${f3(x.c.result.t, 2)} -> validate t ${f3(x.result.t, 2)} IC ${f3(x.result.meanIC)} ex-mom1 t ${f3(x.result.pT, 2)} (needs same sign and |t| >= ${f3(x.thr, 2)})`);
} else if (cmd === 'vault') {
  if (flags['yes-open-vault'] !== 'true') { console.error('The vault can be opened ONCE. Re-run with --yes-open-vault when you are done exploring.'); process.exit(1); }
  const { P, splits, ledger } = load(); const out = runVault({ P, splits, ledger }); if (!out.length) console.log('No idea passed validation, nothing to open.');
  for (const x of out) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.w.name}: vault IC ${f3(x.result.meanIC)} t ${f3(x.result.t, 2)} ex-mom1 t ${f3(x.result.pT, 2)} net spread ${f3(x.result.netSpreadBps, 1)} bps (needs |t| >= ${f3(x.thr, 2)})`);
} else if (cmd === 'status') {
  const { ledger } = load(); const ex = ledger.byBlock('explore').sort((a, b) => Math.abs(b.result.t ?? 0) - Math.abs(a.result.t ?? 0)); console.log(`${ex.length} ideas on explore; validated ${ledger.byBlock('validate').length}; vault ${ledger.byBlock('vault').length}`); for (const e of ex.slice(0, 25)) console.log(row(e));
} else console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
