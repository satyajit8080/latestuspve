import { h } from './dom.js';
import { DASH, isNum, dirGlyph, dirWord, ago, etStamp } from '../app/fmt.js';
import { freshness } from '../app/freshness.js';
export const dirChip = (dir, signal) => h('span', { class: `chip ${dir === 'bull' ? 'bull' : dir === 'bear' ? 'bear' : 'neutral'}` }, `${dirGlyph(dir)} ${dirWord(dir, signal)}`);
export function scoreCell(r) {
  if (!isNum(r.score)) return h('span', { class: 'dim', title: 'Score unavailable', aria: { label: 'score unavailable' } }, DASH);
  const cls = r.dir === 'bull' ? 'bull' : r.dir === 'bear' ? 'bear' : '';
  return h('span', { class: 'scorecell' + (r.gated ? ' is-gated' : ''), title: r.gated && isNum(r.rawScore) ? `Gated. Un-gated score was ${r.rawScore}` : r.tier || null },
    r.gated ? h('span', { class: 'chip gate' }, 'GATED') : null,
    h('span', { class: `v num ${cls}` }, String(r.score)),
    h('span', { class: `scorebar ${cls}`, vars: { '--pct': Math.min(1, r.score / 100) }, aria: { hidden: 'true' } }, h('i')));
}
export function coverageMeter(c) {
  if (!isNum(c)) return h('span', { class: 'dim', title: 'Coverage unavailable' }, DASH);
  const on = Math.round(Math.max(0, Math.min(1, c)) * 5);
  return h('span', { title: `Data coverage ${Math.round(c * 100)}%` }, h('span', { class: 'pips', aria: { hidden: 'true' } }, [0, 1, 2, 3, 4].map((i) => h('i', { class: i < on ? 'on' : '' }))), h('span', { class: 'num dim' }, `${Math.round(c * 100)}%`));
}
const GATE_TEXT = { EARNINGS: 'Earnings within 2 days: published score forced to 0', OUTSIDE_RTH: 'Outside regular trading hours: capped at 60', WIDE_ATM_SPREAD: 'ATM bid/ask spread too wide: capped at 60', LOW_ATM_OI: 'ATM open interest too thin: capped at 60', ILLIQUID: 'Illiquid: capped at 60', PRICE_CONFLICT: 'Price conflicts with direction (×0.75), not actionable', INSUFFICIENT_DIRECTIONAL_EVIDENCE: 'Fewer than 2 of 3 directional features: capped at 60' };
const GATE_SHORT = { EARNINGS: 'ER', OUTSIDE_RTH: 'ETH', WIDE_ATM_SPREAD: 'SPRD', LOW_ATM_OI: 'OI', ILLIQUID: 'LIQ', PRICE_CONFLICT: 'PX', INSUFFICIENT_DIRECTIONAL_EVIDENCE: 'EVID' };
export const gateBadges = (gates, full = false) => (!gates || !gates.length ? h('span', { class: 'dim' }, DASH) : h('span', { class: 'gates' }, gates.map((g) => h('span', { class: 'chip gate', title: GATE_TEXT[g] || g, aria: { label: GATE_TEXT[g] || g } }, full ? g.replace(/_/g, ' ') : (GATE_SHORT[g] || g)))));
export function freshBadge(ts, sessionState, now = Date.now()) {
  if (!isNum(ts)) return h('span', { class: 'fresh dim', title: 'No timestamp' }, DASH);
  const f = freshness(now - ts, sessionState);
  return h('span', { class: 'fresh', title: `${etStamp(ts)} · ${f.label}` }, h('span', { class: `dot ${f.level}`, aria: { hidden: 'true' } }), h('span', {}, ago(ts, now)), h('span', { class: 'sr-only' }, ` ${f.label}`));
}
export function quotaMeter(used, limit) {
  if (!isNum(used) || !isNum(limit) || limit <= 0) return h('span', { class: 'quota dim', title: 'UW rate-limit window unknown' }, 'UW —');
  const p = Math.max(0, Math.min(1, used / limit));
  return h('span', { class: 'quota', dataset: { level: p >= 0.95 ? 'crit' : p >= 0.8 ? 'warn' : 'ok' }, title: `${used} of ${limit} requests this minute` }, h('span', { class: 'track', aria: { hidden: 'true' } }, h('i', { class: 'fill', vars: { '--pct': p } })), h('span', { class: 'num' }, `${used}/${limit}`));
}
export function sparkline(points, w = 80, hh = 20) {
  const p = (points || []).filter(isNum); if (p.length < 3) return null;
  const lo = Math.min(...p), hi = Math.max(...p), span = hi - lo || 1;
  const pts = p.map((v, i) => `${((i / (p.length - 1)) * w).toFixed(1)},${(hh - 2 - ((v - lo) / span) * (hh - 4)).toFixed(1)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('class', 'spark'); svg.setAttribute('width', w); svg.setAttribute('height', hh); svg.setAttribute('viewBox', `0 0 ${w} ${hh}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Last ${p.length} daily closes`);
  const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', pts); svg.append(pl); return svg;
}
export const emptyState = (title, text, action) => h('div', { class: 'empty' }, h('h3', {}, title), h('p', { class: 'muted' }, text), action || null);
export const errorState = (text, retry) => h('div', { class: 'banner err', role: 'alert' }, h('span', {}, text), retry ? h('button', { class: 'btn', onclick: retry }, 'Retry') : null);
export const skeleton = (n = 6) => h('div', { class: 'stack', aria: { busy: 'true', label: 'Loading' } }, Array.from({ length: n }, () => h('div', { class: 'skel' })));
export const aiShadowChip = () => h('span', { class: 'chip shadow' }, 'SHADOW · RESEARCH · not used in production');
