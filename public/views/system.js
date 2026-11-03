import { h, mount } from '../ui/dom.js';
import { state, subscribe, setPref } from '../app/store.js';
import { quotaMeter, freshBadge } from '../ui/parts.js';
import { ago, isNum, DASH, etStamp, countdown } from '../app/fmt.js';
import { marketSession } from '../app/session.js';
import { api } from '../app/api.js';

export function renderSystem(root, { cal, runScan }) {
  const host = h('div', { class: 'stack' }); let alive = true;
  const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const panel = (t, ...c) => h('section', { class: 'panel' }, h('header', {}, h('h2', {}, t)), h('div', { class: 'body stack' }, ...c));
  function draw() {
    const m = state.monitor || {}, a = state.authInfo || {}, o = a.options || {}, rd = state.readiness || {}, uw = rd.uw || {}, feats = (rd.readiness && rd.readiness.features) || {}, ms = marketSession(Date.now(), cal);
    const hist = state.quotaHistory.slice(-40), mx = Math.max(1, ...hist.map((x) => x.used));
    const used = isNum(uw.perMinuteUsed) ? uw.perMinuteUsed : null, limit = isNum(uw.perMinuteLimit) ? uw.perMinuteLimit : uw.uwMinuteLimit;
    mount(host,
      panel('Connection', h('div', { class: 'kv' }, kv('Server', state.conn.failures ? `${state.conn.failures} failed polls` : 'reachable'), kv('Last success', state.conn.lastOk ? `${ago(state.conn.lastOk)} ago` : DASH), kv('Session', state.authed === false ? 'expired' : 'signed in'), kv('Market', `${ms.label}`), kv('Data provider', o.provider ? `${o.provider}${o.configured ? '' : ' (not configured)'}` : DASH), kv('Token', o.configured ? (o.keyMasked || 'set') : 'not set'))),
      panel('Unusual Whales limiter', h('div', { class: 'kv' }, kv('This minute', quotaMeter(used, limit)), kv('Requests this scan', isNum(uw.requestsThisScan) ? String(uw.requestsThisScan) : DASH), kv('Total requests', isNum(uw.requestsTotal) ? String(uw.requestsTotal) : DASH), kv('UW remaining (minute)', isNum(uw.uwMinuteRemaining) ? String(uw.uwMinuteRemaining) : DASH), kv('Failures logged', isNum(uw.failures) ? String(uw.failures) : DASH), kv('Quota exhausted', uw.hardQuotaGone ? 'yes' : 'no')),
        hist.length > 1 ? h('div', {}, h('div', { class: 'caps' }, 'Requests per minute (this session, polled)'), h('div', { class: 'histo', role: 'img', aria: { label: 'Requests per minute history' } }, hist.map((x) => h('i', { vars: { '--pct': x.used / mx }, title: `${x.used} at ${etStamp(x.t)}` })))) : h('p', { class: 'dim' }, 'Usage history builds up while this page is open.')),
      panel('Jobs', h('div', { class: 'kv' },
        kv('Scan', state.scan.running ? `running ${isNum(state.scan.done) ? state.scan.done + '/' + state.scan.total : '…'}` : (state.scan.lastOk === false ? `failed: ${state.scan.message || ''}` : state.scan.lastOk ? 'idle · last ok' : 'idle')), kv('Last scan finished', state.scan.finishedAt ? etStamp(Date.parse(state.scan.finishedAt)) : DASH),
        kv('Resolve outcomes', state.resolve.running ? 'running' : (state.resolve.lastOk === false ? `failed: ${state.resolve.message || ''}` : state.resolve.lastOk ? 'idle · last ok' : 'idle'))),
        h('button', { class: 'btn primary', disabled: !!state.scan.running, onclick: runScan }, 'Run scan')),
      panel('Readiness', h('div', { class: 'kv' }, ['rvol', 'ivSkew', 'sector', 'macro'].map((k) => kv({ rvol: 'RVOL baseline', ivSkew: 'IV-skew change', sector: 'Sector strength', macro: 'Macro calendar' }[k], feats[k] ? h('span', { class: feats[k] === 'READY' ? 'bull' : feats[k] === 'WARMING_UP' ? 'gated' : 'dim' }, feats[k].replace('_', ' ')) : DASH))), h('p', { class: 'dim' }, 'UNAVAILABLE and WARMING UP mean the feature is withheld, never guessed.')),
      panel('Versions', h('div', { class: 'kv' }, kv('Production engine', m.optionsEngineVersion || (a.versions && a.versions.optionsEngine) || DASH), kv('Shadow (v2)', m.v2Version || (a.versions && a.versions.v2) || DASH), kv('Published score from', m.primary || a.primary || 'opt'), kv('AI', a.ai && a.ai.enabled ? 'on' : 'off'))),
      panel('Environment', h('p', { class: 'muted' }, 'Secrets are never shown. Set them in .env on the server.'), h('div', { class: 'kv' }, kv('UNUSUAL_WHALES_API_TOKEN', o.configured ? `set · ${o.keyMasked || ''}` : 'not set'), kv('OPTIONS_PROVIDER', o.provider || 'not set'), kv('AI_ENABLED', a.ai && a.ai.enabled ? 'true' : 'false'))),
      panel('Display', h('div', { class: 'filterbar' }, h('label', { class: 'muted', for: 'pref-density' }, 'Row density'), h('select', { class: 'select', id: 'pref-density', onchange: (e) => setPref('density', e.target.value) }, [['compact', 'Compact (28 px)'], ['comfortable', 'Comfortable (32 px)'], ['touch', 'Touch (40 px)']].map(([v, l]) => h('option', { value: v, selected: state.prefs.density === v }, l))), h('span', { class: 'dim' }, 'Market times are shown in US Eastern (ET).'))),
      panel('Diagnostics', h('p', { class: 'muted' }, 'Reads cached state only. No Unusual Whales calls.'), h('pre', { class: 'dim num', style: null }, JSON.stringify({ monitor: state.monitor, auth: { options: o, ai: a.ai } }, null, 2))));
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'System')), host); draw();
  const unsub = subscribe((w) => { if (['readiness', 'scan', 'resolve', 'conn', 'auth', 'monitor', 'tick'].includes(w)) draw(); });
  (async () => { try { const r = await api('/api/_monitor'); if (alive && r.data) { state.monitor = r.data; draw(); } } catch { /* shown via connection panel */ } })();
  return { destroy() { alive = false; unsub(); } };
}
