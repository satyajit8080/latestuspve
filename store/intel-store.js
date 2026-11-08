// store/intel-store.js — files for Options Intelligence: latest.json (atomic), deep/<TICKER>.json, snapshots/<ET date>/<HHMM>.json.gz.
// Snapshots are append-only point-in-time records (with retrieval timestamps) that later backtests can use.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { etDate, etMinutes } from '../lib/time.js';
const safe = (t) => String(t).toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
export const intelDir = (env = process.env) => env.INTEL_DIR || path.join(process.cwd(), 'research-data', 'intel');
function atomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
export function writeLatest(dir, obj) { atomic(path.join(dir, 'latest.json'), JSON.stringify(obj) + '\n'); }
export function readLatest(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')); } catch { return null; } }
export function writeDeep(dir, ticker, detail) { atomic(path.join(dir, 'deep', `${safe(ticker)}.json`), JSON.stringify(detail)); }
export function readDeep(dir, ticker) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'deep', `${safe(ticker)}.json`), 'utf8')); } catch { return null; } }
export function writeSnapshot(dir, obj, nowMs = Date.now()) {
  const m = etMinutes(nowMs); const name = `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}.json.gz`; const file = path.join(dir, 'snapshots', etDate(nowMs), name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ ...obj, snapshotAt: new Date(nowMs).toISOString() }))); return file;
}
export function listSnapshots(dir) {
  const root = path.join(dir, 'snapshots'); const out = [];
  try { for (const d of fs.readdirSync(root).sort()) for (const f of fs.readdirSync(path.join(root, d)).sort()) if (f.endsWith('.json.gz')) out.push({ date: d, time: f.slice(0, 4), file: path.join(root, d, f) }); } catch { /* none yet */ }
  return out;
}
export function readSnapshot(file) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch { return null; } }
export function writeFlow(dir, obj) { atomic(path.join(dir, 'flow.json'), JSON.stringify(obj)); }
export function readFlow(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8')); } catch { return null; } }
