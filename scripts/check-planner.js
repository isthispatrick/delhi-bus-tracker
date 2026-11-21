// Offline check for public/planner.js: Connaught Place -> Nehru Place (and a few more pairs).
// Usage: node scripts/check-planner.js [HH:MM]
const fs = require('fs');
const path = require('path');
const P = require('../public/planner.js');
const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', f), 'utf8'));
const data = { patterns: D('route_patterns.json'), freq: D('route_freq.json'), metro: D('metro.json'), places: D('places.json'), stops: D('stops.json') };
const t = process.argv[2] || '10:00';
const minutes = +t.split(':')[0] * 60 + +t.split(':')[1];

let t0 = Date.now();
const net = P.build(data, { minutes });
console.log(`network: ${net.nodes.length} nodes, ${net.routes.length} routes, built in ${Date.now() - t0} ms (at ${t} IST, metro ${net.metroOpen ? 'open' : 'closed'})`);
const index = P.buildIndex(data);

const pairs = [['Connaught Place', 'Nehru Place'], ['Kashmere Gate', 'Hauz Khas'], ['Anand Vihar', 'Dwarka Sector 21'], ['India Gate', 'Lajpat Nagar']];
let failed = 0;
for (const [a, b] of pairs) {
  const o = P.search(index, a, 1)[0], d = P.search(index, b, 1)[0];
  t0 = Date.now();
  const res = P.plan(net, o, d);
  console.log(`\n${o.name} (${o.kind}) -> ${d.name} (${d.kind}): ${res.options.length} options in ${Date.now() - t0} ms`);
  if (!res.options.length) failed++;
  for (const opt of res.options) {
    console.log(`  ${Math.round(opt.secs / 60)} min, ${opt.rides} rides, walk ${opt.walkM} m`);
    for (const l of opt.legs) {
      if (l.type === 'walk') console.log(`    walk ${l.dist} m (${Math.round(l.secs / 60)} min) to ${l.to.name}`);
      else console.log(`    ${l.type.toUpperCase()} ${l.label}${l.scheduled ? ' [scheduled]' : ''} towards ${l.headsign}: ${l.board.name} -> ${l.alight.name}, ${l.stops.length - 1} stops, ride ${Math.round(l.rideSecs / 60)} min + wait ~${Math.round(l.waitSecs / 60)} min`);
    }
  }
}
// metro legs must be marked scheduled, and never carry live data
const cp = P.plan(net, P.search(index, 'Connaught Place', 1)[0], P.search(index, 'Nehru Place', 1)[0]);
const metroLegs = cp.options.flatMap((o) => o.legs).filter((l) => l.type === 'metro');
if (metroLegs.some((l) => !l.scheduled)) { console.error('FAIL: metro leg not marked scheduled'); failed++; }
if (!metroLegs.length) console.warn('note: no metro leg in CP -> Nehru Place options');
process.exit(failed ? 1 : 0);
