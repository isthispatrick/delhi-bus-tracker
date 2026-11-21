# Delhi Bus Tracker

Live map of Delhi's buses with a destination search and a walk + bus + metro trip planner. Built on the Delhi government's Open Transit Data (GTFS-RT) feed and Mapbox. Static frontend, no framework; small Node API on Vercel.

## What it does
- **Live map**: every bus reporting to the feed (~3,500-4,400) on a dark Mapbox map, refreshed every 15 s. Buses glide continuously between updates (no jumps). Zoomed out they are dots, then heading markers with route chips, and from zoom 13.6 instanced 3D bus models facing their direction of travel.
- **Search places or routes** in one box: "Dyal Singh College", "Nehru Place", "534", "AIRPORT". Local results (metro stations, landmarks, bus stops) appear instantly; Mapbox Search Box POIs (bounded to Delhi NCR, biased to your location) follow.
- **Destination results**: every direct route from a stop near you (≤850 m) to a stop near the destination (≤650 m), best total time first. Each option shows the board stop and walk, the next catchable bus (live prediction or position estimate), ride time, get-off stop and final walk. Only the live buses on those routes that are heading toward the destination and have not passed it stay on the map. Tap an option to highlight its route, buses and walking legs, then follow the next bus.
- **Trip planner**: when there is no direct bus, or a metro route is much faster, it offers journeys with a change (bus+bus, bus+metro, metro+metro) as step-by-step cards drawn on the map. Bus legs are live; **metro legs are scheduled only** (labelled "Scheduled", no live metro times or countdowns).
- **Bus sheet**: tap a bus for direction, progress, next stops with live predicted times, Follow, whole route, share link.
- **Near me / stops**: nearest stops with the next buses; tap any stop for its arrivals.
- **Feed health**: status pill shows the count, last update and an "updating" pulse; banners for backup feed, stale data, demo mode, or offline.
- Deep links: `#bus=<id>`, `#near=<lat>/<lon>`, `#3d`, `#route=<no>`, `#from=<lat>/<lon>&to=<place>` (e.g. `#from=28.5686/77.2206&to=Dayal Singh College`).

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `OTD_API_KEY` - private key from https://otd.delhi.gov.in/data/realtime/ (optional locally: without it the reclaim mirror is used)
   - `MAPBOX_TOKEN` - public token from https://console.mapbox.com/
3. `npm start` and open http://localhost:3000 (try http://localhost:3000/#3d)
4. Planner check (offline, no server): `node scripts/check-planner.js 10:00`

## Deploy (Vercel)
Zero-config: `public/` is served statically and `api/*.js` run as serverless functions. Set `OTD_API_KEY` and `MAPBOX_TOKEN` in the Vercel project. Pushing a branch deploys a preview.

## API
- `GET /api/vehicles` - `{source, demo, mirror, stale, count, updated, feed_ts, median_age_s, errors, buses:[...]}`
- `GET /api/vehicles?v=2` - same data in a compact form the app uses (route-id dictionary, 1e-5 integer coordinates; ~66 KB gzipped vs ~117 KB)
- `GET /api/arrivals?stop_id=…` / `?stop_ids=a,b,c` / `?vehicle_id=…` - live predictions from trip updates
- `GET /api/config` - public Mapbox token

### Feed robustness (`lib/feed.js`)
OTD feed (key) → reclaim mirror → last good payload (served with `stale: true` for up to 30 min) → demo simulation (only if there was never any data). A source is rejected if it returns fewer than 50 buses or its header timestamp is over 8 minutes old. Buses outside Delhi NCR, duplicates, and positions older than 30 minutes are dropped. Concurrent requests share one upstream fetch; the CDN caches responses for 8 s. Error messages never include the API key.

## Data
All static data uses reclaim.city IDs, which match the live feed. The 2023 DTC archive GTFS is **not** used for routing.

| File | What | Built by |
|---|---|---|
| `public/data/stops.json` | 6,778 bus stops | `scripts/prepare-reclaim.js` from `data/reclaim/bus_stops.geojson` |
| `public/data/route_patterns.json` | 2,554 routes: short name, direction, ordered stops | `scripts/prepare-reclaim.js` from `data/reclaim/route_stops.json` |
| `public/data/stop_routes.json` | stop → routes | `scripts/prepare-reclaim.js` |
| `public/data/route_freq.json` | trips/day, first and last departure (for wait estimates) | `scripts/prepare-planner.js` from `data/reclaim/timings.json` |
| `public/data/places.json` | 2,156 searchable places (areas, stations, colleges, hospitals, landmarks) | `scripts/prepare-planner.js` from `data/reclaim/places.json` |
| `public/data/metro.json` | 12 metro lines with ordered stations and geometry | `scripts/prepare-metro.js` from `data/reclaim/metro_lines.geojson` + `data/osm/metro_stations.json` |

Sources (download into `data/reclaim/`, which is git-ignored, then run the scripts):
- `https://maps.reclaim.city/delhi/data/route_stops.json`, `bus_stops.geojson`, `timings.json`, `metro_lines.geojson`
- `https://maps.reclaim.city/assets/busmap/places/delhi.json` → `data/reclaim/places.json`
- `data/osm/metro_stations.json` is committed: an OpenStreetMap Overpass extract of metro stations (RapidX excluded).
- Live: `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb` (key) and `https://maps.reclaim.city/delhi/rt/vehicle_positions.pb`, `trip_updates.pb` (no key).
- Legacy: `data/routes.json`, `data/stops.json`, `data/demo_trips.json` (OpenDTC / 2023 DTC archive) are only used for demo mode and label fallbacks.

## How the planner works (`public/planner.js`)
A small frequency-based RAPTOR. Each round adds one ride over bus pattern directions and metro lines (both directions). A ride costs the expected wait plus in-vehicle time:
- Buses: wait is half the headway from trips/day (3-20 min); routes outside their first-last service window are skipped. Speed is 15.5 km/h with a 1.2× road factor plus 15 s per stop.
- Metro: scheduled only, 4 min typical wait, ~34 km/h (Airport Express faster), 3 min for platform changes. No metro after ~23:30.
- Walking: 1.2 m/s with a 1.3× street factor; up to 1.1 km at each end, 300 m bus↔bus and 550 m to/from metro.
- Each extra boarding adds a 4 min penalty for ranking. Results keep the fastest option per number of changes and always include a bus-only option.

Metro stations come from OpenStreetMap and are snapped onto reclaim's line geometry. Same-name stations become interchanges (Rajiv Chowk, Kashmere Gate, Lajpat Nagar…). A few stations missing from OSM, or on stretches the geometry doesn't cover, are not routable.

## Note on times
Delhi has no true arrival-prediction system for buses. Next-bus times come from GTFS-RT trip updates (reclaim mirror), marked **Live**, or from the bus's position along its route, marked **Est**. Metro times are typical scheduled estimates. Treat all times as rough.

## Credits
- 3D bus model: "Low-poly City - Bus" by Innerscene (https://www.innerscene.com/tools/library/3d-parts/low-poly-city-bus-49c04273), CC0. Sourced 2026-11-21 (`public/bus.glb`), recoloured at runtime.
- Live data: Delhi Open Transit Data (IIIT-Delhi / Delhi Transport Dept); reclaim.city public mirror for positions, trip updates, route/stop data, timings and metro line geometry.
- Metro stations and searchable places: © OpenStreetMap contributors, ODbL.
- Maps and place search: Mapbox.
