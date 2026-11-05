import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSp500 } from '../scripts/make-sp500.mjs';

test('parseSp500: both CSV layouts, quoted commas, dedupe, bad symbols dropped', () => {
  const gh = 'Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location\nMMM,3M,Industrials,x,"Saint Paul, Minnesota"\nBRK.B,"Berkshire, B",Financials,x,y\nMMM,dup,Industrials,x,y\nbad sym,x,y,z,w\n';
  assert.deepEqual(parseSp500(gh).map((r) => r.symbol), ['MMM', 'BRK.B']);
  assert.equal(parseSp500(gh)[1].name, 'Berkshire, B');
  assert.equal(parseSp500('Symbol,Security,Sector,DateAdded\nAAPL,Apple,Information Technology,1982-11-30\n')[0].sector, 'Information Technology');
  assert.deepEqual(parseSp500('nothing'), []);
});

test('committed snapshot is a plausible S&P 500 list', () => {
  const rows = parseSp500(fs.readFileSync(new URL('../research/data/sp500-snapshot-2026-11-05.csv', import.meta.url), 'utf8'));
  assert.ok(rows.length >= 480 && rows.length <= 520, String(rows.length));
  for (const t of ['AAPL', 'MSFT', 'NVDA', 'JPM']) assert.ok(rows.some((r) => r.symbol === t), t);
});
