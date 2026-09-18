/**
 * Branches, remotes, stashes and tags.
 *
 * Grouped in one module because they share the same shape: a list, a few verbs
 * per row, and one confirmation for anything that removes work.
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { confirmDialog, h, mount, openModal, timeAgo, toast } from '../ui.js';

let onRefresh = () => {};

export function initRefs({ refresh } = {}) {
  if (refresh) onRefresh = refresh;
}

async function runAction(action, params, successTitle, options = {}) {
  try {
    const result = await api.action(action, { path: state.repoPath, ...params });
    toast({ kind: 'ok', title: successTitle, body: result.command, timeout: 3400 });
    await onRefresh();
    return result;
  } catch (error) {
    // A 422 means git ran and refused; the message is more useful than a generic failure.
    toast({
      kind: 'error',
      title: options.errorTitle || 'That did not work',
      body: error.hint ? `${error.message} — ${error.hint}` : error.message,
      timeout: 8000,
    });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Branches
 * ------------------------------------------------------------------ */

export async function renderBranches() {
  const root = document.getElementById('branches-view');
  if (!root || !state.repoPath) return;

  const [{ local, remote }, remotes] = await Promise.all([
    api.branches(state.repoPath),
    api.remotes(state.repoPath),
  ]);

  const remotesByName = new Map(remotes.map((entry) => [entry.name, entry]));

  const localCard = h('div.card', {}, [
    h('div.card__head', {}, [
      h('div', {}, [
        h('div.card__title', { text: 'Local branches' }),
        h('div.card__sub', { text: `${local.length} branch(es) · ${remotes.length} remote(s) configured` }),
      ]),
      h('div', { style: { display: 'flex', gap: '6px' } }, [
        h('button.btn.btn--small', { type: 'button', text: 'New branch', onClick: createBranchDialog }),
        h('button.btn.btn--primary.btn--small', {
          type: 'button',
          text: 'Push current',
          onClick: () => pushCurrent(local.find((branch) => branch.current), remotesByName),
        }),
      ]),
    ]),
    h('div.card__body', {}, local.map((branch) => renderBranchRow(branch, remotesByName))),
  ]);

  const remoteCard = h('div.card', {}, [
    h('div.card__head', {}, [
      h('div', {}, [
        h('div.card__title', { text: 'Remotes' }),
        h('div.card__sub', { text: remotes.length === 0 ? 'No remotes configured' : 'Fetch, pull and push targets' }),
      ]),
      h('div', { style: { display: 'flex', gap: '6px' } }, [
        h('button.btn.btn--small', {
          type: 'button',
          text: 'Fetch all',
          onClick: () => runAction('fetch', {}, 'Fetched from every remote', { errorTitle: 'Fetch failed' }),
        }),
        h('button.btn.btn--small', { type: 'button', text: 'Add remote', onClick: addRemoteDialog }),
      ]),
    ]),
    remotes.length === 0
      ? h('div.card__body', {}, [
          h('div.empty', {}, [
            h('div.empty__title', { text: 'No remotes' }),
            h('div.empty__body', { text: 'Add a remote to back up your work and collaborate.' }),
          ]),
        ])
      : h('div.card__body', {}, remotes.map(renderRemoteRow)),
  ]);

  const remoteBranches = remote.filter((branch) => !branch.name.endsWith('/HEAD'));
  const remoteBranchCard = h('div.card', {}, [
    h('div.card__head', {}, [
      h('div', {}, [
        h('div.card__title', { text: 'Remote branches' }),
        h('div.card__sub', { text: 'Refs as they were at your last fetch' }),
      ]),
    ]),
    h('div.card__body', {}, remoteBranches.length === 0
      ? [h('div.empty', {}, [
          h('div.empty__title', { text: 'Nothing fetched yet' }),
          h('div.empty__body', { text: 'Run a fetch to see the branches on your remote.' }),
        ])]
      : remoteBranches.map((branch) => h('div.row', {}, [
          h('div.row__main', {}, [
            h('div.row__name', {}, [h('code', { text: branch.name })]),
            h('div.row__meta', { text: `${branch.subject || '(no message)'} · ${timeAgo(branch.date)}` }),
          ]),
          h('div.row__actions', { style: { opacity: 1 } }, [
            h('button.btn.btn--small', {
              type: 'button',
              text: 'Check out',
              onClick: () => checkoutRemote(branch),
            }),
          ]),
        ]))),
  ]);

  mount(root, localCard, remoteCard, remoteBranchCard);
}

function renderBranchRow(branch, remotesByName) {
  const name = branch.name;

  const row = h(`div.row${branch.current ? '.row--current' : ''}`, {}, [
    h('div.row__main', {}, [
      h('div.row__name', {}, [
        h('code', { text: name }),
        branch.current ? h('span.badge.badge--ok', { text: 'current' }) : null,
        branch.upstream ? h('span.muted', { text: `→ ${branch.upstream}` }) : h('span.muted', { text: 'no upstream' }),
      ]),
      h('div.row__meta', { text: `${branch.subject || '(no commits)'} · ${timeAgo(branch.date)}` }),
    ]),
  ]);

  const actions = h('div.row__actions', { style: { opacity: '1' } });

  if (!branch.current) {
    actions.append(
      h('button.btn.btn--small', { type: 'button', text: 'Check out', onClick: () => checkout(name) }),
      h('button.btn.btn--small', { type: 'button', text: 'Merge into current', onClick: () => merge(name) }),
      h('button.btn.btn--small', { type: 'button', text: 'Rebase onto', onClick: () => rebase(name) }),
      h('button.btn.btn--small', { type: 'button', text: 'Rename', onClick: () => renameDialog(name) }),
      h('button.btn.btn--small', {
        type: 'button',
        text: 'Delete',
        onClick: () => deleteBranch(name, Boolean(branch.upstream)),
      }),
    );
  } else {
    actions.append(
      h('button.btn.btn--small', { type: 'button', text: 'Pull', onClick: () => pullCurrent(name, remotesByName) }),
      h('button.btn.btn--small', { type: 'button', text: 'Rename', onClick: () => renameDialog(name) }),
      h('button.btn.btn--small', { type: 'button', text: 'Stash changes', onClick: () => stashDialog() }),
    );
  }

  row.append(actions);
  return row;
}

function renderRemoteRow(remote) {
  return h('div.row', {}, [
    h('div.row__main', {}, [
      h('div.row__name', {}, [h('code', { text: remote.name })]),
      h('div.row__meta', { text: remote.fetchUrl || remote.pushUrl || '' }),
    ]),
    h('div.row__actions', { style: { opacity: '1' } }, [
      h('button.btn.btn--small', {
        type: 'button',
        text: 'Fetch',
        onClick: () => runAction('fetch', { remote: remote.name }, `Fetched ${remote.name}`, { errorTitle: 'Fetch failed' }),
      }),
      h('button.btn.btn--small', {
        type: 'button',
        text: 'Change URL',
        onClick: () => changeRemoteUrlDialog(remote),
      }),
      h('button.btn.btn--small', {
        type: 'button',
        text: 'Remove',
        onClick: async () => {
          const approved = await confirmDialog({
            title: `Remove remote "${remote.name}"?`,
            sub: 'Branches already fetched stay on disk, but nothing can be pushed or pulled from it afterwards.',
            body: h('div', {}, [h('div.cmd', { text: `remote remove ${remote.name}` })]),
            confirmLabel: 'Remove remote',
            tone: 'danger',
          });
          if (approved) await runAction('removeRemote', { name: remote.name }, `Removed ${remote.name}`);
        },
      }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Branch operations
 * ------------------------------------------------------------------ */

async function checkout(name) {
  await runAction('checkout', { branch: name }, `Switched to ${name}`, { errorTitle: 'Could not switch branch' });
}

async function checkoutRemote(branch) {
  // `git checkout <remote>/<branch>` creates a local tracking branch, which is
  // almost always what someone means when they click a remote branch.
  const localName = branch.name.split('/').slice(1).join('/');
  await runAction(
    'checkout',
    { branch: localName, create: true, startPoint: branch.name },
    `Tracking branch ${localName} created`,
    { errorTitle: 'Could not check out that remote branch' },
  );
}

async function merge(name) {
  const approved = await confirmDialog({
    title: `Merge ${name} into the current branch?`,
    sub: 'A merge commit is created unless the merge can fast-forward. Conflicts are possible.',
    body: h('div', {}, [h('div.cmd', { text: `merge ${name}` })]),
    confirmLabel: 'Merge',
  });
  if (!approved) return;
  await runAction('merge', { branch: name }, `Merged ${name}`, { errorTitle: 'Merge failed' });
}

async function rebase(name) {
  const approved = await confirmDialog({
    title: `Rebase the current branch onto ${name}?`,
    sub: 'Your commits are replayed on top of that branch, which rewrites their hashes. If this branch is already pushed, you will need to force-push it afterwards.',
    body: h('div', {}, [h('div.cmd', { text: `rebase ${name}` })]),
    confirmLabel: 'Rebase',
    tone: 'danger',
  });
  if (!approved) return;
  await runAction('rebase', { upstream: name }, `Rebased onto ${name}`, { errorTitle: 'Rebase stopped' });
}

async function deleteBranch(name, hasUpstream) {
  const approved = await confirmDialog({
    title: `Delete branch "${name}"?`,
    sub: hasUpstream
      ? 'The branch is deleted locally. Its remote copy is not touched.'
      : 'This branch has no upstream, so the commits on it may exist nowhere else.',
    body: h('div', {}, [h('div.cmd', { text: `branch -d ${name}` })]),
    confirmLabel: 'Delete branch',
    tone: 'danger',
  });
  if (!approved) return;

  let result = await api.action('deleteBranch', { path: state.repoPath, name, force: false }).catch((error) => ({ error }));

  if (result?.error) {
    const forced = await confirmDialog({
      title: 'Branch is not fully merged',
      sub: `"${name}" contains commits that are not in your current branch. Force-deleting loses them.`,
      body: h('div', {}, [h('div.cmd', { text: `branch -D ${name}` })]),
      confirmLabel: 'Force delete',
      tone: 'danger',
    });
    if (!forced) return;
    result = await api.action('deleteBranch', { path: state.repoPath, name, force: true }).catch((error) => ({ error }));
  }

  if (result?.error) {
    toast({ kind: 'error', title: 'Could not delete the branch', body: result.error.message });
  } else {
    toast({ kind: 'ok', title: `Deleted ${name}`, timeout: 2800 });
    await onRefresh();
  }
}

async function createBranchDialog() {
  const nameInput = h('input.input', { type: 'text', placeholder: 'feature/name', 'data-autofocus': 'true' });
  const startInput = h('input.input', { type: 'text', placeholder: 'HEAD (default)' });
  const checkoutNow = h('input', { type: 'checkbox', checked: true });

  const handle = openModal({
    title: 'New branch',
    sub: 'Branches are cheap. Create one before starting anything you might want to abandon.',
    body: h('div', {}, [
      h('div.field', {}, [
        h('label.field__label', { text: 'Name' }),
        nameInput,
        h('div.field__hint', { text: 'git validates the name: no spaces, no "..", no trailing slash.' }),
      ]),
      h('div.field', {}, [
        h('label.field__label', { text: 'Start from (optional)' }),
        startInput,
        h('div.field__hint', { text: 'A branch, tag or commit hash. Leave blank to branch from HEAD.' }),
      ]),
      h('label.check', {}, [checkoutNow, h('span', { text: 'Switch to it straight away' })]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Create branch', value: 'create', tone: 'primary' },
    ],
  });

  const value = await handle.promise;
  if (value !== 'create') return;

  const name = nameInput.value.trim();
  if (!name) return;

  const params = { name, startPoint: startInput.value.trim() || null };

  if (checkoutNow.checked) {
    await runAction('checkout', { branch: name, create: true, startPoint: params.startPoint }, `Switched to new branch ${name}`, {
      errorTitle: 'Could not create the branch',
    });
  } else {
    await runAction('createBranch', params, `Branch ${name} created`, { errorTitle: 'Could not create the branch' });
  }
}

async function renameDialog(from) {
  const input = h('input.input', { type: 'text', value: from, 'data-autofocus': 'true' });

  const handle = openModal({
    title: `Rename "${from}"`,
    body: h('div.field', {}, [h('label.field__label', { text: 'New name' }), input]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Rename', value: 'rename', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'rename') return;
  const to = input.value.trim();
  if (!to || to === from) return;

  await runAction('renameBranch', { from, to }, `Renamed to ${to}`, { errorTitle: 'Could not rename the branch' });
}

async function addRemoteDialog() {
  const nameInput = h('input.input', { type: 'text', value: 'origin', 'data-autofocus': 'true' });
  const urlInput = h('input.input.input--mono', { type: 'text', placeholder: 'https://github.com/user/repo.git' });

  const handle = openModal({
    title: 'Add a remote',
    sub: 'A URL is enough. GitSynapse never asks for your password — configure Git Credential Manager or use SSH.',
    body: h('div', {}, [
      h('div.field', {}, [h('label.field__label', { text: 'Name' }), nameInput]),
      h('div.field', {}, [h('label.field__label', { text: 'URL' }), urlInput]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Add remote', value: 'add', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'add') return;
  const name = nameInput.value.trim();
  const url = urlInput.value.trim();
  if (!name || !url) return;

  await runAction('addRemote', { name, url }, `Remote ${name} added`, { errorTitle: 'Could not add the remote' });
}

async function changeRemoteUrlDialog(remote) {
  const input = h('input.input.input--mono', { type: 'text', value: remote.fetchUrl, 'data-autofocus': 'true' });

  const handle = openModal({
    title: `Change URL for "${remote.name}"`,
    body: h('div.field', {}, [h('label.field__label', { text: 'URL' }), input]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'save') return;
  const url = input.value.trim();
  if (!url) return;

  await runAction('setRemoteUrl', { name: remote.name, url }, `Updated ${remote.name}`, { errorTitle: 'Could not change the URL' });
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

async function pushCurrent(branch, remotesByName) {
  if (!branch) return;
  const remoteNames = [...remotesByName.keys()];
  if (remoteNames.length === 0) {
    toast({ kind: 'warn', title: 'No remote configured', body: 'Add a remote first, then push.' });
    return;
  }

  const remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0];
  const needsUpstream = !branch.upstream;

  await runAction(
    'push',
    { remote, branch: branch.name, setUpstream: needsUpstream },
    `Pushed ${branch.name} to ${remote}`,
    { errorTitle: 'Push failed' },
  );
}

async function pullCurrent(branch, remotesByName) {
  const remoteNames = [...remotesByName.keys()];
  if (remoteNames.length === 0) {
    toast({ kind: 'warn', title: 'No remote configured', body: 'Add a remote first, then pull.' });
    return;
  }
  const remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0];

  const rebase = await confirmDialog({
    title: `Pull ${remote}/${branch.name}?`,
    sub: 'Choose how incoming commits combine with yours. Rebase keeps history linear but rewrites your local commits; merge records a merge commit.',
    body: h('div', {}, [
      h('div.cmd', { text: `pull --rebase ${remote} ${branch.name}` }),
      h('p.muted', { text: 'Cancel to pull with a merge instead.', style: { fontSize: '12px', marginTop: '8px' } }),
    ]),
    confirmLabel: 'Pull with rebase',
  });

  await runAction(
    'pull',
    { remote, branch: branch.name, rebase },
    'Pull complete',
    { errorTitle: 'Pull failed' },
  );
}

export async function pushBranchDialog() {
  const remoteInput = h('input.input', { type: 'text', value: 'origin', 'data-autofocus': 'true' });
  const branchInput = h('input.input', { type: 'text', value: state.status?.branch || '' });
  const upstream = h('input', { type: 'checkbox', checked: !state.status?.upstream });
  const lease = h('input', { type: 'checkbox' });

  const handle = openModal({
    title: 'Push',
    body: h('div', {}, [
      h('div.field', {}, [h('label.field__label', { text: 'Remote' }), remoteInput]),
      h('div.field', {}, [h('label.field__label', { text: 'Branch' }), branchInput]),
      h('label.check', { style: { marginBottom: '10px' } }, [upstream, h('span', { text: 'Set as upstream (-u)' })]),
      h('label.check', {}, [lease, h('span', { text: 'Force with lease' })]),
      h('div.field__hint', {
        text: 'Force-with-lease overwrites the remote branch only if nobody else pushed since your last fetch. It is the least dangerous way to rewrite a remote.',
        style: { marginTop: '8px' },
      }),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Push', value: 'push', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'push') return;

  await runAction(
    'push',
    {
      remote: remoteInput.value.trim() || 'origin',
      branch: branchInput.value.trim() || null,
      setUpstream: upstream.checked,
      forceWithLease: lease.checked,
    },
    'Push complete',
    { errorTitle: 'Push failed' },
  );
}

/* ------------------------------------------------------------------ *
 * Stashes
 * ------------------------------------------------------------------ */

export async function renderStash() {
  const root = document.getElementById('stash-view');
  if (!root || !state.repoPath) return;

  const { stashes } = await api.stash(state.repoPath);

  const card = h('div.card', {}, [
    h('div.card__head', {}, [
      h('div', {}, [
        h('div.card__title', { text: 'Stashes' }),
        h('div.card__sub', { text: 'Parked work. Stashes live outside branches, so they are easy to forget about.' }),
      ]),
      h('button.btn.btn--primary.btn--small', { type: 'button', text: 'Stash my changes', onClick: () => stashDialog() }),
    ]),
    h('div.card__body', {}, stashes.length === 0
      ? [h('div.empty', {}, [
          h('div.empty__title', { text: 'No stashes' }),
          h('div.empty__body', { text: 'Stash when you need to switch tasks without committing half-finished work.' }),
        ])]
      : stashes.map((stash) => h('div.row', {}, [
          h('div.row__main', {}, [
            h('div.row__name', {}, [
              h('code', { text: stash.ref }),
              h('span.muted', { text: stash.hash }),
            ]),
            h('div.row__meta', { text: stash.subject || '' }),
          ]),
          h('div.row__actions', { style: { opacity: '1' } }, [
            h('button.btn.btn--small', {
              type: 'button',
              text: 'Apply',
              onClick: () => runAction('stashApply', { ref: stash.ref, pop: false }, 'Stash applied'),
            }),
            h('button.btn.btn--small', {
              type: 'button',
              text: 'Pop',
              onClick: () => runAction('stashApply', { ref: stash.ref, pop: true }, 'Stash popped'),
            }),
            h('button.btn.btn--small', {
              type: 'button',
              text: 'Drop',
              onClick: async () => {
                const approved = await confirmDialog({
                  title: `Drop ${stash.ref}?`,
                  sub: 'The stashed changes are deleted. Apply it first if you are not certain they exist elsewhere.',
                  body: h('div', {}, [h('div.cmd', { text: `stash drop ${stash.ref}` })]),
                  confirmLabel: 'Drop stash',
                  tone: 'danger',
                });
                if (approved) await runAction('stashDrop', { ref: stash.ref }, `Dropped ${stash.ref}`);
              },
            }),
          ]),
        ]))),
  ]);

  mount(root, card);
}

async function stashDialog() {
  const messageInput = h('input.input', { type: 'text', placeholder: 'What are you parking?', 'data-autofocus': 'true' });
  const untracked = h('input', { type: 'checkbox', checked: true });

  const handle = openModal({
    title: 'Stash changes',
    sub: 'Your working tree is reset to HEAD and the changes are stored on the stash stack.',
    body: h('div', {}, [
      h('div.field', {}, [h('label.field__label', { text: 'Message (optional)' }), messageInput]),
      h('label.check', {}, [untracked, h('span', { text: 'Include untracked files' })]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Stash', value: 'stash', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'stash') return;

  await runAction(
    'stashPush',
    { message: messageInput.value.trim() || null, includeUntracked: untracked.checked },
    'Changes stashed',
  );
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

export async function renderTags() {
  const root = document.getElementById('tags-view');
  if (!root || !state.repoPath) return;

  const { tags } = await api.tags(state.repoPath);

  const card = h('div.card', {}, [
    h('div.card__head', {}, [
      h('div', {}, [
        h('div.card__title', { text: 'Tags' }),
        h('div.card__sub', { text: 'Permanent names for specific commits. Tags are what releases point at.' }),
      ]),
      h('button.btn.btn--small', { type: 'button', text: 'Push all tags', onClick: pushTags }),
    ]),
    h('div.card__body', {}, tags.length === 0
      ? [h('div.empty', {}, [
          h('div.empty__title', { text: 'No tags' }),
          h('div.empty__body', { text: 'Create one from the History view: select a commit, then Tag.' }),
        ])]
      : tags.map((tag) => h('div.row', {}, [
          h('div.row__main', {}, [
            h('div.row__name', {}, [h('code', { text: tag.name }), h('span.muted', { text: tag.hash })]),
            h('div.row__meta', { text: timeAgo(tag.date) }),
          ]),
          h('div.row__actions', { style: { opacity: '1' } }, [
            h('button.btn.btn--small', {
              type: 'button',
              text: 'Delete',
              onClick: async () => {
                const approved = await confirmDialog({
                  title: `Delete tag "${tag.name}"?`,
                  sub: 'The commit itself is untouched. If the tag was already pushed, others will still see it until you delete it there too.',
                  body: h('div', {}, [h('div.cmd', { text: `tag -d ${tag.name}` })]),
                  confirmLabel: 'Delete tag',
                  tone: 'danger',
                });
                if (approved) await runAction('deleteTag', { name: tag.name }, `Deleted tag ${tag.name}`);
              },
            }),
          ]),
        ]))),
  ]);

  mount(root, card);
}

async function pushTags() {
  const remotes = await api.remotes(state.repoPath);
  const remote = remotes.find((entry) => entry.name === 'origin') || remotes[0];
  if (!remote) {
    toast({ kind: 'warn', title: 'No remote configured', body: 'Add a remote before pushing tags.' });
    return;
  }

  const approved = await confirmDialog({
    title: 'Push every tag?',
    sub: `Tags that do not exist on ${remote.name} are uploaded. Nothing is deleted by this.`,
    body: h('div', {}, [h('div.cmd', { text: `push ${remote.name} --tags` })]),
    confirmLabel: 'Push tags',
  });
  if (!approved) return;

  await runAction('pushTags', { remote: remote.name }, 'Tags pushed', { errorTitle: 'Push failed' });
}
