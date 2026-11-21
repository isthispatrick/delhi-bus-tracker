// Local dev server: mimics Vercel's public/ + api/ layout.
const http = require('http');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch {}
// Minimal .env loader so no dotenv dependency is needed
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const apis = {
  '/api/vehicles': require('./api/vehicles'),
  '/api/stops': require('./api/stops'),
  '/api/routes': require('./api/routes'),
  '/api/config': require('./api/config'),
  '/api/arrivals': require('./api/arrivals'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (apis[pathname]) {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
    return apis[pathname](req, res);
  }
  let file = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Delhi bus tracker on http://localhost:${port}`));

