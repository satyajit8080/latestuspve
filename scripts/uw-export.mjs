#!/usr/bin/env node
// scripts/uw-export.mjs — build a small shareable package (features + prices + dictionary + prompt), WITHOUT the sealed vault days.
//   node scripts/uw-export.mjs                 -> research-data/export/ (features.csv, prices.csv, DATA_DICTIONARY.md, PROMPT_FOR_AI.md, SHA256SUMS.txt)
//   node scripts/uw-export.mjs --include-vault include the vault days too (only if you are finished testing)
import fs from 'node:fs';
import path from 'node:path';
import { exportDataset } from '../research/export.js';
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => [a.slice(2), true]));
const out = path.join('research-data', 'export'); fs.rmSync(out, { recursive: true, force: true });
const r = exportDataset({ labDir: path.join('research-data', 'lab'), dir: path.join('research-data', 'backfill'), out, sectorsFile: path.join('research-data', 'sp500-sectors.csv'), includeVault: !!flags['include-vault'] });
console.log(`exported ${r.rows} feature rows, ${r.tickers} tickers, ${r.first}..${r.cutoff}; vault ${r.vaultIncluded ? 'INCLUDED' : 'withheld'}`);
for (const f of r.files) console.log(`  ${f.f.padEnd(20)} ${(f.bytes / 1e6).toFixed(1)} MB`);
console.log('\nNext: tar -czf research-data/export.tar.gz -C research-data export');
