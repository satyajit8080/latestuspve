// research/export.js — builds a SMALL, shareable research package from the backfill (never the raw 40 GB, never any secret).
// By default the sealed VAULT block is withheld, so other people/AIs can explore and validate but cannot contaminate the final test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPrices } from './backtest.js';
import { COLUMN_DOC } from './lab.js';
import { systemPrompt } from './lab-llm.js';

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export function exportDataset({ labDir, dir, out, sectorsFile = null, includeVault = false }) {
  const csv = path.join(labDir, 'features.csv'); const sp = path.join(labDir, 'splits.json');
  if (!fs.existsSync(csv)) throw new Error(`no ${csv}; run: node scripts/uw-lab.mjs features`);
  if (!fs.existsSync(sp)) throw new Error(`no ${sp}; run once: node scripts/uw-lab.mjs info (it creates the sealed blocks)`);
  const splits = JSON.parse(fs.readFileSync(sp, 'utf8')); const cutoff = includeVault ? splits.vault[1] : splits.validate[1];
  fs.mkdirSync(out, { recursive: true });
  const lines = fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean); const kept = [lines[0]]; const tickers = new Set(); let first = null;
  for (const l of lines.slice(1)) { const c = l.split(','); if (c[1] <= cutoff) { kept.push(l); tickers.add(c[0]); if (!first || c[1] < first) first = c[1]; } }
  fs.writeFileSync(path.join(out, 'features.csv'), kept.join('\n') + '\n');
  const prices = loadPrices(dir, [...tickers].sort()); const pl = ['ticker,date,close'];
  for (const [t, p] of [...prices].sort((a, b) => (a[0] < b[0] ? -1 : 1))) for (let i = 0; i < p.dates.length; i++) if (p.dates[i] <= cutoff && p.dates[i] >= shiftDays(first, -15)) pl.push(`${t},${p.dates[i]},${p.close[i]}`);
  fs.writeFileSync(path.join(out, 'prices.csv'), pl.join('\n') + '\n');
  if (sectorsFile && fs.existsSync(sectorsFile)) fs.copyFileSync(sectorsFile, path.join(out, 'sectors.csv'));
  const colDoc = Object.entries(COLUMN_DOC).filter(([k]) => k !== 'mom1' && k !== 'mom5').map(([k, v]) => `- \`${k}\`: ${v}`).join('\n');
  fs.writeFileSync(path.join(out, 'DATA_DICTIONARY.md'), `# Dataset: US options flow, S&P 500, daily\n\nOne row per ticker per trading day (only days with data). Source: Unusual Whales (private research use; do not redistribute).\n\n## Files\n- features.csv: ticker, date, then the columns below. Flow columns are computed from alerts up to 15:30 ET that day.\n- prices.csv: ticker, date, close (daily close, regular session).\n- sectors.csv: ticker, sector (if present).\n\n## Columns\n${colDoc}\n\n## Timing rules (no look-ahead)\n- A signal for day D may use only rows dated <= D. Entry = close of D. Label = close(D+h)/close(D)-1 for h = 1, 3, 5 trading days, from prices.csv.\n- oiImb/oiNetPrem are published the morning of D and reflect trades of D-1.\n- Missing flow values mean no alerts that day (usually zero flow), missing tape/OI means no data.\n\n## Protocol (important)\n- EXPLORE days: ${splits.explore[0]} .. ${splits.explore[1]}  (use freely, but count every idea you try)\n- VALIDATE days: ${splits.validate[0]} .. ${splits.validate[1]}  (test each shortlisted idea ONCE)\n- ${includeVault ? `VAULT days: ${splits.vault[0]} .. ${splits.vault[1]} (included in this file: results on it are no longer a clean test)` : `VAULT days: ${splits.vault[0]} .. ${splits.vault[1]}  WITHHELD on purpose; the owner will run your best ideas on it once`}\n- Drop any signal whose label window (D+h) would run past the end of its block: no leakage between blocks.\n- Use daily cross-sectional rank IC (Spearman across tickers), t-stats on NON-overlapping days (every h-th day), and apply a Bonferroni threshold for the number of ideas you tried.\n- Strong known effect to control for: yesterday's return reverses next day (IC about -0.13). Always report IC after removing it.\n- Previous finding to beat: single-leg flow (alertSingle) has IC about +0.01 at 1 day, t about 2, not significant after multiple-testing correction.\n`);
  fs.writeFileSync(path.join(out, 'PROMPT_FOR_AI.md'), `# Paste this to the AI together with the files\n\nYou are a careful quantitative researcher. Test hypotheses on the attached dataset (read DATA_DICTIONARY.md first and follow its protocol exactly).\nRules: never use future data; do not look for the withheld vault days; keep a running count of every idea you try; report for each candidate: formula, horizon, IC, non-overlapping t, IC after removing yesterday's return, IC in each half of the explore block, and the validate-block result (tested once). Be honest if nothing works.\nExpress each final candidate in the JSON expression language below so the owner can re-run it exactly on the sealed vault:\n\n${systemPrompt()}\n`);
  const files = fs.readdirSync(out).filter((f) => f !== 'SHA256SUMS.txt').sort(); fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), files.map((f) => `${sha256(path.join(out, f))}  ${f}`).join('\n') + '\n');
  return { cutoff, rows: kept.length - 1, tickers: tickers.size, first, priceRows: pl.length - 1, vaultIncluded: includeVault, files: files.map((f) => ({ f, bytes: fs.statSync(path.join(out, f)).size })) };
}
function shiftDays(d, n) { return new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
