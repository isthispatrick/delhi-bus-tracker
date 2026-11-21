// GET /api/vehicles          verbose payload: {demo, count, updated, buses:[...]} plus source/stale/errors
// GET /api/vehicles?v=2      compact payload used by the app (see compact() in lib/feed.js)
const { getVehicles, getTripUpdates, compact } = require('../lib/feed');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // warm this instance's trip-update cache in parallel: the app asks for arrivals right after
    getTripUpdates().catch(() => {});
    const payload = await getVehicles();
    // CDN keeps a copy for 5 s (+5 s while revalidating): one upstream fetch per window for everyone, never more than ~10 s behind
    res.setHeader('Cache-Control', payload.demo || payload.stale ? 'no-store' : 'public, max-age=0, s-maxage=5, stale-while-revalidate=5');
    res.status(200).json(url.searchParams.get('v') === '2' ? compact(payload) : payload);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'vehicles unavailable' });
  }
};
