#!/usr/bin/env node
/**
 * Builds the macOS release artifacts: a `.app` in a zip, for Intel and Apple
 * Silicon, and a `.dmg` when this runs on a Mac.
 *
 * Two things are worth knowing before reading the output:
 *
 *   1. `electron-builder` can assemble a *complete, correctly structured* .app
 *      bundle on Linux — it downloads the darwin Electron runtime and brands
 *      the bundle itself. What it cannot do outside macOS is **sign** it, since
 *      codesign is a macOS tool. So the zip produced here is unsigned, and users
 *      have to clear the quarantine flag once (see below).
 *
 *   2. The `.dmg` target genuinely requires macOS (`hdiutil`), and so does
 *      notarization. On a Mac this script also builds the dmg; elsewhere it says
 *      so plainly instead of failing halfway.
 *
 * To produce a signed build on a Mac you need a Developer ID certificate in the
 * keychain (or CSC_LINK/CSC_KEY_PASSWORD pointing at one). This script does not
 * disable signing by default: if a certificate is present, electron-builder
 * finds it and signs. Pass --unsigned to explicitly skip that.
 *
 * Usage:
 *   npm run dist:mac
 *   npm run dist:mac -- --unsigned     # force an unsigned build
 *   npm run dist:mac -- --dir          # unpacked .app only
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
const onMac = process.platform === 'darwin';
const forceUnsigned = args.includes('--unsigned');
const dirOnly = args.includes('--dir');

function step(message) {
  console.log(`\n\x1b[1m▸ ${message}\x1b[0m`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (!fs.existsSync(builder)) {
    console.error('electron-builder is not installed — run `npm install` first.');
    process.exit(1);
  }

  const canSign = onMac && !forceUnsigned
    && Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

  // Without a certificate, don't let electron-builder hunt for one: a failed
  // signing attempt aborts the build well after the slow packaging step.
  const env = { ...process.env };
  if (!canSign) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

  // dmg creation is macOS-only, so the target list depends on where this runs.
  // electron-builder reads targets as the arguments immediately after the
  // platform flag, so they must come before the architecture flags — 'zip'
  // after them is rejected as an unknown argument.
  const targets = [onMac ? 'dmg' : null, 'zip'].filter(Boolean);

  step(`Packaging GitSynapse ${pkg.version} for macOS (x64 + arm64)`);
  if (!onMac) {
    console.log('  not on macOS: building zips only — signing and dmg need a Mac');
  }

  const commandArgs = dirOnly
    ? ['--mac', '--x64', '--arm64', '--dir']
    : ['--mac', ...targets, '--x64', '--arm64'];

  const result = spawnSync(builder, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`electron-builder exited ${result.status}`);

  if (dirOnly) {
    console.log(`\n\x1b[32m✓ Unpacked app: release/mac/GitSynapse.app\x1b[0m`);
    return;
  }

  const artifacts = fs.readdirSync(releaseDir)
    .filter((file) => /^GitSynapse-.*\.(zip|dmg)$/.test(file))
    .sort();

  const signed = canSign;
  console.log('');
  for (const file of artifacts) {
    const sizeMb = (fs.statSync(path.join(releaseDir, file)).size / 1024 / 1024).toFixed(1);
    const digest = sha256(path.join(releaseDir, file));
    fs.writeFileSync(path.join(releaseDir, `${file}.sha256`), `${digest}  ${file}\n`);
    console.log(`\x1b[32m✓\x1b[0m ${file}  \x1b[2m(${sizeMb} MB)\x1b[0m`);
  }

  console.log(`\n  Signed:      ${signed ? 'yes' : '\x1b[33mno\x1b[0m — Gatekeeper will warn on first launch'}`);

  if (!signed) {
    console.log('\n  What users will see, and the two ways round it:');
    console.log('    * Right-click the app → Open → Open. (Once per machine.)');
    console.log('    * Or from a terminal, if the zip was downloaded:');
    console.log('        xattr -dr com.apple.quarantine /Applications/GitSynapse.app');
    console.log('\n  To ship a warning-free build you need an Apple Developer ID');
    console.log('  certificate and notarization, which must be done on macOS:');
    console.log('    1. Add the certificate to the keychain (or set CSC_LINK and');
    console.log('       CSC_KEY_PASSWORD), then re-run this script on a Mac.');
    console.log('    2. Notarize with `xcrun notarytool submit` and staple the result');
    console.log('       (`xcrun stapler staple GitSynapse.app`). See RELEASE.md.');
  }

  console.log('\n  Requires git on PATH; the app itself needs macOS 10.15 or later.');
}

try {
  main();
} catch (error) {
  console.error(`\n\x1b[31mmacos build failed:\x1b[0m ${error.message}`);
  process.exit(1);
}
