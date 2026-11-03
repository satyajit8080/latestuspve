import { state, emit } from './store.js';
const etags = new Map();
// Returns { ok, status, data, notModified }. Throws { network:true } on network failure (poller counts it as a failure).
export async function api(path, { method = 'GET', body, useEtag = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (useEtag && etags.has(path)) headers['If-None-Match'] = etags.get(path);
  let res;
  try { res = await fetch(path, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { const err = new Error('network'); err.network = true; throw err; }
  if (res.status === 401) { state.authed = false; emit('auth'); return { ok: false, status: 401, data: null }; }
  if (res.status === 304) return { ok: true, status: 304, notModified: true, data: null };
  if (useEtag && res.headers.get('etag')) etags.set(path, res.headers.get('etag'));
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (res.status >= 500) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; throw err; }
  return { ok: res.ok, status: res.status, data, retryAfter: Number(res.headers.get('retry-after')) || null };
}
