// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL), WeatherLink answers (cloud API v2 and
// WeatherLink Live / AirLink local API, after the examples of the official
// docs, astrandb/weatherlink and siku2/hass-weatherlink) and timers (nothing
// fires by itself). No test touches the network nor the disk.
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const API_KEY = 'wlkey-0123456789abcdef';
export const API_SECRET = 'wlsecret-Very-Private-42';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** GET /v2/stations (the owner's e-mail and position are in the real answer). */
export const STATIONS = {
  stations: [
    {
      station_id: 167531,
      station_id_uuid: '03e7585a-4f29-4e7c-b6cb-d9e17313b07c',
      station_name: 'Jardin',
      gateway_id_hex: '001d0ac00dfb',
      user_email: 'owner@example.com',
      latitude: 48.85,
      longitude: 2.35,
      subscription_type: 'Pro',
    },
  ],
  generated_at: 1760983200,
};

/** GET /v2/current/167531, at `ts` (seconds). */
export const current = (ts, { stationId = 167531, temp = 50 } = {}) => ({
  station_id: stationId,
  station_id_uuid: '03e7585a-4f29-4e7c-b6cb-d9e17313b07c',
  generated_at: ts,
  sensors: [
    {
      lsid: 650441,
      sensor_type: 365,
      data_structure_type: 21,
      data: [{ ts, temp_in: 70.5, hum_in: 36.1, dew_point_in: 42.3 }],
    },
    {
      lsid: 650440,
      sensor_type: 242,
      data_structure_type: 19,
      data: [{ ts, bar_sea_level: 30.181, bar_absolute: 30.174, bar_trend: -0.047 }],
    },
    {
      lsid: 650442,
      sensor_type: 37,
      data_structure_type: 23,
      data: [
        {
          ts,
          tx_id: 1,
          temp,
          hum: 81.2,
          dew_point: 44.6,
          wind_speed_last: 10,
          wind_dir_last: 263,
          wind_speed_avg_last_10_min: 2.1,
          wind_speed_hi_last_10_min: 9.06,
          rain_rate_last_mm: 1.2,
          rain_rate_last_in: 0.047,
          rainfall_day_mm: 3.4,
          rainfall_day_in: 0.134,
          rainfall_last_24_hr_mm: 5.2,
          solar_rad: 400,
          uv_index: 2.6,
          trans_battery_flag: 0,
        },
      ],
    },
    {
      lsid: 650439,
      sensor_type: 509,
      data_structure_type: 27,
      data: [{ ts, battery_percent: 100, wifi_rssi: -55, ip_v4_address: '192.168.0.65' }],
    },
  ],
});

/** GET http://<WeatherLink Live>/v1/current_conditions (official docs example). */
export const live = ({ did = '001D0A7139D6', temp = 62.7 } = {}) => ({
  data: {
    did,
    ts: 1531754005,
    conditions: [
      {
        lsid: 48308,
        data_structure_type: 1,
        txid: 1,
        temp,
        hum: 1.1,
        dew_point: -0.3,
        wind_speed_last: 2,
        wind_dir_last: 0,
        wind_speed_avg_last_10_min: 1.78,
        wind_speed_hi_last_10_min: 4,
        rain_size: 2,
        rain_rate_last: 3,
        rainfall_daily: 63,
        rainfall_last_24_hr: 70,
        solar_rad: 747,
        uv_index: 5.5,
        trans_battery_flag: 0,
      },
      {
        lsid: 3187671188,
        data_structure_type: 2,
        txid: 3,
        temp_1: 70,
        temp_2: null,
        moist_soil_1: 1,
        trans_battery_flag: 1,
      },
      { lsid: 48307, data_structure_type: 4, temp_in: 78, hum_in: 41.1, dew_point_in: 7.8 },
      {
        lsid: 48306,
        data_structure_type: 3,
        bar_sea_level: 30.008,
        bar_trend: null,
        bar_absolute: 29.762,
      },
    ],
  },
  error: null,
});

/** An AirLink answer of the local API. */
export const airlink = ({ did = '001D0A100021' } = {}) => ({
  data: {
    did,
    name: 'Balcon',
    ts: 1760983200,
    conditions: [
      {
        lsid: 347825,
        data_structure_type: 6,
        temp: 68,
        hum: 55,
        pm_1: 3,
        pm_2p5: 8.25,
        pm_10: 12.5,
      },
    ],
  },
  error: null,
});

/** Install a fake fetch; `routes` is a list of [RegExp, handler(call)]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    intervals: () => [...pending.values()].filter((t) => t.kind === 'interval'),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
  };
}

/** A logger that keeps every line, to check that no secret reaches it. */
export function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => String(a?.message ?? a)).join(' ')}`);
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}
