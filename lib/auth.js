// Auth helpers: startup secret validation and per-IP login throttling. Pure / injectable clock.
export const MIN_PASSWORD_LEN = 16;
export const MIN_SECRET_LEN = 32;

// Returns { password, sessionSecret } or throws Error with a message safe to print (no secret values).
export function resolveSecrets(env) {
  const test = env.NODE_ENV === 'test';
  const password = env.DASHBOARD_PASSWORD || '';
  if (!password) throw new Error('DASHBOARD_PASSWORD is not set. Add a random secret of at least ' + MIN_PASSWORD_LEN + ' characters to .env.');
  if (!test && password.length < MIN_PASSWORD_LEN) throw new Error('DASHBOARD_PASSWORD must be at least ' + MIN_PASSWORD_LEN + ' characters.');
  let sessionSecret = env.SESSION_SECRET || '';
  if (!sessionSecret) {
    if (!test) throw new Error('SESSION_SECRET is not set. Add a random secret of at least ' + MIN_SECRET_LEN + ' characters to .env (rotate it to log everyone out).');
    sessionSecret = 'test-session-secret-' + Math.random().toString(36).slice(2);
  } else if (!test && sessionSecret.length < MIN_SECRET_LEN) {
    throw new Error('SESSION_SECRET must be at least ' + MIN_SECRET_LEN + ' characters.');
  }
  return { password, sessionSecret };
}

// Failed-login throttle per IP: `limit` failures inside `windowMs` triggers a lockout that doubles
// with every consecutive lockout (baseLockMs * 2^(strikes-1), capped). A success clears the record.
export class LoginThrottle {
  constructor({ limit = 5, windowMs = 60000, baseLockMs = 60000, maxLockMs = 3600000, now = () => Date.now() } = {}) {
    Object.assign(this, { limit, windowMs, baseLockMs, maxLockMs, now }); this.byIp = new Map();
  }
  check(ip) {
    const r = this.byIp.get(ip); const t = this.now();
    if (r && r.lockedUntil > t) return { ok: false, retryAfterMs: r.lockedUntil - t };
    return { ok: true };
  }
  fail(ip) {
    const t = this.now(); let r = this.byIp.get(ip);
    if (!r) { r = { fails: [], strikes: 0, lockedUntil: 0 }; this.byIp.set(ip, r); }
    r.fails = r.fails.filter((x) => t - x < this.windowMs); r.fails.push(t);
    if (r.fails.length >= this.limit) {
      r.strikes++; r.fails = [];
      r.lockedUntil = t + Math.min(this.maxLockMs, this.baseLockMs * 2 ** (r.strikes - 1));
    }
    if (this.byIp.size > 5000) for (const [k, v] of this.byIp) if (v.lockedUntil < t && !v.fails.length) this.byIp.delete(k);
  }
  success(ip) { this.byIp.delete(ip); }
}
