// Real arrival predictions from GTFS-RT trip updates (reclaim.city mirror).
// ?stop_id=123   -> next buses predicted at that stop
// ?vehicle_id=DL1PD8842 -> that bus's upcoming stop predictions
const { getTripUpdates, routeLabel } = require('../lib/feed');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const stopId = url.searchParams.get('stop_id');
    const vehicleId = url.searchParams.get('vehicle_id');
    const data = await getTripUpdates();
    const now = Math.floor(Date.now() / 1000);

    if (stopId) {
      const arrivals = [];
      for (const t of data.trips) {
        for (const u of t.updates) {
          if (u.stop_id !== stopId) continue;
          if (u.t < now - 60) continue; // stale
          arrivals.push({
            route_id: t.route_id,
            route: routeLabel(t.route_id),
            vehicle_id: t.vehicle_id,
            eta: u.t,
            in_sec: u.t - now,
          });
          break; // one entry per trip for this stop
        }
      }
      arrivals.sort((a, b) => a.eta - b.eta);
      res.setHeader('Cache-Control', 'public, max-age=8');
      return res.status(200).json({ updated: data.updated, error: data.error || null, arrivals: arrivals.slice(0, 12) });
    }

    if (vehicleId) {
      const t = data.trips.find((x) => x.vehicle_id === vehicleId);
      const updates = t ? t.updates.filter((u) => u.t >= now - 60) : [];
      res.setHeader('Cache-Control', 'public, max-age=8');
      return res.status(200).json({
        updated: data.updated, error: data.error || null,
        route_id: t ? t.route_id : null,
        updates: updates.slice(0, 20),
      });
    }

    res.status(400).json({ error: 'pass stop_id or vehicle_id' });
  } catch (e) {
    res.status(200).json({ error: String(e.message || e), arrivals: [], updates: [] });
  }
};
