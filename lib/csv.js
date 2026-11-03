// Minimal CSV writer. Quotes fields containing commas/quotes/newlines and neutralises spreadsheet formula injection
// (a text cell starting with = + - @ gets a leading apostrophe). Numbers are written as-is; null/undefined are empty cells.
const needsQuote = /[",\r\n]/;
export function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = Array.isArray(v) ? v.join('|') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows, columns) {
  const head = columns.map((c) => c.header).join(',');
  const body = (rows || []).map((r) => columns.map((c) => cell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}
