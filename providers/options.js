// @ts-check
/*
 * providers/options.js — options/stock provider selection.
 * Unusual Whales is the only data source. NullOptionsProvider is the honest fallback when no
 * provider/token is configured: it reports why, and never fabricates data.
 */
import { UnusualWhalesOptionsProvider } from './unusualwhales.js';

export class NullOptionsProvider {
  constructor(reason = 'No options provider configured (set OPTIONS_PROVIDER=uw + UNUSUAL_WHALES_API_TOKEN)') { this.name = 'null'; this.reason = reason; }
  async getChain(ticker) { return { available: false, error: this.reason, chain: { ticker, asOf: new Date().toISOString(), underlying: { available: false }, contracts: [], fieldsAvailable: { chain: false }, flow: { available: false, largeTrades: [] } } }; }
  async getUnderlying() { return { available: false, error: this.reason }; }
}

/** Build the options provider from env. Supported: uw | null. */
export function makeOptionsProvider(env = {}, { limiter = null } = {}) {
  const name = (env.OPTIONS_PROVIDER || 'null').toLowerCase();
  const baseUrl = env.OPTIONS_BASE_URL;
  const token = env.UNUSUAL_WHALES_API_TOKEN;
  if (name === 'uw') {
    return token ? new UnusualWhalesOptionsProvider({ apiKey: token, baseUrl, limiter })
      : new NullOptionsProvider('OPTIONS_PROVIDER=uw set but UNUSUAL_WHALES_API_TOKEN is missing from .env');
  }
  if (name === 'null') return new NullOptionsProvider('OPTIONS_PROVIDER is not set. Add OPTIONS_PROVIDER=uw and UNUSUAL_WHALES_API_TOKEN=<your UW token> to .env, then restart.');
  return new NullOptionsProvider(`Unknown OPTIONS_PROVIDER='${name}' (only 'uw' is supported).`);
}

// Never expose a full credential anywhere (UI, logs, errors, API responses).
export function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const last4 = key.slice(-4);
  return `${'*'.repeat(8)}${last4}`;
}

export function optionsProviderStatus(env = {}) {
  const name = (env.OPTIONS_PROVIDER || 'null').toLowerCase();
  const base = name === 'uw' ? 'https://api.unusualwhales.com' : null;
  const key = env.UNUSUAL_WHALES_API_TOKEN || null;
  const configured = name === 'uw' && !!key;
  let reason = null;
  if (!configured) {
    if (name === 'uw') reason = 'UNUSUAL_WHALES_API_TOKEN missing from .env';
    else if (name === 'null') reason = 'OPTIONS_PROVIDER not set in .env';
    else reason = `unknown OPTIONS_PROVIDER='${name}'`;
  }
  return { provider: name, configured, baseUrl: env.OPTIONS_BASE_URL || base, keyMasked: maskKey(key), reason };
}
