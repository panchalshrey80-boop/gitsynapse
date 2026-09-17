/**
 * Command text and time budgets.
 *
 * One module owns two things that must never disagree between call sites:
 *   1. How a git argument vector is rendered as text a human can read *and
 *      paste into a shell*. A path or message with a space is quoted, so the
 *      string shown in the UI, copied by the Copy button, and echoed by the
 *      runner are all the same command.
 *   2. How long a git process may live. Every command is bounded; the only
 *      question is which budget applies.
 *
 * Quoting here is display-only. Execution always passes the argument vector to
 * spawn with `shell: false`, so no shell ever parses this text.
 */

/* ------------------------------------------------------------------ *
 * Display
 * ------------------------------------------------------------------ */

/** Characters that are safe to leave unquoted in a shell word. */
const SHELL_SAFE = /^[A-Za-z0-9._/=:@^+-]+$/;

/**
 * Renders one argument the way a shell would need it written.
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteArg(arg) {
  const value = String(arg);
  if (value === '') return "''";
  if (SHELL_SAFE.test(value)) return value;
  // Double quotes are the portable choice: they work in POSIX shells, in
  // cmd.exe and in PowerShell, unlike single quotes.
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

/**
 * Renders a git argument vector as a paste-ready command line.
 *
 * @param {string[]} args Argument vector *without* the leading "git".
 * @returns {string}
 */
export function formatGitCommand(args) {
  const list = Array.isArray(args) ? args : [];
  return `git ${list.map(quoteArg).join(' ')}`.trim();
}

/* ------------------------------------------------------------------ *
 * Time budgets
 * ------------------------------------------------------------------ */

/** Reads that drive the UI refresh loop; a slow one shows up as a frozen app. */
export const READ_TIMEOUT_MS = 30_000;

/** Everything local that is not a known-slow read. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Operations that talk to a remote and may legitimately take minutes. */
export const NETWORK_TIMEOUT_MS = 300_000;

/** A first clone can be a large download. */
export const CLONE_TIMEOUT_MS = 600_000;

/** Reads the UI calls on every refresh. */
const FAST_READS = new Set([
  'status', 'log', 'diff', 'show', 'for-each-ref', 'rev-parse', 'rev-list',
  'symbolic-ref', 'branch', 'tag', 'remote', 'stash', 'describe', 'name-rev',
  'ls-files', 'ls-tree', 'cat-file', 'reflog', 'blame', 'check-ignore',
]);

/** Commands that contact a remote. `remote` is included: `remote update` fetches. */
const NETWORK_OPS = new Set(['fetch', 'pull', 'push', 'ls-remote', 'remote', 'submodule']);

/** Local maintenance that is slow by nature on a large repository. */
const HEAVY_OPS = new Set(['gc', 'repack', 'prune', 'fsck', 'filter-repo', 'count-objects']);

/**
 * Chooses a timeout for an argument vector.
 *
 * An explicit `override` always wins: the action layer knows when an operation
 * is a bulk one (a 600k-object clone) better than a heuristic can.
 *
 * @param {string[]} args
 * @param {number} [override]
 * @returns {number} milliseconds
 */
export function timeoutMsFor(args, override) {
  if (Number.isFinite(override) && override > 0) return override;

  const subcommand = Array.isArray(args) ? args[0] : undefined;
  if (!subcommand) return DEFAULT_TIMEOUT_MS;
  if (subcommand === 'clone') return CLONE_TIMEOUT_MS;
  if (NETWORK_OPS.has(subcommand)) return NETWORK_TIMEOUT_MS;
  if (HEAVY_OPS.has(subcommand)) return NETWORK_TIMEOUT_MS;
  if (FAST_READS.has(subcommand)) return READ_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * True when a killed process should be reported as a timeout rather than a
 * generic failure. Kept here so the runner and the UI agree on the wording.
 *
 * @param {number} ms
 * @returns {string}
 */
export function timeoutMessage(ms) {
  const seconds = Math.round(ms / 1000);
  return `git did not finish within ${seconds}s and was stopped. `
    + 'This usually means it was waiting for input, credentials, or a remote that never answered.';
}
