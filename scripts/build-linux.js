#!/usr/bin/env node
/**
 * Builds the Linux release artifacts: AppImage, .deb and tar.gz.
 *
 * Unlike the Windows build, this one needs no workaround — electron-builder
 * drives the whole thing, including the AppImage runtime and the deb metadata,
 * with its own binaries. It can run on Linux, macOS and Windows (the packaging
 * is arch-independent; only the target runtime differs).
 *
 * Usage:
 *   npm run dist:linux
 *   node scripts/build-linux.js --dir        # unpacked app only, for testing
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');
const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');

const args = process.argv.slice(2);
const dirOnly = args.includes('--dir');

function step(message) {
  console.log(`\n\x1b[1m▸ ${message}\x1b[0m`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function main() {
  if (!fs.existsSync(builder)) {
    console.error('electron-builder is not installed — run `npm install` first.');
    process.exit(1);
  }

  step(`Packaging GitSynapse ${pkg.version} for Linux`);
  run(builder, ['--linux', '--x64', ...(dirOnly ? ['--dir'] : [])]);

  if (dirOnly) {
    console.log(`\n\x1b[32m✓ Unpacked app: release/linux-unpacked\x1b[0m`);
    return;
  }

  const artifacts = fs.readdirSync(releaseDir)
    .filter((file) => /^GitSynapse-.*(\.AppImage|\.deb|\.tar\.gz)$/.test(file))
    .sort();

  console.log('');
  for (const file of artifacts) {
    const sizeMb = (fs.statSync(path.join(releaseDir, file)).size / 1024 / 1024).toFixed(1);
    const digest = sha256(path.join(releaseDir, file));
    fs.writeFileSync(path.join(releaseDir, `${file}.sha256`), `${digest}  ${file}\n`);
    console.log(`\x1b[32m✓\x1b[0m ${file}  \x1b[2m(${sizeMb} MB)\x1b[0m`);
  }

  console.log('\n  Install:');
  console.log('    AppImage   chmod +x GitSynapse-*.AppImage && ./GitSynapse-*.AppImage');
  console.log('    deb        sudo apt install ./GitSynapse-*-amd64.deb');
  console.log('    tar.gz     tar -xzf GitSynapse-*-x64.tar.gz && ./GitSynapse-*/gitsynapse');
  console.log('  Needs:       git on PATH, plus a desktop session (GTK 3).');
}

try {
  main();
} catch (error) {
  console.error(`\n\x1b[31mlinux build failed:\x1b[0m ${error.message}`);
  process.exit(1);
}
