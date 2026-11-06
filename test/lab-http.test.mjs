import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'labhttp-')); fs.mkdirSync(path.join(TMP, 'scan')); fs.mkdirSync(path.join(TMP, 'j'));
Object.assign(process.env, { PORT: '4318', DASHBOARD_PASSWORD: 'lab-test-password-1', SESSION_SECRET: 'x'.repeat(40), OPTIONS_PROVIDER: 'null', SCAN_DIR: path.join(TMP, 'scan'), SIGNAL_LOG_DIR: path.join(TMP, 'j'), BASELINE_DIR: path.join(TMP, 'b'), LAB_WORKER_SCRIPT: path.resolve(new URL('./fixtures/fake-lab-worker.mjs', import.meta.url).pathname), FAKE_LAB_DELAY: '300' });
const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch { /* ignore */ } setTimeout(() => process.exit(0), 50).unref(); });
const B = 'http://127.0.0.1:4318';
const cookie = (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"lab-test-password-1"}' })).headers.get('set-cookie').split(';')[0];
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(b) });

test('lab routes require sign-in', async () => { for (const [m, p] of [['GET', '/api/lab/status'], ['POST', '/api/lab/ask'], ['POST', '/api/lab/validate'], ['POST', '/api/lab/vault']]) assert.equal((await fetch(B + p, { method: m })).status, 401, p); });
test('lab ask: validates the prompt, returns results, reports a busy lab with 409 and keeps errors readable', async () => {
  assert.equal((await post('/api/lab/ask', { prompt: 'short' })).status, 400); assert.equal((await post('/api/lab/ask', { prompt: 'x'.repeat(1600) })).status, 400); assert.equal((await post('/api/lab/ask', {})).status, 400);
  const a = post('/api/lab/ask', { prompt: 'a proper sentence about flow' }); await new Promise((r) => setTimeout(r, 60));
  const second = await post('/api/lab/ask', { prompt: 'another proper sentence here' }); assert.equal(second.status, 409); assert.equal((await second.json()).code, 'BUSY');
  const ok = await a; assert.equal(ok.status, 200); const j = await ok.json(); assert.equal(j.ok, true); assert.equal(j.results[0].name, 'fake idea');
  const bad = await post('/api/lab/ask', { prompt: 'make it boom please' }); const jb = await bad.json(); assert.equal(bad.status, 200); assert.equal(jb.ok, false); assert.match(jb.error, /HTTP 401/);
  const st = await (await fetch(B + '/api/lab/status', { headers: { cookie } })).json(); assert.equal(st.ok, true); assert.equal(st.dataBuilt, true);
});
test('lab vault: needs confirm: true at the HTTP layer too', async () => { assert.equal((await post('/api/lab/vault', {})).status, 400); assert.equal((await post('/api/lab/vault', { confirm: 'yes' })).status, 400); assert.equal((await post('/api/lab/vault', { confirm: true })).status, 200); });
