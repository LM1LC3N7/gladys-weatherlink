# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real WeatherLink account and a real
      WeatherLink Live: the devices of the Discovery tab, their values, the
      status, the test button, wrong keys, a station removed from the
      account. Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published (at milestone 1 its only
      expected error is `docker_image` not yet pullable from GHCR). The
      validator was not run by the development agent (no access to it) and
      the Docker image was never built locally (no Docker on the
      development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm on a real station

- [ ] The exact records of `current/{station}` for each hardware (data
      structures 2, 6, 10, 12, 16, 19, 21, 23, 25): the field names this
      integration looks for (`temp`/`temp_out`, `rainfall_day_mm`,
      `rainfall_daily_in`, `rain_day_in`, `bar_sea_level`/`bar`...).
- [ ] What WeatherLink answers past the rate limit (429? `Retry-After`?)
      and with a station shared without API access (403 or 404?). Both are
      handled.
- [ ] Whether a 403 on `/v2/stations` ever means anything else than keys
      refused.
- [ ] The local `lsid` of a WeatherLink Live: the same as the cloud one?
      (Only matters to someone switching from cloud to local: the devices
      differ anyway, by design.)
- [ ] An AirLink read through the cloud: its data structure 16 fields
      (`pm_2p5`, `pm_10`, `aqi_val`).

## Waiting for the Gladys core

- [ ] Rain totals (storm, month, year): the `precipitation-sensor` category
      lists only mm/h, mm per day and mV; the core has no unit for a rain
      total.
- [ ] Soil moisture in centibars, leaf wetness (0-15), PM1, the solar
      radiation in W/m², evapotranspiration: no category or unit for them
      yet (the solar radiation is shown in lux meanwhile).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-weatherlink:0.1.0`); the first patch release
  gives 0.1.1.
- **References**: astrandb/weatherlink (MIT, Åke Strandberg, commit
  3ab2be8 of 2026-10-20) for the API v2, siku2/hass-weatherlink (MIT, Simon
  Berger, commit 63f8f36 of 2026-08-06) for the local API; licenses read in
  their LICENSE files, cloned read only in `_ref`. Ported to JavaScript,
  credited in the docs and in `THIRD_PARTY_NOTICES.md` with both MIT
  notices (copied into the image with `LICENSE`). The neighbour module is
  gladys-ambient-weather (devices per sensor group, conversions, state
  budget); the pace and the persisted state follow gladys-air-q (lot 11).
- **Read only**: three GET routes; no command, so no sensitive command. The
  UDP real-time broadcast of the WeatherLink Live is not used (it needs a
  request every 20 minutes and UDP in the container).
- **One source at a time** (`source`: cloud or local), so one station is
  never published twice under two ids. Switching later creates other
  devices (documented).
- **Authentication (official docs)**: the API key in the `api-key` query
  parameter, the secret in the `X-Api-Secret` header (no more HMAC
  signature). The key is a `string` field (it is shown on the account page
  and useless alone), the secret a `secret` field, described as "kept by
  Gladys in its database, never shown again", never "encrypted". Error
  messages carry the host of the URL only, never its query; messages are
  scrubbed of both anyway.
- **Rate limits (official docs: 10 calls per second, 1,000 per hour)**:
  0.2 s between the calls of a cycle; the interval is stretched so that an
  hour stays under 600 calls (one per station and per cycle; with the 10
  stations maximum, 1 minute is still allowed); the station list every 6
  hours only. Default interval 5 minutes (1 to 60).
- **Pace (lot 11 lessons)**: the instant of every cycle is recorded and
  written to `/data` before the requests leave; nothing reads a source
  before that instant + the interval: not the test button (it then shows
  the last values and the time of the next possible read), a reconnection,
  a saved configuration, the Discovery tab (it publishes what is known,
  with no call) nor a restart. A reconnection during a read starts no
  other read. Only new keys or a new address are read at once (told apart
  in memory; after a restart, only against keys still refused).
- **State file written at most once per minute for the request instants**:
  a read waits until 60 s have passed since the previous write (whatever
  it was; the instant of the write is kept in the file, so a restart loop
  obeys it too). A pause, a refusal, their end or a new station is written
  at once, at most once per request, so a restart never forgets a 429.
- **Late answers**: a generation is checked after every await; an answer
  of an old configuration or client publishes nothing and sets no status
  (only a 429/5xx pause is kept when the same keys are still configured).
- **Identity**: local values are published under the serial number (`did`)
  of the answer; another serial number at the same address is another
  station, never the first one; an answer without a readable serial number
  is "not a WeatherLink answer" (never "another device"). A cloud answer
  must name the station asked for.
- **Errors**: 401/403 on the station list, 401 on a station = keys refused
  (stop, one try every 6 hours, persisted, salted fingerprint of the
  refused pair only while refused); 403/404 on one station = that station
  only, the list is read again at the next cycle; 429 = pause of the
  account; 5xx on one station = that station only, on every station =
  pause; network = retried at the interval. Pauses: `Retry-After`, else 5
  minutes doubling, 1 minute to 6 hours, read back capped.
- **Devices**: one per sensor group (outdoor transmitter, console, AirLink,
  soil station), external ids `station:c<station id>-<lsid>` /
  `live:<serial>-<lsid>` and `-console`; the feature keys are names of this
  integration. Groups found by the fields a record holds, not by sensor
  type numbers (new hardware with the same fields just works).
- **Categories and units of the core only** (checked by
  `test/manifest.test.js` and the SDK's fake Gladys): temperature °C
  (soil: `probe`, out of the room average), humidity %, pressure hPa
  (inHg × 33.8639), wind km/h (mph × 1.609344), rain rate mm/h, rain today
  and of the last 24 hours mm per day (cloud: `_mm`, else `_in` × 25.4;
  local: bucket counts × the collector size of `rain_size`, unknown size =
  no value), UV index (integer), solar radiation in lux (W/m² ÷ 0.0079, as
  the approved Ambient Weather module), PM2.5/PM10 µg/m³, AQI. The core
  lists no unit for `angle-sensor`: `degree`, as Ambient Weather.
  Metric only: no imperial option.
- **Left out**: the dew point, heat index, wind chill, THW/THSW (a
  temperature that would skew the room temperature), the rain totals, soil
  moisture, leaf wetness, PM1, the health records of the console.
- **Values**: a value out of the feature bounds is left out, never clamped;
  a reading older than 1 hour (or 2 intervals) is not published; a time in
  the future counts as now. Never NaN, null or undefined published. Only
  own fields are read (`Object.hasOwn`): no prototype pollution.
- **Bounded answers**: 512 KB, 10 s per request (body included), the
  chunks joined once; at most 10 stations, 40 sensors per station, 1,000
  entries of a station list looked at.
- **Privacy**: of the station list, only the id and the name are kept (the
  answer also holds the e-mail address and the position of the owner).
- **Features never lost**: the Discovery device holds every field ever read
  plus every feature of the created device (`gladys.devices`); the stations
  met are kept under `/data`, so the Discovery list is filled after a
  restart.
- **Status and Discovery republished at each `connected`** (the core keeps
  them in memory only); the pace, pauses and refusals are kept.
- **States**: only the created features, only what changed (heartbeat 30
  minutes), at most 250 per minute (the core accepts 300), the budget
  reserved before each await.

- **Review 1 fixes**:
  - B1: a record is `outdoor` as soon as it holds an ISS marker
    (`temp_out`, `hum_out`, `temp`, `wind_speed`, `wind_speed_last`,
    `rain_size`, `bar`): a Vantage Pro2 record of structure 2 always
    carries null soil and leaf keys, and was taken for a soil station.
  - I1: a source removed from the configuration keeps its pace (last
    request, pause, refusal, fingerprint) while any of it runs (the last
    request + 60 min, the longest interval), only its stations are dropped;
    the file keeps 8 sources at most (the oldest removed ones go first).
  - I2: extra temperatures are `probe` (out of the room average), like the
    soil ones; the main ISS temperature stays `decimal` (the docs ask to put
    the device in an "Outside" room); extra humidities stay averaged by the
    core (no type filter for humidity), said in the docs.
  - M1: a 403 on a station re-reads the list once, 30 minutes later, then
    waits for the 6-hour refresh (no write when nothing changes).
  - M2: a local device answering 5xx is paused 30 minutes at most.
  - M3: local records with `rx_state` 2 (transmitter searched for, lost)
    are skipped; in the cloud, `last_packet_received_timestamp` dates the
    record when given. To confirm on a real station.
  - M5: a key or a secret with a character outside printable ASCII is
    "not valid" at once and never sent.

## Ideas

- The UDP real-time broadcast of the WeatherLink Live (wind every 2.5 s).
- The rain totals and the solar radiation in W/m² once the core has units
  for them.
- The historic endpoint of the API v2 (daily summaries).
- An imperial option for the temperatures (°F is a core unit).
