/**
 * NOVA OS — brand asset generator.
 *
 * Renders the app icon, Android adaptive-icon layers, splash mark and favicon
 * with flat geometry, then writes real PNG files. No dependencies, no native
 * modules: PNG encoding is done with Node's built-in zlib.
 *
 *   npm run assets
 *
 * The generated PNGs are build artefacts (git-ignored) and are recreated
 * automatically after install, so the repository stays text-only.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, 'assets');

const BG = [5, 6, 11];
const NAVY = [10, 14, 28];
const VIOLET = [139, 92, 246];
const VIOLET_DEEP = [91, 33, 182];
const CYAN = [34, 211, 238];
const WHITE = [244, 245, 255];

const SS = 3; // supersampling factor for clean edges

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- canvas ---- */

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  paint(bbox, color, inside) {
    const [r, g, b, a] = color;
    const sa = a / 255;
    const x0 = Math.max(0, Math.floor(bbox[0]));
    const y0 = Math.max(0, Math.floor(bbox[1]));
    const x1 = Math.min(this.size, Math.ceil(bbox[2]));
    const y1 = Math.min(this.size, Math.ceil(bbox[3]));

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!inside(x + 0.5, y + 0.5)) continue;

        const i = (y * this.size + x) * 4;
        const da = this.data[i + 3] / 255;
        const outA = sa + da * (1 - sa);
        if (outA <= 0) continue;

        this.data[i] = Math.round((r * sa + this.data[i] * da * (1 - sa)) / outA);
        this.data[i + 1] = Math.round((g * sa + this.data[i + 1] * da * (1 - sa)) / outA);
        this.data[i + 2] = Math.round((b * sa + this.data[i + 2] * da * (1 - sa)) / outA);
        this.data[i + 3] = Math.round(outA * 255);
      }
    }
  }

  fill(color) {
    this.paint([0, 0, this.size, this.size], color, () => true);
  }

  toBuffer(targetSize) {
    const factor = this.size / targetSize;
    const out = Buffer.alloc(targetSize * targetSize * 4);

    for (let y = 0; y < targetSize; y += 1) {
      for (let x = 0; x < targetSize; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let alpha = 0;

        for (let sy = 0; sy < factor; sy += 1) {
          for (let sx = 0; sx < factor; sx += 1) {
            const i = ((y * factor + sy) * this.size + (x * factor + sx)) * 4;
            const a = this.data[i + 3];
            r += (this.data[i] * a) / 255;
            g += (this.data[i + 1] * a) / 255;
            b += (this.data[i + 2] * a) / 255;
            alpha += a;
          }
        }

        const o = (y * targetSize + x) * 4;
        if (alpha === 0) continue;

        out[o] = Math.round((r / alpha) * 255);
        out[o + 1] = Math.round((g / alpha) * 255);
        out[o + 2] = Math.round((b / alpha) * 255);
        out[o + 3] = Math.round(alpha / (factor * factor));
      }
    }

    return out;
  }
}

/* ------------------------------------------------------------- geometry ---- */

const rad = (deg) => (deg * Math.PI) / 180;

const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return dist(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function nearPolygon(points, x, y, width) {
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    if (distToSegment(x, y, points[j][0], points[j][1], points[i][0], points[i][1]) <= width / 2) {
      return true;
    }
  }
  return false;
}

const angleOf = (x, y, cx, cy) => {
  let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
};

const withinArc = (a, start, end) =>
  start <= end ? a >= start && a <= end : a >= start || a <= end;

const bboxCircle = (cx, cy, r) => [cx - r, cy - r, cx + r, cy + r];

function drawPolygon(canvas, points, color, width = 0, mode = 'fill') {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const pad = width + 2;
  const bbox = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  const test =
    mode === 'stroke'
      ? (x, y) => nearPolygon(points, x, y, width)
      : (x, y) => insidePolygon(points, x, y);
  canvas.paint(bbox, color, test);
}

function drawCircle(canvas, cx, cy, r, color) {
  canvas.paint(bboxCircle(cx, cy, r + 1), color, (x, y) => dist(x, y, cx, cy) <= r);
}

function drawRing(canvas, cx, cy, radius, width, color) {
  canvas.paint(
    bboxCircle(cx, cy, radius + width),
    color,
    (x, y) => Math.abs(dist(x, y, cx, cy) - radius) <= width / 2,
  );
}

function drawArc(canvas, cx, cy, radius, width, start, end, color) {
  canvas.paint(
    bboxCircle(cx, cy, radius + width),
    color,
    (x, y) => Math.abs(dist(x, y, cx, cy) - radius) <= width / 2 && withinArc(angleOf(x, y, cx, cy), start, end),
  );
}

/* ------------------------------------------------------------------ mark ---- */

function drawMark(size, { background = false, scale = 1 } = {}) {
  const s = size * SS;
  const canvas = new Canvas(s);
  if (background) canvas.fill([...BG, 255]);

  const cx = s / 2;
  const cy = s / 2;
  const unit = s * scale;
  const stroke = Math.max(1, unit * 0.012);

  // Containment hexagon: filled deck plus a bright technical outline.
  const hexRadius = unit * 0.4;
  const hex = Array.from({ length: 6 }, (_, i) => [
    cx + hexRadius * Math.cos(rad(60 * i - 90)),
    cy + hexRadius * Math.sin(rad(60 * i - 90)),
  ]);
  drawPolygon(canvas, hex, [...NAVY, 255]);
  drawPolygon(canvas, hex, [...VIOLET, 150], stroke, 'stroke');

  // Main orbit: violet and cyan sweeps with a deliberate gap.
  const ringRadius = unit * 0.295;
  const ringWidth = Math.max(2, unit * 0.03);
  drawArc(canvas, cx, cy, ringRadius, ringWidth, 128, 352, [...VIOLET, 255]);
  drawArc(canvas, cx, cy, ringRadius, ringWidth, 12, 116, [...CYAN, 255]);

  // Inner orbit for depth.
  const innerRadius = unit * 0.225;
  const innerWidth = Math.max(1, unit * 0.01);
  drawArc(canvas, cx, cy, innerRadius, innerWidth, 200, 330, [...VIOLET_DEEP, 255]);
  drawArc(canvas, cx, cy, innerRadius, innerWidth, 20, 150, [...CYAN, 90]);

  // Satellites riding the main orbit.
  const satellites = [
    { angle: 128, color: CYAN, radius: 0.03 },
    { angle: 352, color: VIOLET, radius: 0.022 },
  ];
  for (const satellite of satellites) {
    const px = cx + ringRadius * Math.cos(rad(satellite.angle));
    const py = cy + ringRadius * Math.sin(rad(satellite.angle));
    const r = unit * satellite.radius;
    drawCircle(canvas, px, py, r, [...satellite.color, 255]);
    drawRing(canvas, px, py, r, Math.max(1, unit * 0.004), [...WHITE, 170]);
  }

  // Core: dark disc, violet containment ring, cyan plasma, white centre.
  const coreRadius = unit * 0.145;
  drawCircle(canvas, cx, cy, coreRadius, [...BG, 255]);
  drawRing(canvas, cx, cy, coreRadius, Math.max(2, unit * 0.016), [...VIOLET, 255]);
  drawCircle(canvas, cx, cy, coreRadius * 0.6, [...CYAN, 255]);
  drawCircle(canvas, cx, cy, coreRadius * 0.26, [...WHITE, 255]);

  return canvas.toBuffer(size);
}

function drawMonochrome(size) {
  const s = size * SS;
  const canvas = new Canvas(s);
  const cx = s / 2;
  const cy = s / 2;

  drawRing(canvas, cx, cy, s * 0.3, Math.max(2, s * 0.03), [...WHITE, 255]);
  drawCircle(canvas, cx, cy, s * 0.145, [...WHITE, 255]);

  return canvas.toBuffer(size);
}

/* ------------------------------------------------------------------ main ---- */

const OUTPUTS = [
  ['icon.png', 512, () => drawMark(512, { background: true, scale: 0.92 }), 'rgb'],
  ['adaptive-icon-foreground.png', 512, () => drawMark(512, { background: false, scale: 0.66 })],
  ['adaptive-icon-monochrome.png', 512, () => drawMonochrome(512)],
  ['splash-icon.png', 512, () => drawMark(512, { background: false, scale: 0.92 })],
  ['favicon.png', 96, () => drawMark(96, { background: true, scale: 0.98 }), 'rgb'],
];

mkdirSync(ASSETS, { recursive: true });

for (const [name, size, render, flatten] of OUTPUTS) {
  let rgba = render();
  if (flatten === 'rgb') {
    const opaque = Buffer.alloc(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      opaque[i] = rgba[i];
      opaque[i + 1] = rgba[i + 1];
      opaque[i + 2] = rgba[i + 2];
      opaque[i + 3] = 255;
    }
    rgba = opaque;
  }

  const png = encodePng(size, size, rgba);
  writeFileSync(join(ASSETS, name), png);
  console.log(`${name}: ${size}x${size}, ${(png.length / 1024).toFixed(1)} KB`);
}
