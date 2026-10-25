// Generates client/public/icon-192.png and icon-512.png (same design as icon.svg)
// with a tiny dependency-free rasterizer + PNG encoder. Run: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Shapes in a 64x64 design space, painted in order.
const inRoundRect = (x, y, rx, ry, w, h, r) => {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const SHAPES = [
  [(x, y) => inRoundRect(x, y, 0, 0, 64, 64, 14), hex('#10141d')],
  [(x, y) => inTri(x, y, [26, 44], [32, 60], [38, 44]), hex('#ffb347')],
  [(x, y) => inTri(x, y, [29, 44], [32, 53], [35, 44]), hex('#fff4c2')],
  [(x, y) => inRoundRect(x, y, 20, 30, 24, 14, 4), hex('#5b6170')],
  [(x, y) => y <= 30 && (x - 32) ** 2 + (y - 30) ** 2 <= 18 * 18, hex('#ff8a3d')],
  [(x, y) => inRoundRect(x, y, 30, 20, 16, 8, 3), hex('#1b2230')],
  [(x, y) => x >= 38 && x <= 43 && y >= 22 && y <= 24, hex('#a0dcff')],
];

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling for anti-aliasing
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((pxx + (sx + 0.5) / SS) / size) * 64;
          const y = ((py + (sy + 0.5) / SS) / size) * 64;
          let col = null;
          for (const [test, c] of SHAPES) if (test(x, y)) col = c;
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxx) * 4;
      const cov = a / 255;
      px[i] = cov ? r / cov : 0;
      px[i + 1] = cov ? g / cov : 0;
      px[i + 2] = cov ? b / cov : 0;
      px[i + 3] = a / n;
    }
  }
  return px;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const raw = render(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [192, 512]) {
  const out = new URL(`../client/public/icon-${s}.png`, import.meta.url);
  writeFileSync(out, png(s));
  console.log('wrote', out.pathname);
}
