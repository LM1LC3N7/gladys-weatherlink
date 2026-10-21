// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { MAX_LOCAL, SOURCES } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  source: 'cloud',
  poll_interval: 5,
};

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,62})$/;

/**
 * The address of a WeatherLink Live or an AirLink as the user may type it:
 * an IPv4 address or a host name, with an optional port. A leading
 * `http://` and a trailing `/` are tolerated; anything else (a path,
 * credentials, IPv6) is refused. Returns the `host[:port]`, or null.
 */
export function parseAddress(text) {
  let value = clean(text)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!value) {
    return null;
  }
  let port = '';
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    port = value.slice(colon + 1);
    value = value.slice(0, colon);
    const n = Number(port);
    if (!/^\d{1,5}$/.test(port) || n < 1 || n > 65535) {
      return null;
    }
    port = n === 80 ? '' : `:${n}`;
  }
  if (value.length > 253) {
    return null;
  }
  const labels = value.split('.');
  const ok = IPV4.test(value) || (!/^[\d.]+$/.test(value) && labels.every((l) => LABEL.test(l)));
  return ok ? `${value}${port}` : null;
}

/**
 * `source` cloud: the API key and secret of the account (v2). `source`
 * local: up to three addresses (`local_<n>_address`). A bad or repeated
 * address is reported by its number only.
 */
export function normalizeConfig(raw = {}) {
  const source = SOURCES.includes(raw.source) ? raw.source : DEFAULT_CONFIG.source;
  const addresses = [];
  const invalid = [];
  const seen = new Set();
  for (let n = 1; n <= MAX_LOCAL; n += 1) {
    const text = clean(raw[`local_${n}_address`]);
    if (!text) {
      continue;
    }
    const address = parseAddress(text);
    if (!address) {
      invalid.push({ slot: n, why: 'address' });
    } else if (seen.has(address)) {
      invalid.push({ slot: n, why: 'duplicate' });
    } else {
      seen.add(address);
      addresses.push({ slot: n, address });
    }
  }
  return {
    source,
    apiKey: clean(raw.api_key),
    // The secret is kept as typed (only the spaces around it are dropped).
    apiSecret: clean(raw.api_secret),
    addresses: source === 'local' ? addresses : [],
    invalid: source === 'local' ? invalid : [],
    pollMinutes: number(raw.poll_interval, DEFAULT_CONFIG.poll_interval, 1, 60),
  };
}

/** Both the key and the secret are needed for the cloud. */
export const hasCloud = (config) =>
  config.source === 'cloud' && Boolean(config.apiKey && config.apiSecret);
