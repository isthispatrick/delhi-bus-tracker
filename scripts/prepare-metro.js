// Builds public/data/metro.json: Delhi NCR metro lines with ordered stations, for the
// trip planner (scheduled service only, no live metro data).
//
// Inputs
//   data/reclaim/metro_lines.geojson  line geometry + colours (reclaim.city Delhi mirror,
//                                     https://maps.reclaim.city/delhi/data/metro_lines.geojson)
//   data/osm/metro_stations.json      station points (OpenStreetMap, ODbL; Overpass extract)
//
// Each station is snapped onto every line that passes within SNAP_M of it and ordered by
// its distance along that line. Stations with the same name within MERGE_M are one node,
// so interchanges (Rajiv Chowk, Kashmere Gate...) fall out of the data.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lines = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reclaim', 'metro_lines.geojson'), 'utf8'));
const osm = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'osm', 'metro_stations.json'), 'utf8')).stations;

const SNAP_M = 160;      // any line passing this close to a station serves it
const NEAREST_M = 450;   // ...or further, when it is the station's nearest line (coarse geometry)
const HINT_M = 700;      // ...or further still, when OSM names the line: "Lajpat Nagar (Violet Line)"
const MERGE_M = 700;     // same-name points closer than this are one station
// names that OSM spells differently for one interchange
const ALIAS = { 'new delhi airport express terminal': 'new delhi', 'new delhi airport express': 'new delhi' };

const toRad = (d) => (d * Math.PI) / 180;
function hav(a, b) {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const norm = (n) => {
  const k = n.toLowerCase().replace(/\(.*?\)/g, '').replace(/\bmetro station\b|\bstation\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return ALIAS[k] || k;
};
const lineHint = (n) => { const m = /\((\w+) line\)/i.exec(n); return m ? m[1].toLowerCase() : null; };

// 1. merge OSM points into stations
const stations = [];
for (const [name, lat, lon] of osm) {
  const key = norm(name);
  if (!key) continue;
  const hit = stations.find((s) => s.key === key && hav([s.lat, s.lon], [lat, lon]) < MERGE_M);
  const pt = [lat, lon, lineHint(name)];
  if (hit) { hit.pts.push(pt); continue; }
  stations.push({ key, name: name.replace(/\s*\((.*?) line\)\s*$/i, '').replace(/ Airport Express Terminal$/, '').trim(), lat, lon, pts: [pt] });
}
for (const s of stations) {
  s.lat = s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length;
  s.lon = s.pts.reduce((a, p) => a + p[1], 0) / s.pts.length;
}

// 2. project onto each line
function project(lat, lon, coords, cum) {
  let best = null;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const kx = Math.cos(toRad((a[1] + b[1]) / 2)) * 111320, ky = 110540;
    const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky, px = lon * kx, py = lat * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || d < best.d) best = { d, along: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
  }
  return best;
}

const out = { source: 'Lines: reclaim.city Delhi mirror. Stations: OpenStreetMap contributors (ODbL).', stations: [], lines: [] };
const stationIdx = new Map();
function sid(s) {
  if (!stationIdx.has(s)) { stationIdx.set(s, out.stations.length); out.stations.push([s.name, +s.lat.toFixed(6), +s.lon.toFixed(6)]); }
  return stationIdx.get(s);
}

const geo = lines.features.map((f) => {
  const coords = f.geometry.coordinates;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav([coords[i - 1][1], coords[i - 1][0]], [coords[i][1], coords[i][0]]));
  return { f, coords, cum, colour: f.properties.line.split(' ')[0].toLowerCase() };
});
// distance from every station to every line (closest of its raw points: OSM often has one node per platform)
for (const s of stations) {
  s.proj = geo.map((g) => {
    let best = null;
    for (const p of s.pts) { const pr = project(p[0], p[1], g.coords, g.cum); if (!best || pr.d < best.d) best = pr; }
    return best;
  });
  s.nearest = Math.min(...s.proj.map((p) => p.d));
  s.hints = new Set(s.pts.map((p) => p[2]).filter(Boolean));
}

for (const [gi, g] of geo.entries()) {
  const f = g.f;
  const coords = g.coords;
  const on = [];
  for (const s of stations) {
    const pr = s.proj[gi];
    const ok = pr.d <= SNAP_M
      || (pr.d <= NEAREST_M && pr.d - s.nearest < 1)
      || (pr.d <= HINT_M && s.hints.has(g.colour));
    if (ok) on.push({ s, along: pr.along });
  }
  on.sort((a, b) => a.along - b.along);
  // drop near-duplicates along the line (two names for one platform)
  const kept = [];
  for (const o of on) { if (kept.length && o.along - kept[kept.length - 1].along < 250) continue; kept.push(o); }
  const name = f.properties.line;
  out.lines.push({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''),
    name: name.replace(/\s*\(.*\)$/, '') === 'Blue Line' ? name.replace('Blue Line (', 'Blue Line · ').replace(')', '') : name,
    short: name.replace(/\s*\(.*?\)/, '').replace(/\s+Line$/, '').replace(/^Noida /, '').replace(/^Gurgaon /, ''),
    color: f.properties.color,
    speed: /airport/i.test(name) ? 16 : 9.5, // m/s average incl. dwell
    stops: kept.map((o) => [sid(o.s), Math.round(o.along)]),
    coords: coords.map((c) => [+c[0].toFixed(5), +c[1].toFixed(5)]),
  });
  console.log(name.padEnd(34), String(kept.length).padStart(3), 'stations', `${kept[0] && kept[0].s.name} -> ${kept[kept.length - 1] && kept[kept.length - 1].s.name}`);
}

const used = new Set(out.lines.flatMap((l) => l.stops.map((s) => s[0])));
console.log('stations used:', used.size, 'of merged', stations.length);
fs.writeFileSync(path.join(ROOT, 'public', 'data', 'metro.json'), JSON.stringify(out));
console.log('metro.json bytes', fs.statSync(path.join(ROOT, 'public', 'data', 'metro.json')).size);
