/**
 * Application bootstrap.
 *
 * Owns the shell: navigation, the refresh cycle, the status bar and keyboard
 * shortcuts. Views own their own DOM; this module only tells them when to
 * re-read state.
 */

import { api, ApiError } from './api.js';
import { state, setState, subscribe } from './state.js';
import { h, mount, toast } from './ui.js';
import { initChat, refreshGreeting, focusComposer, updateModelPill } from './chat.js';
import { initChanges, renderChanges, renderDiff, syncCommitBox } from './views/changes.js';
import { initHistory, renderHistory, renderCommitDetail } from './views/history.js';
import { chooseRepository, initPicker, openRepo, renderWelcomeMeta } from './views/picker.js';
import { initRefs, renderBranches, renderStash, renderTags, pushBranchDialog } from './views/refs.js';
import { initSettings, openSettings } from './settings.js';

/**
 * Refresh coordination. A copilot plan can finish several commands in a row,
 * so status reads are de-duplicated rather than queued up behind each other.
 */
let inFlight = null;
let rerunRequested = false;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  await primeEnvironment();

  initPicker({ onRepoOpened: handleRepoOpened, onRepoClosed: handleRepoClosed });
  initChat({ onRepoChange: () => refresh({ force: true }) });
  initChanges({ refresh: () => refresh({ force: true }) });
  initHistory({ refresh: () => refresh({ force: true }) });
  initRefs({ refresh: () => refresh({ force: true }) });
  initSettings();

  wireNav();
  wireTopbar();
  wireShortcuts();
  subscribe(paintStatusBar);
  renderRecentRepos();

  // Reopen the last repository so the app picks up where the user left off.
  const lastRepo = state.settings?.lastRepo;
  if (lastRepo) {
    try {
      const repo = await api.openRepo(lastRepo);
      await handleRepoOpened(repo, { silent: true });
      return;
    } catch {
      // The folder moved or was deleted; fall back to the welcome screen.
    }
  }

  showView('welcome');
}

async function primeEnvironment() {
  try {
    const [gitInfo, settings] = await Promise.all([api.systemInfo(), api.aiSettings()]);
    setState({ gitInfo, settings });
    renderWelcomeMeta(gitInfo);
    updateModelPill();

    if (!gitInfo.git.found) {
      toast({
        kind: 'error',
        title: 'Git was not found',
        body: gitInfo.git.note || 'Install Git and restart GitSynapse.',
        timeout: 0,
      });
    }
  } catch (error) {
    showServerDown(error);
  }
}

/** Shown when index.html is opened without the local server running. */
function showServerDown(error) {
  const isUnreachable = error instanceof ApiError && error.code === 'server_unreachable';
  mount(document.getElementById('workspace'), h('div.welcome', {}, [
    h('h1.welcome__title', { text: isUnreachable ? 'GitSynapse server is not running' : 'Startup failed' }),
    h('p.welcome__body', {
      text: isUnreachable
        ? 'This page is the interface; it needs the local server to reach git and your AI provider. Close this window and start the app, or run "npm start" in the project folder and open the address it prints.'
        : error.message,
    }),
    isUnreachable
      ? h('div', { style: { marginTop: '8px' } }, [
          h('div.cmd', { text: 'cd gitsynapse && npm start' }),
        ])
      : null,
  ]));
}

/* ------------------------------------------------------------------ *
 * Repository lifecycle
 * ------------------------------------------------------------------ */

async function handleRepoOpened(repo, options = {}) {
  setState({
    repoPath: repo.path,
    repoName: repo.name,
    status: repo.status,
    operationState: repo.operationState,
    remotes: repo.remotes,
    selectedFile: null,
    selectedCommit: null,
  });

  if (!options.silent) refreshGreeting();
  renderRecentRepos();
  showView(state.view === 'welcome' ? 'changes' : state.view);
  await refresh({ force: true });
  updateModelPill();
}

/**
 * Returns to the welcome screen. The repository stays on disk and stays in the
 * recent list; only the server's "reopen this next launch" pointer is cleared.
 */
async function handleRepoClosed() {
  setState({
    repoPath: null,
    repoName: '',
    status: null,
    operationState: { inProgress: null },
    remotes: [],
    selectedFile: null,
    selectedCommit: null,
  });

  // paintTopbar bails out without a status, so the chrome is reset here.
  const nameEl = document.getElementById('repo-chip-text');
  if (nameEl) nameEl.textContent = 'No repository open';
  const repoButton = document.getElementById('repo-chip');
  if (repoButton) repoButton.title = 'Open a repository (Ctrl+O)';
  const cluster = document.getElementById('sync-cluster');
  if (cluster) cluster.hidden = true;

  showView('welcome');
  paintStatusBar();
  await renderRecentRepos();
  toast({ kind: 'info', title: 'Repository closed', body: 'Open one, or create a new one, from this screen.', timeout: 4000 });
}

async function refresh({ force = false } = {}) {
  if (!state.repoPath) return undefined;

  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }

  inFlight = readRepository();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }

  if (rerunRequested) {
    rerunRequested = false;
    await refresh({ force: true });
  }

  void force;
  return undefined;
}

/** Reads status and repaints. Never runs twice at once. */
async function readRepository() {
  try {
    const { status, operationState } = await api.status(state.repoPath);
    setState({ status, operationState });

    paintTopbar();
    paintStatusBar();
    paintNavCounts();
    await renderActiveView();
  } catch (error) {
    if (error.code === 'not_a_repository') {
      toast({ kind: 'error', title: 'Repository no longer available', body: state.repoPath });
      setState({ repoPath: null, status: null });
      showView('welcome');
      return;
    }
    toast({ kind: 'error', title: 'Could not read the repository', body: error.message });
  }
}

async function renderActiveView() {
  const view = state.view;

  if (view === 'changes') {
    renderChanges();
    syncCommitBox();
    await renderDiff();
    return;
  }

  if (view === 'history') {
    await renderHistory();
    await renderCommitDetail();
    return;
  }

  if (view === 'branches') return renderBranches();
  if (view === 'stash') return renderStash();
  if (view === 'tags') return renderTags();

  return undefined;
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function wireNav() {
  document.getElementById('nav')?.addEventListener('click', (event) => {
    const button = event.target.closest('.nav__item');
    if (!button) return;
    showView(button.dataset.view);
  });
}

function wireTopbar() {
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    refresh({ force: true });
    toast({ kind: 'info', title: 'Refreshed', timeout: 1400 });
  });

  const app = document.getElementById('app');

  // Left panel. The button lives in the top bar, so it is still on screen (and
  // still labelled) while the sidebar is hidden — no separate floating launcher
  // is needed, and there is no state where the panel cannot be brought back.
  const sidebarToggle = document.getElementById('btn-sidebar-toggle');
  sidebarToggle?.addEventListener('click', () => {
    const collapsed = app.classList.toggle('is-sidebar-collapsed');
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.title = `${collapsed ? 'Show' : 'Hide'} the sidebar (Ctrl+\\)`;
  });

  const collapse = document.getElementById('btn-collapse-chat');

  collapse?.addEventListener('click', () => {
    app.classList.toggle('is-copilot-collapsed');
    const collapsed = app.classList.contains('is-copilot-collapsed');

    let launcher = document.getElementById('copilot-launcher');
    if (collapsed && !launcher) {
      launcher = h('button.copilot-launcher', {
        id: 'copilot-launcher',
        type: 'button',
        onClick: () => {
          app.classList.remove('is-copilot-collapsed');
          launcher.remove();
          focusComposer();
        },
      }, [h('span.spark'), h('span', { text: 'Copilot' })]);
      document.body.append(launcher);
    } else if (!collapsed) {
      launcher?.remove();
    }
  });
}

function wireShortcuts() {
  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key === ',') {
      event.preventDefault();
      openSettings();
      return;
    }

    if (mod && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      document.getElementById('btn-collapse-chat')?.click();
      return;
    }

    // Ctrl+\  — Ctrl+B is already the copilot, and the sidebar is the panel
    // that frees up room for a diff, so it gets its own binding.
    if (mod && event.key === '\\') {
      event.preventDefault();
      document.getElementById('btn-sidebar-toggle')?.click();
      return;
    }

    // Ctrl+O stays the plain "open a repository" shortcut, matching the tooltip
    // on the repository chip. The sidebar "+" offers the other two ways to get
    // one, plus closing the current repository.
    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      void chooseRepository();
      return;
    }

    if (mod && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      if (state.repoPath) pushBranchDialog();
      return;
    }

    if (!typing && event.key === '/') {
      event.preventDefault();
      focusComposer();
      return;
    }

    if (!typing && event.key.toLowerCase() === 'r') {
      refresh({ force: true });
      return;
    }

    if (mod && event.key >= '1' && event.key <= '5') {
      event.preventDefault();
      const views = ['changes', 'history', 'branches', 'stash', 'tags'];
      showView(views[Number(event.key) - 1]);
    }
  });
}

export function showView(view) {
  if (view !== 'welcome' && !state.repoPath) view = 'welcome';
  setState({ view });

  document.querySelectorAll('.view').forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });

  document.querySelectorAll('.nav__item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === view);
    button.disabled = false;
  });

  if (view !== 'welcome') renderActiveView();
}

function paintTopbar() {
  const status = state.status;
  if (!status) return;

  const nameEl = document.getElementById('repo-chip-text');
  const branchName = document.getElementById('branch-name');
  const branchPill = document.getElementById('branch-pill');
  const aheadPill = document.getElementById('ahead-pill');
  const behindPill = document.getElementById('behind-pill');
  const cluster = document.getElementById('sync-cluster');

  // The name is what you scan for; the path is available on hover and in the
  // status bar. A truncated absolute path in the title bar reads as broken.
  if (nameEl) nameEl.textContent = state.repoName || state.repoPath;

  const repoButton = document.getElementById('repo-chip');
  if (repoButton) repoButton.title = `${state.repoPath}\nClick to open another repository (Ctrl+O)`;

  if (cluster) cluster.hidden = false;
  if (branchName) branchName.textContent = status.branch || 'detached';
  branchPill?.classList.toggle('is-detached', status.detached);

  if (aheadPill) {
    aheadPill.hidden = status.ahead === 0;
    const count = document.getElementById('ahead-count');
    if (count) count.textContent = String(status.ahead);
  }
  if (behindPill) {
    behindPill.hidden = status.behind === 0;
    const count = document.getElementById('behind-count');
    if (count) count.textContent = String(status.behind);
  }
}

function paintNavCounts() {
  const counter = document.getElementById('nav-count-changes');
  const status = state.status;
  if (!counter || !status) return;
  // An empty element hides itself; a "0" badge is noise.
  counter.textContent = status.files.length > 0 ? String(status.files.length) : '';
}

function paintStatusBar() {
  const git = document.getElementById('status-git');
  const policy = document.getElementById('status-policy');
  const message = document.getElementById('status-message');
  const duration = document.getElementById('status-duration');
  const status = state.status;

  if (git) {
    git.textContent = state.gitInfo?.git?.found
      ? `git ${state.gitInfo.git.version}`
      : 'git not found';
  }

  if (policy && state.settings) {
    policy.textContent = `confirm: ${state.settings.confirmPolicy}`;
  }

  if (message) {
    if (state.operationState?.inProgress) {
      message.textContent = `${state.operationState.inProgress} in progress`;
      message.className = 'statusbar__item is-error';
    } else if (status && !status.clean) {
      message.textContent = `${status.stagedCount} staged · ${status.unstagedCount} unstaged`;
      message.className = 'statusbar__item is-busy';
    } else if (status) {
      message.textContent = 'working tree clean';
      message.className = 'statusbar__item is-ok';
    } else {
      message.textContent = '';
      message.className = 'statusbar__item';
    }
  }

  if (duration) {
    duration.textContent = state.repoPath || '';
    duration.title = state.repoPath || '';
  }
}

async function renderRecentRepos() {
  const list = document.getElementById('recent-list');
  if (!list) return;

  const settings = await api.aiSettings().catch(() => null);
  const recent = settings?.recentRepos || [];
  if (settings) setState({ settings });

  if (recent.length === 0) {
    mount(list, h('div.recent-empty', {
      text: 'Nothing open yet.',
    }));
    return;
  }

  mount(list, recent.map((repoPath) => {
    const name = repoPath.split(/[/\\]/).filter(Boolean).pop() || repoPath;
    const isCurrent = repoPath === state.repoPath;

    return h(`button.recent-item${isCurrent ? '.is-current' : ''}`, {
      type: 'button',
      title: repoPath,
      onClick: () => openRepo(repoPath),
    }, [
      h('span.recent-item__dot'),
      h('span.recent-item__name', { text: name }),
    ]);
  }));
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

boot().catch((error) => {
  console.error(error);
  toast({ kind: 'error', title: 'GitSynapse failed to start', body: error.message, timeout: 0 });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason?.name === 'AbortError') return;
  console.error('Unhandled rejection:', reason);
});
