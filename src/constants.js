// -----------------------------------------------------------------------------
// Endpoints, limits, pacing and the keys users store (manifest keys, device
// types): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/** The official WeatherLink API v2 (weatherlink.github.io/v2-api). */
export const CLOUD_URL = 'https://api.weatherlink.com/v2';

/** The documented local API of the WeatherLink Live and of the AirLink. */
export const LOCAL_PATH = '/v1/current_conditions';

export const USER_AGENT = 'gladys-weatherlink (+https://github.com/LM1LC3N7/gladys-weatherlink)';

/** One HTTP call (cloud or local). */
export const HTTP_TIMEOUT = 10_000;

/** The most an answer may weigh (a few KB for a station, more for a large account). */
export const MAX_BODY = 512 * 1024;

/**
 * WeatherLink allows 10 calls per second and 1,000 per hour per API key. The
 * calls of a cycle are spaced by this (5 per second at most), and the cycle
 * interval is stretched so that a whole hour stays under CLOUD_HOURLY_BUDGET.
 */
export const CLOUD_CALL_GAP = 200;
export const CLOUD_HOURLY_BUDGET = 600;

/** At most this many stations of the account are read. */
export const MAX_STATIONS = 10;

/** At most this many sensors of a station are looked at. */
export const MAX_SENSORS = 40;

/** The list of the stations of the account is read again this often. */
export const STATIONS_REFRESH = 6 * 60 * 60_000;

/** A refresh of the list that failed (stations known): tried again after this. */
export const STATIONS_RETRY = 30 * 60_000;

/** At most this many local addresses (a WeatherLink Live, AirLinks). */
export const MAX_LOCAL = 3;

/** How often the integration checks what is due. */
export const TICK = 15_000;

/**
 * The state file under /data is written at most once per minute (flash
 * memory, restart loops): a read waits for that too.
 */
export const WRITE_GAP = 60_000;

/**
 * 429 / 5xx: a pause, from Retry-After when given, else 5 minutes doubling;
 * always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;
/** A device of the local network is paused 30 minutes at most. */
export const LOCAL_BUSY_MAX = 30 * 60_000;

/** The longest interval: the pace of a source removed from the configuration is kept this long. */
export const MAX_INTERVAL = 60 * 60_000;

/** Sources kept in the state file (the configured ones and recently removed ones). */
export const MAX_SAVED_SOURCES = 8;

/** Refused keys: no cloud call for 6 hours (or until the keys change). */
export const REFUSED_BACKOFF = 6 * 60 * 60_000;

/** A reading older than this (or than 2 intervals) is not published as current. */
export const STALE = 60 * 60_000;

/** An unchanged value is re-sent this often, so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;

/** The core accepts 300 states per minute: the integration keeps a margin. */
export const STATES_PER_MINUTE = 250;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 100_000;

/** Where the pace, the pauses and the refusals survive a restart. */
export const STATE_FILE = '/data/weatherlink-state.json';

/** Device types of the external ids (`ext:<selector>:<type>:<id>`). */
export const DEVICE_TYPES = {
  CLOUD: 'station',
  LOCAL: 'live',
};

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

export const SOURCES = ['cloud', 'local'];
