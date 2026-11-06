// Synthetic 2-year-style dataset with a planted next-day signal in alertSingle (alertOpen is pure noise).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradingDays } from '../../research/backfill.js';
export function labSynth({ noiseOnly = false, tickers = 60 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labsvc-')); const dir = path.join(root, 'backfill'); const labDir = path.join(root, 'lab');
  let seed = 4242; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };
  const sig = tradingDays('2026-01-05', '2026-08-14').reverse(); const all = tradingDays('2026-01-05', '2026-09-01').reverse(); const names = Array.from({ length: tickers }, (_, i) => `S${String(i).padStart(2, '0')}`);
  const lines = ['ticker,date,alertSingle,alertRaw,alertOpen,grossAbs,nAlerts'];
  for (const t of names) {
    const X = all.map(() => gauss()); let px = 100; const closes = []; for (let i = 0; i < all.length; i++) { closes.push(px); px *= 1 + (noiseOnly ? 0 : 0.01 * X[i]) + 0.004 * gauss(); }
    fs.mkdirSync(path.join(dir, 'ohlc1d', t), { recursive: true }); fs.writeFileSync(path.join(dir, 'ohlc1d', t, 'series.json'), JSON.stringify({ meta: {}, data: { data: all.map((d, i) => ({ date: d, close: String(closes[i]) })) } }));
    sig.forEach((d, i) => lines.push(`${t},${d},${X[i] * 1e5},${X[i] * 1e5 + gauss() * 1e4},${gauss() * 1e5},${Math.abs(X[i]) * 1e5},${2 + Math.floor(rnd() * 5)}`));
  }
  fs.mkdirSync(labDir, { recursive: true }); fs.writeFileSync(path.join(labDir, 'features.csv'), lines.join('\n') + '\n'); return { dir, labDir };
}
