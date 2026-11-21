// Builds the trip planner's small lookup files in public/data/ from the reclaim.city mirror:
//   places.json      searchable destinations: [name, lat, lon, kind]  (kind: a area, r station,
//                    h hospital, c college, m market, t landmark, b bus station, w worship, x airport)
//                    Source: reclaim's OSM-derived place list (https://maps.reclaim.city/assets/busmap/places/delhi.json,
//                    OpenStreetMap contributors, ODbL) -> data/reclaim/places.json
//   route_freq.json  route_id -> [trips per day, first, last] from data/reclaim/timings.json
//                    (https://maps.reclaim.city/delhi/data/timings.json). Used only to estimate waits.
// Route IDs are reclaim's, which match the live feed. Nothing from the 2023 DTC archive is used.
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'data', 'reclaim');
const OUT = path.join(__dirname, '..', 'public', 'data');

const places = JSON.parse(fs.readFileSync(path.join(SRC, 'places.json'), 'utf8')).places;
const slim = [];
const seen = new Set();
for (const p of places) {
  const [name, lat, lon, kind] = p;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const key = name.toLowerCase() + '|' + kind;
  if (seen.has(key)) continue;
  seen.add(key);
  // English alternates only (keeps search useful without shipping every script)
  const alts = (p[4] ? String(p[4]).split('|') : []).filter((a) => /^[\x20-\x7e]+$/.test(a) && a.toLowerCase() !== name.toLowerCase());
  slim.push(alts.length ? [name, +lat.toFixed(5), +lon.toFixed(5), kind || 'a', alts.slice(0, 3).join('|')] : [name, +lat.toFixed(5), +lon.toFixed(5), kind || 'a']);
}
fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify(slim));

const timings = JSON.parse(fs.readFileSync(path.join(SRC, 'timings.json'), 'utf8'));
const freq = {};
for (const [rid, t] of Object.entries(timings)) {
  if (!t || !t.trips) continue;
  freq[rid] = [t.trips, t.first || '', t.last || ''];
}
fs.writeFileSync(path.join(OUT, 'route_freq.json'), JSON.stringify(freq));

console.log('places', slim.length, fs.statSync(path.join(OUT, 'places.json')).size);
console.log('route_freq', Object.keys(freq).length, fs.statSync(path.join(OUT, 'route_freq.json')).size);
