const { getVehicles } = require('../lib/feed');

module.exports = async (req, res) => {
  try {
    const payload = await getVehicles();
    res.setHeader('Cache-Control', 'public, max-age=8');
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

