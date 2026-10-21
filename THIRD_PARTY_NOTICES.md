# Third-party notices

This integration is licensed under Apache-2.0 (see `LICENSE`). It ports to
JavaScript parts of the following projects, both under the MIT license.

## astrandb/weatherlink

- Project: https://github.com/astrandb/weatherlink (Home Assistant custom
  integration, commit 3ab2be8 of 2026-10-20, version 2026.9.0)
- Author: Åke Strandberg
- Ported: the use of the WeatherLink API v2 (`pyweatherlink.py`: the routes
  `stations` and `current/{station_id}`, the `api-key` query parameter and
  the `X-Api-Secret` header) and the reading of its sensor records
  (`__init__.py`: the field names of the data structures 2, 6, 10, 12, 16,
  19, 21, 23 and 25 for the outdoor transmitter, the console, the
  barometer, the soil stations and the AirLink).
- Changes: rewritten in JavaScript; the field names are looked up by
  presence rather than by sensor type; read only; answers bounded in size;
  the secret never logged; the calls paced under the published rate limits.
- License: MIT, reproduced below.

```
MIT License

Copyright (c) 2021 Åke Strandberg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## siku2/hass-weatherlink

- Project: https://github.com/siku2/hass-weatherlink (Home Assistant custom
  integration, commit 63f8f36 of 2026-08-06)
- Author: Simon Berger
- Ported: the reading of the local API of the WeatherLink Live and the
  AirLink (`api/rest.py`: `GET /v1/current_conditions` and its
  `data` / `error` envelope; `api/conditions/`: the records of the data
  structures 1 to 4 and 6, the rain bucket counts and the collector sizes,
  the conversions °F to °C, mph to km/h and inHg to hPa), and the examples
  of answers of its tests, used in the tests here.
- Changes: rewritten in JavaScript; the UDP real-time broadcast is not
  used; the serial number of each answer is checked; read only; answers
  bounded in size.
- License: MIT, reproduced below.

```
MIT License

Copyright (c) 2021 Simon Berger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
