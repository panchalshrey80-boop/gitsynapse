#!/usr/bin/env node
/**
 * Builds assets/icon.ico from the same vector source as the PNG icon.
 *
 * Classic BMP-format ICO entries are emitted rather than PNG-compressed ones:
 * NSIS and Windows' shell both read those reliably at every size, whereas
 * PNG-in-ICO support varies by tool and by Windows version.
 *
 * Sizes follow Microsoft's guidance — 16 and 32 for the shell, 48 for Explorer,
 * 256 for the large-icon view.
 *
 * @see docs: https://learn.microsoft.com/windows/win32/winprog/using-the-windows-shell
 */

import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ICON_SVG } from './build-icon.js';

const OUT_DIR = path.resolve('assets');
const OUT = path.join(OUT_DIR, 'icon.ico');
const SIZES = [256, 128, 64, 48, 32, 16];

/**
 * Turns RGBA pixels into a 32-bit bottom-up DIB with the trailing AND mask
 * that the ICO format requires (unused for 32-bit entries but still expected).
 *
 * @param {Buffer} rgba  width*height*4 bytes, top-down
 * @param {number} size
 */
function toDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);        // biSize
  header.writeInt32LE(size, 4);       // biWidth
  header.writeInt32LE(size * 2, 8);   // biHeight: image + mask
  header.writeUInt16LE(1, 12);        // biPlanes
  header.writeUInt16LE(32, 14);       // biBitCount
  header.writeUInt32LE(0, 16);        // biCompression: BI_RGB
  header.writeUInt32LE(size * size * 4, 20);
  // Remaining fields (resolution, palette) stay zero, which is standard.

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = y * size * 4;
    const targetRow = (size - 1 - y) * size * 4; // DIB rows run bottom-up.
    for (let x = 0; x < size; x += 1) {
      const s = sourceRow + x * 4;
      const t = targetRow + x * 4;
      pixels[t] = rgba[s + 2];     // B
      pixels[t + 1] = rgba[s + 1]; // G
      pixels[t + 2] = rgba[s];     // R
      pixels[t + 3] = rgba[s + 3]; // A
    }
  }

  // AND mask: 1 bit per pixel, rows padded to 4 bytes. Fully opaque everywhere,
  // so the alpha channel above is what the shell actually uses.
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size, 0);

  return Buffer.concat([header, pixels, mask]);
}

function renderRgba(svg, size) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  }).render();
  return Buffer.from(rendered.pixels);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const images = SIZES.map((size) => ({ size, dib: toDib(renderRgba(ICON_SVG, size), size) }));

  const directory = Buffer.alloc(6);
  directory.writeUInt16LE(0, 0);              // reserved
  directory.writeUInt16LE(1, 2);              // type: icon
  directory.writeUInt16LE(images.length, 4);  // image count

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, dib } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);                      // palette colours
    entry.writeUInt8(0, 3);                      // reserved
    entry.writeUInt16LE(1, 4);                   // colour planes
    entry.writeUInt16LE(32, 6);                  // bits per pixel
    entry.writeUInt32LE(dib.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += dib.length;
  }

  fs.writeFileSync(OUT, Buffer.concat([directory, ...entries, ...images.map((image) => image.dib)]));

  const stats = fs.statSync(OUT);
  console.log(
    `wrote ${path.relative(process.cwd(), OUT)} (${(stats.size / 1024).toFixed(1)} KB, `
    + `${images.length} sizes: ${SIZES.join(', ')})`,
  );
}

main();
