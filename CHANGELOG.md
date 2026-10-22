# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- A refusal of the keys or a 429 pause is no longer forgotten after trying
  several local addresses in a row: the state file under `/data` keeps the
  configured sources first, then those holding a pause or a refusal, and
  only then the other recently removed ones. Back to the cloud with the
  same refused keys, nothing is sent before the end of the refusal.

## [0.1.1] - 2026-10-21

### Added

- Your Davis weather stations in Gladys (Vantage Pro2, Vantage Vue,
  WeatherLink Live, WeatherLink Console, AirLink), read only, either through
  the official WeatherLink API v2 (API key and secret of your account, every
  station of the account, ten at most) or locally from a WeatherLink Live or
  an AirLink (up to three addresses).
- One device per sensor group: outdoor sensors (temperature, humidity, wind
  speed, average and gust, wind direction, rain rate, rain today and of the
  last 24 hours, solar radiation, UV index, battery, and the extra sensors of
  a Vantage Pro2 logger), console (inside temperature and humidity,
  pressure), AirLink (PM2.5, PM10, air quality index) and soil stations, in
  the units Gladys lists (°C, km/h, hPa, mm/h, mm per day...).
- Read every 5 minutes by default, never faster: not by the test button, a
  reconnection, a saved configuration, the Discovery tab nor a restart (the
  instant of the last request is kept under `/data`, written at most once
  per minute); the cloud calls stay under the WeatherLink rate limits.
- A 429 or 5xx pauses the reads (Retry-After, else 5 minutes doubling,
  between 1 minute and 6 hours); refused keys stop them, with one new try
  every 6 hours until they change. Both survive a restart; the key and the
  secret are never written under `/data` nor in the logs.
- Local values are published under the serial number of the device that
  measured them: two devices that swap their addresses never mix their
  values. One cloud station that fails alone never stops the others.
- Clearing the key, switching to local and back or saving the
  configuration never lifts a pause nor a refusal. A key or a secret with a
  line break or a non-ASCII character is reported as not valid, never sent.
- The extra temperatures of a Vantage Pro2 and the soil temperatures are
  probes, kept out of the room temperature average; a lost transmitter
  publishes no value.
- A connection status that names the stations without value and why, and a
  "Test WeatherLink" button that reads what is due and shows the last values
  and the time of the next possible read.

[Unreleased]: https://github.com/LM1LC3N7/gladys-weatherlink/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-weatherlink/releases/tag/v0.1.1
