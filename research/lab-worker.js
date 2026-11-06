// research/lab-worker.js — forked by the dashboard server (lib/lab-client.js). Holds the lab service; talks over IPC.
import { createLabService } from './lab-service.js';
const svc = createLabService({ dir: process.env.LAB_BACKFILL_DIR || 'research-data/backfill', labDir: process.env.LAB_HOME || 'research-data/lab' });
const ALLOWED = new Set(['status', 'ask', 'validate', 'vault']);
process.on('message', async (m) => {
  if (!m || typeof m.id !== 'number' || !ALLOWED.has(m.type)) return;
  try { process.send({ id: m.id, ok: true, data: await svc[m.type](m.payload || {}) }); }
  catch (e) { process.send({ id: m.id, ok: false, error: String(e && e.message || e).slice(0, 400), code: e && e.code }); }
});
