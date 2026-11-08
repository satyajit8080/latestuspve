// Dependency-free SVG charts. Colours come from CSS classes (c-bull, c-bear, c-info, c-gate, c-dim) — no colour literals here.
const NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fin = Number.isFinite;
const scale = (lo, hi, a, b) => (v) => (hi === lo ? (a + b) / 2 : a + ((v - lo) / (hi - lo)) * (b - a));
function ticks(lo, hi, n = 4) { if (!fin(lo) || !fin(hi)) return []; if (lo === hi) return [lo]; return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n); }
const pad = { l: 46, r: 10, t: 8, b: 20 };
// series: [{ label, cls, points: [[x, y], ...] }]; hlines: [{ y, label, cls }]; x may be a number or an ISO date string index (use xLabels)
export function lineChart({ series, hlines = [], w = 640, h = 200, yFmt = (v) => String(Math.round(v * 100) / 100), xFmt = (v) => String(v), xLabels = null, label = 'chart' }) {
  const all = series.flatMap((q) => q.points).filter((p) => fin(p[0]) && fin(p[1])); if (!all.length) return s('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': `${label}: no data` }, s('text', { x: 10, y: 20 }, 'No data'));
  const ys = [...all.map((p) => p[1]), ...hlines.map((l) => l.y).filter(fin)]; let lo = Math.min(...ys), hi = Math.max(...ys); const m = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1; lo -= m; hi += m;
  const xs = all.map((p) => p[0]); const xlo = Math.min(...xs), xhi = Math.max(...xs); const X = scale(xlo, xhi, pad.l, w - pad.r), Y = scale(lo, hi, h - pad.b, pad.t);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' });
  for (const t of ticks(lo, hi)) svg.append(s('line', { class: 'grid', x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t) }), s('text', { class: 'ax', x: pad.l - 4, y: Y(t) + 3, 'text-anchor': 'end' }, yFmt(t)));
  const xt = xLabels ? [0, Math.floor(xLabels.length / 2), xLabels.length - 1].filter((i, k, a) => a.indexOf(i) === k && xLabels[i] != null) : ticks(xlo, xhi, 3).map((v) => v);
  for (const t of xt) { const xv = xLabels ? t : t; svg.append(s('text', { class: 'ax', x: X(xv), y: h - 5, 'text-anchor': 'middle' }, xLabels ? xLabels[t] : xFmt(t))); }
  for (const l of hlines) if (fin(l.y)) svg.append(s('line', { class: `hl ${l.cls || 'c-dim'}`, x1: pad.l, x2: w - pad.r, y1: Y(l.y), y2: Y(l.y) }), s('text', { class: `ax ${l.cls || 'c-dim'}`, x: w - pad.r - 2, y: Y(l.y) - 3, 'text-anchor': 'end' }, l.label));
  for (const q of series) { const pts = q.points.filter((p) => fin(p[0]) && fin(p[1])); if (pts.length) svg.append(s('polyline', { class: `ln ${q.cls || 'c-info'}`, points: pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ') })); }
  return svg;
}
// bars: [{ label, value, cls }]; negative values go below the zero line
export function barChart({ bars, w = 640, h = 180, yFmt = (v) => String(Math.round(v)), label = 'chart' }) {
  const vals = bars.map((b) => b.value).filter(fin); if (!vals.length) return s('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': `${label}: no data` }, s('text', { x: 10, y: 20 }, 'No data'));
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals); const Y = scale(lo, hi, h - pad.b, pad.t); const bw = Math.max(2, (w - pad.l - pad.r) / bars.length - 2);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' });
  for (const t of ticks(lo, hi)) svg.append(s('line', { class: 'grid', x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t) }), s('text', { class: 'ax', x: pad.l - 4, y: Y(t) + 3, 'text-anchor': 'end' }, yFmt(t)));
  bars.forEach((b, i) => { if (!fin(b.value)) return; const x = pad.l + i * ((w - pad.l - pad.r) / bars.length) + 1, y0 = Y(0), y1 = Y(b.value); svg.append(s('rect', { class: `bar ${b.cls || 'c-info'}`, x, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)) }, s('title', {}, `${b.label}: ${yFmt(b.value)}`))); });
  const step = Math.ceil(bars.length / 6); bars.forEach((b, i) => { if (i % step === 0) svg.append(s('text', { class: 'ax', x: pad.l + i * ((w - pad.l - pad.r) / bars.length) + bw / 2, y: h - 5, 'text-anchor': 'middle' }, b.label)); });
  svg.append(s('line', { class: 'zero', x1: pad.l, x2: w - pad.r, y1: Y(0), y2: Y(0) })); return svg;
}
