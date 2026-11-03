// US equity market session in America/New_York (pure; the calendar is injected so it is testable).
const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function etParts(ms) {
  const o = {}; for (const p of dtf.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute), seconds: Number(o.second), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
const PRE_OPEN = 240, OPEN = 570, CLOSE = 960, HALF_CLOSE = 780, POST_END = 1200, HALF_POST_END = 1020;
// Returns { state: PRE|RTH|POST|CLOSED|HOLIDAY|HALF, rth: boolean, label, nextChangeMs }
export function marketSession(ms, cal = { holidays: [], halfDays: [] }) {
  const p = etParts(ms);
  const weekend = p.dow === 0 || p.dow === 6;
  const holiday = (cal.holidays || []).includes(p.date);
  const half = (cal.halfDays || []).includes(p.date);
  if (weekend || holiday) return { state: holiday && !weekend ? 'HOLIDAY' : 'CLOSED', rth: false, label: holiday && !weekend ? 'HOLIDAY' : 'CLOSED', nextChangeMs: null };
  const close = half ? HALF_CLOSE : CLOSE, postEnd = half ? HALF_POST_END : POST_END;
  const secsNow = p.minutes * 60 + p.seconds, until = (min) => (min * 60 - secsNow) * 1000;
  if (p.minutes >= OPEN && p.minutes < close) return { state: half ? 'HALF' : 'RTH', rth: true, label: half ? 'RTH · HALF DAY' : 'RTH', nextChangeMs: until(close), nextLabel: 'closes' };
  if (p.minutes >= PRE_OPEN && p.minutes < OPEN) return { state: 'PRE', rth: false, label: 'PRE-MARKET', nextChangeMs: until(OPEN), nextLabel: 'opens' };
  if (p.minutes >= close && p.minutes < postEnd) return { state: 'POST', rth: false, label: 'AFTER-HOURS', nextChangeMs: until(postEnd), nextLabel: 'ends' };
  return { state: 'CLOSED', rth: false, label: 'CLOSED', nextChangeMs: null };
}
export const isLiveSession = (s) => s && (s.state === 'RTH' || s.state === 'HALF');
