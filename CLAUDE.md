# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads Davis weather stations, read only, through the official WeatherLink
API v2 (after astrandb/weatherlink, MIT) or the local API of the WeatherLink
Live and the AirLink (after siku2/hass-weatherlink, MIT).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        WeatherLinkApp: sources, due times, pauses, devices, states, status, test
src/weatherlink.js                cloud (API v2) and local GET routes, error kinds, identity checks
src/fields.js                     records -> groups, values in core units, devices, states (pure)
src/store.js                      pace, pauses, refusals, stations met, persisted in /data (never a secret)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/http.js                       fetch with timeout, no redirection, bounded body
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** Only `GET /v2/stations`, `GET /v2/current/{id}` and
  `GET /v1/current_conditions`; never a writing route, never the UDP
  real-time broadcast.
- **The API secret never leaves in a URL**: only in the `X-Api-Secret`
  header, to `api.weatherlink.com`. Neither the key nor the secret in a log,
  an error, a status nor `/data` (only a salted scrypt fingerprint of keys
  while they are refused). Never describe a secret field as "encrypted":
  Gladys keeps it in clear in its database (`test/manifest.test.js` checks
  the manifest and the docs).
- **Pace.** Never read a source before its last request + the interval
  (test button, reconnection, saved configuration, Discovery, restart); the
  instant of a request is written to `/data` before it leaves, at most once
  per minute. Cloud calls stay under 600 an hour and 5 a second.
- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`: `station:c<station id>-<lsid>`
  (cloud), `live:<serial number>-<lsid>` (local), `-console` for the console
  group. The feature keys (`temperature`, `rain_today`...) belong to this
  integration, never a WeatherLink field name. The same goes for every key
  users store: manifest `config_schema`, `actions`.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), and never
  drop a feature of a created device from the Discovery list.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
