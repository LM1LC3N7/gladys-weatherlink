// -----------------------------------------------------------------------------
// Records -> groups and values: the conversions to the units of the core, the
// rain buckets of the local API, the bounds, the console values gathered from
// several records, and no prototype pollution.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  deviceOf,
  fahrenheitToCelsius,
  groupsOf,
  inHgToHpa,
  kindOf,
  mphToKmh,
  statesOf,
} from '../src/fields.js';
import { current, live } from './helpers/fakes.js';

const NOW = 1760983200 * 1000;

const cloudRecords = (doc) =>
  doc.sensors.map((s) => ({ lsid: s.lsid, ts: s.data[0].ts * 1000, data: s.data[0] }));
const localRecords = (doc) => doc.data.conditions.map((c) => ({ lsid: c.lsid, ts: null, data: c }));

test('the conversions', () => {
  assert.equal(fahrenheitToCelsius(32), 0);
  assert.equal(fahrenheitToCelsius(212), 100);
  assert.ok(Math.abs(mphToKmh(10) - 16.09344) < 1e-9);
  assert.ok(Math.abs(inHgToHpa(29.92) - 1013.21) < 0.01);
});

test('cloud: outdoor, console, nothing from the health record', () => {
  const groups = groupsOf(cloudRecords(current(1760983200)), { now: NOW });
  assert.deepEqual([...groups.keys()].sort(), ['c', 's650442']);
  const outdoor = groups.get('s650442');
  assert.equal(outdoor.kind, 'outdoor');
  assert.deepEqual(outdoor.values, {
    temperature: 10,
    humidity: 81.2,
    wind_speed: 16.1,
    wind_speed_avg_10min: 3.4,
    wind_gust_10min: 14.6,
    wind_direction: 263,
    rain_rate: 1.2,
    rain_today: 3.4,
    rain_24h: 5.2,
    solar_radiation: 50633,
    uv_index: 3,
    battery_low: 0,
  });
  assert.deepEqual(groups.get('c').values, {
    indoor_temperature: 21.4,
    indoor_humidity: 36.1,
    pressure: 1022.0,
    pressure_absolute: 1021.8,
  });
});

test('cloud: inches when no mm field is given', () => {
  const data = { ts: 1760983200, temp: 50, rain_day_in: 0.5, rain_rate_in: 0.1 };
  const groups = groupsOf([{ lsid: 1, ts: NOW, data }], { now: NOW });
  assert.equal(groups.get('s1').values.rain_today, 12.7);
  assert.equal(groups.get('s1').values.rain_rate, 2.5);
});

test('local: rain buckets by collector size, soil station, console', () => {
  const groups = groupsOf(localRecords(live()), { local: true, now: NOW });
  const outdoor = groups.get('s48308').values;
  // rain_size 2 = 0.2 mm per bucket tip.
  assert.equal(outdoor.rain_today, 12.6);
  assert.equal(outdoor.rain_rate, 0.6);
  assert.equal(outdoor.rain_24h, 14);
  assert.equal(outdoor.temperature, 17.1);
  const soil = groups.get('s3187671188');
  assert.equal(soil.kind, 'soil');
  assert.equal(soil.txid, 3);
  assert.deepEqual(soil.values, { soil_temperature_1: 21.1, battery_low: 1 });
  assert.deepEqual(groups.get('c').values, {
    indoor_temperature: 25.6,
    indoor_humidity: 41.1,
    pressure: 1016.2,
    pressure_absolute: 1007.9,
  });
  // An unknown collector size gives no rain at all, never a wrong amount.
  const odd = localRecords(live());
  odd[0].data = { ...odd[0].data, rain_size: 0 };
  const values = groupsOf(odd, { local: true, now: NOW }).get('s48308').values;
  assert.equal(values.rain_today, undefined);
  // Cloud rules never read bucket counts.
  const asCloud = groupsOf(localRecords(live()), { now: NOW }).get('s48308').values;
  assert.equal(asCloud.rain_today, undefined);
});

// A Vantage Pro2 / Vue record of data structure 2 (WeatherLink IP, Vantage
// Connect), with the soil and leaf keys it always carries (null without such
// sensors), as astrandb/weatherlink reads it (review 1, B1).
const DS2 = {
  ts: 1760983200,
  temp_out: 59,
  hum_out: 70,
  temp_in: 70,
  hum_in: 40,
  bar: 30.0,
  wind_speed: 10,
  wind_speed_10_min_avg: 8,
  wind_gust_10_min: 20,
  wind_dir: 180,
  rain_rate_in: 0.1,
  rain_day_in: 0.5,
  solar_rad: 500,
  uv: 4,
  temp_extra_1: 82,
  temp_extra_2: null,
  temp_soil_1: 50,
  temp_leaf_1: null,
  moist_soil_1: null,
  moist_soil_2: null,
  wet_leaf_1: null,
  hum_extra_1: null,
};

test('B1 a Vantage Pro2 record (structures 2 and 6) is outdoor, never soil', () => {
  assert.equal(kindOf(DS2), 'outdoor');
  const groups = groupsOf([{ lsid: 100, ts: NOW, data: DS2 }], { now: NOW });
  assert.deepEqual([...groups.keys()].sort(), ['c', 's100']);
  assert.deepEqual(groups.get('s100').values, {
    temperature: 15,
    humidity: 70,
    wind_speed: 16.1,
    wind_speed_avg_10min: 12.9,
    wind_gust_10min: 32.2,
    wind_direction: 180,
    rain_rate: 2.5,
    rain_today: 12.7,
    solar_radiation: 63291,
    uv_index: 4,
    extra_temperature_1: 27.8,
    soil_temperature_1: 10,
  });
  assert.deepEqual(groups.get('c').values, {
    indoor_temperature: 21.1,
    indoor_humidity: 40,
    pressure: 1015.9,
  });
  // Structure 6 (EnviroMonitor): temp_out, no indoor values.
  const ds6 = { ts: 1760983200, temp_out: 41, hum_out: 90, bar: 29.9, wind_speed: 5, uv: 1 };
  const six = groupsOf([{ lsid: 7, ts: NOW, data: ds6 }], { now: NOW });
  assert.equal(six.get('s7').kind, 'outdoor');
  assert.equal(six.get('s7').values.temperature, 5);
  // A soil / leaf station (structures 12 and 25, local type 2) stays soil.
  assert.equal(kindOf({ temp_1: 50, moist_soil_1: 12, wet_leaf_1: null, txid: 3 }), 'soil');
});

test('I2 extra and soil temperatures are probes (out of the room average); the main one is decimal', () => {
  const gladys = createFakeGladys({ selector: 'weatherlink' });
  const device = deviceOf(gladys, {
    type: 'station',
    stationKey: 'c1',
    groupKey: 's100',
    kind: 'outdoor',
    name: 'X',
    fields: new Set(['temperature', 'extra_temperature_1', 'soil_temperature_1']),
  });
  const types = Object.fromEntries(
    device.features.map((f) => [f.external_id.split(':').pop(), f.type]),
  );
  assert.deepEqual(types, {
    temperature: 'decimal',
    extra_temperature_1: 'probe',
    soil_temperature_1: 'probe',
  });
});

test('M3 a lost transmitter (local rx_state 2) publishes nothing', () => {
  const records = localRecords(live());
  records[0].data = { ...records[0].data, rx_state: 2 };
  const groups = groupsOf(records, { local: true, now: NOW });
  assert.equal(groups.has('s48308'), false);
  assert.ok(groups.has('c'));
  records[0].data = { ...records[0].data, rx_state: 0 };
  assert.ok(groupsOf(records, { local: true, now: NOW }).has('s48308'));
});

test('an AirLink record', () => {
  const data = { temp: 68, hum: 55, pm_1: 3, pm_2p5: 8.25, pm_10: 12.5, aqi_val: 34.2 };
  assert.equal(kindOf(data), 'airlink');
  const groups = groupsOf([{ lsid: 9, ts: null, data }], { now: NOW });
  assert.deepEqual(groups.get('s9').values, {
    temperature: 20,
    humidity: 55,
    pm25: 8.3,
    pm10: 12.5,
    aqi: 34,
  });
});

test('out of bounds, null, strings, NaN and stale readings are left out', () => {
  const data = {
    temp: 500,
    hum: '45.5',
    wind_speed_last: null,
    wind_dir_last: 'north',
    uv_index: NaN,
    trans_battery_flag: 7,
    solar_rad: -3,
  };
  const groups = groupsOf([{ lsid: 2, ts: NOW, data }], { now: NOW });
  assert.deepEqual(groups.get('s2').values, { humidity: 45.5 });
  const stale = groupsOf([{ lsid: 2, ts: NOW - 3_600_001, data: { temp: 50 } }], {
    now: NOW,
    staleBefore: NOW - 3_600_000,
  });
  assert.equal(stale.size, 0);
  // A reading "from the future" (a clock ahead) counts as now.
  const ahead = groupsOf([{ lsid: 2, ts: NOW + 999_999, data: { temp: 50 } }], { now: NOW });
  assert.equal(ahead.get('s2').at, NOW);
});

test('no prototype pollution, own fields only', () => {
  const data = JSON.parse('{"__proto__": {"temp": 50, "polluted": true}, "hum": 40}');
  const groups = groupsOf([{ lsid: 3, ts: NOW, data }], { now: NOW });
  assert.deepEqual(groups.get('s3').values, { humidity: 40 });
  assert.equal({}.polluted, undefined);
  const inherited = Object.create({ temp: 50 });
  inherited.hum = 40;
  assert.deepEqual(
    groupsOf([{ lsid: 3, ts: NOW, data: inherited }], { now: NOW }).get('s3').values,
    {
      humidity: 40,
    },
  );
});

test('a device keeps the features of the created device; states never undefined', () => {
  const gladys = createFakeGladys({ selector: 'weatherlink' });
  const base = { type: 'station', stationKey: 'c1', groupKey: 's5', kind: 'outdoor', name: 'X' };
  const device = deviceOf(gladys, { ...base, fields: new Set(['temperature']) });
  assert.equal(device.external_id, 'ext:weatherlink:station:c1-5');
  assert.deepEqual(
    device.features.map((f) => f.external_id),
    ['ext:weatherlink:station:c1-5:temperature'],
  );
  gladys.devices.push({
    external_id: device.external_id,
    features: [
      { external_id: `${device.external_id}:temperature`, category: 'temperature-sensor' },
      { external_id: `${device.external_id}:uv_index`, category: 'uv-sensor' },
      { external_id: `${device.external_id}:old_field`, category: 'unknown', type: 'unknown' },
    ],
  });
  const again = deviceOf(gladys, { ...base, fields: new Set(['temperature']) });
  assert.deepEqual(
    again.features.map((f) => f.external_id.split(':').pop()),
    ['temperature', 'uv_index', 'old_field'],
  );
  const states = statesOf(gladys, { ...base, values: { temperature: 1.5, humidity: undefined } });
  assert.deepEqual(states, [
    { device_feature_external_id: 'ext:weatherlink:station:c1-5:temperature', state: 1.5 },
  ]);
  const console = deviceOf(gladys, {
    ...base,
    groupKey: 'c',
    kind: 'console',
    fields: new Set(['pressure']),
  });
  assert.equal(console.external_id, 'ext:weatherlink:station:c1-console');
});
