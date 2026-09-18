#!/usr/bin/env node
/**
 * Renders the application icon from vector source.
 *
 * Uses resvg (a Rust SVG renderer with prebuilt binaries) rather than a headless
 * browser: it starts in milliseconds, has no system library dependencies, and
 * produces identical output on any machine — which matters because this file
 * feeds the Windows installer's icon.
 *
 * Output: assets/icon.png — 1024x1024, transparent outside the rounded plate.
 *
 * Note: assets/ is deliberate. electron-builder's default `build/` directory is
 * excluded from workspace snapshots in some environments, which silently loses
 * the icon between sessions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const SIZE = 1024;
const OUT_DIR = path.resolve('assets');
const OUT = path.join(OUT_DIR, 'icon.png');

/**
 * The mark: two commits on one branch that rejoin at a merge commit.
 * Kept in sync with the title-bar logo in src/renderer/index.html.
 */
export const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1c22"/>
      <stop offset="1" stop-color="#0a0a0d"/>
    </linearGradient>
  </defs>

  <rect x="48" y="48" width="928" height="928" rx="212" fill="url(#plate)"/>
  <rect x="48" y="48" width="928" height="928" rx="212" fill="none"
        stroke="#2c2c34" stroke-width="8"/>

  <g fill="none" stroke="#f4f4f5" stroke-width="40" stroke-linecap="round">
    <path d="M356 356 V 668"/>
    <path d="M356 356 H 512 Q 668 356 668 476"/>
    <path d="M356 668 H 512 Q 668 668 668 548"/>
  </g>

  <circle cx="356" cy="356" r="84" fill="#f4f4f5"/>
  <circle cx="356" cy="668" r="84" fill="#f4f4f5"/>
  <circle cx="668" cy="512" r="84" fill="#5b9dff"/>
</svg>`;

/** Renders an SVG string to a PNG buffer at the given width. */
export function renderPng(svg, width = SIZE) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const png = renderPng(ICON_SVG);
  fs.writeFileSync(OUT, png);

  // Also emit a small copy for in-app use and a 256px variant, which is the
  // size Windows actually shows in Explorer's large-icon view.
  fs.writeFileSync(path.join(OUT_DIR, 'icon-256.png'), renderPng(ICON_SVG, 256));

  const stats = fs.statSync(OUT);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(stats.size / 1024).toFixed(1)} KB, ${SIZE}x${SIZE})`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
