/* gen-icons.cjs — creates app icons (PNG + ICO) for Tauri build */
'use strict';
const { deflateSync } = require('zlib');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const ICONS_DIR = join(__dirname, '..', 'src-tauri', 'icons');
mkdirSync(ICONS_DIR, { recursive: true });

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
