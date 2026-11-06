// research/lab-llm.js — asks an LLM (via OpenRouter) to PROPOSE ideas as JSON expressions for research/lab.js.
// The model receives: the expression language, column descriptions, and EXPLORE-block results (counts, threshold, best ideas).
// It receives no raw data and never sees validate/vault results. Its output is parsed and validated against the whitelist;
// anything that does not validate is dropped. The API key is read from the environment and never logged or written.
import { OPS, COLUMN_DOC, LIMITS, validateSpec, HORIZONS } from './lab.js';

export function systemPrompt() {
  const ops = Object.entries(OPS).map(([k, o]) => `  ${k}${o.p ? ` (needs "p": ${o.p === 'win' ? 'integer window 2..' + LIMITS.maxWin : o.p === 'lag' ? 'integer 1..' + LIMITS.maxLag : '[lo,hi]'})` : ''} — ${o.arity} arg(s): ${o.doc}`).join('\n');
  const cols = Object.entries(COLUMN_DOC).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return `You are a quantitative research assistant for a US-equity options-flow study (S&P 500 stocks, daily data).
Each idea is a JSON "spec" describing a signal; our code evaluates it. You never run code and never see raw data.

GOAL: propose signals whose value on day D predicts the cross-section of stock returns from the close of D to the close of D+horizon (higher value => higher future return; choose the sign yourself).

OUTPUT: ONLY a JSON object {"specs":[ ... ]}, no prose. Each spec:
  {"name": "short label", "hypothesis": "ONE sentence of economic reasoning", "horizon": 1|3|5,
   "expr": <node>, "filter": <node, optional: only rows where it evaluates to 1 are used>}
A node is {"col":"name"} | {"const": number} | {"op":"name","args":[nodes], "p": parameter if the op needs one}.
Limits: depth <= ${LIMITS.maxDepth}, nodes <= ${LIMITS.maxNodes}. Horizons allowed: ${HORIZONS.join(', ')}.

OPERATIONS:
${ops}

COLUMNS (flow columns are missing on days with no alerts; wrap with nz(...) when "no alerts" should mean zero):
${cols}

RULES:
- Every idea you propose costs statistical power: the significance threshold rises with the number of ideas tried. Prefer few, economically motivated, simple ideas over many random combinations.
- Do not repeat ideas already in the history. Vary the mechanism (opening vs closing, size, expiry, delta, earnings timing, interaction with price moves, normalisation).
- Known fact from earlier work: yesterday's return (mom1) strongly predicts a next-day reversal; judge flow ideas by their "IC ex-mom1" too.
- Ideas are checked later on data you will never see; do not try to tune to the numbers you are shown.`;
}
export function parseSpecs(content) {
  let t = String(content || '').trim(); const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) t = m[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) t = t.slice(a, b + 1);
  let j; try { j = JSON.parse(t); } catch { throw new Error('model reply was not valid JSON'); }
  const arr = Array.isArray(j) ? j : Array.isArray(j.specs) ? j.specs : null; if (!arr) throw new Error('model reply had no "specs" array'); return arr;
}
export async function proposeSpecs({ apiKey, model, history, k = 8, fetchImpl = fetch, base = 'https://openrouter.ai/api/v1', timeoutMs = 90000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const body = { model, temperature: 0.8, max_tokens: 3500, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: `${history}\n\nPropose up to ${k} NEW specs now.` }] };
  let res, err;
  for (let a = 0; a < 3; a++) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs);
    try { res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', signal: ac.signal, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'options-desk-lab' }, body: JSON.stringify(body) }); }
    catch { err = 'network error or timeout'; res = null; } finally { clearTimeout(to); }
    if (res && res.status !== 429 && res.status < 500) break; if (res) err = `HTTP ${res.status}`; await sleep(2000 * (a + 1));
  }
  if (!res || !res.ok) throw new Error(`OpenRouter request failed (${res ? `HTTP ${res.status}` : err})`);
  const j = await res.json(); const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const raw = parseSpecs(content); const specs = [], rejected = [];
  for (const r of raw.slice(0, k + 5)) { try { specs.push(validateSpec(r)); } catch (e) { rejected.push({ name: r && r.name, reason: e.message }); } }
  return { specs: specs.slice(0, k), rejected, usage: j.usage || null, model: j.model || model };
}
