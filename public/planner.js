/* Delhi trip planner: walk + bus + metro.
 *
 * A deliberately simple, honest router. There is no Delhi bus timetable we trust, so this is a
 * frequency-based RAPTOR: each round adds one ride, a ride costs (expected wait + in-vehicle time),
 * and transfers cost a fixed penalty. Bus waits come from trips/day in reclaim's timings; metro is
 * SCHEDULED ONLY (fixed typical wait, no live data). Live bus times are layered on by the UI.
 *
 * Data (all in public/data/, reclaim IDs which match the live feed):
 *   route_patterns.json  route_id -> {sn, d:[{from,to,stops:[[id,name,lat,lon]..]}]}
 *   route_freq.json      route_id -> [tripsPerDay, first "HH:MM", last "HH:MM"]
 *   metro.json           {stations:[[name,lat,lon]], lines:[{id,name,short,color,speed,stops:[[station,along_m]],coords}]}
 *   places.json          [[name, lat, lon, kind, alts?]]
 *
 * Works in the browser (window.Planner) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const CFG = {
    walkSpeed: 1.2,          // m/s
    walkDetour: 1.3,         // street distance vs straight line
    maxAccessM: 1100,        // straight-line radius to look for stops/stations at either end
    maxTransferM: 300,       // bus <-> bus walking transfer
    maxMetroTransferM: 550,  // bus <-> metro, metro <-> metro (station entrances are spread out)
    busSpeed: 4.3,           // m/s average incl. traffic (~15.5 km/h)
    busDetour: 1.2,          // road distance vs stop-to-stop straight line
    busDwell: 15,            // s per intermediate stop
    metroDwell: 30,          // s per intermediate station
    metroWait: 240,          // s, typical scheduled wait (headways ~3-8 min daytime)
    metroInterchange: 180,   // s, walking between platforms at an interchange
    transferPenalty: 240,    // s, discomfort cost per extra boarding (ranking only)
    minBusWait: 180, maxBusWait: 1200,
    rounds: 4,               // max rides (3 transfers)
  };

  const toRad = (d) => (d * Math.PI) / 180;
  function hav(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  }
  const walkSecs = (m) => (m * CFG.walkDetour) / CFG.walkSpeed;
  const hhmm = (s) => { const m = /^(\d+):(\d+)/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

  /* minutes since midnight in Delhi, whatever the device timezone */
  function delhiMinutes(date) {
    const d = date || new Date();
    const ist = new Date(d.getTime() + (d.getTimezoneOffset() + 330) * 60000);
    return ist.getHours() * 60 + ist.getMinutes();
  }

  /* ---------------- spatial grid ---------------- */
  const CELL = 0.005; // ~500 m
  function Grid() { this.cells = new Map(); }
  Grid.prototype.key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  Grid.prototype.add = function (i, lat, lon) {
    const k = this.key(lat, lon);
    let c = this.cells.get(k); if (!c) this.cells.set(k, (c = []));
    c.push(i);
  };
  Grid.prototype.near = function (lat, lon, radiusM) {
    const r = Math.ceil(radiusM / 500) + 0;
    const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL), out = [];
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const c = this.cells.get(`${y}:${x}`); if (c) for (const i of c) out.push(i);
    }
    return out;
  };

  /* ---------------- network build ---------------- */
  function build(data, opts) {
    const now = (opts && opts.minutes != null) ? opts.minutes : delhiMinutes();
    const nodes = [];           // {name, lat, lon, kind:'bus'|'metro', id}
    const byStopId = new Map();
    const grid = new Grid();

    function busNode(id, name, lat, lon) {
      let i = byStopId.get(id);
      if (i == null) { i = nodes.length; nodes.push({ id, name, lat, lon, kind: 'bus' }); byStopId.set(id, i); grid.add(i, lat, lon); }
      return i;
    }

    const routes = []; // {kind, rid, label, color, from, to, nodes:[], t:[], wait, line?, along?}
    for (const [rid, p] of Object.entries(data.patterns)) {
      const f = data.freq && data.freq[rid];
      let headwayMin = 30, running = true;
      if (f) {
        const first = hhmm(f[1]), last = hhmm(f[2]);
        if (first != null && last != null) {
          let span = last - first; if (span <= 0) span += 1440;
          headwayMin = Math.max(5, span / Math.max(1, f[0]));
          let t = now - first; if (t < 0) t += 1440;
          running = t <= span + 10; // a little slack after the last departure from the terminal
        }
      }
      if (!running && !(opts && opts.ignoreHours)) continue;
      const wait = Math.max(CFG.minBusWait, Math.min(CFG.maxBusWait, (headwayMin * 60) / 2));
      for (const d of p.d) {
        const ids = d.stops.map((s) => busNode(s[0], s[1], s[2], s[3]));
        const t = [0];
        for (let i = 1; i < d.stops.length; i++) {
          const a = d.stops[i - 1], b = d.stops[i];
          t.push(t[i - 1] + (hav(a[2], a[3], b[2], b[3]) * CFG.busDetour) / CFG.busSpeed + CFG.busDwell);
        }
        routes.push({ kind: 'bus', rid, label: p.sn || rid, from: d.from, to: d.to, nodes: ids, t, wait, headwayMin, trips: f ? f[0] : null });
      }
    }

    // metro: one node per station, a route per line per direction
    const metroOpen = (opts && opts.ignoreHours) || (now >= 330 && now <= 1410); // ~05:30-23:30
    const stationNode = [];
    if (data.metro) {
      for (const [name, lat, lon] of data.metro.stations) {
        const i = nodes.length; nodes.push({ id: 'm' + stationNode.length, name, lat, lon, kind: 'metro', lines: [] });
        stationNode.push(i); grid.add(i, lat, lon);
      }
      if (metroOpen) {
        for (const line of data.metro.lines) {
          if (line.stops.length < 2) continue;
          const seq = line.stops.map(([s, along]) => ({ n: stationNode[s], along }));
          for (const dir of [seq, seq.slice().reverse()]) {
            const t = [0];
            for (let i = 1; i < dir.length; i++) t.push(t[i - 1] + Math.abs(dir[i].along - dir[i - 1].along) / line.speed + CFG.metroDwell);
            routes.push({
              kind: 'metro', rid: line.id, label: line.short, name: line.name, color: line.color,
              from: nodes[dir[0].n].name, to: nodes[dir[dir.length - 1].n].name,
              nodes: dir.map((x) => x.n), along: dir.map((x) => x.along), t, wait: CFG.metroWait, line,
            });
          }
          for (const [s] of line.stops) nodes[stationNode[s]].lines.push(line.id);
        }
      }
    }

    // node -> [[route, pos]]
    const nodeRoutes = nodes.map(() => []);
    routes.forEach((r, ri) => r.nodes.forEach((n, pos) => nodeRoutes[n].push(ri, pos)));

    // footpaths
    const foot = nodes.map(() => []);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (const j of grid.near(a.lat, a.lon, CFG.maxMetroTransferM)) {
        if (j === i) continue;
        const b = nodes[j];
        const lim = a.kind === 'bus' && b.kind === 'bus' ? CFG.maxTransferM : CFG.maxMetroTransferM;
        const d = hav(a.lat, a.lon, b.lat, b.lon);
        if (d <= lim) foot[i].push(j, Math.round(walkSecs(d)), Math.round(d));
      }
    }
    return { nodes, routes, nodeRoutes, foot, grid, metroOpen, builtFor: now };
  }

  /* ---------------- query ---------------- */
  function nearNodes(net, lat, lon, filter) {
    const out = [];
    for (const i of net.grid.near(lat, lon, CFG.maxAccessM)) {
      const n = net.nodes[i];
      if (filter && !filter(n)) continue;
      const d = hav(lat, lon, n.lat, n.lon);
      if (d <= CFG.maxAccessM) out.push({ i, d, s: walkSecs(d) });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, 60);
  }

  function raptor(net, origin, dest, opts) {
    const noMetro = opts && opts.noMetro;
    const N = net.nodes.length, K = CFG.rounds;
    const okNode = noMetro ? (n) => n.kind === 'bus' : null;
    const access = nearNodes(net, origin.lat, origin.lon, okNode);
    const egress = new Map(nearNodes(net, dest.lat, dest.lon, okNode).map((e) => [e.i, e]));
    const best = new Float64Array(N).fill(Infinity);
    const arr = [], par = [];
    for (let k = 0; k <= K; k++) { arr.push(new Float64Array(N).fill(Infinity)); par.push(new Array(N)); }
    let marked = new Set();
    for (const a of access) { arr[0][a.i] = a.s; best[a.i] = a.s; par[0][a.i] = { type: 'access', d: a.d }; marked.add(a.i); }

    for (let k = 1; k <= K && marked.size; k++) {
      // routes to scan, from the earliest marked position
      const q = new Map();
      for (const n of marked) {
        const nr = net.nodeRoutes[n];
        for (let x = 0; x < nr.length; x += 2) {
          const ri = nr[x], pos = nr[x + 1];
          if (noMetro && net.routes[ri].kind === 'metro') continue;
          const cur = q.get(ri);
          if (cur == null || pos < cur) q.set(ri, pos);
        }
      }
      const rideMarked = new Set();
      for (const [ri, p0] of q) {
        const r = net.routes[ri];
        let key = Infinity, boardPos = -1;
        for (let i = p0; i < r.nodes.length; i++) {
          const n = r.nodes[i];
          if (boardPos >= 0) {
            const v = key + r.t[i];
            if (v < best[n] && v < arr[k][n]) {
              arr[k][n] = v; best[n] = v;
              par[k][n] = { type: 'ride', route: ri, from: boardPos, to: i };
              rideMarked.add(n);
            }
          }
          const prev = arr[k - 1][n];
          if (prev < Infinity) {
            const prevPar = par[k - 1][n];
            // same-station metro interchange costs platform walking; any re-boarding costs the transfer penalty
            const xfer = k > 1 ? CFG.transferPenalty + (r.kind === 'metro' && prevPar && prevPar.type === 'ride' && net.routes[prevPar.route].kind === 'metro' ? CFG.metroInterchange : 0) : 0;
            const cand = prev + r.wait + xfer - r.t[i];
            if (cand < key) { key = cand; boardPos = i; }
          }
        }
      }
      // footpaths from nodes reached by a ride this round
      // (one walk per round, always starting from a ride arrival: snapshot those first)
      const next = new Set(rideMarked);
      const rides = [...rideMarked].map((n) => [n, arr[k][n], par[k][n]]);
      for (const [n, v0, rp] of rides) {
        const f = net.foot[n];
        for (let x = 0; x < f.length; x += 3) {
          const m = f[x];
          if (noMetro && net.nodes[m].kind === 'metro') continue;
          const v = v0 + f[x + 1];
          if (v < best[m] && v < arr[k][m]) { arr[k][m] = v; best[m] = v; par[k][m] = { type: 'walk', from: n, d: f[x + 2], ride: rp }; next.add(m); }
        }
      }
      marked = next;
    }

    // best arrival at destination for each number of rides
    const results = [];
    for (let k = 1; k <= K; k++) {
      let bestV = Infinity, bestN = -1;
      for (const [n, e] of egress) { const v = arr[k][n] + e.s; if (v < bestV) { bestV = v; bestN = n; } }
      if (bestN >= 0) results.push({ k, cost: bestV, legs: reconstruct(net, arr, par, k, bestN, origin, dest, egress.get(bestN)) });
    }
    return results;
  }

  function nodeRef(net, n) { const x = net.nodes[n]; return { name: x.name, lat: x.lat, lon: x.lon, kind: x.kind, id: x.id }; }

  function reconstruct(net, arr, par, k, n, origin, dest, eg) {
    const legs = [];
    legs.push({ type: 'walk', from: nodeRef(net, n), to: { name: dest.name || 'Destination', lat: dest.lat, lon: dest.lon }, dist: Math.round(eg.d), secs: Math.round(eg.s) });
    let cur = n, pending = null;
    while (true) {
      const p = pending || par[k][cur];
      pending = null;
      if (!p) break;
      if (p.type === 'access') {
        legs.push({ type: 'walk', from: { name: origin.name || 'Start', lat: origin.lat, lon: origin.lon }, to: nodeRef(net, cur), dist: Math.round(p.d), secs: Math.round(walkSecs(p.d)) });
        break;
      }
      if (p.type === 'walk') {
        const from = p.from;
        legs.push({ type: 'walk', from: nodeRef(net, from), to: nodeRef(net, cur), dist: p.d, secs: Math.round(walkSecs(p.d)) });
        cur = from; pending = p.ride; // the ride that reached `from` this round
        continue;
      }
      const r = net.routes[p.route];
      const leg = {
        type: r.kind, route_id: r.kind === 'bus' ? r.rid : undefined, line_id: r.kind === 'metro' ? r.rid : undefined,
        label: r.label, name: r.name, color: r.color, headsign: r.to, origin_terminal: r.from,
        board: nodeRef(net, r.nodes[p.from]), alight: nodeRef(net, r.nodes[p.to]),
        stops: r.nodes.slice(p.from, p.to + 1).map((x) => nodeRef(net, x)),
        rideSecs: Math.round(r.t[p.to] - r.t[p.from]), waitSecs: Math.round(r.wait),
        headwayMin: r.headwayMin ? Math.round(r.headwayMin) : null, tripsPerDay: r.trips || null,
        scheduled: r.kind === 'metro',
      };
      if (r.kind === 'metro') { leg.alongFrom = r.along[p.from]; leg.alongTo = r.along[p.to]; }
      legs.push(leg);
      cur = r.nodes[p.from];
      k -= 1;
    }
    legs.reverse();
    // merge consecutive walks; drop zero walks
    const out = [];
    for (const l of legs) {
      const last = out[out.length - 1];
      if (l.type === 'walk' && last && last.type === 'walk') { last.to = l.to; last.dist += l.dist; last.secs += l.secs; continue; }
      out.push(l);
    }
    return out.filter((l) => l.type !== 'walk' || l.dist >= 15);
  }

  function summarize(legs) {
    let secs = 0, walkM = 0, rides = 0;
    for (const l of legs) {
      if (l.type === 'walk') { secs += l.secs; walkM += l.dist; }
      else { secs += l.waitSecs + l.rideSecs; rides++; }
    }
    const sig = legs.filter((l) => l.type !== 'walk').map((l) => `${l.type}:${l.label}:${l.board.id}:${l.alight.id}`).join('>');
    const modes = new Set(legs.filter((l) => l.type !== 'walk').map((l) => l.type));
    return { secs: Math.round(secs), walkM: Math.round(walkM), rides, sig, hasMetro: modes.has('metro'), hasBus: modes.has('bus') };
  }

  /* Plan: up to `max` sensible options (fastest, fewest changes, bus-only), plus walking if short. */
  function plan(net, origin, dest, opts) {
    const max = (opts && opts.max) || 4;
    const direct = hav(origin.lat, origin.lon, dest.lat, dest.lon);
    const cands = [];
    for (const r of raptor(net, origin, dest, {})) cands.push(r.legs);
    for (const r of raptor(net, origin, dest, { noMetro: true })) cands.push(r.legs);
    const seen = new Set();
    let options = [];
    for (const legs of cands) {
      const s = summarize(legs);
      if (!s.rides || seen.has(s.sig)) continue;
      seen.add(s.sig);
      options.push({ legs, ...s, score: s.secs + (s.rides - 1) * CFG.transferPenalty });
    }
    options.sort((a, b) => a.score - b.score);
    // drop options dominated on both time and changes, and anything far slower than the best
    const bestSecs = options.length ? options[0].secs : Infinity;
    const dominated = (o) => options.some((p) => p !== o && p.secs <= o.secs && p.rides <= o.rides && (p.secs < o.secs || p.rides < o.rides));
    const firstBusOnly = options.find((o) => !o.hasMetro);
    options = options.filter((o) => !dominated(o) || o === firstBusOnly); // always offer a bus-only option (buses are live)
    options = options.filter((o) => o.secs <= bestSecs * 1.8 + 600);
    const walkSecsDirect = Math.round(walkSecs(direct));
    if (direct < 2500) {
      options.push({ legs: [{ type: 'walk', from: { name: origin.name, lat: origin.lat, lon: origin.lon }, to: { name: dest.name, lat: dest.lat, lon: dest.lon }, dist: Math.round(direct * CFG.walkDetour), secs: walkSecsDirect }], secs: walkSecsDirect, walkM: Math.round(direct * CFG.walkDetour), rides: 0, walkOnly: true, score: walkSecsDirect });
      options.sort((a, b) => a.score - b.score);
    }
    return { options: options.slice(0, max), metroOpen: net.metroOpen, directM: Math.round(direct) };
  }

  /* ---------------- place search ---------------- */
  const KIND_LABEL = { a: 'Area', r: 'Station', h: 'Hospital', c: 'College', m: 'Market', t: 'Landmark', b: 'Bus terminal', w: 'Place of worship', x: 'Airport', s: 'Bus stop', M: 'Metro station' };
  const KIND_RANK = { M: 0, a: 1, x: 1, r: 2, b: 2, t: 3, m: 3, c: 4, h: 4, w: 5, s: 6 };
  const normQ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function buildIndex(data) {
    const items = [];
    const seen = new Set();
    const push = (name, lat, lon, kind, alts, extra) => {
      const key = normQ(name) + '|' + Math.round(lat * 200) + ':' + Math.round(lon * 200);
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ name, lat, lon, kind, keys: [normQ(name)].concat(alts ? String(alts).split('|').map(normQ) : []), ...extra });
    };
    if (data.metro) {
      const lines = data.metro.stations.map(() => []);
      for (const l of data.metro.lines) for (const [s] of l.stops) lines[s].push({ short: l.short, color: l.color });
      data.metro.stations.forEach(([name, lat, lon], i) => { if (lines[i].length) push(name, lat, lon, 'M', null, { lines: lines[i].filter((x, j, a) => a.findIndex((y) => y.short === x.short) === j) }); });
    }
    for (const p of data.places || []) push(p[0], p[1], p[2], p[3], p[4]);
    const stopSeen = new Set();
    for (const s of data.stops || []) {
      const k = normQ(s.name); if (!k || stopSeen.has(k)) continue; stopSeen.add(k);
      push(s.name, s.lat, s.lon, 's', null, { stop_id: s.id });
    }
    return items;
  }

  function search(index, q, limit) {
    const nq = normQ(q); if (!nq) return [];
    const toks = nq.split(' ');
    const scored = [];
    for (const it of index) {
      let best = Infinity;
      for (const k of it.keys) {
        let s;
        if (k === nq) s = 0;
        else if (k.startsWith(nq)) s = 1;
        else if (toks.every((t) => k.split(' ').some((w) => w.startsWith(t)))) s = 2;
        else if (k.includes(nq)) s = 3;
        else continue;
        if (s < best) best = s;
      }
      if (best < Infinity) scored.push({ it, s: best * 10 + (KIND_RANK[it.kind] ?? 5) + Math.min(3, it.name.length / 30) });
    }
    scored.sort((a, b) => a.s - b.s);
    return scored.slice(0, limit || 8).map((x) => x.it);
  }

  const api = { CFG, build, plan, raptor, buildIndex, search, delhiMinutes, KIND_LABEL, hav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== 'undefined' ? window : globalThis);
