import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export type Rgb = [number, number, number];

export function createCanvas(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4);
  const set = (x: number, y: number, color: Rgb, alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (Math.floor(y) * width + Math.floor(x)) * 4;
    const a = alpha / 255;
    data[i] = Math.round(data[i] * (1 - a) + color[0] * a);
    data[i + 1] = Math.round(data[i + 1] * (1 - a) + color[1] * a);
    data[i + 2] = Math.round(data[i + 2] * (1 - a) + color[2] * a);
    data[i + 3] = 255;
  };
  const rect = (x: number, y: number, w: number, h: number, color: Rgb) => {
    for (let py = Math.max(0, y); py < Math.min(height, y + h); py++) {
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px++) set(px, py, color);
    }
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, color: Rgb) => {
    for (let py = Math.floor(cy - ry); py <= cy + ry; py++) {
      for (let px = Math.floor(cx - rx); px <= cx + rx; px++) {
        const dx = (px - cx) / rx;
        const dy = (py - cy) / ry;
        if (dx * dx + dy * dy <= 1) set(px, py, color);
      }
    }
  };
  const gradient = (top: Rgb, bottom: Rgb) => {
    for (let y = 0; y < height; y++) {
      const t = y / height;
      const color: Rgb = [
        Math.round(top[0] + (bottom[0] - top[0]) * t),
        Math.round(top[1] + (bottom[1] - top[1]) * t),
        Math.round(top[2] + (bottom[2] - top[2]) * t),
      ];
      rect(0, y, width, 1, color);
    }
  };
  const noise = (amount: number) => {
    for (let i = 0; i < data.length; i += 4) {
      const delta = Math.round((Math.random() - 0.5) * amount);
      data[i] = Math.max(0, Math.min(255, data[i] + delta));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + delta));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + delta));
    }
  };
  return {
    data,
    set,
    rect,
    ellipse,
    gradient,
    noise,
    png: () => encodePng(width, height, data),
  };
}
