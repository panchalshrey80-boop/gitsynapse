#!/usr/bin/env node
/**
 * Applies the product icon and version metadata to the packaged Windows exe.
 *
 * Normally electron-builder does this by shelling out to rcedit through Wine,
 * which makes a Windows build impossible on a machine that has no Wine (and no
 * root to install it). resedit is a pure-TypeScript PE resource editor, so the
 * same branding is applied natively on any platform — reproducible, and with no
 * emulation layer in the build path.
 *
 * Usage: node scripts/brand-exe.cjs <path-to-exe> [--icon assets/icon.ico]
 */

const fs = require('node:fs');
const path = require('node:path');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

const pkg = require('../package.json');

const LANG_EN_US = 1033;

function parseArgs(argv) {
  const exePath = argv[0];
  if (!exePath) {
    console.error('usage: brand-exe.cjs <path-to-exe> [--icon <path.ico>]');
    process.exit(2);
  }
  const iconIndex = argv.indexOf('--icon');
  return {
    exePath: path.resolve(exePath),
    iconPath: path.resolve(iconIndex === -1 ? 'assets/icon.ico' : argv[iconIndex + 1]),
  };
}

function main() {
  const { exePath, iconPath } = parseArgs(process.argv.slice(2));

  for (const file of [exePath, iconPath]) {
    if (!fs.existsSync(file)) {
      console.error(`missing: ${file}`);
      process.exit(1);
    }
  }

  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);

  // --- Icon ---------------------------------------------------------------
  const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
  // 1 = the first icon group. Electron's exe ships a single group, so this
  // replaces the default Electron icon outright rather than adding a second.
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    1,
    LANG_EN_US,
    iconFile.icons.map((icon) => icon.data),
  );

  // --- Version metadata ----------------------------------------------------
  const version = pkg.version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const versionInfo = Resource.VersionInfo.fromEntries(resources.entries)[0]
    || Resource.VersionInfo.createEmpty();

  versionInfo.setFileVersion(version[0], version[1], version[2], 0);
  versionInfo.setProductVersion(version[0], version[1], version[2], 0);

  versionInfo.setStringValues({ lang: LANG_EN_US, codepage: 1200 }, {
    ProductName: 'GitSynapse',
    FileDescription: 'GitSynapse — a Git client with an AI copilot',
    CompanyName: pkg.author?.name || 'GitSynapse',
    LegalCopyright: `Copyright © ${new Date().getFullYear()} GitSynapse`,
    OriginalFilename: path.basename(exePath),
    InternalName: 'GitSynapse',
    ProductVersion: pkg.version,
    FileVersion: pkg.version,
  });

  versionInfo.outputToResourceEntries(resources.entries);
  resources.outputResource(exe);

  const branded = Buffer.from(exe.generate());
  fs.writeFileSync(exePath, branded);

  console.log(
    `branded ${path.relative(process.cwd(), exePath)} `
    + `(icon: ${iconFile.icons.length} sizes, version ${pkg.version}, ${(branded.length / 1024 / 1024).toFixed(1)} MB)`,
  );
}

main();
