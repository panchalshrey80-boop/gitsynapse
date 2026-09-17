/**
 * Read-only repository and filesystem routes.
 * Nothing in this router mutates a repository.
 */

import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  findRepositoryRoot,
  getBranches,
  getDiff,
  getLog,
  getOperationState,
  getRemotes,
  getStashList,
  getStatus,
  getTags,
  isDirectory,
  listDirectories,
} from '../git/repository.js';
import { runGitIn } from '../git/runner.js';
import { rememberRepo } from '../store.js';

export const repoRouter = express.Router();

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Repository path from the query string, validated against the filesystem.
 * @param {string} raw
 */
function requireRepoPath(raw) {
  if (!raw) {
    const error = new Error('A repository path is required.');
    error.status = 400;
    throw error;
  }
  const resolved = path.resolve(raw);
  const found = findRepositoryRoot(resolved);
  if (!found) {
    const error = new Error('No git repository found at or above that path.');
    error.status = 404;
    throw error;
  }
  return found.root;
}

/** Common root options for the folder picker (Windows drives, home, root). */
repoRouter.get('/fs/roots', (req, res) => {
  const roots = [{ label: 'Home', path: os.homedir() }];

  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (isDirectory(drive)) roots.push({ label: `Drive ${letter}`, path: drive });
    }
  } else {
    roots.push({ label: 'Root', path: '/' });
    for (const candidate of ['/mnt', '/media', '/Volumes']) {
      if (isDirectory(candidate)) roots.push({ label: candidate, path: candidate });
    }
  }

  const seen = new Set();
  res.json({ roots: roots.filter((root) => !seen.has(root.path) && seen.add(root.path)) });
});

repoRouter.get('/fs/list', (req, res) => {
  const target = req.query.path ? String(req.query.path) : os.homedir();
  if (!isDirectory(target)) {
    res.status(404).json({ error: 'not_a_directory', message: 'That folder does not exist.' });
    return;
  }
  const listing = listDirectories(target);
  listing.isRepo = Boolean(findRepositoryRoot(listing.path));
  res.json(listing);
});

/** Opens a repository: validates it, records it in recents, returns status. */
repoRouter.post('/repo/open', asyncRoute(async (req, res) => {
  const requested = String(req.body?.path || '').trim();
  if (!requested) {
    res.status(400).json({ error: 'missing_path', message: 'Choose a folder first.' });
    return;
  }

  const found = findRepositoryRoot(requested);
  if (!found) {
    res.status(404).json({
      error: 'not_a_repository',
      message: 'That folder is not a git repository. You can initialise one from the welcome screen.',
    });
    return;
  }

  rememberRepo(found.root);

  const [status, state, remotes] = await Promise.all([
    getStatus(found.root),
    getOperationState(found.root),
    getRemotes(found.root),
  ]);

  res.json({
    path: found.root,
    name: path.basename(found.root),
    status,
    operationState: state,
    remotes,
  });
}));

repoRouter.get('/repo/status', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  const [status, state] = await Promise.all([getStatus(repoPath), getOperationState(repoPath)]);
  res.json({ path: repoPath, status, operationState: state });
}));

repoRouter.get('/repo/log', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  const limit = Number.parseInt(req.query.limit, 10) || 100;
  const skip = Number.parseInt(req.query.skip, 10) || 0;
  const commits = await getLog(repoPath, { limit, skip, ref: req.query.ref ? String(req.query.ref) : undefined });
  res.json({ path: repoPath, commits });
}));

/** Commit graph for the history view: refs plus parents per commit. */
repoRouter.get('/repo/graph', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 120, 400);

  const result = await runGitIn(repoPath, [
    'log',
    `--max-count=${limit}`,
    '--date=iso-strict',
    '--format=%H\x1f%h\x1f%an\x1f%aI\x1f%s\x1f%D\x1f%P\x1e',
  ]);

  const records = result.ok
    ? result.stdout
        .split('\x1e')
        .map((record) => record.replace(/^\n+/, '').trim())
        .filter(Boolean)
        .map((record) => {
          const [hash, short, author, date, subject, refs, parents] = record.split('\x1f');
          return {
            hash,
            short,
            author,
            date,
            subject,
            refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [],
            parents: parents ? parents.split(' ').filter(Boolean) : [],
          };
        })
    : [];

  // Lane assignment: a simplified swimlane pass, good enough for a local view.
  const lanes = assignLanes(records);
  res.json({ path: repoPath, commits: records.map((commit, index) => ({ ...commit, lane: lanes[index] })) });
}));

/**
 * Assigns each commit a lane index by tracking which lane expects which hash
 * next. This is the standard "first-parent continues, others take new lanes"
 * heuristic used by lightweight log viewers.
 *
 * @param {Array<{hash:string, parents:string[]}>} commits
 * @returns {number[]}
 */
function assignLanes(commits) {
  const pending = []; // lane -> hash that this lane is waiting for
  const laneOf = [];
  let maxLane = -1;

  for (const commit of commits) {
    let lane = pending.indexOf(commit.hash);
    if (lane === -1) {
      lane = pending.indexOf(null);
      if (lane === -1) {
        lane = pending.length;
        pending.push(null);
      }
    }

    pending[lane] = commit.parents[0] || null;
    maxLane = Math.max(maxLane, lane);

    for (let i = 1; i < commit.parents.length; i += 1) {
      const parent = commit.parents[i];
      if (pending.includes(parent)) continue;
      const free = pending.indexOf(null);
      if (free === -1) pending.push(parent);
      else pending[free] = parent;
    }

    laneOf.push(lane);
  }

  return laneOf;
}

repoRouter.get('/repo/diff', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  const diff = await getDiff(repoPath, {
    file: req.query.file ? String(req.query.file) : undefined,
    staged: req.query.staged === 'true',
    commit: req.query.commit ? String(req.query.commit) : undefined,
    untracked: req.query.untracked === 'true',
  });
  res.json({ path: repoPath, diff });
}));

repoRouter.get('/repo/branches', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  res.json({ path: repoPath, ...(await getBranches(repoPath)) });
}));

repoRouter.get('/repo/remotes', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  res.json({ path: repoPath, remotes: await getRemotes(repoPath) });
}));

repoRouter.get('/repo/stash', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  res.json({ path: repoPath, stashes: await getStashList(repoPath) });
}));

repoRouter.get('/repo/tags', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  res.json({ path: repoPath, tags: await getTags(repoPath) });
}));

/** Commit detail: message body, stats and changed files. */
repoRouter.get('/repo/commit', asyncRoute(async (req, res) => {
  const repoPath = requireRepoPath(req.query.path);
  const hash = String(req.query.hash || '');
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    res.status(400).json({ error: 'bad_hash', message: 'A commit hash is required.' });
    return;
  }

  const [meta, files] = await Promise.all([
    runGitIn(repoPath, [
      'show',
      '--no-patch',
      '--format=%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%cn\x1f%ce\x1f%cI\x1f%s\x1f%b\x1f%P',
      hash,
    ]),
    runGitIn(repoPath, ['show', '--name-status', '--format=', '-M', '-m', '--first-parent', hash]),
  ]);

  if (!meta.ok) {
    res.status(404).json({ error: 'commit_not_found', message: 'That commit is not in this repository.' });
    return;
  }

  const [full, short, author, email, authoredAt, committer, committerEmail, committedAt, subject, body, parents] =
    meta.stdout.split('\x1f');

  const parentList = (parents || '').trim().split(/\s+/).filter(Boolean);

  const changedFiles = files.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest.join('\t') };
    });

  res.json({
    path: repoPath,
    commit: {
      hash: full,
      short,
      author,
      email,
      authoredAt,
      committer,
      committerEmail,
      committedAt,
      subject,
      body: (body || '').trim(),
      parents: parentList,
      isMerge: parentList.length > 1,
      files: changedFiles,
    },
  });
}));

export { asyncRoute };
