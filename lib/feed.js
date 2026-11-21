// Feed logic.
//   Positions: Delhi OTD GTFS-RT (OTD_API_KEY, primary) -> reclaim.city public mirror (fallback)
//              -> last good payload (marked stale) -> demo simulation (only if we never had data).
//   Predictions: reclaim.city trip_updates.pb, with its own last-good cache.
// IDs are the feed's own (reclaim static data uses the same ID space). Never mix in other GTFS.
const fs = require('fs');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const FEED_URL = 'https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb';
const RECLAIM_VP = 'https://maps.reclaim.city/delhi/rt/vehicle_positions.pb';
const RECLAIM_TU = 'https://maps.reclaim.city/delhi/rt/trip_updates.pb';

const CACHE_MS = 10 * 1000;          // upstream refreshes every ~10-30 s
const TU_CACHE_MS = 15 * 1000;
const TIMEOUT_MS = 9000;
const FEED_STALE_S = 8 * 60;         // a feed whose header is older than this is considered stuck
const BUS_MAX_AGE_S = 30 * 60;       // drop ghost buses that stopped reporting half an hour ago
const MIN_BUSES = 50;                // fewer than this = broken feed, try the next source
const BBOX = { minLat: 28.2, maxLat: 29.1, minLon: 76.7, maxLon: 77.75 }; // Delhi NCR

let cache = { at: 0, payload: null };
let lastGood = null;                 // last non-demo payload, served (stale) if every source fails
let inflight = null;
let tuCache = { at: 0, payload: null };
let tuLastGood = null;
let tuInflight = null;
let demoTrips = null;
let routesById = null;
let routeNames = null;

function loadJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', name), 'utf8')); } catch { return null; }
}

function getRoutes() {
  if (!routesById) {
    routesById = {};
    for (const r of loadJson('routes.json') || []) routesById[r.id] = r;
  }
  return routesById;
}

function routeLabel(routeId) {
  // reclaim short names (e.g. "102A") match the live feed's ID space best
  if (!routeNames) routeNames = loadJson('route_names.json') || {};
  if (routeNames[routeId]) return routeNames[routeId];
  const r = getRoutes()[routeId];
  if (!r) return routeId || '';
  return r.short_name || r.long_name || routeId;
}

// Never let the API key reach a log line or a client: errors carry the host only.
function safeError(e, url) {
  const host = (() => { try { return new URL(url).host; } catch { return 'upstream'; } })();
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `${host}: timed out`;
  const msg = String((e && e.message) || e || 'error').replace(/key=[^&\s]+/gi, 'key=REDACTED').replace(/https?:\/\/\S+/g, '').trim();
  return `${host}: ${msg}`;
}

async function fetchPb(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'delhi-bus-tracker' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty response');
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
}

function vehiclesFromFeed(feed) {
  const now = Date.now() / 1000;
  const buses = [];
  let dropped = 0;
  const seen = new Set();
  for (const entity of feed.entity || []) {
    const v = entity.vehicle;
    if (!v || !v.position || v.position.latitude == null) continue;
    const lat = v.position.latitude, lon = v.position.longitude;
    const ts = v.timestamp ? Number(v.timestamp) : null;
    const id = (v.vehicle && v.vehicle.id) || entity.id;
    if (!id || seen.has(id)) { dropped++; continue; }
    if (!(lat > BBOX.minLat && lat < BBOX.maxLat && lon > BBOX.minLon && lon < BBOX.maxLon)) { dropped++; continue; }
    if (ts && now - ts > BUS_MAX_AGE_S) { dropped++; continue; }
    seen.add(id);
    const routeId = (v.trip && v.trip.routeId) || '';
    buses.push({
      id,
      route_id: routeId,
      route: routeLabel(routeId),
      lat, lon,
      bearing: v.position.bearing || 0,
      speed: v.position.speed || null,
      ts,
    });
  }
  const headerTs = feed.header && feed.header.timestamp ? Number(feed.header.timestamp) : null;
  return { buses, dropped, headerTs };
}

function check(result, name) {
  const now = Date.now() / 1000;
  if (result.buses.length < MIN_BUSES) throw new Error(`only ${result.buses.length} buses`);
  if (result.headerTs && now - result.headerTs > FEED_STALE_S) throw new Error(`feed stuck since ${Math.round((now - result.headerTs) / 60)} min`);
  return result;
}

async function fromOtd() {
  const key = process.env.OTD_API_KEY;
  if (!key) throw new Error('no OTD_API_KEY');
  const url = `${FEED_URL}?key=${encodeURIComponent(key)}`;
  try { return check(vehiclesFromFeed(await fetchPb(url))); } catch (e) { throw new Error(safeError(e, url)); }
}
async function fromMirror() {
  try { return check(vehiclesFromFeed(await fetchPb(RECLAIM_VP))); } catch (e) { throw new Error(safeError(e, RECLAIM_VP)); }
}

function freshness(buses, headerTs) {
  const now = Date.now() / 1000;
  const ages = buses.map((b) => (b.ts ? now - b.ts : null)).filter((x) => x != null).sort((a, b) => a - b);
  return {
    feed_ts: headerTs ? new Date(headerTs * 1000).toISOString() : null,
    median_age_s: ages.length ? Math.round(ages[ages.length >> 1]) : null,
  };
}

async function load() {
  const errors = [];
  for (const [source, fn] of [['otd', fromOtd], ['mirror', fromMirror]]) {
    try {
      const r = await fn();
      const payload = {
        source, demo: false, mirror: source === 'mirror', stale: false,
        count: r.buses.length, dropped: r.dropped, updated: new Date().toISOString(),
        ...freshness(r.buses, r.headerTs),
        errors: errors.filter((e) => !/no OTD_API_KEY/.test(e)),
        buses: r.buses,
      };
      lastGood = payload;
      return payload;
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  if (lastGood) {
    const ageS = Math.round((Date.now() - Date.parse(lastGood.updated)) / 1000);
    if (ageS < 30 * 60) return { ...lastGood, source: 'cache', stale: true, stale_s: ageS, errors };
  }
  const demo = simulate();
  return { ...demo, source: 'demo', stale: false, errors, feed_error: errors.join('; ') };
}

async function getVehicles() {
  if (Date.now() - cache.at < CACHE_MS && cache.payload) return cache.payload;
  if (!inflight) {
    inflight = load()
      .then((payload) => { cache = { at: Date.now(), payload }; return payload; })
      .finally(() => { inflight = null; });
  }
  return inflight; // concurrent requests share one upstream fetch
}

/* Compact wire format (v2), several times smaller than the verbose one.
   r: route ids, l: labels (same index), b: [id, routeIdx, lat*1e5, lon*1e5, bearing, speed*10 | -1, ts - t0 | -1] */
function compact(p) {
  const rIdx = new Map(), r = [], l = [];
  let t0 = Infinity;
  for (const x of p.buses) if (x.ts && x.ts < t0) t0 = x.ts;
  if (!Number.isFinite(t0)) t0 = Math.floor(Date.now() / 1000);
  const b = p.buses.map((x) => {
    let i = rIdx.get(x.route_id);
    if (i == null) { i = r.length; rIdx.set(x.route_id, i); r.push(x.route_id); l.push(x.route || ''); }
    return [x.id, i, Math.round(x.lat * 1e5), Math.round(x.lon * 1e5), Math.round(x.bearing || 0), x.speed == null ? -1 : Math.round(x.speed * 10), x.ts ? x.ts - t0 : -1];
  });
  const { buses, ...meta } = p;
  return { v: 2, ...meta, t0, r, l, b };
}

// Trip updates (real arrival predictions) from the reclaim mirror.
async function loadTripUpdates() {
  try {
    const feed = await fetchPb(RECLAIM_TU);
    const trips = [];
    for (const entity of feed.entity || []) {
      const tu = entity.tripUpdate;
      if (!tu || !tu.trip) continue;
      const updates = (tu.stopTimeUpdate || [])
        .filter((u) => u.stopId && (u.arrival || u.departure))
        .map((u) => ({
          stop_id: u.stopId,
          t: Number((u.arrival && u.arrival.time) || (u.departure && u.departure.time)),
          delay: (u.arrival && u.arrival.delay) || 0,
        }))
        .filter((u) => Number.isFinite(u.t) && u.t > 0);
      trips.push({ vehicle_id: (tu.vehicle && tu.vehicle.id) || '', route_id: tu.trip.routeId || '', trip_id: tu.trip.tripId || '', updates });
    }
    if (!trips.length) throw new Error('no trip updates');
    const payload = { updated: new Date().toISOString(), stale: false, trips };
    tuLastGood = payload;
    return payload;
  } catch (e) {
    const error = safeError(e, RECLAIM_TU);
    if (tuLastGood && Date.now() - Date.parse(tuLastGood.updated) < 10 * 60 * 1000) return { ...tuLastGood, stale: true, error };
    return { error, stale: true, trips: [] };
  }
}

async function getTripUpdates() {
  if (Date.now() - tuCache.at < TU_CACHE_MS && tuCache.payload) return tuCache.payload;
  if (!tuInflight) {
    tuInflight = loadTripUpdates()
      .then((payload) => { tuCache = { at: Date.now(), payload }; return payload; })
      .finally(() => { tuInflight = null; });
  }
  return tuInflight;
}

// ---- Demo mode: simulate buses gliding along real trip stop sequences ----
function getDemoTrips() {
  if (!demoTrips) demoTrips = loadJson('demo_trips.json') || [];
  return demoTrips;
}

function haversineM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function simulate() {
  const trips = getDemoTrips();
  const now = Date.now() / 1000;
  const buses = [];
  for (const t of trips) {
    if (!t.points || t.points.length < 2) continue;
    const speed = 7 + (t.seed % 5); // 7-11 m/s
    const period = 3600 + (t.seed % 1800);
    const headStart = ((now + t.seed * 137) % period) * speed;
    let acc = 0;
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1], b = t.points[i];
      const seg = haversineM(a, b);
      if (acc + seg >= headStart) {
        const f = seg === 0 ? 0 : (headStart - acc) / seg;
        const bearing = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        buses.push({
          id: `demo-${t.trip_id}`, route_id: t.route_id, route: routeLabel(t.route_id),
          lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f,
          bearing: (bearing + 360) % 360, speed, ts: Math.floor(now),
        });
        break;
      }
      acc += seg;
    }
  }
  return { demo: true, mirror: false, count: buses.length, updated: new Date().toISOString(), buses };
}

module.exports = { getVehicles, getTripUpdates, routeLabel, compact };
