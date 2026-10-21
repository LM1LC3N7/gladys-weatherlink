# gladys-weatherlink

[Gladys Assistant](https://gladysassistant.com) external integration for the
**Davis** weather stations (Vantage Pro2, Vantage Vue, WeatherLink Live,
WeatherLink Console, AirLink): temperature, humidity, wind, rain, pressure,
UV, solar radiation and particulate matter, read through the official
[WeatherLink API v2](https://weatherlink.github.io/v2-api/) or the local API
of the WeatherLink Live and the AirLink. Read only. **Unofficial, not
affiliated with Davis Instruments. Never tested with a real station yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (WeatherLinkApp)  what is due, pauses, devices, states, status, test button
                 ├─ src/weatherlink.js        GET /v2/stations, /v2/current/{id}, /v1/current_conditions; error kinds
                 ├─ src/fields.js             records -> groups, values in core units, devices, states (pure)
                 ├─ src/store.js              pace, pauses, refusals, stations met, persisted in /data
                 ├─ src/config.js             DEFAULT_CONFIG + normalization of the configuration
                 └─ src/http.js               fetch, timeout, no redirection, bounded body
```

- **Cloud (API v2)**: the key in the `api-key` query parameter, the secret
  in the `X-Api-Secret` header (never in a URL nor a log). The station list
  every 6 hours, then `current/{station}` for each (10 at most), 0.2 s
  apart; the interval is stretched to stay under 600 calls an hour
  (WeatherLink allows 1,000). Each answer must name the station asked for.
- **Local**: `GET http://<address>/v1/current_conditions` on a WeatherLink
  Live or an AirLink; the values are published under the serial number
  (`did`) of each answer, so two devices that swap their addresses never
  mix their values.
- **Pace**: 5 minutes by default; never faster than the interval since the
  last request (persisted before it leaves, written at most once per
  minute), test button, reconnections and restarts included.
- **Pauses**: 429/5xx → `Retry-After`, else 5 minutes doubling, between
  1 minute and 6 hours; refused keys → one try every 6 hours (or at once
  with new keys). One station that fails alone never stops the others.
  Persisted in `/data/weatherlink-state.json`, never the key nor the secret
  (only while they are refused, a salted scrypt fingerprint of the refused
  pair, erased by the first successful read).
- **Devices**: one per sensor group (`station:c<id>-<lsid>`,
  `station:c<id>-console`, `live:<serial>-<lsid>`...), then a feature key of
  this integration (`temperature`, `rain_today`...). Units of the core only.
  A feature once created is never dropped from the Discovery list.

No runtime dependency besides the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network, no disk
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

The test answers follow the examples of the official documentation and of the
two Home Assistant integrations below.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- [astrandb/weatherlink](https://github.com/astrandb/weatherlink) (MIT, Åke
  Strandberg): the use of the API v2 and its sensor records.
- [siku2/hass-weatherlink](https://github.com/siku2/hass-weatherlink) (MIT,
  Simon Berger): the local API of the WeatherLink Live and the AirLink.

Their notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). Davis, Vantage Pro2, Vantage Vue,
WeatherLink and AirLink are trademarks of their owner.
