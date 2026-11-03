import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toCsv, cell } from '../lib/csv.js';

test('csv: quoting, nulls are empty (never 0), arrays joined, formula injection neutralised', () => {
  assert.equal(cell('a,b'), '"a,b"'); assert.equal(cell('say "hi"'), '"say ""hi"""'); assert.equal(cell(null), ''); assert.equal(cell(undefined), ''); assert.equal(cell(NaN), '');
  assert.equal(cell(0), '0'); assert.equal(cell(['EARNINGS', 'OUTSIDE_RTH']), 'EARNINGS|OUTSIDE_RTH'); assert.equal(cell(true), 'true');
  assert.equal(cell('=cmd|calc'), "'=cmd|calc"); assert.equal(cell('@SUM(A1)'), "'@SUM(A1)"); assert.equal(cell('-12.5'), '-12.5');
  assert.equal(toCsv([{ a: 1, b: null }, { a: 2, b: 'x' }], [{ header: 'a', key: 'a' }, { header: 'b', key: 'b' }]), 'a,b\r\n1,\r\n2,x\r\n');
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
fs.mkdirSync(path.join(TMP, 'scan')); fs.mkdirSync(path.join(TMP, 'j'));
fs.writeFileSync(path.join(TMP, 'scan', 'latest.json'), JSON.stringify({ generatedAt: '2026-11-03T16:00:00.000Z', partial: false, rows: [{ ticker: 'NVDA', productionScore: 24, dir: 'bull', signal: 'CALL', gated: false, gateReasons: [], price: 208.3, rawScore: null }, { ticker: 'BAD', error: 'x' }] }));
fs.writeFileSync(path.join(TMP, 'j', 'signal-log-2026-11-03.jsonl'), JSON.stringify({ id: 'NVDA:1', ticker: 'NVDA', firedAt: '2026-11-03T16:00:00Z', composite: { dir: 'bull', finalScore: 70, gated: false, gateReasons: ['OUTSIDE_RTH'] }, entry: { stockPrice: 208.3 }, outcomes: {} }) + '\n');
Object.assign(process.env, { PORT: '4316', DASHBOARD_PASSWORD: 'export-test-password', OPTIONS_PROVIDER: 'null', SCAN_DIR: path.join(TMP, 'scan'), SIGNAL_LOG_DIR: path.join(TMP, 'j'), BASELINE_DIR: path.join(TMP, 'b') });
const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch { /* ignore */ } });
const B = 'http://127.0.0.1:4316';
const cookie = (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"export-test-password"}' })).headers.get('set-cookie').split(';')[0];

test('exports require sign-in', async () => { for (const p of ['/api/export/scan.csv', '/api/export/journal.csv', '/api/export/journal.json']) assert.equal((await fetch(B + p)).status, 401, p); });

test('scan.csv: attachment, header row, error rows excluded, nulls empty', async () => {
  const r = await fetch(B + '/api/export/scan.csv', { headers: { cookie } });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment; filename="scan-2026-11-03T16-00-00\.csv"/); assert.match(r.headers.get('content-type'), /text\/csv/);
  const lines = (await r.text()).trim().split('\r\n');
  assert.match(lines[0], /^ticker,sector,dir,signal,score,rawScore,gated,gateReasons/);
  assert.equal(lines.length, 2); assert.match(lines[1], /^NVDA,,bull,CALL,24,,false,,/);
});

test('journal.csv and journal.json carry the saved rows', async () => {
  const csv = (await (await fetch(B + '/api/export/journal.csv', { headers: { cookie } })).text()).trim().split('\r\n');
  assert.match(csv[0], /^id,ticker,firedAt,dir,score,rawScore,gated,gateReasons/); assert.match(csv[1], /^NVDA:1,NVDA,2026-11-03T16:00:00Z,bull,70,,false,OUTSIDE_RTH/);
  const j = await (await fetch(B + '/api/export/journal.json', { headers: { cookie } })).json(); assert.equal(j.length, 1); assert.equal(j[0].ticker, 'NVDA');
});

import { parseDirectory, sample } from '../scripts/make-universe.mjs';
test('universe builder: drops test issues, footer and non-plain symbols; sampling is unique and bounded', () => {
  const nasdaq = 'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nAAPL|Apple|Q|N|N|100|N|N\nZZZT|Test|G|Y|N|100|N|N\nABCDW|Warrant|S|N|N|100|N|N\nQQQ|Invesco|G|N|N|100|Y|N\nFile Creation Time: 1103202610:00|||||||';
  assert.deepEqual(parseDirectory(nasdaq), ['AAPL', 'QQQ']);
  assert.deepEqual(parseDirectory(nasdaq, { etf: false }), ['AAPL']);
  const other = 'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\nIBM|IBM|N|IBM|N|100|N|IBM\nBRK.B|Berkshire|N|BRK.B|N|100|N|BRK.B';
  assert.deepEqual(parseDirectory(other), ['IBM']);
  const s = sample(['A', 'B', 'C', 'D', 'A'], 3); assert.equal(s.length, 3); assert.equal(new Set(s).size, 3);
  assert.equal(sample(['A', 'B'], 10).length, 2);
});
