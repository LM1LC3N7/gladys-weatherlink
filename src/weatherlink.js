// -----------------------------------------------------------------------------
// The two ways to read a Davis station, read only, and their error kinds:
//
//   cloud  GET https://api.weatherlink.com/v2/stations?api-key=...
//          GET https://api.weatherlink.com/v2/current/{station_id}?api-key=...
//          (the API secret in the `X-Api-Secret` header, as the official
//          "Authentication" page asks, never in the URL)
//   local  GET http://<address>/v1/current_conditions
//          (the documented local API of the WeatherLink Live and the AirLink)
//
// Only these GET routes exist here: nothing is ever written to a station or
// to the account (the local `/v1/real_time` UDP broadcast is not used).
// -----------------------------------------------------------------------------

import { CLOUD_URL, LOCAL_PATH, MAX_SENSORS, MAX_STATIONS } from './constants.js';
import { NetworkError, getText } from './http.js';

/**
 * kind: refused (401/403 on the account), denied (no access to one station),
 * limited (429), busy (5xx), invalid (not a WeatherLink answer), failed
 * (network, another status).
 */
export class SourceError extends Error {
  constructor(kind, detail = '', { retryAfterMs, status } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'SourceError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('invalid', 'not JSON');
  }
}

/** An HTTP status that is not 2xx -> its SourceError (`account`: 401/403 = keys refused). */
function statusError(response, { account }) {
  const { status, retryAfterMs } = response;
  if (status === 429) {
    return new SourceError('limited', 'HTTP 429', { retryAfterMs, status });
  }
  if (status >= 500) {
    return new SourceError('busy', `HTTP ${status}`, { retryAfterMs, status });
  }
  if (status === 401 || (account && status === 403)) {
    return new SourceError('refused', `HTTP ${status}`, { status });
  }
  if (status === 403 || status === 404) {
    return new SourceError('denied', `HTTP ${status}`, { status });
  }
  return new SourceError('failed', `HTTP ${status}`, { status });
}

async function get(url, options, { account = false } = {}) {
  let response;
  try {
    response = await getText(url, options);
  } catch (err) {
    throw new SourceError('failed', err instanceof NetworkError ? err.message : 'network failed');
  }
  if (response.status < 200 || response.status > 299) {
    throw statusError(response, { account });
  }
  return parseJson(response.text);
}

// --- Cloud: API v2 ---------------------------------------------------------------

const cloudUrl = (path, apiKey) => `${CLOUD_URL}/${path}?api-key=${encodeURIComponent(apiKey)}`;

const cloudOptions = (apiSecret) => ({ headers: { 'X-Api-Secret': apiSecret } });

/** A station id of the API: a positive integer. */
export const stationIdOf = (value) =>
  Number.isSafeInteger(value) && value > 0
    ? value
    : typeof value === 'string' && /^\d{1,12}$/.test(value) && Number(value) > 0
      ? Number(value)
      : null;

/**
 * The stations of the account: [{ id, name }], sorted by id, at most
 * MAX_STATIONS (`more` tells how many were left out). Nothing else is kept
 * (the answer also holds the e-mail address and the position of the owner).
 */
export async function cloudStations({ apiKey, apiSecret }) {
  const body = await get(cloudUrl('stations', apiKey), cloudOptions(apiSecret), { account: true });
  if (!isObject(body) || !Array.isArray(body.stations)) {
    throw new SourceError('invalid', 'no station list');
  }
  const seen = new Set();
  const stations = [];
  for (const raw of body.stations.slice(0, 1000)) {
    const id = isObject(raw) ? stationIdOf(raw.station_id) : null;
    if (id === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    stations.push({ id, name: cleanText(raw.station_name, 60) || `WeatherLink ${id}` });
  }
  stations.sort((a, b) => a.id - b.id);
  return {
    stations: stations.slice(0, MAX_STATIONS),
    more: Math.max(0, stations.length - MAX_STATIONS),
  };
}

/**
 * The current conditions of one station: { stationId, records }, records
 * being [{ lsid, ts, data }] (ts in ms, null when absent). The answer must
 * name the station asked for.
 */
export async function cloudCurrent({ apiKey, apiSecret }, stationId) {
  const body = await get(cloudUrl(`current/${stationId}`, apiKey), cloudOptions(apiSecret));
  if (!isObject(body) || !Array.isArray(body.sensors)) {
    throw new SourceError('invalid', 'no sensor list');
  }
  const answered = stationIdOf(body.station_id);
  if (answered === null) {
    throw new SourceError('invalid', 'no station id');
  }
  if (answered !== stationId) {
    throw new SourceError('invalid', 'another station answered');
  }
  const generated = Number.isFinite(body.generated_at) ? body.generated_at * 1000 : null;
  const records = [];
  for (const sensor of body.sensors.slice(0, MAX_SENSORS)) {
    if (!isObject(sensor) || !Array.isArray(sensor.data) || !isObject(sensor.data[0])) {
      continue;
    }
    const data = sensor.data[0];
    // The instant the console last heard the transmitter, when given
    // (structure 23): the values of a lost transmitter age, never stay fresh.
    const packet = data.last_packet_received_timestamp;
    const ts = Number.isFinite(packet)
      ? packet * 1000
      : Number.isFinite(data.ts)
        ? data.ts * 1000
        : generated;
    records.push({ lsid: lsidOf(sensor.lsid), ts, data });
  }
  return { stationId, records };
}

// --- Local: WeatherLink Live and AirLink -------------------------------------------

/** A logical sensor id: a positive integer, else null. */
export const lsidOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

/** The serial number of a local device ("001D0A7139D6") -> "001d0a7139d6", or null. */
export const didOf = (value) => {
  const did = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{6,32}$/.test(did) ? did : null;
};

/**
 * The current conditions of a WeatherLink Live or an AirLink: { did, name,
 * records }. Each answer carries the serial number of the device: it is
 * what the values are published under, so another device that took the
 * address (DHCP) never publishes under the first one. An answer without a
 * readable serial number is refused (never taken as "another device").
 */
export async function localCurrent(address) {
  const body = await get(`http://${address}${LOCAL_PATH}`, {});
  if (!isObject(body)) {
    throw new SourceError('invalid', 'not an object');
  }
  if (body.error) {
    const code = Number.isSafeInteger(body.error?.code) ? body.error.code : '?';
    throw new SourceError('failed', `device error ${code}`);
  }
  const data = body.data;
  if (!isObject(data) || !Array.isArray(data.conditions)) {
    throw new SourceError('invalid', 'no conditions');
  }
  const did = didOf(data.did);
  if (!did) {
    throw new SourceError('invalid', 'no serial number');
  }
  const records = [];
  for (const condition of data.conditions.slice(0, MAX_SENSORS)) {
    if (isObject(condition)) {
      // The local `ts` may count from the boot of the device (time not yet
      // synchronized): the values are current, the read time is used.
      records.push({ lsid: lsidOf(condition.lsid), ts: null, data: condition });
    }
  }
  return { did, name: cleanText(data.name, 60), records };
}
