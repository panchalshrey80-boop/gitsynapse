/**
 * History view: commit graph, commit detail, and the operations you actually
 * need from a log — inspect, explain, cherry-pick, revert, reset, branch from
 * here. Anything that rewrites history is flagged as destructive and goes
 * through the confirmation sheet.
 */

import { api } from '../api.js';
import { state, setState } from '../state.js';
import {
  confirmDialog, formatDate, h, mount, openModal, timeAgo, toast,
} from '../ui.js';
import { renderDiffView } from './changes.js';

const nodes = {};
let onRefresh = () => {};

const LANE_COLORS = ['#5b9dff', '#48b06b', '#d8a13a', '#a97bff', '#e5675f', '#33d6c0'];

export function initHistory({ refresh } = {}) {
  nodes.graph = document.getElementById('graph');
  nodes.detail = document.getElementById('commit-detail');
  nodes.count = document.getElementById('history-count');
  if (refresh) onRefresh = refresh;
}

export async function renderHistory() {
  if (!state.repoPath || !nodes.graph) return;

  const { commits } = await api.graph(state.repoPath, { limit: 150 });
  if (nodes.count) nodes.count.textContent = `${commits.length} loaded`;

  if (commits.length === 0) {
    mount(nodes.graph, h('div.empty', {}, [
      h('div.empty__title', { text: 'No commits yet' }),
      h('div.empty__body', { text: 'Stage something and commit to start the history.' }),
    ]));
    return;
  }

  const highlightHead = state.status?.head;

  mount(nodes.graph, commits.map((commit) => {
    const isSelected = state.selectedCommit?.hash === commit.hash;
    const row = h(`button.graph-row${isSelected ? '.is-selected' : ''}`, {
      type: 'button',
      onClick: () => selectCommit(commit),
    });

    row.append(renderLane(commit.lane));

    const subjectLine = h('div.graph-row__subject-line', {}, [
      h('span.graph-row__subject', { text: commit.subject || '(no message)' }),
    ]);

    // Refs belong beside the subject: they name the commit, and the meta line
    // is too narrow to hold them without wrapping.
    const refs = commit.refs.filter((ref) => ref && ref !== 'HEAD');
    for (const ref of refs.slice(0, 3)) {
      const isHead = commit.hash === highlightHead || commit.refs.includes('HEAD');
      subjectLine.append(renderRefTag(ref, isHead));
    }
    if (refs.length > 3) {
      subjectLine.append(h('span.ref-tag.ref-tag--branch', { text: `+${refs.length - 3}` }));
    }

    const main = h('div.graph-row__main', {}, [
      subjectLine,
      h('div.graph-row__meta', {}, [
        h('code', { text: commit.short }),
        h('span.graph-row__author', { text: commit.author }),
        h('span', { text: timeAgo(commit.date) }),
      ]),
    ]);

    row.append(main);
    return row;
  }));
}

function renderLane(lane) {
  const container = h('div.graph-row__lane');

  const color = LANE_COLORS[Math.abs(lane) % LANE_COLORS.length];

  // Connecting line above and below the node, offset per lane.
  container.append(h('span.graph-row__line', {
    style: { left: `${8 + Math.min(lane, 4) * 10}px`, background: color, top: 0, bottom: '50%' },
  }));
  container.append(h('span.graph-row__line', {
    style: { left: `${8 + Math.min(lane, 4) * 10}px`, background: color, top: '50%', bottom: 0 },
  }));
  container.append(h('span.graph-row__node', {
    style: { left: `${4 + Math.min(lane, 4) * 10}px`, background: color },
  }));

  return container;
}

function renderRefTag(ref, isHead) {
  let kind = 'branch';
  if (ref.startsWith('tag: ')) kind = 'tag';
  else if (ref.includes('/')) kind = 'remote';
  if (isHead && !ref.includes('/')) kind = 'head';

  const label = ref.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
  return h(`span.ref-tag.ref-tag--${kind}`, { text: label, title: ref });
}

/* ------------------------------------------------------------------ *
 * Commit detail
 * ------------------------------------------------------------------ */

async function selectCommit(commit) {
  setState({ selectedCommit: commit });
  await renderHistory();
  await renderCommitDetail();
}

export async function renderCommitDetail() {
  const commit = state.selectedCommit;
  const pane = nodes.detail;
  if (!pane) return;

  if (!commit) {
    mount(pane, h('div.empty', {}, [
      h('div.empty__title', { text: 'No commit selected' }),
      h('div.empty__body', { text: 'Select a commit to inspect the change, or ask the copilot to explain it.' }),
    ]));
    return;
  }

  mount(pane, h('div.empty', {}, [h('div.empty__title', { text: 'Loading commit…' })]));

  try {
    const [{ commit: detail }, { diff }] = await Promise.all([
      api.commitDetail(state.repoPath, commit.hash),
      api.diff(state.repoPath, { commit: commit.hash }),
    ]);

    const patchPane = h('div.diff-pane');

    const head = h('div.commit-detail__head', {}, [
      h('div.commit-detail__subject', { text: detail.subject || '(no message)' }),
      detail.body ? h('div.commit-detail__body', { text: detail.body }) : null,
      h('div.commit-detail__meta', {}, [
        h('span', { text: `${detail.author} <${detail.email}>` }),
        h('span', { text: formatDate(detail.authoredAt) }),
        h('code', { text: detail.short }),
        h('span', { text: `${detail.files.length} file(s) changed` }),
        detail.isMerge
          ? h('span', { text: `merge of ${detail.parents.length} parents — showing changes vs the first parent` })
          : null,
      ]),
      h('div.commit-detail__actions', {}, [
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Explain with AI',
          onClick: (event) => explainCommit(detail, event.currentTarget),
        }),
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Create branch here',
          onClick: () => branchFrom(detail),
        }),
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Cherry-pick',
          onClick: () => cherryPick(detail),
        }),
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Revert',
          onClick: () => revert(detail),
        }),
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Reset to here…',
          onClick: () => resetTo(detail),
        }),
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Tag…',
          onClick: () => tagHere(detail),
        }),
      ]),
    ]);

    const explanation = h('div', {
      style: { display: 'none', padding: '12px 18px', borderBottom: '1px solid var(--border)', fontSize: '12.5px', lineHeight: '1.65', color: 'var(--text-soft)' },
      dataset: { role: 'explanation' },
    });

    const files = h('div.commit-files');
    for (const file of detail.files) {
      files.append(h('div.file-row', { style: { cursor: 'default' } }, [
        h('span.file-row__code.file-row__code', { text: file.status, dataset: { state: file.status[0] } }),
        h('span.file-row__path', { text: file.path }),
      ]));
    }

    renderDiffView(patchPane, {
      // The header above already carries the hash and subject; this pane only
      // needs to say what the patch contains.
      title: `Patch · ${detail.files.length} file(s) changed`,
      lines: diff.lines,
      stats: totalStats(diff.stats),
      actions: null,
    });

    mount(pane, head, explanation, files, patchPane.querySelector('.diff-head'), patchPane.querySelector('.diff-body'));
  } catch (error) {
    mount(pane, h('div.empty', {}, [
      h('div.empty__title', { text: 'Could not load that commit' }),
      h('div.empty__body', { text: error.message }),
    ]));
  }
}

async function explainCommit(detail, button) {
  const pane = nodes.detail.querySelector('[data-role="explanation"]');
  if (!pane) return;

  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Thinking…';
  pane.style.display = 'block';
  pane.textContent = 'Reading the patch…';

  try {
    const { explanation } = await api.explainCommit(state.repoPath, detail.hash);
    pane.textContent = explanation;
  } catch (error) {
    pane.textContent = `Could not generate an explanation: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ------------------------------------------------------------------ *
 * Commit operations
 * ------------------------------------------------------------------ */

async function runAction(action, params, successTitle, options = {}) {
  try {
    const result = await api.action(action, { path: state.repoPath, ...params });
    toast({ kind: 'ok', title: successTitle, body: result.command, timeout: 3200 });
    await onRefresh();
    if (options.reloadDetail !== false) await renderCommitDetail();
    return result;
  } catch (error) {
    toast({ kind: 'error', title: 'That did not work', body: error.message });
    return null;
  }
}

async function branchFrom(detail) {
  const nameInput = h('input.input', { type: 'text', placeholder: 'feature/my-branch', 'data-autofocus': 'true' });

  const values = await openPrompt({
    title: 'Create a branch here',
    sub: `The new branch starts at ${detail.short}. Your current branch is not affected.`,
    fields: [nameInput],
    confirmLabel: 'Create branch',
  });

  const name = values?.[0]?.trim();
  if (!name) return;

  await runAction('createBranch', { name, startPoint: detail.hash }, `Branch "${name}" created`, { reloadDetail: false });
}

async function cherryPick(detail) {
  const approved = await confirmDialog({
    title: 'Cherry-pick this commit?',
    sub: `Applies the change from ${detail.short} on top of your current branch as a new commit.`,
    body: h('div', {}, [
      h('div.cmd', { text: `cherry-pick ${detail.hash}` }),
      h('p.muted', { text: detail.subject, style: { fontSize: '12px', marginTop: '8px' } }),
    ]),
    confirmLabel: 'Cherry-pick',
  });
  if (!approved) return;

  await runAction('cherryPick', { hash: detail.hash }, 'Cherry-pick complete');
}

async function revert(detail) {
  const approved = await confirmDialog({
    title: 'Revert this commit?',
    sub: 'Creates a new commit that undoes this change. History is preserved, which is why this is the safe way to undo a pushed commit.',
    body: h('div', {}, [h('div.cmd', { text: `revert --no-edit ${detail.hash}` })]),
    confirmLabel: 'Revert',
  });
  if (!approved) return;

  await runAction('revert', { hash: detail.hash }, 'Revert commit created');
}

async function resetTo(detail) {
  const choice = await openChoice({
    title: `Reset to ${detail.short}`,
    sub: 'Choose what happens to the changes between HEAD and this commit.',
    options: [
      { value: 'soft', title: 'Soft', body: 'Move HEAD only. Everything stays staged and ready to re-commit.' },
      { value: 'mixed', title: 'Mixed', body: 'Move HEAD and unstage. Your files on disk are untouched.' },
      { value: 'hard', title: 'Hard', body: 'Move HEAD and discard all uncommitted changes. Destructive.', danger: true },
    ],
  });

  if (!choice) return;

  const destructive = choice === 'hard';
  const approved = await confirmDialog({
    title: destructive ? 'Discard changes permanently?' : 'Reset the branch?',
    sub: destructive
      ? 'Every uncommitted change in tracked files will be lost. This cannot be undone from GitSynapse.'
      : `Your working tree stays as it is; the branch pointer moves to ${detail.short}.`,
    body: h('div', {}, [h('div.cmd', { text: `reset --${choice} ${detail.hash}` })]),
    confirmLabel: destructive ? 'Reset and discard' : 'Reset',
    tone: destructive ? 'danger' : 'primary',
  });
  if (!approved) return;

  await runAction('reset', { ref: detail.hash, mode: choice }, `Reset (--${choice}) complete`);
}

async function tagHere(detail) {
  const nameInput = h('input.input', { type: 'text', placeholder: 'v1.0.0', 'data-autofocus': 'true' });
  const messageInput = h('input.input', { type: 'text', placeholder: 'Release notes (optional)' });

  const values = await openPrompt({
    title: 'Create a tag here',
    sub: `Tags ${detail.short}. Use an annotated message for releases.`,
    fields: [nameInput, messageInput],
    confirmLabel: 'Create tag',
  });

  const name = values?.[0]?.trim();
  if (!name) return;

  await runAction(
    'createTag',
    { name, message: values[1]?.trim() || null, ref: detail.hash },
    `Tag "${name}" created`,
    { reloadDetail: false },
  );
}

/** Text prompt built on the shared modal. Resolves with the field values, or null. */
function openPrompt({ title, sub, fields, confirmLabel }) {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, fields);
  return openModal({
    title,
    sub,
    body,
    actions: [
      { label: 'Cancel', value: null },
      { label: confirmLabel, value: 'confirm', tone: 'primary' },
    ],
  }).promise.then((value) => (value === 'confirm' ? fields.map((field) => field.value) : null));
}

/** Choice list built on the shared modal. Resolves with the chosen value, or null. */
function openChoice({ title, sub, options }) {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

  const handle = openModal({
    title,
    sub,
    body,
    actions: [{ label: 'Cancel', value: null }],
  });

  for (const option of options) {
    body.append(h('button', {
      type: 'button',
      style: {
        textAlign: 'left',
        padding: '11px 13px',
        border: '1px solid var(--border-strong)',
        borderRadius: '10px',
        background: 'var(--bg-inset)',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
      },
      onClick: () => handle.close(option.value),
    }, [
      h('span', {
        text: option.title,
        style: { fontWeight: '600', color: option.danger ? 'var(--del-text)' : 'var(--text)' },
      }),
      h('span.muted', { text: option.body, style: { fontSize: '12px', lineHeight: '1.5' } }),
    ]));
  }

  return handle.promise;
}

/** Sums a numstat map into a single addition/deletion pair. */
function totalStats(stats) {
  if (!stats || typeof stats !== 'object') return null;

  let additions = 0;
  let deletions = 0;
  let counted = 0;

  for (const entry of Object.values(stats)) {
    if (!entry || entry.additions === null) continue; // binary files report null
    additions += entry.additions;
    deletions += entry.deletions;
    counted += 1;
  }

  return counted > 0 ? { additions, deletions } : null;
}

export { runAction as runHistoryAction };
