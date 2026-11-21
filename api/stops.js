const fs = require('fs');
const path = require('path');

let stops = null;

module.exports = async (req, res) => {
  try {
    if (!stops) {
      stops = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stops.json'), 'utf8'));
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).json({ count: stops.length, stops });
  } catch (e) {
    res.status(200).json({ count: 0, stops: [], note: 'stops.json not prepared yet' });
  }
};

