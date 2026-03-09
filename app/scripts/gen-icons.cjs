/* gen-icons.cjs — creates app icons (PNG + ICO) for Tauri build */
'use strict';
const { deflateSync } = require('zlib');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const ICONS_DIR = join(__dirname, '..', 'src-tauri', 'icons');
mkdirSync(ICONS_DIR, { recursive: true });

// Brand colors
const ACCENT   = [88, 101, 242];   // #5865F2 indigo
const ACCENT_L = [99, 114, 255];   // lighter top
const WHITE    = [255, 255, 255];

// ── CRC32 ────────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td  = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cc  = Buffer.alloc(4); cc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cc]);
}

// ── Draw helpers ─────────────────────────────────────────
function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inRoundedRect(x, y, rx, ry, rw, rh, cr) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  // corner zones
  const corners = [
    [rx + cr,      ry + cr],
    [rx + rw - cr, ry + cr],
    [rx + cr,      ry + rh - cr],
    [rx + rw - cr, ry + rh - cr],
  ];
  for (const [cx, cy] of corners) {
    if (x < cx - cr || x > cx + (cr * 2 - (cx - rx < cr ? cx - rx : rw - (cx - rx))) ) { /* skip */ }
    if (Math.abs(x - cx) >= cr && Math.abs(y - cy) >= cr) {
      // strictly in the corner square but not in the circle
      if (x < rx + cr || x > rx + rw - cr) {
        if (y < ry + cr || y > ry + rh - cr) {
          // find which corner
          const nearX = x < rx + rw / 2 ? rx + cr : rx + rw - cr;
          const nearY = y < ry + rh / 2 ? ry + cr : ry + rh - cr;
          return inCircle(x, y, nearX, nearY, cr);
        }
      }
    }
  }
  return true;
}

function roundedRect(px, x, y, size, cr) {
  const get = (rx, ry) => {
    if (rx < 0 || ry < 0 || rx >= size || ry >= size) return false;
    if (rx >= x && rx <= x + size - 1 && ry >= y && ry <= y + size - 1) {
      const lx = rx - x, ly = ry - y; const s = size - 1;
      if (lx < cr && ly < cr) return inCircle(lx, ly, cr, cr, cr);
      if (lx > s - cr && ly < cr) return inCircle(lx, ly, s - cr, cr, cr);
      if (lx < cr && ly > s - cr) return inCircle(lx, ly, cr, s - cr, cr);
      if (lx > s - cr && ly > s - cr) return inCircle(lx, ly, s - cr, s - cr, cr);
      return true;
    }
    return false;
  };
  return get;
}

// ── Chat bubble icon ──────────────────────────────────────
// Draws a rounded-square background with a speech bubble shape inside
function createPNG(size) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA

  const pad   = Math.round(size * 0.08);
  const bgR   = Math.round(size * 0.18); // bg corner radius

  // Bubble body
  const bx    = Math.round(size * 0.12);
  const by    = Math.round(size * 0.10);
  const bw    = Math.round(size * 0.76);
  const bh    = Math.round(size * 0.62);
  const bcr   = Math.round(size * 0.14);

  // Bubble tail triangle (bottom-left)
  const tailTipX = Math.round(size * 0.18);
  const tailTipY = Math.round(size * 0.88);
  const tailBase1X = Math.round(size * 0.12);
  const tailBase1Y = Math.round(size * 0.64);
  const tailBase2X = Math.round(size * 0.36);
  const tailBase2Y = Math.round(size * 0.72);

  // Dot positions (three dots inside bubble)
  const dotY   = by + Math.round(bh * 0.5);
  const dotR   = Math.round(size * 0.065);
  const dotSpacing = Math.round(size * 0.195);
  const dotsStartX = bx + Math.round(bw * 0.18);
  const dots = [
    [dotsStartX, dotY],
    [dotsStartX + dotSpacing, dotY],
    [dotsStartX + dotSpacing * 2, dotY],
  ];

  function inTail(px, py) {
    // Point in triangle test
    const v0x = tailBase2X - tailBase1X, v0y = tailBase2Y - tailBase1Y;
    const v1x = tailTipX - tailBase1X,   v1y = tailTipY - tailBase1Y;
    const v2x = px - tailBase1X,         v2y = py - tailBase1Y;
    const d00 = v0x*v0x + v0y*v0y;
    const d01 = v0x*v1x + v0y*v1y;
    const d11 = v1x*v1x + v1y*v1y;
    const d02 = v0x*v2x + v0y*v2y;
    const d12 = v1x*v2x + v1y*v2y;
    const inv = 1 / (d00*d11 - d01*d01);
    const u = (d11*d02 - d01*d12) * inv;
    const v = (d00*d12 - d01*d02) * inv;
    return u >= 0 && v >= 0 && u + v <= 1;
  }

  function inBubble(px, py) {
    // Rounded rect body
    if (px >= bx && px <= bx + bw && py >= by && py <= by + bh) {
      const lx = px - bx, ly = py - by; const sw = bw, sh = bh;
      if (lx < bcr && ly < bcr) return inCircle(lx, ly, bcr, bcr, bcr);
      if (lx > sw-bcr && ly < bcr) return inCircle(lx, ly, sw-bcr, bcr, bcr);
      if (lx < bcr && ly > sh-bcr) return inCircle(lx, ly, bcr, sh-bcr, bcr);
      if (lx > sw-bcr && ly > sh-bcr) return inCircle(lx, ly, sw-bcr, sh-bcr, bcr);
      return true;
    }
    return inTail(px, py);
  }

  function inBackground(px, py) {
    const s = size - 1;
    if (px < bgR && py < bgR) return inCircle(px, py, bgR, bgR, bgR);
    if (px > s-bgR && py < bgR) return inCircle(px, py, s-bgR, bgR, bgR);
    if (px < bgR && py > s-bgR) return inCircle(px, py, bgR, s-bgR, bgR);
    if (px > s-bgR && py > s-bgR) return inCircle(px, py, s-bgR, s-bgR, bgR);
    return px >= 0 && px <= s && py >= 0 && py <= s;
  }

  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) {
      if (!inBackground(x, y)) {
        raw.push(0, 0, 0, 0);
        continue;
      }
      // Gradient bg
      const t = y / size;
      const [r0,g0,b0] = ACCENT_L, [r1,g1,b1] = ACCENT;
      const bgR_ = Math.round(r0 + (r1-r0)*t);
      const bgG_ = Math.round(g0 + (g1-g0)*t);
      const bgB_ = Math.round(b0 + (b1-b0)*t);

      if (inBubble(x, y)) {
        // Check dots
        let isDot = false;
        for (const [dx, dy] of dots) {
          if (inCircle(x, y, dx, dy, dotR)) { isDot = true; break; }
        }
        if (isDot) {
          raw.push(bgR_, bgG_, bgB_, 255); // dots = bg color (cutout effect)
        } else {
          raw.push(255, 255, 255, 255); // white bubble
        }
      } else {
        raw.push(bgR_, bgG_, bgB_, 255);
      }
    }
  }

  const compressed = deflateSync(Buffer.from(raw), { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO ──────────────────────────────────────────────────
function createICO(images) {
  const count = images.length;
  const headerSize = 6 + count * 16;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  let offset = headerSize;
  const entries = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

// ── Generate ──────────────────────────────────────────────
console.log('Generating icons...');
const png32  = createPNG(32);
const png128 = createPNG(128);
const png256 = createPNG(256);
const png512 = createPNG(512);

writeFileSync(join(ICONS_DIR, '32x32.png'),        png32);
writeFileSync(join(ICONS_DIR, '128x128.png'),      png128);
writeFileSync(join(ICONS_DIR, '128x128@2x.png'),   png256);
writeFileSync(join(ICONS_DIR, 'icon.png'),         png512);

const ico = createICO([
  { size: 16,  data: createPNG(16) },
  { size: 32,  data: png32 },
  { size: 48,  data: createPNG(48) },
  { size: 256, data: png256 },
]);
writeFileSync(join(ICONS_DIR, 'icon.ico'), ico);

console.log('Done → ' + ICONS_DIR);


const R = 88, G = 101, B = 242; // #5865F2

// ── CRC32 ───────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

// ── PNG chunk builder ───────────────────────────────────
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crcBuf]);
}

// ── Create RGBA PNG with rounded-square icon ────────────
function createPNG(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const raw = [];
  const center = size / 2;
  const radius = size * 0.42;
  const corner = size * 0.15;

  for (let y = 0; y < size; y++) {
    raw.push(0); // row filter: none
    for (let x = 0; x < size; x++) {
      const ax = Math.abs(x - center);
      const ay = Math.abs(y - center);

      // Rounded rectangle test
      let inside;
      if (ax <= radius - corner && ay <= radius) inside = true;
      else if (ax <= radius && ay <= radius - corner) inside = true;
      else {
        const cdx = ax - (radius - corner);
        const cdy = ay - (radius - corner);
        inside = cdx * cdx + cdy * cdy <= corner * corner;
      }

      if (inside) {
        // Subtle vertical gradient (lighter at top)
        const t = y / size;
        const rr = Math.min(255, R + Math.round((1 - t) * 30));
        const gg = Math.min(255, G + Math.round((1 - t) * 20));
        const bb = Math.min(255, B + Math.round((1 - t) * 10));
        raw.push(rr, gg, bb, 255);
      } else {
        raw.push(0, 0, 0, 0);
      }
    }
  }

  const compressed = deflateSync(Buffer.from(raw), { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Create ICO (embeds PNGs) ────────────────────────────
function createICO(images) {
  const count = images.length;
  const headerSize = 6 + count * 16;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // ICO type
  header.writeUInt16LE(count, 4);

  let offset = headerSize;
  const entries = [];

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);             // planes
    entry.writeUInt16LE(32, 6);            // bpp
    entry.writeUInt32LE(data.length, 8);   // data size
    entry.writeUInt32LE(offset, 12);       // data offset
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ── Generate all needed icons ───────────────────────────
console.log('Generating icons...');

const png32 = createPNG(32);
const png128 = createPNG(128);
const png256 = createPNG(256);

writeFileSync(join(ICONS_DIR, '32x32.png'), png32);
writeFileSync(join(ICONS_DIR, '128x128.png'), png128);
writeFileSync(join(ICONS_DIR, '128x128@2x.png'), png256);

const ico = createICO([
  { size: 32, data: png32 },
  { size: 256, data: png256 },
]);
writeFileSync(join(ICONS_DIR, 'icon.ico'), ico);

console.log('Done → ' + ICONS_DIR);
console.log('For macOS .icns, run: npx tauri icon icons/128x128@2x.png');
