# Flight visualizer

Pick two US airports and see the great-circle path next to the airway route air traffic control
prefers, built from public FAA navigation data. The app is a static page (no server, no API keys).
**Educational only. Not for flight planning or navigation.**

Live copy: https://cloudandsre.com/portfolio/aiml-501/flight-paths/ (AIML-501 portfolio, Indiana Wesleyan University).
Built with AI-assisted coding.

## Layout

```
app/                    the static site: index.html, js/, vendor/ (Leaflet 1.9.4, BSD-2), data/
  js/route-engine.js    geometry, route expansion, A* over airways (pure, unit-tested)
  js/app.js             map and UI
  data/                 generated JSON (airports, points, airways, routes, meta)
scripts/
  build-data.mjs        data pipeline
  nasr.mjs              CSV parsers for the FAA NASR files
  test/engine.test.mjs  unit tests
.github/workflows/flight-data.yml   rebuilds data from the FAA and opens a PR
```

## Commands (Node 22+)

```sh
npm test                 # 18 unit tests
npm run data:seed        # airports only, from OurAirports (no FAA access needed)
npm run data:build       # full build from the FAA NASR 28-Day Subscription (needs unzip + network)
node scripts/build-data.mjs --cycle 2026-10-29
node scripts/build-data.mjs --local-dir ~/Downloads/nasr   # use files you downloaded yourself
npm run serve            # preview at http://localhost:3000
```

## Data sources

| FAA file | Used for |
| --- | --- |
| `APT_BASE.csv` | airport ids, names, coordinates |
| `FIX_BASE.csv`, `NAV_BASE.csv` | fixes and navaids |
| `AWY_SEG_ALT.csv` | airway segments, chained into ordered point lists |
| `PFR_SEG.csv`, `PFR_BASE.csv` | preferred routes between airport pairs |

From the [NASR 28-Day Subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/).
Each group is fetched as `{dd}_{Mon}_{yyyy}_{GROUP}_CSV.zip` from `https://nfdc.faa.gov/webContent/28DaySub/extra/`
(override with `--base-url`). Seed airports: [OurAirports](https://github.com/davidmegginson/ourairports-data) (public domain).
Map tiles © OpenStreetMap contributors.

## Known uncertainties

- Column names and the download URL pattern were **not verified against live FAA files** when this was written.
  The parsers fail with the list of real headers if a column is missing, so the first real run shows what to adjust in `scripts/nasr.mjs`.
- Duplicate fix ids: first wins (navaids before fixes). Airway gaps split a segment.
- The graph search ignores one-way airways and altitude limits. SIDs and STARs are not drawn.
- Routes crossing the antimeridian (some Alaska flights) are not handled.
