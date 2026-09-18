/**
 * Changes view: working tree, staged changes, conflicts and the diff pane.
 *
 * The layout follows the model every developer already has in their head —
 * unstaged on top, staged underneath, one file's diff on the right — because
 * inventing a new metaphor for staging is how GUIs become slower than the
 * command line they replace.
 */

import { api } from '../api.js';
import { askForIdentity, isIdentityFailure } from '../identity.js';
import { state, setState } from '../state.js';
import {
  clear, confirmDialog, h, mount, pathParts, shortPath, toast,
} from '../ui.js';

const nodes = {};
let onRefresh = () => {};

export function initChanges({ refresh } = {}) {
  nodes.groups = document.getElementById('file-groups');
  nodes.summary = document.getElementById('changes-summary');
  nodes.diffPane = document.getElementById('diff-pane');
  nodes.stageAll = document.getElementById('btn-stage-all');
  nodes.unstageAll = document.getElementById('btn-unstage-all');
  nodes.commitSubject = document.getElementById('commit-subject');
  nodes.commitBody = document.getElementById('commit-body');
  nodes.commitAmend = document.getElementById('commit-amend');
  nodes.commitButton = document.getElementById('btn-commit');
  nodes.stagedCount = document.getElementById('staged-count');
  nodes.draftButton = document.getElementById('btn-draft-message');

  if (refresh) onRefresh = refresh;

  nodes.stageAll?.addEventListener('click', () => runAction('stageAll', {}, 'Staged every change'));
  nodes.unstageAll?.addEventListener('click', () => runAction('unstageAll', {}, 'Unstaged everything'));
  nodes.commitButton?.addEventListener('click', commitChanges);
  nodes.draftButton?.addEventListener('click', draftMessage);

  nodes.commitSubject?.addEventListener('input', updateCommitButton);
  nodes.commitSubject?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commitChanges();
  });
}

/* ------------------------------------------------------------------ *
 * File list
 * ------------------------------------------------------------------ */

export function renderChanges() {
  const status = state.status;
  if (!nodes.groups) return;

  if (!status) {
    mount(nodes.groups, h('div.empty', {}, [
      h('div.empty__title', { text: 'No repository open' }),
      h('div.empty__body', { text: 'Open a folder to see its changes.' }),
    ]));
    return;
  }

  const conflicts = status.files.filter((file) => file.conflicted);
  const staged = status.files.filter((file) => file.staged && !file.conflicted);
  const unstaged = status.files.filter((file) => !file.staged && !file.untracked && !file.conflicted);
  const untracked = status.files.filter((file) => file.untracked);

  if (nodes.summary) {
    nodes.summary.textContent = status.clean
      ? 'clean'
      : `${status.files.length} changed`;
  }

  const sections = [
    { key: 'conflicts', title: 'Conflicts', files: conflicts, tone: 'danger' },
    { key: 'staged', title: 'Staged', files: staged },
    { key: 'unstaged', title: 'Changes', files: unstaged },
    { key: 'untracked', title: 'Untracked', files: untracked },
  ].filter((section) => section.files.length > 0);

  if (sections.length === 0) {
    mount(nodes.groups, h('div.empty', {}, [
      h('div.empty__title', { text: 'Working tree clean' }),
      h('div.empty__body', { text: 'Nothing to commit. Make a change, or ask the copilot to summarise where you are.' }),
    ]));
    // A tree whose only untracked files are noise is still worth telling the
    // user about, so the offer to ignore them survives the empty state.
    const cleanNoise = renderNoiseRow(status);
    if (cleanNoise) nodes.groups.append(cleanNoise);
    return;
  }

  clear(nodes.groups);

  for (const section of sections) {
    const group = h('div.file-group');
    group.append(h('div.file-group__head', {}, [
      h('span', { text: section.title }),
      h('span.count', { text: String(section.files.length) }),
      h('span.grow'),
      section.key === 'staged' && section.files.length > 1
        ? h('button.btn.btn--ghost.btn--small', {
            type: 'button',
            text: 'Unstage all',
            onClick: () => runAction('unstageAll', {}, 'Unstaged everything'),
          })
        : null,
    ]));

    for (const file of section.files) {
      group.append(renderFileRow(file, section.key));
    }

    nodes.groups.append(group);
  }

  const noiseRow = renderNoiseRow(status);
  if (noiseRow) nodes.groups.append(noiseRow);
}

/**
 * One row explaining the untracked files GitSynapse left out of the list, with the
 * action that stops them coming back.
 *
 * Nothing is hidden silently: the count is always shown, and one click writes
 * the standard patterns to .gitignore so git itself stops reporting them.
 *
 * @param {any} status
 * @returns {HTMLElement|null}
 */
function renderNoiseRow(status) {
  if (!status?.noiseCount) return null;

  const row = h('div.noise-row');

  const kinds = status.noise
    .map((entry) => entry.short || entry.label)
    .filter((label, index, all) => all.indexOf(label) === index);

  const summary = h('div.noise-row__text', {
    // The full paths, so nothing is hidden without a way to see it.
    title: `Ignored by GitSynapse:\n${status.noise.map((entry) => entry.path).join('\n')}`,
  }, [
    h('span.noise-row__count', { text: `${status.noiseCount} hidden` }),
    h('span.noise-row__kinds', { text: kinds.join(', ') }),
  ]);

  const button = h('button.btn.btn--ghost.btn--small', {
    type: 'button',
    text: 'Add ignores',
    title: 'Add these patterns to .gitignore so git stops reporting them',
    onClick: async () => {
      button.disabled = true;
      button.textContent = 'Adding…';
      try {
        const result = await api.ignoreJunk(state.repoPath);
        const count = result?.patterns ?? 0;
        toast({
          kind: 'ok',
          title: count > 0 ? `Added ${count} ignore rule${count === 1 ? '' : 's'}` : 'Already ignored',
          body: count > 0
            ? 'Review .gitignore and commit it when you are ready.'
            : 'Every pattern was already in .gitignore.',
          timeout: 6000,
        });
        await onRefresh();
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Add ignores';
        toast({ kind: 'error', title: 'Could not update .gitignore', body: error.message, timeout: 8000 });
      }
    },
  });

  row.append(summary, button);

  // Safari/Firefox style tooltip alternative is unnecessary: the title on the
  // text already lists the hidden paths, which is what a curious user wants.
  return row;
}

function renderFileRow(file, groupKey) {
  const { dir, name } = pathParts(file.path);
  const isSelected =
    state.selectedFile?.path === file.path &&
    state.selectedFile?.group === groupKey;

  const code = file.conflicted ? 'U' : file.untracked ? '?' : (file.index !== ' ' ? file.index : file.worktree);

  const row = h(`button.file-row${isSelected ? '.is-selected' : ''}`, {
    type: 'button',
    title: file.origPath ? `${file.origPath} → ${file.path}` : file.path,
    onClick: () => selectFile(file, groupKey),
  }, [
    h('span.file-row__code', { text: code.trim() || '•', dataset: { state: code.trim() || 'M' } }),
    h('span.file-row__path', {}, [
      dir ? h('span.file-row__dir', { text: dir }) : null,
      name,
    ]),
  ]);

  const actions = h('span.file-row__actions');

  if (groupKey === 'conflicts') {
    actions.append(
      iconButton('Use mine', 'undo', () => resolveConflict(file, 'ours')),
      iconButton('Use theirs', 'down', () => resolveConflict(file, 'theirs')),
      iconButton('Mark resolved', 'plus', () => resolveConflict(file, 'mark-resolved')),
    );
  } else if (groupKey === 'staged') {
    actions.append(
      iconButton('Unstage', 'minus', () => runAction('unstage', { files: [file.path] }, 'Unstaged', { silent: true })),
    );
  } else {
    actions.append(
      iconButton('Stage', 'plus', () => runAction('stage', { files: [file.path] }, 'Staged', { silent: true })),
      iconButton('Discard changes', 'undo', () => discard(file), 'icon-btn--danger'),
    );
  }

  row.append(actions);
  return row;
}

function iconButton(label, iconName, handler, extraClass = '') {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-4"/>',
    down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  };
  const button = h(`span.icon-btn${extraClass ? `.${extraClass}` : ''}`, {
    role: 'button',
    tabindex: '0',
    title: label,
    'aria-label': label,
    html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths[iconName]}</svg>`,
  });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      handler();
    }
  });

  return button;
}

/* ------------------------------------------------------------------ *
 * Diff pane
 * ------------------------------------------------------------------ */

export function selectFile(file, groupKey) {
  setState({ selectedFile: { path: file.path, group: groupKey, untracked: file.untracked || groupKey === 'untracked', conflicted: file.conflicted } });
  renderChanges();
  renderDiff();
}

export async function renderDiff() {
  const selection = state.selectedFile;
  const pane = nodes.diffPane;
  if (!pane) return;

  if (!selection) {
    mount(pane, h('div.empty', {}, [
      h('div.empty__title', { text: 'No file selected' }),
      h('div.empty__body', { text: 'Pick a file on the left to see its diff.' }),
    ]));
    return;
  }

  mount(pane, h('div.empty', {}, [
    h('div.empty__title', { text: 'Loading diff…' }),
  ]));

  try {
    const { diff } = await api.diff(state.repoPath, {
      file: selection.path,
      staged: selection.group === 'staged',
      untracked: selection.untracked,
    });

    renderDiffView(pane, {
      title: selection.path,
      lines: diff.lines,
      stats: diff.stats?.[selection.path],
      actions: buildDiffActions(selection),
      error: diff.error,
    });
  } catch (error) {
    mount(pane, h('div.empty', {}, [
      h('div.empty__title', { text: 'Could not read the diff' }),
      h('div.empty__body', { text: error.message }),
    ]));
  }
}

function buildDiffActions(selection) {
  const actions = h('div.diff-head__actions');

  if (selection.group === 'staged') {
    actions.append(h('button.btn.btn--small', {
      type: 'button',
      text: 'Unstage',
      onClick: () => runAction('unstage', { files: [selection.path] }, 'Unstaged', { refreshDiff: true }),
    }));
  } else if (!selection.conflicted) {
    actions.append(h('button.btn.btn--small', {
      type: 'button',
      text: 'Stage',
      onClick: () => runAction('stage', { files: [selection.path] }, 'Staged', { refreshDiff: true }),
    }));
  }

  if (!selection.conflicted && selection.group !== 'staged') {
    actions.append(h('button.btn.btn--danger.btn--small', {
      type: 'button',
      text: 'Discard',
      onClick: () => discard({ path: selection.path, untracked: selection.untracked }),
    }));
  }

  return actions;
}

/**
 * Renders parsed diff lines.
 * @param {HTMLElement} pane
 * @param {{title:string, lines:object[], stats?:object, actions?:Node, error?:string}} options
 */
export function renderDiffView(pane, { title, lines, stats, actions, error }) {
  const head = h('div.diff-head', {}, [
    h('span.diff-head__file', { title, text: shortPath(title, 90) }),
    stats
      ? h('span.file-row__stat', {}, [
          h('span.add', { text: `+${stats.additions ?? '−'}` }),
          h('span.del', { text: `−${stats.deletions ?? '−'}` }),
        ])
      : null,
    actions || null,
  ]);

  if (error) {
    mount(pane, head, h('div.empty', {}, [
      h('div.empty__title', { text: 'Diff unavailable' }),
      h('div.empty__body', { text: error }),
    ]));
    return;
  }

  if (!lines || lines.length === 0) {
    mount(pane, head, h('div.empty', {}, [
      h('div.empty__title', { text: 'No textual changes' }),
      h('div.empty__body', { text: 'The file may be binary, or the change is mode-only.' }),
    ]));
    return;
  }

  const body = h('div.diff-body');
  for (const line of lines) {
    body.append(h(`div.dl.dl--${line.type}`, {}, [
      h('span.dl__no', { text: line.oldLine ?? '' }),
      h('span.dl__no', { text: line.newLine ?? '' }),
      h('span.dl__text', { text: line.text }),
    ]));
  }

  mount(pane, head, body);
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

async function runAction(action, params, successMessage, options = {}) {
  if (!state.repoPath) return null;

  try {
    const result = await api.action(action, { path: state.repoPath, ...params });
    if (successMessage && !options.silent) {
      toast({ kind: 'ok', title: successMessage, body: result.command, timeout: 2600 });
    }
    await onRefresh();
    if (options.refreshDiff && state.selectedFile) {
      // The diff may no longer exist (e.g. the change was staged away).
      const stillPresent = state.status?.files.some((file) => file.path === state.selectedFile.path);
      if (stillPresent) await renderDiff();
      else {
        setState({ selectedFile: null });
        await renderDiff();
      }
    }
    return result;
  } catch (error) {
    toast({ kind: 'error', title: 'That did not work', body: error.message });
    return null;
  }
}

async function discard(file) {
  const isUntracked = Boolean(file.untracked);

  const approved = await confirmDialog({
    title: isUntracked ? 'Delete this untracked file?' : 'Discard local changes?',
    sub: isUntracked
      ? 'The file is not tracked by git, so it will be deleted from disk and cannot be recovered from GitSynapse.'
      : 'Your edits to this file will be replaced by the last committed version. This cannot be undone from GitSynapse.',
    body: h('div', {}, [
      h('div.cmd', { text: isUntracked ? `clean --force -- ${file.path}` : `restore --worktree -- ${file.path}` }),
    ]),
    confirmLabel: isUntracked ? 'Delete file' : 'Discard changes',
    tone: 'danger',
  });

  if (!approved) return;

  await runAction('discard', { file: file.path, untracked: isUntracked }, isUntracked ? 'File deleted' : 'Changes discarded');
  if (state.selectedFile?.path === file.path) {
    setState({ selectedFile: null });
    await renderDiff();
  }
}

async function resolveConflict(file, strategy) {
  const labels = { ours: 'your version', theirs: 'their version', 'mark-resolved': 'the current content' };
  try {
    await api.action('resolveConflict', { path: state.repoPath, file: file.path, strategy });
    toast({ kind: 'ok', title: `Kept ${labels[strategy]}`, body: file.path });
    await onRefresh();
    if (state.selectedFile?.path === file.path) await renderDiff();
  } catch (error) {
    toast({ kind: 'error', title: 'Could not resolve', body: error.message });
  }
}

/* ------------------------------------------------------------------ *
 * Commit box
 * ------------------------------------------------------------------ */

function updateCommitButton() {
  if (!nodes.commitButton) return;
  const hasMessage = (nodes.commitSubject?.value || '').trim().length > 0;
  const stagedCount = state.status?.stagedCount ?? 0;
  const amending = Boolean(nodes.commitAmend?.checked);

  nodes.commitButton.disabled = state.busy || !hasMessage || (stagedCount === 0 && !amending);

  if (nodes.stagedCount) {
    nodes.stagedCount.textContent = stagedCount === 0
      ? (amending ? 'amending HEAD' : 'nothing staged')
      : `${stagedCount} staged`;
  }
}

export function syncCommitBox() {
  updateCommitButton();
}

async function commitChanges() {
  const subject = (nodes.commitSubject?.value || '').trim();
  const body = (nodes.commitBody?.value || '').trim();
  if (!subject) return;

  const message = body ? `${subject}\n\n${body}` : subject;
  const amend = Boolean(nodes.commitAmend?.checked);
  const stagedCount = state.status?.stagedCount ?? 0;

  if (stagedCount === 0 && !amend) {
    const approved = await confirmDialog({
      title: 'Nothing is staged',
      sub: 'Stage every change in the working tree and commit it in one step?',
      body: h('div', {}, [h('div.cmd', { text: 'add --all && commit -m "<message>"' })]),
      confirmLabel: 'Stage all and commit',
    });
    if (!approved) return;
  }

  setState({ busy: true });
  nodes.commitButton.disabled = true;
  nodes.commitButton.textContent = 'Committing…';

  try {
    const result = await commitWithIdentityHelp({
      path: state.repoPath,
      message,
      amend,
      stageAllFirst: stagedCount === 0 && !amend,
    });

    nodes.commitSubject.value = '';
    nodes.commitBody.value = '';
    if (nodes.commitAmend) nodes.commitAmend.checked = false;

    toast({ kind: 'ok', title: amend ? 'Commit amended' : 'Commit created', body: subject });
    void result;
    await onRefresh();
  } catch (error) {
    toast({ kind: 'error', title: 'Commit failed', body: error.message });
  } finally {
    setState({ busy: false });
    nodes.commitButton.textContent = 'Commit';
    updateCommitButton();
  }
}

/**
 * Commits, and if git refuses because it has no identity, asks for one and
 * tries again. A beginner on a fresh machine hits exactly this, and the retry
 * means the first commit still only takes one attempt from their side.
 */
async function commitWithIdentityHelp(params) {
  try {
    return await api.action('commit', params);
  } catch (error) {
    if (!isIdentityFailure(error)) throw error;

    const identity = await askForIdentity({
      reason: 'Git would not record this commit because no name or email is configured on this machine.',
    });
    if (!identity) throw error;

    return api.action('commit', params);
  }
}

async function draftMessage() {
  if (!state.repoPath) return;

  nodes.draftButton.disabled = true;
  const original = nodes.draftButton.textContent;
  nodes.draftButton.textContent = 'Drafting…';

  try {
    const { message } = await api.commitMessage(state.repoPath);
    const [subject, ...rest] = message.split('\n');
    if (nodes.commitSubject) nodes.commitSubject.value = subject.slice(0, 200);
    if (nodes.commitBody) nodes.commitBody.value = rest.join('\n').trim();
    updateCommitButton();
    toast({ kind: 'ok', title: 'Draft ready', body: 'Edit it before committing — the copilot only saw the diff.', timeout: 4000 });
  } catch (error) {
    toast({ kind: 'error', title: 'Could not draft a message', body: error.message });
  } finally {
    nodes.draftButton.disabled = false;
    nodes.draftButton.textContent = original;
  }
}
