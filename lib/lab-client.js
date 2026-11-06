// lib/lab-client.js — runs the lab in a separate worker process and talks to it over IPC, one operation at a time.
// The dashboard server never imports research code: it only forks a script. A long operation (loading the 2-year dataset,
// an LLM call) therefore cannot freeze the website.
import { fork } from 'node:child_process';

export function createLabClient({ script, cwd, env, timeoutMs = 180000 }) {
  let child = null, seq = 0, busy = null; const pending = new Map();
  const fail = (e, code) => Object.assign(new Error(e), { code });
  function ensure() {
    if (child && child.connected) return child;
    child = fork(script, [], { cwd, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); const me = child;
    me.on('message', (m) => { const p = m && pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.t); if (m.ok) p.resolve(m.data); else p.reject(fail(m.error, m.code)); });
    me.on('exit', () => { for (const [, p] of pending) { clearTimeout(p.t); p.reject(fail('The lab worker stopped; try again.', 'WORKER_EXIT')); } pending.clear(); if (child === me) { child = null; busy = null; } });
    return me;
  }
  return {
    busy: () => busy,
    async call(type, payload = {}) {
      if (busy && type === 'status') return { busy: true, op: busy };                       // the worker is occupied: answer from here
      if (busy) throw fail(`The lab is busy (${busy}). Wait for it to finish.`, 'BUSY');
      busy = type; const c = ensure(); const id = ++seq;
      try {
        return await new Promise((resolve, reject) => { const t = setTimeout(() => { pending.delete(id); reject(fail('The lab took too long and was stopped.', 'TIMEOUT')); try { c.kill(); } catch { /* ignore */ } }, timeoutMs); pending.set(id, { resolve, reject, t }); c.send({ id, type, payload }); });
      } finally { busy = null; }
    },
    stop() { if (child) { try { child.kill(); } catch { /* ignore */ } child = null; } },
  };
}
