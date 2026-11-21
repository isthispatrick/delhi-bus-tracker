// Builds public/data/* from the reclaim.city Delhi mirror (https://maps.reclaim.city/delhi/).
// Its route/stop ID space matches the live OTD VehiclePositions feed (~96% of buses).
// Usage: download route_stops.json + bus_stops.geojson into data/reclaim/ then run this.
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'data', 'reclaim');
const OUT = path.join(__dirname, '..', 'public', 'data');

const rs = JSON.parse(fs.readFileSync(path.join(SRC, 'route_stops.json'), 'utf8'));
const bs = JSON.parse(fs.readFileSync(path.join(SRC, 'bus_stops.geojson'), 'utf8'));

// stops.json: slim stop list
const stops = bs.features.map((f) => ({
  id: String(f.properties.stop_id),
  name: f.properties['Stop Name'] || '',
  lat: f.geometry.coordinates[1],
  lon: f.geometry.coordinates[0],
})).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
fs.writeFileSync(path.join(OUT, 'stops.json'), JSON.stringify(stops));

// route_patterns.json: route_id -> {sn, d:[{from,to,stops:[[id,name,lat,lon]..]}]}
const patterns = {};
const stopRoutes = new Map();
for (const [rid, r] of Object.entries(rs)) {
  const dirs = (r.d || [])
    .map((d) => ({
      from: d.o || '', to: d.e || '',
      stops: (d.s || []).map((x) => [String(x[0]), x[1], x[2], x[3]]),
    }))
    .filter((d) => d.stops.length >= 2);
  if (!dirs.length) continue;
  patterns[rid] = { sn: r.sn || '', d: dirs };
  for (const dir of dirs) {
    for (const s of dir.stops) {
      let set = stopRoutes.get(s[0]);
      if (!set) { set = new Set(); stopRoutes.set(s[0], set); }
      set.add(rid);
    }
  }
}
fs.writeFileSync(path.join(OUT, 'route_patterns.json'), JSON.stringify(patterns));

const sr = {};
for (const [sid, set] of stopRoutes) sr[sid] = [...set];
fs.writeFileSync(path.join(OUT, 'stop_routes.json'), JSON.stringify(sr));

console.log('stops:', stops.length, fs.statSync(path.join(OUT, 'stops.json')).size);
console.log('patterns:', Object.keys(patterns).length, fs.statSync(path.join(OUT, 'route_patterns.json')).size);
console.log('stop_routes:', Object.keys(sr).length, fs.statSync(path.join(OUT, 'stop_routes.json')).size);
