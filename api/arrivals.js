// Real arrival predictions from GTFS-RT trip updates (reclaim.city mirror).
//   ?stop_id=123              -> next buses predicted at that stop
//   ?stop_ids=123,456,789     -> same, for several stops at once: {stops: {id: [arrivals]}} (max 40)
//   ?vehicle_id=DL1PD8842     -> that bus's upcoming stop predictions
// Every response carries `stale: true` when predictions come from a cached copy after an upstream failure.
const { getTripUpdates, routeLabel } = require('../lib/feed');

function arrivalsFor(data, stopIds, now) {
  const want = new Set(stopIds);
  const out = {};
  for (const id of want) out[id] = [];
  for (const t of data.trips) {
    for (const u of t.updates) {
      if (!want.has(u.stop_id)) continue;
      if (u.t < now - 60) continue; // already left
      // delay: seconds vs the timetable the feed predicts against (+ late, - early)
      out[u.stop_id].push({ route_id: t.route_id, route: routeLabel(t.route_id), vehicle_id: t.vehicle_id, eta: u.t, in_sec: u.t - now, delay: u.delay || 0 });
    }
  }
  for (const id of Object.keys(out)) out[id] = out[id].sort((a, b) => a.eta - b.eta).slice(0, 12);
  return out;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const stopId = url.searchParams.get('stop_id');
    const stopIds = (url.searchParams.get('stop_ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const vehicleId = url.searchParams.get('vehicle_id');
    const data = await getTripUpdates();
    const now = Math.floor(Date.now() / 1000);
    const meta = { updated: data.updated || null, stale: Boolean(data.stale), error: data.error || null };
    res.setHeader('Cache-Control', 'public, max-age=8, s-maxage=8, stale-while-revalidate=15');

    if (stopIds.length) return res.status(200).json({ ...meta, stops: arrivalsFor(data, stopIds, now) });
    if (stopId) return res.status(200).json({ ...meta, arrivals: arrivalsFor(data, [stopId], now)[stopId] });
    if (vehicleId) {
      const t = data.trips.find((x) => x.vehicle_id === vehicleId);
      const updates = t ? t.updates.filter((u) => u.t >= now - 60) : [];
      return res.status(200).json({ ...meta, route_id: t ? t.route_id : null, updates: updates.slice(0, 40) });
    }
    res.status(400).json({ error: 'pass stop_id, stop_ids or vehicle_id' });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ error: 'predictions unavailable', stale: true, arrivals: [], updates: [], stops: {} });
  }
};
