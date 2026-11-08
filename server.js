// US options signal engine — server.
// Unusual Whales is the only data source. One pipeline (engine/pipeline.js) builds the production signal
// (engine/options-engine.js) and the v2 shadow challenger (engine/v2.js) for both these routes and the scan.
// Secrets stay server-side. AI is explain-only.

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/env.js';
import { createLabClient } from './lib/lab-client.js';
import { registerIntelRoutes } from './lib/intel-routes.js';
import { toCsv } from './lib/csv.js';
import { resolveSecrets, LoginThrottle } from './lib/auth.js';
import { makeOptionsProvider, optionsProviderStatus } from './providers/options.js';
import { OpenRouterClient, configFromEnv as aiConfigFromEnv } from './providers/openrouter.js';
import { buildAiContext, runAnalysis } from './ai/agents.js';
import { safeTicker } from './ticker.js';
import { loadPromotion } from './validated/promotion.js';
import { readJournal, readSignal, pendingOutcomes } from './store/journal-store.js';
import { filterJournal, computeLearning } from './store/journal.js';
import { baselineReport } from './store/evaluation.js';
import { createPipelineContext, computeTickerSignal } from './engine/pipeline.js';
import { V2_VERSION } from './engine/v2.js';
import { BaselineStore } from './store/normalize.js';
import { macroReadiness, researchReadiness, RateLimiter } from './store/readiness.js';
import { OPTIONS_ENGINE_VERSION } from './engine/options-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- .env loader (inline comments stripped; see lib/env.js) -------------------
loadEnvFile(path.join(__dirname, '.env'), process.env, fs);

let SECRETS;
try { SECRETS = resolveSecrets(process.env); } catch (e) { console.error('FATAL: ' + e.message); process.exit(1); }

const CONFIG = {
  PASSWORD: SECRETS.password,
  PORT: Number(process.env.PORT || 4000),
  SESSION_TTL_MS: 1000 * 60 * 60 * 12,
};

// =============================================================================
//  AUTH  (basic gate for a self-hosted single-user tool — change the password;
//  this is not hardened multi-user auth)
// =============================================================================
// Stateless auth: the cookie is an HMAC-signed expiry, so sessions survive server restarts/deploys
// (previously an in-memory Map wiped every restart → refresh bounced to login). The signing secret is
// SESSION_SECRET (independent of the password); rotating it logs everyone out.
const SESSION_SECRET = crypto.createHash('sha256').update('sess-v2|' + SECRETS.sessionSecret).digest();
function signSession(expMs) { return `${expMs}.${crypto.createHmac('sha256', SESSION_SECRET).update(String(expMs)).digest('hex')}`; }
function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.'); if (i < 0) return false;
  const expStr = token.slice(0, i), mac = token.slice(i + 1);
  const exp = Number(expStr); if (!Number.isFinite(exp) || exp < Date.now()) return false;
  let a, b; try { a = Buffer.from(mac, 'hex'); b = Buffer.from(crypto.createHmac('sha256', SESSION_SECRET).update(expStr).digest('hex'), 'hex'); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
  return null;
}
function safeEq(a, b) { const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b)); if (ab.length !== bb.length) return false; try { return crypto.timingSafeEqual(ab, bb); } catch { return false; } }
function authed(req) { return verifySession(getCookie(req, 'sess')); }
function requireAuth(req, res, next) { if (authed(req)) return next(); res.status(401).json({ error: 'unauthorized' }); }

// =============================================================================
//  APP
// =============================================================================
const app = express();
app.use(express.json({ limit: '256kb' }));

const LOGIN_THROTTLE = new LoginThrottle();
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.post('/auth/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const gate = LOGIN_THROTTLE.check(ip);
  if (!gate.ok) { res.setHeader('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000))); return res.status(429).json({ error: 'too many attempts', retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) }); }
  if (!safeEq(req.body?.password || '', CONFIG.PASSWORD)) { LOGIN_THROTTLE.fail(ip); return res.status(403).json({ error: 'wrong password' }); }
  LOGIN_THROTTLE.success(ip);
  const token = signSession(Date.now() + CONFIG.SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(CONFIG.SESSION_TTL_MS / 1000)}${COOKIE_SECURE}`);
  res.json({ ok: true });
});
app.post('/auth/logout', (req, res) => { res.setHeader('Set-Cookie', 'sess=; HttpOnly; Path=/; Max-Age=0' + COOKIE_SECURE); res.json({ ok: true }); });
app.get('/auth/status', (req, res) => res.json({ authed: authed(req), options: optionsProviderStatus(process.env), ai: { enabled: AI.cfg.enabled && AI.client.available }, versions: { optionsEngine: OPTIONS_ENGINE_VERSION, v2: V2_VERSION }, primary: PROMOTION.primary }));

// ---- REAL options + stock (PRIMARY). Provider selected via env; key stays server-side. ----
const UW_LIMITER = new RateLimiter({ maxPerMinute: Number(process.env.UW_MAX_PER_MINUTE) || null, maxPerScan: Number(process.env.UW_MAX_PER_SCAN) || 12000 });   // 500 tickers x ~14 calls + headroom
const OPT_PROVIDER = makeOptionsProvider(process.env, { limiter: UW_LIMITER });
const AI = { cfg: aiConfigFromEnv(process.env), client: new OpenRouterClient(aiConfigFromEnv(process.env)) };
const PROMOTION = loadPromotion(path.join(__dirname, 'validated', 'promotion.json'));   // the ONE promotion switch; human-edited
const aiCache = new Map(); // ticker -> { ts, payload } advisory AI results (short TTL)
// Optional lightweight persistence of AI runs (OFF by default). Never stores keys/prompts/secrets.
const AI_PERSIST = process.env.AI_PERSIST === 'true';
const AI_LOG_DIR = process.env.AI_LOG_DIR || path.join(__dirname, 'ai-runs');
async function persistAiRun(ticker, rec) {
  if (!AI_PERSIST) return;
  try { await fs.promises.mkdir(AI_LOG_DIR, { recursive: true }); await fs.promises.appendFile(path.join(AI_LOG_DIR, `${ticker}.jsonl`), JSON.stringify(rec) + '\n'); } catch (e) { /* best-effort; never breaks the response */ }
}

// ONE pipeline (engine/pipeline.js) builds production + v2-shadow signals for BOTH this server and the scan.
// Per-process research state (baselines, v2 state machine, IV skew, readiness) lives in PIPE, keyed by ticker.
const BASELINES = new BaselineStore();
const PIPE = createPipelineContext(OPT_PROVIDER, { baselines: BASELINES, promotion: PROMOTION });
const buildTickerSignal = (ticker, opts = {}) => computeTickerSignal(OPT_PROVIDER, ticker, PIPE, opts);

// The scan child process has its OWN UW rate limiter; live single-ticker calls during a scan could push the
// combined rate past UW's per-minute limit, so they are refused until the scan finishes.
function scanBusy(res) {
  if (!SCAN_STATE.running) return false;
  res.status(409).json({ ok: false, error: 'SCAN_RUNNING', detail: 'A universe scan is using the Unusual Whales budget. Retry when it finishes (see /api/scan/status).', state: SCAN_STATE });
  return true;
}
app.get('/api/options/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker', provider: OPT_PROVIDER.name, normalized: null });
  if (scanBusy(res)) return;
  if (OPT_PROVIDER.name === 'null') {
    return res.json({ ok: false, provider: 'null', error: OPT_PROVIDER.reason || 'Insufficient options data — no options provider configured (set OPTIONS_PROVIDER + OPTIONS_API_KEY)', normalized: null });
  }
  try {
    const built = await buildTickerSignal(ticker);
    if (!built.ok) return res.json({ ok: false, provider: OPT_PROVIDER.name, status: built.status || null, reason: built.reason || null, error: built.error || built.detail || 'no options data', normalized: null });
    const sig = built.signal; const chain = built.chain;
    const contracts = (chain.contracts || []).slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 60);
    res.json({ ok: true, provider: OPT_PROVIDER.name, ts: new Date().toISOString(), signal: sig, chain: { ticker, underlying: chain.underlying, fieldsAvailable: chain.fieldsAvailable, contracts } });
  } catch (e) {
    res.json({ ok: false, provider: OPT_PROVIDER.name, error: e.message, normalized: null }); // 403/paywall surfaces here; no fabrication
  }
});


// ---- Ticker tear sheet data. GET is CACHE-ONLY (zero UW calls). POST .../refresh is an explicit live recompute that is
// side-effect-free (no journal row, no baseline, no state) and is refused while a scan runs or the limiter is saturated.
function tickerPayload(ticker, signal, chain, at, spark, source) {
  const contracts = ((chain && chain.contracts) || []).slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 80);
  const flow = chain && chain.flow && chain.flow.available ? chain.flow.largeTrades.slice(0, 40) : [];
  return { ok: true, source, ticker, at, ageMs: Date.now() - at, signal, spark: spark || [], chain: { underlying: chain && chain.underlying, fieldsAvailable: chain && chain.fieldsAvailable, contracts, flow } };
}
app.get('/api/ticker/:ticker', requireAuth, (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'Invalid ticker' });
  const hit = PIPE.lastSignals.get(ticker);
  if (!hit) return res.json({ ok: false, reason: 'no_cache', ticker });
  res.json(tickerPayload(ticker, hit.signal, hit.chain, hit.at, hit.spark, 'cache'));
});
app.post('/api/ticker/:ticker/refresh', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'Invalid ticker' });
  if (OPT_PROVIDER.name === 'null') return res.status(400).json({ ok: false, error: OPT_PROVIDER.reason || 'No options provider configured' });
  // allowed during a scan: it is an explicit user action, one ticker (~8 calls), and UW 429 backoff paces it
  const gate = UW_LIMITER.canRequest();
  if (!gate.ok) return res.status(429).json({ ok: false, error: 'LIMITER_SATURATED', reason: gate.reason, retryAfterMs: gate.retryAfterMs || null });
  try {
    const built = await buildTickerSignal(ticker, { sideEffects: false });
    if (!built.ok) return res.json({ ok: false, status: built.status || null, reason: built.reason || null, error: built.error || built.detail || 'no options data' });
    const hit = PIPE.lastSignals.get(ticker);
    res.json(tickerPayload(ticker, built.signal, built.chain, hit ? hit.at : Date.now(), hit ? hit.spark : [], 'live'));
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---- ADVISORY AI layer (OpenRouter). On-demand only. Never alters the deterministic signal. ----
app.post('/api/ai/analyze/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker' });
  if (!AI.client.available || !AI.cfg.enabled) return res.json({ ok: false, error: 'AI layer not configured (set OPENROUTER_API_KEY)', aiEnabled: false });
  // cache
  const hit = aiCache.get(ticker);
  if (hit && (Date.now() - hit.ts) < AI.cfg.cacheTtlMs) return res.json({ ok: true, cached: true, ...hit.payload });
  // AI is explain-only and must have NO research side effects: reuse the last computed signal when fresh,
  // otherwise build with sideEffects:false (no journal row, no baseline write, no state/IV-skew advance).
  let built;
  const last = PIPE.lastSignals.get(ticker);
  if (last && Date.now() - last.at < 10 * 60000) built = { ok: true, signal: last.signal, chain: last.chain };
  else { if (scanBusy(res)) return; try { built = await buildTickerSignal(ticker, { sideEffects: false }); } catch (e) { return res.json({ ok: false, error: 'options data error: ' + e.message }); } }
  if (!built.ok || !built.signal) return res.json({ ok: false, error: built.error || 'no options data for ticker' });
  const sig = built.signal;
  // gather real extras for AI context (no fabrication; each optional)
  const extras = { ticker };
  try { if (OPT_PROVIDER.name !== 'null' && OPT_PROVIDER.getNetPremium) { const np = await OPT_PROVIDER.getNetPremium(ticker); if (np && np.available) extras.netPremium = np; } } catch (e) {}
  if (built.chain && built.chain.flow && built.chain.flow.largeTrades) extras.sweeps = built.chain.flow.largeTrades;
  const context = buildAiContext(sig, extras);
  const split = AI.cfg.models.analyst !== AI.cfg.models.manager;   // single call when identical → no extra cost
  const llm = (messages, o = {}) => AI.client.chat({ messages, model: (AI.cfg.models[o.role] || AI.cfg.model), reasoning: !!(AI.cfg.reasoning && AI.cfg.reasoning[o.role]), responseFormat: AI.cfg.structured ? { type: 'json_object' } : undefined });
  const r = await runAnalysis({ signal: sig, context, extras, split, llm });
  if (!r.ok) { await persistAiRun(ticker, { ts: new Date().toISOString(), ticker, model: r.model || AI.cfg.model, deterministic: { finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier }, error: r.error || 'AI analysis failed' }); return res.json({ ok: false, error: r.error || 'AI analysis failed', signal: publicSignal(sig) }); }
  const payload = { provider: OPT_PROVIDER.name, model: r.model, ts: new Date().toISOString(), signal: publicSignal(sig), ai: r.ai };
  aiCache.set(ticker, { ts: Date.now(), payload });
  await persistAiRun(ticker, { ts: payload.ts, ticker, model: r.model, deterministic: { finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier }, aiView: r.ai.aiView, aiConfidence: r.ai.aiConfidence });
  res.json({ ok: true, cached: false, ...payload });
});

// AI-run history (only when AI_PERSIST=true). Read-only; never feeds scoring/backtest.
app.get('/api/ai/history/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker' });
  if (!AI_PERSIST) return res.json({ ok: true, enabled: false, runs: [] });
  try {
    const txt = await fs.promises.readFile(path.join(AI_LOG_DIR, `${ticker}.jsonl`), 'utf8');
    const runs = txt.split('\n').filter(Boolean).slice(-50).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    res.json({ ok: true, enabled: true, runs });
  } catch (e) { res.json({ ok: true, enabled: true, runs: [] }); }
});
// ON-DEMAND SCAN — the ONLY thing that spends options-provider quota in bulk. Deliberately manual
// (no timer) so API usage is user-triggered. One run at a time; the child is detached from the request.

const SCAN_STATE = { running: false, startedAt: null, finishedAt: null, lastOk: null, message: '', limit: null };
app.post('/api/scan/run', requireAuth, (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.status(400).json({ ok: false, error: 'No options provider configured', reason: OPT_PROVIDER.reason || null });
  if (SCAN_STATE.running) return res.status(409).json({ ok: false, error: 'A scan is already running', state: SCAN_STATE });
  const limit = Math.max(1, Number(req.body && req.body.limit) || Number(process.env.SCAN_LIMIT) || 1000);
  const script = path.join(__dirname, 'research', 'scan-universe.js');
  if (!fs.existsSync(script)) return res.status(500).json({ ok: false, error: 'scan-universe.js not found' });
  SCAN_STATE.running = true; SCAN_STATE.done = null; SCAN_STATE.total = null; SCAN_STATE.etaMs = null; SCAN_STATE.startedAt = new Date().toISOString(); SCAN_STATE.finishedAt = null; SCAN_STATE.lastOk = null; SCAN_STATE.message = 'running'; SCAN_STATE.limit = limit;
  const child = spawn(process.execPath, [script], { cwd: __dirname, env: { ...process.env, SCAN_LIMIT: String(limit) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const grab = (b) => {
    tail = (tail + b.toString()).slice(-2000);
    const m = [...tail.matchAll(/(\d+)\/(\d+) scanned/g)].pop();
    if (m) { SCAN_STATE.done = Number(m[1]); SCAN_STATE.total = Number(m[2]); const el = Date.now() - Date.parse(SCAN_STATE.startedAt); SCAN_STATE.etaMs = SCAN_STATE.done > 0 ? Math.max(0, Math.round(el / SCAN_STATE.done * (SCAN_STATE.total - SCAN_STATE.done))) : null; }
  };
  child.stdout.on('data', grab); child.stderr.on('data', grab);
  child.on('close', (code) => {
    SCAN_STATE.running = false; SCAN_STATE.finishedAt = new Date().toISOString();
    SCAN_STATE.lastOk = code === 0; SCAN_STATE.message = (tail.trim().split('\n').pop() || `exit ${code}`).slice(0, 300);
  });
  child.on('error', (e) => { SCAN_STATE.running = false; SCAN_STATE.finishedAt = new Date().toISOString(); SCAN_STATE.lastOk = false; SCAN_STATE.message = e.message; });
  res.json({ ok: true, started: true, limit, state: SCAN_STATE });
});
app.get('/api/scan/status', requireAuth, (req, res) => res.json({ ok: true, ...SCAN_STATE }));

// MAIN SIGNALS FEED — serves the universe scan cache (production + v2 shadow per ticker).
// Fast: reads the cache written by research/scan-universe.js (no UW calls on page load). Never fabricates.
const SCAN_CACHE = path.join(process.env.SCAN_DIR || path.join(__dirname, 'research-data', 'scan'), 'latest.json');
app.get('/api/signals/us', requireAuth, (req, res) => {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(SCAN_CACHE, 'utf8')); } catch { /* not scanned yet */ }
  if (!cache || !Array.isArray(cache.rows)) {
    return res.json({ ok: true, available: false, reason: 'No scan yet — press “Run Scan” to fetch fresh data.', dataStatus: 'DATA UNAVAILABLE', rows: [] });
  }
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 500));
  const etag = `"${cache.generatedAt}-${limit}"`;
  res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const ageMs = Date.now() - Date.parse(cache.generatedAt || 0);
  const rows = cache.rows.slice(0, limit);
  res.json({
    ok: true, available: true, generatedAt: cache.generatedAt, ageSeconds: Math.round(ageMs / 1000),
    dataStatus: ageMs < 20 * 60000 ? 'MARKET DATA LIVE' : 'MARKET DATA DELAYED',
    universe: cache.universe, scored: cache.scored, skipped: cache.skipped, count: rows.length, partial: !!cache.partial, done: cache.done ?? null, total: cache.total ?? null,
    primary: PROMOTION.primary,
    rows,
    note: 'productionScore is the published score; v2Score is a shadow challenger and never modifies it. confidence is a data/conviction score, not a probability of profit.',
  });
});

// ---- Downloads (CSV/JSON). Read-only views of data already on disk; no Unusual Whales calls. ----
const SCAN_COLS = [['ticker'], ['sector'], ['dir'], ['signal'], ['productionScore', 'score'], ['rawScore'], ['gated'], ['gateReasons'], ['actionable'], ['coverage'], ['tier'], ['price'], ['changePct'], ['vsVwapPct'], ['relativeVolume', 'rvol'], ['oiChangeNet', 'net_oi_change'], ['ivRank', 'iv_rank'], ['optionsLiquidity', 'liquidity'], ['v2Score', 'v2_score_shadow'], ['v2Dir', 'v2_dir_shadow'], ['engineVersion'], ['updatedAt']].map(([key, header]) => ({ key, header: header || key }));
function sendDownload(res, name, type, body) {
  res.setHeader('Content-Type', type + '; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.setHeader('Cache-Control', 'no-store'); res.send(body);
}
app.get('/api/export/scan.csv', requireAuth, (req, res) => {
  let cache = null; try { cache = JSON.parse(fs.readFileSync(SCAN_CACHE, 'utf8')); } catch { /* none yet */ }
  if (!cache || !Array.isArray(cache.rows)) return res.status(404).json({ ok: false, error: 'No scan yet' });
  const rows = cache.rows.filter((r) => r && r.ticker && !r.error);
  const stamp = String(cache.generatedAt || '').replace(/[:.]/g, '-').slice(0, 19) || 'scan';
  sendDownload(res, `scan-${stamp}${cache.partial ? '-partial' : ''}.csv`, 'text/csv', toCsv(rows, SCAN_COLS));
});
app.get('/api/export/journal.csv', requireAuth, (req, res) => {
  try {
    const recs = readJournal();
    const oc = (r, h, k) => (r.outcomes && r.outcomes[h] && r.outcomes[h].status === 'resolved' ? r.outcomes[h][k] : null);
    const cols = [['id', (r) => r.id], ['ticker', (r) => r.ticker], ['firedAt', (r) => r.firedAt], ['dir', (r) => r.composite && r.composite.dir], ['score', (r) => r.composite && r.composite.finalScore], ['rawScore', (r) => r.composite && r.composite.rawScore],
      ['gated', (r) => r.composite && r.composite.gated], ['gateReasons', (r) => r.composite && r.composite.gateReasons], ['tier', (r) => r.composite && r.composite.tier], ['entryStock', (r) => r.entry && r.entry.stockPrice], ['entryOption', (r) => r.entry && r.entry.optionPrice],
      ['vsVwapPct', (r) => r.entry && r.entry.vsVwapPct], ['atr', (r) => r.context && r.context.atr], ['rvol', (r) => r.context && r.context.rvol], ['ret15m', (r) => oc(r, '15m', 'directionalReturnPct')], ['ret30m', (r) => oc(r, '30m', 'directionalReturnPct')], ['ret60m', (r) => oc(r, '60m', 'directionalReturnPct')],
      ['stock30m', (r) => oc(r, '30m', 'stockChangePct')], ['spy30m', (r) => oc(r, '30m', 'benchmarkReturnPct')], ['engineVersion', (r) => r.optionsEngineVersion || (r.composite && r.composite.optionsEngineVersion)], ['legacyScore', (r) => r.legacyScore], ['v2Score', (r) => r.v2 && r.v2.score], ['v2Dir', (r) => r.v2 && r.v2.dir]]
      .map(([header, get]) => ({ header, get }));
    sendDownload(res, `journal-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', toCsv(recs, cols));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/export/journal.json', requireAuth, (req, res) => {
  try { sendDownload(res, `journal-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(readJournal(), null, 1)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- SIGNAL JOURNAL (replaces Claude Review) -------------------------------
// Read-only over immutable signal records + append-only outcome patches.
app.get('/api/journal/list', requireAuth, (req, res) => {
  try { res.json({ ok: true, ...filterJournal(readJournal(), req.query) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/signal/:id', requireAuth, (req, res) => {
  try {
    const rec = readSignal(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, signal: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/stats', requireAuth, (req, res) => {
  try {
    const recs = readJournal();
    res.json({ ok: true, learning: computeLearning(recs, { horizon: req.query.horizon || '60m' }), pending: pendingOutcomes(recs).length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// On-demand outcome resolution (spends provider quota only when pressed).
const RESOLVE_STATE = { running: false, startedAt: null, finishedAt: null, lastOk: null, message: '' };
app.post('/api/journal/resolve', requireAuth, (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.status(400).json({ ok: false, error: 'No options provider configured', reason: OPT_PROVIDER.reason || null });
  if (RESOLVE_STATE.running) return res.status(409).json({ ok: false, error: 'Already resolving' });
  const script = path.join(__dirname, 'research', 'resolve-outcomes.js');
  if (!fs.existsSync(script)) return res.status(500).json({ ok: false, error: 'resolve-outcomes.js not found' });
  RESOLVE_STATE.running = true; RESOLVE_STATE.startedAt = new Date().toISOString(); RESOLVE_STATE.lastOk = null; RESOLVE_STATE.message = 'running';
  const child = spawn(process.execPath, [script], { cwd: __dirname, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = ''; const grab = (b) => { tail = (tail + b.toString()).slice(-2000); };
  child.stdout.on('data', grab); child.stderr.on('data', grab);
  child.on('close', (code) => { RESOLVE_STATE.running = false; RESOLVE_STATE.finishedAt = new Date().toISOString(); RESOLVE_STATE.lastOk = code === 0; RESOLVE_STATE.message = (tail.trim().split('\n').pop() || `exit ${code}`).slice(0, 300); });
  child.on('error', (e) => { RESOLVE_STATE.running = false; RESOLVE_STATE.lastOk = false; RESOLVE_STATE.message = e.message; });
  res.json({ ok: true, started: true });
});
app.get('/api/research/readiness', requireAuth, (req, res) => {
  try {
    const recs = readJournal();
    const report = baselineReport(recs);
    // readiness is per ticker: ?ticker=XYZ, else the most recently computed ticker
    const want = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const entries = [...PIPE.readiness.entries()];
    const rd = (want ? PIPE.readiness.get(want) : (entries.length ? entries[entries.length - 1][1] : null)) || { rvol: null, ivSkew: null, sector: null };
    res.json({ ok: true, ticker: want || (entries.length ? entries[entries.length - 1][0] : null), readiness: researchReadiness({
      report, journalCount: recs.length,
      rvol: rd.rvol, ivSkew: rd.ivSkew, sector: rd.sector,
      macro: macroReadiness({ uwSupportsMacroCalendar: false }),
    }), uw: { ...UW_LIMITER.stats(), ...optionsProviderStatus(process.env) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/evaluation', requireAuth, (req, res) => {
  try { res.json({ ok: true, report: baselineReport(readJournal()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/resolve/status', requireAuth, (req, res) => res.json({ ok: true, ...RESOLVE_STATE }));
// compact, safe view of the deterministic signal for the AI response (authority fields intact)
function publicSignal(sig) {
  return { ticker: sig.ticker, finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier, optionsScore: sig.optionsScore, rawScore: sig.rawScore, gated: sig.gated, actionable: sig.actionable, gateReasons: sig.gateReasons, priceGate: sig.priceGate, dataQualityStatus: sig.dataQualityStatus, dataQuality: sig.dataQuality, gexSource: sig.gexSource, ivRank: sig.ivRank, walls: sig.walls, agg: sig.agg ? { gex: sig.agg.gex, gammaFlip: sig.agg.gammaFlip, maxPain: sig.agg.maxPain } : null };
}

// ---- Options Intelligence (US stocks only; no Indian-market code paths) ----
const INTEL = registerIntelRoutes(app, { requireAuth, provider: OPT_PROVIDER, limiter: UW_LIMITER, legacyScanRunning: () => !!SCAN_STATE.running, scanScript: path.join(__dirname, 'research', 'intel-scan.js'), env: process.env, cwd: __dirname });
// ---- Lab: describe a test in plain words; the AI turns it into tests; they run on the 2-year dataset (explore block only) ----
// The heavy work happens in a separate worker process (lib/lab-client.js), never inside this server.
const lab = createLabClient({ script: process.env.LAB_WORKER_SCRIPT || path.join(__dirname, 'research', 'lab-worker.js'), cwd: __dirname, env: process.env });
async function labCall(res, type, payload) {
  try { const data = await lab.call(type, payload); return res.json({ ok: true, ...data }); }
  catch (e) { const code = e && e.code; return res.status(code === 'BUSY' ? 409 : 200).json({ ok: false, error: String((e && e.message) || 'Lab error').slice(0, 400), code: code || null }); }
}
app.get('/api/lab/status', requireAuth, (req, res) => labCall(res, 'status'));
app.post('/api/lab/ask', requireAuth, (req, res) => {
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : ''; const k = Number.isInteger(req.body.k) ? Math.min(10, Math.max(1, req.body.k)) : 6;
  if (prompt.length < 8 || prompt.length > 1500) return res.status(400).json({ ok: false, error: 'Write between 8 and 1500 characters about what you want tested.' });
  return labCall(res, 'ask', { prompt, k });
});
app.post('/api/lab/validate', requireAuth, (req, res) => labCall(res, 'validate'));
app.post('/api/lab/vault', requireAuth, (req, res) => (req.body && req.body.confirm === true ? labCall(res, 'vault', { confirm: true }) : res.status(400).json({ ok: false, error: 'Opening the vault needs confirm: true.' })));

app.get('/api/_monitor', requireAuth, (req, res) => res.json({
  optionsEngineVersion: OPTIONS_ENGINE_VERSION, v2Version: V2_VERSION, primary: PROMOTION.primary,
  optionsProvider: optionsProviderStatus(process.env), uw: UW_LIMITER.stats(),
  ai: { enabled: AI.cfg.enabled, configured: AI.client.available, model: AI.cfg.model },
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

export const httpServer = app.listen(CONFIG.PORT, () => {
  console.log(`\n  Options Signal Engine → http://localhost:${CONFIG.PORT}`);
  console.log('  Options data: Unusual Whales only');
  console.log('  Auth: configured\n');
});
