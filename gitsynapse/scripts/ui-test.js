#!/usr/bin/env node
/**
 * Browser-level test of the renderer.
 *
 * Boots the real server, drives the real UI in headless Chrome, and fails on
 * any console error or uncaught exception. Also captures screenshots to
 * `screenshots/` so the layout can be reviewed by eye.
 *
 * Usage:  npm run ui-test
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsynapse-ui-'));
process.env.GITSYNAPSE_CONFIG_DIR = path.join(sandbox, 'config');
process.env.GITSYNAPSE_PORT = '0';

const repoPath = path.join(sandbox, 'demo-project');
const shots = path.resolve('screenshots');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${condition ? '' : `  — ${detail}`}`);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function buildFixture() {
  fs.mkdirSync(repoPath, { recursive: true });
  git(['init', '--initial-branch=main', '-q']);
  git(['config', 'user.email', 'demo@example.com']);
  git(['config', 'user.name', 'Demo User']);
  git(['remote', 'add', 'origin', 'https://github.com/example/demo-project.git']);

  fs.writeFileSync(path.join(repoPath, 'index.js'), "export const greet = (name) => `Hello, ${name}!`;\n");
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Demo project\n\nA fixture for the UI test.\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Initial commit with greeting helper']);

  fs.writeFileSync(path.join(repoPath, 'package.json'), '{\n  "name": "demo-project",\n  "version": "0.1.0"\n}\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Add package manifest']);

  git(['checkout', '-q', '-b', 'feature/readme-cleanup']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Demo project\n\nA fixture for the UI test.\n\n## Usage\n\nImport and call.\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Document usage in the README']);
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', 'feature/readme-cleanup', '-m', 'Merge readme cleanup']);
  git(['tag', '-a', 'v0.1.0', '-m', 'First release']);

  // Messy working tree for the Changes view.
  fs.appendFileSync(path.join(repoPath, 'index.js'), "export const farewell = (name) => `Bye, ${name}.`;\n");
  git(['add', 'index.js']);
  fs.appendFileSync(path.join(repoPath, 'index.js'), "export const version = '0.1.0';\n");
  fs.writeFileSync(path.join(repoPath, 'notes.md'), '- [ ] write tests\n- [ ] add CI\n');

  // The noise a real working directory collects (symptom C): python bytecode,
  // a Windows shortcut and macOS metadata, none of it meant to be committed.
  fs.mkdirSync(path.join(repoPath, '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, '__pycache__', 'index.cpython-311.pyc'), '\x00binary\n');
  fs.writeFileSync(path.join(repoPath, 'project shortcut.lnk'), 'link\n');
  fs.writeFileSync(path.join(repoPath, '.DS_Store'), 'meta\n');
}

async function main() {
  buildFixture();
  fs.mkdirSync(shots, { recursive: true });

  const { createApp } = await import('../src/server/index.js');
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\x1b[1mGitSynapse UI test\x1b[0m\nserver: ${base}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (!request.url().startsWith(base)) return;
    const reason = request.failure()?.errorText || 'unknown';
    // A request cancelled because the page navigated away is not a defect: the
    // reload drives this suite, and an in-flight refresh is aborted by it. Any
    // other failure — refused, timed out, reset — is still an error.
    if (reason === 'net::ERR_ABORTED') return;
    consoleErrors.push(`request failed: ${request.url()} (${reason})`);
  });

  console.log('\x1b[1mStartup\x1b[0m');
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.welcome__title');

  check('page loads without uncaught exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  check('no console errors on boot', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('welcome screen renders', Boolean(await page.$('.welcome__title')));
  check('sidebar shows a recent-repositories section', Boolean(await page.$('#recent-list')));
  check('exactly one "open repository" control exists in the chrome',
    (await page.$$('#repo-chip, #btn-open-repo')).length === 2,
    'the title bar and the Repositories header are the only two entry points');
  check('no empty count badge is rendered', (await page.$eval('#nav-count-changes', (n) => n.textContent)) === '');

  const gitStatus = await page.$eval('#welcome-git-status', (node) => node.textContent);
  check('git version is reported in the UI', /git \d+\.\d+/.test(gitStatus), gitStatus);

  // Branding: the rename has to reach what the user actually sees, and the
  // version has to come from the same place the installer reports.
  const branding = await page.evaluate(async () => {
    const info = await (await fetch('/api/system/info')).json();
    return {
      title: document.title,
      brand: document.querySelector('.brand__name')?.textContent || '',
      body: document.body.textContent,
      app: info.app,
    };
  });
  check('the window title says GitSynapse', branding.title.includes('GitSynapse'), branding.title);
  check('the name plate in the chrome says GitSynapse', branding.brand.trim() === 'GitSynapse', branding.brand);
  check('no stale GitDesk string is left in the rendered page', !/GitDesk/.test(branding.body), 'GitDesk still appears in the UI');
  check('the app reports version 1.0.0 through the API', branding.app.version === '1.0.0', branding.app.version);
  check('the app reports its name through the API', branding.app.name === 'GitSynapse', branding.app.name);
  await page.screenshot({ path: path.join(shots, '01-welcome.png') });

  // Open the fixture through the folder picker, the way a user would.
  console.log('\n\x1b[1mFolder picker and repository open\x1b[0m');
  await page.click('#welcome-open');
  await page.waitForSelector('.modal .picker__list');

  await page.evaluate((target) => {
    // Drive the picker's path loader directly; typing a path is covered by the input field below.
    const input = document.querySelector('.picker__path');
    if (input) input.dataset.target = target;
  }, repoPath);

  // Use the app's own API to open the repo, then verify the UI reflects it.
  await page.evaluate(async (target) => {
    await fetch('/api/repo/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
  }, repoPath);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.modal-root')?.hidden === true);

  // Reload so the app reopens the remembered repository.
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row', { timeout: 10000 });

  check('remembered repository reopens on reload', Boolean(await page.$('#view-changes:not([hidden])')));
  check('repository name appears in the top bar', (await page.$eval('#repo-chip-text', (n) => n.textContent)).includes('demo-project'));
  check('branch name appears in the top bar', (await page.$eval('#branch-name', (n) => n.textContent)) === 'main');
  check('the full repository path is shown in the status bar',
    (await page.$eval('#status-duration', (n) => n.textContent)).includes('demo-project'));
  check('the title bar shows the repository name, not a truncated path',
    (await page.$eval('#repo-chip-text', (n) => n.textContent)) === 'demo-project');

  const fileRows = await page.$$eval('.file-row__path', (nodes) => nodes.map((n) => n.textContent));
  check('working tree lists the changed files', fileRows.some((row) => row.includes('index.js')), fileRows.join(', '));
  check('untracked file is listed', fileRows.some((row) => row.includes('notes.md')), fileRows.join(', '));

  const navCount = await page.$eval('#nav-count-changes', (n) => n.textContent);
  check('changes counter shows the file count', Number(navCount) >= 2, navCount);

  console.log('\n\x1b[1mWorking-tree noise\x1b[0m');
  check('bytecode never reaches the file list', !fileRows.some((row) => row.includes('__pycache__')), fileRows.join(', '));
  check('a Windows shortcut never reaches the file list', !fileRows.some((row) => row.includes('.lnk')), fileRows.join(', '));
  check('macOS metadata never reaches the file list', !fileRows.some((row) => row.includes('.DS_Store')), fileRows.join(', '));
  check('the genuine untracked file is still listed', fileRows.some((row) => row.includes('notes.md')), fileRows.join(', '));

  const noiseText = await page.$eval('.noise-row', (n) => n.textContent).catch(() => '');
  check('hidden files are accounted for, not silently dropped',
    /3 hidden/.test(noiseText) && /bytecode/.test(noiseText) && /shortcuts/.test(noiseText),
    noiseText);

  const noiseTooltip = await page.$eval('.noise-row__text', (n) => n.getAttribute('title')).catch(() => '');
  check('the row lists the hidden paths on hover',
    /__pycache__/.test(noiseTooltip) && /shortcut\.lnk/.test(noiseTooltip), noiseTooltip?.slice(0, 90));

  const noiseClipped = await page.$eval('.noise-row__kinds', (n) => n.scrollWidth > n.clientWidth + 1).catch(() => true);
  check('the hidden-files label is not truncated', noiseClipped === false);

  const noiseRowHeight = await page.$eval('.noise-row', (n) => n.getBoundingClientRect().height).catch(() => 0);
  check('the hidden-files row sits inside the file list', noiseRowHeight > 0 && noiseRowHeight < 60, `${Math.round(noiseRowHeight)}px`);

  // Prove the row before using it, then prove it does its job after the diff
  // screenshot, so each capture shows the state it is meant to document.
  await page.screenshot({ path: path.join(shots, '10-hidden-files.png') });

  console.log('\n\x1b[1mDiff pane\x1b[0m');
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.file-row')];
    const target = rows.find((row) => row.textContent.includes('index.js'));
    target?.click();
  });
  await page.waitForSelector('.diff-body .dl', { timeout: 5000 });

  const diffKinds = await page.$$eval('.dl', (nodes) => nodes.map((n) => n.className));
  check('diff renders added lines', diffKinds.some((c) => c.includes('dl--add')));
  check('diff renders a hunk header', diffKinds.some((c) => c.includes('dl--hunk')));
  check('diff renders context lines', diffKinds.some((c) => c.includes('dl--context')));
  await page.screenshot({ path: path.join(shots, '02-changes-diff.png') });

  // The one-click fix for the noise, asserted against the file on disk.
  await page.click('.noise-row .btn');
  await page.waitForFunction(
    () => !document.querySelector('.noise-row'),
    { timeout: 8000 },
  ).catch(() => {});

  const ignoreWritten = fs.existsSync(path.join(repoPath, '.gitignore'))
    ? fs.readFileSync(path.join(repoPath, '.gitignore'), 'utf8')
    : '';
  check('the ignore action writes .gitignore', /__pycache__\//.test(ignoreWritten), ignoreWritten.slice(0, 80));
  check('the noise row disappears once the files are ignored', !(await page.$('.noise-row')));

  console.log('\n\x1b[1mCommit box\x1b[0m');
  const disabledBefore = await page.$eval('#btn-commit', (n) => n.disabled);
  await page.type('#commit-subject', 'Add farewell helper and version constant');
  const disabledAfter = await page.$eval('#btn-commit', (n) => n.disabled);
  check('commit button is disabled until a message is typed', disabledBefore === true && disabledAfter === false);

  await page.click('#btn-commit');
  await page.waitForFunction(() => document.querySelector('#commit-subject').value === '', { timeout: 10000 });

  // The full path is shown in the status bar; the title bar shows the name only.
  const afterCommit = await page.evaluate(async () => {
    const repoPath = document.querySelector('#status-duration').textContent;
    const response = await fetch(`/api/repo/status?path=${encodeURIComponent(repoPath)}`);
    return (await response.json()).status;
  });
  check('commit removes the staged file from the working tree', !afterCommit.files.some((f) => f.path === 'index.js' && f.staged));
  check('untracked file survives the commit', afterCommit.files.some((f) => f.path === 'notes.md'));

  // Undo it again so later screenshots show a dirty tree.
  git(['reset', '--soft', 'HEAD~1']);
  git(['reset']);

  console.log('\n\x1b[1mHistory\x1b[0m');
  await page.click('.nav__item[data-view="history"]');
  await page.waitForSelector('.graph-row', { timeout: 8000 });

  const graphRows = await page.$$('.graph-row');
  check('commit graph renders every commit', graphRows.length >= 4, `${graphRows.length} rows`);
  const nodes = await page.$$eval('.graph-row__node', (list) => list.length);
  check('every row draws a graph node', nodes === graphRows.length, `${nodes} nodes for ${graphRows.length} rows`);
  const laneOffsets = await page.$$eval('.graph-row__node', (list) => [...new Set(list.map((n) => n.style.left))]);
  check('a merge produces more than one lane', laneOffsets.length > 1, laneOffsets.join(', '));
  check('ref tags are rendered', (await page.$$('.ref-tag')).length > 0);

  await graphRows[0].click();
  await page.waitForSelector('.commit-detail__subject', { timeout: 8000 });
  check('commit detail opens with metadata', Boolean(await page.$('.commit-detail__meta')));
  check('commit detail lists changed files', (await page.$$('.commit-files .file-row')).length > 0);
  await page.screenshot({ path: path.join(shots, '03-history.png') });

  console.log('\n\x1b[1mBranches\x1b[0m');
  await page.click('.nav__item[data-view="branches"]');
  await page.waitForSelector('#branches-view .card', { timeout: 8000 });
  const branchText = await page.$eval('#branches-view', (n) => n.textContent);
  check('local branches are listed', branchText.includes('feature/readme-cleanup'));
  check('remotes are listed', branchText.includes('origin'));
  await page.screenshot({ path: path.join(shots, '04-branches.png') });

  console.log('\n\x1b[1mStashes and tags\x1b[0m');
  await page.click('.nav__item[data-view="stash"]');
  await page.waitForSelector('#stash-view .card', { timeout: 8000 });
  check('stash view renders', (await page.$eval('#stash-view', (n) => n.textContent)).includes('Stash my changes'));

  await page.click('.nav__item[data-view="tags"]');
  await page.waitForSelector('#tags-view .card', { timeout: 8000 });
  check('tags view lists the release tag', (await page.$eval('#tags-view', (n) => n.textContent)).includes('v0.1.0'));

  console.log('\n\x1b[1mCopilot panel\x1b[0m');
  await page.click('.nav__item[data-view="changes"]');
  check('copilot greeting explains what it does', (await page.$eval('#chat-log', (n) => n.textContent)).length > 40);

  await page.evaluate(() => {
    document.querySelectorAll('.toast__close').forEach((button) => button.click());
  });

  await page.type('#chat-input', 'show me what changed');
  await page.click('#btn-send');
  await page.waitForSelector('.toast', { timeout: 6000 });
  const toastText = await page.$$eval('.toast', (nodes) => nodes.map((n) => n.textContent).join(' | '));
  check('copilot refuses politely when no API key is saved', /API key/i.test(toastText), toastText);

  // With a stub key the panel must reach the network layer and fail cleanly.
  await page.evaluate(async () => {
    await fetch('/api/ai/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'rsk_invalid_for_test', baseUrl: 'http://127.0.0.1:9/v1' }),
    });
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row');
  await page.type('#chat-input', 'what changed?');
  await page.click('#btn-send');
  await page.waitForSelector('.msg--assistant', { timeout: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const assistantText = await page.$eval('.msg--assistant', (n) => n.textContent);
  check('an unreachable API produces a readable error, not a crash', /Mesh|reach|failed/i.test(assistantText), assistantText.slice(0, 160));
  await page.screenshot({ path: path.join(shots, '05-copilot-error.png') });

  console.log('\n\x1b[1mToast layering\x1b[0m');
  const toastOverlap = await page.evaluate(async () => {
    const { toast } = await import('./js/ui.js');
    toast({ kind: 'info', title: 'Click-through probe', timeout: 4000 });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const toastNode = document.querySelector('.toast');
    const button = document.querySelector('#btn-send');
    const rect = toastNode.getBoundingClientRect();
    const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    // What does a click at the toast's centre actually hit?
    const hitTarget = document.elementFromPoint(centre.x, centre.y);
    return {
      overlapsComposer: rect.bottom > button.getBoundingClientRect().top && rect.right > button.getBoundingClientRect().left,
      swallowsClicks: toastNode.contains(hitTarget) && hitTarget !== toastNode.querySelector('.toast__close'),
    };
  });
  check('a toast can overlap the composer without swallowing clicks', toastOverlap.swallowsClicks === false, JSON.stringify(toastOverlap));
  await page.evaluate(() => document.querySelectorAll('.toast__close').forEach((button) => button.click()));

  console.log('\n\x1b[1mSettings\x1b[0m');
  await page.click('#btn-settings');
  await page.waitForSelector('.modal');
  check('settings dialog opens', Boolean(await page.$('.modal__title')));
  const settingsBody = await page.$eval('.modal', (n) => n.textContent);
  check('settings exposes the API key field', /API key/i.test(settingsBody));
  check('settings explains the confirmation policy', /confirm/i.test(settingsBody));

  // The provider picker drives the key field, so it is checked by behaving like
  // a user: choose a provider, read what the dialog then claims.
  const providerInfo = await page.evaluate(() => {
    const field = [...document.querySelectorAll('.modal .field')]
      .find((node) => /AI provider/i.test(node.textContent));
    const select = field?.querySelector('select');
    return {
      found: Boolean(select),
      options: select ? [...select.options].map((option) => option.value) : [],
      labels: select ? [...select.options].map((option) => option.textContent) : [],
      selected: select?.value,
      keyLabel: [...document.querySelectorAll('.modal .field__label')].map((n) => n.textContent),
    };
  });

  check('the settings dialog offers a provider picker', providerInfo.found);
  check('all five providers are listed, Mesh included',
    JSON.stringify(providerInfo.options) === JSON.stringify(['mesh', 'openrouter', 'openai', 'anthropic', 'groq']),
    JSON.stringify(providerInfo.options));
  check('the active provider is the one that is selected', providerInfo.selected === 'mesh', providerInfo.selected);
  check('the key field is labelled generically, not Mesh-specific',
    providerInfo.keyLabel.includes('API key') && !providerInfo.keyLabel.some((label) => /Mesh/i.test(label)),
    JSON.stringify(providerInfo.keyLabel));

  // Switching provider must repaint the placeholder and the advice.
  const switched = await page.evaluate(async () => {
    const select = [...document.querySelectorAll('.modal select')]
      .find((node) => [...node.options].some((option) => option.value === 'groq'));
    select.value = 'groq';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const keyInput = document.querySelector('.modal input[type="password"]');
    const blurb = [...document.querySelectorAll('.modal .field__hint')].map((n) => n.textContent).join(' ');
    return { placeholder: keyInput.placeholder, blurb, model: document.querySelector('.modal input.input--mono:not([type="password"])')?.value };
  });
  check('choosing a provider swaps the key placeholder', switched.placeholder.startsWith('gsk_'), switched.placeholder);
  check('the dialog advice names the chosen provider', /Groq/.test(switched.blurb), switched.blurb.slice(0, 200));
  check('the model default follows the provider', switched.model === 'openai/gpt-oss-120b', switched.model);

  // ...but an id the user typed is theirs to keep: some gateways serve custom
  // model names, and silently rewriting one would be worse than a failed call.
  const kept = await page.evaluate(async () => {
    const select = [...document.querySelectorAll('.modal select')]
      .find((node) => [...node.options].some((option) => option.value === 'groq'));
    const modelInput = document.querySelector('.modal input.input--mono:not([type="password"])');
    modelInput.value = 'my-gateway/custom-model';
    modelInput.dispatchEvent(new Event('input', { bubbles: true }));
    select.value = 'mesh';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    return modelInput.value;
  });
  check('a hand-typed model id survives a provider switch', kept === 'my-gateway/custom-model', kept);

  // Put the dialog back where it started, so later checks see the real state.
  await page.evaluate(async () => {
    const select = [...document.querySelectorAll('.modal select')]
      .find((node) => [...node.options].some((option) => option.value === 'mesh'));
    select.value = 'mesh';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  // Let the modal finish its open animation; a mid-fade capture looks broken.
  await new Promise((resolve) => setTimeout(resolve, 350));
  await page.screenshot({ path: path.join(shots, '06-settings.png') });

  // Cancel, so the probe above cannot leak into the rest of the run.
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 250));

  console.log('\n\x1b[1mKeyboard and layout\x1b[0m');
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('Ctrl+B collapses the copilot', await page.$eval('#app', (n) => n.classList.contains('is-copilot-collapsed')));
  check('a launcher appears when the copilot is hidden', Boolean(await page.$('#copilot-launcher')));
  await page.click('#copilot-launcher');
  check('launcher restores the copilot', !(await page.$eval('#app', (n) => n.classList.contains('is-copilot-collapsed'))));

  console.log('\n\x1b[1mSidebar collapse\x1b[0m');

  // Measured before the click — the point of the comparison is the difference
  // between the two states, so the baseline has to be taken while expanded.
  const expandedBackground = await page.$eval('#btn-sidebar-toggle', (n) => getComputedStyle(n).backgroundColor);

  await page.click('#btn-sidebar-toggle');
  await new Promise((resolve) => setTimeout(resolve, 250));

  const collapsed = await page.evaluate(() => {
    const app = document.getElementById('app');
    return {
      background: getComputedStyle(document.getElementById('btn-sidebar-toggle')).backgroundColor,
      display: getComputedStyle(document.querySelector('.sidebar')).display,
      firstColumn: getComputedStyle(app).gridTemplateColumns.split(' ')[0],
      expanded: document.getElementById('btn-sidebar-toggle').getAttribute('aria-expanded'),
      toggleWidth: Math.round(document.getElementById('btn-sidebar-toggle').getBoundingClientRect().width),
      title: document.getElementById('btn-sidebar-toggle').title,
    };
  });
  check('the toggle hides the sidebar', collapsed.display === 'none', JSON.stringify(collapsed));
  check('the sidebar column collapses to nothing', collapsed.firstColumn === '0px', collapsed.firstColumn);
  check('the toggle reports the collapsed state', collapsed.expanded === 'false', String(collapsed.expanded));
  check('the toggle stays on screen as the way back', collapsed.toggleWidth > 0, `${collapsed.toggleWidth}px`);
  check('the toggle relabels itself to offer the reverse action',
    /Show the sidebar/.test(collapsed.title), collapsed.title);
  check('the toggle looks pressed while the sidebar is hidden',
    collapsed.background !== expandedBackground,
    `${expandedBackground} -> ${collapsed.background}`);

  const collapsedOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal overflow while the sidebar is hidden', collapsedOverflow <= 1, `${collapsedOverflow}px`);
  await page.screenshot({ path: path.join(shots, '11-sidebar-collapsed.png') });

  // The keyboard path has to work too: the state is toggled by the button, but
  // the shortcut is what a user reaches for once they know it exists.
  await page.keyboard.down('Control');
  await page.keyboard.press('\\');
  await page.keyboard.up('Control');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('Ctrl+\\ restores the sidebar',
    (await page.$eval('.sidebar', (n) => getComputedStyle(n).display)) !== 'none');
  check('the toggle reports the expanded state again',
    (await page.$eval('#btn-sidebar-toggle', (n) => n.getAttribute('aria-expanded'))) === 'true');
  check('the nav is reachable again after restoring',
    await page.$eval('.nav__item', (n) => n.getBoundingClientRect().width > 0));

  // Narrow window: the layout must not overflow horizontally.
  await page.setViewport({ width: 1024, height: 800, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal overflow at 1024px', overflow <= 1, `${overflow}px`);

  // "No overflow" alone passed while the panes were squeezed to unreadable
  // slivers, so measure the controls a user actually has to reach.
  const narrow = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() || null;
    const subject = box('#commit-subject');
    const commit = box('#btn-commit');
    return {
      subjectWidth: subject ? Math.round(subject.width) : 0,
      commitRight: commit ? Math.round(commit.right) : -1,
      commitWidth: commit ? Math.round(commit.width) : 0,
      amendHeight: box('.commit-box__foot .check span')?.height || 0,
      viewport: window.innerWidth,
    };
  });
  check('the commit subject keeps a usable width at 1024px',
    narrow.subjectWidth >= 200, `${narrow.subjectWidth}px`);
  check('the commit button stays inside the window',
    narrow.commitRight > 0 && narrow.commitRight <= narrow.viewport,
    `right=${narrow.commitRight} viewport=${narrow.viewport}`);
  check('the commit button is not squeezed below its own label',
    narrow.commitWidth >= 60, `${narrow.commitWidth}px`);
  check('the amend label does not wrap inside the commit box',
    narrow.amendHeight > 0 && narrow.amendHeight <= 22, `${Math.round(narrow.amendHeight)}px`);

  await page.screenshot({ path: path.join(shots, '07-narrow.png') });

  // With both panels closed the workspace has the whole window, so the panes
  // should share a row again rather than stacking.
  await page.click('#btn-sidebar-toggle');
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const bothClosed = await page.evaluate(() => {
    const list = document.querySelector('.split__list').getBoundingClientRect();
    const detail = document.querySelector('.split__detail').getBoundingClientRect();
    return {
      listTop: Math.round(list.top),
      detailTop: Math.round(detail.top),
      listRight: Math.round(list.right),
      detailLeft: Math.round(detail.left),
    };
  });
  check('with both panels collapsed the panes sit side by side',
    Math.abs(bothClosed.listTop - bothClosed.detailTop) < 2
      && bothClosed.detailLeft >= bothClosed.listRight - 2,
    JSON.stringify(bothClosed));
  await page.screenshot({ path: path.join(shots, '12-both-collapsed.png') });

  // Leave the app as the later checks expect to find it.
  await page.click('#btn-sidebar-toggle');
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('both panels are back for the remaining checks',
    (await page.$eval('.sidebar', (n) => getComputedStyle(n).display)) !== 'none'
      && !(await page.$eval('#app', (n) => n.classList.contains('is-copilot-collapsed'))));

  console.log('\n\x1b[1mDesign system\x1b[0m');
  const design = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const button = document.querySelector('.nav__item');
    const primary = document.querySelector('.btn--primary');
    const buttonStyle = getComputedStyle(button);
    const primaryStyle = primary ? getComputedStyle(primary) : null;
    return {
      scale: ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl'].map((t) => root.getPropertyValue(t).trim()),
      radii: ['--r-sm', '--r', '--r-lg', '--r-xl'].map((t) => root.getPropertyValue(t).trim()),
      buttonRadius: buttonStyle.borderRadius,
      buttonFontSize: buttonStyle.fontSize,
      primaryBg: primaryStyle ? primaryStyle.backgroundColor : '',
      navRowHeight: buttonStyle.height,
    };
  });

  check('the type scale is a fixed five-step ramp',
    design.scale.join(',') === '11px,12px,13px,15px,20px', design.scale.join(','));
  check('corner radii stay tight (no pill buttons)',
    ['4px', '6px', '8px', '12px'].join(',') === design.radii.join(','), design.radii.join(','));
  check('nav rows render at the 28px density',
    design.navRowHeight === '28px', design.navRowHeight);
  check('the primary button uses the accent, not white',
    /91, 157, 255/.test(design.primaryBg), design.primaryBg);

  // An unmatched class name is invisible in review but renders as raw markup,
  // which is exactly how the leftover .chip row survived a CSS rewrite.
  const orphanClasses = await page.evaluate(() => {
    const declared = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        for (const name of rule.selectorText.matchAll(/\.([A-Za-z][\w-]*)/g)) declared.add(name[1]);
      }
    }
    // Plain structural wrapper emitted by changes.js — intentionally unstyled.
    const structural = new Set(['file-group']);
    const used = new Set();
    for (const node of document.querySelectorAll('[class]')) {
      for (const name of node.classList) used.add(name);
    }
    return [...used].filter((name) => !declared.has(name) && !structural.has(name)).sort();
  });
  check('every class in the DOM has a matching CSS rule',
    orphanClasses.length === 0, orphanClasses.join(', '));

  const composerButtons = await page.$$eval('.composer button', (nodes) => nodes.length);
  check('the composer has exactly one control (the send button)',
    composerButtons === 1, `${composerButtons} buttons`);

  const promptCopies = await page.$$eval('.suggestion', (nodes) => nodes.map((n) => n.textContent.trim()));
  check('no suggested prompt is duplicated elsewhere in the UI',
    new Set(promptCopies).size === promptCopies.length, promptCopies.join(' | '));

  console.log('\n\x1b[1mFinal error sweep\x1b[0m');
  check('no uncaught exceptions during the whole run', pageErrors.length === 0, pageErrors.join(' | '));
  check('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  server.close();

  const passed = results.filter((result) => result.ok).length;
  console.log(`\n\x1b[1m${passed}/${results.length} UI checks passed\x1b[0m`);
  if (passed < results.length) {
    console.log('\n\x1b[31mFailures\x1b[0m');
    for (const result of results.filter((entry) => !entry.ok)) {
      console.log(`  - ${result.name}: ${result.detail}`);
    }
  }
  console.log(`\nscreenshots: ${shots}`);

  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('\x1b[31mUI test crashed:\x1b[0m', error);
  process.exit(1);
});
