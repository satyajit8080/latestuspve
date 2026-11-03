// Minimal .env parser (no dependency). Pure so it can be unit-tested.
// Rules: `KEY=value`; surrounding quotes are honoured (a `#` inside quotes is kept);
// for UNQUOTED values an inline comment (whitespace + `#...`) is stripped and the value trimmed.
// A line like `OPENROUTER_API_KEY= # sk-or-...` therefore yields an EMPTY value, not a fake key.
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/(^|\s)#.*$/, '').trim();
    }
    out[m[1]] = v;
  }
  return out;
}

// Load a .env file into process.env without overriding variables that are already set.
export function loadEnvFile(file, env = process.env, fs) {
  try {
    if (!fs.existsSync(file)) return;
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
  } catch { /* ignore */ }
}
