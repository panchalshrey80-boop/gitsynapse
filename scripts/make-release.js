#!/usr/bin/env node
/**
 * Assembles the release: one folder holding every platform's installer, the
 * source archives, and the checksums that go with them.
 *
 * Slow work (packaging Electron for three platforms) belongs to the `dist:*`
 * scripts. This one only organises what they produced, so it can be re-run as
 * often as the notes or the checksums need regenerating.
 *
 * Usage:
 *   npm run release
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');
const outDir = path.join(releaseDir, `v${pkg.version}`);

/**
 * Where each build's output should end up in the release.
 *
 * The Windows installer keeps its short name while it is being built (the NSIS
 * script and the README both refer to it), and is renamed here so that every
 * file a user might download out of context says which platform and
 * architecture it belongs to.
 */
const LAYOUT = [
  { source: 'GitSynapse-setup.exe', target: `GitSynapse-${pkg.version}-Windows-x64-Setup.exe`, platform: 'Windows' },
  { source: `GitSynapse-${pkg.version}-macOS-arm64.zip`, platform: 'macOS (Apple Silicon)' },
  { source: `GitSynapse-${pkg.version}-macOS-x64.zip`, platform: 'macOS (Intel)' },
  { source: `GitSynapse-${pkg.version}-Linux-x86_64.AppImage`, platform: 'Linux (portable)' },
  { source: `GitSynapse-${pkg.version}-Linux-amd64.deb`, platform: 'Linux (Debian/Ubuntu)' },
  { source: `GitSynapse-${pkg.version}-Linux-x64.tar.gz`, platform: 'Linux (archive)' },
];

function step(message) {
  console.log(`\n\x1b[1m▸ ${message}\x1b[0m`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Packages the source tree, excluding anything generated or installed. */
function packSource() {
  const name = `GitSynapse-${pkg.version}-Source`;
  const excluded = ['node_modules', 'release', '.git', '.cache'];

  const tarPath = path.join(outDir, `${name}.tar.gz`);
  const tarResult = spawnSync('tar', [
    '--exclude=node_modules', '--exclude=release', '--exclude=.git',
    '--exclude=.cache', '--exclude=.verify',
    '-czf', tarPath, '-C', root, '.',
  ], { stdio: 'pipe', encoding: 'utf8' });
  if (tarResult.status !== 0) throw new Error(`tar failed: ${tarResult.stderr}`);

  const zipPath = path.join(outDir, `${name}.zip`);
  const zipResult = spawnSync('zip', [
    '-q', '-r', zipPath, '.',
    '-x', 'node_modules/*', '-x', 'release/*', '-x', '.git/*', '-x', '.cache/*',
  ], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  if (zipResult.status !== 0) throw new Error(`zip failed: ${zipResult.stderr}`);

  return { tarPath, zipPath, excluded };
}

function writeReleaseNotes(entries, source) {
  const rows = entries.map((entry) => {
    const sizeMb = (fs.statSync(entry.file).size / 1024 / 1024).toFixed(1);
    return `| \`${path.basename(entry.file)}\` | ${entry.platform} | ${sizeMb} MB |`;
  }).join('\n');

  const notes = `# GitSynapse ${pkg.version}

${pkg.description}

Every artifact below was unpacked and its bundled server started as part of
\`npm run verify:release\`, so what is listed here is what was tested.

## Downloads

| File | Platform | Size |
| --- | --- | --- |
${rows}
| \`${path.basename(source.tarPath)}\` | Source (all platforms) | — |
| \`${path.basename(source.zipPath)}\` | Source (all platforms) | — |

## Installing

**Windows** — run \`GitSynapse-${pkg.version}-Windows-x64-Setup.exe\`. It installs
per-user (no administrator rights), creates a Start-menu shortcut, and can be
uninstalled from *Apps & features*. SmartScreen will warn once because the build
is not code-signed: *More info* → *Run anyway*.

**macOS** — unzip, then drag **GitSynapse** to Applications. It is unsigned, so
the first launch needs either right-click → *Open* → *Open*, or:

\`\`\`bash
xattr -dr com.apple.quarantine /Applications/GitSynapse.app
\`\`\`

Use the \`arm64\` build on Apple Silicon and \`x64\` on Intel.

**Linux** — \`chmod +x\` the AppImage and run it, or:

\`\`\`bash
sudo apt install ./GitSynapse-${pkg.version}-Linux-amd64.deb
\`\`\`

## Requirements

Git on your \`PATH\` — GitSynapse drives the \`git\` you already have rather than
bundling one. For the AI copilot, an API key from Mesh, OpenRouter, OpenAI,
Anthropic or Groq; without a key everything else still works.

## Verifying a download

\`\`\`bash
sha256sum -c SHA256SUMS.txt        # Linux
shasum -a 256 -c SHA256SUMS.txt    # macOS
certutil -hashfile <file> SHA256   # Windows
\`\`\`

## Before you publish

Two placeholders in \`package.json\` are deliberately generic and should be
replaced with your own details, then rebuilt:

- \`homepage\` and \`repository\` — currently \`github.com/gitsynapse/gitsynapse\`
- \`author.email\` and \`build.deb.maintainer\` — currently \`maintainer@example.com\`

See \`RELEASE.md\` for signing and notarization.
`;

  fs.writeFileSync(path.join(outDir, 'RELEASE-NOTES.md'), notes);
}

function main() {
  if (!fs.existsSync(releaseDir)) {
    console.error('no release/ directory — run a build first (npm run dist:all)');
    process.exit(1);
  }

  step(`Assembling release/v${pkg.version}`);

  const entries = [];
  const missing = [];

  for (const item of LAYOUT) {
    const from = path.join(releaseDir, item.source);
    const to = path.join(outDir, item.target || item.source);

    // Accept an already-assembled release, so this can be re-run to refresh the
    // notes or the checksums without rebuilding anything.
    if (!fs.existsSync(from) && !fs.existsSync(to)) {
      missing.push(item.source);
      continue;
    }

    fs.mkdirSync(outDir, { recursive: true });
    if (fs.existsSync(from) && from !== to) fs.renameSync(from, to);
    entries.push({ ...item, file: to });
    console.log(`  ${path.basename(to)}`);
  }

  if (entries.length === 0) {
    console.error('\nnothing to release: no artifacts found in release/');
    process.exit(1);
  }

  if (missing.length) {
    console.log(`\n\x1b[33m  not built, so not included: ${missing.join(', ')}\x1b[0m`);
    console.log('  (\x1b[2mnpm run dist:all\x1b[0m builds every platform)');
  }

  // Electron-updater blockmaps are useless without an update feed, and they sit
  // next to the zips looking like part of the release.
  for (const file of fs.readdirSync(releaseDir)) {
    if (file.endsWith('.blockmap') || file.endsWith('.sha256')) {
      fs.rmSync(path.join(releaseDir, file), { force: true });
    }
  }

  step('Packing the source');
  const source = packSource();
  console.log(`  ${path.basename(source.tarPath)}`);
  console.log(`  ${path.basename(source.zipPath)}`);
  console.log(`  \x1b[2mexcludes: ${source.excluded.join(', ')}\x1b[0m`);

  step('Writing checksums');
  const all = [...entries.map((entry) => entry.file), source.tarPath, source.zipPath];
  const lines = all.map((file) => `${sha256(file)}  ${path.basename(file)}`);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  for (const line of lines) console.log(`  ${line}`);

  writeReleaseNotes(entries, source);
  console.log(`\n  RELEASE-NOTES.md`);

  const totalMb = all.reduce((sum, file) => sum + fs.statSync(file).size, 0) / 1024 / 1024;
  console.log(`\n\x1b[32m✓ release/v${pkg.version} is ready\x1b[0m (${entries.length} binaries + source, ${totalMb.toFixed(0)} MB total)`);
  console.log(`  verify: npm run verify:release`);
  console.log(`  \x1b[2mhost: ${os.platform()} ${os.arch()}\x1b[0m`);
}

try {
  main();
} catch (error) {
  console.error(`\n\x1b[31mrelease assembly failed:\x1b[0m ${error.message}`);
  process.exit(1);
}
