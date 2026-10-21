// -----------------------------------------------------------------------------
// What a Davis station measures, and how it lands in Gladys. Pure: no clock,
// no network.
//
// The field names are those of the WeatherLink API v2 ("Sensor Catalog" data
// structures, as astrandb/weatherlink reads them) and of the WeatherLink Live
// local API (as siku2/hass-weatherlink reads them). Both send imperial values
// (°F, mph, inHg, rain in inches or in bucket counts): they are converted
// here, once, to the units the Gladys core lists for each category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js).
//
// A record (one logical sensor) gives one Gladys device, by its kind:
//   outdoor   the ISS / Vantage Vue / Vantage Pro2 transmitter (and the extra
//             sensors a Vantage Pro2 logger reports with it)
//   airlink   an AirLink air quality sensor
//   soil      a soil / leaf station (its soil temperatures)
// and the console values (inside temperature and humidity, barometer) of
// every record of a station go to one "console" device.
//
// The feature key is a name of this integration (`temperature`,
// `rain_today`...), never a WeatherLink field name: it is part of the
// external id, so it never changes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A finite number, or null (never NaN, never undefined). */
export const num = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** An own field of a record as a number (never a field of its prototype). */
const own = (record, key) => (Object.hasOwn(record, key) ? num(record[key]) : null);

/** The first of `keys` the record holds a number for. */
const first = (record, ...keys) => {
  for (const key of keys) {
    const value = own(record, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
};

const map = (value, fn) => (value === null ? null : fn(value));

export const fahrenheitToCelsius = (f) => ((f - 32) * 5) / 9;
export const mphToKmh = (mph) => mph * 1.609344;
export const inHgToHpa = (inHg) => inHg * 33.8639;
const MM_PER_INCH = 25.4;

/** `rain_size` of the local API: the volume of one bucket tip, in mm. */
export const COLLECTOR_MM = { 1: 0.254, 2: 0.2, 3: 0.1, 4: 0.0254 };

/**
 * A rain amount in mm. Cloud: `<base>_mm`, else `<base>_in` × 25.4. Local:
 * bucket counts × the collector size (`rain_size`); unknown size: none.
 */
function rain(record, ctx, cloudBases, localKeys) {
  if (ctx.local) {
    const size = COLLECTOR_MM[own(record, 'rain_size')];
    const counts = first(record, ...localKeys);
    return size === undefined || counts === null ? null : counts * size;
  }
  for (const base of cloudBases) {
    const mm = own(record, `${base}_mm`);
    if (mm !== null) {
      return mm;
    }
    const inches = own(record, `${base}_in`);
    if (inches !== null) {
      return inches * MM_PER_INCH;
    }
  }
  return null;
}

// --- Kinds: Gladys category, type, unit, bounds, rounding ---------------------------
// Only the units the core lists for the category. The core lists no unit for
// `angle-sensor` and `battery-low`: the wind direction keeps its own
// `degree` unit (as the approved Ambient Weather module), the battery flag
// has none.

const KINDS = {
  temperature: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -60,
    max: 70,
    convert: (v) => round(v, 1),
  },
  // A probe (in the ground, in water...): kept out of the room temperature
  // average of Gladys.
  probe: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.TEMPERATURE_SENSOR.PROBE,
    unit: UNITS.CELSIUS,
    min: -60,
    max: 80,
    convert: (v) => round(v, 1),
  },
  humidity: {
    category: CAT.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (v) => round(v, 1),
  },
  pressure: {
    category: CAT.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.HECTO_PASCAL,
    min: 500,
    max: 1100,
    convert: (v) => round(v, 1),
  },
  wind: {
    category: CAT.SPEED_SENSOR,
    type: TYPES.SPEED_SENSOR.DECIMAL,
    unit: UNITS.KILOMETER_PER_HOUR,
    min: 0,
    max: 400,
    convert: (v) => round(v, 1),
  },
  direction: {
    category: CAT.ANGLE_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.DEGREE,
    min: 0,
    max: 360,
    convert: (v) => Math.round(v),
  },
  rainRate: {
    category: CAT.PRECIPITATION_SENSOR,
    type: TYPES.PRECIPITATION_SENSOR.DECIMAL,
    unit: UNITS.MILLIMETER_PER_HOUR,
    min: 0,
    max: 2000,
    convert: (v) => round(v, 1),
  },
  // Rain since midnight, rain of the last 24 hours: daily amounts, in the
  // one daily unit the core lists for the category.
  rainDay: {
    category: CAT.PRECIPITATION_SENSOR,
    type: TYPES.PRECIPITATION_SENSOR.DECIMAL,
    unit: UNITS.MILLIMETER_PER_DAY,
    min: 0,
    max: 2000,
    convert: (v) => round(v, 1),
  },
  uv: {
    category: CAT.UV_SENSOR,
    type: TYPES.UV_SENSOR.INTEGER,
    unit: UNITS.UV_INDEX,
    min: 0,
    max: 20,
    convert: (v) => Math.round(v),
  },
  // The core has no W/m² unit: the solar radiation is shown in lux, with the
  // usual daylight approximation (1 W/m² ≈ 126.6 lx, 1/0.0079), as the
  // approved Ambient Weather module does.
  solar: {
    category: CAT.LIGHT_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.LUX,
    min: 0,
    max: 250_000,
    convert: (v) => Math.round(v / 0.0079),
  },
  // WeatherLink: 1 = low, 0 = OK; Gladys: 1 = low.
  batteryLow: {
    category: CAT.BATTERY_LOW,
    type: TYPES.BATTERY_LOW.BINARY,
    min: 0,
    max: 1,
    convert: (v) => v,
  },
  pm25: {
    category: CAT.PM25_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.MICROGRAM_PER_CUBIC_METER,
    min: 0,
    max: 2000,
    convert: (v) => round(v, 1),
  },
  pm10: {
    category: CAT.PM10_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.MICROGRAM_PER_CUBIC_METER,
    min: 0,
    max: 2000,
    convert: (v) => round(v, 1),
  },
  aqi: {
    category: CAT.AIRQUALITY_SENSOR,
    type: TYPES.AIRQUALITY_SENSOR.AQI,
    unit: UNITS.AQI,
    min: 0,
    max: 500,
    convert: (v) => Math.round(v),
  },
};

const tempOf =
  (...keys) =>
  (r) =>
    map(first(r, ...keys), fahrenheitToCelsius);
const windOf =
  (...keys) =>
  (r) =>
    map(first(r, ...keys), mphToKmh);
const flagOf = (key) => (r) => {
  const v = own(r, key);
  return v === 0 || v === 1 ? v : null;
};

/** [feature key, kind, feature name, read(record, ctx)]: the order of the features in Gladys. */
const OUTDOOR = [
  ['temperature', 'temperature', 'Temperature', tempOf('temp', 'temp_out')],
  ['humidity', 'humidity', 'Humidity', (r) => first(r, 'hum', 'hum_out')],
  ['wind_speed', 'wind', 'Wind speed', windOf('wind_speed_last', 'wind_speed')],
  [
    'wind_speed_avg_10min',
    'wind',
    'Wind speed (10 min average)',
    windOf('wind_speed_avg_last_10_min', 'wind_speed_10_min_avg'),
  ],
  [
    'wind_gust_10min',
    'wind',
    'Wind gust (10 min)',
    windOf('wind_speed_hi_last_10_min', 'wind_gust_10_min'),
  ],
  ['wind_direction', 'direction', 'Wind direction', (r) => first(r, 'wind_dir_last', 'wind_dir')],
  [
    'rain_rate',
    'rainRate',
    'Rain rate',
    (r, ctx) => rain(r, ctx, ['rain_rate_last', 'rain_rate'], ['rain_rate_last']),
  ],
  [
    'rain_today',
    'rainDay',
    'Rain today',
    (r, ctx) => rain(r, ctx, ['rainfall_day', 'rainfall_daily', 'rain_day'], ['rainfall_daily']),
  ],
  [
    'rain_24h',
    'rainDay',
    'Rain (last 24 h)',
    (r, ctx) => rain(r, ctx, ['rainfall_last_24_hr'], ['rainfall_last_24_hr', 'rain_24_hr']),
  ],
  ['solar_radiation', 'solar', 'Solar radiation', (r) => first(r, 'solar_rad')],
  ['uv_index', 'uv', 'UV index', (r) => first(r, 'uv_index', 'uv')],
  ['battery_low', 'batteryLow', 'Battery low (transmitter)', flagOf('trans_battery_flag')],
  // The extra sensors a Vantage Pro2 logger reports in the same record. An
  // extra temperature is often a probe (pool, greenhouse, water tank): a
  // `probe`, kept out of the room temperature average of Gladys.
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => [
    `extra_temperature_${n}`,
    'probe',
    `Extra temperature ${n}`,
    tempOf(`temp_extra_${n}`),
  ]),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => [
    `extra_humidity_${n}`,
    'humidity',
    `Extra humidity ${n}`,
    (r) => first(r, `hum_extra_${n}`),
  ]),
  ...[1, 2, 3, 4].map((n) => [
    `soil_temperature_${n}`,
    'probe',
    `Soil temperature ${n}`,
    tempOf(`temp_soil_${n}`),
  ]),
];

const AIRLINK = [
  ['temperature', 'temperature', 'Temperature', tempOf('temp')],
  ['humidity', 'humidity', 'Humidity', (r) => first(r, 'hum')],
  ['pm25', 'pm25', 'PM2.5', (r) => first(r, 'pm_2p5', 'pm_2p5_last')],
  ['pm10', 'pm10', 'PM10', (r) => first(r, 'pm_10', 'pm_10_last')],
  ['aqi', 'aqi', 'Air quality index', (r) => first(r, 'aqi_val')],
];

const SOIL = [
  ...[1, 2, 3, 4].map((n) => [
    `soil_temperature_${n}`,
    'probe',
    `Soil temperature ${n}`,
    tempOf(`temp_${n}`),
  ]),
  ['battery_low', 'batteryLow', 'Battery low (transmitter)', flagOf('trans_battery_flag')],
];

const CONSOLE = [
  ['indoor_temperature', 'temperature', 'Inside temperature', tempOf('temp_in')],
  ['indoor_humidity', 'humidity', 'Inside humidity', (r) => first(r, 'hum_in')],
  [
    'pressure',
    'pressure',
    'Pressure (sea level)',
    (r) => map(first(r, 'bar_sea_level', 'bar'), inHgToHpa),
  ],
  [
    'pressure_absolute',
    'pressure',
    'Pressure (absolute)',
    (r) => map(first(r, 'bar_absolute'), inHgToHpa),
  ],
];

export const TABLES = { outdoor: OUTDOOR, airlink: AIRLINK, soil: SOIL, console: CONSOLE };

export const KIND_LABELS = {
  outdoor: 'outdoor sensors',
  airlink: 'AirLink',
  soil: 'soil sensors',
  console: 'console',
};

/**
 * The fields only an outdoor transmitter (ISS, Vantage Pro2 / Vue logger)
 * record holds. A Vantage Pro2 record of data structure 2 always carries
 * the soil and leaf keys too (null without such sensors): it stays outdoor.
 */
const ISS_MARKERS = [
  'temp_out',
  'hum_out',
  'temp',
  'wind_speed',
  'wind_speed_last',
  'rain_size',
  'bar',
];

/** The kind of a record, from the fields it holds (never from a type number alone). */
export function kindOf(record) {
  if (Object.hasOwn(record, 'pm_2p5') || Object.hasOwn(record, 'pm_10')) {
    return 'airlink';
  }
  if (ISS_MARKERS.some((key) => Object.hasOwn(record, key))) {
    return 'outdoor';
  }
  if (
    Object.hasOwn(record, 'moist_soil_1') ||
    Object.hasOwn(record, 'temp_1') ||
    Object.hasOwn(record, 'wet_leaf_1')
  ) {
    return 'soil';
  }
  return 'outdoor';
}

/** The usable values of a table for a record: converted, rounded, within the bounds. */
function valuesFrom(table, record, ctx) {
  const values = {};
  for (const [key, kindName, , read] of table) {
    const raw = read(record, ctx);
    if (raw === null || !Number.isFinite(raw)) {
      continue;
    }
    const kind = KINDS[kindName];
    const value = kind.convert(raw);
    // A value out of the bounds is left out, never clamped into a false reading.
    if (Number.isFinite(value) && value >= kind.min && value <= kind.max) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * The records of a station -> its groups: Map(group key -> { kind, txid,
 * values, at }). A group key is `s<lsid>` (`c` for the console). A record
 * without any usable value (a transmitter out of range) gives no group; a
 * reading older than `staleBefore` neither.
 */
export function groupsOf(records, { local = false, now, staleBefore = -Infinity }) {
  const groups = new Map();
  const consoleValues = new Map();
  let consoleAt = -Infinity;
  for (const [index, { lsid, ts, data }] of records.entries()) {
    const at = ts === null || ts === undefined ? now : Math.min(ts, now);
    if (!(at >= staleBefore)) {
      continue;
    }
    // Local: a transmitter the WeatherLink Live is searching for (rx_state 2,
    // lost) may still carry its last values: never published as current.
    if (local && own(data, 'rx_state') === 2) {
      continue;
    }
    const ctx = { local };
    const kind = kindOf(data);
    const values = valuesFrom(TABLES[kind], data, ctx);
    const key = lsid === null ? `i${index}` : `s${lsid}`;
    if (Object.keys(values).length > 0 && lsid !== null) {
      const txid = first(data, 'txid', 'tx_id');
      groups.set(key, { kind, txid: txid !== null && txid > 1 ? txid : null, values, at });
    }
    // A console value given by several records (a Vantage Pro2 logger record
    // and a barometer record): the most recent one.
    for (const [field, value] of Object.entries(valuesFrom(CONSOLE, data, ctx))) {
      if (!consoleValues.has(field) || at > consoleValues.get(field).at) {
        consoleValues.set(field, { value, at });
      }
      consoleAt = Math.max(consoleAt, at);
    }
  }
  if (consoleValues.size > 0) {
    const values = Object.fromEntries([...consoleValues].map(([field, v]) => [field, v.value]));
    groups.set('c', { kind: 'console', txid: null, values, at: consoleAt });
  }
  return groups;
}

// --- Gladys devices and states ------------------------------------------------------

/** The platform id of a group: `<station key>-<lsid>` or `<station key>-console`. */
export const deviceKey = (stationKey, groupKey) =>
  groupKey === 'c' ? `${stationKey}-console` : `${stationKey}-${groupKey.slice(1)}`;

const idsOf = (gladys, type, stationKey, groupKey) =>
  gladys.externalIds(type, deviceKey(stationKey, groupKey));

/** The features of a device as the user created it (gladys.devices). */
export function createdFeatures(gladys, type, stationKey, groupKey) {
  const ids = idsOf(gladys, type, stationKey, groupKey);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  return device?.features ?? [];
}

const featureOf = (ids, key, kindName, name) => {
  const kind = KINDS[kindName];
  return {
    name,
    external_id: ids.feature(key),
    category: kind.category,
    type: kind.type,
    ...(kind.unit ? { unit: kind.unit } : {}),
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

export const groupName = (stationName, kind, txid) =>
  `${stationName} – ${KIND_LABELS[kind]}${txid ? ` (transmitter ${txid})` : ''}`;

/**
 * The Gladys device of a group: every feature it has ever given, plus every
 * feature of the device already created (so a transmitter out of range, or a
 * field this version no longer knows, never removes a feature: the core
 * would mark the device as changed and "Update" would drop its history).
 */
export function deviceOf(gladys, { type, stationKey, groupKey, kind, name, fields }) {
  const ids = idsOf(gladys, type, stationKey, groupKey);
  const table = TABLES[kind] ?? [];
  const known = new Set(table.map(([key]) => key));
  const created = createdFeatures(gladys, type, stationKey, groupKey);
  const createdIds = new Set(created.map((f) => f.external_id));
  const features = table
    .filter(([key]) => fields.has(key) || createdIds.has(ids.feature(key)))
    .map(([key, kindName, featureName]) => featureOf(ids, key, kindName, featureName));
  const prefix = `${ids.device}:`;
  for (const feature of created) {
    const key = String(feature.external_id ?? '').startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : '';
    if (key && !known.has(key)) {
      features.push({
        name: feature.name,
        external_id: feature.external_id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name,
    external_id: ids.device,
    // The integration reads WeatherLink at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features,
  };
}

/** The states of the values of a group, for the publishStates format. */
export function statesOf(gladys, { type, stationKey, groupKey, kind, values }) {
  const ids = idsOf(gladys, type, stationKey, groupKey);
  return (TABLES[kind] ?? [])
    .filter(([key]) => num(values?.[key]) !== null)
    .map(([key]) => ({ device_feature_external_id: ids.feature(key), state: values[key] }));
}

/** Every feature key of a kind (the fields kept under /data are checked against it). */
export const keysOf = (kind) => new Set((TABLES[kind] ?? []).map(([key]) => key));
