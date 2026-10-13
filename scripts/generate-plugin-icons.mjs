import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return out;
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const centers = [
    [0.28, 0.36],
    [0.5, 0.36],
    [0.72, 0.36],
    [0.28, 0.64],
    [0.5, 0.64],
    [0.72, 0.64],
  ];
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const offset = y * stride + 1 + x * 4;
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const selectedGlow = Math.max(0, 1 - Math.hypot(nx - 0.5, ny - 0.36) / 0.28);
      let red = 45 + Math.floor(5 * (1 - ny));
      let green = 47 + Math.floor(6 * (1 - ny)) + Math.floor(selectedGlow * 8);
      let blue = 49 + Math.floor(7 * (1 - ny)) + Math.floor(selectedGlow * 18);

      for (let index = 0; index < centers.length; index++) {
        const [cx, cy] = centers[index];
        const distance = roundedRectDistance(nx, ny, cx, cy, 0.085, 0.09, 0.025);
        if (distance <= 0.012) {
          const selected = index === 1;
          const border = distance > 0;
          red = border ? (selected ? 47 : 78) : selected ? 39 : 56;
          green = border ? (selected ? 137 : 81) : selected ? 91 : 59;
          blue = border ? (selected ? 255 : 85) : selected ? 146 : 62;
          const dot = Math.hypot(nx - cx, ny - cy);
          if (dot < 0.018) {
            red = selected ? 57 : 224;
            green = selected ? 154 : 226;
            blue = selected ? 255 : 224;
          }
          break;
        }
      }

      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = edge < size * 0.06 ? Math.max(0, Math.floor((255 * edge) / (size * 0.06))) : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRectDistance(x, y, centerX, centerY, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x - centerX) - halfWidth + radius;
  const dy = Math.abs(y - centerY) - halfHeight + radius;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

export function generatePluginIcons(root = process.cwd()) {
  for (const [name, size] of [
    ["plugin-icon.png", 256],
    ["plugin-icon@2x.png", 512],
  ]) {
    const path = resolve(root, "static/imgs", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png(size));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generatePluginIcons();
}
