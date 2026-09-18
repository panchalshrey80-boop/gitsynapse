/**
 * Repository opening: folder browser, init and clone.
 *
 * The folder browser starts at a recent location and walks the filesystem one
 * level at a time. It exists because asking a non-technical user to type an
 * absolute path is a guaranteed support burden, and because a native dialog
 * needs a desktop shell that the browser build does not have.
 *
 * The browser is a reusable control rather than part of one dialog: the same
 * list appears when opening a repository, when initialising one and when
 * choosing where to clone. Browsing is the reliable way to name a folder, so it
 * is offered wherever a folder is asked for.
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { confirmDialog, h, icon, mount, openModal, toast } from '../ui.js';

let onOpened = () => {};
let onClosed = () => {};

/** True when running inside the Electron shell (see electron/preload.cjs). */
function hasNativePicker() {
  return Boolean(window.gitSynapseNative?.pickFolder);
}

export function initPicker({ onRepoOpened, onRepoClosed } = {}) {
  if (onRepoOpened) onOpened = onRepoOpened;
  if (onRepoClosed) onClosed = onRepoClosed;

  const handlers = {
    'welcome-open': () => chooseRepository(),
    'welcome-init': () => initDialog(),
    'welcome-clone': () => cloneDialog(),
    // The sidebar "+" asks the only sensible question once a repository is
    // already open: which of the three ways to get another one do you want?
    'btn-open-repo': () => addRepositoryDialog(),
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
 * The folder browser
 * ------------------------------------------------------------------ */

/**
 * Builds a browser control. Callers drop `element` into a dialog and call
 * `load()` with a starting folder; `path` then reflects whatever folder is on
 * screen, which is the folder the user means.
 *
 * @param {object} [options]
 * @param {(info: {path: string, positioning: boolean}) => void} [options.onNavigate]
 *   Called after each successful load — used to mirror the folder into a text
 *   field. `positioning` is true for a load that only puts the browser
 *   somewhere (the panel opening, the dialog starting), which is not the user
 *   choosing a folder.
 * @param {(path: string) => void} [options.onInitialise] When given, folders
 *   that are not repositories get a row offering to create one there. This must
 *   close the surrounding dialog first: only one modal exists at a time.
 */
function createBrowser({ onNavigate, onInitialise } = {}) {
  const rootsBar = h('div.picker__roots');
  const pathLabel = h('div.picker__path', { text: '…' });
  const list = h('div.picker__list');
  let current = null;
  let homePath = null;

  async function load(targetPath, relative, { positioning = false } = {}) {
    list.replaceChildren(h('div.picker__entry', {}, [h('span.spinner'), h('span', { text: 'Loading…' })]));

    try {
      // Navigate by handing the server the joined path: it owns path
      // normalisation, including Windows separators.
      const query = relative ? `${String(targetPath).replace(/[/\\]+$/, '')}/${relative}` : targetPath;
      const listing = await api.fsList(query);

      current = listing.path;
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
          h('span', { text: 'No sub-folders here. This folder itself can still be used.' }),
        ]));
      }

      for (const entry of listing.entries) {
        list.append(h(`button.picker__entry${entry.isRepo ? '.is-repo' : ''}${entry.hidden ? '.is-hidden' : ''}`, {
          type: 'button',
          title: entry.blocked ? 'GitSynapse is not allowed to read inside this folder.' : entry.path,
          onClick: () => load(entry.path),
        }, [
          h('span', { html: icon(entry.isRepo ? 'repo' : 'folder').outerHTML }),
          h('span.truncate', { text: entry.name }),
          entry.isRepo ? h('span.tag', { text: 'repository' }) : null,
          entry.blocked ? h('span.tag', { text: 'no access' }) : null,
        ]));
      }

      if (listing.isRepo) {
        list.prepend(h('div.picker__entry', { style: { color: 'var(--ok)', cursor: 'default' } }, [
          h('span', { text: 'This folder is a git repository.' }),
        ]));
      } else if (onInitialise) {
        list.prepend(h('button.picker__entry', {
          type: 'button',
          style: { color: 'var(--accent)' },
          onClick: () => onInitialise(listing.path),
        }, [
          h('span', { html: icon('plus').outerHTML }),
          h('span', { text: 'Create a new repository here' }),
        ]));
      }

      onNavigate?.({ path: listing.path, positioning });
    } catch (error) {
      // The server sends a readable reason (missing folder, macOS blocking
      // access, a file rather than a folder); showing it beats "Cannot read
      // that folder: undefined".
      current = null;
      list.replaceChildren(h('div.picker__entry', { style: { color: 'var(--del-text)', cursor: 'default' } }, [
        h('span', { text: error.message }),
      ]));
    }
  }

  const upButton = h('button.btn.btn--small', {
    type: 'button',
    text: '↑ Up',
    onClick: () => current && load(current, '..'),
  });

  const element = h('div', {}, [
    rootsBar,
    h('div.picker__bar', {}, [upButton, pathLabel]),
    list,
  ]);

  // Roots are a shortcut only; the browser works without them.
  void api.fsRoots().then(({ roots }) => {
    for (const root of roots.slice(0, 8)) {
      if (root.label === 'Home') homePath = root.path;
      rootsBar.append(h('button.chip', {
        type: 'button',
        text: root.label,
        onClick: () => load(root.path),
      }));
    }
  }).catch(() => {});

  return {
    element,
    list,
    load,
    get path() {
      return current;
    },
    get home() {
      return homePath;
    },
  };
}

/**
 * A collapsible browser that lives inside another dialog and mirrors the folder
 * on screen into `input`. Opening a second modal is not possible — there is one
 * modal root — so browsing happens in place rather than in a nested dialog.
 */
function inlineBrowser({ input, label = 'Browse…' }) {
  // A load that only positions the browser must not write into the field.
  // Otherwise opening the browser and pressing the primary button in quick
  // succession would act on wherever the browser happened to start — home, the
  // one folder nobody means to initialise.
  const browser = createBrowser({
    onNavigate: ({ path, positioning }) => {
      if (!positioning) input.value = path;
    },
  });
  browser.list.style.height = '200px';

  const toggle = h('button.btn.btn--small', {
    type: 'button',
    text: label,
    onClick: () => {
      const show = panel.hidden;
      panel.hidden = !show;
      toggle.textContent = show ? 'Hide browser' : label;
      // Position the browser without claiming the user chose that folder.
      if (show) void browser.load(input.value.trim() || browser.home || '', null, { positioning: true });
    },
  });

  const panel = h('div', { hidden: true, style: { marginTop: '8px' } }, [browser.element]);

  return h('div', {}, [toggle, panel]);
}

/** A labelled folder field with a browsing button underneath it. */
function folderField({ label, value, placeholder, hint, mono = true }) {
  const input = h(`input.input${mono ? '.input--mono' : ''}`, { type: 'text', value, placeholder });

  const field = h('div.field', {}, [
    h('label.field__label', { text: label }),
    input,
    hint ? h('div.field__hint', { text: hint }) : null,
    inlineBrowser({ input }),
  ]);

  return { input, field };
}

/* ------------------------------------------------------------------ *
 * Open a repository
 * ------------------------------------------------------------------ */

export async function openRepoDialog() {
  const browser = createBrowser({
    // Creating a repository from the browser is the flow a beginner wants:
    // find the project folder, see that git does not know about it yet, make
    // it a repository without retyping the path.
    onInitialise: (path) => {
      handle.close(null);
      void initDialog(path);
    },
  });

  const body = h('div');
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

  body.append(browser.element);

  const start = await api.aiSettings().then((settings) => settings.lastRepo).catch(() => null);
  await browser.load(start || browser.home || '', null, { positioning: true });

  const result = await handle.promise;
  if (result !== 'open' || !browser.path) return;

  await openRepo(browser.path);
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
    // A folder that simply has no repository yet is not a dead end: offer to
    // create one, which is what the user was about to ask for anyway.
    if (error.payload?.canInitialise) {
      const yes = await confirmInitialise(error.payload.path || path, error.message);
      if (yes) await initDialog(error.payload.path || path);
      return;
    }

    toast({
      kind: 'error',
      title: 'Could not open that folder',
      body: error.message,
      timeout: 7000,
    });
  }
}

function confirmInitialise(folder, message) {
  return confirmDialog({
    title: 'No repository in that folder yet',
    sub: message,
    body: `Create a new git repository in ${folder}? This adds a hidden .git folder and changes nothing else.`,
    confirmLabel: 'Create repository',
  });
}

/* ------------------------------------------------------------------ *
 * Add a repository (available while one is already open)
 * ------------------------------------------------------------------ */

/**
 * The welcome screen is not reachable once a repository is open, so the ways to
 * get a repository are offered from the sidebar instead. Without this there was
 * no route back to "Create a new repository" except restarting the app.
 */
async function addRepositoryDialog() {
  const actions = [
    { value: 'open', label: 'Open an existing repository…', sub: 'Browse for a folder that is already a git repository.' },
    { value: 'init', label: 'Create a new repository…', sub: 'Turn an existing folder into a git repository.' },
    { value: 'clone', label: 'Clone from a URL…', sub: 'Download a copy of a repository hosted somewhere else.' },
  ];

  if (state.repoPath) {
    actions.push({ value: 'close', label: 'Close the current repository', sub: state.repoPath, quiet: true });
  }

  const body = h('div', { style: { display: 'grid', gap: '8px' } });

  for (const action of actions) {
    body.append(h('button.btn', {
      type: 'button',
      style: {
        width: '100%',
        height: 'auto',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '2px',
        padding: '10px 12px',
        textAlign: 'left',
      },
      onClick: () => handle.close(action.value),
    }, [
      h('span', { text: action.label }),
      h('span', {
        style: { color: 'var(--text-4)', fontWeight: '400', fontSize: 'var(--fs-sm)' },
        text: action.sub,
      }),
    ]));
  }

  const handle = openModal({
    title: 'Repositories',
    sub: state.repoPath ? `Currently open: ${state.repoName || state.repoPath}` : '',
    body,
    actions: [{ label: 'Cancel', value: null }],
  });

  const result = await handle.promise;

  if (result === 'open') await chooseRepository();
  if (result === 'init') await initDialog();
  if (result === 'clone') await cloneDialog();
  if (result === 'close') await closeRepository();
}

/** Closes the open repository: the app returns to the welcome screen. */
async function closeRepository() {
  try {
    await api.closeRepo(state.repoPath);
  } catch {
    // Forgetting it is a convenience; failing to is not worth an error dialog.
  }
  await onClosed();
}

/* ------------------------------------------------------------------ *
 * Init and clone
 * ------------------------------------------------------------------ */

async function initDialog(startFolder = '') {
  const folder = folderField({
    label: 'Folder',
    value: startFolder,
    placeholder: 'C:\\Users\\you\\projects\\new-project',
    hint: 'The folder must already exist. Browse to it, or type the path — ~ means your home folder.',
  });
  folder.input.setAttribute('data-autofocus', 'true');

  const branchInput = h('input.input', { type: 'text', value: 'main' });

  const handle = openModal({
    title: 'Create a new repository',
    sub: 'Creates a .git folder in an existing folder. Nothing on disk is modified beyond that.',
    body: h('div', {}, [
      folder.field,
      h('div.field', {}, [
        h('label.field__label', { text: 'Initial branch name' }),
        branchInput,
        h('div.field__hint', { text: 'git defaults to "master" unless told otherwise. "main" is the common convention.' }),
      ]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Create repository', value: 'init', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'init') return;

  const target = folder.input.value.trim();
  try {
    const result = await api.action('init', {
      path: target,
      initialBranch: branchInput.value.trim() || 'main',
    });
    if (!result.ok) throw new Error(result.stderr || 'git init failed.');
    await openRepo(target);
  } catch (error) {
    toast({ kind: 'error', title: 'Could not create the repository', body: error.message, timeout: 9000 });
  }
}

async function cloneDialog() {
  const urlInput = h('input.input.input--mono', {
    type: 'text',
    placeholder: 'https://github.com/user/repo.git',
    'data-autofocus': 'true',
  });

  const parent = folderField({
    label: 'Clone into',
    value: await api.aiSettings().then((settings) => settings.lastRepo).catch(() => ''),
    placeholder: 'C:\\Users\\you\\projects',
    hint: 'An existing folder that will hold the new clone.',
  });

  const handle = openModal({
    title: 'Clone a repository',
    sub: 'The folder name is taken from the URL. Git may ask for credentials through Git Credential Manager.',
    body: h('div', {}, [
      h('div.field', {}, [h('label.field__label', { text: 'URL' }), urlInput]),
      parent.field,
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Clone', value: 'clone', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'clone') return;

  const parentPath = parent.input.value.trim();
  try {
    toast({ kind: 'info', title: 'Cloning…', body: 'Large repositories can take a while.', timeout: 3000 });
    const result = await api.action('clone', { url: urlInput.value.trim(), parent: parentPath });
    if (!result.ok) throw new Error(result.stderr || 'git clone failed.');

    // Derive the cloned folder name the same way the server does.
    const folder = urlInput.value.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop().replace(/\.git$/i, '');
    await openRepo(`${parentPath.replace(/[/\\]+$/, '')}/${folder}`);
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
