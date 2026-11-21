// Reads GTFS txt files from data/gtfs/ and writes compact JSON into data/.
const fs = require('fs');
const path = require('path');

const GTFS = path.join(__dirname, '..', 'data', 'gtfs');
const OUT = path.join(__dirname, '..', 'data');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
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
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

function read(name) {
  const p = path.join(GTFS, name);
  if (!fs.existsSync(p)) { console.error(`missing ${name}`); return null; }
  return parseCsv(fs.readFileSync(p, 'utf8'));
}

// stops.json
const stops = read('stops.txt');
if (stops) {
  const out = stops.map((s) => ({
    id: s.stop_id, name: s.stop_name,
    lat: parseFloat(s.stop_lat), lon: parseFloat(s.stop_lon),
  })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  fs.writeFileSync(path.join(OUT, 'stops.json'), JSON.stringify(out));
  console.log(`stops.json: ${out.length}`);
}

// routes.json
const routes = read('routes.txt');
if (routes) {
  const out = routes.map((r) => ({
    id: r.route_id, short_name: r.route_short_name || '', long_name: r.route_long_name || '',
    type: r.route_type || '',
  }));
  fs.writeFileSync(path.join(OUT, 'routes.json'), JSON.stringify(out));
  console.log(`routes.json: ${out.length}`);
}

// demo_trips.json: a spread of trips with their stop coordinate sequences
const trips = read('trips.txt');
const stopTimes = read('stop_times.txt');
if (stops && trips && stopTimes) {
  const coord = {};
  for (const s of stops) coord[s.stop_id] = [parseFloat(s.stop_lat), parseFloat(s.stop_lon)];
  const byTrip = {};
  for (const st of stopTimes) {
    (byTrip[st.trip_id] ||= []).push(st);
  }
  const tripRoute = {};
  for (const t of trips) tripRoute[t.trip_id] = t.route_id;
  const tripIds = Object.keys(byTrip);
  const step = Math.max(1, Math.floor(tripIds.length / 400));
  const out = [];
  for (let i = 0, seed = 0; i < tripIds.length && out.length < 400; i += step, seed++) {
    const tid = tripIds[i];
    const seq = byTrip[tid].sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));
    const points = seq.map((st) => coord[st.stop_id]).filter((p) => p && Number.isFinite(p[0]));
    if (points.length >= 5) out.push({ trip_id: tid, route_id: tripRoute[tid] || '', seed, points });
  }
  fs.writeFileSync(path.join(OUT, 'demo_trips.json'), JSON.stringify(out));
  console.log(`demo_trips.json: ${out.length} trips`);
}

