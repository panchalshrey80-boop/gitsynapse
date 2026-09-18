/**
 * Focused regression test for the "I can't make a new repository in this, some
 * folders are working and some are not" report.
 *
 * Each defect gets an explicit assertion, so a future change that reintroduces
 * one of them fails here rather than in front of a user. Run with:
 *
 *   npm run test:paths
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.GITSYNAPSE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsynapse-probe-'));

const { createApp } = await import('../src/server/index.js');
const { runGitIn } = await import('../src/server/git/runner.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsynapse-probe-fs-'));
const home = os.homedir();
/** Temp folders created under $HOME, so the probe can prove ~ handling. */
const homeScratch = [];

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(route, body) {
  const res = await fetch(base + route, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// The route reads `path`; the renderer sends `path`. This helper keeps the
// probe honest about the wire format rather than about a guess.
const action = (name, body) => call('/api/action', { action: name, ...body });

function makeFolder(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function git(dir, args) {
  const result = await runGitIn(dir, args);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

/**
 * A commit needs an author, and a build machine has no global git identity.
 * Setting it through the app's own action keeps the probe dependent on the same
 * code path the UI uses.
 */
async function setIdentity(dir) {
  await action('setConfig', { path: dir, key: 'user.name', value: 'GitSynapse Probe' });
  await action('setConfig', { path: dir, key: 'user.email', value: 'probe@example.com' });
}

/* ---------------------------------------------------------------- *
 * A. A freshly created repository reports its real branch
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mNew repository (no commits yet)\x1b[0m');
{
  const dir = makeFolder('fresh');
  const init = await action('init', { path: dir, initialBranch: 'main' });
  check('git init succeeds', init.json?.ok === true, JSON.stringify(init.json).slice(0, 160));

  const open = await call('/api/repo/open', { path: dir });
  check('the new repository opens', open.json?.status !== undefined, JSON.stringify(open.json).slice(0, 160));
  check('branch is "main", not "HEAD"', open.json?.status?.branch === 'main', open.json?.status?.branch);
  check('a repository with no commits is not reported as detached', open.json?.status?.detached === false);
  check('a repository with no commits is flagged unborn', open.json?.status?.unborn === true);
  check('a new repository reads as clean', open.json?.status?.clean === true);
  check('no phantom changes', open.json?.status?.files?.length === 0, JSON.stringify(open.json?.status?.files));

  // A commit must clear the unborn flag without disturbing the branch name.
  fs.writeFileSync(path.join(dir, 'readme.md'), '# hello\n');
  await setIdentity(dir);
  await action('stage', { path: dir, files: ['readme.md'] });
  const commit = await action('commit', { path: dir, message: 'First commit' });
  check('the first commit succeeds', commit.json?.ok === true, String(commit.json?.stderr || '').slice(0, 140));
  const after = await call('/api/repo/open', { path: dir });
  check('after the first commit the branch is still "main"', after.json?.status?.branch === 'main');
  check('after the first commit "unborn" clears', after.json?.status?.unborn === false);
}

/* ---------------------------------------------------------------- *
 * B. Tilde paths
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mPaths starting with ~\x1b[0m');
{
  // A ~ path can only be proved with a folder genuinely inside $HOME.
  const tildeTarget = fs.mkdtempSync(path.join(home, '.gitsynapse-probe-'));
  homeScratch.push(tildeTarget);
  const relativeToHome = path.relative(home, tildeTarget);

  if (relativeToHome.startsWith('..')) {
    console.log('  \x1b[33m·\x1b[0m skipped: scratch folder is not under $HOME on this machine');
  } else {
    const asTilde = `~/${relativeToHome}`;
    const open = await call('/api/repo/open', { path: asTilde });
    check('~ resolves before asking git anything', open.status === 404
      && open.json?.error === 'not_a_repository', `${open.status} ${JSON.stringify(open.json)}`);
    check('the message names the expanded folder', String(open.json?.message || '').includes(tildeTarget));

    const init = await action('init', { path: asTilde, initialBranch: 'main' });
    check('a ~ path can be initialised', init.json?.ok === true, JSON.stringify(init.json).slice(0, 160));
    check('the repository landed where the user asked', fs.existsSync(path.join(tildeTarget, '.git')));

    const listing = await call(`/api/fs/list?path=${encodeURIComponent('~')}`);
    check('/fs/list accepts ~', listing.status === 200 && listing.json?.path === home,
      `${listing.status} ${listing.json?.path}`);
  }

  const quoted = await call(`/api/fs/list?path=${encodeURIComponent('"~"')}`);
  check('a quoted paste still resolves', quoted.status === 200, JSON.stringify(quoted.json).slice(0, 120));
}

/* ---------------------------------------------------------------- *
 * C. An empty path must never run git in the server's own directory
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mEmpty and invalid paths\x1b[0m');
{
  const cwdGit = path.join(process.cwd(), '.git');
  const homeGit = path.join(home, '.git');
  const cwdHadGit = fs.existsSync(cwdGit);
  const homeHadGit = fs.existsSync(homeGit);

  for (const value of ['', '   ', null, undefined]) {
    const init = await action('init', { path: value, initialBranch: 'main' });
    check(`init with path ${JSON.stringify(value)} is refused with a readable message`,
      init.status === 400 && /folder path/i.test(String(init.json?.message || '')),
      `${init.status} ${JSON.stringify(init.json).slice(0, 120)}`);
  }

  // An action without a repository used to reach findRepositoryRoot('') directly
  // and surface as an internal error.
  const bare = await action('stage', { files: ['x'] });
  check('an action with no repository is a clean 400', bare.status === 400 && bare.json?.error === 'missing_path',
    `${bare.status} ${JSON.stringify(bare.json)}`);

  const open = await call('/api/repo/open', { path: '' });
  check('opening with an empty path is refused', open.status === 400 && open.json?.error === 'missing_path');

  check('no .git appeared in the server working directory', fs.existsSync(cwdGit) === cwdHadGit);
  check('no .git appeared in the home directory', fs.existsSync(homeGit) === homeHadGit);
}

/* ---------------------------------------------------------------- *
 * D. Folders the app cannot read must explain themselves
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mUnreadable folders and odd paths\x1b[0m');
{
  const locked = makeFolder('locked');
  fs.mkdirSync(path.join(locked, 'inner'));
  fs.chmodSync(locked, 0o000);

  const listing = await call(`/api/fs/list?path=${encodeURIComponent(locked)}`);
  const denied = listing.status === 403 || listing.status === 200; // root can read anything
  check('an unreadable folder answers with JSON, never an HTML 500', denied
    && typeof listing.json === 'object' && listing.json !== null,
    `${listing.status} ${String(JSON.stringify(listing.json)).slice(0, 80)}`);
  check('the refusal carries a code and a message', listing.status === 200
    || (listing.json?.error && listing.json?.message), JSON.stringify(listing.json).slice(0, 160));

  fs.chmodSync(locked, 0o755);

  const missing = await call(`/api/fs/list?path=${encodeURIComponent(path.join(scratch, 'nope'))}`);
  check('a missing folder is a 404 with a message', missing.status === 404 && missing.json?.error === 'not_found',
    JSON.stringify(missing.json).slice(0, 120));

  const file = path.join(scratch, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  const notADir = await call(`/api/fs/list?path=${encodeURIComponent(file)}`);
  check('a file is not a folder', notADir.status === 404 || notADir.status === 400, String(notADir.status));

  const openFile = await call('/api/repo/open', { path: file });
  check('opening a file explains it is a file', openFile.status === 400
    && String(openFile.json?.message || '').includes('file'), JSON.stringify(openFile.json).slice(0, 120));

  const openMissing = await call('/api/repo/open', { path: path.join(scratch, 'nope') });
  check('opening a missing folder says so', openMissing.status === 404
    && openMissing.json?.error === 'not_found', JSON.stringify(openMissing.json).slice(0, 120));

  const openPlain = await call('/api/repo/open', { path: makeFolder('plain') });
  check('a plain folder offers to be initialised', openPlain.status === 404
    && openPlain.json?.canInitialise === true, JSON.stringify(openPlain.json).slice(0, 140));
}

/* ---------------------------------------------------------------- *
 * E. Bare and nested repositories
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mBare and nested repositories\x1b[0m');
{
  const bare = path.join(scratch, 'bare.git');
  fs.mkdirSync(bare);
  await git(bare, ['init', '--bare']);

  const open = await call('/api/repo/open', { path: bare });
  check('a bare repository is refused explicitly', open.status === 400
    && open.json?.error === 'bare_repository', `${open.status} ${JSON.stringify(open.json).slice(0, 160)}`);
  check('the bare message explains working trees',
    String(open.json?.message || '').includes('working tree'), String(open.json?.message));

  const init = await action('init', { path: bare, initialBranch: 'main' });
  check('a bare repository cannot be "initialised"', init.status === 400
    && /bare repository/i.test(String(init.json?.message || '')),
    `${init.status} ${JSON.stringify(init.json).slice(0, 160)}`);

  const repo = makeFolder('outer');
  await git(repo, ['init', '-q']);
  const inner = path.join(repo, 'inner');
  fs.mkdirSync(inner);
  const nested = await action('init', { path: inner, initialBranch: 'main' });
  check('initialising inside a repository is refused with guidance', nested.status === 409,
    `${nested.status} ${JSON.stringify(nested.json).slice(0, 140)}`);

  const inside = await call('/api/repo/open', { path: inner });
  check('opening a sub-folder resolves to the repository root', inside.json?.path === repo,
    `${inside.json?.path} vs ${repo}`);
}

/* ---------------------------------------------------------------- *
 * F. Close repository
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mClosing a repository\x1b[0m');
{
  const dir = makeFolder('to-close');
  await git(dir, ['init', '-q']);
  await call('/api/repo/open', { path: dir });

  const before = await call('/api/ai/settings');
  check('the last repository is remembered while open', before.json?.lastRepo === dir, String(before.json?.lastRepo));

  const closed = await call('/api/repo/close', { path: dir });
  check('closing succeeds', closed.json?.ok === true);

  const after = await call('/api/ai/settings');
  check('the last repository is forgotten', after.json?.lastRepo === null, String(after.json?.lastRepo));
  check('the folder stays in the recent list', (after.json?.recentRepos || []).includes(dir),
    JSON.stringify(after.json?.recentRepos));
  check('nothing was deleted from disk', fs.existsSync(path.join(dir, '.git')));
}

/* ---------------------------------------------------------------- *
 * G. Folder shapes that must keep working
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mFolder shapes that already worked\x1b[0m');
{
  const repo = makeFolder('shapes');
  await git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  await setIdentity(repo);
  await action('stage', { path: repo, files: ['a.txt'] });
  await action('commit', { path: repo, message: 'base' });

  const deep = path.join(repo, 'x', 'y', 'z');
  fs.mkdirSync(deep, { recursive: true });

  for (const [label, target] of [
    ['the repository root', repo],
    ['a nested folder', deep],
    ['a trailing slash', `${repo}/`],
    ['a relative path with ..', path.join(deep, '..', '..')],
  ]) {
    const opened = await call('/api/repo/open', { path: target });
    check(`${label} opens and resolves to the root`, opened.json?.path === repo,
      `${opened.json?.path} vs ${repo}`);
  }

  const trailingSlashInit = await action('init', { path: `${makeFolder('slash')}/`, initialBranch: 'main' });
  check('a trailing slash initialises correctly', trailingSlashInit.json?.ok === true);
}

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */

console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);

server.close();
fs.rmSync(scratch, { recursive: true, force: true });
for (const dir of homeScratch) fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
