import { h, mount } from '../ui/dom.js';
import { api } from '../app/api.js';
import { state, subscribe } from '../app/store.js';
import { adaptScanRow } from '../adapt/scanRow.js';
import { dirChip, scoreCell, coverageMeter, gateBadges, freshBadge, sparkline, emptyState, errorState, skeleton, aiShadowChip } from '../ui/parts.js';
import { navigate, buildHash } from '../app/router.js';
import { signed, num, usd, compact, times, pct, int, isNum, DASH, etStamp } from '../app/fmt.js';
import { toast } from '../ui/toast.js';

const kv = (k, v, note) => h('div', { title: note || null }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
const unavail = (t = 'unavailable') => h('span', { class: 'dim', title: t, aria: { label: t } }, DASH);

function featureLedger(sig) {
  const rows = (sig.features || []).map((f) => h('tr', {},
    h('td', {}, f.label || f.key),
    h('td', { class: f.avail ? '' : 'dim' }, f.avail ? (f.dir > 0 ? h('span', { class: 'bull' }, '▲ bull') : f.dir < 0 ? h('span', { class: 'bear' }, '▼ bear') : '●') : unavail('feature unavailable')),
    h('td', {}, f.avail && f.dir ? h('span', { class: 'diverge', aria: { label: `strength ${Math.round(f.strength * 100)}%` } }, h('i', { class: f.dir > 0 ? 'bull' : 'bear', vars: { '--pct': Math.min(1, f.strength) } })) : unavail()),
    h('td', { class: 'num' }, f.weight != null ? `${Math.round(f.weight * 100)}%` : DASH),
    h('td', { class: 'num' }, isNum(f.contribution) ? signed(f.contribution * 100, 1) : DASH),
    h('td', { class: 'muted' }, f.note || '')));
  return h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Feature', 'Signal', 'Strength', 'Weight', 'Contrib.', 'Note'].map((x) => h('th', {}, x)))), h('tbody', {}, rows));
}
function contextGrid(sig, ch) {
  const a = sig.agg || {}, w = sig.walls || {};
  return h('div', { class: 'kv' },
    kv('GEX', isNum(a.gex) ? signed(a.gex / 1e6, 1, 'M') : unavail('needs greeks + OI')), kv('Gamma flip', usd(a.gammaFlip)), kv('Call / put wall', `${usd(w.call, 0)} / ${usd(w.put, 0)}`),
    kv('ATM IV', isNum(a.atmIV) ? pct(a.atmIV, 0) : DASH), kv('IV rank', int(sig.ivRank)), kv('Max pain', usd(a.maxPain, 0)), kv('Call/put vol', isNum(a.cpVolRatio) ? num(a.cpVolRatio, 2) : unavail('put volume is zero')),
    kv('Vol / OI', num(a.volOIRatio, 2)), kv('ATM spread', isNum(a.atmSpread) ? pct(a.atmSpread, 1) : DASH), kv('ATM OI', compact(a.atmOI)), kv('Price vs VWAP', sig.priceGate && isNum(sig.priceGate.vwapDistAtr) ? `${signed(sig.priceGate.vwapDistAtr, 2)} ATR · ${sig.priceGate.state}` : unavail('VWAP/ATR unavailable')),
    kv('Underlying', usd(ch && ch.underlying && ch.underlying.price)));
}
function flowTable(trades) {
  if (!trades || !trades.length) return emptyState('No flow alerts', 'No signed flow alerts are cached for this ticker.');
  return h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Time (ET)', 'Right', 'Aggressor', 'Premium', 'Signed effect'].map((x) => h('th', {}, x)))),
    h('tbody', {}, trades.slice(0, 15).map((t) => { const known = isNum(t.askPremium) && isNum(t.bidPremium); const signedEff = known ? (t.right === 'call' ? 1 : -1) * (t.askPremium - t.bidPremium) : null;
      return h('tr', {}, h('td', { class: 'num' }, isNum(t.ts) ? etStamp(t.ts) : DASH), h('td', {}, t.right || DASH), h('td', {}, t.direction === 'ask' ? 'bought at ask' : t.direction === 'bid' ? 'sold at bid' : unavail('aggressor side unknown')),
        h('td', { class: 'num' }, compact(t.premium)), h('td', { class: 'num ' + (signedEff > 0 ? 'bull' : signedEff < 0 ? 'bear' : 'dim') }, isNum(signedEff) ? `${signedEff > 0 ? '▲' : '▼'} ${compact(signedEff, true)}` : DASH)); })));
}
function chainTable(contracts, spot) {
  if (!contracts || !contracts.length) return emptyState('No contracts', 'No option contracts are cached for this ticker.');
  const exps = [...new Set(contracts.map((c) => c.expiration).filter(Boolean))].sort();
  const host = h('div'); let cur = exps[0];
  const draw = () => {
    const rows = contracts.filter((c) => c.expiration === cur).sort((a, b) => a.strike - b.strike);
    const atm = rows.reduce((b, c) => (!b || Math.abs(c.strike - spot) < Math.abs(b.strike - spot) ? c : b), null);
    mount(host, h('div', { class: 'seg', role: 'group', aria: { label: 'Expiry' } }, exps.slice(0, 8).map((e) => h('button', { type: 'button', aria: { pressed: String(e === cur) }, onclick: () => { cur = e; draw(); } }, e))),
      h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Type', 'Strike', 'Vol', 'OI', 'IV', 'Delta', 'Bid', 'Ask'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((c) => h('tr', { class: c === atm ? 'atm' : '' }, h('td', { class: c.type === 'call' ? 'bull' : 'bear' }, c.type), h('td', { class: 'num' }, `${num(c.strike, 2)}${c === atm ? ' ◂ ATM' : ''}`), h('td', { class: 'num' }, compact(c.volume)), h('td', { class: 'num' }, compact(c.openInterest)), h('td', { class: 'num' }, isNum(c.iv) ? pct(c.iv, 0) : DASH), h('td', { class: 'num' }, num(c.delta, 2)), h('td', { class: 'num' }, num(c.bid, 2)), h('td', { class: 'num' }, num(c.ask, 2)))))));
  };
  draw(); return host;
}
function shadowBox(sig) {
  const v = sig && sig.v2;
  return h('details', { class: 'panel shadowbox' }, h('summary', {}, h('strong', {}, 'Shadow (research)'), aiShadowChip()),
    h('div', { class: 'body' }, !v || v.error || !isNum(v.score) ? h('p', { class: 'muted' }, 'v2 shadow unavailable for this ticker (needs signed flow).') : h('div', { class: 'stack' },
      h('div', { class: 'kv' }, kv('v2 state', v.state || DASH), kv('v2 score', String(v.score)), kv('v2 dir', v.dir || DASH), kv('Coverage', isNum(v.coverage) ? `${v.coverage}%` : DASH), kv('Version', v.version || DASH)),
      h('p', { class: 'dim' }, 'Observation only. This never changes the published score above.'))));
}
function aiBox(ticker) {
  const out = h('div'); const btn = h('button', { class: 'btn', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Asking…'; mount(out, h('p', { class: 'muted' }, 'Generating an explanation…'));
    try { const r = await fetch(`/api/ai/analyze/${encodeURIComponent(ticker)}`, { method: 'POST', credentials: 'include' }); const j = await r.json();
      if (!j.ok) { mount(out, errorState(j.error || 'AI unavailable')); }
      else { const ai = j.ai || {}; const pts = (a) => (a && a.points ? a.points : []); mount(out, h('div', { class: 'stack' }, ai.summary && ai.summary.text ? h('p', {}, ai.summary.text) : null,
        ['flow', 'positioning', 'technical', 'news'].map((k) => (ai.analysts && ai.analysts[k] && pts(ai.analysts[k]).length ? h('div', {}, h('h3', {}, k), h('ul', {}, pts(ai.analysts[k]).map((p) => h('li', {}, p)))) : null)),
        ai.riskReview && (ai.riskReview.risks || []).length ? h('div', {}, h('h3', {}, 'Risks'), h('ul', {}, ai.riskReview.risks.map((p) => h('li', {}, p)))) : null,
        h('p', { class: 'dim' }, 'Advisory explanation only. It does not change the score, direction or any stored data.'))); }
    } catch { mount(out, errorState('Cannot reach the server.')); }
    btn.disabled = false; btn.textContent = 'Explain this score';
  } }, 'Explain this score');
  return h('details', { class: 'panel' }, h('summary', {}, h('strong', {}, 'AI explanation'), h('span', { class: 'chip' }, 'advisory')), h('div', { class: 'body stack' }, btn, out));
}

export function renderTicker(root, { ticker, cal, openInput }) {
  if (!ticker) {
    const inp = h('input', { class: 'input', placeholder: 'Ticker, e.g. NVDA', dataset: { search: '1' }, aria: { label: 'Ticker' } });
    const go = () => { const t = inp.value.trim().toUpperCase(); if (t) navigate(buildHash('t', t)); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Ticker')), emptyState('Pick a ticker', 'Choose one from the scan, press / to search, or type a symbol. Opening a ticker reads the cached snapshot and spends no data-provider quota.', h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', onclick: go }, 'Open'))));
    return { destroy() {}, focusSearch: () => inp.focus() };
  }
  let alive = true, unsub = () => {};
  const body = h('div', { class: 'stack' });
  const head = h('div', { class: 'page-head' });
  mount(root, head, body);
  let payload = null;
  const scanRow = () => { const rows = state.signals && state.signals.rows; const r = rows && rows.find((x) => x.ticker === ticker); return r ? adaptScanRow(r) : null; };
  const refreshBtn = h('button', { class: 'btn', onclick: () => refreshLive() }, 'Refresh live');
  function paintHead() {
    const sc = state.scan.running; const lim = state.readiness && state.readiness.uw;
    const sat = lim && isNum(lim.perMinuteLimit) && lim.perMinuteUsed >= lim.perMinuteLimit * 0.95;
    refreshBtn.disabled = !!sat || (state.authInfo && state.authInfo.options && state.authInfo.options.configured === false);
    refreshBtn.title = sat ? 'Disabled: the rate limit is nearly saturated' : 'Recompute from Unusual Whales now. Costs roughly 8–12 requests of quota. Writes nothing to the journal.';
    mount(head, h('a', { href: '#/scan', class: 'btn ghost' }, '← Scan'), h('h1', {}, ticker), h('span', { class: 'grow' }), payload ? h('span', { class: 'muted' }, `${payload.source === 'live' ? 'Live read' : 'Cached'} · `) : null, payload ? freshBadge(payload.at, state.session.state) : null, refreshBtn);
  }
  async function refreshLive(auto) {
    refreshBtn.disabled = true; refreshBtn.textContent = 'Refreshing…';
    try { const r = await api(`/api/ticker/${encodeURIComponent(ticker)}/refresh`, { method: 'POST' });
      if (r.ok && r.data && r.data.ok) { payload = r.data; paint(); if (!auto) toast(`${ticker} recomputed live`); }
      else { const why = r.data && (r.data.error || r.data.reason || r.data.detail); mount(body, errorState(`Could not load ${ticker}: ${why || 'no options data returned'}. ${r.status === 429 ? 'The rate limit is saturated; try again shortly.' : 'Check the symbol, or try again.'}`, () => { autoTried = false; refreshLive(); })); if (!auto) toast(`Refresh failed: ${why || 'error'}`, 'err'); }
    } catch { toast('Refresh failed: cannot reach the server', 'err'); }
    refreshBtn.textContent = 'Refresh live'; paintHead();
  }
  function paint() {
    paintHead();
    const row = scanRow(), sig = payload && payload.signal, ch = payload && payload.chain;
    if (!payload && !row) return mount(body, emptyState(`Loading ${ticker}…`, 'Fetching it live from Unusual Whales (nothing is written to the journal).'));
    const v = row || (sig ? adaptScanRow({ ticker, productionScore: sig.finalScore, dir: sig.dir, tier: sig.tier, gated: sig.gated, rawScore: sig.rawScore, gateReasons: sig.gateReasons, coverage: sig.coverage, dataQuality: sig.dataQuality }) : null);
    const sc = sig ? { score: sig.finalScore, dir: sig.dir, gated: sig.gated, rawScore: sig.rawScore, tier: sig.tier, gates: sig.gateReasons || [], coverage: sig.coverage } : v;
    const spot = ch && ch.underlying && ch.underlying.price != null ? ch.underlying.price : (v && v.price);
    mount(body,
      h('section', { class: 'panel hero', aria: { label: `${ticker} summary` } },
        h('div', {}, h('div', { class: 'tk' }, ticker), h('div', { class: 'muted' }, v && v.sector ? v.sector : '')),
        h('div', {}, h('div', { class: 'num', style: null }, usd(spot)), v ? h('div', { class: 'num ' + (v.changePct > 0 ? 'bull' : v.changePct < 0 ? 'bear' : 'dim') }, signed(v.changePct, 2, '%')) : null),
        payload && payload.spark ? sparkline(payload.spark, 120, 28) : null,
        h('div', { class: 'scoreblock ' + (sc.dir === 'bull' ? 'bull' : sc.dir === 'bear' ? 'bear' : '') }, h('div', { class: 'big' }, scoreCell({ ...sc, score: sc.score })), h('div', {}, dirChip(sc.dir, null), ' ', h('span', { class: 'muted' }, sc.tier || '')), h('div', {}, coverageMeter(sc.coverage), ' ', gateBadges(sc.gates, true)),
          h('div', { class: 'dim' }, `engine ${(sig && sig.optionsEngineVersion) || (v && v.engineVersion) || DASH}`))),
      sig ? h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Why this score')), h('div', { class: 'body' }, featureLedger(sig), sig.gateReasons && sig.gateReasons.length ? h('p', { class: 'gated' }, `Gates and caps applied: ${sig.gateReasons.join(', ')}`) : null)) : h('div', { class: 'banner' }, 'Feature detail is not cached for this ticker. Refresh live to load it.'),
      sig ? h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Context'), h('span', { class: 'dim' }, 'shown for reference; not in the score')), h('div', { class: 'body' }, contextGrid(sig, ch))) : null,
      ch ? h('div', { class: 'grid2' }, h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Flow alerts')), h('div', { class: 'body' }, flowTable(ch.flow))), h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Option chain'), h('span', { class: 'dim' }, 'top by volume')), h('div', { class: 'body' }, chainTable(ch.contracts, spot)))) : null,
      state.authInfo && state.authInfo.ai && state.authInfo.ai.enabled ? aiBox(ticker) : null,
      sig ? shadowBox(sig) : null);
  }
  mount(body, skeleton());
  // A ticker the user explicitly searched for loads live when it is neither in the scan nor cached (read-only, nothing journaled).
  // While a scan runs (or the limiter is saturated) it waits and loads when that clears.
  let autoTried = false;
  const maybeAuto = async () => {
    if (!alive || autoTried || payload) return;          // no cached detail (even if the ticker is in the scan): load it live, read-only
    if (state.authInfo && state.authInfo.options && state.authInfo.options.configured === false) { mount(body, emptyState('No data provider configured', 'Set OPTIONS_PROVIDER=uw and UNUSUAL_WHALES_API_TOKEN in .env, then restart.')); autoTried = true; return; }
    autoTried = true; await refreshLive(true);
  };
  unsub = subscribe((w) => { if (w === 'scan' || w === 'signals') { if (!payload) { maybeAuto(); } } });
  (async () => { try { const r = await api(`/api/ticker/${encodeURIComponent(ticker)}`); if (!alive) return; if (r.data && r.data.ok) payload = r.data; paint(); maybeAuto(); } catch { if (alive) mount(body, errorState('Cannot reach the server.', () => location.reload())); } })();
  return { destroy() { alive = false; unsub(); }, focusSearch() { navigate('#/t'); }, repaint: paintHead };
}
