// Formatting helpers only. null/undefined/NaN always render as the dash, never as 0.
export const DASH = '—';
const MINUS = '−';
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const num = (v, d = 2) => (isNum(v) ? v.toFixed(d) : DASH);
export const signed = (v, d = 2, suffix = '') => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(d)}${suffix}` : DASH);
export const pct = (v, d = 0) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : DASH);
export const usd = (v, d = 2) => (isNum(v) ? `$${v.toFixed(d)}` : DASH);
export const int = (v) => (isNum(v) ? String(Math.round(v)) : DASH);
export function compact(v, signedOut = false) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : String(Math.round(a));
  return signedOut ? `${v > 0 ? '+' : v < 0 ? MINUS : ''}${s}` : `${v < 0 ? MINUS : ''}${s}`;
}
export const times = (v, d = 1) => (isNum(v) ? `${v.toFixed(d)}×` : DASH);
const etFmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', ...opts });
export const etClock = (ms) => (isNum(ms) ? etFmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms)) : DASH);
export const etStamp = (ms) => (isNum(ms) ? `${etFmt({ month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))} ET` : DASH);
export function ago(ms, now = Date.now()) {
  if (!isNum(ms)) return DASH;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d`;
}
export function countdown(ms) {
  if (!isNum(ms) || ms < 0) return DASH;
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export const dirGlyph = (dir) => (dir === 'bull' ? '▲' : dir === 'bear' ? '▼' : '●');
export const dirWord = (dir, signal) => (signal === 'CALL' || signal === 'PUT' ? signal : dir === 'bull' ? 'CALL' : dir === 'bear' ? 'PUT' : 'WATCH');
