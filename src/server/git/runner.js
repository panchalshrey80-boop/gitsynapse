/**
 * Low-level git process runner.
 *
 * Design notes:
 *  - Every command is executed as an argument vector with `shell: false`.
 *    Nothing is ever concatenated into a shell string, so user/AI input
 *    cannot break out of the argument boundary. Paths containing spaces need
 *    no quoting here: the argument vector is passed to the OS intact, which is
 *    why a directory such as "vivid bills" works without special handling.
 *  - stdin is `/dev/null` (`stdio: ['ignore', 'pipe', 'pipe']`). A GUI has no
 *    TTY, so any process that decides to ask a question instead of exiting —
 *    git prompting for a password, ssh asking to accept a host key, a pager
 *    waiting for a keystroke — would otherwise block until the timeout. With
 *    stdin closed, such a read returns EOF immediately and the command fails
 *    with a message instead of hanging.
 *  - `GIT_TERMINAL_PROMPT=0` and `SSH_ASKPASS_REQUIRE=never` reinforce that:
 *    credential prompts are refused rather than silently awaited.
 *  - Every command is bounded by a timeout chosen in `command.js`.
 *  - The promise *always* settles. If a killed child leaves a grandchild
 *    holding the output pipes open, `close` never fires; a grace timer then
 *    resolves the call so a request can never hang forever.
 *  - Output is capped; a runaway command cannot exhaust memory.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatGitCommand, timeoutMessage, timeoutMsFor } from './command.js';
import { gitBinary } from '../env.js';

export { DEFAULT_TIMEOUT_MS, NETWORK_TIMEOUT_MS, READ_TIMEOUT_MS } from './command.js';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How long to wait for `close` after a kill before giving up on the pipes. */
const KILL_GRACE_MS = 5_000;

/** Windows launched-from-Explorer processes inherit a PATH without Git. */
const WINDOWS_GIT_CANDIDATES = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
];

let cachedBinary = null;

/**
 * Resolves the git executable once per process.
 * @returns {string} Absolute path to git, or bare "git" to defer to PATH.
 */
export function resolveGitBinary() {
  if (cachedBinary) return cachedBinary;

  const override = gitBinary();
  if (override) {
    cachedBinary = override;
    return cachedBinary;
  }

  if (process.platform === 'win32') {
    const found = WINDOWS_GIT_CANDIDATES.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (found) {
      cachedBinary = found;
      return cachedBinary;
    }
  }

  cachedBinary = 'git';
  return cachedBinary;
}

/**
 * @typedef {object} GitResult
 * @property {boolean} ok        True when exit code is 0.
 * @property {number} code       Process exit code (-1 = killed/timeout).
 * @property {string} stdout
 * @property {string} stderr
 * @property {string[]} args     The argument vector that was executed.
 * @property {string} command    Human-readable, paste-ready command, for display only.
 * @property {number} durationMs
 * @property {boolean} timedOut  True when the process was killed on the deadline.
 * @property {boolean} truncated True when output was dropped at the 8 MB cap.
 */

/**
 * Runs git with the given argument vector.
 *
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string>} [options.env]
 * @param {boolean} [options.allowNonZero] When false, a non-zero exit rejects.
 * @returns {Promise<GitResult>}
 */
export function runGit(args, options = {}) {
  const {
    cwd,
    timeoutMs: overrideTimeout,
    env = {},
    allowNonZero = true,
  } = options;

  if (!Array.isArray(args) || args.length === 0) {
    return Promise.reject(new Error('runGit requires a non-empty argument array'));
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return Promise.reject(new Error('runGit arguments must all be strings'));
    }
  }

  const binary = resolveGitBinary();
  const startedAt = Date.now();
  const timeoutMs = timeoutMsFor(args, overrideTimeout);

  // Global, safety-oriented flags. `-c core.quotepath=false` keeps non-ASCII
  // filenames readable instead of emitting octal escapes.
  const argv = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, argv, {
        cwd: cwd || process.cwd(),
        shell: false,
        windowsHide: true,
        // stdin closed: any read gets EOF instead of blocking for a TTY.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          GIT_OPTIONAL_LOCKS: '0',
          // OpenSSH 8.4+: never fall back to a GUI askpass dialog. Without this
          // a passphrase-protected key hangs a window with no way to answer.
          SSH_ASKPASS_REQUIRE: 'never',
          LC_ALL: 'C.UTF-8',
          ...env,
        },
      });
    } catch (error) {
      resolve(failure(args, error.message, startedAt));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    // Declared before `settle` closes over them: an error event can arrive
    // before the deadline is armed.
    let timer = null;
    let graceTimer = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ...result, timedOut, truncated });
    };

    const killTree = () => {
      // On Windows a plain kill() terminates only git itself; git may have
      // children (ssh, a credential helper, a pager) that hold the pipes open.
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          return;
        } catch {
          // Fall through to the portable path.
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // A grandchild can keep the pipes open after the kill, in which case
      // `close` never fires. Resolve anyway so the caller is never stuck.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(-1);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      else truncated = true;
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      else truncated = true;
    });

    child.on('error', (error) => {
      settle({ ...failure(args, error.message, startedAt), timedOut: false, truncated });
    });

    function finish(code) {
      const out = Buffer.concat(stdout).toString('utf8');
      const rawErr = Buffer.concat(stderr).toString('utf8');

      const notes = [];
      if (timedOut) notes.push(timeoutMessage(timeoutMs));
      if (truncated) notes.push('[output truncated]');
      const err = notes.length > 0 ? `${rawErr}${rawErr ? '\n' : ''}${notes.join('\n')}` : rawErr;

      const result = {
        ok: code === 0 && !timedOut,
        code: code ?? -1,
        stdout: out,
        stderr: err,
        args,
        command: formatGitCommand(args),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      };

      if (!result.ok && !allowNonZero) {
        const error = new Error(
          (rawErr || out || 'git command failed').trim().split('\n').slice(0, 6).join('\n'),
        );
        error.name = 'GitCommandError';
        error.result = result;
        settle(Object.assign(result, { error }));
        return;
      }
      settle(result);
    }

    child.on('close', (code) => finish(code));
  });
}

function failure(args, message, startedAt) {
  return {
    ok: false,
    code: -1,
    stdout: '',
    stderr: message,
    args,
    command: formatGitCommand(args),
    durationMs: Date.now() - startedAt,
    timedOut: false,
    truncated: false,
  };
}

/** @returns {Promise<string>} Version string such as "2.47.3", or "" when missing. */
export async function gitVersion() {
  const result = await runGit(['--version'], { timeoutMs: 10_000 });
  if (!result.ok) return '';
  return result.stdout.trim().replace(/^git version\s+/i, '');
}

/**
 * Runs a git command inside a specific repository. The path is assumed to have
 * already been validated by the repo registry.
 */
export function runGitIn(repoPath, args, options = {}) {
  return runGit(args, { ...options, cwd: repoPath });
}
