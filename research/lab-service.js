// research/lab-service.js — the lab as a service: one object holding the 2-year panel in memory, used by the CLI and by the
// dashboard (through a separate worker process, so the website never freezes while the dataset loads).
import fs from 'node:fs';
import path from 'node:path';
import { buildPanel, getSplits, Ledger, runExplore, runValidate, runVault, shortlist, bonferroniT, exprToString, verdictFor, buildHistory, specId } from './lab.js';
import { proposeSpecs } from './lab-llm.js';

export function createLabService({ dir, labDir, env = process.env, fetchImpl = fetch }) {
  const csv = path.join(labDir, 'features.csv'); let st = null; const ledger = new Ledger(labDir);
  const model = () => env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  function load() {
    if (st) return st;
    if (!fs.existsSync(csv)) { const e = new Error('The lab dataset is not built yet. On the server run: node scripts/uw-lab.mjs features'); e.code = 'NO_DATA'; throw e; }
    const P = buildPanel({ featuresCsv: csv, dir }); st = { P, splits: getSplits(labDir, P) }; return st;
  }
  const brief = (e, n) => ({ id: e.id, name: e.name, hypothesis: e.hypothesis, horizon: e.horizon, expr: exprToString(e.expr), filter: e.filter ? exprToString(e.filter) : null, result: e.result, verdict: verdictFor(e.result, n) });
  return {
    async status() {
      const ex = ledger.byBlock('explore'); const n = ex.length; let blocks = null; try { blocks = JSON.parse(fs.readFileSync(path.join(labDir, 'splits.json'), 'utf8')); } catch { /* not created yet */ }
      return { dataBuilt: fs.existsSync(csv), loaded: !!st, keyConfigured: !!env.OPENROUTER_API_KEY, model: model(), blocks: blocks && { explore: blocks.explore, validate: blocks.validate, vault: blocks.vault }, trials: n, bonferroniT: bonferroniT(Math.max(1, n)), validated: ledger.byBlock('validate').length, vaultOpened: !!ledger.vaultOpened(),
        ideas: ex.slice().sort((a, b) => Math.abs(b.result.t ?? 0) - Math.abs(a.result.t ?? 0)).slice(0, 25).map((e) => brief(e, n)), shortlist: shortlist(ledger).map((e) => e.name),
        validatedResults: ledger.byBlock('validate').map((e) => ({ name: e.name, pass: e.pass, exploreT: e.exploreT, t: e.result.t, ic: e.result.meanIC, thr: e.thr })), vaultResults: ledger.byBlock('vault').map((e) => ({ name: e.name, pass: e.pass, t: e.result.t, ic: e.result.meanIC, netSpreadBps: e.result.netSpreadBps, contaminated: !!e.contaminated })) };
    },
    async ask({ prompt, k = 6 }) {
      const text = String(prompt || '').trim(); if (text.length < 8) { const e = new Error('Write at least a sentence about what you want tested.'); e.code = 'BAD_PROMPT'; throw e; }
      const { P, splits } = load(); const hist = buildHistory(ledger, { summaryOnly: true });
      const out = await proposeSpecs({ apiKey: env.OPENROUTER_API_KEY, model: model(), history: hist.text, request: text, k: Math.min(10, Math.max(1, k)), fetchImpl });
      const ran = runExplore({ P, splits, ledger, specs: out.specs, round: 'ask' }); const n = ledger.trialCount(); const ex = ledger.byBlock('explore');
      const results = ran.map((x) => { const e = ex.find((q) => q.id === x.id); return { ...brief(e, n), repeated: !!x.skipped }; });
      return { note: out.note, rejected: out.rejected, usage: out.usage, model: out.model, trials: n, bonferroniT: bonferroniT(Math.max(1, n)), results };
    },
    async validate() { const { P, splits } = load(); const out = runValidate({ P, splits, ledger }); return { results: out.map((x) => ({ name: x.c.name, pass: x.pass, exploreT: x.c.result.t, t: x.result.t, ic: x.result.meanIC, pT: x.result.pT, thr: x.thr })) }; },
    async vault({ confirm } = {}) { if (confirm !== true) { const e = new Error('Opening the vault needs explicit confirmation.'); e.code = 'NEEDS_CONFIRM'; throw e; } const { P, splits } = load(); const out = runVault({ P, splits, ledger }); return { results: out.map((x) => ({ name: x.w.name, pass: x.pass, t: x.result.t, ic: x.result.meanIC, netSpreadBps: x.result.netSpreadBps, thr: x.thr })) }; },
  };
}
export { specId };
