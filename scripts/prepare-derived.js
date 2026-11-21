// Builds data/route_patterns.json and data/stop_routes.json from data/gtfs/ (GTFS txt).
// route_patterns: per route, up to 2 direction patterns with ordered stop ids + endpoint names.
// stop_routes: per stop id, the routes serving it.
const fs = require('fs');
const path = require('path');

const GTFS = path.join(__dirname, '..', 'data', 'gtfs');
const OUT = path.join(__dirname, '..', 'data');

function parseCsvLines(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return { header, rows };
}

const stopsTxt = parseCsvLines(fs.readFileSync(path.join(GTFS, 'stops.txt'), 'utf8'));
const stopName = {};
for (const r of stopsTxt.rows) stopName[r[0]] = r[2];

const tripsTxt = parseCsvLines(fs.readFileSync(path.join(GTFS, 'trips.txt'), 'utf8'));
const tripRoute = {};
for (const r of tripsTxt.rows) tripRoute[r[2]] = r[0];

// stream stop_times: trip_id, arrival_time, departure_time, stop_id, stop_sequence
const text = fs.readFileSync(path.join(GTFS, 'stop_times.txt'), 'utf8');
const lines = text.split('\n');
const byTrip = new Map();
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const p = line.split(',');
  const tid = p[0];
  let arr = byTrip.get(tid);
  if (!arr) { arr = []; byTrip.set(tid, arr); }
  arr.push([parseInt(p[4], 10), p[3]]);
}

// group trips per route by (first,last) stop signature
const routeGroups = new Map(); // route -> Map(sig -> {count, seq})
for (const [tid, arr] of byTrip) {
  const route = tripRoute[tid];
  if (route == null) continue;
  arr.sort((a, b) => a[0] - b[0]);
  const seq = arr.map((x) => x[1]);
  if (seq.length < 2) continue;
  const sig = seq[0] + '>' + seq[seq.length - 1];
  let groups = routeGroups.get(route);
  if (!groups) { groups = new Map(); routeGroups.set(route, groups); }
  const g = groups.get(sig);
  if (!g) groups.set(sig, { count: 1, seq });
  else { g.count++; if (seq.length > g.seq.length) g.seq = seq; }
}

const routePatterns = {};
const stopRoutes = new Map();
for (const [route, groups] of routeGroups) {
  const dirs = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 2)
    .map((g) => ({
      stops: g.seq,
      from: stopName[g.seq[0]] || '',
      to: stopName[g.seq[g.seq.length - 1]] || '',
      trips: g.count,
    }));
  routePatterns[route] = { d: dirs };
  for (const dir of dirs) {
    for (const sid of dir.stops) {
      let s = stopRoutes.get(sid);
      if (!s) { s = new Set(); stopRoutes.set(sid, s); }
      s.add(route);
    }
  }
}

const stopRoutesOut = {};
for (const [sid, set] of stopRoutes) stopRoutesOut[sid] = [...set];

fs.writeFileSync(path.join(OUT, 'route_patterns.json'), JSON.stringify(routePatterns));
fs.writeFileSync(path.join(OUT, 'stop_routes.json'), JSON.stringify(stopRoutesOut));
console.log('routes with patterns:', Object.keys(routePatterns).length);
console.log('stops with routes:', Object.keys(stopRoutesOut).length);
console.log('route_patterns bytes:', fs.statSync(path.join(OUT, 'route_patterns.json')).size);
console.log('stop_routes bytes:', fs.statSync(path.join(OUT, 'stop_routes.json')).size);
