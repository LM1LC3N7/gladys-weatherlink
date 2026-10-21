// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): for each
// source (the cloud account, each local address), the instant of the last
// request, the end of a pause (429/5xx) and of a refusal of the keys, so a
// container restarting in a loop never reads faster than the interval; and
// the stations met (id, name, the sensors and the fields they gave: nothing
// secret), so the Discovery list is not empty after a restart.
//
// The instant of a request is written at most once per minute (WRITE_GAP
// after the previous write, whatever it was; the instant of the write is
// kept in the file): a read waits until such a write is allowed, so the
// instant of its request is always on disk before the request leaves. A
// pause, a refusal, their end or a new station is written at once (one such
// write per request at most), so a restart never forgets it.
//
// The key and the secret are never written. Only while they are refused, the
// file keeps a salted scrypt fingerprint (16 bytes, a random salt per file)
// of that refused pair, to know after a restart whether the refusal still
// concerns the configured keys; it is erased by the first successful read.
// Nothing in the file can confirm keys that work.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_INTERVAL, MAX_SAVED_SOURCES, MAX_STATIONS, WRITE_GAP } from './constants.js';
import { KIND_LABELS, keysOf } from './fields.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    writes: 0,
    load: () => value,
    save(next) {
      this.writes += 1;
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 256 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

const SOURCE_KEY = /^(cloud|local:[a-z0-9.:-]{1,260})$/;
const STATION_KEY = /^[a-z0-9]{1,32}$/;
const GROUP_KEY = /^(c|s\d{1,12})$/;

/** A group read back from the file, or undefined when it does not look right. */
function groupOf(value) {
  if (!value || typeof value !== 'object' || !GROUP_KEY.test(value.key)) {
    return undefined;
  }
  if (
    !Object.hasOwn(KIND_LABELS, value.kind) ||
    (value.key === 'c') !== (value.kind === 'console')
  ) {
    return undefined;
  }
  const allowed = keysOf(value.kind);
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((f) => typeof f === 'string' && allowed.has(f)).slice(0, 40)
    : [];
  const txid =
    Number.isSafeInteger(value.txid) && value.txid > 1 && value.txid < 100 ? value.txid : null;
  return { key: value.key, kind: value.kind, txid, fields };
}

/** A station read back from the file, or undefined when it does not look right. */
function stationOf(value) {
  if (!value || typeof value !== 'object' || !STATION_KEY.test(value.key)) {
    return undefined;
  }
  const cloudId = Number.isSafeInteger(value.cloudId) && value.cloudId > 0 ? value.cloudId : null;
  const groups = Array.isArray(value.groups)
    ? value.groups.slice(0, 40).map(groupOf).filter(Boolean)
    : [];
  return { key: value.key, cloudId, name: cleanText(value.name, 60), groups };
}

const EMPTY = Object.freeze({
  lastAttemptAt: 0,
  pausedUntil: 0,
  streak: 0,
  refusedUntil: 0,
  fp: '',
  stationsReadAt: 0,
  stations: [],
});

export class SourceStore {
  constructor({
    storage = memoryStorage(),
    now = Date.now,
    timers = { setTimeout, clearTimeout },
    maxPause,
    maxRefusal,
  }) {
    this.storage = storage;
    this.now = now;
    this.timers = timers;
    this.flushTimer = undefined;
    this.dirty = false;
    /** In memory only: source key -> the secret last configured, to tell a change. */
    this.secrets = new Map();
    const saved = storage.load();
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved);
    const at = now();
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    // The instant of the last write, never in the future: a restart loop
    // writes no more often than a running process.
    this.writtenAt = valid ? Math.min(finite(saved.writtenAt), at) : 0;
    /** source key -> entry */
    this.entries = new Map();
    const sources =
      valid && saved.sources && typeof saved.sources === 'object' ? saved.sources : {};
    // Valid entries first, then the most recent ones (whatever their order in
    // the file): a configured source, read lately, is never the one dropped.
    const kept = Object.keys(sources)
      .slice(0, 64)
      .filter((key) => {
        const entry = sources[key];
        return SOURCE_KEY.test(key) && entry && typeof entry === 'object' && !Array.isArray(entry);
      })
      .sort((a, b) => finite(sources[b].lastAttemptAt) - finite(sources[a].lastAttemptAt))
      .slice(0, MAX_SAVED_SOURCES);
    for (const key of kept) {
      const entry = sources[key];
      // A time read back is capped (a request never "in the future", a pause
      // never longer than a fresh one): a clock that jumped, or a hand-edited
      // file, never stops a source for longer.
      this.entries.set(key, {
        lastAttemptAt: Math.min(finite(entry.lastAttemptAt), at),
        pausedUntil: Math.min(finite(entry.pausedUntil), at + maxPause),
        streak: Math.min(Math.max(0, Math.floor(finite(entry.streak))), 20),
        refusedUntil: Math.min(finite(entry.refusedUntil), at + maxRefusal),
        fp:
          typeof entry.fp === 'string' &&
          /^[0-9a-f]{32}$/.test(entry.fp) &&
          finite(entry.refusedUntil) > at
            ? entry.fp
            : '',
        stationsReadAt: Math.min(finite(entry.stationsReadAt), at),
        stations: Array.isArray(entry.stations)
          ? entry.stations.slice(0, MAX_STATIONS).map(stationOf).filter(Boolean)
          : [],
      });
    }
  }

  /** The salted fingerprint of a secret for a source (never the secret). */
  fingerprint(key, secret) {
    return scryptSync(String(secret), `${this.salt}:${key}`, 16).toString('hex');
  }

  get(key) {
    return this.entries.get(key) ?? EMPTY;
  }

  /**
   * The saved state of a source for the configured secret (the cloud keys;
   * '' for a local address). New keys drop the refusal and the instant of
   * the last request (tried at once): told apart in memory while the
   * process runs; after a restart, only refused keys are known (their
   * fingerprint), so keys changed while the container was stopped wait at
   * most one interval. Returns `{ entry, changed }`.
   */
  restore(key, secret) {
    const entry = { ...EMPTY, ...this.entries.get(key) };
    let changed = false;
    if (this.secrets.has(key)) {
      changed = this.secrets.get(key) !== secret;
    } else if (entry.fp && entry.refusedUntil > this.now()) {
      changed = entry.fp !== this.fingerprint(key, secret);
    }
    this.secrets.set(key, secret);
    const next = { ...entry };
    if (changed) {
      next.refusedUntil = 0;
      next.lastAttemptAt = 0;
      // Other keys may open another account: its station list is read again.
      next.stationsReadAt = 0;
    }
    if (next.refusedUntil <= this.now()) {
      next.fp = '';
    }
    this.entries.set(key, next);
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      this.markDirty();
    }
    return { entry: next, changed };
  }

  /**
   * Update a source. A refusal (`refusedUntil` > 0, with the refused
   * `secret`) keeps the fingerprint of that secret; anything else erases it.
   * A change (a pause, a refusal, its end, the stations met: rare events,
   * one per request at most) is written at once, so a restart never forgets
   * it; with `defer` (the instant of a request, written by its own flush),
   * at the next allowed instant.
   */
  update(key, changes, secret, { defer = false } = {}) {
    const entry = { ...EMPTY, ...this.entries.get(key) };
    const next = { ...entry, ...changes };
    if (changes.refusedUntil > 0 && secret !== undefined) {
      next.fp = this.fingerprint(key, secret);
    } else if (!(next.refusedUntil > this.now())) {
      next.fp = '';
    }
    this.entries.set(key, next);
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      if (defer) {
        this.markDirty();
      } else {
        this.dirty = true;
        this.write();
      }
    }
    return next;
  }

  /**
   * The configured sources are `keys`. A source removed from the
   * configuration loses its stations, but keeps its pace (last request,
   * pause, refusal and its fingerprint) while any of it still runs: a key
   * cleared then typed again, or a switch to local and back, never reads
   * sooner nor lifts a 429 pause or a refusal. Then it is forgotten.
   */
  keep(keys) {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (keys.includes(key)) {
        continue;
      }
      const running =
        entry.lastAttemptAt + MAX_INTERVAL > now ||
        entry.pausedUntil > now ||
        entry.refusedUntil > now;
      if (!running) {
        this.entries.delete(key);
        this.markDirty();
      } else if (entry.stations.length > 0 || entry.stationsReadAt !== 0) {
        this.entries.set(key, { ...entry, stations: [], stationsReadAt: 0 });
        this.markDirty();
      }
    }
    // Bounded: the configured sources always have their room (counted even
    // before restore() adds them), the removed ones share what is left, the
    // oldest going first.
    const room = Math.max(0, MAX_SAVED_SOURCES - new Set(keys).size);
    const removed = [...this.entries]
      .filter(([key]) => !keys.includes(key))
      .sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt);
    while (removed.length > room) {
      this.entries.delete(removed.shift()[0]);
      this.markDirty();
    }
  }

  /** The first instant a write is allowed. */
  writableAt() {
    return this.writtenAt + WRITE_GAP;
  }

  canWrite() {
    return this.now() >= this.writableAt();
  }

  markDirty() {
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer !== undefined) {
      return;
    }
    const delay = Math.max(0, this.writableAt() - this.now());
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  /** Write the file now if something changed and a write is allowed; returns whether it is on disk. */
  flush() {
    if (!this.dirty) {
      return true;
    }
    if (!this.canWrite()) {
      this.scheduleFlush();
      return false;
    }
    this.write();
    return true;
  }

  write() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.writtenAt = this.now();
    this.dirty = false;
    this.storage.save({
      salt: this.salt,
      writtenAt: this.writtenAt,
      sources: Object.fromEntries(this.entries),
    });
  }

  /** Stop the pending write (the next start writes what is left). */
  close() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}
