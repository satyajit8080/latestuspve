import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createLabClient } from '../lib/lab-client.js';

const script = path.resolve(new URL('./fixtures/fake-lab-worker.mjs', import.meta.url).pathname);
const mk = (env = {}, timeoutMs = 5000) => createLabClient({ script, cwd: process.cwd(), env: { ...process.env, ...env }, timeoutMs });

test('lab client: request/response over IPC, one operation at a time, status answered while busy', async () => {
  const c = mk({ FAKE_LAB_DELAY: '250' });
  try {
    const first = c.call('ask', { prompt: 'a long enough prompt' });
    await assert.rejects(c.call('ask', { prompt: 'second one at once' }), (e) => e.code === 'BUSY');
    assert.deepEqual(await c.call('status'), { busy: true, op: 'ask' });
    assert.equal((await first).results[0].name, 'fake idea'); assert.equal(c.busy(), null);
    assert.equal((await c.call('status')).dataBuilt, true);
  } finally { c.stop(); }
});
test('lab client: worker errors keep their message and code; a crash is reported and the next call works again', async () => {
  const c = mk();
  try {
    await assert.rejects(c.call('ask', { prompt: 'please boom now' }), (e) => e.code === 'LLM' && /HTTP 401/.test(e.message));
    await assert.rejects(c.call('ask', { prompt: 'please crash now' }), (e) => e.code === 'WORKER_EXIT');
    assert.equal(c.busy(), null); assert.equal((await c.call('status')).dataBuilt, true);
  } finally { c.stop(); }
});
test('lab client: a hung worker is stopped after the timeout', async () => {
  const c = mk({ FAKE_LAB_DELAY: '5000' }, 300);
  try { await assert.rejects(c.call('ask', { prompt: 'this will take too long' }), (e) => e.code === 'TIMEOUT'); assert.equal(c.busy(), null); } finally { c.stop(); }
});
