/**
 * Write operations.
 *
 * One table-driven endpoint rather than a dozen loose routes: every action goes
 * through the same validation, the same risk annotation, and the same response
 * shape, which makes the UI uniform and the audit trail trivial.
 *
 * The renderer can only reach the actions listed in ACTIONS. It cannot send a
 * raw git argument vector — that privilege belongs to the AI plan executor,
 * which classifies every step.
 */

import express from 'express';
import { findRepositoryRoot } from '../git/repository.js';
import * as git from '../git/actions.js';
import { ActionError } from '../git/actions.js';
import { asyncRoute } from './repo.js';

export const actionRouter = express.Router();

/** @type {Record<string, (repoPath:string, body:any)=>Promise<object>>} */
const ACTIONS = {
  stage: (repo, body) => git.stagePaths(repo, body.files),
  stageAll: (repo) => git.stageAll(repo),
  unstage: (repo, body) => git.unstagePaths(repo, body.files),
  unstageAll: (repo) => git.unstageAll(repo),
  discard: (repo, body) => git.discardChanges(repo, body.file, { untracked: Boolean(body.untracked) }),

  commit: (repo, body) => git.commit(repo, {
    message: body.message,
    amend: Boolean(body.amend),
    signOff: Boolean(body.signOff),
    stageAllFirst: Boolean(body.stageAllFirst),
  }),
  abortOperation: (repo, body) => git.abortOperation(repo, body.operation),

  checkout: (repo, body) => git.checkoutBranch(repo, body.branch, {
    create: Boolean(body.create),
    startPoint: body.startPoint || null,
  }),
  checkoutDetached: (repo, body) => git.checkoutDetached(repo, body.ref),
  createBranch: (repo, body) => git.createBranch(repo, body.name, body.startPoint || null),
  renameBranch: (repo, body) => git.renameBranch(repo, body.from, body.to),
  deleteBranch: (repo, body) => git.deleteBranch(repo, body.name, { force: Boolean(body.force) }),
  deleteRemoteBranch: (repo, body) => git.deleteRemoteBranch(repo, body.remote, body.branch),

  reset: (repo, body) => git.resetTo(repo, body.ref, body.mode),
  merge: (repo, body) => git.mergeBranch(repo, body.branch, { noFastForward: Boolean(body.noFastForward) }),
  cherryPick: (repo, body) => git.cherryPick(repo, body.hash),
  revert: (repo, body) => git.revertCommit(repo, body.hash, { noCommit: Boolean(body.noCommit) }),
  rebase: (repo, body) => git.rebaseOnto(repo, body.upstream),

  resolveConflict: (repo, body) => git.resolveConflict(repo, body.file, body.strategy),

  fetch: (repo, body) => git.fetchRemote(repo, body.remote || null, { prune: body.prune !== false }),
  pull: (repo, body) => git.pull(repo, { remote: body.remote || 'origin', branch: body.branch || null, rebase: Boolean(body.rebase) }),
  push: (repo, body) => git.push(repo, {
    remote: body.remote || 'origin',
    branch: body.branch || null,
    setUpstream: Boolean(body.setUpstream),
    forceWithLease: Boolean(body.forceWithLease),
  }),

  pushTags: (repo, body) => git.pushTags(repo, { remote: body.remote || 'origin' }),

  addRemote: (repo, body) => git.addRemote(repo, body.name, body.url),
  removeRemote: (repo, body) => git.removeRemote(repo, body.name),
  setRemoteUrl: (repo, body) => git.setRemoteUrl(repo, body.name, body.url),

  stashPush: (repo, body) => git.stashPush(repo, { message: body.message || null, includeUntracked: body.includeUntracked !== false }),
  stashApply: (repo, body) => git.stashApply(repo, body.ref || null, { pop: Boolean(body.pop) }),
  stashDrop: (repo, body) => git.stashDrop(repo, body.ref),

  createTag: (repo, body) => git.createTag(repo, body.name, { message: body.message || null, ref: body.ref || null }),
  deleteTag: (repo, body) => git.deleteTag(repo, body.name),

  setConfig: (repo, body) => git.setLocalConfig(repo, body.key, body.value),

  // Writes the canonical junk patterns to .gitignore. The pattern list lives on
  // the server; a body cannot smuggle arbitrary lines into the file.
  ignoreJunk: (repo, body) => git.addIgnorePatterns(repo, body.patterns),
};

/** Actions that are only meaningful outside an existing repository. */
const REPO_FREE_ACTIONS = {
  init: (body) => git.initRepository(body.path, { initialBranch: body.initialBranch || 'main' }),
  clone: (body) => git.cloneRepository(body.url, body.parent, { depth: body.depth || null }),
};

/** Credential failures look like generic errors; give the user the real fix. */
function annotateCredentialFailure(payload) {
  const text = `${payload.stderr || ''}${payload.error || ''}`;
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)|could not read Password/i.test(text)) {
    payload.hint =
      'Git could not ask for credentials because this app runs non-interactively. ' +
      'Install Git Credential Manager, or use an SSH key, or run the command once in Git Bash so the credential is cached.';
  } else if (/rejected.*non-fast-forward|fetch first|Updates were rejected/i.test(text)) {
    payload.hint = 'The remote has commits you do not have. Fetch and review before pushing, or pull with rebase.';
  } else if (/diverged|have diverged/i.test(text)) {
    payload.hint = 'Local and remote histories have diverged. Pull with rebase, or merge first.';
  } else if (/Please commit your changes or stash them|Your local changes to the following files would be overwritten/i.test(text)) {
    payload.hint = 'Commit or stash your local changes before switching branches.';
  } else if (/CONFLICT|Automatic merge failed|fix conflicts/i.test(text)) {
    payload.hint = 'Conflicts were created. Open the Conflicts section to pick a side for each file.';
  } else if (/not fully merged/i.test(text)) {
    payload.hint = 'This branch has unmerged commits. Use force delete only if you are certain they are disposable.';
  }
  return payload;
}

actionRouter.post('/action', asyncRoute(async (req, res) => {
  const { action } = req.body || {};

  if (typeof action !== 'string' || (!ACTIONS[action] && !REPO_FREE_ACTIONS[action])) {
    res.status(404).json({
      error: 'unknown_action',
      message: `"${action}" is not a supported action.`,
      available: Object.keys(ACTIONS),
    });
    return;
  }

  let repoPath = null;

  if (REPO_FREE_ACTIONS[action]) {
    const result = await REPO_FREE_ACTIONS[action](req.body || {});
    res.json({ ok: result.ok, action, ...result });
    return;
  }

  const requested = String(req.body?.path || '');
  const found = findRepositoryRoot(requested);
  if (!found) {
    res.status(404).json({ error: 'not_a_repository', message: 'That folder is not a git repository.' });
    return;
  }
  repoPath = found.root;

  let result;
  try {
    result = await ACTIONS[action](repoPath, req.body || {});
  } catch (error) {
    if (error instanceof ActionError) {
      res.status(error.status || 400).json({ error: 'invalid_request', message: error.message, action });
      return;
    }
    throw error;
  }

  const payload = annotateCredentialFailure({
    action,
    ok: result.ok,
    // Actions whose outcome is more than "a command ran" describe it here —
    // e.g. ignoreJunk reports which patterns were written and which were
    // already present. Everything else leaves this undefined.
    ...(result.extra || {}),
    command: result.command,
    args: result.args,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    durationMs: result.durationMs,
    risk: result.risk,
    riskReasons: result.riskReasons || [],
  });

  res.status(result.ok ? 200 : 422).json(payload);
}));
