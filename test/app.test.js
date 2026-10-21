// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake WeatherLink: the
// devices and states, the pace (never faster than the interval: test button,
// reconnection, saved configuration, restart), the state file (written at
// most once per minute, never a secret), refusals, pauses, a station that
// fails alone, late answers, the identity of local devices.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WeatherLinkApp } from '../src/app.js';
import { TICK } from '../src/constants.js';
import { memoryStorage } from '../src/store.js';
import {
  API_KEY,
  API_SECRET,
  STATIONS,
  airlink,
  createFakeTimers,
  current,
  installFetch,
  json,
  live,
  recordingLogger,
} from './helpers/fakes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const CLOUD = { source: 'cloud', api_key: API_KEY, api_secret: API_SECRET, poll_interval: 5 };
const LOCAL = { source: 'local', local_1_address: '192.168.1.60', poll_interval: 5 };
const OUTDOOR = 'ext:weatherlink:station:c167531-650442';
const CONSOLE = 'ext:weatherlink:station:c167531-console';

let fake;
afterEach(() => fake?.restore());

/** A storage that records the instant of each write. */
function timedStorage(clock, initial) {
  const inner = memoryStorage(initial);
  const times = [];
  return {
    times,
    load: () => inner.load(),
    save(value) {
      times.push(clock.now);
      inner.save(value);
    },
  };
}

async function setup({ config = CLOUD, storage, clock = { now: NOW } } = {}) {
  const answers = {
    stations: () => json(STATIONS),
    current: () => json(current(Math.floor(clock.now / 1000))),
    local: () => json(live()),
  };
  fake = installFetch([
    [/\/v2\/stations\?/, (c) => answers.stations(c)],
    [/\/v2\/current\/\d+\?/, (c) => answers.current(c)],
    [/^http:\/\/[^/]+\/v1\/current_conditions$/, (c) => answers.local(c)],
  ]);
  const gladys = createFakeGladys({ selector: 'weatherlink', config });
  const timers = createFakeTimers();
  const logger = recordingLogger();
  const app = new WeatherLinkApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    storage: storage ?? timedStorage(clock),
    sleep: async () => {},
  });
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  return { app, gladys, timers, clock, answers, logger };
}

const calls = (pattern) => fake.calls.filter((c) => pattern.test(c.url));
const currents = () => calls(/\/v2\/current\//).length;

/** Advance the clock tick by tick for `ms`, running the periodic checks. */
async function advance(ctx, ms) {
  for (let t = 0; t < ms; t += TICK) {
    ctx.clock.now += TICK;
    await ctx.timers.runIntervals();
  }
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

test('cloud: the devices of a station, their values, the status; the secret nowhere', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  const { gladys } = ctx;
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [OUTDOOR, CONSOLE].sort());
  const outdoor = gladys.fake.discoveredDevices.find((d) => d.external_id === OUTDOOR);
  assert.equal(outdoor.name, 'Jardin – outdoor sensors');
  assert.ok(outdoor.features.every((f) => f.read_only === true));
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${OUTDOOR}:temperature`), 10);
  assert.equal(gladys.fake.lastState(`${OUTDOOR}:rain_today`), 3.4);
  assert.equal(gladys.fake.lastState(`${CONSOLE}:pressure`), 1022);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /1 WeatherLink station\(s\), read every 5 min/,
  );
  const everything = JSON.stringify([
    ctx.logger.lines,
    gladys.fake.connectionStatuses,
    gladys.fake.discoveredDevices,
    gladys.fake.requests,
  ]);
  assert.ok(!everything.includes(API_SECRET));
  // Calls: the station list, then one station.
  assert.equal(calls(/\/v2\/stations\?/).length, 1);
  assert.equal(currents(), 1);
});

test('the test button never reads closer than the interval to the last read', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  let answer;
  for (let i = 0; i < 5; i += 1) {
    ctx.clock.now += 10_000;
    answer = await ctx.app.testConnection();
  }
  assert.equal(currents(), 1);
  assert.match(answer.en, /Jardin: temperature 10 °C, humidity 81.2 %/);
  assert.match(answer.en, /next read possible at 18:05 UTC/);
  assert.match(answer.fr, /prochaine lecture possible à 18:05 UTC/);
  ctx.clock.now += 5 * 60_000;
  await ctx.app.testConnection();
  assert.equal(currents(), 2, 'once the interval has passed');
});

test('the periodic reads follow the interval, the station list every 6 hours', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  await advance(ctx, 60 * 60_000);
  assert.equal(currents(), 13, 'every 5 minutes: 1 + 12 in an hour');
  assert.equal(calls(/\/v2\/stations\?/).length, 1);
  await advance(ctx, 5 * 60 * 60_000);
  assert.equal(calls(/\/v2\/stations\?/).length, 2);
});

test('a reconnection, a saved configuration or Discovery never reads sooner', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  for (const minutes of [5, 3, 1, 10]) {
    ctx.clock.now += 5_000;
    await ctx.app.start({ ...CLOUD, poll_interval: minutes });
    await ctx.gladys.fake.scanRequest();
  }
  assert.equal(fake.calls.length, 2);
  // The status and the Discovery list are published again at each start.
  assert.ok(ctx.gladys.fake.connectionStatuses.length >= 5);
});

test('a restart 30 s after a read: no read, the Discovery and the status kept, no secret on disk', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const first = await setup({ storage, clock });
  await first.app.start(CLOUD);
  first.app.shutdown();
  fake.restore();
  clock.now += 30_000;
  const second = await setup({ storage, clock });
  await second.app.start(CLOUD);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(
    second.gladys.fake.discoveredDevices.map((d) => d.external_id).sort(),
    [OUTDOOR, CONSOLE].sort(),
  );
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  const file = JSON.stringify(storage.load());
  assert.ok(!file.includes(API_SECRET) && !file.includes(API_KEY));
  assert.ok(!file.includes('owner@example.com') && !file.includes('48.85'));
  await advance(second, 5 * 60_000);
  assert.equal(currents(), 1, 'read again once the interval has passed');
});

test('the instant of a request is on disk before it leaves, written at most once per minute', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock, config: { ...CLOUD, poll_interval: 1 } });
  const onDisk = [];
  const inner = storage.save;
  storage.save = (value) => {
    onDisk.push({ at: clock.now, attempt: value.sources.cloud?.lastAttemptAt });
    inner.call(storage, value);
  };
  ctx.answers.current = (c) => {
    // At each request, its instant is already in the file.
    assert.equal(storage.load().sources.cloud.lastAttemptAt, clock.now, c.url);
    return json(current(Math.floor(clock.now / 1000)));
  };
  await ctx.app.start({ ...CLOUD, poll_interval: 1 });
  await advance(ctx, 30 * 60_000);
  ctx.answers.current = () => json({}, 503);
  await advance(ctx, 2 * 60 * 60_000);
  // The writes that carry a new request instant are a minute apart at least.
  const attempts = onDisk.filter((w, i) => i === 0 || w.attempt !== onDisk[i - 1].attempt);
  assert.ok(attempts.length > 20);
  for (let i = 1; i < onDisk.length; i += 1) {
    if (onDisk[i].attempt !== onDisk[i - 1].attempt) {
      assert.ok(onDisk[i].at - onDisk[i - 1].at >= 60_000, `write ${i}`);
    }
  }
  // In a quiet hour (the same values, no pause), one write per request at most.
  const quiet = onDisk.filter((w) => w.at > NOW && w.at <= NOW + 30 * 60_000);
  assert.ok(quiet.length <= 31, `${quiet.length} writes in 30 minutes`);
});

test('new keys are read at once (as soon as a write is allowed); unchanged ones keep the pace', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  ctx.clock.now += 5_000;
  await ctx.app.start({ ...CLOUD, api_secret: 'another-secret' });
  assert.equal(currents(), 1, 'the instant of the last write is 5 s old');
  await advance(ctx, 60_000);
  assert.equal(currents(), 2);
  assert.equal(calls(/\/v2\/stations\?/).length, 2, 'other keys: the station list again');
  assert.equal(calls(/\/v2\/current/).at(-1).init.headers['X-Api-Secret'], 'another-secret');
});

test('refused keys: no periodic read for 6 hours; the file keeps no fingerprint of working keys', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.answers.stations = () => json({ code: 401 }, 401);
  await ctx.app.start(CLOUD);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the API key or secret/);
  await advance(ctx, 5 * 60 * 60_000);
  assert.equal(fake.calls.length, 1);
  await advance(ctx, 60_000);
  const fp = () => storage.load().sources.cloud.fp;
  assert.match(fp(), /^[0-9a-f]{32}$/);
  // The right secret: read at once (once a write is allowed), fingerprint erased.
  ctx.answers.stations = () => json(STATIONS);
  await ctx.app.start({ ...CLOUD, api_secret: 'the right one' });
  await advance(ctx, 60_000);
  assert.equal(currents(), 1);
  await advance(ctx, 2 * 60_000);
  assert.equal(fp(), '');
  assert.ok(!JSON.stringify(storage.load()).includes('the right one'));
});

test('a 429 pauses the account, also across a restart; Retry-After is kept', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const first = await setup({ storage, clock });
  first.answers.current = () => json({}, 429, { 'retry-after': '1800' });
  await first.app.start(CLOUD);
  assert.equal(currents(), 1);
  await advance(first, 2 * 60_000);
  first.app.shutdown();
  fake.restore();
  const second = await setup({ storage, clock });
  await second.app.start(CLOUD);
  await advance(second, 26 * 60_000);
  assert.equal(fake.calls.length, 0, 'the 30 minute pause holds after the restart');
  await advance(second, 3 * 60_000);
  assert.equal(currents(), 1);
});

test('a reconnection during a read: no second read, the late answer publishes nothing', async () => {
  const ctx = await setup();
  let release;
  ctx.answers.current = () =>
    new Promise((resolve) => {
      release = () => resolve(json(current(Math.floor(NOW / 1000), { temp: 99 })));
    });
  const starting = ctx.app.start(CLOUD);
  await new Promise((r) => setTimeout(r, 20));
  ctx.app.stop();
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  release();
  await starting;
  assert.equal(ctx.gladys.fake.connectionStatuses.length, statuses, 'no status from the old read');
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0, 'nothing published');
  ctx.answers.current = () => json(current(Math.floor(NOW / 1000)));
  await ctx.app.start(CLOUD);
  assert.equal(currents(), 1);
});

test('one station failing (5xx, 403) never stops the others; all failing pauses', async () => {
  const ctx = await setup();
  const two = {
    stations: [
      { station_id: 1, station_name: 'A' },
      { station_id: 2, station_name: 'B' },
    ],
  };
  ctx.answers.stations = () => json(two);
  ctx.answers.current = (c) =>
    c.url.includes('/current/1?')
      ? json({}, 503)
      : json(current(Math.floor(ctx.clock.now / 1000), { stationId: 2 }));
  await ctx.app.start(CLOUD);
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState('ext:weatherlink:station:c2-650442:temperature'), 10);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /Without value: A \(service unavailable/,
  );
  // A 403 on a station: the list is read again at the next cycle, not sooner.
  ctx.answers.current = (c) =>
    c.url.includes('/current/1?')
      ? json({}, 403)
      : json(current(Math.floor(ctx.clock.now / 1000), { stationId: 2 }));
  await advance(ctx, 5 * 60_000);
  assert.equal(calls(/\/v2\/stations\?/).length, 1);
  await advance(ctx, 5 * 60_000);
  assert.equal(calls(/\/v2\/stations\?/).length, 2);
  // Every station 5xx: the account pauses (5 minutes, then 10, then 20).
  ctx.answers.current = () => json({}, 500);
  const before = currents();
  await advance(ctx, 5 * 60_000);
  assert.equal(currents(), before + 2);
  await advance(ctx, 5 * 60_000);
  assert.equal(currents(), before + 4);
  await advance(ctx, 9 * 60_000);
  assert.equal(currents(), before + 4, 'paused for 10 minutes');
  await advance(ctx, 60_000);
  assert.equal(currents(), before + 6);
});

test('the station list failing at its refresh never stops the known stations', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  ctx.answers.stations = () => json({}, 502);
  await advance(ctx, 6 * 60 * 60_000);
  const lists = calls(/\/v2\/stations\?/).length;
  const reads = currents();
  await advance(ctx, 25 * 60_000);
  assert.equal(calls(/\/v2\/stations\?/).length, lists, 'the list is tried again in 30 minutes');
  assert.equal(currents(), reads + 5, 'the stations are still read every 5 minutes');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a value too old is never published as current', async () => {
  const ctx = await setup();
  ctx.answers.current = () => json(current(Math.floor(NOW / 1000) - 2 * 3600));
  await ctx.app.start(CLOUD);
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${OUTDOOR}:temperature`), undefined);
});

test('local: values under the serial number; two devices swapping their addresses never mix', async () => {
  const config = { ...LOCAL, local_2_address: '192.168.1.61' };
  const ctx = await setup({ config });
  const swapped = { value: false };
  const isSecond = (c) => c.url.includes('.61/') !== swapped.value;
  ctx.answers.local = (c) =>
    isSecond(c) ? json(live({ did: '001D0A000002', temp: 32 })) : json(live({ temp: 50 }));
  await ctx.app.start(config);
  await createAll(ctx.gladys);
  const A = 'ext:weatherlink:live:001d0a7139d6-48308:temperature';
  const B = 'ext:weatherlink:live:001d0a000002-48308:temperature';
  assert.equal(ctx.gladys.fake.lastState(A), 10);
  assert.equal(ctx.gladys.fake.lastState(B), 0);
  swapped.value = true;
  ctx.answers.local = (c) =>
    isSecond(c) ? json(live({ did: '001D0A000002', temp: 41 })) : json(live({ temp: 59 }));
  await advance(ctx, 5 * 60_000);
  assert.equal(ctx.gladys.fake.lastState(A), 15);
  assert.equal(ctx.gladys.fake.lastState(B), 5);
  assert.equal(new Set(ctx.gladys.fake.discoveredDevices.map((d) => d.external_id)).size, 6);
});

test('local: an AirLink and its name; an unreadable serial number publishes nothing', async () => {
  const ctx = await setup({ config: LOCAL });
  ctx.answers.local = () => json(airlink());
  await ctx.app.start(LOCAL);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.name, 'Balcon – AirLink');
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    ['temperature', 'humidity', 'pm25', 'pm10'],
  );
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${device.external_id}:pm25`), 8.3);
  const odd = airlink();
  odd.data.did = '';
  ctx.answers.local = () => json(odd);
  await advance(ctx, 5 * 60_000);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /not a WeatherLink answer/);
});

test('the configuration messages; invalid addresses reported by number', async () => {
  const ctx = await setup({ config: {} });
  await ctx.app.start({});
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /API key and the API secret/);
  await ctx.app.start({ source: 'cloud', api_key: API_KEY });
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Les deux sont nécessaires/);
  await ctx.app.start({ source: 'local', local_1_address: 'http://x/y z', local_2_address: '' });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Address 1 ignored/);
  assert.equal(fake.calls.length, 0);
  const answer = await ctx.app.testConnection();
  assert.match(answer.fr, /Adresse 1 ignorée/);
});

test('the state budget: at most 250 states a minute', async () => {
  const ctx = await setup();
  await ctx.app.start(CLOUD);
  const sent = [];
  ctx.gladys.publishChangedStates = async (batch) => {
    sent.push(batch.length);
    return { count: batch.length };
  };
  for (let i = 0; i < 400; i += 1) {
    ctx.app.backlog.set(`f${i}`, { device_feature_external_id: `f${i}`, state: i });
  }
  await Promise.all([ctx.app.flushStates(), ctx.app.flushStates()]);
  assert.deepEqual(sent, [250]);
  ctx.clock.now += 61_000;
  await ctx.app.flushStates();
  assert.deepEqual(sent, [250, 150]);
});
