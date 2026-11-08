// engine/intel/session.js — US session label for data-mode labelling (LIVE / DELAYED / CLOSED / HISTORICAL).
import fs from 'node:fs';
import { etDate, etMinutes, RTH_OPEN_MIN, RTH_CLOSE_MIN } from '../../lib/time.js';
let cal = null;
function calendar() { if (cal) return cal; try { cal = JSON.parse(fs.readFileSync(new URL('../../public/data/nyse-calendar.json', import.meta.url), 'utf8')); } catch { cal = { holidays: [], halfDays: [] }; } return cal; }
export function sessionOf(ms = Date.now(), c = calendar()) {
  const d = etDate(ms), m = etMinutes(ms); const dow = new Date(`${d}T12:00:00Z`).getUTCDay(); const closed = dow === 0 || dow === 6 || (c.holidays || []).includes(d);
  const close = (c.halfDays || []).includes(d) ? 780 : RTH_CLOSE_MIN;
  if (closed) return 'closed'; if (m >= RTH_OPEN_MIN && m < close) return 'open'; if (m >= 240 && m < RTH_OPEN_MIN) return 'pre'; if (m >= close && m < 1200) return 'post'; return 'closed';
}
// mode of a dataset: LIVE = session open and data newer than 20 min; DELAYED = session open but older; CLOSED = market closed (last session shown); HISTORICAL = a stored snapshot
export function dataMode({ nowMs, asOfMs, historical = false }) {
  if (historical) return 'HISTORICAL'; const s = sessionOf(nowMs); if (s !== 'open') return 'CLOSED';
  return Number.isFinite(asOfMs) && nowMs - asOfMs <= 20 * 60000 ? 'LIVE' : 'DELAYED';
}
