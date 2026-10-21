// -----------------------------------------------------------------------------
// The integration itself: the sources to read (the WeatherLink account, or
// the local addresses), when each is due, the pauses and refusals, the Gladys
// devices and states built from the readings, the connection status and the
// test button. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasCloud, normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  CLOUD_CALL_GAP,
  CLOUD_HOURLY_BUDGET,
  DEVICE_TYPES,
  HEARTBEAT,
  LOCAL_BUSY_MAX,
  MAX_STATIONS,
  REFUSED_BACKOFF,
  STALE,
  STATES_PER_MINUTE,
  STATIONS_REFRESH,
  STATIONS_RETRY,
  TEST_DEADLINE,
  TICK,
} from './constants.js';
import { deviceOf, groupName, groupsOf, kindOf, statesOf } from './fields.js';
import { T, reason } from './i18n.js';
import { SourceStore, memoryStorage } from './store.js';
import { SourceError, cloudCurrent, cloudStations, localCurrent } from './weatherlink.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultClient = { cloudStations, cloudCurrent, localCurrent };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 12.54 -> "12.5", "12,5" in French. */
const numberText = (value, lang) => {
  const text = String(Math.round(value * 10) / 10);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const asSourceError = (err) => (err instanceof SourceError ? err : new SourceError('failed'));

const newStation = (key, name, cloudId = null) => ({
  key,
  cloudId,
  name,
  /** group key -> { kind, txid, fields: Set } (every field ever read) */
  groups: new Map(),
  /** group key -> { kind, values, at } (the last reading) */
  readings: new Map(),
  error: undefined,
});

/** A station kept under /data -> a station in memory (no reading yet). */
const stationFromSaved = (saved) => {
  const station = newStation(saved.key, saved.name || saved.key, saved.cloudId);
  for (const group of saved.groups) {
    station.groups.set(group.key, {
      kind: group.kind,
      txid: group.txid,
      fields: new Set(group.fields),
    });
  }
  return station;
};

export class WeatherLinkApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'weatherlink' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
    sleep = defaultSleep,
    client = defaultClient,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.sleep = sleep;
    this.client = client;
    this.config = normalizeConfig();
    // The pace, the pauses and the refusals live as long as the process,
    // across restarts of the app and reconnections to Gladys, and in /data
    // across restarts of the container.
    this.store = new SourceStore({
      storage,
      now,
      timers,
      maxPause: BUSY_MAX,
      maxRefusal: REFUSED_BACKOFF,
    });
    /** The configured sources: [{ key, kind, secret, address?, slot? }]. */
    this.sources = [];
    /** source key -> { error, stations: Map(station key -> station) } */
    this.track = new Map();
    /** Stations of the account left out (beyond MAX_STATIONS). */
    this.more = 0;
    this.interval = undefined;
    this.ticking = undefined;
    this.chain = Promise.resolve();
    /** States waiting for room in the per-minute budget: feature id -> state. */
    this.backlog = new Map();
    /** [instant, count] of the states sent in the last minute. */
    this.sentLog = [];
    this.flushTimer = undefined;
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  sourcesOf(config) {
    if (config.source === 'cloud') {
      return hasCloud(config)
        ? [{ key: 'cloud', kind: 'cloud', secret: `${config.apiKey}\n${config.apiSecret}` }]
        : [];
    }
    return config.addresses.map(({ slot, address }) => ({
      key: `local:${address}`,
      kind: 'local',
      secret: '',
      slot,
      address,
    }));
  }

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.sources = this.sourcesOf(this.config);
    const keys = this.sources.map((s) => s.key);
    for (const key of [...this.track.keys()]) {
      if (!keys.includes(key)) {
        this.track.delete(key);
      }
    }
    this.store.keep(keys);
    for (const source of this.sources) {
      // The store drops the refusal and the last request of other keys (seen
      // in memory while the process runs, or after a restart against the
      // fingerprint of keys still refused): new keys, like a new address,
      // are tried at once. Anything else (a reconnection to Gladys, a
      // restart of the container, a new interval) keeps the pace: the next
      // read is never before the last request + the interval.
      const { entry: saved, changed } = this.store.restore(source.key, source.secret);
      let track = this.track.get(source.key);
      if (!track) {
        // After a restart: the stations known before (ids, names, sensors,
        // not secret) keep the Discovery list filled until the next read.
        track = {
          error: undefined,
          stations: new Map(saved.stations.map((s) => [s.key, stationFromSaved(s)])),
        };
        this.track.set(source.key, track);
      }
      if (changed) {
        track.error = undefined;
      }
      // After a restart, the status says at once that the keys are refused
      // or the source paused, without asking it.
      if (!track.error && saved.refusedUntil > this.now()) {
        track.error = 'refused';
      } else if (!track.error && saved.pausedUntil > this.now()) {
        track.error = 'busy';
      }
    }
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again even when nothing changed.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /** The container stops: the state file is written if allowed, the timers dropped. */
  shutdown() {
    this.stop();
    this.store.flush();
    this.store.close();
  }

  /** An error message without the API key nor the secret. */
  scrub(err) {
    let message = String(err?.message ?? err);
    for (const secret of [this.config.apiSecret, this.config.apiKey]) {
      if (secret && secret.length >= 4) {
        message = message.split(secret).join('***');
      }
    }
    return message;
  }

  /** Run `fn` after every read already queued: never two reads at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Pace ---------------------------------------------------------------------------

  /**
   * The interval of a source. For the cloud, stretched so that a whole hour
   * stays under CLOUD_HOURLY_BUDGET calls (one per station and per cycle).
   */
  intervalMs(source) {
    const base = this.config.pollMinutes * 60_000;
    if (source.kind !== 'cloud') {
      return base;
    }
    const stations = Math.max(1, this.track.get(source.key)?.stations.size ?? 1);
    return Math.max(base, Math.ceil((stations * 3_600_000) / CLOUD_HOURLY_BUDGET));
  }

  staleMs(source) {
    return Math.max(STALE, 2 * this.intervalMs(source));
  }

  /** The earliest read of a source: interval, pause and (periodic reads only) refusal kept. */
  earliest(source, { manual = false } = {}) {
    const saved = this.store.get(source.key);
    const at = Math.max(saved.lastAttemptAt + this.intervalMs(source), saved.pausedUntil);
    return manual ? at : Math.max(at, saved.refusedUntil);
  }

  /** When the next read can happen (shown by the test button). */
  nextRead(source) {
    return Math.max(this.earliest(source, { manual: true }), this.store.writableAt(), this.now());
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read what is due (a tick never overlaps another). */
  tick({ manual = false } = {}) {
    if (!manual && this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const generation = this.generation;
    const run = this.exclusive(() => this.readDue({ manual })).finally(() => {
      if (this.ticking === run) {
        this.ticking = undefined;
      }
    });
    if (!manual) {
      this.ticking = run;
      this.tickGeneration = generation;
    }
    return run;
  }

  /**
   * Read the sources whose interval has passed. Nothing, not even the test
   * button (`manual`), reads a source before its last request + the
   * interval, nor during a pause; `manual` may try refused keys again once
   * the interval has passed. The instant of the request is written to /data
   * before it leaves (a read waits until a write is allowed).
   */
  async readDue({ manual = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    const due = this.sources.filter((source) => now >= this.earliest(source, { manual }));
    if (due.length === 0 || !this.store.canWrite()) {
      return;
    }
    for (const source of due) {
      this.store.update(source.key, { lastAttemptAt: now }, undefined, { defer: true });
    }
    this.store.flush();
    for (const source of due) {
      if (generation !== this.generation) {
        return;
      }
      if (source.kind === 'cloud') {
        await this.readCloud(source);
      } else {
        await this.readLocal(source);
      }
    }
    if (generation === this.generation) {
      await this.publish();
      await this.refreshStatus();
    }
  }

  /** The same source, with the same keys, is still configured. */
  stillConfigured(source) {
    return this.sources.some((s) => s.key === source.key && s.secret === source.secret);
  }

  /** The cloud account: the station list (every 6 hours), then each station. */
  async readCloud(source) {
    const generation = this.generation;
    const current = () => generation === this.generation;
    const track = this.track.get(source.key);
    const keys = { apiKey: this.config.apiKey, apiSecret: this.config.apiSecret };
    try {
      let calls = 0;
      const saved = this.store.get(source.key);
      if (track.stations.size === 0 || this.now() - saved.stationsReadAt >= STATIONS_REFRESH) {
        calls += 1;
        let list;
        try {
          list = await this.client.cloudStations(keys);
        } catch (err) {
          const error = asSourceError(err);
          // The list is secondary once stations are known: a passing failure
          // of it never stops their reads (it is tried again in 30 minutes).
          // Refused keys and a 429 concern the whole account.
          if (
            !current() ||
            track.stations.size === 0 ||
            error.kind === 'refused' ||
            error.kind === 'limited'
          ) {
            throw error;
          }
          this.logger.warn(`WeatherLink station list: ${this.scrub(error)}`);
          this.store.update(source.key, {
            stationsReadAt: this.now() - STATIONS_REFRESH + STATIONS_RETRY,
          });
        }
        if (!current()) {
          return;
        }
        if (list) {
          this.more = list.more;
          const next = new Map();
          for (const { id, name } of list.stations) {
            const key = `c${id}`;
            const known = track.stations.get(key) ?? newStation(key, name, id);
            known.name = name;
            known.cloudId = id;
            next.set(key, known);
          }
          track.stations = next;
          this.store.update(source.key, { stationsReadAt: this.now() });
        }
      }
      let ok = 0;
      let busy;
      for (const station of track.stations.values()) {
        if (calls > 0) {
          // WeatherLink: at most 10 calls per second; a margin is kept.
          await this.sleep(CLOUD_CALL_GAP);
          if (!current()) {
            return;
          }
        }
        calls += 1;
        try {
          const { records } = await this.client.cloudCurrent(keys, station.cloudId);
          if (!current()) {
            return;
          }
          this.applyReadings(source, station, records, { local: false });
          station.deniedRetried = false;
          ok += 1;
        } catch (err) {
          const error = asSourceError(err);
          // The whole account: refused keys, a 429. A late answer of an old
          // configuration is handled below.
          if (!current() || error.kind === 'refused' || error.kind === 'limited') {
            throw error;
          }
          // One station that fails never stops the others.
          station.error = error.kind;
          if (error.kind === 'busy') {
            busy = error;
          }
          if (error.kind === 'denied' && !station.deniedRetried) {
            // Removed from the account, or shared without API access: the
            // station list is read again once, in 30 minutes at the earliest;
            // a station still refused then waits for the 6-hour refresh.
            station.deniedRetried = true;
            const retryAt = this.now() - STATIONS_REFRESH + STATIONS_RETRY;
            if (this.store.get(source.key).stationsReadAt > retryAt) {
              this.store.update(source.key, { stationsReadAt: retryAt });
            }
          }
          this.logger.warn(`WeatherLink station ${station.cloudId}: ${this.scrub(error)}`);
        }
      }
      if (ok === 0 && busy) {
        // Every station answered 5xx: the service is down, it gets a pause.
        throw busy;
      }
      track.error = undefined;
      this.store.update(source.key, {
        pausedUntil: 0,
        streak: 0,
        refusedUntil: 0,
        stations: this.serialize(track),
      });
    } catch (err) {
      this.failed(source, track, asSourceError(err), current());
    }
  }

  /** A WeatherLink Live or an AirLink. */
  async readLocal(source) {
    const generation = this.generation;
    const current = () => generation === this.generation;
    const track = this.track.get(source.key);
    try {
      const { did, name, records } = await this.client.localCurrent(source.address);
      if (!current()) {
        return;
      }
      let station = track.stations.get(did);
      if (!station) {
        // A first read, or another device now answers at this address (two
        // devices that swapped their addresses in the router): it is its own
        // station, never the first one.
        const airlink = records.some((r) => kindOf(r.data) === 'airlink');
        const model = airlink ? 'AirLink' : 'WeatherLink Live';
        station = newStation(did, name || `${model} ${did.slice(-6).toUpperCase()}`);
        track.stations = new Map([[did, station]]);
      } else if (name) {
        station.name = name;
      }
      this.applyReadings(source, station, records, { local: true });
      track.error = undefined;
      this.store.update(source.key, {
        pausedUntil: 0,
        streak: 0,
        refusedUntil: 0,
        stations: this.serialize(track),
      });
    } catch (err) {
      this.failed(source, track, asSourceError(err), current());
    }
  }

  /** A failed read: refusal, pause or a passing failure (retried at the interval). */
  failed(source, track, error, current) {
    const at = this.now();
    if (!current) {
      // Disconnected (or reconfigured) meanwhile: nothing is published and no
      // status is set, but a pause asked by the same source, with the same
      // keys, is kept.
      if ((error.kind === 'limited' || error.kind === 'busy') && this.stillConfigured(source)) {
        this.recordBusy(source, error, at);
      }
      return;
    }
    track.error = error.kind;
    if (error.kind === 'refused') {
      // The fingerprint of these refused keys is kept only while the refusal lasts.
      this.store.update(source.key, { refusedUntil: at + REFUSED_BACKOFF }, source.secret);
    } else if (error.kind === 'limited' || error.kind === 'busy') {
      this.recordBusy(source, error, at);
    }
    const name = source.kind === 'cloud' ? 'WeatherLink account' : source.address;
    this.logger.warn(`${name}: ${this.scrub(error)}`);
  }

  /**
   * A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours
   * for the cloud, to 30 minutes for a device of the local network (a
   * WeatherLink Live restarting or updating).
   */
  recordBusy(source, error, at) {
    const streak = this.store.get(source.key).streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      source.kind === 'local' ? LOCAL_BUSY_MAX : BUSY_MAX,
    );
    this.store.update(source.key, { streak, pausedUntil: at + pause });
  }

  /** The readings of a station replace the previous ones; the fields only grow. */
  applyReadings(source, station, records, { local }) {
    const now = this.now();
    const groups = groupsOf(records, { local, now, staleBefore: now - this.staleMs(source) });
    station.readings = new Map();
    for (const [key, group] of groups) {
      let known = station.groups.get(key);
      if (!known || known.kind !== group.kind) {
        if (!known && station.groups.size >= 40) {
          continue;
        }
        known = { kind: group.kind, txid: group.txid, fields: new Set() };
        station.groups.set(key, known);
      }
      known.txid = group.txid;
      for (const field of Object.keys(group.values)) {
        known.fields.add(field);
      }
      station.readings.set(key, { kind: group.kind, values: group.values, at: group.at });
    }
    station.error = groups.size === 0 ? 'stale' : undefined;
  }

  /** The stations of a source as kept under /data (nothing secret). */
  serialize(track) {
    return [...track.stations.values()].slice(0, MAX_STATIONS).map((station) => ({
      key: station.key,
      cloudId: station.cloudId,
      name: station.name,
      groups: [...station.groups].map(([key, group]) => ({
        key,
        kind: group.kind,
        txid: group.txid,
        fields: [...group.fields],
      })),
    }));
  }

  // --- Gladys devices and states --------------------------------------------------

  typeOf(source) {
    return source.kind === 'cloud' ? DEVICE_TYPES.CLOUD : DEVICE_TYPES.LOCAL;
  }

  /**
   * The stations known, without duplicates (one device found at two
   * addresses is published once, under the first): [{ source, station }].
   */
  known() {
    const seen = new Set();
    const list = [];
    for (const source of this.sources) {
      for (const station of this.track.get(source.key)?.stations.values() ?? []) {
        const id = `${this.typeOf(source)}:${station.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          list.push({ source, station });
        }
      }
    }
    return list;
  }

  devices() {
    const devices = [];
    for (const { source, station } of this.known()) {
      for (const [groupKey, group] of station.groups) {
        const device = deviceOf(this.gladys, {
          type: this.typeOf(source),
          stationKey: station.key,
          groupKey,
          kind: group.kind,
          name: groupName(station.name, group.kind, group.txid),
          fields: group.fields,
        });
        if (device.features.length > 0) {
          devices.push(device);
        }
      }
    }
    return devices;
  }

  async publish() {
    await this.publishDiscovered();
    await this.publishStates();
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** A reading recent enough to be published as current. */
  isFresh(source, reading, now) {
    return Boolean(reading) && now - reading.at <= this.staleMs(source);
  }

  /**
   * The fresh values of the created features, only what changed (plus a
   * heartbeat). The core accepts 300 states per minute: past
   * STATES_PER_MINUTE in the last minute, the rest waits in a backlog (the
   * newest value of each feature) sent as the minute frees room.
   */
  async publishStates() {
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    if (created.size === 0) {
      return;
    }
    const now = this.now();
    for (const { source, station } of this.known()) {
      for (const [groupKey, reading] of station.readings) {
        if (!this.isFresh(source, reading, now)) {
          continue;
        }
        const states = statesOf(this.gladys, {
          type: this.typeOf(source),
          stationKey: station.key,
          groupKey,
          kind: reading.kind,
          values: reading.values,
        });
        for (const state of states) {
          if (created.has(state.device_feature_external_id)) {
            this.backlog.set(state.device_feature_external_id, state);
          }
        }
      }
    }
    await this.flushStates();
  }

  /** Room left in the per-minute budget. */
  stateBudget() {
    const now = this.now();
    this.sentLog = this.sentLog.filter(([t]) => now - t < 60_000);
    return STATES_PER_MINUTE - this.sentLog.reduce((sum, [, n]) => sum + n, 0);
  }

  async flushStates() {
    if (this.backlog.size === 0) {
      return;
    }
    const budget = this.stateBudget();
    if (budget <= 0) {
      this.scheduleFlush();
      return;
    }
    const batch = [...this.backlog.values()].slice(0, budget);
    for (const state of batch) {
      this.backlog.delete(state.device_feature_external_id);
    }
    // The batch is reserved in the budget BEFORE the await: a flush running
    // meanwhile (a test button, a created device) sees the room already taken.
    const entry = [this.now(), batch.length];
    this.sentLog.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(batch, { heartbeat: HEARTBEAT });
      // Only what was really sent counts (unchanged values are skipped).
      entry[1] = Number.isFinite(result?.count) ? result.count : batch.length;
    } catch (err) {
      entry[1] = 0;
      this.logger.warn(`Publishing the states failed: ${err.message}`);
      // Sent again later, unless a newer value came in meanwhile.
      for (const state of batch) {
        if (!this.backlog.has(state.device_feature_external_id)) {
          this.backlog.set(state.device_feature_external_id, state);
        }
      }
      this.scheduleFlush(60_000);
      return;
    }
    if (this.backlog.size > 0) {
      this.scheduleFlush();
    }
  }

  /** Flush again when the oldest send of the minute expires. */
  scheduleFlush(wait) {
    if (this.flushTimer !== undefined) {
      return;
    }
    const oldest = this.sentLog[0]?.[0];
    const delay =
      wait ??
      (oldest !== undefined ? Math.max(1_000, 60_000 - (this.now() - oldest) + 100) : 1_000);
    const generation = this.generation;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      if (generation === this.generation) {
        this.flushStates().catch((err) => this.logger.warn(`Flush failed: ${err.message}`));
      }
    }, delay);
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  withNotes(text) {
    const notes = [];
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidSlots(this.config.invalid));
    }
    if (this.sources.some((s) => this.track.get(s.key)?.error === 'refused')) {
      notes.push(T.refusedHelp);
    }
    if (this.config.source === 'cloud' && this.more > 0) {
      notes.push(T.moreStations(this.more, MAX_STATIONS));
    }
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en.replace(/\.$/, '')}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr.replace(/\.$/, '')}.`).join(' ')}`,
    };
  }

  /** What has no value, and why: [{ name, kind }]. */
  failing() {
    const list = [];
    for (const source of this.sources) {
      const track = this.track.get(source.key);
      if (track?.error) {
        list.push({
          name: source.kind === 'cloud' ? 'WeatherLink' : source.address,
          kind: track.error,
        });
      }
    }
    for (const { station } of this.known()) {
      if (station.error) {
        list.push({ name: station.name, kind: station.error });
      }
    }
    return list;
  }

  configMessage() {
    const { config } = this;
    if (config.source === 'cloud' && this.sources.length === 0) {
      if (config.keysInvalid) {
        return T.keysInvalid;
      }
      return config.apiKey || config.apiSecret ? T.oneKeyMissing : T.notConfiguredCloud;
    }
    if (config.source === 'local' && this.sources.length === 0) {
      return T.notConfiguredLocal;
    }
    return null;
  }

  async refreshStatus() {
    const missing = this.configMessage();
    if (missing) {
      return this.setStatus(false, this.withNotes(missing));
    }
    const now = this.now();
    const failing = this.failing();
    const anyValue = this.known().some(({ source, station }) =>
      [...station.readings.values()].some((r) => this.isFresh(source, r, now)),
    );
    const text = T.ok({
      stations: this.known().length,
      interval: Math.round(this.intervalMs(this.sources[0]) / 60_000),
      failing,
    });
    return this.setStatus(anyValue || failing.length === 0, this.withNotes(text));
  }

  // --- Configuration screen button -------------------------------------------------

  stationLine(source, station, lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    const now = this.now();
    const parts = [];
    const add = (values, field, label, unit) => {
      if (typeof values?.[field] === 'number') {
        parts.push(`${label} ${numberText(values[field], lang)}${unit}`);
      }
    };
    let newest = -Infinity;
    for (const reading of station.readings.values()) {
      if (!this.isFresh(source, reading, now)) {
        continue;
      }
      newest = Math.max(newest, reading.at);
      const v = reading.values;
      if (reading.kind === 'outdoor' || reading.kind === 'airlink') {
        add(v, 'temperature', lang === 'fr' ? 'température' : 'temperature', ' °C');
        add(v, 'humidity', lang === 'fr' ? 'humidité' : 'humidity', ' %');
        add(v, 'wind_speed', lang === 'fr' ? 'vent' : 'wind', ' km/h');
        add(v, 'rain_today', lang === 'fr' ? "pluie aujourd'hui" : 'rain today', ' mm');
        add(v, 'pm25', 'PM2.5', ' µg/m³');
      } else if (reading.kind === 'console') {
        add(v, 'pressure', lang === 'fr' ? 'pression' : 'pressure', ' hPa');
      }
    }
    if (parts.length === 0) {
      const why = station.error
        ? reason(station.error)[lang]
        : lang === 'fr'
          ? 'pas encore lue depuis le démarrage'
          : 'not read since the start';
      return `- ${station.name}${colon} ${why}`;
    }
    const minutes = Math.max(0, Math.round((now - newest) / 60_000));
    parts.push(lang === 'fr' ? `mesure d'il y a ${minutes} min` : `read ${minutes} min ago`);
    return `- ${station.name}${colon} ${parts.join(', ')}`;
  }

  sourceLines(source, lang) {
    const track = this.track.get(source.key);
    const colon = lang === 'fr' ? ' :' : ':';
    const name =
      source.kind === 'cloud'
        ? lang === 'fr'
          ? 'Compte WeatherLink'
          : 'WeatherLink account'
        : source.address;
    const saved = this.store.get(source.key);
    const head = [];
    if (track?.error) {
      head.push(reason(track.error)[lang]);
      if (saved.pausedUntil > this.now()) {
        head.push(T.pausedUntil(saved.pausedUntil)[lang]);
      }
    } else {
      const n = track?.stations.size ?? 0;
      head.push(lang === 'fr' ? `${n} station(s)` : `${n} station(s)`);
    }
    head.push(T.nextRead(this.nextRead(source))[lang]);
    const lines = [`${name}${colon} ${head.join(', ')}`];
    for (const station of track?.stations.values() ?? []) {
      lines.push(this.stationLine(source, station, lang));
    }
    return lines;
  }

  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return this.withNotes(missing);
    }
    // Gladys waits 120 s for the answer: past ~100 s, the last values are
    // shown (a read still running finishes in the background).
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([this.tick({ manual: true }), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    const en = [];
    const fr = [];
    for (const source of this.sources) {
      en.push(...this.sourceLines(source, 'en'));
      fr.push(...this.sourceLines(source, 'fr'));
    }
    await this.publish();
    await this.refreshStatus();
    return this.withNotes({ en: en.join('\n'), fr: fr.join('\n') });
  }
}
