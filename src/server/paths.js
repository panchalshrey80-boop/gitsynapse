/**
 * Turning what a person typed into a real path.
 *
 * Both the "Initialise" and "Clone" dialogs ask the user to type a folder, and
 * people write paths the way they write them in a shell: `~/Projects/new-thing`.
 * Passing that to `path.resolve` produces `<cwd>/~/Projects/new-thing`, which
 * does not exist — so the app used to answer "That folder does not exist" for a
 * perfectly valid folder. The same function also stops an empty box from
 * resolving to the current working directory, which is how `git init` once ran
 * in the app's own install folder.
 *
 * There is one more deliberate choice here: relative paths resolve against the
 * **home directory**, not the process's working directory. A GUI's working
 * directory is an implementation detail — it is wherever the app happened to be
 * launched from — so `projects/thing` means `~/projects/thing`, which is what
 * someone typing it means.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Expands `~` and resolves a user-typed path to an absolute one.
 *
 * @param {unknown} input
 * @returns {string} an absolute path
 * @throws {PathError} when the input is empty or not a string
 */
export function expandUserPath(input) {
  if (typeof input !== 'string') {
    throw new PathError('Enter a folder path.', 'missing_path');
  }

  let value = input.trim();
  if (value === '') {
    throw new PathError('Enter a folder path.', 'missing_path');
  }

  // A path inside quotes is a common paste artifact, and leaving them on makes
  // every subsequent filesystem call fail for no visible reason.
  if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
    || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
    value = value.slice(1, -1).trim();
  }

  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  // `~someone` is left alone deliberately: it needs a passwd lookup, and on
  // macOS the home directory is not always /Users/<name>. Failing loudly on a
  // missing folder is better than resolving to the wrong one.
  if (value.startsWith('~')) {
    throw new PathError(
      `Only "~" and "~/" are understood, not "${value.split('/')[0]}". Use a full path instead.`,
      'unsupported_home',
    );
  }

  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(os.homedir(), value);
}

/**
 * A path problem the user can fix, as opposed to a crash.
 *
 * Carries a short machine-readable `code` so callers can special-case a few of
 * them (an unreadable folder on macOS is worth extra advice) without matching
 * on message text.
 */
export class PathError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {{cause?:unknown}} [meta]
   */
  constructor(message, code = 'invalid_path', meta = {}) {
    super(message);
    this.name = 'PathError';
    this.code = code;
    this.cause = meta.cause;
  }
}

/**
 * Reads a directory's permission errors as advice rather than an errno.
 *
 * On macOS this is the interesting one: a build that is not notarised and not
 * granted access gets `EPERM` for Desktop, Documents, Downloads and removable
 * volumes, because those are protected by TCC. A user seeing "some folders work
 * and some do not" is usually seeing exactly this, so the message names the
 * likely cause and the fix instead of printing "EACCES: permission denied".
 *
 * @param {unknown} error
 * @param {string} target
 */
export function describeFsError(error, target) {
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;

  if (code === 'EACCES' || code === 'EPERM') {
    return new PathError(
      `macOS did not allow access to ${target}. Folders like Desktop, Documents, `
      + 'Downloads and external drives are protected: open System Settings → Privacy & '
      + 'Security → Files and Folders (or Full Disk Access) and allow GitSynapse, then try '
      + 'again. A repository in your home directory usually needs no permission at all.',
      'permission_denied',
      { cause: error },
    );
  }

  if (code === 'ENOENT') {
    return new PathError(`${target} does not exist.`, 'not_found', { cause: error });
  }

  if (code === 'ENOTDIR') {
    return new PathError(`${target} is a file, not a folder.`, 'not_a_directory', { cause: error });
  }

  if (code === 'ELOOP') {
    return new PathError(
      `${target} is a symbolic link loop.`,
      'symlink_loop',
      { cause: error },
    );
  }

  if (code === 'ENAMETOOLONG') {
    return new PathError('That path is too long for this filesystem.', 'path_too_long', { cause: error });
  }

  return new PathError(`Could not read ${target}: ${error?.message || 'unknown error'}`, 'fs_error', { cause: error });
}

/** True when the path exists and is a directory. Never throws. */
export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path exists, is a directory, and can be listed. */
export function canRead(target) {
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects a bare repository.
 *
 * A bare repository has no working tree and no `.git` subdirectory — it *is*
 * the git directory — so `findRepositoryRoot` cannot find it, and the app used
 * to report "not a git repository" for one. `git init` in that same folder then
 * reported success without changing anything, leaving the user in a loop of
 * "not a repository" → "initialised" → "not a repository".
 *
 * Checked by looking for the pieces a git directory must have, rather than by
 * running git, so this works even when the folder is not a repository at all.
 */
export function lookLikeGitDirectory(target) {
  const required = ['HEAD', 'objects', 'refs'];
  return required.every((entry) => fs.existsSync(path.join(target, entry)));
}
