#!/usr/bin/env node
/**
 * Verifies the release artifacts by unpacking each one and running it.
 *
 * Building an installer proves nothing on its own: the interesting failures are
 * a stale file inside the bundle, a wrong version string, or code that throws
 * the moment it starts. So for every artifact this script:
 *
 *   1. unpacks the format (NSIS, deb, AppImage, tar.gz, macOS zip) into a temp
 *      directory using whatever tool the platform provides,
 *   2. reads `package.json` and the provider registry straight out of the
 *      shipped `app.asar`, so the check is on the bundle rather than the source,
 *   3. extracts that asar and **boots the packaged server** — the real entry
 *      point, from the packaged files — then queries its HTTP API.
 *
 * The GUI cannot be started here (no display, and the Windows and macOS
 * binaries are foreign), so this covers the server and the bundle contents.
 *
 * Usage:  npm run verify:release
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as asar from '@electron/asar';
import * as ResEdit from 'resedit';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const releaseDir = path.join(root, 'release');
/**
 * Scratch space for unpacked bundles.
 *
 * Each platform's bundle is ~230 MB once unpacked, and on a container `/tmp` is
 * often a small tmpfs — which fails midway with an unhelpful unzip/7z error
 * rather than an out-of-space message. So the scratch directory is chosen from
 * somewhere with room, and each artifact's tree is deleted as soon as it has
 * been checked.
 */
function scratchRoot() {
  const candidates = [
    process.env.GITSYNAPSE_VERIFY_TMP,
    '/var/tmp',
    os.tmpdir(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      const stats = fs.statfsSync ? fs.statfsSync(candidate) : null;
      if (stats && stats.bavail * stats.bsize < 3 * 1024 ** 3) continue;
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return os.tmpdir();
}

const temp = path.join(scratchRoot(), `gitsynapse-verify-${Date.now()}`);

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`    \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures += 1;
    console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr || ''}`);
  }
  return result.stdout;
}

/** Unpacks an artifact and returns the extracted directory. */
function unpack(artifact, name) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(artifact);

  if (ext === '.exe') {
    // NSIS needs 7-Zip. It is not part of a default image, so this is the one
    // step that can legitimately be skipped.
    const sevenZip = findSevenZip();
    if (!sevenZip) throw new Error('SKIP: 7z is not installed, so NSIS cannot be unpacked');
    run(sevenZip, ['x', artifact, `-o${dir}`, '-y', 'resources/app.asar']);
    // The archive has no directory structure to preserve for this member.
    const found = walk(dir).find((file) => file.endsWith('app.asar'));
    return path.dirname(found);
  }

  if (ext === '.deb') {
    run('dpkg-deb', ['-x', artifact, dir]);
    return dir;
  }

  if (ext === '.zip') {
    run('unzip', ['-q', '-o', artifact, '-d', dir]);
    return dir;
  }

  if (artifact.endsWith('.tar.gz')) {
    run('tar', ['-xzf', artifact, '-C', dir]);
    return dir;
  }

  if (artifact.endsWith('.AppImage')) {
    fs.chmodSync(artifact, 0o755);
    // --appimage-extract is handled by the runtime before it ever needs FUSE,
    // so this works in a container.
    run(artifact, ['--appimage-extract'], { cwd: dir });
    return dir;
  }

  throw new Error(`no unpacker for ${path.basename(artifact)}`);
}

function findSevenZip() {
  for (const candidate of ['7z', '7za', '7zr']) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0) return candidate.trim();
  }
  for (const candidate of ['/tmp/p7/root/usr/lib/7zip/7z']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Finds node_modules, app.asar and the executable inside an unpacked tree. */
function locate(dir) {
  const files = walk(dir);
  const asarPath = files.find((file) => file.endsWith(`${path.sep}resources${path.sep}app.asar`))
    || files.find((file) => file.endsWith('app.asar'));
  return { asarPath, files };
}

async function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Boots the packaged server and asks it about itself.
 *
 * The server entry point is the same file Electron loads, so a missing module,
 * a bad import path or a syntax error introduced by packaging all show up here.
 */
async function bootPackagedServer(extractedRoot) {
  const entry = path.join(extractedRoot, 'src', 'server', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`no server entry point at ${entry}`);

  const port = await freePort();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsynapse-verify-config-'));

  const child = spawn(process.execPath, [entry], {
    cwd: extractedRoot,
    env: {
      ...process.env,
      GITSYNAPSE_CONFIG_DIR: configDir,
      GITSYNAPSE_PORT: String(port),
      GITSYNAPSE_BIND: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const stop = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };

  try {
    const info = await waitForJson(`http://127.0.0.1:${port}/api/system/info`, child, () => output);
    const settings = await fetchJson(`http://127.0.0.1:${port}/api/ai/settings`);
    return { info, settings };
  } finally {
    stop();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return response.json();
}

/** Polls the API until the packaged server answers, or the process dies. */
async function waitForJson(url, child, getOutput, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the packaged server exited with code ${child.exitCode}\n${getOutput()}`);
    }
    try {
      return await fetchJson(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`the packaged server did not answer within ${timeoutMs}ms\n${getOutput()}`);
}

/** Reads bundle metadata without extracting the whole asar to disk. */
function inspectAsar(asarPath, extractTo) {
  const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  const providers = asar.extractFile(asarPath, 'src/server/ai/providers.js').toString('utf8');
  const indexHtml = asar.extractFile(asarPath, 'src/renderer/index.html').toString('utf8');
  const env = asar.extractFile(asarPath, 'src/server/env.js').toString('utf8');

  if (extractTo) {
    fs.mkdirSync(extractTo, { recursive: true });
    asar.extractAll(asarPath, extractTo);
  }

  return { pkg, providers, indexHtml, env };
}

async function verifyArtifact(artifact) {
  const name = path.basename(artifact);
  const sizeMb = (fs.statSync(artifact).size / 1024 / 1024).toFixed(1);
  console.log(`\n\x1b[1m${name}\x1b[0m \x1b[2m(${sizeMb} MB)\x1b[0m`);

  let dir;
  try {
    dir = unpack(artifact, name.replace(/[^\w.-]/g, '_'));
  } catch (error) {
    if (error.message.startsWith('SKIP')) {
      console.log(`    \x1b[33m— skipped: ${error.message.slice(6)}\x1b[0m`);
      return;
    }
    failures += 1;
    console.log(`    \x1b[31m✗ could not unpack: ${error.message.split('\n')[0]}\x1b[0m`);
    return;
  }

  const { asarPath, files } = locate(dir);
  check('the bundle contains resources/app.asar', Boolean(asarPath), asarPath || 'not found');
  if (!asarPath) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  const extracted = path.join(temp, `${name}-asar`);
  const bundle = inspectAsar(asarPath, extracted);

  check('bundled name is gitsynapse', bundle.pkg.name === 'gitsynapse', bundle.pkg.name);
  check('bundled productName is GitSynapse', bundle.pkg.productName === 'GitSynapse', bundle.pkg.productName);
  check('bundled version is 1.0.0', bundle.pkg.version === '1.0.0', bundle.pkg.version);
  check('the renderer title says GitSynapse', /<title>GitSynapse<\/title>/.test(bundle.indexHtml));

  const providerIds = [...bundle.providers.matchAll(/    id: '([a-z]+)',/g)].map((m) => m[1]);
  check('all five providers shipped',
    JSON.stringify(providerIds) === JSON.stringify(['mesh', 'openrouter', 'openai', 'anthropic', 'groq']),
    providerIds.join(', '));
  check('Mesh is still the default', bundle.providers.includes("DEFAULT_PROVIDER_ID = 'mesh'"));
  check('no retired Anthropic model id', !bundle.providers.includes('claude-3-5'));

  // Nothing a user reads may still say GitDesk...
  const visible = ['src/renderer/index.html', 'src/renderer/js/settings.js', 'src/renderer/js/chat.js',
    'src/renderer/js/app.js', 'src/server/ai/providers.js', 'src/server/routes/ai.js'];
  const stale = visible.filter((file) => /GitDesk/.test(asar.extractFile(asarPath, file).toString('utf8')));
  check('no stale branding in user-visible files', stale.length === 0, stale.join(', '));

  // ...but the compatibility shim has to be there, or an upgrade from 0.x drops
  // the user's settings and key.
  const envSource = asar.extractFile(asarPath, 'src/server/env.js').toString('utf8');
  check('the legacy GITDESK_* compatibility ships', envSource.includes('GITDESK_'));

  // Now the part that actually matters: does it run?
  try {
    const { info, settings } = await bootPackagedServer(extracted);
    check('the packaged server starts and answers', info?.app?.name === 'GitSynapse',
      JSON.stringify(info?.app));
    check('it reports version 1.0.0 over HTTP', info?.app?.version === '1.0.0', info?.app?.version);
    check('it serves all five providers over HTTP',
      Array.isArray(settings?.providers) && settings.providers.length === 5,
      `${settings?.providers?.length} providers`);
    check('the git binary is found on this machine', Boolean(info?.git?.version), info?.git?.version);
  } catch (error) {
    failures += 1;
    console.log(`    \x1b[31m✗ the packaged server did not boot: ${error.message.split('\n')[0]}\x1b[0m`);
  }

  verifyPlatformMetadata(name, artifact, dir, files);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Checks the bits of each format a user sees before the app ever launches:
 * the desktop entry, the app icon, the macOS bundle identity, and the Windows
 * version resource. These are the details that make a build look unfinished.
 */
function verifyPlatformMetadata(name, artifact, dir, files) {
  if (name.endsWith('.deb')) {
    const desktop = files.find((file) => file.endsWith('.desktop'));
    check('the deb ships a desktop entry', Boolean(desktop), desktop || 'not found');
    if (desktop) {
      const text = fs.readFileSync(desktop, 'utf8');
      check('the desktop entry is named GitSynapse', /^Name=GitSynapse$/m.test(text),
        (text.match(/^Name=.*$/m) || [''])[0]);
      check('the desktop entry runs the packaged binary', /^Exec=.*gitsynapse/m.test(text),
        (text.match(/^Exec=.*$/m) || [''])[0]);
    }
    // electron-builder installs into the hicolor theme; the size it picks has
    // changed between versions, so accept any size rather than one path.
    const icon = files.find((file) => /\/icons\/hicolor\/[^/]+\/apps\/[^/]+\.png$/.test(file));
    check('the deb ships a launcher icon', Boolean(icon), icon || 'no hicolor icon found');
  }

  if (name.endsWith('.exe')) {
    // Windows shows these in the file's Properties dialog, and SmartScreen
    // quotes the product name, so they are part of the release, not decoration.
    // The unpacker only extracts app.asar from the NSIS archive, so the version
    // resource has to be read from the installer itself.
    try {
      const data = fs.readFileSync(artifact);
      const parsed = ResEdit.NtExecutable.from(data, { ignoreCert: true });
      const resource = ResEdit.NtExecutableResource.from(parsed);
      const info = ResEdit.Resource.VersionInfo.fromEntries(resource.entries)[0];
      const values = info.getStringValues(info.getAllLanguagesForStringValues()[0]);
      check('the installer is branded GitSynapse', values.ProductName === 'GitSynapse', values.ProductName);
      check('the installer reports version 1.0.0', values.FileVersion === '1.0.0', values.FileVersion);
      check('the installer has an icon resource',
        resource.entries.some((entry) => entry.type === 14));
    } catch (error) {
      check('the installer version resource is readable', false, error.message);
    }
  }

  if (name.endsWith('.AppImage')) {
    const desktop = files.find((file) => file.endsWith('.desktop'));
    check('the AppImage ships a desktop entry', Boolean(desktop));
    if (desktop) {
      check('the AppImage desktop entry is named GitSynapse',
        /^Name=GitSynapse$/m.test(fs.readFileSync(desktop, 'utf8')));
    }
  }

  if (name.endsWith('.zip')) {
    // A .app contains helper bundles, each with its own Info.plist. Only the
    // outermost one describes the app the user is installing, so pick the
    // shallowest match rather than whichever the directory walk reached first.
    const shallowest = (predicate) => files
      .filter(predicate)
      .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0];

    const plistPath = shallowest((file) => file.endsWith(`${path.sep}Contents${path.sep}Info.plist`));
    check('the app bundle has an Info.plist', Boolean(plistPath));
    if (plistPath) {
      const plist = fs.readFileSync(plistPath, 'utf8');
      const read = (key) => (plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)) || [])[1];
      check('CFBundleName is GitSynapse', read('CFBundleName') === 'GitSynapse', read('CFBundleName'));
      check('CFBundleIdentifier is ai.gitsynapse.app', read('CFBundleIdentifier') === 'ai.gitsynapse.app',
        read('CFBundleIdentifier'));
      check('CFBundleShortVersionString is 1.0.0', read('CFBundleShortVersionString') === '1.0.0',
        read('CFBundleShortVersionString'));
    }

    // The two zips are for different Macs, so the binary has to match the name.
    const binary = shallowest((file) => /Contents\/MacOS\/[^/]+$/.test(file));
    const kind = binary ? run('file', [binary]) : '';
    const expected = name.includes('arm64') ? 'arm64' : 'x86_64';
    check(`the binary is a ${expected} Mach-O executable`, kind.includes(expected),
      kind.trim() || 'no binary found');
  }
}

async function main() {
  if (!fs.existsSync(releaseDir)) {
    console.error('no release/ directory — run a build first');
    process.exit(1);
  }

  // Artifacts live in release/ while they are being built and in
  // release/v<version>/ once assembled, so check both.
  const artifactPattern = /\.(exe|deb|zip|AppImage|tar\.gz)$/;
  const artifacts = [];
  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!/^v\d/.test(entry.name)) continue;
      for (const file of fs.readdirSync(path.join(releaseDir, entry.name))) {
        if (artifactPattern.test(file) && !/Source\.(zip|tar\.gz)$/.test(file)) {
          artifacts.push(path.join(releaseDir, entry.name, file));
        }
      }
    } else if (artifactPattern.test(entry.name)) {
      artifacts.push(path.join(releaseDir, entry.name));
    }
  }
  artifacts.sort();

  if (artifacts.length === 0) {
    console.error('no artifacts found in release/');
    process.exit(1);
  }

  console.log(`\x1b[1mVerifying ${artifacts.length} release artifacts\x1b[0m`);
  for (const artifact of artifacts) {
    await verifyArtifact(artifact);
  }

  fs.rmSync(temp, { recursive: true, force: true });

  console.log(`\n\x1b[1m${checks - failures}/${checks} checks passed\x1b[0m`);
  if (failures > 0) {
    console.log(`\x1b[31m${failures} failed\x1b[0m`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\x1b[31mverify failed:\x1b[0m ${error.message}`);
  process.exit(1);
});
