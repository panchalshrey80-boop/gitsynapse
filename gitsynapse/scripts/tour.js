#!/usr/bin/env node
/**
 * Builds `ui-preview.html` — the standalone interface tour.
 *
 * The tour is one self-contained file so it can be opened straight from disk
 * with no server, no build step and no network. That means the screenshots are
 * embedded, and at full PNG size a dozen of them would be several megabytes, so
 * each is re-encoded to JPEG through the same headless browser the UI suite
 * uses. Encoding through Chrome keeps this script free of image dependencies.
 *
 * Branding, version and the provider table are read from the same sources the
 * app uses (`package.json`, the provider registry), so the tour cannot claim a
 * name or a model the app does not ship.
 *
 * Usage:  npm run tour
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROVIDERS, DEFAULT_PROVIDER_ID } from '../src/server/ai/providers.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shotsDir = path.join(root, 'screenshots');
const outFile = path.join(root, 'ui-preview.html');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

/** The tour, in reading order. Filenames match what the suites write. */
const CARDS = [
  {
    file: '01-welcome.png',
    title: 'Welcome screen',
    body: 'Says what it is, what it needs, and offers exactly one way in. Git is '
      + 'located on first run, and the version it found is shown in the status bar '
      + 'rather than discovered later.',
  },
  {
    file: '02-changes-diff.png',
    title: 'Working tree',
    body: 'Staged and unstaged changes are separated, and the diff renders beside '
      + 'the file list. Staging, unstaging and committing are one control each — no '
      + 'command syntax anywhere in the interface.',
  },
  {
    file: '10-hidden-files.png',
    title: 'Build and OS noise, filtered',
    body: 'Untracked clutter such as <code>.DS_Store</code>, <code>__pycache__</code> '
      + 'and editor swap files is collapsed into a single row with a count. It is '
      + 'still recorded — expanding the row lists the files, and the ignore action '
      + 'writes the canonical patterns to <code>.gitignore</code>. Tracked files are '
      + 'never hidden, whatever they are named.',
  },
  {
    file: '03-history.png',
    title: 'History',
    body: 'The commit graph with refs marked. Merges are labelled rather than '
      + 'silently reported as empty, which is what a plain <code>git show</code> on a '
      + 'merge would do.',
  },
  {
    file: '04-branches.png',
    title: 'Branches',
    body: 'Local and remote branches, with the current one marked. Checkout is one '
      + 'click; anything that would lose work is refused with the reason.',
  },
  {
    file: '05-copilot-error.png',
    title: 'When the copilot fails',
    body: 'A provider outage produces this: which provider failed, why, and whether '
      + 'it is worth retrying. There is no state where the panel shows "Thinking…" '
      + 'with nothing behind it.',
  },
  {
    file: '06-settings.png',
    title: 'Settings',
    body: 'Pick one of five providers, paste that provider\'s key, test it, and '
      + 'choose a model. One key is kept per provider, so switching between them '
      + 'never means re-pasting. Keys are encrypted at rest and never leave the '
      + 'machine except to the provider they belong to.',
  },
  {
    file: '07-narrow.png',
    title: 'Narrow window',
    body: 'At 1024px the panels stop competing for width: the diff stacks under the '
      + 'file list, the commit controls keep their labels, and nothing overflows '
      + 'sideways.',
  },
  {
    file: '11-sidebar-collapsed.png',
    title: 'Collapsing the sidebar',
    body: 'The toolbar toggle — or <code>Ctrl+\\</code> — hides the sidebar entirely '
      + 'and gives the width to the work. The toggle lives in the top bar rather '
      + 'than inside the sidebar, so it stays reachable while the sidebar is gone.',
  },
  {
    file: '12-both-collapsed.png',
    title: 'Both panels collapsed',
    body: 'With the sidebar and the copilot both hidden, the list and the diff sit '
      + 'side by side even at 1024px. One rule drives it, because the two column '
      + 'widths are variables rather than fixed layouts.',
  },
  {
    file: '08-copilot-plan.png',
    title: 'A proposed plan',
    body: 'The copilot explains in prose and, when a task needs commands, attaches a '
      + 'plan. Each step shows the command and why. Steps the model marked safe but '
      + 'the server classified as writes are labelled as writes — the model\'s own '
      + 'risk label is never trusted.',
  },
  {
    file: '09-approval-sheet.png',
    title: 'Approval before running',
    body: 'Destructive steps are held for explicit confirmation and hostile ones are '
      + 'refused outright, even inside an approved plan. Execution stops at the '
      + 'first failure instead of continuing through a half-applied change.',
  },
];

/** Re-encodes one screenshot to a JPEG data URI, scaled to tour width. */
async function encode(page, file) {
  const source = path.join(shotsDir, file);
  if (!fs.existsSync(source)) {
    throw new Error(`missing screenshot ${file} — run "npm run test:ui" and "npm run shots" first`);
  }

  const dataUri = `data:image/png;base64,${fs.readFileSync(source).toString('base64')}`;
  return page.evaluate(async (uri) => {
    const image = new Image();
    // `decode()` rejects on data URIs in this Chrome build, so the load event is
    // the reliable signal that the pixels are available to draw.
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('the screenshot could not be decoded'));
      image.src = uri;
    });

    // Half resolution is plenty at this display size and keeps the file small
    // enough to open instantly.
    const scale = Math.min(1, 900 / image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { uri: canvas.toDataURL('image/jpeg', 0.74), width: image.naturalWidth }; // -> card.uri
  }, dataUri);
}

function providerRows() {
  return PROVIDERS.map((provider) => {
    const badge = provider.id === DEFAULT_PROVIDER_ID ? ' <em>(default)</em>' : '';
    const format = provider.protocol === 'anthropic' ? 'Messages API' : 'OpenAI-compatible';
    return `          <tr>
            <td><strong>${provider.label}</strong>${badge}</td>
            <td><code>${provider.keyPlaceholder}</code></td>
            <td><code>${provider.defaultModel}</code></td>
            <td>${format}</td>
          </tr>`;
  }).join('\n');
}

function buildHtml(cards) {
  const figures = cards.map((card) => `      <figure class="card">
        <figcaption class="card__head">
          <h2>${card.title}</h2>
          <p>${card.body}</p>
        </figcaption>
        <img src="${card.uri}" alt="${card.title}" width="${card.width}">
      </figure>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pkg.productName} ${version} — interface tour</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #14171b;
    --line: #24282e;
    --text: #e8eaed;
    --muted: #9aa3ae;
    --accent: #5b9dff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 24px 72px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 32px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -0.01em; }
  .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .version { color: var(--muted); font-weight: 400; }
  h1 { font-size: 26px; letter-spacing: -0.02em; margin: 18px 0 10px; }
  header p { color: var(--muted); margin: 0; max-width: 62ch; }
  .card {
    margin: 0 0 40px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  .card__head { padding: 18px 20px 16px; border-bottom: 1px solid var(--line); }
  .card__head h2 { font-size: 15px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .card__head p { margin: 0; color: var(--muted); font-size: 13.5px; max-width: 74ch; }
  .card img { display: block; width: 100%; height: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #cbd5e1; }
  h2.section { font-size: 15px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  em { color: var(--accent); font-style: normal; font-size: 12px; }
  .table-card { margin-bottom: 40px; }
  footer { color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 20px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand"><span class="dot"></span>${pkg.productName} <span class="version">${version}</span></div>
      <h1>Interface tour, before you download</h1>
      <p>Every screen below is a real capture of ${pkg.productName} ${version} running against a
      throwaway repository — not a mockup. The screenshots are produced by the same suites that
      gate the build.</p>
    </header>

    <section class="card table-card">
      <figcaption class="card__head">
        <h2 class="section">AI providers</h2>
        <p>Bring your own key. Mesh, OpenRouter, OpenAI, Anthropic and Groq are all first-class;
        the app speaks both the OpenAI format and Anthropic's Messages API natively. Model
        ids differ per vendor, and <strong>Load models</strong> lists what your key can reach.</p>
      </figcaption>
      ${''}
      <div style="padding: 4px 8px 12px">
        <table>
          <thead>
          <tr><th>Provider</th><th>Key</th><th>Default model</th><th>Wire format</th></tr>
          </thead>
          <tbody>
${providerRows()}
          </tbody>
        </table>
      </div>
    </section>

${figures}

    <footer>
      Built with HTML, CSS, JavaScript and Node.js. No framework, no build step, no telemetry.
      The installer is unsigned, so Windows SmartScreen will ask once — the SHA-256 of the build
      ships alongside it.
    </footer>
  </div>
</body>
</html>
`;
}

async function main() {
  console.log(`${pkg.productName} ${version} — building the interface tour`);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><title>encoder</title>');

    const cards = [];
    for (const card of CARDS) {
      const encoded = await encode(page, card.file);
      cards.push({ ...card, ...encoded });
      console.log(`  encoded ${card.file}`);
    }

    fs.writeFileSync(outFile, buildHtml(cards));
    const size = fs.statSync(outFile).size;
    console.log(`\nwrote ${path.relative(root, outFile)} (${Math.round(size / 1024)} KB, ${cards.length} screenshots)`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\x1b[31mtour failed:\x1b[0m ${error.message}`);
  process.exit(1);
});
