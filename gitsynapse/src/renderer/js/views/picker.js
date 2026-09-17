/**
 * Repository opening: folder browser, init and clone.
 *
 * The folder browser starts at a recent location and walks the filesystem one
 * level at a time. It exists because asking a non-technical user to type an
 * absolute path is a guaranteed support burden, and because a native dialog
 * needs a desktop shell that the browser build does not have.
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { h, icon, mount, openModal, toast } from '../ui.js';

let currentPath = null;
let onOpened = () => {};

/** True when running inside the Electron shell (see electron/preload.cjs). */
function hasNativePicker() {
  return Boolean(window.gitSynapseNative?.pickFolder);
}

export function initPicker({ onRepoOpened } = {}) {
  if (onRepoOpened) onOpened = onRepoOpened;

  const handlers = {
    'welcome-open': () => chooseRepository(),
    'welcome-init': () => initDialog(),
    'welcome-clone': () => cloneDialog(),
    'btn-open-repo': () => chooseRepository(),
    'repo-chip': () => chooseRepository(),
  };

  for (const [id, handler] of Object.entries(handlers)) {
    document.getElementById(id)?.addEventListener('click', handler);
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Uses the OS folder picker in the desktop build and the in-app browser
 * everywhere else. Both end at {@link openRepo}.
 */
export async function chooseRepository() {
  if (!hasNativePicker()) {
    await openRepoDialog();
    return;
  }

  const lastRepo = state.settings?.lastRepo || undefined;
  const chosen = await window.gitSynapseNative.pickFolder({
    title: 'Open a git repository',
    defaultPath: lastRepo,
  });

  if (chosen) await openRepo(chosen);
}

/* ------------------------------------------------------------------ *
 * In-app folder browser (browser build, and a fallback on desktop)
 * ------------------------------------------------------------------ */

export async function openRepoDialog() {
  const body = h('div');
  const list = h('div.picker__list');
  const pathLabel = h('div.picker__path', { text: '…' });
  const rootsBar = h('div.picker__roots');

  const handle = openModal({
    title: 'Open a repository',
    sub: 'Pick any folder inside a git repository — GitSynapse resolves up to the repository root.',
    body,
    wide: true,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Open this folder', value: 'open', tone: 'primary' },
    ],
  });

  if (hasNativePicker()) {
    body.append(h('div', { style: { marginBottom: '10px' } }, [
      h('button.btn.btn--primary.btn--small', {
        type: 'button',
        text: 'Use the system folder picker',
        onClick: async () => {
          const chosen = await window.gitSynapseNative.pickFolder({ title: 'Open a git repository' });
          if (chosen) {
            handle.close(null);
            await openRepo(chosen);
          }
        },
      }),
    ]));
  }

  body.append(
    rootsBar,
    h('div.picker__bar', {}, [
      h('button.btn.btn--small', { type: 'button', text: '↑ Up', onClick: () => currentPath && load(currentPath, '..') }),
      pathLabel,
    ]),
    list,
  );

  async function load(targetPath, relative) {
    list.replaceChildren(h('div.picker__entry', {}, [h('span.spinner'), h('span', { text: 'Loading…' })]));

    try {
      const listing = await api.fsList(relative ? `${targetPath}/${relative}` : targetPath);
      currentPath = listing.path;
      pathLabel.textContent = listing.path;
      pathLabel.title = listing.path;

      list.replaceChildren();

      if (listing.parent) {
        list.append(h('button.picker__entry', {
          type: 'button',
          onClick: () => load(listing.parent),
        }, [
          h('span', { html: icon('up').outerHTML }),
          h('span', { text: '..' }),
        ]));
      }

      if (listing.entries.length === 0) {
        list.append(h('div.picker__entry', { style: { color: 'var(--text-faint)', cursor: 'default' } }, [
          h('span', { text: 'No sub-folders here' }),
        ]));
      }

      for (const entry of listing.entries) {
        list.append(h(`button.picker__entry${entry.isRepo ? '.is-repo' : ''}${entry.hidden ? '.is-hidden' : ''}`, {
          type: 'button',
          onClick: () => load(entry.path),
        }, [
          h('span', { html: icon(entry.isRepo ? 'repo' : 'folder').outerHTML }),
          h('span.truncate', { text: entry.name }),
          entry.isRepo ? h('span.tag', { text: 'repository' }) : null,
        ]));
      }

      if (listing.isRepo) {
        list.prepend(h('div.picker__entry', { style: { color: 'var(--ok)', cursor: 'default' } }, [
          h('span', { text: `This folder is a git repository — click "Open this folder".` }),
        ]));
      }
    } catch (error) {
      list.replaceChildren(h('div.picker__entry', { style: { color: 'var(--del-text)' } }, [
        h('span', { text: `Cannot read that folder: ${error.message}` }),
      ]));
    }
  }

  try {
    const { roots } = await api.fsRoots();
    for (const root of roots.slice(0, 8)) {
      rootsBar.append(h('button.chip', {
        type: 'button',
        text: root.label,
        onClick: () => load(root.path),
      }));
    }
  } catch {
    // Roots are a shortcut only; the browser still works without them.
  }

  const start = await api.aiSettings().then((settings) => settings.lastRepo).catch(() => null);
  await load(start || '', null);

  const result = await handle.promise;
  if (result !== 'open' || !currentPath) return;

  await openRepo(currentPath);
}

export async function openRepo(path) {
  try {
    const repo = await api.openRepo(path);
    toast({
      kind: 'ok',
      title: `Opened ${repo.name}`,
      body: repo.status.clean
        ? `${repo.status.branch} · working tree clean`
        : `${repo.status.branch} · ${repo.status.files.length} change(s)`,
      timeout: 3200,
    });
    await onOpened(repo);
  } catch (error) {
    toast({
      kind: 'error',
      title: 'Could not open that folder',
      body: error.message,
      timeout: 7000,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Init and clone
 * ------------------------------------------------------------------ */

async function initDialog() {
  const pathInput = h('input.input.input--mono', {
    type: 'text',
    placeholder: 'C:\\Users\\you\\projects\\new-project',
    'data-autofocus': 'true',
  });
  const branchInput = h('input.input', { type: 'text', value: 'main' });

  const handle = openModal({
    title: 'Initialise a repository',
    sub: 'Creates a .git folder in an existing folder. Nothing on disk is modified beyond that.',
    body: h('div', {}, [
      h('div.field', {}, [
        h('label.field__label', { text: 'Folder' }),
        pathInput,
        h('div.field__hint', { text: 'The folder must already exist. Use the folder browser if you would rather not type a path.' }),
      ]),
      h('div.field', {}, [
        h('label.field__label', { text: 'Initial branch name' }),
        branchInput,
        h('div.field__hint', { text: 'git defaults to "master" unless told otherwise. "main" is the common convention.' }),
      ]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Initialise', value: 'init', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'init') return;

  try {
    const result = await api.action('init', {
      path: pathInput.value.trim(),
      initialBranch: branchInput.value.trim() || 'main',
    });
    if (!result.ok) throw new Error(result.stderr || 'git init failed.');
    await openRepo(pathInput.value.trim());
  } catch (error) {
    toast({ kind: 'error', title: 'Could not initialise', body: error.message, timeout: 7000 });
  }
}

async function cloneDialog() {
  const urlInput = h('input.input.input--mono', {
    type: 'text',
    placeholder: 'https://github.com/user/repo.git',
    'data-autofocus': 'true',
  });
  const parentInput = h('input.input.input--mono', {
    type: 'text',
    value: await api.aiSettings().then((settings) => settings.lastRepo).catch(() => ''),
    placeholder: 'C:\\Users\\you\\projects',
  });

  const handle = openModal({
    title: 'Clone a repository',
    sub: 'The folder name is taken from the URL. Git may ask for credentials through Git Credential Manager.',
    body: h('div', {}, [
      h('div.field', {}, [h('label.field__label', { text: 'URL' }), urlInput]),
      h('div.field', {}, [
        h('label.field__label', { text: 'Clone into' }),
        parentInput,
        h('div.field__hint', { text: 'An existing folder that will hold the new clone.' }),
      ]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Clone', value: 'clone', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'clone') return;

  const parent = parentInput.value.trim();
  try {
    toast({ kind: 'info', title: 'Cloning…', body: 'Large repositories can take a while.', timeout: 3000 });
    const result = await api.action('clone', { url: urlInput.value.trim(), parent });
    if (!result.ok) throw new Error(result.stderr || 'git clone failed.');

    // Derive the cloned folder name the same way the server does.
    const folder = urlInput.value.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop().replace(/\.git$/i, '');
    await openRepo(`${parent}/${folder}`);
  } catch (error) {
    toast({ kind: 'error', title: 'Clone failed', body: error.message, timeout: 9000 });
  }
}

export function renderWelcomeMeta(gitInfo) {
  const target = document.getElementById('welcome-git-status');
  if (!target || !gitInfo) return;

  mount(target, gitInfo.git.found
    ? h('span', {
        text: `Using git ${gitInfo.git.version}`,
        title: gitInfo.git.binary,
      })
    : h('span', { style: { color: 'var(--del-text)' }, text: gitInfo.git.note }));
}
