import { h, mount } from '../ui/dom.js';
import { api } from '../app/api.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { DASH, isNum } from '../app/fmt.js';

const EXAMPLES = [
  'Does single-leg flow bought at the ask predict 3-day returns? Use the last 3 days of flow.',
  'Test opening flow only, for 1-day returns.',
  'Do sweeps in options expiring within 7 days predict the next day?',
  'Does flow within 5 days of earnings behave differently? Test 3-day returns.',
  'Compare near-the-money flow with far out-of-the-money flow for 1-day returns.',
];
const f = (v, d = 3) => (isNum(v) ? v.toFixed(d) : DASH);
const chipFor = (lvl) => (lvl === 'strong' ? 'chip ok' : lvl === 'promising' ? 'chip gate' : 'chip neutral');

export function renderLab(root) {
  let alive = true; const statusBox = h('div', { class: 'stack' }); const out = h('div', { class: 'stack' }); const history = h('div', { class: 'stack' });
  const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const panel = (t, ...c) => h('section', { class: 'panel' }, h('header', {}, h('h2', {}, t)), h('div', { class: 'body stack' }, ...c));
  const ta = h('textarea', { class: 'textarea', rows: '4', maxlength: '1500', placeholder: 'Describe what you want tested, in plain words…', aria: { label: 'What do you want tested?' } });
  const runBtn = h('button', { class: 'btn primary', onclick: ask }, 'Run test');

  function card(r) {
    const x = r.result || {};
    return h('section', { class: 'panel' }, h('header', {}, h('h2', {}, r.name), h('span', { class: chipFor(r.verdict.level) }, r.verdict.level), r.repeated ? h('span', { class: 'chip' }, 'already tried') : null),
      h('div', { class: 'body stack' }, h('p', {}, r.hypothesis), h('p', { class: 'dim expr' }, `${r.expr}${r.filter ? `  ·  only when ${r.filter}` : ''}  ·  ${r.horizon}-day horizon`),
        h('div', { class: 'kv' }, kv('IC', f(x.meanIC)), kv('t-stat', f(x.t, 2)), kv('IC without yesterday’s move', f(x.pIC)), kv('t (that)', f(x.pT, 2)), kv('First / second half', `${f(x.icFirstHalf)} / ${f(x.icSecondHalf)}`), kv('Days used', isNum(x.nDays) ? String(x.nDays) : DASH), kv('Net spread (bps)', f(x.netSpreadBps, 1))),
        h('p', { class: 'muted' }, r.verdict.text)));
  }
  function drawIdeas(ideas) {
    mount(history, ideas && ideas.length ? h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Everything tried so far (best first)')), h('div', { class: 'body' }, h('table', { class: 'dt' },
      h('thead', {}, h('tr', {}, ['Idea', 'Days', 'IC', 't', 't without yesterday’s move', 'Verdict'].map((c, i) => h('th', { class: i ? 'r' : '' }, c)))),
      h('tbody', {}, ideas.map((r) => h('tr', { class: 'row' }, h('td', {}, r.name), h('td', { class: 'r num' }, `${r.horizon}d`), h('td', { class: 'r num' }, f(r.result.meanIC)), h('td', { class: 'r num' }, f(r.result.t, 2)), h('td', { class: 'r num' }, f(r.result.pT, 2)), h('td', { class: 'r' }, h('span', { class: chipFor(r.verdict.level) }, r.verdict.level)))))))) : null);
  }
  async function loadStatus() {
    try {
      const r = await api('/api/lab/status'); if (!alive) return; const d = r.data || {};
      if (d.busy) { mount(statusBox, h('div', { class: 'banner warn' }, `The lab is busy (${d.op}). It will be ready in a moment.`)); return; }
      if (!r.ok || d.ok === false) { mount(statusBox, h('div', { class: 'banner err', role: 'alert' }, d.error || 'The lab is unavailable.')); return; }
      const b = d.blocks;
      mount(statusBox, !d.dataBuilt ? h('div', { class: 'banner warn' }, 'The lab dataset is not built yet. On the server run: node scripts/uw-lab.mjs features') : null, !d.keyConfigured ? h('div', { class: 'banner warn' }, 'No OPENROUTER_API_KEY on the server. Add it to .env and restart.') : null,
        panel('Dataset and guardrails', h('div', { class: 'kv' }, kv('AI model', d.model || DASH), kv('Ideas tried', String(d.trials ?? 0)), kv('Bar for “real” (|t|)', f(d.bonferroniT, 2)), kv('Validated', String(d.validated ?? 0)), kv('Vault', d.vaultOpened ? 'opened' : 'sealed'),
          b ? kv('Explore days', `${b.explore[0]} → ${b.explore[1]}`) : null, b ? kv('Validate days', `${b.validate[0]} → ${b.validate[1]}`) : null, b ? kv('Vault days', `${b.vault[0]} → ${b.vault[1]}`) : null),
          h('p', { class: 'muted' }, 'Tests run on the explore days only. Each idea you try raises the bar a result must clear. Ideas that look good go to the validate days once, then to the sealed vault once.')));
      drawIdeas(d.ideas);
    } catch { if (alive) mount(statusBox, h('div', { class: 'banner err', role: 'alert' }, 'Cannot reach the server.')); }
  }
  async function ask() {
    const prompt = ta.value.trim(); if (prompt.length < 8) { toast('Write at least a sentence about what you want tested.', 'warn'); return; }
    runBtn.disabled = true; runBtn.textContent = 'Working…'; mount(out, h('p', { class: 'muted' }, 'Asking the AI to turn your request into tests, then running them on the 2-year dataset. The first run loads the dataset and can take about a minute.'));
    try {
      const r = await api('/api/lab/ask', { method: 'POST', body: { prompt } }); const d = r.data || {};
      if (!r.ok || d.ok === false) mount(out, h('div', { class: 'banner err', role: 'alert' }, d.error || 'The test failed.'));
      else mount(out, d.note ? h('div', { class: 'banner shadow' }, d.note) : null, d.results && d.results.length ? d.results.map(card) : h('p', { class: 'muted' }, 'The AI did not produce a testable idea.'),
        d.rejected && d.rejected.length ? h('p', { class: 'dim' }, `${d.rejected.length} idea(s) were dropped because they could not be expressed with the available data.`) : null);
    } catch { mount(out, h('div', { class: 'banner err', role: 'alert' }, 'Cannot reach the server.')); }
    runBtn.disabled = false; runBtn.textContent = 'Run test'; loadStatus();
  }
  async function validate() {
    const r = await api('/api/lab/validate', { method: 'POST', body: {} }); const d = r.data || {};
    if (!r.ok || d.ok === false) return toast(d.error || 'Validation failed', 'err');
    if (!d.results.length) return toast('Nothing qualifies for validation yet (needs |t| of at least 2.5, consistent).', 'warn');
    openDialog({ title: 'Validation results', body: h('div', { class: 'stack' }, d.results.map((x) => h('p', {}, h('span', { class: x.pass ? 'chip ok' : 'chip neutral' }, x.pass ? 'PASS' : 'FAIL'), ` ${x.name}: explore t ${f(x.exploreT, 2)} → validate t ${f(x.t, 2)} (needs the same sign and |t| ≥ ${f(x.thr, 2)})`))) }); loadStatus();
  }
  function vault() {
    const go = h('button', { class: 'btn primary', onclick: async () => { go.disabled = true; const r = await api('/api/lab/vault', { method: 'POST', body: { confirm: true } }); const d = r.data || {}; dlg.close(); if (!r.ok || d.ok === false) return toast(d.error || 'Vault failed', 'err');
      openDialog({ title: 'Vault results', body: h('div', { class: 'stack' }, d.results.length ? d.results.map((x) => h('p', {}, h('span', { class: x.pass ? 'chip ok' : 'chip neutral' }, x.pass ? 'PASS' : 'FAIL'), ` ${x.name}: t ${f(x.t, 2)}, IC ${f(x.ic)}, net spread ${f(x.netSpreadBps, 1)} bps`)) : h('p', {}, 'No idea had passed validation, so nothing was opened.')) }); loadStatus(); } }, 'Open the vault');
    const dlg = openDialog({ title: 'Open the sealed vault?', body: h('div', { class: 'stack' }, h('p', {}, 'The vault can be opened once. Do this only when you are finished exploring and validating.'), go) });
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Lab')),
    h('div', { class: 'stack' }, statusBox,
      panel('Ask the AI to test something', h('p', { class: 'muted' }, 'Describe a test in plain words. The AI turns it into precise tests; our code runs them on 2 years of S&P 500 flow data and tells you if it is noise.'), ta,
        h('div', { class: 'filterbar' }, runBtn, h('button', { class: 'btn', onclick: validate }, 'Validate best ideas'), h('button', { class: 'btn', onclick: vault }, 'Open vault…')),
        h('div', { class: 'filterbar' }, EXAMPLES.map((t) => h('button', { class: 'chip pick', onclick: () => { ta.value = t; ta.focus(); } }, t)))),
      out, history));
  loadStatus();
  return { destroy() { alive = false; } };
}
