// HTTP-level proofs: (1) an AI request leaves journal/baselines byte-identical, (2) login is rate limited,
// (3) single-ticker UW calls are refused while a scan runs is covered in pipeline.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'http-'));
process.env.SIGNAL_LOG_DIR = path.join(TMP, 'journal');
process.env.BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCAN_DIR = path.join(TMP, 'scan');
process.env.PORT = '4312';
process.env.DASHBOARD_PASSWORD = 'integration-test-password';
process.env.OPTIONS_PROVIDER = 'uw'; process.env.UNUSUAL_WHALES_API_TOKEN = 'uwtoken1234';
process.env.AI_ENABLED = 'true'; process.env.OPENROUTER_API_KEY = 'sk-or-test';

const real = globalThis.fetch;
const J = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o });
const exp = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '').slice(2);
const sym = (cp, k) => `AAPL${exp}${cp}${String(k * 1000).padStart(8, '0')}`;
let aiCalls = 0, uwCalls = 0;
globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (s.includes('127.0.0.1') || s.includes('localhost')) return real(u, o);
  if (s.includes('openrouter.ai')) { aiCalls++; return J({ choices: [{ message: { content: JSON.stringify({ analysts: {}, summary: { text: 'ok', ai_view: 'bullish', ai_confidence: 60 } }) } }] }); }
  uwCalls++;
  if (s.includes('/stock-state')) return J({ data: { close: '218', prev_close: '200', volume: '5000000' } });
  if (s.includes('/option-contracts')) return J({ data: [
    { option_symbol: sym('C', 200), volume: 90000, open_interest: 40000, implied_volatility: 0.45, delta: 0.55, gamma: 0.05, nbbo_bid: 5, nbbo_ask: 5.2 },
    { option_symbol: sym('P', 200), volume: 1200, open_interest: 40000, implied_volatility: 0.42, delta: -0.45, gamma: 0.04, nbbo_bid: 2, nbbo_ask: 2.2 },
  ] });
  if (s.includes('/flow-alerts')) return J({ data: [{ type: 'call', total_premium: '9000000', total_ask_side_prem: '9000000', total_bid_side_prem: '0', total_size: 50, expiry: '2099-01-01', option_chain: sym('C', 200), created_at: new Date().toISOString() }] });
  if (s.includes('/oi-change')) return J({ data: [{ option_symbol: sym('C', 200), curr_oi: 46000, prev_oi: 40000 }] });
  if (s.includes('/ohlc/5m')) return J({ data: Array.from({ length: 10 }, (_, i) => ({ start_time: new Date(Date.UTC(2026, 7, 24, 13, 30 + i * 5)).toISOString(), open: 208, high: 211, low: 207, close: 209, volume: 100000 })) });
  if (s.includes('/ohlc')) return J({ data: Array.from({ length: 20 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, open: 200, high: 205 + i, low: 198 + i, close: 200 + i, volume: 1e6 })) });
  return J({ data: [] });
};

const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch { /* ignore */ } globalThis.fetch = real; });
const B = 'http://127.0.0.1:4312';
const login = (password) => real(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });

const snapshot = () => {
  const rd = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort().map((f) => f + ':' + fs.readFileSync(path.join(d, f), 'utf8')) : []);
  return JSON.stringify({ journal: rd(process.env.SIGNAL_LOG_DIR), baselines: rd(process.env.BASELINE_DIR) });
};

test('an AI request leaves the journal and baselines byte-identical (explain-only, no research side effects)', async () => {
  const ok = await login('integration-test-password');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal(snapshot(), JSON.stringify({ journal: [], baselines: [] }));
  const r = await (await real(B + '/api/ai/analyze/AAPL', { method: 'POST', headers: { cookie } })).json();
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.ok(aiCalls >= 1 && uwCalls > 0);
  assert.equal(snapshot(), JSON.stringify({ journal: [], baselines: [] }), 'AI analyze must not journal, record baselines or advance state');
  // contrast: the regular ticker route DOES record research data
  const o = await (await real(B + '/api/options/AAPL', { headers: { cookie } })).json();
  assert.equal(o.ok, true);
  assert.notEqual(snapshot(), JSON.stringify({ journal: [], baselines: [] }));
});

test('login is rate limited per IP: repeated wrong passwords lock out (429), even for the right password', async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await login('wrong-' + i)).status);
  assert.deepEqual(codes.slice(0, 5), [403, 403, 403, 403, 403]);
  assert.equal(codes[5], 429);
  const locked = await login('integration-test-password');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});
