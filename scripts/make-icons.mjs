// Generates PNG app icons from the SVault mark without external image tools.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT_DIR = path.join(process.cwd(), "public");
fs.mkdirSync(OUT_DIR, { recursive: true });

const BRAND = [31, 122, 92];
const INK = [246, 243, 236];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function writePng(file, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${width}x${height})`);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function roundedRectAlpha(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dist = Math.hypot(x - cx, y - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - dist));
}

function drawIcon(size, file) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 48;
  const radius = size * 0.23;
  const points = [
    [13, 18.5],
    [24, 12],
    [35, 18.5],
    [35, 29.5],
    [24, 36],
    [13, 29.5],
  ].map(([x, y]) => [x * scale, y * scale]);
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 0],
  ];
  const center = [24 * scale, 25 * scale];
  const bottom = [24 * scale, 36 * scale];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const alpha = roundedRectAlpha(px, py, size, size, radius);
      if (alpha <= 0) continue;

      let ink = 0;
      const thickness = size * 0.045;
      for (const [a, b] of edges) {
        ink = Math.max(ink, Math.max(0, Math.min(1, thickness - distToSegment(px, py, points[a][0], points[a][1], points[b][0], points[b][1]))));
      }
      for (const point of [points[0], points[2], points[3], points[4], points[5]]) {
        ink = Math.max(ink, Math.max(0, Math.min(1, thickness - distToSegment(px, py, center[0], center[1], point[0], point[1]))));
      }
      ink = Math.max(ink, Math.max(0, Math.min(1, thickness - distToSegment(px, py, center[0], center[1], bottom[0], bottom[1]))));
      const dot = Math.max(0, Math.min(1, size * 0.05 - Math.hypot(px - center[0], py - center[1])));

      const i = (y * size + x) * 4;
      const mix = (a, b, t) => Math.round(a + (b - a) * t);
      rgba[i] = mix(BRAND[0], INK[0], Math.max(ink, dot));
      rgba[i + 1] = mix(BRAND[1], INK[1], Math.max(ink, dot));
      rgba[i + 2] = mix(BRAND[2], INK[2], Math.max(ink, dot));
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  writePng(file, size, size, rgba);
}

drawIcon(192, path.join(OUT_DIR, "icon-192.png"));
drawIcon(512, path.join(OUT_DIR, "icon-512.png"));
drawIcon(180, path.join(OUT_DIR, "icon-180.png"));
