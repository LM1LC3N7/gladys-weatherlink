// -----------------------------------------------------------------------------
// The clients: where the key and the secret travel, the error kinds, the
// identity checks (station id, serial number), bounded answers.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY } from '../src/constants.js';
import { cloudCurrent, cloudStations, localCurrent } from '../src/weatherlink.js';
import {
  API_KEY,
  API_SECRET,
  STATIONS,
  current,
  installFetch,
  json,
  live,
} from './helpers/fakes.js';

const KEYS = { apiKey: API_KEY, apiSecret: API_SECRET };

let fake;
afterEach(() => fake?.restore());

const kindOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return [err.kind, err.message];
  }
  return ['none'];
};

test('cloud: the key in the query, the secret in a header only, GET only', async () => {
  fake = installFetch([
    [/\/v2\/stations\?/, () => json(STATIONS)],
    [/\/v2\/current\/167531\?/, () => json(current(1760983200))],
  ]);
  const { stations, more } = await cloudStations(KEYS);
  assert.deepEqual(stations, [{ id: 167531, name: 'Jardin' }]);
  assert.equal(more, 0);
  const { records } = await cloudCurrent(KEYS, 167531);
  assert.equal(records.length, 4);
  assert.equal(records[0].ts, 1760983200 * 1000);
  for (const call of fake.calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, 'https://api.weatherlink.com');
    assert.equal(url.searchParams.get('api-key'), API_KEY);
    assert.ok(!call.url.includes(API_SECRET), 'the secret never in a URL');
    assert.equal(call.init.headers['X-Api-Secret'], API_SECRET);
    assert.equal(call.init.method, undefined, 'GET');
    assert.equal(call.init.redirect, 'error');
  }
});

test('cloud: only the id and the name of a station are kept, at most ten', async () => {
  const many = {
    stations: Array.from({ length: 14 }, (_, i) => ({
      station_id: 100 + i,
      station_name: `S\u0007${i}`,
      user_email: 'owner@example.com',
    })).concat([{ station_id: 'x' }, { station_id: 100 }, null]),
  };
  fake = installFetch([[/\/v2\/stations\?/, () => json(many)]]);
  const { stations, more } = await cloudStations(KEYS);
  assert.equal(stations.length, 10);
  assert.equal(more, 4);
  assert.deepEqual(stations[0], { id: 100, name: 'S0' });
});

test('cloud: error kinds', async () => {
  const answers = [
    [401, 'refused'],
    [403, 'refused'],
    [429, 'limited'],
    [500, 'busy'],
    [503, 'busy'],
    [400, 'failed'],
  ];
  for (const [status, kind] of answers) {
    fake = installFetch([[/./, () => json({ code: 1, message: 'nope' }, status)]]);
    const [got, message] = await kindOf(cloudStations(KEYS));
    assert.equal(got, kind, `stations ${status}`);
    assert.ok(!message.includes(API_KEY) && !message.includes(API_SECRET));
    fake.restore();
  }
  // On one station, 403/404 is that station only (not the keys).
  for (const status of [403, 404]) {
    fake = installFetch([[/./, () => json({}, status)]]);
    assert.equal((await kindOf(cloudCurrent(KEYS, 1)))[0], 'denied');
    fake.restore();
  }
  fake = installFetch([[/./, () => json({}, 401)]]);
  assert.equal((await kindOf(cloudCurrent(KEYS, 1)))[0], 'refused');
  fake.restore();
  fake = installFetch([[/./, () => json({}, 429, { 'retry-after': '120' })]]);
  try {
    await cloudCurrent(KEYS, 1);
    assert.fail('429');
  } catch (err) {
    assert.equal(err.retryAfterMs, 120_000);
  }
  fake.restore();
  fake = installFetch([
    [
      /./,
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      },
    ],
  ]);
  const [kind, message] = await kindOf(cloudStations(KEYS));
  assert.equal(kind, 'failed');
  assert.match(message, /ENOTFOUND on api\.weatherlink\.com/);
  assert.ok(!message.includes(API_KEY));
});

test('cloud: another station answering, or not JSON, is refused', async () => {
  fake = installFetch([[/./, () => json(current(1760983200, { stationId: 999 }))]]);
  assert.equal((await kindOf(cloudCurrent(KEYS, 167531)))[0], 'invalid');
  fake.restore();
  fake = installFetch([[/./, () => new Response('<html>', { status: 200 })]]);
  assert.equal((await kindOf(cloudCurrent(KEYS, 167531)))[0], 'invalid');
});

test('a body larger than the limit is abandoned', async () => {
  const big = 'x'.repeat(MAX_BODY + 10);
  fake = installFetch([[/./, () => new Response(big, { status: 200 })]]);
  const [kind, message] = await kindOf(cloudStations(KEYS));
  assert.equal(kind, 'failed');
  assert.match(message, /answer too large/);
});

test('local: the serial number names the device; no serial number, no values', async () => {
  fake = installFetch([[/^http:\/\/192\.168\.1\.60\/v1\/current_conditions$/, () => json(live())]]);
  const { did, records } = await localCurrent('192.168.1.60');
  assert.equal(did, '001d0a7139d6');
  assert.equal(records.length, 4);
  assert.equal(records[0].ts, null);
  fake.restore();
  const noDid = live();
  delete noDid.data.did;
  fake = installFetch([[/./, () => json(noDid)]]);
  assert.equal((await kindOf(localCurrent('192.168.1.60')))[0], 'invalid');
  fake.restore();
  fake = installFetch([[/./, () => json({ data: null, error: { code: 409, message: 'x' } })]]);
  assert.equal((await kindOf(localCurrent('192.168.1.60')))[0], 'failed');
  fake.restore();
  fake = installFetch([[/./, () => json({}, 503)]]);
  assert.equal((await kindOf(localCurrent('192.168.1.60')))[0], 'busy');
});
