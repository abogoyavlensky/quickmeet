// Writes the app's raster icons into resources/public: the two the web app
// manifest names, the one iOS puts on the home screen, and favicon.ico for
// the browsers that take no SVG (Safari) and for the /favicon.ico they ask
// for on their own. The shapes mirror icon.svg: a #111312 square and a
// #45c285 disc in its middle, a radius of 7/32 of the side. The home-screen
// icons are full-bleed squares, because Android and iOS cut their own
// corners; the favicon keeps icon.svg's rounded ones. Pure Node, nothing to
// install, and the same bytes on every run. `lgx icons` runs this.
import { writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';

const out = new URL('../resources/public/', import.meta.url);
const SQUARE = [0x11, 0x13, 0x12];
const DISC = [0x45, 0xc2, 0x85];
// Each pixel is the average of an n x n grid of samples, so the disc and
// the corners have soft edges.
const n = 4;

// RGBA, row by row. `rounded`: corners of radius 8/32 of the side,
// transparent outside them.
function draw(size, { rounded = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2, disc = size * 7 / 32, corner = rounded ? size * 8 / 32 : 0;
  // Whether (x, y) lies inside the square with its corners cut round.
  const inSquare = (x, y) => {
    const dx = Math.max(corner - x, x - (size - corner), 0);
    const dy = Math.max(corner - y, y - (size - corner), 0);
    return dx * dx + dy * dy <= corner * corner;
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = px + (sx + 0.5) / n, y = py + (sy + 0.5) / n;
          if (!inSquare(x, y)) continue;
          const color = (x - c) ** 2 + (y - c) ** 2 <= disc * disc ? DISC : SQUARE;
          covered++; r += color[0]; g += color[1]; b += color[2];
        }
      }
      const i = (py * size + px) * 4;
      if (covered) {
        rgba[i] = Math.round(r / covered);
        rgba[i + 1] = Math.round(g / covered);
        rgba[i + 2] = Math.round(b / covered);
      }
      rgba[i + 3] = Math.round(covered * 255 / (n * n));
    }
  }
  return rgba;
}

// A PNG: the signature, then IHDR (8-bit RGBA), one IDAT of the rows (each
// behind filter byte 0) and IEND, every chunk with its CRC-32.
function png(rgba, size) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;  // bits per channel
  header[9] = 6;  // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// An ICO holding one PNG: a 6-byte header, one 16-byte directory entry,
// then the PNG itself. Every current browser reads PNG inside ICO.
function ico(image, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);   // reserved
  head.writeUInt16LE(1, 2);   // an icon
  head.writeUInt16LE(1, 4);   // one image
  head[6] = size; head[7] = size;
  head.writeUInt16LE(1, 10);  // colour planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(image.length, 14);
  head.writeUInt32LE(22, 18); // where the image starts
  return Buffer.concat([head, image]);
}

const files = {
  'icon-192.png': png(draw(192), 192),
  'icon-512.png': png(draw(512), 512),
  'apple-touch-icon.png': png(draw(180), 180),
  'favicon.ico': ico(png(draw(32, { rounded: true }), 32), 32),
};
for (const [name, bytes] of Object.entries(files)) {
  await writeFile(new URL(name, out), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
