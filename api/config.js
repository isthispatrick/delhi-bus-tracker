module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    mapboxToken: process.env.MAPBOX_TOKEN || '',
    live: Boolean(process.env.OTD_API_KEY),
  });
};

