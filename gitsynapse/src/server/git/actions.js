/**
 * High-level repository actions.
 *
 * Every function here builds an explicit argument vector, validates the inputs
 * that git would otherwise interpret as options, and returns the raw result so
 * the UI can show exactly what ran. Risk classification is attached to each
 * action so the interface can label buttons honestly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runGitIn } from './runner.js';
import { JUNK_IGNORE_LINES, ignoreLinesFor } from './junk.js';
import { classifyCommand } from '../ai/safety.js';
import { findRepositoryRoot } from './repository.js';

export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

function requireRepo(repoPath) {
  const found = findRepositoryRoot(repoPath);
  if (!found) throw new ActionError('No git repository found at that path.', 404);
  return found;
}

/**
 * Rejects anything that git would treat as a flag, plus NUL bytes.
 * Git argument parsing cannot be made safe by quoting alone, so option-shaped
 * values are refused outright.
 */
function safeValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ActionError(`${label} is required.`);
  }
  if (value.includes('\0')) throw new ActionError(`${label} contains a null byte.`);
  if (value.startsWith('-')) throw new ActionError(`${label} cannot start with "-".`);
  return value;
}

/** Multi-line values (commit messages) may not be flags or contain NULs. */
function safeMultiline(value, label, maxLength = 20_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ActionError(`${label} is required.`);
  }
  if (value.includes('\0')) throw new ActionError(`${label} contains a null byte.`);
  if (value.length > maxLength) throw new ActionError(`${label} is too long.`);
  return value;
}

/** Repository-relative path that resolves inside the working tree. */
function safePath(repoPath, value, label = 'Path') {
  if (typeof value !== 'string' || value.trim() === '') throw new ActionError(`${label} is required.`);
  if (value.includes('\0')) throw new ActionError(`${label} contains a null byte.`);
  if (path.isAbsolute(value)) {
    const relative = path.relative(repoPath, value);
    if (relative.startsWith('..')) throw new ActionError(`${label} is outside the repository.`);
    return relative.split(path.sep).join('/');
  }
  const resolved = path.resolve(repoPath, value);
  const root = path.resolve(repoPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ActionError(`${label} is outside the repository.`);
  }
  return value.split(path.sep).join('/');
}

function safePathList(repoPath, list, label = 'Paths') {
  if (!Array.isArray(list) || list.length === 0) {
    throw new ActionError(`Select at least one file.`);
  }
  if (list.length > 500) throw new ActionError('Too many files selected at once.');
  return list.map((entry) => safePath(repoPath, entry, label));
}

/** Branch/ref names: delegated to git's own rules via check-ref-format. */
async function safeRef(repoPath, value, label = 'Name') {
  safeValue(value, label);
  if (/[\s~^:?*[\\]/.test(value) || value.includes('..') || value.endsWith('.lock')) {
    throw new ActionError(`${label} is not a valid git ref name.`);
  }
  const result = await runGitIn(repoPath, ['check-ref-format', '--branch', value]);
  if (!result.ok) throw new ActionError(`"${value}" is not a valid branch name.`);
  return value;
}

/** Remote names are refs too, and simpler. */
function safeRemoteName(value) {
  safeValue(value, 'Remote name');
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new ActionError('Remote names may contain only letters, digits, dot, underscore and dash.');
  }
  return value;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new ActionError('URL is required.');
  if (value.startsWith('-')) throw new ActionError('URL cannot start with "-".');
  return value.trim();
}

/** Attaches the independently computed risk verdict to an action result. */
function withRisk(args, result) {
  const verdict = classifyCommand(args);
  return { ...result, risk: verdict.level, riskReasons: verdict.reasons };
}

/* ------------------------------------------------------------------ *
 * Working tree
 * ------------------------------------------------------------------ */

export async function stagePaths(repoPath, paths) {
  requireRepo(repoPath);
  const safe = safePathList(repoPath, paths);
  const args = ['add', '--', ...safe];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function stageAll(repoPath) {
  requireRepo(repoPath);
  // `add -A` stages modifications, additions and deletions across the tree.
  const args = ['add', '--all'];
  return withRisk(args, await runGitIn(repoPath, args));
}

async function hasCommits(repoPath) {
  const result = await runGitIn(repoPath, ['rev-parse', '--verify', 'HEAD']);
  return result.ok;
}

export async function unstagePaths(repoPath, paths) {
  requireRepo(repoPath);
  const safe = safePathList(repoPath, paths);

  // With no commits yet there is nothing to reset to; drop the index entries.
  const args = (await hasCommits(repoPath))
    ? ['reset', '--quiet', 'HEAD', '--', ...safe]
    : ['rm', '--cached', '-r', '--quiet', '--', ...safe];

  return withRisk(args, await runGitIn(repoPath, args));
}

export async function unstageAll(repoPath) {
  requireRepo(repoPath);
  const args = (await hasCommits(repoPath))
    ? ['reset', '--quiet', 'HEAD']
    : ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '.'];
  return withRisk(args, await runGitIn(repoPath, args));
}

/**
 * Discards local modifications for one file. Deliberately destructive; the
 * caller must have obtained explicit confirmation that names the file.
 */
export async function discardChanges(repoPath, filePath, { untracked = false } = {}) {
  requireRepo(repoPath);
  const safe = safePath(repoPath, filePath);

  if (untracked) {
    const args = ['clean', '--force', '--', safe];
    return withRisk(args, await runGitIn(repoPath, args));
  }

  const args = ['restore', '--worktree', '--', safe];
  let result = await runGitIn(repoPath, args);

  // Older git (< 2.23) has no `restore`.
  if (!result.ok && /unknown option|not a git command/i.test(result.stderr)) {
    const fallback = ['checkout', '--', safe];
    result = await runGitIn(repoPath, fallback);
    return withRisk(fallback, result);
  }

  return withRisk(args, result);
}

/* ------------------------------------------------------------------ *
 * Ignore rules
 * ------------------------------------------------------------------ */

/**
 * Appends ignore patterns for the junk GitSynapse filters out of the file list.
 *
 * The pattern list is the server's own (`junk.js`), never the caller's, so this
 * endpoint has no attacker-controlled input: worst case the user gets a
 * `.gitignore` line they did not need. Existing content is preserved and
 * patterns already present are not duplicated; the file is left as a normal
 * working-tree change so the user reviews and commits it like anything else.
 *
 * Note for the UI: `.gitignore` only affects *untracked* paths. A file that is
 * already tracked keeps appearing until it is removed from the index, which is
 * a `git rm --cached` away — the caller's message should not over-promise.
 *
 * @param {string} repoPath
 * @param {string[]} [requested] Ignored; present only for API symmetry.
 * @returns {Promise<{ok:true, file:string, added:string[], alreadyPresent:string[], patterns:number}>}
 */
export async function addIgnorePatterns(repoPath, requested = null) {
  requireRepo(repoPath);

  // Accept a subset of the canonical list at most; unknown strings are dropped.
  const wanted = Array.isArray(requested) && requested.length > 0
    ? JUNK_IGNORE_LINES.filter((line) => requested.includes(line))
    : JUNK_IGNORE_LINES;
  const lines = wanted.length > 0 ? wanted : JUNK_IGNORE_LINES;

  const file = path.join(repoPath, '.gitignore');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ActionError(`Could not read .gitignore: ${error.message}`);
  }

  const present = new Set(
    existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  );

  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return {
      ok: true,
      extra: { file, added: [], alreadyPresent: lines, patterns: 0 },
    };
  }

  const block = [
    existing.trim() ? '' : null,
    '# Added by GitSynapse: build output and OS noise.',
    ...missing,
  ].filter((line) => line !== null).join('\n');

  const next = `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n' : ''}${block}\n`;

  try {
    fs.writeFileSync(file, next, 'utf8');
  } catch (error) {
    throw new ActionError(`Could not write .gitignore: ${error.message}`);
  }

  return {
    ok: true,
    extra: {
      file,
      added: missing,
      alreadyPresent: lines.filter((line) => present.has(line)),
      patterns: missing.length,
    },
  };
}

/**
 * The ignore lines for the junk currently present in a repository, so the UI
 * can tell the user exactly what a click will add.
 *
 * @param {Array<{path:string}>} noise
 * @returns {string[]}
 */
export function ignoreLinesForNoise(noise) {
  return ignoreLinesFor(Array.isArray(noise) ? noise : []);
}

/* ------------------------------------------------------------------ *
 * Commits
 * ------------------------------------------------------------------ */

export async function commit(repoPath, { message, amend = false, signOff = false, stageAllFirst = false }) {
  requireRepo(repoPath);
  const clean = safeMultiline(message, 'Commit message');

  if (stageAllFirst) await runGitIn(repoPath, ['add', '--all']);

  const args = ['commit', '-m', clean];
  if (amend) args.push('--amend');
  if (signOff) args.push('--signoff');

  const result = await runGitIn(repoPath, args);
  return withRisk(['commit', '-m', '<message>', ...args.slice(3)], result);
}

export async function amendMessage(repoPath, message) {
  return commit(repoPath, { message, amend: true });
}

export async function abortOperation(repoPath, operation) {
  requireRepo(repoPath);
  const map = {
    merge: ['merge', '--abort'],
    rebase: ['rebase', '--abort'],
    'cherry-pick': ['cherry-pick', '--abort'],
    revert: ['revert', '--abort'],
  };
  const args = map[operation];
  if (!args) throw new ActionError('Unknown operation to abort.');
  return withRisk(args, await runGitIn(repoPath, args));
}

/* ------------------------------------------------------------------ *
 * History movement
 * ------------------------------------------------------------------ */

export async function checkoutBranch(repoPath, branch, { create = false, startPoint = null } = {}) {
  requireRepo(repoPath);
  const name = await safeRef(repoPath, branch, 'Branch name');

  const args = ['checkout'];
  if (create) args.push('-b', name);
  else args.push(name);
  if (create && startPoint) args.push(await safeRef(repoPath, startPoint, 'Start point'));

  return withRisk(args, await runGitIn(repoPath, args));
}

export async function checkoutDetached(repoPath, ref) {
  requireRepo(repoPath);
  const target = safeValue(ref, 'Ref');
  // Explicit `--detach` keeps the intent unambiguous even if a branch of the
  // same name exists.
  const args = ['checkout', '--detach', target];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function createBranch(repoPath, name, startPoint = null) {
  requireRepo(repoPath);
  const branch = await safeRef(repoPath, name, 'Branch name');
  const args = ['branch', branch];
  if (startPoint) args.push(safeValue(startPoint, 'Start point'));
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function renameBranch(repoPath, from, to) {
  requireRepo(repoPath);
  const source = await safeRef(repoPath, from, 'Current branch name');
  const target = await safeRef(repoPath, to, 'New branch name');
  const args = ['branch', '-m', source, target];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function deleteBranch(repoPath, name, { force = false } = {}) {
  requireRepo(repoPath);
  const branch = await safeRef(repoPath, name, 'Branch name');
  const args = ['branch', force ? '-D' : '-d', branch];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function deleteRemoteBranch(repoPath, remote, branch) {
  requireRepo(repoPath);
  const remoteName = safeRemoteName(remote);
  const branchName = safeValue(branch, 'Branch name');
  const args = ['push', remoteName, '--delete', branchName];
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 120_000 }));
}

export async function resetTo(repoPath, ref, mode = 'mixed') {
  requireRepo(repoPath);
  const target = safeValue(ref, 'Target');
  const flag = { soft: '--soft', mixed: '--mixed', hard: '--hard' }[mode];
  if (!flag) throw new ActionError('Reset mode must be soft, mixed or hard.');
  const args = ['reset', flag, target];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function mergeBranch(repoPath, branch, { noFastForward = false } = {}) {
  requireRepo(repoPath);
  const name = await safeRef(repoPath, branch, 'Branch name');
  const args = ['merge', name];
  if (noFastForward) args.push('--no-ff');
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 120_000 }));
}

export async function cherryPick(repoPath, hash) {
  requireRepo(repoPath);
  const commitHash = safeValue(hash, 'Commit');
  const args = ['cherry-pick', commitHash];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function revertCommit(repoPath, hash, { noCommit = false } = {}) {
  requireRepo(repoPath);
  const commitHash = safeValue(hash, 'Commit');
  const args = ['revert', '--no-edit'];
  if (noCommit) args.push('--no-commit');
  args.push(commitHash);
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function rebaseOnto(repoPath, upstream) {
  requireRepo(repoPath);
  const target = safeValue(upstream, 'Upstream');
  const args = ['rebase', target];
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 180_000 }));
}

/* ------------------------------------------------------------------ *
 * Merge conflicts
 * ------------------------------------------------------------------ */

export async function resolveConflict(repoPath, filePath, strategy) {
  requireRepo(repoPath);
  const safe = safePath(repoPath, filePath, 'File');

  if (strategy === 'ours' || strategy === 'theirs') {
    const args = ['checkout', `--${strategy}`, '--', safe];
    const result = await runGitIn(repoPath, args);
    if (!result.ok) return withRisk(args, result);
    const stageArgs = ['add', '--', safe];
    return withRisk(stageArgs, await runGitIn(repoPath, stageArgs));
  }

  if (strategy === 'mark-resolved') {
    const args = ['add', '--', safe];
    return withRisk(args, await runGitIn(repoPath, args));
  }

  throw new ActionError('Strategy must be "ours", "theirs" or "mark-resolved".');
}

/* ------------------------------------------------------------------ *
 * Remotes and synchronisation
 * ------------------------------------------------------------------ */

export async function fetchRemote(repoPath, remote = null, { prune = true } = {}) {
  requireRepo(repoPath);
  const args = ['fetch'];
  if (prune) args.push('--prune');
  args.push(remote ? safeRemoteName(remote) : '--all');
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 300_000 }));
}

export async function pull(repoPath, { remote = 'origin', branch = null, rebase = false } = {}) {
  requireRepo(repoPath);
  const args = ['pull'];
  if (rebase) args.push('--rebase');
  args.push(safeRemoteName(remote));
  if (branch) args.push(safeValue(branch, 'Branch'));
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 300_000 }));
}

export async function push(repoPath, { remote = 'origin', branch = null, setUpstream = false, forceWithLease = false } = {}) {
  requireRepo(repoPath);
  const args = ['push'];
  if (forceWithLease) args.push('--force-with-lease');
  if (setUpstream) args.push('--set-upstream');
  args.push(safeRemoteName(remote));
  if (branch) args.push(safeValue(branch, 'Branch'));
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 300_000 }));
}

export async function pushTags(repoPath, { remote = 'origin' } = {}) {
  requireRepo(repoPath);
  const args = ['push', safeRemoteName(remote), '--tags'];
  return withRisk(args, await runGitIn(repoPath, args, { timeoutMs: 300_000 }));
}

export async function addRemote(repoPath, name, url) {
  requireRepo(repoPath);
  const args = ['remote', 'add', safeRemoteName(name), safeUrl(url)];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function removeRemote(repoPath, name) {
  requireRepo(repoPath);
  const args = ['remote', 'remove', safeRemoteName(name)];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function setRemoteUrl(repoPath, name, url) {
  requireRepo(repoPath);
  const args = ['remote', 'set-url', safeRemoteName(name), safeUrl(url)];
  return withRisk(args, await runGitIn(repoPath, args));
}

/* ------------------------------------------------------------------ *
 * Stash, tags, repository creation
 * ------------------------------------------------------------------ */

export async function stashPush(repoPath, { message = null, includeUntracked = true } = {}) {
  requireRepo(repoPath);
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (message) args.push('-m', safeMultiline(message, 'Stash message', 500));
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function stashApply(repoPath, ref = null, { pop = false } = {}) {
  requireRepo(repoPath);
  const args = ['stash', pop ? 'pop' : 'apply'];
  if (ref) args.push(safeValue(ref, 'Stash reference'));
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function stashDrop(repoPath, ref) {
  requireRepo(repoPath);
  const args = ['stash', 'drop', safeValue(ref, 'Stash reference')];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function createTag(repoPath, name, { message = null, ref = null } = {}) {
  requireRepo(repoPath);
  safeValue(name, 'Tag name');
  const args = ['tag'];
  if (message) args.push('-a', name, '-m', safeMultiline(message, 'Tag message', 1000));
  else args.push(name);
  if (ref) args.push(safeValue(ref, 'Ref'));
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function deleteTag(repoPath, name) {
  requireRepo(repoPath);
  const args = ['tag', '-d', safeValue(name, 'Tag name')];
  return withRisk(args, await runGitIn(repoPath, args));
}

export async function initRepository(targetPath, { initialBranch = 'main' } = {}) {
  const absolute = path.resolve(targetPath);
  if (!fs.existsSync(absolute)) throw new ActionError('That folder does not exist.', 404);
  if (!fs.statSync(absolute).isDirectory()) throw new ActionError('That path is not a folder.');
  const args = ['init', `--initial-branch=${safeValue(initialBranch, 'Branch name')}`];
  return withRisk(args, await runGitIn(absolute, args));
}

/**
 * Clones into a sibling folder. The destination is derived from the URL rather
 * than taken from the model, so a clone can never land in an unexpected place.
 */
export async function cloneRepository(url, destinationParent, { depth = null } = {}) {
  const parent = path.resolve(destinationParent);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new ActionError('Destination folder does not exist.', 404);
  }

  const safeUrlValue = safeUrl(url);
  const derived = deriveFolderName(safeUrlValue);
  const destination = path.join(parent, derived);

  if (fs.existsSync(destination)) {
    throw new ActionError(`"${derived}" already exists in that folder.`);
  }

  const args = ['clone'];
  if (depth) args.push('--depth', String(Math.max(1, Math.min(Number(depth) || 1, 500))));
  args.push(safeUrlValue, destination);

  return withRisk(args, await runGitIn(parent, args, { timeoutMs: 600_000 }));
}

export function deriveFolderName(url) {
  const withoutTrailingSlash = url.replace(/[/\\]+$/, '');
  const lastSegment = withoutTrailingSlash.split(/[/\\:]/).pop() || 'repository';
  return lastSegment.replace(/\.git$/i, '') || 'repository';
}

/** Settings writes are confined to the repository, never global or system. */
export async function setLocalConfig(repoPath, key, value) {
  requireRepo(repoPath);
  const allowed = new Set(['user.name', 'user.email', 'core.autocrlf', 'pull.rebase', 'init.defaultBranch', 'commit.gpgsign']);
  if (!allowed.has(key)) throw new ActionError(`Changing "${key}" is not supported in the app.`);
  if (value === '' || value === null) {
    const args = ['config', '--local', '--unset', key];
    return withRisk(args, await runGitIn(repoPath, args));
  }
  const args = ['config', '--local', key, safeValue(String(value), 'Value')];
  return withRisk(args, await runGitIn(repoPath, args));
}
