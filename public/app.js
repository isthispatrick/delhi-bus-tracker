/* Delhi Bus: live map, destination search, trip planner.
 * Static, no framework. Sections:
 *   1 helpers + data       5 search (places, routes)        9 bus / stop / near-me sheets
 *   2 map + layers         6 destination: direct buses      10 3D buses
 *   3 feed + motion        7 trip planner (walk/bus/metro)  11 boot + deep links
 *   4 bottom sheet         8 route focus
 */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ui = {
    boot: $('boot'), bootSub: $('boot-sub'), q: $('q'), qClear: $('q-clear'), back: $('search-back'), lead: $('search-lead'),
    suggest: $('suggest'), chipNear: $('chip-near'), chipFocus: $('chip-focus'), chipFocusLabel: $('chip-focus-label'),
    banner: $('banner'), status: $('status'), statusText: $('status-text'), btn3d: $('btn-3d'), btnLocate: $('btn-locate'),
    sheet: $('sheet'), sheetBody: $('sheet-body'), grab: $('sheet-grab'), toast: $('toast'), fatal: $('fatal'),
  };

  /* =============================== 1. helpers + data =============================== */
  const toRad = (d) => (d * Math.PI) / 180;
  function hav(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  }
  const WALK_MS = 1.2, WALK_DETOUR = 1.3, BUS_MS = 4.3, BUS_DETOUR = 1.2, BUS_DWELL = 15;
  const walkSecs = (m) => (m * WALK_DETOUR) / WALK_MS;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDist = (m) => (m == null ? '' : m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  const mins = (s) => Math.max(1, Math.round(s / 60));
  const fmtMin = (s) => `${Math.max(1, Math.round(s / 60))}`; // always minutes, like transit apps ("75 min")
  const etaHtml = (s, cls) => (s < 45 ? `<span class="v ${cls || ''}">Now</span>` : `<span class="v ${cls || ''}">${fmtMin(s)}<small>min</small></span>`);
  const clock = (d) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const ico = (id, cls) => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}><use href="#i-${id}"/></svg>`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  let toastT;
  function toast(msg) { ui.toast.textContent = msg; ui.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => ui.toast.classList.remove('show'), 2400); }
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 600));

  // lazily loaded static data (public/data, reclaim IDs = live feed IDs)
  const D = {};
  const once = {};
  const load = (key, fn) => (once[key] = once[key] || fn().catch((e) => { delete once[key]; throw e; }));
  const getJson = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
  const loadStops = () => load('stops', async () => {
    const list = await getJson('/data/stops.json');
    D.stopList = list; D.stops = new Map(list.map((s) => [s.id, s]));
    D.stopGrid = new Map();
    for (const s of list) { const k = gk(s.lat, s.lon); let c = D.stopGrid.get(k); if (!c) D.stopGrid.set(k, (c = [])); c.push(s); }
  });
  const loadPatterns = () => load('patterns', async () => {
    const [rp, sr] = await Promise.all([getJson('/data/route_patterns.json'), getJson('/data/stop_routes.json'), loadStops()]);
    D.patterns = rp; D.stopRoutes = sr;
  });
  const loadMetro = () => load('metro', async () => { D.metro = await getJson('/data/metro.json'); });
  const loadPlaces = () => load('places', async () => {
    const [places] = await Promise.all([getJson('/data/places.json'), loadStops(), loadMetro()]);
    D.places = places;
    D.index = Planner.buildIndex({ places, metro: D.metro, stops: D.stopList });
  });
  const loadNet = () => load('net', async () => {
    const [freq] = await Promise.all([getJson('/data/route_freq.json'), loadPatterns(), loadMetro()]);
    D.freq = freq;
    D.net = Planner.build({ patterns: D.patterns, freq, metro: D.metro });
  });

  // ~500 m grid over stops
  const GC = 0.005;
  const gk = (lat, lon) => `${Math.floor(lat / GC)}:${Math.floor(lon / GC)}`;
  function stopsNear(lat, lon, radius) {
    const r = Math.ceil(radius / 500), cy = Math.floor(lat / GC), cx = Math.floor(lon / GC), out = [];
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const c = D.stopGrid.get(`${y}:${x}`);
      if (c) for (const s of c) { const d = hav(lat, lon, s.lat, s.lon); if (d <= radius) out.push({ s, d }); }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /* route geometry: per direction, stop points + cumulative metres + stop index */
  const geomCache = new Map();
  function patternGeom(rid) {
    if (geomCache.has(rid)) return geomCache.get(rid);
    const p = D.patterns && D.patterns[rid];
    let geom = null;
    if (p) {
      geom = p.d.map((dir, di) => {
        const pts = dir.stops.map((x) => ({ id: x[0], name: x[1], lat: x[2], lon: x[3] }));
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
        const pos = new Map();
        pts.forEach((pt, i) => { if (!pos.has(pt.id)) pos.set(pt.id, []); pos.get(pt.id).push(i); });
        return { rid, di, pts, cum, pos, from: dir.from, to: dir.to, total: cum[cum.length - 1] || 0 };
      }).filter((g) => g.pts.length >= 2);
    }
    geomCache.set(rid, geom);
    return geom;
  }
  function projectOnGeom(lat, lon, g) {
    let best = null;
    const kx = Math.cos(toRad(lat)) * 111320, ky = 110540, px = lon * kx, py = lat * ky;
    for (let i = 1; i < g.pts.length; i++) {
      const a = g.pts[i - 1], b = g.pts[i];
      const ax = a.lon * kx, ay = a.lat * ky, dx = b.lon * kx - ax, dy = b.lat * ky - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (!best || d < best.dist) best = { dist: d, along: g.cum[i - 1] + t * (g.cum[i] - g.cum[i - 1]), seg: i };
    }
    return best;
  }
  /* which direction a live bus is running: closest pattern, bearing as tiebreak */
  function busDirection(bus) {
    const geoms = patternGeom(bus.route_id);
    if (!geoms || !geoms.length) return null;
    let best = null;
    for (const g of geoms) {
      const proj = projectOnGeom(bus.lat, bus.lon, g);
      let score = proj.dist;
      if (bus.bearing && g.pts[proj.seg]) {
        const a = g.pts[proj.seg - 1], b = g.pts[proj.seg];
        const brg = (Math.atan2((b.lon - a.lon) * Math.cos(toRad(a.lat)), b.lat - a.lat) * 180) / Math.PI;
        if (Math.abs(((brg - bus.bearing + 540) % 360) - 180) > 100) score += 150;
      }
      if (!best || score < best.score) best = { geom: g, proj, score };
    }
    return best && best.proj.dist <= 400 ? best : null;
  }
  const routeLabel = (rid) => (D.patterns && D.patterns[rid] && D.patterns[rid].sn) || S.labels.get(rid) || rid || '';

  /* live predictions, cached per stop for 12 s, fetched in batches */
  const arrCache = new Map();
  const arrInflight = new Map();
  async function arrivalsForStops(ids, maxWait) {
    const now = Date.now();
    const need = ids.filter((id) => { const c = arrCache.get(id); return (!c || now - c.at > 12000) && !arrInflight.has(id); });
    if (need.length) {
      const p = getJson(`/api/arrivals?stop_ids=${need.slice(0, 40).map(encodeURIComponent).join(',')}`)
        .then((d) => { for (const id of need) arrCache.set(id, { at: Date.now(), list: (d.stops && d.stops[id]) || [], stale: d.stale }); })
        .catch(() => { for (const id of need) if (!arrCache.has(id)) arrCache.set(id, { at: Date.now() - 9000, list: [] }); })
        .finally(() => { for (const id of need) arrInflight.delete(id); });
      for (const id of need) arrInflight.set(id, p);
    }
    const pending = [...new Set(ids.map((id) => arrInflight.get(id)).filter(Boolean))];
    if (pending.length) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, maxWait == null ? 3000 : maxWait))]);
    const t = Math.floor(Date.now() / 1000);
    const out = {};
    for (const id of ids) out[id] = ((arrCache.get(id) || {}).list || []).map((a) => ({ ...a, in_sec: a.eta - t })).filter((a) => a.in_sec > -30);
    return out;
  }

  /* ============================== state ============================== */
  const S = {
    buses: new Map(),          // id -> latest bus record
    labels: new Map(),         // route_id -> label (from the feed)
    byRoute: new Map(),        // route_id -> [bus]
    meta: null, lastOk: 0, fetching: false, failures: 0,
    userLoc: null, meMarker: null, destMarker: null,
    focus: null,               // null | Set(bus ids) shown exclusively
    focusRoutes: null,         // route ids in focus (for buses that appear later)
    selectedId: null, followId: null, is3D: false,
    mode: null,                // null | 'bus' | 'stop' | 'near' | 'dest' | 'route' | 'trip'
    dest: null, origin: null, results: null,
    interacting: false,
  };

  /* =============================== 2. map + layers =============================== */
  let cfg;
  try { cfg = await getJson('/api/config'); } catch { cfg = {}; }
  if (!cfg.mapboxToken) { ui.fatal.textContent = 'Map unavailable: MAPBOX_TOKEN is not set on the server.'; ui.fatal.classList.remove('hidden'); ui.boot.classList.add('gone'); return; }
  mapboxgl.accessToken = cfg.mapboxToken;
  const DELHI = [77.209, 28.6139];
  const map = new mapboxgl.Map({
    container: 'map', style: 'mapbox://styles/mapbox/dark-v11', center: DELHI, zoom: 11, minZoom: 8.5, maxZoom: 19.5,
    attributionControl: false, pitchWithRotate: true, fadeDuration: 120, maxBounds: [[76.3, 27.9], [78.2, 29.4]],
  });
  window.map = map;
  map.addControl(new mapboxgl.AttributionControl({ compact: true, customAttribution: 'Live: Delhi OTD · reclaim.city · Metro stations © OpenStreetMap · 3D bus: Innerscene (CC0)' }), 'bottom-right');
  map.touchZoomRotate.disableRotation();
  ['dragstart', 'zoomstart', 'pitchstart', 'rotatestart'].forEach((ev) => map.on(ev, (e) => { if (e.originalEvent) { S.interacting = true; if (S.followId) stopFollow(true); } }));
  map.on('moveend', () => { S.interacting = false; refreshView(true); });

  function makeImage(w, h, draw, opts) {
    const r = 2, cv = document.createElement('canvas');
    cv.width = w * r; cv.height = h * r;
    const ctx = cv.getContext('2d'); ctx.scale(r, r); draw(ctx);
    return [{ width: cv.width, height: cv.height, data: ctx.getImageData(0, 0, cv.width, cv.height).data }, { pixelRatio: r, ...(opts || {}) }];
  }
  function addImages() {
    // bus marker: orange disc with a heading notch (rotated by bearing)
    const marker = (fill, ring) => makeImage(30, 30, (c) => {
      c.translate(15, 16);
      c.beginPath(); c.moveTo(0, -14); c.lineTo(5.6, -7.6); c.arc(0, 0, 9.4, -0.94, Math.PI + 0.94, false); c.lineTo(-5.6, -7.6); c.closePath();
      c.fillStyle = ring; c.fill();
      c.beginPath(); c.arc(0, 0, 7.4, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
      c.beginPath(); c.moveTo(0, -4); c.lineTo(3.4, 2.2); c.lineTo(0, 0.6); c.lineTo(-3.4, 2.2); c.closePath(); c.fillStyle = '#1a0a02'; c.fill();
    });
    map.addImage('bus-marker', ...marker('#ff6a1f', '#ffffff'));
    map.addImage('bus-marker-stale', ...marker('#8d7b70', '#c9c2bd'));
    // stretchable chip behind route labels
    map.addImage('chip', ...makeImage(24, 20, (c) => {
      c.fillStyle = '#ff6a1f'; c.strokeStyle = 'rgba(11,15,20,0.9)'; c.lineWidth = 1.5;
      c.beginPath();
      if (c.roundRect) c.roundRect(1, 1, 22, 18, 6); else c.rect(1, 1, 22, 18);
      c.fill(); c.stroke();
    }, { stretchX: [[8, 16]], stretchY: [[8, 12]], content: [5, 3, 19, 17] }));
  }

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const Z3D = 13.6; // 3D models above this zoom
  function addLayers() {
    addImages();
    const firstLabel = (map.getStyle().layers.find((l) => l.type === 'symbol' && l.layout && l.layout['text-field']) || {}).id;

    // metro network (context, scheduled service)
    map.addSource('metro', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'metro-lines', type: 'line', source: 'metro', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 15, 4], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.38, 14, 0.55] } }, firstLabel);
    map.addLayer({ id: 'metro-stations', type: 'circle', source: 'metro', minzoom: 12.5, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 2.5, 16, 5], 'circle-color': '#0b0f14', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-opacity': 0.9 } });
    map.addLayer({ id: 'metro-names', type: 'symbol', source: 'metro', minzoom: 14, filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'], 'text-optional': true },
      paint: { 'text-color': '#c9d2de', 'text-halo-color': '#0b0f14', 'text-halo-width': 1.4 } });

    // bus stops (zoomed in)
    map.addSource('stops', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'stops', type: 'circle', source: 'stops', minzoom: 14.5,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 2.5, 18, 5.5], 'circle-color': '#d6dde6', 'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 1.5, 'circle-opacity': 0.85 } });

    // focused route / trip legs
    map.addSource('trip', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'trip-casing', type: 'line', source: 'trip', filter: ['!=', ['get', 'kind'], 'walk'], layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#0b0f14', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11], 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 0.9] } });
    map.addLayer({ id: 'trip-line', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'bus'], layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ff6a1f', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7], 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] } });
    map.addLayer({ id: 'trip-metro', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'metro'], layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9], 'line-dasharray': [2.2, 0.8] } });
    map.addLayer({ id: 'trip-walk', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'walk'], layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#c9d4e2', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 4.5], 'line-dasharray': [0.1, 1.8] } });
    map.addSource('trip-pts', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'trip-pts', type: 'circle', source: 'trip-pts',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 16, 7], 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 4] } });
    map.addLayer({ id: 'trip-pt-names', type: 'symbol', source: 'trip-pts', minzoom: 12,
      layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-max-width': 9 },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b0f14', 'text-halo-width': 1.6 } });

    // live buses
    map.addSource('buses', { type: 'geojson', data: EMPTY });
    map.addSource('sel', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'bus-sel', type: 'circle', source: 'sel',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 11, 14, 17, 17, 26], 'circle-color': 'rgba(61,220,132,0.16)', 'circle-stroke-color': '#3ddc84', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'bus-dot', type: 'circle', source: 'buses', maxzoom: 12.9,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.5, 1.6, 11, 2.8, 12.5, 4.2],
        'circle-color': ['case', ['==', ['get', 'st'], 1], '#8d7b70', '#ff6a1f'],
        'circle-stroke-color': '#0b0f14', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 12, 1],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12.2, 1, 12.6, 0],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 12.2, 1, 12.6, 0],
      } });
    map.addLayer({ id: 'bus-marker', type: 'symbol', source: 'buses', minzoom: 12.2,
      layout: {
        'icon-image': ['case', ['==', ['get', 'st'], 1], 'bus-marker-stale', 'bus-marker'],
        'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12.2, 0.72, 14, 0.95, 17, 1.15],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 12.2, 0, 12.6, 1] } });
    map.addLayer({ id: 'bus-label', type: 'symbol', source: 'buses', minzoom: 13.2, filter: ['!=', ['get', 'r'], ''],
      layout: {
        'text-field': ['get', 'r'], 'text-size': 11.5, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
        'icon-image': 'chip', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 4, 1, 4],
        'text-anchor': 'bottom', 'text-offset': ['interpolate', ['linear'], ['zoom'], 13.2, ['literal', [0, -1.1]], 15, ['literal', [0, -1.7]], 17, ['literal', [0, -2.4]], 19, ['literal', [0, -4.2]]], 'icon-anchor': 'bottom', 'symbol-sort-key': ['get', 'k'],
        'text-allow-overlap': false, 'icon-allow-overlap': false, 'text-padding': 1, 'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': '#1a0a02', 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 13.2, 0, 13.5, 1], 'text-opacity': ['interpolate', ['linear'], ['zoom'], 13.2, 0, 13.5, 1] } });
    // invisible, generous tap targets (work at every zoom, under 3D models too)
    map.addLayer({ id: 'bus-hit', type: 'circle', source: 'buses',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 12, 10, 14, 17, 17, 24], 'circle-color': '#000', 'circle-opacity': 0 } });

    map.addLayer(bus3dLayer, 'bus-label'); // models under the route chips
  }

  /* =============================== 3. feed + motion =============================== */
  const REFRESH_MS = 15000;
  const MOTION_MS = REFRESH_MS + 1500;  // glide slightly longer than the gap so buses never pause
  const STALE_S = 180;                 // a position older than this is drawn dimmed
  const M = new Map();                 // id -> {fl, fo, fb, tl, to, tb, t0}
  let animEnd = 0;

  function lerpAngle(a, b, f) { const d = ((b - a + 540) % 360) - 180; return (a + d * f + 360) % 360; }
  function pos(id, now) {
    const m = M.get(id);
    if (!m) return null;
    let f = (now - m.t0) / MOTION_MS; f = f < 0 ? 0 : f > 1 ? 1 : f;
    return { lat: m.fl + (m.tl - m.fl) * f, lon: m.fo + (m.to - m.fo) * f, b: lerpAngle(m.fb, m.tb, Math.min(1, f * 4)) };
  }

  function ingest(list, labels) {
    const now = performance.now();
    const seen = new Set();
    S.byRoute = new Map();
    for (const b of list) {
      seen.add(b.id);
      const prev = M.get(b.id);
      let brg = b.bearing || 0;
      if (prev) {
        const cur = pos(b.id, now);
        const moved = hav(cur.lat, cur.lon, b.lat, b.lon);
        if (!b.bearing && moved > 8) brg = (Math.atan2((b.lon - cur.lon) * Math.cos(toRad(b.lat)), b.lat - cur.lat) * 180) / Math.PI;
        if (!b.bearing && moved <= 8) brg = cur.b;
        if (moved > 2500) M.set(b.id, { fl: b.lat, fo: b.lon, fb: brg, tl: b.lat, to: b.lon, tb: brg, t0: now }); // teleport: snap
        else M.set(b.id, { fl: cur.lat, fo: cur.lon, fb: cur.b, tl: b.lat, to: b.lon, tb: (brg + 360) % 360, t0: now });
      } else {
        M.set(b.id, { fl: b.lat, fo: b.lon, fb: brg, tl: b.lat, to: b.lon, tb: brg, t0: now - MOTION_MS });
      }
      b.bearing = (brg + 360) % 360;
      S.buses.set(b.id, b);
      let arr = S.byRoute.get(b.route_id); if (!arr) S.byRoute.set(b.route_id, (arr = [])); arr.push(b);
    }
    for (const id of [...S.buses.keys()]) if (!seen.has(id)) { S.buses.delete(id); M.delete(id); }
    if (labels) for (const [rid, l] of labels) S.labels.set(rid, l);
    animEnd = now + MOTION_MS;
    if (S.focusRoutes) recomputeFocus();
    refreshView(true);
    kick();
  }

  // decode compact payload (v2) to bus records
  function decode(p) {
    const labels = new Map(p.r.map((rid, i) => [rid, p.l[i]]));
    const list = p.b.map((x) => ({
      id: x[0], route_id: p.r[x[1]], route: p.l[x[1]], lat: x[2] / 1e5, lon: x[3] / 1e5, bearing: x[4],
      speed: x[5] < 0 ? null : x[5] / 10, ts: x[6] < 0 ? null : p.t0 + x[6],
    }));
    return { list, labels };
  }

  let fetchCtl = null, pollT = null;
  async function refresh() {
    clearTimeout(pollT);
    if (document.hidden && S.lastOk) { pollT = setTimeout(refresh, REFRESH_MS); return; }
    if (fetchCtl) return; // one request at a time; never restart an in-flight fetch
    fetchCtl = new AbortController();
    const to = setTimeout(() => fetchCtl && fetchCtl.abort(), 12000);
    S.fetching = true; renderStatus();
    try {
      const p = await (await fetch('/api/vehicles?v=2', { signal: fetchCtl.signal })).json();
      if (!p || !p.b) throw new Error('bad payload');
      const { list, labels } = decode(p);
      S.meta = p; S.lastOk = Date.now(); S.failures = 0;
      ingest(list, labels);
      if (S.mode === 'bus' && S.selectedId) refreshBusSheet();
      if (S.mode === 'dest') updateDestLive();
    } catch (e) {
      S.failures++;
    } finally {
      clearTimeout(to); fetchCtl = null; S.fetching = false; renderStatus();
      pollT = setTimeout(refresh, S.failures ? Math.min(REFRESH_MS, 4000 * S.failures) : REFRESH_MS);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.fetching && S.lastOk && Date.now() - S.lastOk > 8000) refresh(); });

  function renderStatus() {
    const m = S.meta, el = ui.status;
    el.classList.toggle('fetching', S.fetching);
    let cls = '', text = 'Connecting…', banner = null, bcls = '';
    const sinceOk = S.lastOk ? (Date.now() - S.lastOk) / 1000 : Infinity;
    if (m) {
      const t = clock(new Date(m.updated));
      const n = (S.focus ? S.focus.size : m.count).toLocaleString('en-IN');
      text = `<b>${n}</b> ${S.focus ? 'shown' : 'live'} · ${t}${m.source === 'mirror' ? ' · backup feed' : ''}`;
      if (m.demo) { cls = 'bad'; text = `<b>Demo</b> · simulated buses`; banner = 'Live feed unavailable. Showing simulated buses (demo).'; bcls = 'bad'; }
      else if (m.stale) { cls = 'warn'; banner = `Live feed is down. Showing positions from ${Math.max(1, Math.round((m.stale_s || 0) / 60))} min ago.`; }
    }
    if (S.failures && sinceOk > 40) { cls = 'warn'; text = m ? `${text.replace(/ · backup feed/, '')} · offline` : 'Offline · retrying'; banner = "Can't reach the server. Retrying…"; bcls = ''; }
    el.className = `${cls}${S.fetching ? ' fetching' : ''}`;
    ui.statusText.innerHTML = text;
    if (banner) { ui.banner.textContent = banner; ui.banner.className = bcls; } else ui.banner.className = 'hidden';
  }
  setInterval(renderStatus, 10000);

  /* ---- view sync: push interpolated positions to the map at a zoom-appropriate rate ---- */
  let viewIds = [];       // buses inside the padded viewport (or all, zoomed out)
  let lastPush = 0, rafId = 0;
  function inFocus(id) { return !S.focus || S.focus.has(id); }
  function refreshView(force) {
    const z = map.getZoom();
    const all = z < 11.5;
    if (all) viewIds = [...S.buses.keys()].filter(inFocus);
    else {
      const b = map.getBounds(), padLat = (b.getNorth() - b.getSouth()) * 0.35, padLon = (b.getEast() - b.getWest()) * 0.35;
      const s = b.getSouth() - padLat, n = b.getNorth() + padLat, w = b.getWest() - padLon, e = b.getEast() + padLon;
      viewIds = [];
      for (const [id, bus] of S.buses) if (bus.lat > s && bus.lat < n && bus.lon > w && bus.lon < e && inFocus(id)) viewIds.push(id);
    }
    if (force) { lastPush = 0; kick(); }
  }
  // how often positions must reach the GPU so steps stay under ~0.5 px
  function pushInterval(z) {
    const mpp = (78271.5 * Math.cos(toRad(28.6))) / 2 ** z;
    const pxPerSec = 6 / mpp; // 6 m/s ~ 22 km/h, a moving Delhi bus
    return Math.max(66, Math.min(3000, 500 / pxPerSec));
  }
  function frame() {
    rafId = 0;
    const now = performance.now();
    const z = map.getZoom();
    const moving = now < animEnd;
    const iv = pushInterval(z) * (S.interacting && z < 14 ? 4 : 1);
    if (now - lastPush >= iv) { pushSource(now); lastPush = now; }
    if (S.followId) followTick(now);
    if (bus3d.ready && z >= Z3D - 0.3 && moving) map.triggerRepaint();
    if (moving || S.followId) rafId = requestAnimationFrame(frame);
  }
  function kick() { if (!rafId) rafId = requestAnimationFrame(frame); }

  function pushSource(now) {
    const src = map.getSource('buses');
    if (!src) return;
    const nowS = Date.now() / 1000;
    const feats = new Array(viewIds.length);
    let k = 0;
    for (const id of viewIds) {
      const b = S.buses.get(id), p = pos(id, now);
      if (!b || !p) continue;
      feats[k++] = { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id, r: b.route || routeLabel(b.route_id), b: Math.round(p.b), st: b.ts && nowS - b.ts > STALE_S ? 1 : 0, k: id === S.selectedId ? 0 : 1 } };
    }
    feats.length = k;
    src.setData({ type: 'FeatureCollection', features: feats });
    if (S.selectedId) {
      const p = pos(S.selectedId, now);
      map.getSource('sel').setData(p ? { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {} } : EMPTY);
    }
  }

  function followTick(now) {
    if (S.interacting) return;
    const p = pos(S.followId, now);
    if (!p) return;
    const c = map.getCenter();
    if (Math.abs(c.lng - p.lon) + Math.abs(c.lat - p.lat) > 1e-7) map.setCenter([p.lon, p.lat]);
  }
  function stopFollow(silent) {
    if (!S.followId) return;
    S.followId = null;
    if (!silent) toast('Stopped following');
    const btn = ui.sheetBody.querySelector('[data-act="follow"]');
    if (btn) { btn.classList.remove('on'); btn.lastChild.textContent = 'Follow'; }
  }
  function startFollow(id) {
    S.followId = id;
    const p = pos(id, performance.now());
    if (p) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 700, padding: sheetPadding() });
    setTimeout(kick, 720);
  }

  /* =============================== 4. bottom sheet =============================== */
  const sheet = {
    state: 'closed', onClose: null,
    heights() {
      const H = ui.sheet.offsetHeight, vh = window.innerHeight;
      return { full: 0, half: Math.max(0, H - Math.round(vh * 0.5)), peek: Math.max(0, H - 210), closed: H + 20 };
    },
    set(state) {
      this.state = state;
      ui.sheet.style.transform = `translateY(${this.heights()[state]}px)`;
      ui.sheet.setAttribute('aria-hidden', state === 'closed');
      document.body.classList.toggle('sheet-open', state !== 'closed');
      ui.sheet.classList.remove('peek', 'half', 'full'); if (state !== 'closed') ui.sheet.classList.add(state);
    },
    open(html, state, onClose) {
      const prev = this.onClose; this.onClose = null;
      if (prev) prev(true);
      ui.sheetBody.innerHTML = `<div class="sheet-fade">${html}</div>`;
      ui.sheetBody.scrollTop = 0;
      this.onClose = onClose || null;
      this.set(state || 'half');
    },
    update(html) { ui.sheetBody.innerHTML = html; },
    close() {
      const cb = this.onClose; this.onClose = null;
      this.set('closed');
      if (cb) cb(false);
    },
    visible() { return this.state === 'closed' ? 0 : ui.sheet.offsetHeight - this.heights()[this.state]; },
  };
  function sheetPadding() {
    const top = (document.getElementById('appbar').getBoundingClientRect().bottom || 120) + 52; // room for the 42 px destination pin
    const wide = window.innerWidth >= 720;
    return wide ? { top: 40, bottom: 40, left: 460, right: 60 } : { top, bottom: Math.min(window.innerHeight * 0.55, sheet.visible() || window.innerHeight * 0.5) + 16, left: 40, right: 40 };
  }
  // drag: grabber, header, or the body when scrolled to top
  (() => {
    let y0 = null, t0 = 0, base = 0, dy = 0, fromBody = false;
    const down = (e, body) => {
      if (sheet.state === 'closed') return;
      if (body && ui.sheetBody.scrollTop > 0) return;
      y0 = e.clientY; t0 = performance.now(); base = sheet.heights()[sheet.state]; dy = 0; fromBody = body;
    };
    const move = (e) => {
      if (y0 == null) return;
      dy = e.clientY - y0;
      if (fromBody && (dy < 0 && sheet.state === 'full')) { y0 = null; return; }
      if (Math.abs(dy) < 6) return;
      ui.sheet.classList.add('dragging');
      ui.sheet.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
    };
    const up = () => {
      if (y0 == null) return;
      ui.sheet.classList.remove('dragging');
      const v = dy / Math.max(1, performance.now() - t0); // px/ms
      const h = sheet.heights(), at = base + dy;
      y0 = null;
      if (Math.abs(dy) < 6) return;
      if (v > 0.9 || at > h.peek + 60) return sheet.close();
      const order = ['full', 'half', 'peek'];
      let target;
      if (v < -0.5) target = order[Math.max(0, order.indexOf(sheet.state) - 1)];
      else if (v > 0.5) target = order[Math.min(2, order.indexOf(sheet.state) + 1)];
      else target = order.reduce((a, s) => (Math.abs(h[s] - at) < Math.abs(h[a] - at) ? s : a), 'half');
      sheet.set(target);
    };
    ui.grab.addEventListener('pointerdown', (e) => { down(e, false); ui.grab.setPointerCapture(e.pointerId); });
    ui.grab.addEventListener('pointermove', move);
    ui.grab.addEventListener('pointerup', up); ui.grab.addEventListener('pointercancel', up);
    ui.sheetBody.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (e.target.closest('.sh')) down(t, false); else down(t, true); }, { passive: true });
    ui.sheetBody.addEventListener('touchmove', (e) => { if (y0 != null && !(fromBody && ui.sheetBody.scrollTop > 0)) move(e.touches[0]); }, { passive: true });
    ui.sheetBody.addEventListener('touchend', up);
    window.addEventListener('resize', () => sheet.set(sheet.state));
  })();

  const head = (title, sub, lead) => `
    <div class="sh">${lead || ''}<div class="sh-main"><div class="sh-title">${title}</div>${sub ? `<div class="sh-sub">${sub}</div>` : ''}</div>
    <button class="sh-close" data-act="close" aria-label="Close">${ico('x')}</button></div>`;
  const skeleton = (n) => Array.from({ length: n || 3 }, () => '<div class="skel card-sk"></div>').join('');
  const empty = (icon, title, sub, btn) => `<div class="empty"><div class="empty-ic">${ico(icon)}</div><div class="empty-t">${title}</div>${sub ? `<div class="empty-s">${sub}</div>` : ''}${btn || ''}</div>`;
  const badge = (label, cls, style) => `<span class="rb ${cls || ''}"${style ? ` style="${style}"` : ''}>${esc(label)}</span>`;
  // readable text on any line colour (Yellow, Aqua and Grey need dark ink)
  const inkFor = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#14110a' : '#ffffff'; };
  const metroBadge = (short, color, cls) => `<span class="rb metro ${cls || ''}" style="background:${esc(color)};color:${inkFor(color)}">${ico('metro')}${esc(short)}</span>`;

  /* =============================== 5. search =============================== */
  let sgItems = [], sgSeq = 0, sgKb = -1;
  let searchSession = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  const routeish = (q) => /^[a-z]{0,4}[-\s]?\d{1,4}[a-z]{0,3}$/i.test(q.trim()) || /^(airport|ac|express|ring|mudrika|exp)/i.test(q.trim());

  function setSearchMode(on) {
    ui.back.classList.toggle('hidden', !on);
    ui.lead.classList.toggle('hidden', on);
  }
  ui.q.addEventListener('focus', () => { if (ui.q.value.trim()) runSuggest(); });
  ui.q.addEventListener('input', () => {
    ui.qClear.classList.toggle('hidden', !ui.q.value);
    if (!ui.q.value.trim()) { hideSuggest(); return; }
    runSuggest();
  });
  ui.q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sgKb = Math.max(0, Math.min(sgItems.length - 1, sgKb + (e.key === 'ArrowDown' ? 1 : -1)));
      ui.suggest.querySelectorAll('.sg-item').forEach((el, i) => el.classList.toggle('kb', i === sgKb));
    }
    if (e.key === 'Enter') { e.preventDefault(); const it = sgItems[sgKb >= 0 ? sgKb : 0]; if (it) pick(it); else runSuggest(true); }
    if (e.key === 'Escape') { hideSuggest(); ui.q.blur(); }
  });
  ui.qClear.addEventListener('click', () => { ui.q.value = ''; ui.qClear.classList.add('hidden'); hideSuggest(); ui.q.focus(); });
  ui.back.addEventListener('click', () => { clearModes(); sheet.close(); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#appbar')) hideSuggest(); });
  function hideSuggest() { ui.suggest.classList.add('hidden'); sgKb = -1; }

  function routeMatches(q) {
    const nq = q.trim().toUpperCase().replace(/\s+/g, '');
    if (!nq) return [];
    const out = new Map();
    const consider = (rid, label, sub) => {
      const L = (label || '').toUpperCase().replace(/\s+/g, '');
      if (!L) return;
      let s = L === nq ? 0 : L.startsWith(nq) ? 1 : L.includes(nq) ? 2 : -1;
      if (s < 0) return;
      const key = L;
      const live = (S.byRoute.get(rid) || []).length;
      const cur = out.get(key);
      if (!cur || s < cur.s) out.set(key, { type: 'route', rid, label, sub, s: s * 10 - Math.min(live, 9), live });
      else cur.live += live;
    };
    if (D.patterns) for (const [rid, p] of Object.entries(D.patterns)) consider(rid, p.sn, p.d[0] ? `${p.d[0].from} – ${p.d[0].to}` : '');
    else for (const [rid, l] of S.labels) consider(rid, l, '');
    return [...out.values()].sort((a, b) => a.s - b.s || a.label.length - b.label.length).slice(0, 4);
  }

  async function runSuggest(force) {
    const q = ui.q.value.trim();
    const seq = ++sgSeq;
    if (!q) return hideSuggest();
    const routes = routeMatches(q);
    let local = [];
    if (D.index) local = Planner.search(D.index, q, 6).map((it) => ({ type: 'place', ...it }));
    else loadPlaces().then(() => { if (seq === sgSeq) runSuggest(); });
    const isRoute = routeish(q);
    const items = isRoute ? [...routes, ...local] : [...local.slice(0, 5), ...routes.slice(0, 3)];
    renderSuggest(items, q.length >= 3, isRoute ? null : 'Places');
    sgItems = items;
    if (q.length >= 3 && !isRoute) mapboxSuggest(q, seq, items);
  }

  const mapboxSuggest = debounce(async (q, seq, base) => {
    try {
      const p = S.userLoc ? `${S.userLoc.lon},${S.userLoc.lat}` : `${map.getCenter().lng},${map.getCenter().lat}`;
      const u = `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(q)}&language=en&country=IN&limit=6&proximity=${p}&bbox=76.75,28.25,77.65,28.95&access_token=${mapboxgl.accessToken}`;
      const d = await getJson(u);
      if (seq !== sgSeq) return;
      const extra = [];
      for (const f of d.features || []) {
        const [lon, lat] = f.geometry.coordinates;
        const name = f.properties.name || f.properties.full_address;
        if (base.concat(extra).some((x) => x.type === 'place' && hav(x.lat, x.lon, lat, lon) < 250 && x.name.toLowerCase().slice(0, 6) === name.toLowerCase().slice(0, 6))) continue;
        extra.push({ type: 'place', kind: 'g', name, lat, lon, sub: f.properties.place_formatted || f.properties.full_address || '', poi: (f.properties.poi_category || [])[0] });
      }
      sgItems = base.concat(extra);
      renderSuggest(sgItems, false);
    } catch {
      if (seq === sgSeq) renderSuggest(sgItems, false);
    }
  }, 260);

  const KIND_IC = { M: 'metro', s: 'stop', r: 'metro', b: 'bus', x: 'place' };
  function renderSuggest(items, loading, headLabel) {
    let html = '';
    if (!items.length && !loading) html = `<div class="sg-empty">No places or routes match “${esc(ui.q.value.trim())}”. Try a landmark, area or metro station.</div>`;
    items.forEach((it, i) => {
      if (it.type === 'route') {
        const live = it.live || (S.byRoute.get(it.rid) || []).length;
        html += `<button class="sg-item" data-i="${i}" role="option"><span class="rb sm">${esc(it.label)}</span><span class="sg-txt"><div class="sg-name">Route ${esc(it.label)}</div><div class="sg-sub">${esc(it.sub || '')}${live ? ` · ${live} live` : ''}</div></span></button>`;
      } else {
        const metro = it.kind === 'M';
        const icStyle = metro && it.lines && it.lines[0] ? ` style="background:${esc(it.lines[0].color)}"` : '';
        const sub = metro ? `Metro · ${it.lines.map((l) => `<span class="ld" style="background:${esc(l.color)}"></span>${esc(l.short)}`).join(' ')}`
          : esc(it.kind === 'g' ? (it.sub || 'Place') : Planner.KIND_LABEL[it.kind] || 'Place');
        html += `<button class="sg-item" data-i="${i}" role="option"><span class="sg-ic${metro ? ' metro' : ''}"${icStyle}>${ico(KIND_IC[it.kind] || 'place')}</span><span class="sg-txt"><div class="sg-name">${esc(it.name)}</div><div class="sg-sub">${sub}</div></span></button>`;
      }
    });
    if (loading) html += `<div class="sg-loading"><span class="spin"></span>Searching places…</div>`;
    ui.suggest.innerHTML = html;
    ui.suggest.classList.remove('hidden');
  }
  ui.suggest.addEventListener('click', (e) => {
    const b = e.target.closest('.sg-item');
    if (b) pick(sgItems[+b.dataset.i]);
  });

  function pick(it) {
    hideSuggest(); ui.q.blur();
    if (it.type === 'route') { ui.q.value = `Route ${it.label}`; ui.qClear.classList.remove('hidden'); setSearchMode(true); showRoute(it.rid); return; }
    ui.q.value = it.name; ui.qClear.classList.remove('hidden'); setSearchMode(true);
    goTo({ name: it.name, lat: it.lat, lon: it.lon, kind: it.kind, stop_id: it.stop_id });
  }

  /* =============================== 6. destination: direct buses =============================== */
  function setDestMarker(d) {
    if (S.destMarker) S.destMarker.remove();
    if (!d) { S.destMarker = null; return; }
    const el = document.createElement('div'); el.className = 'dest-marker'; el.innerHTML = ico('pin');
    S.destMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([d.lon, d.lat]).addTo(map);
  }
  function setMe(loc) {
    S.userLoc = loc;
    if (!S.meMarker) { const el = document.createElement('div'); el.className = 'me-marker'; S.meMarker = new mapboxgl.Marker({ element: el }); }
    S.meMarker.setLngLat([loc.lon, loc.lat]).addTo(map);
    ui.btnLocate.classList.add('on');
  }
  function locate(timeout) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Location is not available on this device'));
      ui.btnLocate.classList.add('busy');
      navigator.geolocation.getCurrentPosition(
        (p) => { ui.btnLocate.classList.remove('busy'); const loc = { lat: p.coords.latitude, lon: p.coords.longitude, name: 'Your location' }; setMe(loc); resolve(loc); },
        (e) => { ui.btnLocate.classList.remove('busy'); reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location')); },
        { enableHighAccuracy: true, timeout: timeout || 9000, maximumAge: 30000 });
    });
  }
  ui.btnLocate.addEventListener('click', async () => {
    try { const loc = await locate(); map.flyTo({ center: [loc.lon, loc.lat], zoom: Math.max(map.getZoom(), 15), duration: 900, padding: sheetPadding() }); }
    catch (e) { toast(e.message); }
  });

  function fitTo(points, maxZoom) {
    const pts = points.filter(Boolean);
    if (!pts.length) return;
    if (pts.length === 1) return map.easeTo({ center: [pts[0].lon, pts[0].lat], zoom: Math.max(map.getZoom(), 15), duration: 700, padding: sheetPadding() });
    const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: sheetPadding(), maxZoom: maxZoom || 16, duration: 750 });
  }

  function setFocus(ids, label, routes) {
    S.focus = ids ? new Set(ids) : null;
    S.focusRoutes = routes || null;
    ui.chipFocus.classList.toggle('hidden', !ids);
    if (ids) ui.chipFocusLabel.textContent = label;
    refreshView(true); renderStatus(); map.triggerRepaint();
  }
  ui.chipFocus.addEventListener('click', () => { clearModes(); sheet.close(); });
  let focusFilter = null; // fn(bus) -> bool, re-applied when new positions arrive
  function recomputeFocus() {
    if (!focusFilter) return;
    const ids = [];
    for (const b of S.buses.values()) if (focusFilter(b)) ids.push(b.id);
    S.focus = new Set(ids);
  }

  function clearModes() {
    S.mode = null; S.dest = null; S.results = null; focusFilter = null;
    setFocus(null); setDestMarker(null); clearTrip(); select(null); stopFollow(true);
    setSearchMode(false); ui.q.value = ''; ui.qClear.classList.add('hidden');
  }

  /* direct options: a route-direction serving a stop near you, then a stop near the destination */
  function directOptions(origin, dest) {
    const boards = stopsNear(origin.lat, origin.lon, 850).slice(0, 80);
    const alights = stopsNear(dest.lat, dest.lon, 650).slice(0, 60);
    const boardWalk = new Map(boards.map((x) => [x.s.id, x.d]));
    const opts = new Map();
    for (const a of alights) {
      for (const rid of D.stopRoutes[a.s.id] || []) {
        for (const g of patternGeom(rid) || []) {
          const aPos = g.pos.get(a.s.id); if (!aPos) continue;
          for (const ai of aPos) {
            for (let bi = 0; bi < ai; bi++) {
              const wB = boardWalk.get(g.pts[bi].id); if (wB == null) continue;
              const rideM = g.cum[ai] - g.cum[bi];
              if (rideM < 300) continue;
              const rideS = (rideM * BUS_DETOUR) / BUS_MS + BUS_DWELL * (ai - bi);
              const cost = walkSecs(wB) + rideS + walkSecs(a.d);
              const key = `${rid}:${g.di}`;
              const cur = opts.get(key);
              if (!cur || cost < cur.cost) opts.set(key, { rid, g, bi, ai, walkB: wB, walkA: a.d, rideM, rideS, cost, label: routeLabel(rid) });
            }
          }
        }
      }
    }
    // keep the best direction per route label
    const byLabel = new Map();
    for (const o of opts.values()) { const c = byLabel.get(o.label); if (!c || o.cost < c.cost) byLabel.set(o.label, o); }
    return [...byLabel.values()].sort((a, b) => a.cost - b.cost).slice(0, 12);
  }

  /* live buses for an option: running this direction, not yet past the destination stop */
  function liveForOption(o) {
    const out = [];
    for (const b of S.byRoute.get(o.rid) || []) {
      const m = busDirection(b);
      if (!m || m.geom !== o.g) continue;
      const along = m.proj.along;
      if (along > o.g.cum[o.ai] - 30) continue;
      const toBoard = o.g.cum[o.bi] - along;
      out.push({ bus: b, along, toBoard, catchable: toBoard > -15, estS: toBoard > 0 ? (toBoard * BUS_DETOUR) / BUS_MS : 0 });
    }
    return out.sort((a, b) => a.toBoard - b.toBoard);
  }

  function headwayMin(rid) {
    const f = D.freq && D.freq[rid];
    if (!f) return null;
    const p = (s) => { const m = /^(\d+):(\d+)/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const a = p(f[1]), b = p(f[2]);
    if (a == null || b == null) return null;
    let span = b - a; if (span <= 0) span += 1440;
    return Math.max(5, Math.round(span / Math.max(1, f[0])));
  }

  /* the next bus you can actually catch: first live prediction / estimate after you reach the stop */
  function nextBusFor(o, arrivals) {
    const walkS = walkSecs(o.walkB);
    const live = o.live || [];
    const vehicles = new Set(live.map((x) => x.bus.id));
    const preds = (arrivals || []).filter((a) => a.route_id === o.rid && (!vehicles.size || vehicles.has(a.vehicle_id) || !a.vehicle_id));
    const cand = [];
    for (const a of preds) cand.push({ s: a.in_sec, live: true, vehicle: a.vehicle_id });
    for (const x of live) if (x.catchable && !preds.some((a) => a.vehicle_id === x.bus.id)) cand.push({ s: x.estS, live: false, vehicle: x.bus.id });
    cand.sort((a, b) => a.s - b.s);
    const ok = cand.find((c) => c.s >= walkS * 0.85) || null;
    return { next: ok, first: cand[0] || null, headway: headwayMin(o.rid) };
  }

  const destOnClose = (replaced) => { if (!replaced && (S.mode === 'dest' || S.mode === 'trip')) clearModes(); };
  async function goTo(dest) {
    S.mode = 'dest'; S.dest = dest; S.results = null; clearTrip(); select(null); stopFollow(true); focusFilter = null;
    setDestMarker(dest);
    const title = `To ${esc(dest.name)}`;
    sheet.open(`${head(title, 'Finding buses…', `<div class="sh-ic dest">${ico('pin')}</div>`)}<div class="searching"><span class="spin"></span>Looking for routes and live buses</div>${skeleton(3)}`, 'half', destOnClose);
    fitTo([S.userLoc, dest], 15);

    let origin = S.userLoc;
    if (!origin) {
      try { origin = await locate(8000); } catch (e) {
        if (S.dest !== dest) return;
        sheet.update(`${head(title, esc(e.message), `<div class="sh-ic dest">${ico('pin')}</div>`)}
          ${empty('locate', 'Where are you starting from?', 'Bus options depend on which stops you can walk to.', `<div class="actions" style="justify-content:center"><button class="btn primary" data-act="locate-retry">${ico('locate')}Use my location</button><button class="btn" data-act="from-center">Map centre</button></div>`)}`);
        return;
      }
    }
    if (S.dest !== dest) return;
    S.origin = origin;
    fitTo([origin, dest], 15.5);
    const t0 = performance.now();
    try { await Promise.all([loadPatterns(), loadNet()]); } catch {
      sheet.update(`${head(title, '', `<div class="sh-ic dest">${ico('pin')}</div>`)}${empty('bus', 'Could not load route data', 'Check your connection and try again.', `<button class="btn primary" data-act="retry-dest">Try again</button>`)}`);
      return;
    }
    if (S.dest !== dest) return;
    const opts = directOptions(origin, dest);
    for (const o of opts) o.live = liveForOption(o);
    // results first (position-based ETAs), live predictions folded in as soon as they land
    const boardIds = [...new Set(opts.map((o) => o.g.pts[o.bi].id))];
    const arr = opts.length ? await arrivalsForStops(boardIds, 600) : {};
    if (S.dest !== dest) return;
    for (const o of opts) scoreOption(o, arr[o.g.pts[o.bi].id]);
    opts.sort((a, b) => a.total - b.total);
    if (opts.length && boardIds.some((id) => arrInflight.has(id))) {
      arrivalsForStops(boardIds, 20000).then((late) => {
        if (S.dest !== dest || !S.results || S.results.opts !== opts) return;
        for (const o of opts) scoreOption(o, late[o.g.pts[o.bi].id]);
        if (S.mode === 'dest' && S.results.selected == null) { opts.sort((a, b) => a.total - b.total); renderDest(true); }
        else if (S.mode === 'dest') renderDest(true);
      });
    }

    // with one change (bus+bus or bus+metro), and metro alternatives worth showing
    let planned = null;
    try { planned = Planner.plan(D.net, { ...origin, name: origin.name || 'Your location' }, { ...dest }, { max: 4 }); } catch { planned = null; }
    let transfers = [];
    if (planned) {
      const bestDirect = opts.length ? opts[0].total : Infinity;
      transfers = planned.options.filter((p) => !p.walkOnly && (p.rides >= 2 || p.hasMetro) && (!opts.length || p.secs < bestDirect - 300 || p.hasMetro));
      if (opts.length) transfers = transfers.filter((p) => p.rides <= 2).slice(0, 2);
      else transfers = transfers.filter((p) => p.rides <= 2).slice(0, 4);
    }
    const walkOpt = planned && planned.options.find((p) => p.walkOnly);
    S.results = { dest, origin, opts, transfers, walkOpt, selected: null, metroOpen: planned ? planned.metroOpen : true, ms: Math.round(performance.now() - t0) };

    focusFilter = (b) => opts.some((o) => o.rid === b.route_id && o.live.some((x) => x.bus.id === b.id));
    recomputeFocus();
    setFocus([...S.focus], `To ${dest.name}`, opts.map((o) => o.rid));
    drawDestOverview();
    renderDest();
    const pts = [origin, dest];
    for (const o of opts.slice(0, 3)) pts.push(o.g.pts[o.bi]);
    fitTo(pts, 15.5);
  }

  function scoreOption(o, arrivals) {
    const nb = nextBusFor(o, arrivals);
    o.nb = nb;
    const walkS = walkSecs(o.walkB);
    const waitS = nb.next ? Math.max(walkS, nb.next.s) : walkS + (nb.headway ? (nb.headway * 60) / 2 : 900);
    o.total = waitS + o.rideS + walkSecs(o.walkA);
    o.waitS = waitS;
  }

  function updateDestLive() {
    const R = S.results; if (!R) return;
    for (const o of R.opts) o.live = liveForOption(o);
    recomputeFocus(); refreshView(true);
    arrivalsForStops([...new Set(R.opts.map((o) => o.g.pts[o.bi].id))]).then((arr) => {
      if (S.results !== R) return;
      for (const o of R.opts) scoreOption(o, arr[o.g.pts[o.bi].id]);
      if (S.mode === 'dest') renderDest(true);
    });
  }

  function optionCard(o, i, sel) {
    const nb = o.nb || {};
    const boardStop = o.g.pts[o.bi], alightStop = o.g.pts[o.ai];
    const arrive = new Date(Date.now() + o.total * 1000);
    let next;
    if (nb.next) next = `${nb.next.live ? '<span class="tag live">Live</span>' : '<span class="tag est">Est</span>'}<span>Next bus ${nb.next.s < 45 ? '<b>now</b>' : `in <b>${fmtMin(nb.next.s)} min</b>`}</span>`;
    else if (nb.first) next = `<span class="tag est">Live</span><span>Next bus in ${fmtMin(nb.first.s)} min (before you get there)${nb.headway ? `, then ~every ${nb.headway} min` : ''}</span>`;
    else next = `<span class="tag est">No live bus</span><span>${nb.headway ? `Runs about every ${nb.headway} min` : 'None approaching right now'}</span>`;
    const liveCount = (o.live || []).filter((x) => x.catchable).length;
    return `<div class="card tap opt${sel ? ' sel' : ''}" data-act="opt" data-i="${i}">
      <div class="opt-top">
        ${badge(o.label, 'lg')}
        <div style="flex:1;min-width:0">
          <div class="sg-name" style="font-size:15px">Towards ${esc(o.g.to)}</div>
          <div class="opt-arrive">${o.ai - o.bi} stops · ${fmtMin(o.rideS)} min ride${liveCount ? ` · ${liveCount} on the way` : ''}</div>
        </div>
        <div class="eta"><div class="opt-time">${fmtMin(o.total)}<small>min</small></div><div class="opt-arrive">arr ${clock(arrive)}</div></div>
      </div>
      <div class="opt-detail">
        <div class="r">${ico('walk')}<span>Walk <b>${fmtDist(o.walkB * WALK_DETOUR)}</b> (${mins(walkSecs(o.walkB))} min) to <b>${esc(boardStop.name)}</b></span></div>
        <div class="r">${ico('bus')}<span>Get off at <b>${esc(alightStop.name)}</b></span></div>
        <div class="r">${ico('walk')}<span>Walk ${fmtDist(o.walkA * WALK_DETOUR)} (${mins(walkSecs(o.walkA))} min) to destination</span></div>
      </div>
      <div class="opt-next">${next}</div>
      ${sel ? optionActions(o) : ''}
    </div>`;
  }
  function nextVehicle(o) { const n = o.nb && (o.nb.next || o.nb.first); return n ? n.vehicle : null; }
  function optionActions(o) {
    const id = nextVehicle(o);
    return `<div class="actions" style="margin:12px 0 0">
      ${id && S.buses.has(id) ? `<button class="btn primary" data-act="follow-bus" data-id="${esc(id)}">${ico('follow')}Follow next bus</button>` : ''}
      <button class="btn" data-act="opt-back">All options</button></div>`;
  }

  function legChips(p) {
    const parts = [];
    for (const l of p.legs) {
      if (l.type === 'walk') { if (l.secs > 120) parts.push(`<span class="w">${ico('walk')}${mins(l.secs)}</span>`); continue; }
      parts.push(l.type === 'metro' ? metroBadge(l.label, l.color, 'sm') : badge(l.label, 'sm'));
    }
    return parts.join(`<svg viewBox="0 0 24 24" class="sep"><use href="#i-chev"/></svg>`);
  }
  function planCard(p, i) {
    const arrive = new Date(Date.now() + p.secs * 1000);
    const firstRide = p.legs.find((l) => l.type !== 'walk');
    const desc = p.legs.filter((l) => l.type !== 'walk').map((l) => (l.type === 'metro' ? `${esc(l.label)} Line` : `Bus ${esc(l.label)}`)).join(' → ');
    return `<div class="card tap opt" data-act="plan" data-i="${i}">
      <div class="opt-top"><div style="flex:1;min-width:0"><div class="opt-legs" style="margin-top:0">${legChips(p)}</div>
        <div class="opt-arrive" style="margin-top:8px">${desc}${firstRide ? ` · from ${esc(firstRide.board.name)}` : ''}</div></div>
        <div class="eta"><div class="opt-time">${fmtMin(p.secs)}<small>min</small></div><div class="opt-arrive">arr ~${clock(arrive)}</div></div></div>
      ${p.hasMetro ? `<div class="opt-next"><span class="tag sched">Metro scheduled</span><span>No live metro times. Buses are live.</span></div>` : ''}
    </div>`;
  }

  function renderDest(soft) {
    const R = S.results; if (!R) return;
    const { dest, opts, transfers } = R;
    const nLive = opts.reduce((n, o) => n + (o.live || []).length, 0);
    const sub = opts.length ? `${opts.length} direct bus${opts.length > 1 ? 'es' : ''} · ${nLive} live on the way` : 'No direct bus';
    let html = head(`To ${esc(dest.name)}`, `From ${esc((R.origin && R.origin.name) || 'your location')} · ${sub}`, `<div class="sh-ic dest">${ico('pin')}</div>`);
    if (opts.length) {
      // a much faster metro/transfer route goes first, clearly labelled; buses stay the default otherwise
      const faster = transfers.map((p, i) => [p, i]).filter(([p]) => p.secs < opts[0].total - 600);
      const rest = transfers.map((p, i) => [p, i]).filter(([p]) => !(p.secs < opts[0].total - 600));
      if (faster.length) html += `<div class="sec" style="margin-top:0">Faster with a change</div>` + faster.map(([p, i]) => planCard(p, i)).join('') + `<div class="sec">Direct buses</div>`;
      html += opts.map((o, i) => optionCard(o, i, R.selected === i)).join('');
      if (rest.length) html += `<div class="sec">Other ways <span class="fill"></span></div>` + rest.map(([p, i]) => planCard(p, i)).join('');
    } else if (transfers.length) {
      html += `<div class="note" style="margin:0 0 12px">No single bus goes from near you to ${esc(dest.name)}. With one change:</div>` + transfers.map((p, i) => planCard(p, i)).join('');
    } else if (R.walkOpt) {
      html += empty('walk', `It's a ${mins(R.walkOpt.secs)} min walk`, `No bus route beats walking ${fmtDist(R.walkOpt.walkM)} from here.`);
    } else {
      html += empty('bus', 'No bus route found', `Nothing within walking distance of you reaches ${esc(dest.name)}${R.metroOpen ? '' : ', and the metro is closed now'}. Try a nearby landmark or metro station.`);
    }
    if (opts.length || transfers.length) html += `<div class="note">Times use live bus positions and predictions where available. Metro times are scheduled estimates, not live. Delhi traffic makes all times rough.</div>`;
    const top = ui.sheetBody.scrollTop;
    sheet.update(soft ? html : `<div class="sheet-fade">${html}</div>`);
    ui.sheetBody.scrollTop = top;
  }

  function drawDestOverview() {
    const R = S.results; if (!R) return;
    const feats = [];
    R.opts.slice(0, 6).forEach((o, i) => {
      feats.push(lineFeat(o.g.pts.slice(o.bi, o.ai + 1).map((p) => [p.lon, p.lat]), { kind: 'bus', dim: i === 0 ? 0 : 1 }));
    });
    const o = R.opts[0];
    if (o) {
      feats.push(lineFeat([[R.origin.lon, R.origin.lat], [o.g.pts[o.bi].lon, o.g.pts[o.bi].lat]], { kind: 'walk' }));
      feats.push(lineFeat([[o.g.pts[o.ai].lon, o.g.pts[o.ai].lat], [R.dest.lon, R.dest.lat]], { kind: 'walk' }));
    }
    setTrip(feats, o ? [ptFeat(o.g.pts[o.bi], '#ff6a1f'), ptFeat(o.g.pts[o.ai], '#ff6a1f')] : []);
  }

  function selectOption(i) {
    const R = S.results; if (!R) return;
    const o = R.opts[i]; if (!o) return;
    R.selected = i;
    const g = o.g, b = g.pts[o.bi], a = g.pts[o.ai];
    setTrip([
      lineFeat(g.pts.map((p) => [p.lon, p.lat]), { kind: 'bus', dim: 1 }),
      lineFeat(g.pts.slice(o.bi, o.ai + 1).map((p) => [p.lon, p.lat]), { kind: 'bus' }),
      lineFeat([[R.origin.lon, R.origin.lat], [b.lon, b.lat]], { kind: 'walk' }),
      lineFeat([[a.lon, a.lat], [R.dest.lon, R.dest.lat]], { kind: 'walk' }),
    ], [ptFeat(b, '#ff6a1f', b.name), ptFeat(a, '#ff6a1f', a.name)]);
    focusFilter = (bus) => bus.route_id === o.rid && liveForOption(o).some((x) => x.bus.id === bus.id);
    recomputeFocus();
    setFocus([...S.focus], `Route ${o.label}`, [o.rid]);
    const nextId = nextVehicle(o);
    renderDest(true);
    const card = ui.sheetBody.querySelector(`.card[data-i="${i}"][data-act="opt"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const bus = nextId && S.buses.get(nextId);
    fitTo([R.origin, b, a, R.dest, bus && pos(bus.id, performance.now())], 16);
  }

  /* map drawing helpers */
  const lineFeat = (coords, props) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props || {} });
  const ptFeat = (p, color, name) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { color, name: name || '' } });
  function setTrip(lines, pts) {
    if (!map.getSource('trip')) return;
    map.getSource('trip').setData({ type: 'FeatureCollection', features: lines });
    map.getSource('trip-pts').setData({ type: 'FeatureCollection', features: pts || [] });
  }
  function clearTrip() { setTrip([], []); }

  /* =============================== 7. trip planner (step-by-step) =============================== */
  function metroSlice(lineId, a, b) {
    const line = D.metro.lines.find((l) => l.id === lineId);
    if (!line) return [];
    if (!line._cum) { line._cum = [0]; for (let i = 1; i < line.coords.length; i++) line._cum.push(line._cum[i - 1] + hav(line.coords[i - 1][1], line.coords[i - 1][0], line.coords[i][1], line.coords[i][0])); }
    const lo = Math.min(a, b), hi = Math.max(a, b), c = line.coords, cum = line._cum, out = [];
    const at = (d) => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f]; };
    out.push(at(lo));
    for (let i = 0; i < c.length; i++) if (cum[i] > lo && cum[i] < hi) out.push(c[i]);
    out.push(at(hi));
    return a > b ? out.reverse() : out;
  }

  async function showPlan(p) {
    S.mode = 'trip';
    const R = S.results;
    const lines = [], pts = [];
    for (const l of p.legs) {
      if (l.type === 'walk') lines.push(lineFeat([[l.from.lon, l.from.lat], [l.to.lon, l.to.lat]], { kind: 'walk' }));
      else if (l.type === 'bus') { lines.push(lineFeat(l.stops.map((s) => [s.lon, s.lat]), { kind: 'bus' })); pts.push(ptFeat(l.board, '#ff6a1f', l.board.name), ptFeat(l.alight, '#ff6a1f', l.alight.name)); }
      else { lines.push(lineFeat(metroSlice(l.line_id, l.alongFrom, l.alongTo), { kind: 'metro', color: l.color })); pts.push(ptFeat(l.board, l.color, l.board.name), ptFeat(l.alight, l.color, l.alight.name)); }
    }
    setTrip(lines, pts);
    const busRids = p.legs.filter((l) => l.type === 'bus').map((l) => l.route_id);
    focusFilter = (b) => busRids.includes(b.route_id);
    recomputeFocus();
    setFocus([...S.focus], 'This trip', busRids);
    const arrive = new Date(Date.now() + p.secs * 1000);
    const steps = [];
    p.legs.forEach((l, i) => {
      const last = i === p.legs.length - 1;
      if (l.type === 'walk') {
        steps.push(`<div class="step"><div class="step-rail"><div class="step-ic">${ico('walk')}</div><div class="step-line walk"></div></div>
          <div class="step-body"><div class="step-t">Walk ${mins(l.secs)} min</div><div class="step-s">${fmtDist(l.dist)} to <b>${esc(last ? (R ? R.dest.name : l.to.name) : l.to.name)}</b></div></div></div>`);
      } else if (l.type === 'bus') {
        steps.push(`<div class="step" data-leg="${i}"><div class="step-rail"><div class="step-ic bus">${ico('bus')}</div><div class="step-line bus"></div></div>
          <div class="step-body"><div class="step-row" style="margin-top:0">${badge(l.label)}<span class="step-t">towards ${esc(l.headsign)}</span></div>
          <div class="step-s">Board at <b>${esc(l.board.name)}</b>, ride ${l.stops.length - 1} stops (~${mins(l.rideSecs)} min), get off at <b>${esc(l.alight.name)}</b></div>
          <div class="step-row" data-live="${i}"><span class="spin"></span><span class="step-s" style="margin:0">Checking live buses…</span></div></div></div>`);
      } else {
        steps.push(`<div class="step"><div class="step-rail"><div class="step-ic metro" style="background:${esc(l.color)};color:${inkFor(l.color)}">${ico('metro')}</div><div class="step-line" style="background:${esc(l.color)}"></div></div>
          <div class="step-body"><div class="step-row" style="margin-top:0">${metroBadge(l.label + ' Line', l.color)}<span class="tag sched">Scheduled</span></div>
          <div class="step-s" style="margin-top:6px">Towards <b>${esc(l.headsign)}</b>. Board at <b>${esc(l.board.name)}</b>, ${l.stops.length - 1} station${l.stops.length > 2 ? 's' : ''} (~${mins(l.rideSecs)} min), ${p.legs[i + 2] && p.legs[i + 2].type === 'metro' || (p.legs[i + 1] && p.legs[i + 1].type === 'metro') ? 'change at' : 'get off at'} <b>${esc(l.alight.name)}</b></div>
          <div class="step-s">Trains typically every few minutes. No live metro times.</div></div></div>`);
      }
    });
    steps.push(`<div class="step end"><div class="step-rail"><div class="step-ic">${ico('pin')}</div></div><div class="step-body"><div class="step-t">${esc(R ? R.dest.name : 'Destination')}</div><div class="step-s">Arrive around ${clock(arrive)}</div></div></div>`);
    sheet.open(`${head(`${fmtMin(p.secs)} min`, `Arrive ~${clock(arrive)} · ${p.rides} ride${p.rides > 1 ? 's' : ''} · walk ${fmtDist(p.walkM)}`, `<button class="sh-ic" data-act="plan-back" aria-label="Back">${ico('back')}</button>`)}
      <div class="opt-legs" style="margin:0 0 14px">${legChips(p)}</div><div class="steps">${steps.join('')}</div>
      <div class="note">Bus times are live where the feed has them. Metro legs use typical scheduled frequency, not live data.</div>`, 'half', destOnClose);
    fitTo(p.legs.flatMap((l) => (l.type === 'walk' ? [l.from, l.to] : l.stops)), 15.5);
    // live next bus for each bus leg
    for (const [i, l] of p.legs.entries()) {
      if (l.type !== 'bus') continue;
      const arr = (await arrivalsForStops([l.board.id]))[l.board.id] || [];
      const el = ui.sheetBody.querySelector(`[data-live="${i}"]`);
      if (!el) continue;
      const pred = arr.find((a) => a.route_id === l.route_id && a.in_sec > 0);
      const est = !pred && (S.byRoute.get(l.route_id) || []).length;
      el.innerHTML = pred ? `<span class="tag live">Live</span><span class="step-s" style="margin:0">Next ${esc(l.label)} in <b>${fmtMin(pred.in_sec)} min</b></span>`
        : est ? `<span class="tag est">Live</span><span class="step-s" style="margin:0">${est} bus${est > 1 ? 'es' : ''} on this route now${l.headwayMin ? `, about every ${l.headwayMin} min` : ''}</span>`
          : `<span class="tag est">No live bus</span><span class="step-s" style="margin:0">${l.headwayMin ? `Usually about every ${l.headwayMin} min` : 'None reporting right now'}</span>`;
    }
  }

  /* =============================== 8. route focus =============================== */
  // a route number is often two route ids, one per direction ("534" up and down): treat them as one route
  function ridsForLabel(label) {
    const L = String(label || '').toUpperCase();
    const out = new Set();
    if (D.patterns) for (const [rid, p] of Object.entries(D.patterns)) if ((p.sn || '').toUpperCase() === L) out.add(rid);
    for (const [rid, l] of S.labels) if ((l || '').toUpperCase() === L) out.add(rid);
    return [...out];
  }
  async function showRoute(rid) {
    S.mode = 'route'; select(null); stopFollow(true); setDestMarker(null);
    sheet.open(`${head(badge(routeLabel(rid), 'lg'), 'Loading route…')}${skeleton(2)}`, 'half', (replaced) => { if (!replaced && S.mode === 'route') clearModes(); });
    await Promise.all([loadPatterns(), loadNet()]).catch(() => {});
    const label = routeLabel(rid);
    const rids = ridsForLabel(label);
    if (!rids.includes(rid)) rids.push(rid);
    S.routeLabel = label;
    const geoms = rids.flatMap((r) => patternGeom(r) || []);
    focusFilter = (b) => rids.includes(b.route_id);
    recomputeFocus();
    setFocus([...S.focus], `Route ${label}`, rids);
    setTrip(geoms.map((g, i) => lineFeat(g.pts.map((p) => [p.lon, p.lat]), { kind: 'bus', dim: i ? 1 : 0 })),
      geoms.flatMap((g) => [ptFeat(g.pts[0], '#ff6a1f', g.from), ptFeat(g.pts[g.pts.length - 1], '#ff6a1f', g.to)]));
    renderRoute(label);
    const live = rids.flatMap((r) => S.byRoute.get(r) || []);
    fitTo((geoms.length ? geoms[0].pts : []).concat(live), 14.5);
  }
  function renderRoute(label) {
    const rids = ridsForLabel(label);
    const geoms = rids.flatMap((r) => patternGeom(r) || []);
    const live = rids.flatMap((r) => S.byRoute.get(r) || []);
    const dirs = geoms.map((g) => ({ g, buses: [] }));
    for (const b of live) { const m = busDirection(b); const d = m && dirs.find((x) => x.g === m.geom); if (d) d.buses.push({ b, m }); }
    const ends = geoms.length ? `${esc(geoms[0].from)} ↔ ${esc(geoms[0].to)}` : 'Live buses on this route';
    let html = head(`Route ${esc(label)}`, ends, badge(label, 'lg'));
    const hws = rids.map(headwayMin).filter(Boolean);
    const hw = hws.length ? Math.min(...hws) : null;
    html += `<div class="facts"><div class="fact"><div class="k">Live now</div><div class="v">${live.length}</div></div><div class="fact"><div class="k">Stops</div><div class="v">${geoms[0] ? geoms[0].pts.length : '—'}</div></div><div class="fact"><div class="k">Frequency</div><div class="v">${hw ? `~${hw} min` : '—'}</div></div></div>`;
    for (const d of dirs) {
      html += `<div class="sec">Towards ${esc(d.g.to)}<span class="fill"></span>${d.buses.length} live</div>`;
      if (!d.buses.length) html += `<div class="note" style="margin:0 0 8px">No bus reporting in this direction right now.</div>`;
      else html += `<div class="card">${d.buses.sort((x, y) => y.m.proj.along - x.m.proj.along).slice(0, 8).map(({ b, m }) => {
        const nxt = d.g.pts.find((p, i) => d.g.cum[i] > m.proj.along + 30);
        return `<div class="arr tap" data-act="bus" data-id="${esc(b.id)}" style="cursor:pointer">${ico('bus')}<div class="to"><div class="a">${nxt ? `Next: ${esc(nxt.name)}` : 'Arriving at terminal'}</div><div class="b">${Math.round((m.proj.along / (d.g.total || 1)) * 100)}% along · bus ${esc(b.id)}</div></div>${ico('chev')}</div>`;
      }).join('')}${d.buses.length > 8 ? `<div class="arr"><div class="to"><div class="b">+ ${d.buses.length - 8} more on the map</div></div></div>` : ''}</div>`;
    }
    if (!geoms.length) html += `<div class="note">No stop data for this route. Showing live positions only.</div>`;
    sheet.update(`<div class="sheet-fade">${html}</div>`);
  }

  /* =============================== 9. bus / stop / near-me sheets =============================== */
  function select(id) {
    S.selectedId = id;
    if (!id && map.getSource('sel')) map.getSource('sel').setData(EMPTY);
    lastPush = 0; kick();
  }
  let busPredCache = { id: null, at: 0, map: null };
  async function openBus(bus) {
    await loadPatterns().catch(() => {});
    const prevMode = S.mode;
    S.mode = 'bus';
    select(bus.id);
    if (S.followId && S.followId !== bus.id) stopFollow(true);
    sheet.open(`${head(`${badge(routeLabel(bus.route_id) || bus.route || '—', 'lg')}`, 'Loading…')}<div class="skel line" style="width:70%"></div><div class="skel line"></div><div class="skel line" style="width:50%"></div>`, 'half', (replaced) => {
      if (S.mode === 'bus') {
        select(null); stopFollow(true);
        if (!replaced) {
          S.mode = null;
          if (S.results && (prevMode === 'dest' || prevMode === 'trip')) { S.mode = 'dest'; renderDest(); sheet.onClose = destOnClose; sheet.set('half'); }
          else if (prevMode === 'route' && S.routeLabel) { S.mode = 'route'; renderRoute(S.routeLabel); sheet.onClose = (r) => { if (!r && S.mode === 'route') clearModes(); }; sheet.set('half'); }
        }
      }
    });
    const p = pos(bus.id, performance.now());
    if (p && !S.followId) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14), duration: 500, padding: sheetPadding() });
    await renderBusSheet(bus, true);
  }
  async function refreshBusSheet() { const b = S.buses.get(S.selectedId); if (b && S.mode === 'bus') renderBusSheet(b, false); }
  async function renderBusSheet(bus, fresh) {
    if (busPredCache.id !== bus.id || Date.now() - busPredCache.at > 12000) {
      busPredCache = { id: bus.id, at: Date.now(), map: null };
      try {
        const d = await getJson(`/api/arrivals?vehicle_id=${encodeURIComponent(bus.id)}`);
        if (d.updates && d.updates.length) { busPredCache.map = {}; for (const u of d.updates) busPredCache.map[u.stop_id] = u.t; }
      } catch { /* optional */ }
    }
    if (S.selectedId !== bus.id) return;
    const pred = busPredCache.map;
    const label = routeLabel(bus.route_id) || bus.route || '—';
    const m = bus.route_id ? busDirection(bus) : null;
    const ago = bus.ts ? Math.max(0, Math.round(Date.now() / 1000 - bus.ts)) : null;
    const kmh = bus.speed != null ? Math.round(bus.speed * 3.6) : null;
    const now = Date.now() / 1000;
    let title = `Route ${esc(label)}`, sub = `Bus ${esc(bus.id)}`, body = '';
    if (m) {
      const g = m.geom;
      title = `To ${esc(g.to)}`;
      sub = `From ${esc(g.from)} · Bus ${esc(bus.id)}`;
      const nextIdx = g.pts.findIndex((pt, i) => g.cum[i] > m.proj.along + 30);
      const pct = Math.round((m.proj.along / (g.total || 1)) * 100);
      body += `<div class="progress"><div class="progress-bar"><span style="width:${pct}%"></span></div><div class="progress-lbl"><span>${esc(g.from)}</span><span class="num">Stop ${Math.max(1, nextIdx)} of ${g.pts.length}</span></div></div>`;
      const rows = [];
      if (nextIdx >= 0) {
        const showAll = ui.sheetBody.dataset.all === bus.id;
        const end = showAll ? g.pts.length : Math.min(g.pts.length, nextIdx + 7);
        for (let i = nextIdx; i < end; i++) {
          const pt = g.pts[i], dist = g.cum[i] - m.proj.along;
          if (i > nextIdx && g.pts[i - 1].name === pt.name) continue; // paired kerbside stops share a name
          const t = pred && pred[pt.id];
          const tt = t ? `<span class="tl-t live">${t - now < 45 ? 'Now' : `${fmtMin(t - now)} min`}</span>` : `<span class="tl-t dim">${fmtMin((dist * BUS_DETOUR) / BUS_MS)} min</span>`;
          rows.push(`<div class="tl-row${i === nextIdx ? ' next' : ''}${i === g.pts.length - 1 ? ' end' : ''}"><div class="tl-dot"><i></i></div><div class="tl-name">${esc(pt.name)}</div>${tt}</div>`);
        }
        body += `<div class="sec">Next stops <span class="fill"></span>${pred ? '<span class="tag live">Live times</span>' : '<span class="tag est">Estimated</span>'}</div><div class="tl">${rows.join('')}</div>`;
        if (!showAll && end < g.pts.length) body += `<button class="more" data-act="all-stops" data-id="${esc(bus.id)}">Show all ${g.pts.length - nextIdx} remaining stops</button>`;
      } else body += `<div class="note">Arriving at ${esc(g.to)}.</div>`;
    } else if (bus.route_id) body += `<div class="note">No stop data for this route, so only the live position is shown.</div>`;
    const following = S.followId === bus.id;
    const html = `${head(title, sub, badge(label, 'lg'))}
      <div class="facts">
        <div class="fact"><div class="k">Speed</div><div class="v">${kmh != null ? `${kmh} km/h` : '—'}</div></div>
        <div class="fact"><div class="k">Updated</div><div class="v">${ago != null ? (ago < 90 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`) : '—'}</div></div>
        <div class="fact"><div class="k">Status</div><div class="v" style="color:${ago != null && ago > STALE_S ? 'var(--warn)' : 'var(--live)'}">${ago != null && ago > STALE_S ? 'Delayed' : 'Live'}</div></div>
      </div>
      <div class="actions">
        <button class="btn ${following ? 'on' : 'primary'}" data-act="follow" data-id="${esc(bus.id)}">${ico('follow')}<span>${following ? 'Following' : 'Follow'}</span></button>
        <button class="btn" data-act="route" data-rid="${esc(bus.route_id || '')}">${ico('route')}Route</button>
        <button class="btn icon" data-act="share" data-id="${esc(bus.id)}" aria-label="Share link">${ico('share')}</button>
      </div>${body}`;
    const top = ui.sheetBody.scrollTop;
    sheet.update(fresh ? `<div class="sheet-fade">${html}</div>` : html);
    ui.sheetBody.scrollTop = top;
  }

  function destNameFor(rid, stopId) {
    const g = (patternGeom(rid) || []).find((x) => x.pos.has(stopId));
    return g ? g.to : '';
  }
  async function stopArrivals(stopId, limit) {
    const arr = ((await arrivalsForStops([stopId]))[stopId] || []).filter((a) => a.in_sec > -30);
    const seen = new Set(), out = [];
    for (const a of arr) {
      if (seen.has(a.route_id)) continue; seen.add(a.route_id);
      out.push({ rid: a.route_id, label: routeLabel(a.route_id) || a.route, s: a.in_sec, live: true, vehicle: a.vehicle_id, to: destNameFor(a.route_id, stopId) });
    }
    // add position-based estimates for routes with no prediction
    for (const rid of (D.stopRoutes && D.stopRoutes[stopId]) || []) {
      if (seen.has(rid)) continue;
      for (const g of patternGeom(rid) || []) {
        const idx = g.pos.get(stopId); if (!idx) continue;
        const at = g.cum[idx[0]];
        let best = null;
        for (const b of S.byRoute.get(rid) || []) {
          const m = busDirection(b); if (!m || m.geom !== g) continue;
          const rem = at - m.proj.along;
          if (rem > 20 && (!best || rem < best.rem)) best = { rem, b };
        }
        if (best) { out.push({ rid, label: routeLabel(rid), s: (best.rem * BUS_DETOUR) / BUS_MS, live: false, vehicle: best.b.id, to: g.to }); seen.add(rid); break; }
      }
    }
    return out.sort((a, b) => a.s - b.s).slice(0, limit || 6);
  }
  const arrRow = (a) => `<div class="arr tap" data-act="bus" data-id="${esc(a.vehicle || '')}" style="cursor:pointer">${badge(a.label)}<div class="to"><div class="a">${a.to ? `To ${esc(a.to)}` : 'Live bus'}</div><div class="b">${a.live ? 'Live prediction' : 'Estimated from position'}</div></div><div class="eta">${etaHtml(a.s, a.live ? 'live' : '')}</div></div>`;

  async function openStop(stopId, name) {
    await loadPatterns().catch(() => {});
    S.mode = 'stop'; select(null);
    const routes = (D.stopRoutes && D.stopRoutes[stopId]) || [];
    const lead = `<div class="sh-ic">${ico('stop')}</div>`;
    sheet.open(`${head(esc(name || 'Bus stop'), `Bus stop · ${routes.length} route${routes.length === 1 ? '' : 's'}`, lead)}${skeleton(2)}`, 'half', (replaced) => { if (!replaced && S.mode === 'stop') S.mode = null; });
    const s = D.stops.get(stopId);
    const arr = await stopArrivals(stopId, 8);
    if (S.mode !== 'stop') return;
    const labels = [...new Set(routes.map(routeLabel))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    sheet.update(`<div class="sheet-fade">${head(esc(name || 'Bus stop'), `Bus stop · ${routes.length} route${routes.length === 1 ? '' : 's'}`, lead)}
      <div class="actions"><button class="btn primary" data-act="go-here" data-lat="${s ? s.lat : ''}" data-lon="${s ? s.lon : ''}" data-name="${esc(name)}">${ico('route')}Directions here</button></div>
      <div class="sec">Next buses</div>
      ${arr.length ? `<div class="card">${arr.map(arrRow).join('')}</div>` : empty('clock', 'No buses heading here right now', 'No live bus on these routes is approaching. Try again in a few minutes.')}
      ${labels.length ? `<div class="sec">Routes at this stop</div><div class="opt-legs" style="margin:0">${labels.slice(0, 40).map((l) => badge(l, 'sm')).join('')}</div>` : ''}
      <div class="note">Live = prediction from the trip-updates feed. Estimated = from the bus's live position and typical speed.</div></div>`);
  }

  async function openNearMe() {
    S.mode = 'near'; select(null);
    sheet.open(`${head('Near you', 'Finding stops…', `<div class="sh-ic">${ico('stop')}</div>`)}${skeleton(3)}`, 'half', (replaced) => { if (!replaced && S.mode === 'near') S.mode = null; });
    let loc = S.userLoc;
    if (!loc) {
      try { loc = await locate(); } catch (e) {
        sheet.update(`${head('Near you', esc(e.message), `<div class="sh-ic">${ico('stop')}</div>`)}${empty('locate', 'Location needed', 'Allow location access to see the next buses at stops around you.', `<button class="btn primary" data-act="near-retry">${ico('locate')}Try again</button>`)}`);
        return;
      }
    }
    map.easeTo({ center: [loc.lon, loc.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 800, padding: sheetPadding() });
    await loadPatterns().catch(() => {});
    if (S.mode !== 'near') return;
    const near = [];
    for (const n of stopsNear(loc.lat, loc.lon, 700)) {
      if (near.length >= 5) break;
      if (near.some((k) => k.s.name === n.s.name && hav(k.s.lat, k.s.lon, n.s.lat, n.s.lon) < 150)) continue;
      near.push(n);
    }
    await arrivalsForStops(near.map((n) => n.s.id));
    const blocks = await Promise.all(near.map(async (n) => ({ n, arr: await stopArrivals(n.s.id, 3) })));
    if (S.mode !== 'near') return;
    sheet.update(`<div class="sheet-fade">${head('Near you', `${near.length} stops within ${fmtDist(near.length ? near[near.length - 1].d : 700)}`, `<div class="sh-ic">${ico('stop')}</div>`)}
      ${near.length ? blocks.map(({ n, arr }) => `<div class="card">
        <div class="card-h tap" data-act="stop" data-id="${esc(n.s.id)}" data-name="${esc(n.s.name)}" style="cursor:pointer"><span class="ttl">${esc(n.s.name)}</span><span class="meta">${ico('walk', '')}</span><span class="meta">${mins(walkSecs(n.d))} min · ${fmtDist(n.d * WALK_DETOUR)}</span></div>
        ${arr.length ? arr.map(arrRow).join('') : `<div class="arr"><div class="to"><div class="b">No bus heading here right now</div></div></div>`}
      </div>`).join('') : empty('stop', 'No bus stops nearby', 'There are no stops within 700 m. Try searching for a place instead.')}
      <div class="note">Live = trip-update prediction. Estimated = from live bus position. Delhi buses bunch in traffic, so treat times as rough.</div></div>`);
  }
  ui.chipNear.addEventListener('click', () => { clearModes(); openNearMe(); });

  // sheet actions
  ui.sheetBody.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') return sheet.close();
    if (act === 'follow') {
      if (S.followId === t.dataset.id) stopFollow(false);
      else { startFollow(t.dataset.id); t.classList.remove('primary'); t.classList.add('on'); t.lastChild.textContent = 'Following'; }
      return;
    }
    if (act === 'follow-bus') { const b = S.buses.get(t.dataset.id); if (b) { S.followId = b.id; openBus(b).then(() => startFollow(b.id)); } else toast('That bus is not reporting right now'); return; }
    if (act === 'route') { if (t.dataset.rid) { ui.q.value = `Route ${routeLabel(t.dataset.rid)}`; setSearchMode(true); ui.qClear.classList.remove('hidden'); showRoute(t.dataset.rid); } return; }
    if (act === 'share') {
      const url = `${location.origin}${location.pathname}#bus=${encodeURIComponent(t.dataset.id)}`;
      if (navigator.share) navigator.share({ title: 'Live bus', url }).catch(() => {});
      else navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast(url));
      return;
    }
    if (act === 'all-stops') { ui.sheetBody.dataset.all = t.dataset.id; refreshBusSheet(); sheet.set('full'); return; }
    if (act === 'bus') { const b = S.buses.get(t.dataset.id); if (b) openBus(b); else toast('That bus is not reporting right now'); return; }
    if (act === 'stop') return openStop(t.dataset.id, t.dataset.name);
    if (act === 'opt') { const i = +t.dataset.i; if (S.results && S.results.selected === i && !e.target.closest('.actions')) return; return selectOption(i); }
    if (act === 'opt-back') { e.stopPropagation(); S.results.selected = null; focusFilter = (b) => S.results.opts.some((o) => o.rid === b.route_id && liveForOption(o).some((x) => x.bus.id === b.id)); recomputeFocus(); setFocus([...S.focus], `To ${S.results.dest.name}`, S.results.opts.map((o) => o.rid)); drawDestOverview(); renderDest(true); return; }
    if (act === 'plan') { const p = S.results.transfers[+t.dataset.i]; if (p) showPlan(p); return; }
    if (act === 'plan-back') { S.mode = 'dest'; const R = S.results; sheet.open('', 'half', destOnClose); renderDest(); drawDestOverview(); focusFilter = (b) => R.opts.some((o) => o.rid === b.route_id && liveForOption(o).some((x) => x.bus.id === b.id)); recomputeFocus(); setFocus([...S.focus], `To ${R.dest.name}`, R.opts.map((o) => o.rid)); return; }
    if (act === 'go-here') { const d = { name: t.dataset.name, lat: +t.dataset.lat, lon: +t.dataset.lon }; ui.q.value = d.name; setSearchMode(true); ui.qClear.classList.remove('hidden'); return goTo(d); }
    if (act === 'locate-retry' || act === 'retry-dest') return S.dest && goTo(S.dest);
    if (act === 'from-center') { const c = map.getCenter(); S.userLoc = { lat: c.lat, lon: c.lng, name: 'Map centre' }; setMe(S.userLoc); return S.dest && goTo(S.dest); }
    if (act === 'near-retry') return openNearMe();
  });

  /* map taps: bus first (generous box), then stop, then metro station */
  map.on('click', (e) => {
    hideSuggest();
    const p = e.point, r = 14;
    const box = [[p.x - r, p.y - r], [p.x + r, p.y + r]];
    const hits = map.queryRenderedFeatures(box, { layers: ['bus-hit'] });
    if (hits.length) {
      let best = null, bd = Infinity;
      for (const h of hits) { const pt = map.project(h.geometry.coordinates); const d = (pt.x - p.x) ** 2 + (pt.y - p.y) ** 2; if (d < bd) { bd = d; best = h; } }
      const bus = S.buses.get(best.properties.id);
      if (bus) return openBus(bus);
    }
    const st = map.queryRenderedFeatures(box, { layers: ['stops'] });
    if (st.length) return openStop(String(st[0].properties.id), st[0].properties.name);
    const ms = map.queryRenderedFeatures(box, { layers: ['metro-stations'] });
    if (ms.length) { const f = ms[0]; const [lon, lat] = f.geometry.coordinates; ui.q.value = f.properties.name; setSearchMode(true); ui.qClear.classList.remove('hidden'); return goTo({ name: f.properties.name, lat, lon, kind: 'M' }); }
  });
  map.on('mousemove', (e) => {
    const p = e.point;
    const n = map.queryRenderedFeatures([[p.x - 8, p.y - 8], [p.x + 8, p.y + 8]], { layers: ['bus-hit', 'stops', 'metro-stations'] }).length;
    map.getCanvas().style.cursor = n ? 'pointer' : '';
  });

  /* =============================== 10. 3D buses =============================== */
  // Model: "Low-poly City - Bus" by Innerscene, CC0. Front is -X (headlights), up is +Y, door side +Z (left, as in India).
  const bus3d = { ready: false, max: 1200, groups: [], matAttr: null, alpha: 0 };
  const PARTS = [
    [/passenger[ _]volume/i, { color: 0xff6a1f }],
    [/lower[ _]body/i, { color: 0xc94b12 }],
    [/window|glass/i, { color: 0x1c2733, emissive: 0x0d1724 }],
    [/bumper|door/i, { color: 0x2a2f36 }],
    [/headlight/i, { color: 0xfff3d1, emissive: 0xfff0c0 }],
    [/rear[ _]lamp/i, { color: 0xff3b30, emissive: 0xc81e14 }],
    [/tyre/i, { color: 0x15171a }],
    [/hub/i, { color: 0x9aa3ad }],
  ];
  function busLenMeters(z) {
    const mpp = (78271.5 * Math.cos(toRad(28.6))) / 2 ** z;
    const px = Math.max(22, Math.min(44, 22 + (z - Z3D) * 5.5));
    return Math.max(12, px * mpp);  // a readable icon when zoomed out, true 12 m bus when close
  }
  const bus3dLayer = {
    id: 'buses-3d', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      this.camera = new THREE.Camera();
      this.scene = new THREE.Scene();
      const hemi = new THREE.HemisphereLight(0xffffff, 0x8a909c, 0.78); hemi.position.set(0, 0, 1); this.scene.add(hemi);
      const sun = new THREE.DirectionalLight(0xfff6ea, 0.42); sun.position.set(-0.6, 0.5, 0.9); this.scene.add(sun);
      this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
      new THREE.GLTFLoader().load('/bus.glb', (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const buckets = PARTS.map(() => []);
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const i = PARTS.findIndex(([re]) => re.test(o.name));
          if (i >= 0) buckets[i].push(o);
        });
        // one shared instance-matrix buffer for every part: 8 draw calls for all buses
        bus3d.matAttr = new THREE.InstancedBufferAttribute(new Float32Array(bus3d.max * 16), 16);
        bus3d.matAttr.setUsage(THREE.DynamicDrawUsage);
        buckets.forEach((meshes, i) => {
          if (!meshes.length) return;
          const pos = [], nor = [];
          for (const mesh of meshes) {
            const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
            g.applyMatrix4(mesh.matrixWorld);
            pos.push(g.attributes.position.array); nor.push(g.attributes.normal.array);
          }
          const cat = (arrs) => { const n = arrs.reduce((a, x) => a + x.length, 0), out = new Float32Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(cat(pos), 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(cat(nor), 3));
          const mat = new THREE.MeshLambertMaterial({ color: PARTS[i][1].color, emissive: PARTS[i][1].emissive || 0x000000, side: THREE.DoubleSide, transparent: false });
          const im = new THREE.InstancedMesh(geo, mat, bus3d.max);
          im.instanceMatrix = bus3d.matAttr;
          im.count = 0; im.frustumCulled = false;
          this.scene.add(im);
          bus3d.groups.push(im);
        });
        bus3d.ready = true;
        // hand the high zooms over to the models
        map.setPaintProperty('bus-marker', 'icon-opacity', ['interpolate', ['linear'], ['zoom'], 12.2, 0, 12.6, 1, Z3D - 0.25, 1, Z3D + 0.25, 0]);
        map.triggerRepaint();
      }, undefined, () => { /* model failed: 2D markers stay at every zoom */ });
    },
    render(gl, matrix) {
      if (!bus3d.ready) return;
      const z = map.getZoom();
      const a = Math.max(0, Math.min(1, (z - (Z3D - 0.25)) / 0.5));
      if (a <= 0) return;
      const now = performance.now();
      const c = map.getCenter();
      const o = mapboxgl.MercatorCoordinate.fromLngLat(c, 0);
      const unit = o.meterInMercatorCoordinateUnits();
      const k = (busLenMeters(z) / 7.9) * unit * (0.85 + 0.15 * a);
      const arr = bus3d.matAttr.array;
      let n = 0;
      for (const id of viewIds) {
        if (n >= bus3d.max) break;
        const p = pos(id, now); if (!p) continue;
        const mc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: p.lon, lat: p.lat }, 0);
        const h = toRad(p.b), s = Math.sin(h), cs = Math.cos(h), off = n * 16;
        // columns: model X -> backwards, model Y -> up, model Z -> left of heading (mercator y points south)
        arr[off] = -s * k; arr[off + 1] = cs * k; arr[off + 2] = 0; arr[off + 3] = 0;
        arr[off + 4] = 0; arr[off + 5] = 0; arr[off + 6] = k; arr[off + 7] = 0;
        arr[off + 8] = -cs * k; arr[off + 9] = -s * k; arr[off + 10] = 0; arr[off + 11] = 0;
        arr[off + 12] = mc.x - o.x; arr[off + 13] = mc.y - o.y; arr[off + 14] = 0; arr[off + 15] = 1;
        n++;
      }
      bus3d.matAttr.needsUpdate = true;
      const fading = a < 1;
      for (const im of bus3d.groups) {
        im.count = n;
        if (im.material.transparent !== fading) { im.material.transparent = fading; im.material.needsUpdate = true; }
        im.material.opacity = a;
      }
      // render relative to the map centre: keeps float32 precision (no vertex wobble)
      this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, 0));
      if (this.renderer.resetState) this.renderer.resetState(); else this.renderer.state.reset();
      this.renderer.render(this.scene, this.camera);
    },
  };
  window.__bus3d = bus3d;

  function set3D(on, jump) {
    S.is3D = on;
    ui.btn3d.classList.toggle('on', on); ui.btn3d.setAttribute('aria-pressed', on);
    if (on) {
      if (!map.getLayer('3d-buildings')) addBuildings();
      const opts = { pitch: 60, zoom: Math.max(map.getZoom(), 15.2) };
      jump ? map.jumpTo(opts) : map.easeTo({ ...opts, duration: 900 });
    } else map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
  ui.btn3d.addEventListener('click', () => set3D(!S.is3D));
  function addBuildings() {
    map.addLayer({
      id: '3d-buildings', source: 'composite', 'source-layer': 'building', filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 14,
      paint: { 'fill-extrusion-color': '#1b222c', 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.4, ['get', 'height']], 'fill-extrusion-base': ['get', 'min_height'], 'fill-extrusion-opacity': 0.82 },
    }, 'trip-casing');
  }

  /* =============================== 11. boot + deep links =============================== */
  // start the first vehicle fetch while the map style is still loading
  const firstData = refresh();
  // don't hold the boot screen for slow tiles: once data and the style are in, show the app
  firstData.then(() => { const done = () => ui.boot.classList.add('gone'); if (map.isStyleLoaded()) done(); else map.once('style.load', done); });
  map.on('load', async () => {
    addLayers();
    loadStops().then(() => map.getSource('stops').setData({ type: 'FeatureCollection', features: D.stopList.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, name: s.name } })) })).catch(() => {});
    loadMetro().then(() => {
      const feats = D.metro.lines.map((l) => lineFeat(l.coords, { color: l.color, name: l.name }));
      const seen = new Set();
      for (const l of D.metro.lines) for (const [s] of l.stops) { if (seen.has(s)) continue; seen.add(s); const [name, lat, lon] = D.metro.stations[s]; feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name, color: l.color } }); }
      map.getSource('metro').setData({ type: 'FeatureCollection', features: feats });
    }).catch(() => {});
    refreshView(true);
    ui.boot.classList.add('gone'); // the map is up; buses stream in as soon as the first fetch lands
    await firstData;
    // warm the planner and search data in the background so the first search is instant
    idle(() => { loadPlaces().catch(() => {}); loadNet().catch(() => {}); });
    await handleHash();
  });
  map.on('error', (e) => { if (e && e.error && /token|401|403/i.test(String(e.error.message || e.error.status))) { ui.fatal.textContent = 'The map could not load (Mapbox token rejected).'; ui.fatal.classList.remove('hidden'); } });
  setTimeout(() => { if (!ui.boot.classList.contains('gone')) ui.bootSub.textContent = 'Still connecting to the live feed…'; }, 6000);

  /* #bus=<id> · #near=<lat>/<lon> · #3d · #from=<lat>/<lon>&to=<place> · #route=<no> */
  async function handleHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return;
    const kv = {};
    for (const part of h.split(/[&,]/)) { const [k, ...v] = part.split('='); kv[k] = v.join('='); }
    if ('3d' in kv) { map.jumpTo({ center: [77.2185, 28.6315] }); set3D(true, true); }
    const ll = (s) => { const [a, b] = (s || '').split('/').map(Number); return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lon: b } : null; };
    if (kv.from) { const l = ll(kv.from); if (l) setMe({ ...l, name: 'Your location' }); }
    if (kv.near) { const l = ll(kv.near); if (l) { setMe({ ...l, name: 'Your location' }); openNearMe(); } }
    if (kv.bus) { const b = S.buses.get(kv.bus); if (b) { map.jumpTo({ center: [b.lon, b.lat], zoom: 15 }); openBus(b); } else toast('That bus is not reporting right now'); }
    if (kv.route) { await loadPatterns(); const rid = Object.keys(D.patterns).find((r) => (D.patterns[r].sn || '').toUpperCase() === kv.route.toUpperCase()); if (rid) { ui.q.value = `Route ${kv.route}`; setSearchMode(true); showRoute(rid); } }
    if (kv.to) {
      await loadPlaces();
      const it = Planner.search(D.index, kv.to, 1)[0];
      if (it) pick({ type: 'place', ...it });
      else toast(`No place called “${kv.to}”`);
    }
  }
  window.addEventListener('hashchange', handleHash);
})();
