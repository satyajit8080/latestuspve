#!/usr/bin/env node
// scripts/make-sp500.mjs — builds the S&P 500 ticker list for the backfill (and a ticker→sector map).
//   node scripts/make-sp500.mjs            download the current constituents (community dataset on GitHub)
//   node scripts/make-sp500.mjs --offline  use the committed snapshot research/data/sp500-snapshot-2026-11-05.csv
// Writes research-data/sp500.txt (one ticker per line) and research-data/sp500-sectors.csv.
// CAVEAT: this is TODAY's membership. A backtest on it over-represents stocks that survived/rose into the index.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, '..', 'research', 'data', 'sp500-snapshot-2026-11-05.csv');

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
// Accepts the GitHub dataset (Symbol, Security, GICS Sector, …) or the committed snapshot (Symbol, Security, Sector, …).
export function parseSp500(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean); if (lines.length < 2) return [];
  const head = splitCsvLine(lines[0]).map((h) => h.trim()); const ix = (...n) => head.findIndex((h) => n.includes(h));
  const iS = ix('Symbol'), iN = ix('Security'), iC = ix('GICS Sector', 'Sector'); if (iS < 0) return [];
  const seen = new Set(); const out = [];
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l); const sym = String(c[iS] || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym) || seen.has(sym)) continue;
    seen.add(sym); out.push({ symbol: sym, name: c[iN] || '', sector: c[iC] || '' });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text; let source;
  if (process.argv.includes('--offline')) { text = fs.readFileSync(SNAPSHOT, 'utf8'); source = 'committed snapshot (2026-11-05)'; }
  else {
    try { const r = await fetch(URL_CSV); if (!r.ok) throw new Error(`HTTP ${r.status}`); text = await r.text(); source = 'GitHub dataset (live)'; }
    catch (e) { console.error(`download failed (${e.message}); falling back to the committed snapshot`); text = fs.readFileSync(SNAPSHOT, 'utf8'); source = 'committed snapshot (2026-11-05)'; }
  }
  const rows = parseSp500(text);
  if (rows.length < 450 || rows.length > 520) { console.error(`unexpected constituent count ${rows.length} — refusing to write`); process.exit(1); }
  const dir = path.join(HERE, '..', 'research-data'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sp500.txt'), rows.map((r) => r.symbol).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'sp500-sectors.csv'), 'ticker,sector\n' + rows.map((r) => `${r.symbol},"${r.sector}"`).join('\n') + '\n');
  console.log(`wrote ${rows.length} S&P 500 tickers from ${source} → research-data/sp500.txt (+ sp500-sectors.csv)`);
  const dots = rows.filter((r) => /[.\-]/.test(r.symbol)).map((r) => r.symbol);
  if (dots.length) console.log(`note: class-share tickers (${dots.join(', ')}) — run the probe on one to confirm UW's spelling`);
}
