#!/usr/bin/env node
/**
 * Builds the Windows installer, `GitSynapse-setup.exe`.
 *
 * One command, two strategies:
 *
 *   On Windows   electron-builder drives the whole thing — package, brand,
 *                NSIS. Nothing extra needed.
 *
 *   Everywhere   electron-builder is asked only for the unpacked app directory
 *                (`--dir`), which is pure Node and needs no emulation. The exe is
 *                then branded with resedit (a pure-JS PE editor) and wrapped by
 *                makensis. electron-builder's NSIS target is skipped because it
 *                shells out to rcedit through Wine, which is a hard requirement
 *                we can avoid entirely rather than work around.
 *
 * Usage:
 *   npm run dist:win
 *   node scripts/build-windows.js --skip-package     # reuse release/win-unpacked
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const APP_DIR = path.join(root, 'release', 'win-unpacked');
const OUT_FILE = path.join(root, 'release', 'GitSynapse-setup.exe');
const ICON_ICO = path.join(root, 'assets', 'icon.ico');
const NSI = path.join(root, 'installer', 'gitsynapse.nsi');

const args = process.argv.slice(2);
const skipPackage = args.includes('--skip-package');

function step(message) {
  console.log(`\n\x1b[1m▸ ${message}\x1b[0m`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status}`);
  }
}

/** Locates a native makensis, preferring electron-builder's own download. */
function findMakensis() {
  if (process.platform === 'win32') {
    // electron-builder installs its NSIS copy here on Windows.
    const bundled = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis');
    if (fs.existsSync(bundled)) {
      for (const dir of fs.readdirSync(bundled)) {
        const candidate = path.join(bundled, dir, 'Bin', 'makensis.exe');
        if (fs.existsSync(candidate)) return { binary: candidate, nsisDir: path.join(bundled, dir) };
      }
    }
    const onPath = spawnSync('where', ['makensis'], { encoding: 'utf8' });
    if (onPath.status === 0) return { binary: onPath.stdout.split('\n')[0].trim(), nsisDir: '' };
    return null;
  }

  const cacheRoot = path.join(os.homedir(), '.cache', 'electron-builder', 'nsis');
  if (fs.existsSync(cacheRoot)) {
    for (const dir of fs.readdirSync(cacheRoot)) {
      const base = path.join(cacheRoot, dir);
      for (const flavour of ['linux', 'mac']) {
        const candidate = path.join(base, flavour, 'makensis');
        if (fs.existsSync(candidate)) return { binary: candidate, nsisDir: base };
      }
      const candidate = path.join(base, 'Bin', 'makensis');
      if (fs.existsSync(candidate)) return { binary: candidate, nsisDir: base };
    }
  }

  const onPath = spawnSync('which', ['makensis'], { encoding: 'utf8' });
  if (onPath.status === 0) return { binary: onPath.stdout.trim(), nsisDir: '' };

  return null;
}

/**
 * Writes the `.sha256` sidecar next to the installer.
 *
 * An unsigned download is indistinguishable from a tampered one by eye, so the
 * hash is produced by the build rather than by hand afterwards — a hash that
 * depends on remembering a command is a hash that eventually goes missing.
 *
 * @returns {string} the hex digest, for logging
 */
function writeChecksum() {
  const digest = createHash('sha256').update(fs.readFileSync(OUT_FILE)).digest('hex');
  const sidecar = `${OUT_FILE}.sha256`;

  // `sha256sum -c` compatible: digest, two spaces, filename (no directory, so
  // the file verifies from wherever it was downloaded to).
  fs.writeFileSync(sidecar, `${digest}  ${path.basename(OUT_FILE)}\n`);
  return digest;
}

function describeResult() {
  const stats = fs.statSync(OUT_FILE);
  const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
  const digest = writeChecksum();

  console.log(`\n\x1b[32m✓ Built ${path.relative(root, OUT_FILE)} (${sizeMb} MB)\x1b[0m`);
  console.log(`  sha256:    ${digest}`);
  console.log(`  sidecar:   ${path.relative(root, `${OUT_FILE}.sha256`)}`);
  console.log('  Installer: per-user by default ($LOCALAPPDATA\\Programs\\GitSynapse), no admin required.');
  console.log('  Verify:    7z t release/GitSynapse-setup.exe   (checks every embedded file)');
}

function main() {
  const onWindows = process.platform === 'win32';

  let nsis = onWindows ? null : findMakensis();

  step(`Packaging the Windows app (${pkg.version})`);
  if (skipPackage && fs.existsSync(path.join(APP_DIR, 'GitSynapse.exe'))) {
    console.log('  reusing release/win-unpacked');
  } else if (skipPackage) {
    throw new Error('--skip-package was given but release/win-unpacked/GitSynapse.exe is missing.');
  } else if (!onWindows && !nsis) {
    // Bootstrap: running electron-builder's own NSIS target downloads NSIS into
    // its cache before failing on the Wine step. That one pass therefore gives
    // us both the unpacked app *and* a local makensis, so it is not wasted work.
    console.log('  makensis not found — fetching it via electron-builder (its Wine step will fail, which is expected)');
    spawnSync('npx', ['electron-builder', '--win', '--x64'], { stdio: 'inherit', cwd: root });
    nsis = findMakensis();
    if (!fs.existsSync(path.join(APP_DIR, 'GitSynapse.exe'))) {
      run('npx', ['electron-builder', '--win', '--x64', '--dir']);
    }
  } else {
    fs.rmSync(APP_DIR, { recursive: true, force: true });
    // `--dir` stops before the NSIS target, which is the only Wine-dependent step.
    run('npx', ['electron-builder', '--win', '--x64', '--dir']);
  }

  step('Branding the executable (icon + version metadata)');
  let brandArgs = [path.join(root, 'scripts', 'brand-exe.cjs'), path.join(APP_DIR, 'GitSynapse.exe')];
  if (fs.existsSync(ICON_ICO)) brandArgs = [...brandArgs, '--icon', ICON_ICO];
  if (!fs.existsSync(ICON_ICO)) {
    console.log('  assets/icon.ico is missing — run `npm run build:icons` first.');
  }
  run('node', brandArgs);

  step('Building the installer');

  if (onWindows) {
    // Native Windows: electron-builder's own NSIS pipeline works without Wine
    // and produces the same artifact, so use it rather than duplicating it.
    run('npx', [
      'electron-builder', '--win', '--x64',
      '-c.win.signAndEditExecutable=false',
      `-c.win.artifactName=${path.basename(OUT_FILE)}`,
    ]);
  } else {
    if (!nsis) {
      console.error(
        '\nCould not find makensis. Install NSIS (apt install nsis, or brew install makensis)\n'
        + 'or run this command once so electron-builder downloads its own copy:\n'
        + '  npx electron-builder --win --x64 --dir\n',
      );
      process.exit(1);
    }

    console.log(`  using ${nsis.binary}`);
    run(nsis.binary, [
      '-V3',
      `-DAPP_DIR=${APP_DIR}`,
      `-DOUT_FILE=${OUT_FILE}`,
      `-DAPP_VERSION=${pkg.version}`,
      `-DICON_FILE=${ICON_ICO}`,
      NSI,
    ], { env: { ...process.env, NSISDIR: nsis.nsisDir || process.env.NSISDIR || '' } });
  }

  describeResult();
}

try {
  main();
} catch (error) {
  console.error(`\n\x1b[31mBuild failed: ${error.message}\x1b[0m`);
  process.exit(1);
}
