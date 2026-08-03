#!/usr/bin/env node
// Generates the app icon and NSIS installer sidebar image from scratch, hand-rolling PNG/BMP
// encoding directly (no image library dependency -- consistent with this project's existing
// no-framework/hand-rolled-canvas approach for the stats chart and card exports). Palette and the
// diamond/chevron emblem shape are pulled straight from electron/renderer/index.html's CSS (--red/
// --grey/--black/--gold and the .emblem clip-path), so this stays in sync with the in-app branding by
// construction rather than by copy-pasted hex codes going stale.
// Run: node bin/generate-branding.js -- writes build/icon.png and build/installerSidebar.bmp
// (electron-builder auto-discovers both by filename from the `build/` resources directory; the
// uninstaller sidebar falls back to installerSidebar.bmp when uninstallerSidebar.bmp isn't present).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RED = [155, 27, 30];
const GOLD = [201, 169, 81];
const DARK = [20, 20, 20];
const BLACK = [8, 8, 8];

function makeCanvas(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

function setPixel(cv, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  cv.data[i] = r;
  cv.data[i + 1] = g;
  cv.data[i + 2] = b;
  cv.data[i + 3] = a;
}

function fillRect(cv, x0, y0, x1, y1, col, a = 255) {
  for (let y = Math.max(0, y0); y < Math.min(cv.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(cv.w, x1); x++) setPixel(cv, x, y, col, a);
  }
}

// Vertical gradient rect, linearly interpolating between colA (top) and colB (bottom).
function fillGradientRect(cv, x0, y0, x1, y1, colA, colB) {
  for (let y = Math.max(0, y0); y < Math.min(cv.h, y1); y++) {
    const t = (y - y0) / Math.max(1, y1 - y0 - 1);
    const col = [0, 1, 2].map((i) => Math.round(colA[i] + (colB[i] - colA[i]) * t));
    for (let x = Math.max(0, x0); x < Math.min(cv.w, x1); x++) setPixel(cv, x, y, col);
  }
}

function fillCircle(cv, cx, cy, radius, col, a = 255) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(cv, x, y, col, a);
    }
  }
}

function strokeCircle(cv, cx, cy, radius, thickness, col, a = 255) {
  const outer2 = (radius + thickness / 2) ** 2;
  const inner2 = (radius - thickness / 2) ** 2;
  for (let y = Math.floor(cy - radius - thickness); y <= Math.ceil(cy + radius + thickness); y++) {
    for (let x = Math.floor(cx - radius - thickness); x <= Math.ceil(cx + radius + thickness); x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= outer2 && d2 >= inner2) setPixel(cv, x, y, col, a);
    }
  }
}

// Scanline fill with sorted-crossing pairing -- this is exactly the even-odd rule, which is what's
// needed for the emblem's self-intersecting "diamond with a diamond-shaped hole" outline (same single
// closed point list as the CSS clip-path polygon(), not two separate subpaths).
function fillPolygonEvenOdd(cv, pts, col, a = 255) {
  const ys = pts.map((p) => p[1]);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(cv.h - 1, Math.ceil(Math.max(...ys)));
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) setPixel(cv, x, y, col, a);
    }
  }
}

// The .emblem clip-path polygon from index.html's header, as fractional (0-1) coordinates: an outer
// diamond with a smaller diamond-shaped hole cut into it via the even-odd rule above.
const EMBLEM_FRACTIONAL_POINTS = [
  [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5],
  [0.5, 0.2], [0.3, 0.5], [0.5, 0.8], [0.7, 0.5]
];

function emblemPointsIn(box) {
  return EMBLEM_FRACTIONAL_POINTS.map(([fx, fy]) => [box.x + fx * box.size, box.y + fy * box.size]);
}

// --- PNG encoding (RGBA, filter-none rows, zlib-deflated via node's built-in zlib) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(cv) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  const raw = Buffer.alloc(cv.h * (1 + cv.w * 4));
  for (let y = 0; y < cv.h; y++) {
    const rowStart = y * (1 + cv.w * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < cv.w; x++) {
      const si = (y * cv.w + x) * 4, di = rowStart + 1 + x * 4;
      raw[di] = cv.data[si]; raw[di + 1] = cv.data[si + 1]; raw[di + 2] = cv.data[si + 2]; raw[di + 3] = cv.data[si + 3];
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- BMP encoding (24-bit RGB, bottom-up, no alpha -- NSIS sidebar/header bitmaps don't need it) ---
function encodeBMP(cv) {
  const rowSize = Math.ceil((cv.w * 3) / 4) * 4;
  const pixelArraySize = rowSize * cv.h;
  const buf = Buffer.alloc(54 + pixelArraySize);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // DIB header size (BITMAPINFOHEADER)
  buf.writeInt32LE(cv.w, 18);
  buf.writeInt32LE(cv.h, 22); // positive height = bottom-up row order
  buf.writeUInt16LE(1, 26); // color planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38); // ~72 DPI
  buf.writeInt32LE(2835, 42);
  let offset = 54;
  for (let y = cv.h - 1; y >= 0; y--) {
    for (let x = 0; x < cv.w; x++) {
      const si = (y * cv.w + x) * 4;
      buf[offset++] = cv.data[si + 2]; // B
      buf[offset++] = cv.data[si + 1]; // G
      buf[offset++] = cv.data[si]; // R
    }
    offset += rowSize - cv.w * 3; // row padding to a 4-byte boundary
  }
  return buf;
}

// --- App icon: 256x256, transparent background, dark badge + red ring + gold emblem ---
function buildIcon() {
  const cv = makeCanvas(256, 256);
  fillCircle(cv, 128, 128, 118, DARK);
  strokeCircle(cv, 128, 128, 118, 10, RED);
  strokeCircle(cv, 128, 128, 98, 3, GOLD);
  fillPolygonEvenOdd(cv, emblemPointsIn({ x: 63, y: 63, size: 130 }), GOLD);
  return cv;
}

// --- Installer sidebar: 164x314 (standard NSIS MUI welcome/finish page size) ---
function buildSidebar() {
  const cv = makeCanvas(164, 314);
  fillGradientRect(cv, 0, 0, 164, 314, BLACK, [26, 26, 26]);
  fillRect(cv, 0, 0, 6, 314, RED); // left accent stripe, matches the app panel's red left border
  fillCircle(cv, 82, 96, 54, DARK);
  strokeCircle(cv, 82, 96, 54, 6, RED);
  strokeCircle(cv, 82, 96, 44, 2, GOLD);
  // Box centered on the circle's own center (82,96), not offset to one corner -- size 64 leaves a
  // clean margin inside the radius-44 gold ring.
  fillPolygonEvenOdd(cv, emblemPointsIn({ x: 82 - 32, y: 96 - 32, size: 64 }), GOLD);
  fillRect(cv, 20, 190, 144, 193, GOLD); // thin accent lines, echoing the header's status-bar look
  fillRect(cv, 20, 210, 144, 212, [90, 76, 45]);
  return cv;
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePNG(buildIcon()));
fs.writeFileSync(path.join(buildDir, 'installerSidebar.bmp'), encodeBMP(buildSidebar()));
console.log('Wrote build/icon.png and build/installerSidebar.bmp');
