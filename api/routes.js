const fs = require('fs');
const path = require('path');

let routes = null;

module.exports = async (req, res) => {
  try {
    if (!routes) {
      routes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'routes.json'), 'utf8'));
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).json({ count: routes.length, routes });
  } catch (e) {
    res.status(200).json({ count: 0, routes: [], note: 'routes.json not prepared yet' });
  }
};

