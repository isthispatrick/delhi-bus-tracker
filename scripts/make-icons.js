// Draws the app icons (PNG) with no dependencies: Delhi-orange tile with a dark bus glyph.
// Writes public/icons/icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png (180).
// Usage: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const ORANGE = [255, 106, 31], INK = [26, 10, 2];

// signed-distance helpers in a 0..1 unit square
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

// colour at a point: tile + bus glyph (glyph scaled by `g` around the centre)
function shade(x, y, { round, g }) {
  if (round && rrect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null; // transparent outside the rounded tile
  const u = 0.5 + (x - 0.5) / g, v = 0.5 + (y - 0.5) / g;
  const body = rrect(u, v, 0.5, 0.46, 0.26, 0.25, 0.07);
  const glass = rrect(u, v, 0.5, 0.38, 0.2, 0.1, 0.03);
  const lampL = circle(u, v, 0.34, 0.6, 0.035), lampR = circle(u, v, 0.66, 0.6, 0.035);
  const wheelL = rrect(u, v, 0.35, 0.75, 0.055, 0.06, 0.02), wheelR = rrect(u, v, 0.65, 0.75, 0.055, 0.06, 0.02);
  const mirror = rrect(u, v, 0.5, 0.19, 0.12, 0.02, 0.01);
  const ink = (body < 0 && glass > 0 && lampL > 0 && lampR > 0) || wheelL < 0 || wheelR < 0 || mirror < 0;
  return ink ? INK : ORANGE;
}

function render(size, opts) {
  const SS = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, gg = 0, b = 0, a = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const c = shade((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, opts);
      if (!c) continue;
      r += c[0]; gg += c[1]; b += c[2]; a += 1;
    }
    const o = (j * size + i) * 4;
    if (a) { px[o] = r / a; px[o + 1] = gg / a; px[o + 2] = b / a; }
    px[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
  return png(size, size, px);
}

// minimal PNG encoder (RGBA, filter 0)
function png(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const files = {
  'icon-192.png': render(192, { round: true, g: 1 }),
  'icon-512.png': render(512, { round: true, g: 1 }),
  'maskable-512.png': render(512, { round: false, g: 0.72 }), // full bleed, glyph inside the safe zone
  'apple-touch-icon.png': render(180, { round: false, g: 0.9 }), // iOS rounds the corners itself
};
for (const [name, buf] of Object.entries(files)) { fs.writeFileSync(path.join(OUT, name), buf); console.log(name, buf.length); }
