/* Delhi Bus Tracker v2 */
(async () => {
  const cfg = await (await fetch('/api/config')).json();
  const loadingEl = document.getElementById('map-loading');
  const statusEl = document.getElementById('status');
  const statusDot = document.getElementById('status-dot');
  const demoBadge = document.getElementById('demo-badge');

  if (!cfg.mapboxToken) {
    document.getElementById('token-warning').classList.remove('hidden');
    return;
  }
  mapboxgl.accessToken = cfg.mapboxToken;

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [77.2090, 28.6139],
    zoom: 11,
    attributionControl: false,
  });
  window.map = map;
  map.addControl(new mapboxgl.AttributionControl({ compact: true, customAttribution: '3D bus model: <a href="https://www.innerscene.com/tools/library/3d-parts/low-poly-city-bus-49c04273" target="_blank">Low-poly City Bus</a> by Innerscene (CC0)' }), 'bottom-right');

  /* ---------------- state ---------------- */
  let buses = [];                 // latest bus array from api
  let routesList = null;          // route_id -> repo route record (fallback names)
  let stopsById = null;           // stop_id -> {name, lat, lon} (reclaim mirror ids)
  let routePatterns = null;       // route_id -> {sn, d:[{from,to,stops:[[id,name,lat,lon]..]}]}
  let stopRoutes = null;          // stop_id -> [route_id]
  let patternCache = new Map();   // route_id -> computed geometry per direction
  let followedId = null;
  let is3D = false;
  let meMarker = null;
  let userLoc = null;             // {lat, lon}
  let routeFilter = '';
  let busDataVersion = 0;        // bumped on every refresh so the 3D layer re-uploads instances

  /* ---------------- helpers ---------------- */
  const toRad = (d) => (d * Math.PI) / 180;
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function fmtDist(m) {
    if (m == null) return '';
    return m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  }
  function fmtEta(sec) {
    if (sec == null) return '';
    const min = Math.round(sec / 60);
    if (min < 1) return '<1 min';
    if (min < 60) return `~${min} min`;
    return `~${Math.floor(min / 60)}h${min % 60 ? ' ' + (min % 60) + 'm' : ''}`;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- lazy data ---------------- */
  async function loadRoutes() {
    if (routesList) return;
    try {
      const d = await (await fetch('/api/routes')).json();
      routesList = {};
      for (const r of d.routes || []) routesList[r.id] = r;
    } catch { routesList = {}; }
  }
  async function loadStops() {
    if (stopsById) return;
    const list = await (await fetch('/data/stops.json')).json();
    stopsById = {};
    for (const s of list) stopsById[s.id] = s;
  }
  async function loadPatterns() {
    if (routePatterns) return;
    const [rp, sr] = await Promise.all([
      fetch('/data/route_patterns.json').then((r) => r.json()),
      fetch('/data/stop_routes.json').then((r) => r.json()),
    ]);
    routePatterns = rp; stopRoutes = sr;
    await loadStops();
  }

  /* Best display label for a route: reclaim short name > repo names > id */
  function routeLabel(routeId) {
    const p = routePatterns && routePatterns[routeId];
    if (p && p.sn) return p.sn;
    const r = routesList && routesList[routeId];
    return (r && (r.short_name || r.long_name)) || routeId || '';
  }
  function routeSubName(routeId) {
    const p = routePatterns && routePatterns[routeId];
    if (p && p.d && p.d[0]) {
      const ends = p.d.map((d) => `${d.from} – ${d.to}`);
      return ends.length > 1 ? ends.join('  ·  ') : ends[0];
    }
    const r = routesList && routesList[routeId];
    if (r && r.short_name && r.long_name && r.short_name !== r.long_name) return r.long_name;
    return '';
  }

  /* Precompute per-direction geometry: stop points + cumulative distance */
  function getPatternGeom(routeId) {
    if (patternCache.has(routeId)) return patternCache.get(routeId);
    const p = routePatterns && routePatterns[routeId];
    let geom = null;
    if (p) {
      geom = p.d.map((dir) => {
        const pts = dir.stops.map((x) => ({ id: x[0], name: x[1], lat: x[2], lon: x[3] }));
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
        return { pts, cum, from: dir.from, to: dir.to, total: cum[cum.length - 1] || 0 };
      }).filter((g) => g.pts.length >= 2);
    }
    patternCache.set(routeId, geom);
    return geom;
  }

  /* Project a point onto a direction polyline (stop-to-stop segments) */
  function projectOnGeom(lat, lon, geom) {
    let best = null;
    for (let i = 1; i < geom.pts.length; i++) {
      const a = geom.pts[i - 1], b = geom.pts[i];
      const kx = Math.cos(toRad((a.lat + b.lat) / 2)) * 111320, ky = 110540;
      const ax = a.lon * kx, ay = a.lat * ky, bx = b.lon * kx, by = b.lat * ky;
      const px = lon * kx, py = lat * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (!best || d < best.dist) {
        const segLen = geom.cum[i] - geom.cum[i - 1];
        best = { dist: d, along: geom.cum[i - 1] + t * segLen, seg: i };
      }
    }
    return best;
  }

  /* Best direction match for a bus: lowest off-route distance, bearing tiebreak */
  function busDirection(bus) {
    const geoms = getPatternGeom(bus.route_id);
    if (!geoms || !geoms.length) return null;
    let best = null;
    for (const g of geoms) {
      const proj = projectOnGeom(bus.lat, bus.lon, g);
      let score = proj.dist;
      if (bus.bearing && g.pts[proj.seg]) {
        const a = g.pts[proj.seg - 1], b = g.pts[proj.seg];
        const pathBrg = (Math.atan2(b.lon - a.lon, b.lat - a.lat) * 180) / Math.PI;
        const diff = Math.abs(((pathBrg - bus.bearing + 540) % 360) - 180);
        if (diff > 90) score += 120;
      }
      if (!best || score < best.score) best = { geom: g, proj, score };
    }
    if (!best || best.proj.dist > 400) return null;
    return best;
  }

  /* ---------------- search ---------------- */
  const filterInput = document.getElementById('route-filter');
  const resultsEl = document.getElementById('search-results');
  const clearBtn = document.getElementById('clear-search');

  filterInput.addEventListener('input', async () => {
    routeFilter = filterInput.value.trim().toUpperCase();
    clearBtn.classList.toggle('hidden', !routeFilter);
    applyFilter();
    if (!routeFilter) { resultsEl.classList.add('hidden'); return; }
    await Promise.all([loadRoutes(), loadPatterns()]);
    const seen = new Map(); // label -> {id, sub}
    for (const [rid, p] of Object.entries(routePatterns)) {
      const label = (p.sn || '').toUpperCase();
      const hay = `${label}|${(p.d[0] ? p.d[0].from + ' ' + p.d[0].to : '').toUpperCase()}|${rid}`;
      if (hay.includes(routeFilter) && !seen.has(label || rid)) {
        seen.set(label || rid, { id: rid, label: p.sn || rid, sub: p.d[0] ? `${p.d[0].from} – ${p.d[0].to}` : '' });
      }
      if (seen.size >= 14) break;
    }
    // also search repo routes for anything missing
    if (seen.size < 14) {
      for (const r of Object.values(routesList)) {
        const label = (r.short_name || r.long_name || '').toUpperCase();
        if (!label || seen.has(label)) continue;
        if (label.includes(routeFilter)) seen.set(label, { id: r.id, label: r.short_name || r.long_name, sub: '' });
        if (seen.size >= 14) break;
      }
    }
    if (!seen.size) {
      resultsEl.innerHTML = '<div class="empty"><div class="big">No routes match</div>Try a route number like 534 or a place name.</div>';
      resultsEl.classList.remove('hidden');
      return;
    }
    resultsEl.innerHTML = [...seen.values()].map((m) =>
      `<div class="sr-item" data-route="${esc(m.id)}"><span class="sr-badge">${esc(m.label)}</span><span class="sr-name">${esc(m.sub)}</span></div>`
    ).join('');
    resultsEl.classList.remove('hidden');
  });
  resultsEl.addEventListener('click', (e) => {
    const item = e.target.closest('.sr-item');
    if (!item) return;
    resultsEl.classList.add('hidden');
    zoomToRoute(item.dataset.route);
  });
  clearBtn.addEventListener('click', () => {
    filterInput.value = ''; routeFilter = '';
    clearBtn.classList.add('hidden');
    resultsEl.classList.add('hidden');
    applyFilter();
  });

  const chip = document.getElementById('filter-chip');
  const chipLabel = document.getElementById('filter-chip-label');
  chip.querySelector('button').addEventListener('click', () => {
    filterInput.value = ''; routeFilter = '';
    clearBtn.classList.add('hidden');
    chip.classList.remove('show');
    resultsEl.classList.add('hidden');
    applyFilter();
  });

  function applyFilter() {
    if (routeFilter) {
      chipLabel.textContent = 'Route ' + (routeLabel(routeFilter) || routeFilter);
      chip.classList.add('show');
    } else {
      chip.classList.remove('show');
    }
    if (!map.getLayer('buses')) return;
    const f = routeFilter
      ? ['in', routeFilter, ['upcase', ['concat', ['coalesce', ['get', 'route'], ''], '|', ['coalesce', ['get', 'route_name'], '']]]]
      : null;
    map.setFilter('buses', f);
    map.setFilter('bus-labels', f);
    map.setFilter('bus-arrows', f);
  }

  async function zoomToRoute(routeId) {
    const live = buses.filter((b) => b.route_id === routeId);
    if (live.length) {
      const lons = live.map((b) => b.lon), lats = live.map((b) => b.lat);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 13.5, duration: 900 });
      return;
    }
    await loadPatterns();
    const geoms = getPatternGeom(routeId);
    if (geoms && geoms.length) {
      const pts = geoms[0].pts;
      const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 13, duration: 900 });
    }
  }

  /* ---------------- 3D ---------------- */
  document.getElementById('btn-3d').addEventListener('click', () => {
    is3D = !is3D;
    document.getElementById('btn-3d').classList.toggle('on', is3D);
    if (is3D) {
      if (!map.getLayer('3d-buildings')) addBuildings();
      map.easeTo({ pitch: 62, duration: 800 });
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  });
  function addBuildings() {
    const layers = map.getStyle().layers;
    let labelLayerId;
    for (const l of layers) {
      if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelLayerId = l.id; break; }
    }
    map.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#1c2530',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.05, ['get', 'height']],
        'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': 0.85,
      },
    }, labelLayerId);
  }

  /* ---------------- bottom sheet ---------------- */
  const sheet = document.getElementById('sheet');
  const sheetContent = document.getElementById('sheet-content');
  function closeSheet() {
    sheet.classList.add('hidden');
    document.body.classList.remove('sheet-open');
    followedId = null;
    clearSelected();
  }
  // drag the handle down to close
  let dragY = null;
  sheet.addEventListener('touchstart', (e) => {
    if (sheetContent.scrollTop > 0) return;
    dragY = e.touches[0].clientY;
    sheet.classList.add('dragging');
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (dragY == null) return;
    const dy = e.touches[0].clientY - dragY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (dragY == null) return;
    const dy = (e.changedTouches[0].clientY - dragY);
    dragY = null;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    if (dy > 90) closeSheet();
  });
  function openSheet() {
    sheet.classList.remove('hidden');
    document.body.classList.add('sheet-open');
  }
  function sheetSkeleton(title) {
    sheetContent.innerHTML = `
      <div class="sheet-head">
        <div class="sheet-title"><div class="t1">${esc(title)}</div><div class="t2">loading…</div></div>
        <button class="sheet-close">&times;</button>
      </div>
      <div class="skel skel-row" style="width:60%"></div>
      <div class="skel skel-row" style="width:90%"></div>
      <div class="skel skel-row" style="width:75%"></div>`;
    openSheet();
  }

  // selected-bus highlight ring
  function setSelected(bus) {
    if (!map.getSource('selected')) return;
    map.getSource('selected').setData({
      type: 'FeatureCollection',
      features: bus ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [bus.lon, bus.lat] }, properties: {} }] : [],
    });
  }
  function clearSelected() { setSelected(null); }
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('.sheet-close')) { closeSheet(); return; }
    const act = e.target.closest('[data-action]');
    if (!act) return;
    if (act.dataset.action === 'follow') {
      followedId = followedId ? null : act.dataset.id;
      if (followedId) {
        const b = buses.find((x) => x.id === followedId);
        if (b) map.easeTo({ center: [b.lon, b.lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
      }
      const bus = buses.find((x) => x.id === act.dataset.id);
      if (bus) renderBusSheet(bus);
    }
    if (act.dataset.action === 'show-route') {
      zoomToRoute(act.dataset.route);
    }
  });

  async function renderBusSheet(bus) {
    if (sheet.classList.contains('hidden')) sheetSkeleton('Bus ' + bus.id);
    const label = routeLabel(bus.route_id) || bus.route || '—';
    const ago = bus.ts ? Math.max(0, Math.round(Date.now() / 1000 - bus.ts)) : null;
    const speedKmh = bus.speed ? (bus.speed * 3.6).toFixed(0) : null;
    let dirHtml = '', stopsHtml = '';
    const match = bus.route_id ? busDirection(bus) : null;

    // predicted times for this bus from trip updates
    let predByStop = null;
    try {
      const d = await (await fetch(`/api/arrivals?vehicle_id=${encodeURIComponent(bus.id)}`)).json();
      if (d.updates && d.updates.length) {
        predByStop = {};
        for (const u of d.updates) predByStop[u.stop_id] = u.t;
      }
    } catch { /* predictions optional */ }

    if (!match && bus.route_id) {
      dirHtml = '<div class="nm-note" style="margin:8px 0 0">Route path data missing for this route, showing live info only.</div>';
    }
    if (match) {
      const g = match.geom;
      dirHtml = `<div class="dir-line"><span class="dim">${esc(g.from)}</span><span class="arrow">&#10230;</span><span>${esc(g.to)}</span></div>`;
      const next = [];
      for (let i = 0; i < g.pts.length && next.length < 6; i++) {
        const along = g.cum[i];
        if (along > match.proj.along + 40) next.push({ id: g.pts[i].id, name: g.pts[i].name, dist: along - match.proj.along });
      }
      if (next.length) {
        const now = Math.floor(Date.now() / 1000);
        stopsHtml = `<div class="sec-label">Next stops</div>` + next.map((n, i) => {
          const pred = predByStop && predByStop[n.id] ? fmtEta(predByStop[n.id] - now) : null;
          return `<div class="stop-row"><span class="stop-dot${i === 0 ? ' next' : ''}"></span><span class="stop-name">${esc(n.name)}</span><span class="stop-dist">${pred ? esc(pred) : fmtDist(n.dist)}</span></div>`;
        }).join('') + (predByStop ? '<div class="nm-note">Times are live predictions from the feed.</div>' : '');
      }
    }
    sheetContent.innerHTML = `
      <div class="sheet-head">
        <span class="route-badge">${esc(label)}</span>
        <div class="sheet-title">
          <div class="t1">${esc(routeSubName(bus.route_id) || 'Route ' + label)}</div>
          <div class="t2">Bus ${esc(bus.id)}</div>
        </div>
        <button class="sheet-close">&times;</button>
      </div>
      ${dirHtml}
      <div class="fact-row">
        <div class="fact"><div class="k">Speed</div><div class="v">${speedKmh != null ? speedKmh + ' km/h' : '—'}</div></div>
        <div class="fact"><div class="k">Updated</div><div class="v">${ago != null ? ago + 's ago' : '—'}</div></div>
        <div class="fact"><div class="k">Progress</div><div class="v">${match ? Math.round((match.proj.along / (match.geom.total || 1)) * 100) + '%' : '—'}</div></div>
      </div>
      ${stopsHtml}
      <div class="sheet-actions">
        <button class="btn" data-action="follow" data-id="${esc(bus.id)}">${followedId === bus.id ? 'Following… tap to stop' : 'Follow this bus'}</button>
        <button class="btn ghost" data-action="show-route" data-route="${esc(bus.route_id || '')}">Whole route</button>
      </div>`;
    openSheet();
  }

  /* ---------------- stop sheet (tap a stop) ---------------- */
  async function renderStopSheet(stopId, stopName) {
    sheetSkeleton(stopName || 'Stop');
    await Promise.all([loadRoutes(), loadPatterns()]);
    const arrivals = await arrivalsAtStop(stopId);
    sheetContent.innerHTML = `
      <div class="sheet-head">
        <div class="sheet-title">
          <div class="t1">${esc(stopName || 'Stop')}</div>
          <div class="t2">Next buses at this stop</div>
        </div>
        <button class="sheet-close">&times;</button>
      </div>
      ${arrivals.length
        ? arrivals.map((a) => `<div class="nm-bus" style="padding:5px 0"><span class="nm-route">${esc(a.label)}</span><span class="nm-eta">${fmtEta(a.etaSec)} <span class="unit">${a.live ? '' : '· est'}</span></span></div>`).join('')
        : '<div class="empty"><div class="big">No buses heading here right now</div>Check again in a few minutes, or look at a stop on a bigger road.</div>'}
      <div class="nm-note">Times from live trip updates where available; "est" = computed from the bus's live position. Treat as rough.</div>`;
    openSheet();
  }

  /* ---------------- near me / next buses ---------------- */
  document.getElementById('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { statusEl.textContent = 'no geolocation on this device'; return; }
    statusEl.textContent = 'finding you…';
    const locBtn = document.getElementById('btn-locate');
    locBtn.classList.add('spinning');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (meMarker) meMarker.remove();
        const el = document.createElement('div');
        el.className = 'me-marker';
        meMarker = new mapboxgl.Marker({ element: el }).setLngLat([userLoc.lon, userLoc.lat]).addTo(map);
        locBtn.classList.remove('spinning');
        map.easeTo({ center: [userLoc.lon, userLoc.lat], zoom: Math.max(map.getZoom(), 14.5), duration: 900 });
        renderNearMe();
      },
      () => { locBtn.classList.remove('spinning'); statusEl.textContent = 'location unavailable'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  async function arrivalsAtStop(stopId) {
    // real predictions first
    try {
      const d = await (await fetch(`/api/arrivals?stop_id=${encodeURIComponent(stopId)}`)).json();
      if (d.arrivals && d.arrivals.length) {
        const seen = new Set();
        return d.arrivals.filter((a) => (seen.has(a.route_id) ? false : (seen.add(a.route_id), true)))
          .slice(0, 4)
          .map((a) => ({ label: routeLabel(a.route_id) || a.route || a.route_id, etaSec: a.in_sec, live: true, vehicle: a.vehicle_id }));
      }
    } catch { /* fall through to estimate */ }
    // fallback: estimate from live positions along route
    const serving = stopRoutes[stopId] || [];
    const stop = stopsById[stopId];
    if (!stop) return [];
    const est = [];
    for (const rid of serving) {
      const geoms = getPatternGeom(rid);
      if (!geoms || !geoms.length) continue;
      for (const g of geoms) {
        const idx = g.pts.findIndex((p) => String(p.id) === String(stopId));
        if (idx < 0) continue;
        const stopAlong = g.cum[idx];
        let bestBus = null;
        for (const b of buses) {
          if (b.route_id !== rid) continue;
          const proj = projectOnGeom(b.lat, b.lon, g);
          if (proj.dist > 400) continue;
          const remaining = stopAlong - proj.along;
          if (remaining < 20) continue;
          if (!bestBus || remaining < bestBus.remaining) bestBus = { bus: b, remaining };
        }
        if (bestBus) {
          const spd = bestBus.bus.speed && bestBus.bus.speed > 1.5 ? bestBus.bus.speed : 4.2;
          est.push({ label: routeLabel(rid) || rid, etaSec: bestBus.remaining / spd, live: false, vehicle: bestBus.bus.id });
        }
      }
    }
    est.sort((a, b) => a.etaSec - b.etaSec);
    const seen = new Set();
    return est.filter((a) => (seen.has(a.label) ? false : (seen.add(a.label), true))).slice(0, 4);
  }

  async function renderNearMe() {
    sheetSkeleton('Next buses near you');
    await Promise.all([loadRoutes(), loadPatterns()]);
    const all = Object.entries(stopsById).map(([id, s]) => ({ id, s, d: haversineM(userLoc.lat, userLoc.lon, s.lat, s.lon) }));
    all.sort((a, b) => a.d - b.d);
    // dedupe: skip stops whose name matches an already-kept stop within 150m (same terminal, many bays)
    const nearest = [];
    for (const n of all) {
      if (nearest.length >= 4) break;
      const dup = nearest.some((k) => k.s.name === n.s.name && haversineM(k.s.lat, k.s.lon, n.s.lat, n.s.lon) < 150);
      if (!dup) nearest.push(n);
    }

    const blocks = [];
    for (const n of nearest) {
      const arrivals = await arrivalsAtStop(n.id);
      blocks.push({ stop: n, arrivals });
    }

    sheetContent.innerHTML = `
      <div class="sheet-head">
        <div class="sheet-title">
          <div class="t1">Next buses near you</div>
          <div class="t2">Live predictions where the feed provides them</div>
        </div>
        <button class="sheet-close">&times;</button>
      </div>
      ${blocks.map((b) => `
        <div class="nm-stop">
          <div class="nm-stop-head"><span class="nm-stop-name">${esc(b.stop.s.name)}</span><span class="nm-stop-dist">${fmtDist(b.stop.d)} away</span></div>
          ${b.arrivals.length
            ? b.arrivals.map((a) => `<div class="nm-bus"><span class="nm-route">${esc(a.label)}</span><span class="nm-eta">${fmtEta(a.etaSec)} <span class="unit">${a.live ? '' : '· est'}</span></span></div>`).join('')
            : '<div class="nm-none">No buses heading here right now. Try a bigger road nearby.</div>'}
        </div>`).join('')}
      <div class="nm-note">Times marked "est" are computed from the bus's live position and speed. Treat all times as rough; Delhi buses bunch up in traffic.</div>`;
    openSheet();
    statusEl.textContent = `${buses.length} buses · near-you updated`;
  }

  /* ---------------- map init ---------------- */
  map.on('load', async () => {
    loadRoutes();

    // direction arrow image (dark-v11 sprite has no triangle icon)
    {
      const cv = document.createElement('canvas');
      cv.width = 24; cv.height = 24;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#a7f3d0';
      ctx.beginPath();
      ctx.moveTo(12, 1); ctx.lineTo(21, 21); ctx.lineTo(12, 15.5); ctx.lineTo(3, 21);
      ctx.closePath(); ctx.fill();
      map.addImage('dir-arrow', { width: 24, height: 24, data: ctx.getImageData(0, 0, 24, 24).data });
    }

    // Stops
    try {
      await loadStops();
      map.addSource('stops', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: Object.values(stopsById).map((s) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: { name: s.name, id: s.id },
          })),
        },
      });
      map.addLayer({
        id: 'stops', type: 'circle', source: 'stops', minzoom: 13,
        paint: { 'circle-radius': 3.5, 'circle-color': '#7d8aa0', 'circle-stroke-width': 1, 'circle-stroke-color': '#0f172a' },
      });
    } catch { /* stops optional */ }

    // selected bus highlight
    map.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'selected-ring', type: 'circle', source: 'selected',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 16],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#22e07a',
        'circle-opacity': 0,
      },
    });

    // Buses
    map.addSource('buses', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'buses', type: 'circle', source: 'buses',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7.5],
        'circle-color': '#22e07a',
        'circle-stroke-width': 1.6,
        'circle-stroke-color': '#04150c',
      },
    });
    map.addLayer({
      id: 'bus-arrows', type: 'symbol', source: 'buses', minzoom: 13.5,
      layout: {
        'icon-image': 'dir-arrow',
        'icon-rotate': ['get', 'bearing'],
        'icon-size': 0.85,
        'icon-allow-overlap': true,
        'icon-offset': [0, -15],
      },
      paint: { 'icon-opacity': 0.95 },
    });
    map.addLayer({
      id: 'bus-labels', type: 'symbol', source: 'buses', minzoom: 12.5,
      layout: { 'text-field': ['get', 'route'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': false },
      paint: { 'text-color': '#f2f6fa', 'text-halo-color': '#060b12', 'text-halo-width': 1.8 },
    });

    /* ---------------- 3D bus models (instanced, zoom-gated) ----------------
       Model: "Low-poly City - Bus" by Innerscene, CC0 (https://www.innerscene.com/tools/library/3d-parts/low-poly-city-bus-49c04273).
       Renders as a real 3D bus at zoom >= 13.5; green dots stay below that. */
    const BUS3D_MIN_ZOOM = 13.5;
    const bus3d = { ready: false, instances: [], max: 4000, renderedVersion: -1 };
    let _rxBase = null;
    function fadeOutDots() {
      // keep the circle layer present (tap targets) but invisible at high zoom
      map.setPaintProperty('buses', 'circle-opacity', ['interpolate', ['linear'], ['zoom'], BUS3D_MIN_ZOOM - 0.15, 1, BUS3D_MIN_ZOOM + 0.15, 0]);
      map.setPaintProperty('buses', 'circle-stroke-opacity', ['interpolate', ['linear'], ['zoom'], BUS3D_MIN_ZOOM - 0.15, 1, BUS3D_MIN_ZOOM + 0.15, 0]);
      map.setPaintProperty('buses', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 9, 16, 13]);
      map.setPaintProperty('bus-arrows', 'icon-opacity', ['interpolate', ['linear'], ['zoom'], BUS3D_MIN_ZOOM - 0.15, 0.95, BUS3D_MIN_ZOOM + 0.15, 0]);
    }
    function updateBusInstances() {
      const list = buses.slice(0, bus3d.max);
      const n = list.length;
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), m = new THREE.Matrix4(), m2 = new THREE.Matrix4();
      const upAxis = new THREE.Vector3(0, 0, 1);
      for (let i = 0; i < n; i++) {
        const b = list[i];
        const mc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: b.lon, lat: b.lat }, 0);
        const sc = mc.meterInMercatorCoordinateUnits();
        q.setFromAxisAngle(upAxis, toRad(b.bearing || 0));
        p.set(mc.x, mc.y, 0); s.set(sc * 1.35, sc * 1.35, sc * 1.35); // model is a ~7.9m minibus; ~11m reads better on the map
        m.compose(p, q, s).multiply(_rxBase);
        for (const im of bus3d.instances) im.setMatrixAt(i, m2.copy(m).multiply(im.userData.local));
      }
      for (const im of bus3d.instances) { im.count = n; im.instanceMatrix.needsUpdate = true; }
    }
    const bus3dLayer = {
      id: 'buses-3d', type: 'custom', renderingMode: '3d',
      onAdd(mapInst, gl) {
        _rxBase = new THREE.Matrix4().makeRotationZ(-Math.PI / 2).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)); // model: up +Y, forward +X -> world: up +Z, forward north
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x2a3442, 1.15));
        const sun = new THREE.DirectionalLight(0xffffff, 0.55);
        sun.position.set(60, -90, 140);
        this.scene.add(sun);
        this.renderer = new THREE.WebGLRenderer({ canvas: mapInst.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
        const loader = new THREE.GLTFLoader();
        if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
        loader.load('/bus.glb', (gltf) => {
          gltf.scene.updateMatrixWorld(true);
          const meshes = [];
          gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
          bus3d.instances = meshes.map((mm) => {
            const im = new THREE.InstancedMesh(mm.geometry, mm.material, bus3d.max);
            im.count = 0;
            im.frustumCulled = false;
            im.userData.local = mm.matrixWorld.clone();
            this.scene.add(im);
            return im;
          });
          bus3d.ready = true;
          fadeOutDots();
          map.triggerRepaint();
        }, undefined, () => { /* model failed: green dots stay, nothing breaks */ });
      },
      render(gl, matrix) {
        if (!bus3d.ready || map.getZoom() < BUS3D_MIN_ZOOM) return;
        if (bus3d.renderedVersion !== busDataVersion) {
          updateBusInstances();
          bus3d.renderedVersion = busDataVersion;
        }
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix);
        this.renderer.state.reset();
        this.renderer.render(this.scene, this.camera);
      },
    };
    map.addLayer(bus3dLayer);

    map.on('click', 'stops', (e) => {
      const p = e.features[0].properties;
      if (p && p.id != null) renderStopSheet(String(p.id), p.name);
    });
    map.on('mouseenter', 'stops', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'stops', () => (map.getCanvas().style.cursor = ''));

    map.on('click', 'buses', (e) => {
      const id = e.features[0].properties.id;
      const bus = buses.find((b) => b.id === id);
      if (bus) {
        setSelected(bus);
        Promise.all([loadPatterns(), loadRoutes()]).then(() => renderBusSheet(bus));
        map.easeTo({ center: [bus.lon, bus.lat], duration: 400 });
      }
    });
    map.on('mouseenter', 'buses', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'buses', () => (map.getCanvas().style.cursor = ''));

    async function refresh() {
      try {
        const data = await (await fetch('/api/vehicles')).json();
        buses = data.buses || [];
        const features = buses.map((b) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
          properties: { id: b.id, route: b.route || '', route_id: b.route_id || '', route_name: routeSubName(b.route_id), speed: b.speed, ts: b.ts, bearing: b.bearing || 0 },
        }));
        map.getSource('buses').setData({ type: 'FeatureCollection', features });
        busDataVersion++;
        map.triggerRepaint();
        demoBadge.classList.toggle('hidden', !data.demo);
        statusDot.classList.toggle('err', Boolean(data.feed_error || data.demo));
        const time = new Date(data.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        statusEl.textContent = `${data.count} buses · ${time}${data.feed_error ? ' · feed error' : ''}`;
        if (followedId) {
          const b = buses.find((x) => x.id === followedId);
          if (b) {
            map.easeTo({ center: [b.lon, b.lat], duration: 600 });
            setSelected(b);
            renderBusSheet(b);
          } else {
            followedId = null;
            closeSheet();
          }
        }
      } catch (e) {
        statusEl.textContent = 'update failed, retrying…';
        statusDot.classList.add('err');
      }
    }
    await refresh();
    if (loadingEl) loadingEl.classList.add('gone');
    applyFilter();
    setInterval(refresh, 15000);

    /* deep links: #bus=<id> opens a bus, #near=<lat>,<lon> shows next buses there, #3d */
    const hash = location.hash.slice(1);
    if (hash) {
      const parts = hash.split(',');
      if (parts[0] === '3d') {
        is3D = true;
        document.getElementById('btn-3d').classList.add('on');
        addBuildings();
        map.jumpTo({ pitch: 62, zoom: 15, center: [77.2167, 28.6315] });
      }
      if (parts[0].startsWith('bus=')) {
        const id = parts[0].slice(4);
        const b = buses.find((x) => x.id === id);
        if (b) {
          await Promise.all([loadPatterns(), loadRoutes()]);
          map.jumpTo({ center: [b.lon, b.lat], zoom: 13.5 });
          renderBusSheet(b);
        }
      }
      if (parts[0].startsWith('near=')) {
        const [lat, lon] = parts[0].slice(5).split('/').map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          userLoc = { lat, lon };
          map.jumpTo({ center: [lon, lat], zoom: 14.5 });
          renderNearMe();
        }
      }
    }
  });
})();
