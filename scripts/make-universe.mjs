#!/usr/bin/env node
// Builds research-data/tickers.txt with N random US-listed symbols from the public Nasdaq Trader symbol directories
// (nasdaqlisted.txt + otherlisted.txt). Run ON THE SERVER:  node scripts/make-universe.mjs 2000
// Options: --no-etf  (drop ETFs)   --seed=NAME  (not used: the shuffle is cryptographically random each run)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const URLS = ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'];

// Parses one pipe-delimited directory file. Excludes test issues, the footer line, and symbols that are not plain 1-5 letters
// (warrants, units, preferreds and share-class suffixes rarely have listed options).
export function parseDirectory(text, { etf = true } = {}) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('|'); const idx = (n) => head.indexOf(n);
  const sym = idx('Symbol') >= 0 ? idx('Symbol') : idx('ACT Symbol');
  const test = idx('Test Issue'), isEtf = idx('ETF'), nameI = idx('Security Name');
  const out = [];
  for (const l of lines.slice(1)) {
    if (/^File Creation Time/i.test(l)) continue;
    const c = l.split('|'); const s = (c[sym] || '').trim();
    if (!/^[A-Z]{1,5}$/.test(s)) continue;
    if (test >= 0 && c[test] === 'Y') continue;
    if (nameI >= 0 && /warrant|\brights?\b|\bunits?\b|preferred|depositary|notes? due|\bnotes\b/i.test(c[nameI] || '')) continue;
    if (!etf && isEtf >= 0 && c[isEtf] === 'Y') continue;
    out.push(s);
  }
  return out;
}
export function sample(list, n, rnd = (m) => crypto.randomInt(m)) {
  const a = [...new Set(list)];
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv.find((a) => /^\d+$/.test(a)) || 2000);
  const etf = !process.argv.includes('--no-etf');
  const all = [];
  for (const u of URLS) { const r = await fetch(u); if (!r.ok) { console.error(`download failed: ${u} (HTTP ${r.status})`); process.exit(1); } all.push(...parseDirectory(await r.text(), { etf })); }
  const picked = sample(all, n);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'research-data'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tickers.txt'), picked.join('\n') + '\n');
  console.log(`wrote ${picked.length} random tickers (from ${all.length} listed) -> research-data/tickers.txt`);
}
