// Feed logic: live GTFS-RT from Delhi OTD (user's key, primary), with the
// reclaim.city public mirror as fallback and as the trip-updates (ETA) source.
const fs = require('fs');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const FEED_URL = 'https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb';
const RECLAIM_VP = 'https://maps.reclaim.city/delhi/rt/vehicle_positions.pb';
const RECLAIM_TU = 'https://maps.reclaim.city/delhi/rt/trip_updates.pb';
const CACHE_MS = 10 * 1000; // upstream updates roughly every 10-30s

let cache = { at: 0, payload: null };
let tuCache = { at: 0, payload: null };
let demoTrips = null;
let routesById = null;
let routeNames = null;

function loadJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', name), 'utf8'));
  } catch {
    return null;
  }
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

async function fetchPb(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer()));
}

function vehiclesFromFeed(feed, label) {
  const buses = [];
  for (const entity of feed.entity || []) {
    const v = entity.vehicle;
    if (!v || !v.position || v.position.latitude == null) continue;
    const routeId = (v.trip && v.trip.routeId) || '';
    buses.push({
      id: (v.vehicle && v.vehicle.id) || entity.id,
      route_id: routeId,
      route: label(routeId),
      lat: v.position.latitude,
      lon: v.position.longitude,
      bearing: v.position.bearing || 0,
      speed: v.position.speed || null,
      ts: v.timestamp ? Number(v.timestamp) : null,
    });
  }
  return buses;
}

async function fetchLive() {
  const key = process.env.OTD_API_KEY;
  if (key) {
    const feed = await fetchPb(`${FEED_URL}?key=${encodeURIComponent(key)}`);
    return vehiclesFromFeed(feed, routeLabel);
  }
  return null;
}

// Fallback positions when the user's key/feed is down: reclaim mirror (no key).
async function fetchMirror() {
  const feed = await fetchPb(RECLAIM_VP);
  return vehiclesFromFeed(feed, routeLabel);
}

// Trip updates (real arrival predictions) from the reclaim mirror.
async function getTripUpdates() {
  if (Date.now() - tuCache.at < 15000 && tuCache.payload) return tuCache.payload;
  let payload = null;
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
        .filter((u) => Number.isFinite(u.t));
      trips.push({
        vehicle_id: (tu.vehicle && tu.vehicle.id) || '',
        route_id: tu.trip.routeId || '',
        trip_id: tu.trip.tripId || '',
        updates,
      });
    }
    payload = { updated: new Date().toISOString(), trips };
  } catch (e) {
    payload = { error: String(e.message || e), trips: [] };
  }
  tuCache = { at: Date.now(), payload };
  return payload;
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
        const lat = a[0] + (b[0] - a[0]) * f;
        const lon = a[1] + (b[1] - a[1]) * f;
        const bearing = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        buses.push({
          id: `demo-${t.trip_id}`,
          route_id: t.route_id,
          route: routeLabel(t.route_id),
          lat, lon,
          bearing: (bearing + 360) % 360,
          speed,
          ts: Math.floor(now),
        });
        break;
      }
      acc += seg;
    }
  }
  return { demo: true, count: buses.length, updated: new Date().toISOString(), buses };
}

async function getVehicles() {
  if (Date.now() - cache.at < CACHE_MS && cache.payload) return cache.payload;
  let payload;
  try {
    let buses = await fetchLive();
    let mirror = false;
    if (!buses) {
      try { buses = await fetchMirror(); mirror = true; } catch { buses = null; }
    }
    if (buses) {
      payload = { demo: false, mirror, count: buses.length, updated: new Date().toISOString(), buses };
    } else {
      payload = simulate();
    }
  } catch (e) {
    try {
      const buses = await fetchMirror();
      payload = { demo: false, mirror: true, count: buses.length, updated: new Date().toISOString(), buses };
    } catch (e2) {
      payload = simulate();
      payload.feed_error = String(e.message || e);
    }
  }
  cache = { at: Date.now(), payload };
  return payload;
}

module.exports = { getVehicles, getTripUpdates, routeLabel };
