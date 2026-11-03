// US-Eastern time helpers. All "session" / "trading day" logic must use these, never UTC slices.
const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function parts(ms) {
  const o = {}; for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}
export const etDate = (ms) => (Number.isFinite(ms) ? parts(ms).date : null);          // 'YYYY-MM-DD' in ET
export const etMinutes = (ms) => (Number.isFinite(ms) ? parts(ms).minutes : null);    // minutes since ET midnight
export const RTH_OPEN_MIN = 570, RTH_CLOSE_MIN = 960;                                 // 09:30 .. 16:00 ET
export const isRth = (ms) => { const m = etMinutes(ms); return m != null && m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN; };

// Whole calendar days from `fromMs` (ET date) to a 'YYYY-MM-DD' date string. Negative = in the past.
// Both sides are reduced to calendar dates first, so no UTC-midnight off-by-one.
export function etCalendarDaysUntil(dateStr, fromMs = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || '')); const today = etDate(fromMs);
  if (!m || !today) return null;
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(+t[1], +t[2] - 1, +t[3])) / 86400000);
}
