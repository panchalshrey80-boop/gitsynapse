#!/usr/bin/env node
/**
 * Reproduces the reported failure through the real UI:
 *
 *   "I can't make a new REPOSITORY in this, some folders are working and some
 *    are not"
 *
 * Drives the actual init dialog in headless Chrome — no direct API calls for
 * anything the user would click — against a fresh config directory, so the app
 * starts on the welcome screen and nothing is remembered from a previous run.
 *
 * Usage:  npm run test:init
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

// The folder browser starts at $HOME, so the scratch tree lives there: browsing
// to it then happens by clicking, exactly as a person would.
const sandbox = fs.mkdtempSync(path.join(os.homedir(), '.gitsynapse-repro-'));
process.env.GITSYNAPSE_CONFIG_DIR = path.join(sandbox, 'config');
process.env.GITSYNAPSE_PORT = '0';

// A folder that exists and is empty: exactly what someone points at when they
// want a brand new repository.
const target = path.join(sandbox, 'my-new-project');
fs.mkdirSync(target, { recursive: true });

// A folder that is not a repository, to prove the browser offers to create one.
const plain = path.join(sandbox, 'not-a-repo-yet');
fs.mkdirSync(plain, { recursive: true });

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
const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.message));

const text = (selector) => page.$eval(selector, (node) => node.textContent.trim());

const waitFor = (selector, timeout = 8000) => page.waitForSelector(selector, { timeout, visible: true });

/** Waits for a toast whose text matches, then returns the toast body. */
async function waitForToast(pattern, timeout = 8000) {
  await page.waitForFunction(
    (source) => {
      const toasts = [...document.querySelectorAll('.toast')].map((node) => node.textContent);
      return toasts.some((text) => new RegExp(source, 'i').test(text));
    },
    { timeout },
    pattern,
  );
  return page.$$eval('.toast', (nodes) => nodes.map((node) => node.textContent).join(' | '));
}

console.log('\n\x1b[1m1. Creating a repository from the welcome screen\x1b[0m');
await page.goto(base, { waitUntil: 'networkidle0' });
check('the app starts on the welcome screen', Boolean(await page.$('#view-welcome:not([hidden])')));

await page.click('#welcome-init');
await waitFor('.modal');
check('the dialog is called "Create a new repository"',
  (await text('.modal__title')).toLowerCase().includes('create a new repository'), await text('.modal__title'));
check('the dialog has a folder field', Boolean(await page.$('.modal input.input--mono')));

// The hint used to promise a folder browser that did not exist (defect D).
const browseLabels = await page.$$eval('.modal button', (nodes) => nodes.map((n) => n.textContent.trim()));
check('the dialog offers a folder browser', browseLabels.includes('Browse…'), browseLabels.join(', '));

await page.evaluate(() => {
  [...document.querySelectorAll('.modal button')].find((n) => n.textContent.trim() === 'Browse…').click();
});
await waitFor('.modal .picker__list');
check('browsing lists folders', (await page.$$('.modal .picker__entry')).length > 0);

// Opening the browser must not fill the field by itself: a user could click
// "Create repository" straight away and initialise whatever folder the browser
// started in, which is home.
const untouched = await page.$eval('.modal input.input--mono', (node) => node.value);
check('opening the browser does not choose a folder on its own', untouched === '', JSON.stringify(untouched));

// Click into the folder the user wants, the way a person does: by name.
await page.evaluate((name) => {
  const row = [...document.querySelectorAll('.modal .picker__entry')].find((n) => n.textContent.includes(name));
  row.click();
}, path.basename(sandbox));
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.modal .picker__entry')].some((n) => n.textContent.includes(name)),
  { timeout: 8000 }, path.basename(target),
);

await page.evaluate((name) => {
  const row = [...document.querySelectorAll('.modal .picker__entry')].find((n) => n.textContent.includes(name));
  row.click();
}, path.basename(target));

const navigated = await page.waitForFunction(
  (expected) => {
    const input = document.querySelector('.modal input.input--mono');
    return input && input.value === expected ? expected : false;
  },
  { timeout: 8000 }, target,
).then((handle) => handle.jsonValue()).catch(() => null);
check('the chosen folder is mirrored into the path field', navigated === target, `${navigated} vs ${target}`);

const opened = page.evaluate(() => new Promise((resolve) => {
  const toast = setInterval(() => {
    if (document.querySelector('.toast')) { clearInterval(toast); resolve(true); }
  }, 100);
  setTimeout(() => { clearInterval(toast); resolve(false); }, 8000);
}));
await page.evaluate(() => {
  [...document.querySelectorAll('.modal__foot button')].find((n) => /Create repository/i.test(n.textContent)).click();
});
await opened;
await waitForToast('Opened my-new-project');
check('the repository is created and opened', true);

// The header repaints after the repository is read, which is a round trip after
// the toast appears: wait for the value rather than assuming it is already there.
const painted = await page.waitForFunction(
  () => document.querySelector('#branch-name')?.textContent === 'main',
  { timeout: 8000 },
).then(() => true).catch(() => false);
const branch = await text('#branch-name');
check('the header shows the branch name, not "HEAD"', painted, branch);
const detached = await page.$eval('#branch-pill', (node) => node.classList.contains('is-detached'));
check('a new repository is not flagged as detached', detached === false);
check('the .git folder was created on disk', fs.existsSync(path.join(target, '.git')));
check('a toast does not report a failure', !/could not/i.test(await waitForToast('Opened my-new-project')));

console.log('\n\x1b[1m2. Creating a repository while one is already open\x1b[0m');
// This is the reported bug: there was no route to a new repository once one was
// open, because the welcome screen becomes unreachable.
check('the welcome screen is hidden', Boolean(await page.$('#view-welcome[hidden]')));

await page.click('#btn-open-repo');
await waitFor('.modal');
const options = await page.$$eval('.modal button', (nodes) => nodes.map((n) => n.textContent));
check('the sidebar offers a way to create a repository',
  options.some((label) => /Create a new repository/i.test(label)), options.join(', '));
check('the sidebar offers cloning', options.some((label) => /Clone from a URL/i.test(label)));
check('the sidebar offers closing the current repository',
  options.some((label) => /Close the current repository/i.test(label)));

const second = path.join(sandbox, 'second-project');
fs.mkdirSync(second, { recursive: true });

await page.evaluate(() => {
  [...document.querySelectorAll('.modal button')].find((n) => /Create a new repository/i.test(n.textContent)).click();
});
await waitFor('.modal input.input--mono');
await page.evaluate((value) => {
  const input = document.querySelector('.modal input.input--mono');
  input.value = value;
}, second);
await page.evaluate(() => {
  [...document.querySelectorAll('.modal__foot button')].find((n) => /Create repository/i.test(n.textContent)).click();
});
await waitForToast('Opened second-project');
check('a second repository can be created without restarting', fs.existsSync(path.join(second, '.git')));
check('the header follows the new repository',
  (await text('#repo-chip-text')).includes('second-project'), await text('#repo-chip-text'));

console.log('\n\x1b[1m3. Closing a repository\x1b[0m');
await page.click('#btn-open-repo');
await waitFor('.modal');
await page.evaluate(() => {
  [...document.querySelectorAll('.modal button')].find((n) => /Close the current repository/i.test(n.textContent)).click();
});
await page.waitForFunction(() => document.querySelector('.modal-root')?.hidden === true, { timeout: 8000 });
// The dialog closes before the server round trip that clears the repository
// finishes, so both of these are waits, not reads.
const backToWelcome = await page.waitForFunction(
  () => document.querySelector('#view-welcome')?.hidden === false,
  { timeout: 8000 },
).then(() => true).catch(() => false);
check('the welcome screen comes back', backToWelcome, await text('#repo-chip-text'));

const forgot = await page.waitForFunction(
  () => document.querySelector('#repo-chip-text')?.textContent === 'No repository open',
  { timeout: 8000 },
).then(() => true).catch(() => false);
check('the header forgets the repository', forgot, await text('#repo-chip-text'));

const settings = await fetch(`${base}/api/ai/settings`).then((res) => res.json());
check('the next launch will not reopen it', settings.lastRepo === null, String(settings.lastRepo));

console.log('\n\x1b[1m4. A folder that is not a repository yet\x1b[0m');
await page.click('#welcome-open');
await waitFor('.modal .picker__list');

// Walk to the plain folder using only clicks on folder rows.
for (const name of [path.basename(sandbox), path.basename(plain)]) {
  await page.waitForFunction(
    (needle) => [...document.querySelectorAll('.modal .picker__entry')].some((n) => n.textContent.includes(needle)),
    { timeout: 8000 }, name,
  );
  await page.evaluate((needle) => {
    const row = [...document.querySelectorAll('.modal .picker__entry')].find((n) => n.textContent.includes(needle));
    row.click();
  }, name);
}

await page.waitForFunction(
  () => [...document.querySelectorAll('.modal .picker__entry')].some((n) => /Create a new repository here/i.test(n.textContent)),
  { timeout: 8000 },
).catch(() => {});
const offers = await page.$$eval('.modal .picker__entry', (nodes) => nodes.map((n) => n.textContent.trim()));
check('a folder with no repository offers to create one',
  offers.some((label) => /Create a new repository here/i.test(label)), offers.slice(0, 6).join(' | '));

await page.evaluate(() => {
  [...document.querySelectorAll('.modal .picker__entry')]
    .find((n) => /Create a new repository here/i.test(n.textContent)).click();
});
await waitFor('.modal input.input--mono');
const prefilled = await page.$eval('.modal input.input--mono', (node) => node.value);
check('the create dialog opens with that folder filled in', prefilled === plain, `${prefilled} vs ${plain}`);

await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('.modal-root')?.hidden === true, { timeout: 8000 });

console.log('\n\x1b[1m5. Console health\x1b[0m');
check('no console errors or uncaught exceptions', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
if (failed > 0) console.log(`\x1b[31mFailed:\x1b[0m ${problems.join('; ')}`);
process.exit(failed === 0 ? 0 : 1);
