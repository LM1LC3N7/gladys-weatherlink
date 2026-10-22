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
import { SourceStore, memoryStorage } from '../src/store.js';
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
  // A 403 on a station: the list is read again once, 30 minutes later.
  ctx.answers.current = (c) =>
    c.url.includes('/current/1?')
      ? json({}, 403)
      : json(current(Math.floor(ctx.clock.now / 1000), { stationId: 2 }));
  await advance(ctx, 5 * 60_000);
  assert.equal(calls(/\/v2\/stations\?/).length, 1);
  await advance(ctx, 30 * 60_000);
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

test('I1 a 429 pause holds when the key is cleared then typed again', async () => {
  const ctx = await setup();
  ctx.answers.current = () => json({}, 429, { 'retry-after': '3600' });
  await ctx.app.start(CLOUD);
  assert.equal(currents(), 1);
  ctx.clock.now += 120_000;
  await ctx.app.start({ ...CLOUD, api_key: '' });
  ctx.clock.now += 60_000;
  ctx.answers.current = () => json(current(Math.floor(ctx.clock.now / 1000)));
  await ctx.app.start(CLOUD);
  await advance(ctx, 50 * 60_000);
  assert.equal(currents(), 1, 'still paused');
  await advance(ctx, 10 * 60_000);
  assert.equal(currents(), 2, 'read again at the end of the pause');
});

test('I1 refused keys are not tried again after a switch to local and back', async () => {
  const ctx = await setup();
  ctx.answers.stations = () => json({}, 401);
  await ctx.app.start(CLOUD);
  ctx.clock.now += 120_000;
  await ctx.app.start({ ...CLOUD, source: 'local' });
  ctx.clock.now += 60_000;
  await ctx.app.start(CLOUD);
  await advance(ctx, 60 * 60_000);
  assert.equal(calls(/\/v2\/stations/).length, 1);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the API key or secret/);
});

test('I1 a removed source is forgotten once its pace has run out, the file stays bounded', () => {
  const clock = { now: NOW };
  const storage = memoryStorage();
  const ctx = { clock };
  const app = new WeatherLinkApp({
    gladys: createFakeGladys({ selector: 'weatherlink' }),
    logger: recordingLogger(),
    now: () => ctx.clock.now,
    timers: createFakeTimers(),
    storage,
  });
  const store = app.store;
  for (let i = 1; i <= 12; i += 1) {
    store.update(`local:10.0.0.${i}`, { lastAttemptAt: NOW + i });
  }
  clock.now += 1_000;
  store.keep(['local:10.0.0.12']);
  assert.equal(store.entries.size, 8);
  assert.ok(store.entries.has('local:10.0.0.12'));
  clock.now += 2 * 60 * 60_000;
  store.keep(['local:10.0.0.12']);
  assert.deepEqual([...store.entries.keys()], ['local:10.0.0.12']);
});

test('R1 every configured source keeps its pace after a restart, whatever was removed before', () => {
  let now = NOW;
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const storage = memoryStorage();
  const options = { storage, now: () => now, timers, maxPause: 6 * 3600e3, maxRefusal: 6 * 3600e3 };
  const store = new SourceStore(options);
  let configured = [];
  for (let i = 0; i < 12; i += 1) {
    now += 61_000;
    configured = [`local:192.168.1.${10 + i}`, 'local:192.168.1.200'];
    store.keep(configured);
    for (const key of configured) {
      store.restore(key, '');
    }
    for (const key of configured) {
      store.update(key, { lastAttemptAt: now }, undefined, { defer: true });
    }
    store.flush();
    assert.ok(store.entries.size <= 8, `${store.entries.size} sources in memory`);
    assert.ok(Object.keys(storage.load().sources).length <= 8);
  }
  now += 30_000;
  const again = new SourceStore(options);
  for (const key of configured) {
    assert.ok(again.entries.has(key), key);
    assert.equal(again.get(key).lastAttemptAt, now - 30_000, key);
  }
  // A file holding more than 8 sources, in any order: the most recent are kept.
  const sources = {};
  for (let i = 0; i < 12; i += 1) {
    sources[`local:10.0.0.${i}`] = { lastAttemptAt: NOW + i * 1000 };
  }
  sources['bad key'] = { lastAttemptAt: NOW + 99_000 };
  const loaded = new SourceStore({ ...options, storage: memoryStorage({ sources }) });
  assert.deepEqual(
    [...loaded.entries.keys()].sort(),
    [4, 5, 6, 7, 8, 9, 10, 11].map((i) => `local:10.0.0.${i}`).sort(),
  );
});

test('M6 a refusal outlives 8 local addresses tried meanwhile; back to the cloud: no call', async () => {
  const clock = { now: NOW };
  const storage = memoryStorage();
  const ctx = await setup({ storage, clock });
  ctx.answers.stations = () => json({}, 401);
  ctx.answers.local = () => json(live());
  await ctx.app.start(CLOUD);
  assert.equal(calls(/\/v2\/stations/).length, 1);
  for (let i = 0; i < 8; i += 1) {
    clock.now += 61_000;
    await ctx.app.start({ ...LOCAL, local_1_address: `192.168.1.${100 + i}` });
  }
  assert.equal(calls(/current_conditions/).length, 8);
  assert.ok(ctx.app.store.entries.has('cloud'), 'the refusal is kept last');
  clock.now += 61_000;
  await ctx.app.start(CLOUD);
  await advance(ctx, 60 * 60_000);
  assert.equal(calls(/\/v2\/stations/).length, 1, 'no call with the refused keys');
  // The same after a restart of the container.
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock });
  again.answers.stations = () => json({}, 401);
  await again.app.start(CLOUD);
  assert.equal(fake.calls.length, 0);
});

test('M6 at load, the configured sources first, then a pause or a refusal, then the most recent', () => {
  const options = {
    now: () => NOW,
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
    maxPause: 6 * 3600e3,
    maxRefusal: 6 * 3600e3,
  };
  const sources = { cloud: { lastAttemptAt: NOW - 50 * 60_000, refusedUntil: NOW + 3600e3 } };
  for (let i = 0; i < 10; i += 1) {
    sources[`local:10.0.0.${i}`] = { lastAttemptAt: NOW - i * 1000 };
  }
  sources['local:10.0.0.42'] = { lastAttemptAt: NOW - 59 * 60_000 };
  const store = new SourceStore({
    ...options,
    storage: memoryStorage({ configured: ['local:10.0.0.42'], sources }),
  });
  const keys = [...store.entries.keys()];
  assert.equal(keys.length, 8);
  assert.ok(keys.includes('local:10.0.0.42'), 'configured');
  assert.ok(keys.includes('cloud'), 'refused');
  assert.ok(!keys.includes('local:10.0.0.9'));
});

test('M1 a station refused for ever (403) re-reads the list once, then waits for the 6-hour refresh', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.answers.stations = () =>
    json({ stations: [...STATIONS.stations, { station_id: 999, station_name: 'Shared' }] });
  ctx.answers.current = (c) =>
    /current\/999/.test(c.url) ? json({}, 403) : json(current(Math.floor(clock.now / 1000)));
  await ctx.app.start(CLOUD);
  const writes = storage.times.length;
  await advance(ctx, 2 * 60 * 60_000);
  assert.equal(calls(/\/v2\/stations/).length, 2, 'the first list, then one retry after 30 min');
  // One write per cycle at most (the instant of its request).
  const cycles = currents() / 2;
  assert.ok(storage.times.length - writes <= cycles + 2, `${storage.times.length - writes} writes`);
  await advance(ctx, 5 * 60 * 60_000);
  assert.equal(calls(/\/v2\/stations/).length, 3, 'the normal 6-hour refresh');
});

test('M2 a local device answering 5xx is paused 30 minutes at most', async () => {
  const ctx = await setup({ config: LOCAL });
  ctx.answers.local = () => json({}, 503);
  await ctx.app.start(LOCAL);
  await advance(ctx, 4 * 60 * 60_000);
  const n = calls(/current_conditions/).length;
  await advance(ctx, 31 * 60_000);
  assert.ok(calls(/current_conditions/).length > n, 'tried again within 31 minutes');
  assert.ok(ctx.app.store.get('local:192.168.1.60').pausedUntil - ctx.clock.now <= 30 * 60_000);
});

test('M5 a key or a secret with a line break or a non-ASCII character: "not valid", never tried', async () => {
  const ctx = await setup();
  for (const bad of [`${API_SECRET}\nx`, `${API_SECRET}é`, `${API_SECRET}\u0000`]) {
    await ctx.app.start({ ...CLOUD, api_secret: bad });
    assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
    assert.match(ctx.gladys.fake.connectionStatus.message.en, /API key or secret not valid/);
    assert.match(ctx.gladys.fake.connectionStatus.message.fr, /non valide/);
  }
  await ctx.app.start({ ...CLOUD, api_key: 'clé' });
  await advance(ctx, 30 * 60_000);
  assert.equal(fake.calls.length, 0);
  const answer = await ctx.app.testConnection();
  assert.match(answer.en, /not valid/);
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
