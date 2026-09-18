/**
 * Parsers for git's machine-readable output.
 *
 * Every parser here is paired with a fixed-format git invocation (a `--format`
 * or `--porcelain` flag). Git's human-readable output is locale-dependent and
 * column-aligned; parsing it is the classic bug in home-made git GUIs, so we
 * never do it.
 */

/** Field and record separators used in custom --format strings. */
export const FS = '\u001f'; // unit separator
export const RS = '\u001e'; // record separator

const XY_LABELS = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'ignored',
};

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * In -z mode records are NUL separated, and rename/copy records emit the new
 * path first, then the original path as a separate NUL-terminated token.
 *
 * @param {string} raw
 * @returns {Array<{path:string, origPath:string|null, index:string, worktree:string, state:string, staged:boolean, unstaged:boolean, untracked:boolean, conflicted:boolean}>}
 */
export function parseStatus(raw) {
  const tokens = raw.split('\0');
  const files = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    if (!record || record.length < 4) continue;

    const index = record[0];
    const worktree = record[1];
    const filePath = record.slice(3);
    let origPath = null;

    const isRenameOrCopy = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C';
    if (isRenameOrCopy) {
      origPath = tokens[i + 1] || null;
      i += 1;
    }

    const untracked = index === '?' && worktree === '?';
    const conflicted =
      index === 'U' ||
      worktree === 'U' ||
      (index === 'A' && worktree === 'A') ||
      (index === 'D' && worktree === 'D');

    files.push({
      path: filePath,
      origPath,
      index,
      worktree,
      state: XY_LABELS[index] || XY_LABELS[worktree] || 'changed',
      staged: index !== ' ' && index !== '?' && index !== '!',
      unstaged: worktree !== ' ' && worktree !== '?' && worktree !== '!',
      untracked,
      conflicted,
    });
  }

  return files;
}

/**
 * Parses the output of a `%x1f`-delimited `git log --format=...`.
 * @param {string} raw
 */
export function parseLog(raw) {
  return raw
    .split(RS)
    .map((record) => record.replace(/^\n+/, '').trimEnd())
    .filter(Boolean)
    .map((record) => {
      const [hash, short, author, email, date, subject, refs] = record.split(FS);
      return {
        hash,
        short,
        author,
        email,
        date,
        subject,
        refs: refs ? refs.split(',').map((r) => r.trim()).filter(Boolean) : [],
      };
    });
}

/** `git log` format string matching {@link parseLog}. */
export const LOG_FORMAT = [
  '%H',
  '%h',
  '%an',
  '%ae',
  '%aI',
  '%s',
  '%D',
].join('%x1f') + '%x1e';

/**
 * Parses `git branch --format=%(refname:short)%x1f...`.
 * @param {string} raw
 * @param {boolean} isRemote
 */
export function parseBranches(raw, isRemote = false) {
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, head, upstream, date, subject] = line.split(FS);
      return {
        name,
        current: head === '*',
        upstream: upstream || null,
        date: date || null,
        subject: subject || '',
        remote: isRemote,
      };
    });
}

/**
 * Parses a unified diff into hunks so the UI can render it without a diff
 * library. Handles the standard `@@ -a,b +c,d @@` header form.
 *
 * @param {string} raw
 * @returns {{text:string, type:'context'|'add'|'remove'|'meta'|'hunk', oldLine:number|null, newLine:number|null}[]}
 */
export function parseDiff(raw) {
  const lines = raw.split('\n');
  const output = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
      }
      output.push({ text: line, type: 'hunk', oldLine: null, newLine: null });
      continue;
    }

    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('Binary files')
    ) {
      output.push({ text: line, type: 'meta', oldLine: null, newLine: null });
      continue;
    }

    if (line.startsWith('+')) {
      output.push({ text: line, type: 'add', oldLine: null, newLine: newLine++ });
      continue;
    }
    if (line.startsWith('-')) {
      output.push({ text: line, type: 'remove', oldLine: oldLine++, newLine: null });
      continue;
    }
    if (line.startsWith('\\')) {
      output.push({ text: line, type: 'meta', oldLine: null, newLine: null });
      continue;
    }

    output.push({ text: line, type: 'context', oldLine: oldLine++, newLine: newLine++ });
  }

  return output.filter((line, index) => !(index === output.length - 1 && line.text === ''));
}

/**
 * Parses `git diff --numstat -z` into per-file add/delete counts.
 * @param {string} raw
 * @returns {Map<string, {additions:number|null, deletions:number|null}>}
 */
export function parseNumstat(raw) {
  const map = new Map();
  for (const record of raw.split('\0')) {
    if (!record.trim()) continue;
    const [adds, dels, file] = record.split('\t');
    if (!file) continue;
    map.set(file, {
      additions: adds === '-' ? null : Number.parseInt(adds, 10),
      deletions: dels === '-' ? null : Number.parseInt(dels, 10),
    });
  }
  return map;
}
