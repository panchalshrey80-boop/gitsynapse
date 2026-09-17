/**
 * Repository discovery and read-only queries.
 *
 * Nothing in this module mutates a repository. All write operations live in
 * actions.js and pass through the safety layer first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runGitIn } from './runner.js';
import { partitionJunk } from './junk.js';
import {
  LOG_FORMAT,
  FS,
  parseBranches,
  parseDiff,
  parseLog,
  parseNumstat,
  parseStatus,
} from './porcelain.js';

/**
 * Walks up from `inputPath` looking for a `.git` entry, the way git itself
 * resolves the repository root.
 *
 * @param {string} inputPath
 * @returns {{root:string, gitDir:string}|null}
 */
export function findRepositoryRoot(inputPath) {
  let current;
  try {
    current = fs.realpathSync(path.resolve(inputPath));
  } catch {
    return null;
  }

  if (!isDirectory(current)) return null;

  for (let depth = 0; depth < 40; depth += 1) {
    const gitEntry = path.join(current, '.git');
    try {
      const stat = fs.statSync(gitEntry);
      if (stat.isDirectory()) return { root: current, gitDir: gitEntry };
      if (stat.isFile()) {
        // Worktree or submodule: ".git" is a file containing "gitdir: <path>".
        const contents = fs.readFileSync(gitEntry, 'utf8');
        const match = /^gitdir:\s*(.+)$/m.exec(contents);
        if (match) {
          return { root: current, gitDir: path.resolve(current, match[1].trim()) };
        }
      }
    } catch {
      // Not a repository at this level; keep walking up.
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/** @returns {boolean} */
export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists immediate sub-directories, for the folder picker.
 * Hidden directories are included but flagged so the UI can dim them.
 * @param {string} target
 */
export function listDirectories(target) {
  const absolute = path.resolve(target);
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => {
      const full = path.join(absolute, entry.name);
      return {
        name: entry.name,
        path: full,
        hidden: entry.name.startsWith('.'),
        isRepo: fs.existsSync(path.join(full, '.git')),
        readable: canRead(full),
      };
    })
    .filter((entry) => entry.readable)
    .sort((a, b) => {
      if (a.isRepo !== b.isRepo) return a.isRepo ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  const parent = path.dirname(absolute);
  return {
    path: absolute,
    parent: parent === absolute ? null : parent,
    entries: directories,
  };
}

function canRead(target) {
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Aggregated repository state for the main screen.
 * @param {string} repoPath
 */
export async function getStatus(repoPath) {
  const [statusResult, branchResult, remoteResult, headResult] = await Promise.all([
    runGitIn(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch']),
    runGitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGitIn(repoPath, ['remote']),
    runGitIn(repoPath, ['rev-parse', '--short', 'HEAD']),
  ]);

  const branch = branchResult.ok ? branchResult.stdout.trim() : 'HEAD';
  // Tracking info needs the branch name, so it is queried after the fact.
  const trackingResult = await runGitIn(repoPath, [
    'for-each-ref',
    `--format=%(upstream:short)${FS}%(upstream:track,nobracket)`,
    `refs/heads/${branch}`,
  ]);

  const parsed = parseStatus(stripBranchHeader(statusResult.stdout));
  const { visible: files, noise } = partitionJunk(parsed);
  const tracking = parseTrackString(trackingResult.stdout);
  const staged = files.filter((file) => file.staged);
  const unstaged = files.filter((file) => file.unstaged || file.untracked);
  const conflicted = files.filter((file) => file.conflicted);

  return {
    branch,
    head: headResult.ok ? headResult.stdout.trim() : '',
    upstream: tracking.upstream,
    ahead: tracking.ahead,
    behind: tracking.behind,
    detached: branch === 'HEAD' || branch === '',
    files,
    stagedCount: staged.length,
    unstagedCount: unstaged.length,
    conflictCount: conflicted.length,
    // Noise is reported separately rather than merely dropped: `clean` reflects
    // committable work, and the caller can still tell the user what was left out.
    noiseCount: noise.length,
    noise,
    clean: files.length === 0,
    hasRemotes: remoteResult.ok && remoteResult.stdout.trim().length > 0,
  };
}

/**
 * `--branch` adds `## main...origin/main [ahead 1]` before the file records.
 * @param {string} raw
 */
function stripBranchHeader(raw) {
  if (!raw.startsWith('##')) return raw;
  const nul = raw.indexOf('\0');
  if (nul === -1) return '';
  return raw.slice(nul + 1);
}

function parseTrackString(raw) {
  const line = raw.split('\n').find((entry) => entry.includes(FS));
  if (!line) return { upstream: null, ahead: 0, behind: 0 };
  const [upstream, track] = line.split(FS);
  const ahead = /ahead (\d+)/.exec(track || '');
  const behind = /behind (\d+)/.exec(track || '');
  return {
    upstream: upstream?.trim() || null,
    ahead: ahead ? Number.parseInt(ahead[1], 10) : 0,
    behind: behind ? Number.parseInt(behind[1], 10) : 0,
  };
}

export async function currentBranch(repoPath) {
  const result = await runGitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.ok ? result.stdout.trim() : 'HEAD';
}

/**
 * @param {string} repoPath
 * @param {{limit?:number, skip?:number, ref?:string}} [options]
 */
export async function getLog(repoPath, options = {}) {
  const { limit = 120, skip = 0, ref } = options;
  const args = [
    'log',
    `--max-count=${Math.min(Math.max(limit, 1), 500)}`,
    `--skip=${Math.max(skip, 0)}`,
    `--date=iso-strict`,
    `--format=${LOG_FORMAT}`,
  ];
  if (ref) args.push(ref);
  else args.push('HEAD');

  const result = await runGitIn(repoPath, args);
  return parseLog(result.ok ? result.stdout : '');
}

/**
 * Full diff payload for the diff pane: raw text plus parsed numstat.
 *
 * @param {string} repoPath
 * @param {{file?:string, staged?:boolean, commit?:string, untracked?:boolean}} [options]
 */
export async function getDiff(repoPath, options = {}) {
  const { file, staged = false, commit, untracked = false } = options;

  if (untracked && file) {
    return getUntrackedDiff(repoPath, file);
  }

  // `-m --first-parent` makes a merge commit show what it brought in relative
  // to the branch it was merged into. Without it, `git show` on a merge prints
  // no file list at all, which reads as "this commit changed nothing".
  const base = commit
    ? ['show', '--format=', '--no-color', '-M', '-m', '--first-parent', commit]
    : ['diff', '--no-color', '-M'];
  const args = [...base];
  if (commit && file) {
    args.push('--', file);
  } else if (!commit) {
    if (staged) args.push('--cached');
    if (file) args.push('--', file);
  }

  const [diffResult, statResult] = await Promise.all([
    runGitIn(repoPath, args),
    runGitIn(repoPath, [
      'diff',
      '--numstat',
      '-z',
      ...(commit ? ['--no-renames', `${commit}^..${commit}`] : staged ? ['--cached'] : []),
      ...(file && !commit ? ['--', file] : []),
    ]),
  ]);

  const raw = diffResult.stdout;
  return {
    file: file || null,
    staged,
    commit: commit || null,
    raw,
    lines: parseDiff(raw),
    stats: Object.fromEntries(parseNumstat(statResult.stdout)),
    truncated: raw.length > 400_000 ? raw.slice(0, 400_000) : raw,
  };
}

/** Renders an untracked file as a whole-file addition. */
async function getUntrackedDiff(repoPath, file) {
  const absolute = path.resolve(repoPath, file);
  if (!absolute.startsWith(path.resolve(repoPath) + path.sep)) {
    return { file, staged: false, commit: null, raw: '', lines: [], stats: {}, error: 'Path escapes repository root' };
  }

  let contents = '';
  let binary = false;
  try {
    const buffer = fs.readFileSync(absolute);
    binary = buffer.includes(0);
    contents = binary ? '' : buffer.toString('utf8');
  } catch (error) {
    return { file, staged: false, commit: null, raw: '', lines: [], stats: {}, error: error.message };
  }

  if (binary) {
    return {
      file,
      staged: false,
      commit: null,
      raw: '',
      lines: [{ text: 'Binary file (not shown)', type: 'meta', oldLine: null, newLine: null }],
      stats: {},
      untracked: true,
    };
  }

  const lines = contents.split('\n');
  const rendered = [
    { text: `new file: ${file}`, type: 'meta', oldLine: null, newLine: null },
    { text: `@@ -0,0 +1,${lines.length} @@`, type: 'hunk', oldLine: null, newLine: null },
    ...lines.map((text, index) => ({
      text: `+${text}`,
      type: 'add',
      oldLine: null,
      newLine: index + 1,
    })),
  ];

  return {
    file,
    staged: false,
    commit: null,
    untracked: true,
    raw: '',
    lines: rendered.slice(0, 3000),
    stats: { [file]: { additions: lines.length, deletions: 0 } },
  };
}

export async function getBranches(repoPath) {
  const [local, remote] = await Promise.all([
    runGitIn(repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=%(refname:short)${FS}%(HEAD)${FS}%(upstream:short)${FS}%(committerdate:iso-strict)${FS}%(contents:subject)`,
      'refs/heads',
    ]),
    runGitIn(repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=%(refname:short)${FS}%(HEAD)${FS}%(upstream:short)${FS}%(committerdate:iso-strict)${FS}%(contents:subject)`,
      'refs/remotes',
    ]),
  ]);

  const remotes = parseBranches(remote.stdout, true).filter(
    (branch) => !branch.name.endsWith('/HEAD'),
  );

  return {
    local: parseBranches(local.stdout, false),
    remote: remotes,
    current: await currentBranch(repoPath),
  };
}

export async function getRemotes(repoPath) {
  const result = await runGitIn(repoPath, ['remote', '-v']);
  if (!result.ok) return [];
  const seen = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    if (!seen.has(name)) seen.set(name, { name, fetchUrl: '', pushUrl: '' });
    const entry = seen.get(name);
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return [...seen.values()];
}

export async function getStashList(repoPath) {
  // Note: `stash list` takes *log* formatting, not the `%(field)` syntax used
  // by for-each-ref. %gd is the reflog selector, %gs the reflog subject.
  const result = await runGitIn(repoPath, [
    'stash',
    'list',
    `--format=%h${FS}%gd${FS}%gs`,
  ]);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, ref, subject] = line.split(FS);
      return { hash, ref, subject };
    });
}

export async function getTags(repoPath) {
  const result = await runGitIn(repoPath, [
    'for-each-ref',
    '--sort=-creatordate',
    '--count=50',
    `--format=%(refname:short)${FS}%(objectname:short)${FS}%(creatordate:iso-strict)`,
    'refs/tags',
  ]);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, hash, date] = line.split(FS);
      return { name, hash, date };
    });
}

/** Detects an in-progress merge/rebase/cherry-pick so the UI can offer recovery. */
export async function getOperationState(repoPath) {
  const { gitDir } = findRepositoryRoot(repoPath) || {};
  if (!gitDir) return { inProgress: null };
  const checks = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ];
  for (const [entry, name] of checks) {
    if (fs.existsSync(path.join(gitDir, entry))) return { inProgress: name };
  }
  return { inProgress: null };
}
