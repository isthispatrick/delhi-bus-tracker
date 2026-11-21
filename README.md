# Delhi Bus Tracker

Live map of Delhi's buses, built on the Delhi government's Open Transit Data (GTFS-RT) feed and Mapbox.

## What it does
- Plots every bus reporting to the Delhi OTD VehiclePositions feed (~2,500-3,000 buses) on a Mapbox map, refreshed every 15 seconds
- Tap a bus: route badge, From → To direction, speed, last update, progress along route, next stops with live predicted times, Follow mode
- Locate button: nearest stops and the next buses arriving, using real GTFS-RT trip-update predictions where available (position-based estimates otherwise, marked "est")
- 3D view toggle (tilt + building extrusions)
- Direction arrows on buses when zoomed in, clean route short names (534, 102A, AIRPORT-EXP-04)
- Route search with endpoint names; deep links `#bus=<id>`, `#near=<lat>/<lon>`, `#3d`
- Bus stops appear when you zoom in
- Fallbacks: if the OTD key/feed is down, positions come from the reclaim.city public mirror; if both fail, demo mode simulates buses along real trip paths

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `OTD_API_KEY` - private key from https://otd.delhi.gov.in/data/realtime/
   - `MAPBOX_TOKEN` - public token from https://console.mapbox.com/
3. `npm start` and open http://localhost:3000

## Deploy (Vercel)
The repo is zero-config: `public/` is served statically and `api/*.js` run as serverless functions. Set `OTD_API_KEY` and `MAPBOX_TOKEN` as environment variables in the Vercel project.

## Data
- Live positions: https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb (GTFS-RT, own key, primary)
- Live fallback + arrival predictions: https://maps.reclaim.city/delhi/rt/ (public mirror, no key; trip_updates.pb powers next-bus times)
- Route stop sequences, stops, short names: derived from the reclaim.city Delhi mirror (`data/reclaim/`, whose IDs match the live feed for ~96% of buses) by `scripts/prepare-reclaim.js` into `public/data/`
- Legacy static data: `data/routes.json`, `data/stops.json`, `data/demo_trips.json` (OpenDTC mirror + 2023 DTC archive; used for demo mode and name fallbacks). Official OTD static download (https://otd.delhi.gov.in/data/static/) is currently broken.

## Note on times
Delhi has no true arrival-prediction system for buses. Next-bus times come from GTFS-RT trip updates (reclaim mirror) or, marked "est", from the bus's live position and speed along its route. Treat them as rough.
