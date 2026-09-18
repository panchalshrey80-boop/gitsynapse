#!/usr/bin/env node
/**
 * The first commit on a machine where git has never been told who you are.
 *
 * This is the state every freshly installed git starts in, and it is where the
 * app used to answer "Commit failed — Request failed (HTTP 422)", leaving the
 * user with no way to know that the problem was a name and an email.
 *
 * Two halves: the API contract (a readable reason for every failure, and an
 * identity that can be written), then the same journey through the real UI in
 * headless Chrome. The second half is the one that matters, because the user's
 * complaint was about what the screen said, not about what the server returned.
 *
 * Usage:  npm run test:identity
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A machine with no git identity anywhere: an empty HOME, no global config
// file, and the system config pointed at /dev/null.
// Captured before HOME is replaced: puppeteer's browser lives under the real
// home, and this test deliberately runs the server under a fake one.
const realPuppeteerCache = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsynapse-identity-'));
const globalConfig = path.join(home, '.gitconfig');
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GITSYNAPSE_CONFIG_DIR = path.join(home, 'config');
process.env.GITSYNAPSE_PORT = '0';

const repo = path.join(home, 'my-project');
fs.mkdirSync(repo, { recursive: true });

const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '--initial-branch=main');
fs.writeFileSync(path.join(repo, 'index.js'), 'export const answer = 42;\n');

let passed = 0;
let failed = 0;
const problems = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    problems.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const { createApp } = await import('../src/server/index.js');
const { explainGitFailure } = await import('../src/server/git/failures.js');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(route, body, method = 'POST') {
  const res = await fetch(base + route, body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const act = (action, params = {}) => call('/api/action', { action, path: repo, ...params });

/* ---------------------------------------------------------------- *
 * 1. What the API says when there is no identity
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mNo identity configured\x1b[0m');
{
  const identity = await call('/api/git/identity', undefined, 'GET');
  check('the API reports the identity as unset', identity.json?.configured === false,
    JSON.stringify(identity.json));

  await act('stageAll');
  const commit = await act('commit', { message: 'My first commit' });

  check('the commit is refused', commit.status === 422 && commit.json?.ok === false, String(commit.status));
  check('the reason is prose, not an HTTP status',
    typeof commit.json?.message === 'string' && commit.json.message.length > 40
      && !/HTTP \d|undefined/.test(commit.json.message), String(commit.json?.message));
  check('the reason names the real cause', /know who you are/i.test(commit.json?.message || ''),
    String(commit.json?.message));
  check('the response asks the UI to offer the fix', commit.json?.needsIdentity === true);
  check('a hint explains what will be written',
    /global git configuration/i.test(commit.json?.hint || ''), String(commit.json?.hint));
  check('nothing was committed', git('log', '--oneline').stdout.trim() === '');
}

/* ---------------------------------------------------------------- *
 * 2. Every failure carries a reason
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mFailures that are not about identity\x1b[0m');
{
  const cases = [
    ['checkout a branch that does not exist', await act('checkout', { branch: 'no-such-branch' })],
    ['delete a branch that does not exist', await act('deleteBranch', { name: 'no-such-branch' })],
    ['push a branch with no remote', await act('push', {})],
    ['discard a file that does not exist', await act('discard', { file: 'ghost.txt' })],
  ];

  for (const [label, response] of cases) {
    check(`${label} explains itself`, response.status >= 400
      && typeof response.json?.message === 'string'
      && response.json.message.length > 15
      && !/HTTP \d/.test(response.json.message),
    JSON.stringify(response.json?.message || response.json).slice(0, 120));
  }

  // A missing branch and a missing file produce identical git output; the
  // action is what tells them apart.
  const ref = explainGitFailure({ ok: false, code: 1, stderr: "error: pathspec 'x' did not match any file(s) known to git", stdout: '', args: [] }, { action: 'checkout' });
  const file = explainGitFailure({ ok: false, code: 1, stderr: "error: pathspec 'x' did not match any file(s) known to git", stdout: '', args: [] }, { action: 'discard' });
  check('a missing branch is described as a branch', /branch, tag or commit/i.test(ref.message), ref.message);
  check('a missing file is described as a file', /file or folder/i.test(file.message), file.message);

  const unknown = explainGitFailure({ ok: false, code: 128, stderr: 'fatal: something nobody predicted', stdout: '', args: [] }, { action: 'commit' });
  check('an unforeseen failure still quotes git', unknown.message.includes('something nobody predicted'), unknown.message);
  const silent = explainGitFailure({ ok: false, code: 9, stderr: '', stdout: '', args: [] }, { action: 'commit' });
  check('a silent failure still names the exit code', silent.message.includes('9'), silent.message);
}

/* ---------------------------------------------------------------- *
 * 3. Setting the identity
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mSaving a name and email\x1b[0m');
{
  const bad = await act('setIdentity', { name: 'Ada', email: 'not-an-email' });
  check('a malformed email is refused', bad.status === 400 && /email/i.test(bad.json?.message || ''),
    JSON.stringify(bad.json).slice(0, 140));

  const flag = await act('setIdentity', { name: '-x', email: 'ada@example.com' });
  check('an option-shaped name is refused', flag.status === 400, String(flag.status));

  const missing = await act('setIdentity', { name: '', email: 'ada@example.com' });
  check('a blank name is refused', missing.status === 400, String(missing.status));

  const saved = await act('setIdentity', { name: 'Ada Lovelace', email: 'ada@example.com' });
  check('a valid identity saves', saved.json?.ok === true, JSON.stringify(saved.json).slice(0, 140));
  check('it lands in the global git config', fs.existsSync(globalConfig)
    && /name = Ada Lovelace/.test(fs.readFileSync(globalConfig, 'utf8')), fs.existsSync(globalConfig) ? 'file differs' : 'no file');
  check('the API reads it back', saved.json?.identity?.configured === true
    && saved.json?.identity?.email === 'ada@example.com', JSON.stringify(saved.json?.identity));
  check('git itself agrees', git('config', '--global', 'user.email').stdout.trim() === 'ada@example.com');

  const commit = await act('commit', { message: 'My first commit' });
  check('the commit now succeeds', commit.json?.ok === true, JSON.stringify(commit.json?.message));
  check('it is attributed to the saved identity',
    /Ada Lovelace <ada@example\.com>/.test(git('log', '-1', '--pretty=%an <%ae>').stdout.trim()),
    git('log', '-1', '--pretty=%an <%ae>').stdout.trim());

  const clean = await act('commit', { message: 'nothing changed' });
  check('committing a clean tree explains there is nothing to do',
    /nothing to commit/i.test(clean.json?.message || ''), String(clean.json?.message));
  check('and that is not reported as an identity problem', clean.json?.needsIdentity !== true);
}

/* ---------------------------------------------------------------- *
 * 4. The same journey, through the UI
 * ---------------------------------------------------------------- */

console.log('\n\x1b[1mThrough the interface\x1b[0m');
{
  // A second machine, because the first one now has an identity: this half has
  // to start from the state a new user is actually in.
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsynapse-fresh-'));
  const freshConfig = path.join(freshHome, '.gitconfig');
  const freshRepo = path.join(freshHome, 'brand-new-project');
  fs.mkdirSync(freshRepo, { recursive: true });
  spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: freshRepo });
  fs.writeFileSync(path.join(freshRepo, 'notes.md'), '# notes\n');

  process.env.HOME = freshHome;
  process.env.GIT_CONFIG_GLOBAL = freshConfig;
  // The config directory is captured when the server module loads, so this
  // second app has to be a second process-shaped import: a fresh server on a
  // fresh port, with the environment set before it reads anything.
  const { createApp: createFreshApp } = await import('../src/server/index.js');
  const freshServer = createFreshApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => freshServer.once('listening', resolve));
  const freshBase = `http://127.0.0.1:${freshServer.address().port}`;

  // Puppeteer resolves its browser cache from HOME at import time, so the
  // environment has to name the real cache explicitly before it loads.
  process.env.PUPPETEER_CACHE_DIR = realPuppeteerCache;
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    // HOME now points at the fresh machine under test.
    cacheDirectory: realPuppeteerCache,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  // A 422 is the expected answer here — the commit is supposed to be refused
  // first. Chrome logs every non-2xx response as a console error, so those are
  // filtered out; a real app error would still be caught.
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource/.test(message.text())) return;
    consoleErrors.push(message.text());
  });

  await page.goto(freshBase, { waitUntil: 'networkidle0' });
  await page.evaluate((target) => fetch('/api/repo/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target }),
  }), freshRepo);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row', { timeout: 10000 });

  // Write a message, stage everything, then commit: the exact sequence that
  // produced "Commit failed — Request failed (HTTP 422)". The commit button
  // stays disabled until there is both a message and something staged.
  await page.evaluate(() => {
    const subject = document.querySelector('#commit-subject');
    subject.value = 'Add my notes';
    subject.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((n) => /Stage all/i.test(n.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('#btn-commit')?.disabled, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#btn-commit').click());

  const dialog = await page.waitForSelector('.modal', { timeout: 8000 }).then(() => true).catch(() => false);
  check('committing opens a dialog instead of failing silently', dialog);

  const title = dialog ? await page.$eval('.modal__title', (node) => node.textContent.trim()) : '';
  check('the dialog asks for a name and an email', /know who you are/i.test(title), title);
  const inputs = await page.$$eval('.modal input', (nodes) => nodes.length);
  check('it offers both fields', inputs >= 2, String(inputs));

  await page.evaluate(() => {
    const [name, email] = [...document.querySelectorAll('.modal input')];
    name.value = 'Grace Hopper';
    email.value = 'grace@example.com';
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.modal__foot button')].find((n) => /save and try again/i.test(n.textContent)).click();
  });

  await page.waitForFunction(
    () => [...document.querySelectorAll('.toast')].some((n) => /Commit created/i.test(n.textContent)),
    { timeout: 10000 },
  ).catch(() => {});
  const toasts = await page.$$eval('.toast', (nodes) => nodes.map((n) => n.textContent.trim()));

  check('the commit is created without a second attempt', /Commit created/i.test(toasts.join(' ')), toasts.join(' | '));
  check('the commit exists on disk', spawnSync('git', ['log', '--oneline'], { cwd: freshRepo, encoding: 'utf8' }).stdout.includes('Add my notes'));
  check('it is attributed to the typed identity',
    /Grace Hopper <grace@example\.com>/.test(spawnSync('git', ['log', '-1', '--pretty=%an <%ae>'], { cwd: freshRepo, encoding: 'utf8' }).stdout.trim()));
  check('the identity was written globally, not just here', /grace@example\.com/.test(
    fs.existsSync(freshConfig) ? fs.readFileSync(freshConfig, 'utf8') : ''));

  // And the repository reads clean afterwards, which is what "my changes were
  // saved" means to the person clicking.
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: freshRepo, encoding: 'utf8' }).stdout.trim();
  check('the working tree is clean afterwards', porcelain === '', porcelain);

  check('no console errors during the whole journey', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  freshServer.close();
}

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */

console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
if (failed > 0) console.log(`\x1b[31mFailed:\x1b[0m ${problems.join('; ')}`);

server.close();
fs.rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
