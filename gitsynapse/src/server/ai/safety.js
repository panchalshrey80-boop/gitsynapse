/**
 * Command safety classification.
 *
 * Rules of engagement:
 *  1. The AI's own risk claim is *never* trusted. This module classifies the
 *     argument vector independently and the stricter of the two wins.
 *  2. Hard-blocked forms are rejected outright. They are not "risky git"; they
 *     are a way to execute arbitrary programs through git, which defeats the
 *     entire argument-vector design.
 *  3. Classification is conservative: unknown subcommands are treated as
 *     mutating, and anything that discards uncommitted work is `destructive`.
 */

/** @typedef {'safe'|'writes'|'destructive'|'network'|'blocked'} RiskLevel */

export const RISK = {
  SAFE: 'safe',
  WRITES: 'writes',
  NETWORK: 'network',
  DESTRUCTIVE: 'destructive',
  BLOCKED: 'blocked',
};

/** Subcommands that only read repository state. */
const READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'shortlog', 'describe', 'rev-parse', 'rev-list',
  'blame', 'ls-files', 'ls-tree', 'cat-file', 'whatchanged', 'reflog', 'name-rev',
  'symbolic-ref', 'for-each-ref', 'count-objects', 'verify-pack', 'check-ignore',
  'var', 'help', 'version', 'cherry', 'grep',
]);

/** Subcommands that contact a remote but do not rewrite local history. */
const NETWORK = new Set(['fetch', 'ls-remote', 'remote']);

/**
 * Argument patterns that let git spawn an arbitrary process or write outside
 * the repository. Every one of these is a documented escape hatch.
 * @type {{pattern: RegExp, reason: string}[]}
 */
const BLOCKED_PATTERNS = [
  { pattern: /^--exec-path/, reason: 'Can redirect git to load an arbitrary binary.' },
  { pattern: /^--upload-pack/, reason: 'Can execute an arbitrary program on the remote side.' },
  { pattern: /^--receive-pack/, reason: 'Can execute an arbitrary program on the remote side.' },
  { pattern: /^--ext-diff/, reason: 'Enables execution of an external diff program.' },
  { pattern: /^--exec(=|$)/, reason: 'Runs an arbitrary command once per commit.' },
  { pattern: /^-c$/, reason: 'Inline config injection is not permitted; change settings in the app.' },
  { pattern: /^-c\s*(alias|core\.sshCommand|core\.pager|core\.editor|diff\.external|core\.gitProxy|core\.fsmonitor|protocol\..*\.allow|filter\.)/i, reason: 'This config key can run a shell command or weaken transport security.' },
  { pattern: /^--config-env/, reason: 'Config injection via environment variable.' },
  { pattern: /^--git-dir=/, reason: 'Can retarget git at an unintended repository.' },
  { pattern: /^--work-tree=/, reason: 'Can retarget git at an unintended working tree.' },
];

/**
 * Shell and OS utilities that are not git subcommands.
 *
 * The copilot reasons about a working tree and sometimes proposes the shell
 * command that would do the job — `rm`/`del` for a cache directory, `mv` to
 * rename, `cd` to move around. GitSynapse executes git only, and it always
 * prefixes the vector with `git`, so such a step would either be reinterpreted
 * as an unrelated git subcommand (`rm -rf __pycache__` runs `git rm`, which
 * deletes *tracked* files and cannot touch untracked ones) or fail on the
 * platform it was written for (`del` does not exist on macOS or Linux).
 *
 * Anything that is a genuine git subcommand is deliberately absent: `rm`, `mv`
 * and `grep` all exist in git and must keep working.
 */
const SHELL_UTILITIES = new Map([
  ['del', 'the Windows delete command'],
  ['erase', 'the Windows delete command'],
  ['rmdir', 'the Windows/Linux directory removal command'],
  ['rd', 'the Windows directory removal command'],
  ['md', 'the Windows mkdir command'],
  ['mkdir', 'a shell command'],
  ['move', 'the Windows rename command (git spells it "mv")'],
  ['ren', 'the Windows rename command (git spells it "mv")'],
  ['rename', 'a shell command (git spells it "mv")'],
  ['cp', 'a shell copy command'],
  ['copy', 'the Windows copy command'],
  ['xcopy', 'the Windows copy command'],
  ['robocopy', 'the Windows copy command'],
  ['cat', 'a shell command'],
  ['type', 'the Windows file-printing command'],
  ['echo', 'a shell command'],
  ['ls', 'a shell listing command'],
  ['dir', 'the Windows listing command'],
  ['find', 'a shell command'],
  ['findstr', 'the Windows search command'],
  ['sed', 'a stream editor'],
  ['awk', 'a text-processing tool'],
  ['perl', 'a scripting language'],
  ['cd', 'a shell directory change'],
  ['chmod', 'a shell permission change'],
  ['chown', 'a shell ownership change'],
  ['touch', 'a shell command'],
  ['tar', 'an archiving tool'],
  ['unzip', 'an archiving tool'],
  ['curl', 'a network tool'],
  ['wget', 'a network tool'],
  ['start', 'the Windows process launcher'],
  ['cmd', 'the Windows shell'],
  ['powershell', 'a shell'],
  ['pwsh', 'a shell'],
  ['bash', 'a shell'],
  ['sh', 'a shell'],
  ['zsh', 'a shell'],
  ['python', 'an interpreter'],
  ['python3', 'an interpreter'],
  ['py', 'an interpreter'],
  ['node', 'an interpreter'],
  ['npm', 'a package manager'],
  ['npx', 'a package runner'],
  ['yarn', 'a package manager'],
  ['pnpm', 'a package manager'],
  ['pip', 'a package manager'],
  ['pip3', 'a package manager'],
  ['taskkill', 'a Windows process command'],
  ['kill', 'a process command'],
  ['sudo', 'a privilege escalation tool'],
  ['attrib', 'the Windows attribute command'],
  ['icacls', 'the Windows permission command'],
  ['reg', 'the Windows registry command'],
  ['setx', 'the Windows environment command'],
]);

/** The one place the "ignore it instead" advice is written, so it stays consistent. */
export const IGNORE_ADVICE =
  'Build output and caches (__pycache__, *.pyc, *.lnk, .DS_Store) are better ignored than deleted — '
  + 'use the "Add ignores" action under Untracked in the Changes view.';

/** Subcommands that are never allowed through the app, regardless of flags. */
const BLOCKED_SUBCOMMANDS = new Map([
  ['filter-branch', 'Rewrites all history; run it manually if you really need it.'],
  ['filter-repo', 'Rewrites all history; run it manually if you really need it.'],
  ['daemon', 'Starts a network server.'],
  ['shell', 'Provides remote shell access.'],
  ['credential', 'Reads and writes stored credentials.'],
  ['send-email', 'Can send mail from your account.'],
  ['instaweb', 'Starts a web server.'],
  ['http-backend', 'Server-side helper, not usable locally.'],
]);

/**
 * Subcommands that are read-only when given no operand, and to which the
 * listing flags below are safe to add.
 */
const LISTING_FLAGS = new Set([
  '-a', '-r', '-v', '-vv', '-l', '--all', '--list', '--verbose', '--remotes',
  '--contains', '--merged', '--no-merged', '--points-at', '--sort',
]);

/**
 * Recognises `git branch -a`, `git tag -l`, `git remote -v`, `git stash list`
 * and friends, which read state and must not be treated as writes.
 */
function isListingOnly(args) {
  const [subcommand, ...rest] = args;
  if (!['branch', 'tag', 'remote', 'stash', 'worktree', 'config'].includes(subcommand)) return false;

  if (subcommand === 'stash') return rest[0] === 'list';
  if (subcommand === 'worktree') return rest[0] === 'list';
  if (subcommand === 'config') return rest.includes('--get') || rest.includes('--get-all') || rest.includes('--list') || rest.includes('-l');

  // `branch` and `tag` with no operands print a list.
  if (rest.length === 0) return true;

  // Otherwise every token must be a listing flag; any bare word is an operand.
  return rest.every((arg) => LISTING_FLAGS.has(arg)
    || arg.startsWith('--sort=')
    || arg.startsWith('--format=')
    || /^-\d+$/.test(arg));
}

/** Flags that imply the working tree or history is being discarded. */
const DESTRUCTIVE_RULES = [
  { test: (args) => args[0] === 'reset' && args.includes('--hard'), reason: 'Discards all uncommitted changes in tracked files.' },
  { test: (args) => args[0] === 'reset' && args.includes('--merge'), reason: 'Discards uncommitted changes before moving HEAD.' },
  { test: (args) => args[0] === 'clean' && args.some((a) => /^-[a-z]*f/.test(a) && a.startsWith('-') && !a.startsWith('--')), reason: 'Permanently deletes untracked files.' },
  { test: (args) => args[0] === 'clean' && args.includes('--force'), reason: 'Permanently deletes untracked files.' },
  { test: (args) => args[0] === 'push' && args.some((a) => a === '-f' || a === '--force'), reason: 'Overwrites the remote branch, discarding commits others may have.' },
  { test: (args) => args[0] === 'push' && args.some((a) => a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes')), reason: 'Rewrites the remote branch (lease-guarded, but still a rewrite).' },
  { test: (args) => args[0] === 'push' && args.includes('--delete'), reason: 'Deletes a branch on the remote.' },
  { test: (args) => args[0] === 'push' && args.includes('--mirror'), reason: 'Forces the remote to match local exactly, deleting refs.' },
  { test: (args) => args[0] === 'branch' && args.some((a) => a === '-D' || a === '--delete' || a === '--force'), reason: 'Deletes a branch even if it is not merged.' },
  { test: (args) => args[0] === 'tag' && args.some((a) => a === '-d' || a === '--delete'), reason: 'Deletes a tag.' },
  { test: (args) => args[0] === 'stash' && ['drop', 'clear'].includes(args[1]), reason: 'Discards stashed work permanently.' },
  { test: (args) => args[0] === 'checkout' && (args.includes('--') || args.includes('.')) && !args.includes('-b'), reason: 'Overwrites working-tree files with the committed version.' },
  { test: (args) => args[0] === 'restore' && !args.includes('--staged'), reason: 'Overwrites working-tree files, discarding edits.' },
  // Any `git rm` removes the file from the working tree as well as the index.
  // `--cached` is the documented way to untrack while keeping the file, and it
  // is the only form that does not touch the disk.
  { test: (args) => args[0] === 'rm' && !args.includes('--cached'), reason: 'Deletes the file from disk and records the deletion. Recover it with "git restore --staged --worktree <path>".' },
  { test: (args) => args[0] === 'rebase', reason: 'Rewrites commit history. Conflicts are possible.' },
  { test: (args) => args[0] === 'rebase' && args.includes('--exec'), reason: 'Runs arbitrary shell commands per commit.' },
  { test: (args) => args[0] === 'remote' && (args[1] === 'remove' || args[1] === 'rm' || args[1] === 'rename'), reason: 'Removes or renames a remote, affecting all its branches.' },
  { test: (args) => args[0] === 'update-ref' && args.includes('-d'), reason: 'Deletes a ref directly.' },
  { test: (args) => args[0] === 'gc' && args.includes('--prune=now'), reason: 'Aggressively prunes unreachable objects.' },
  { test: (args) => args[0] === 'submodule' && args[1] === 'deinit', reason: 'Removes submodule working trees.' },
];

/**
 * Classifies an argument vector.
 *
 * @param {string[]} args Argument vector *without* the leading "git".
 * @returns {{level: RiskLevel, reasons: string[], allowed: boolean}}
 */
export function classifyCommand(args) {
  const safeArgs = Array.isArray(args) ? args.filter((a) => typeof a === 'string') : [];

  if (safeArgs.length === 0) {
    return { level: RISK.BLOCKED, reasons: ['Empty command.'], allowed: false };
  }

  if (safeArgs[0].startsWith('-')) {
    return {
      level: RISK.BLOCKED,
      reasons: ['Global git flags must be given after the subcommand.'],
      allowed: false,
    };
  }

  const subcommand = safeArgs[0];

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    const hit = safeArgs.find((arg) => pattern.test(arg));
    if (hit) {
      return { level: RISK.BLOCKED, reasons: [`Blocked flag "${hit}": ${reason}`], allowed: false };
    }
  }

  // `-c key=value` style injection using two arguments.
  for (let i = 0; i < safeArgs.length - 1; i += 1) {
    if (safeArgs[i] === '-c') {
      return {
        level: RISK.BLOCKED,
        reasons: ['Blocked: "-c" inline configuration is not permitted.'],
        allowed: false,
      };
    }
  }

  if (subcommand === 'config') {
    const scoped = safeArgs.some((arg) => arg === '--local');
    const reading = safeArgs.some((arg) => arg === '--get' || arg === '--get-all' || arg === '--list');
    if (!scoped && !reading) {
      return {
        level: RISK.BLOCKED,
        reasons: ['Only repository-local config ("--local") may be changed from GitSynapse; global and system config are off limits.'],
        allowed: false,
      };
    }
  }

  const blockedSub = BLOCKED_SUBCOMMANDS.get(subcommand);
  if (blockedSub) {
    return { level: RISK.BLOCKED, reasons: [`"git ${subcommand}" is blocked. ${blockedSub}`], allowed: false };
  }

  // Aliases can expand to `!shell-command`, so a bare alias name is unknowable.
  if (subcommand.includes('=')) {
    return { level: RISK.BLOCKED, reasons: ['Alias definitions are not permitted.'], allowed: false };
  }

  // A shell/OS utility is not something this app can run, and running it as
  // `git <name>` would mean something entirely different.
  const utility = SHELL_UTILITIES.get(subcommand.toLowerCase());
  if (utility) {
    const equivalent = ['del', 'erase', 'rmdir', 'rd', 'rm'].includes(subcommand.toLowerCase())
      ? ` To remove a tracked file, ask for "git rm <path>" instead. ${IGNORE_ADVICE}`
      : ' GitSynapse runs git commands only.';
    return {
      level: RISK.BLOCKED,
      reasons: [`"${subcommand}" is ${utility}, not a git command.${equivalent}`],
      allowed: false,
    };
  }

  // `git rm` with nothing named is a usage error, not a deletion.
  if (subcommand === 'rm' && safeArgs.length === 1) {
    return {
      level: RISK.BLOCKED,
      reasons: ['"git rm" needs at least one path. ' + IGNORE_ADVICE],
      allowed: false,
    };
  }

  const reasons = [];
  let level = RISK.SAFE;

  if (isListingOnly(safeArgs)) {
    return { level: RISK.SAFE, reasons: [], allowed: true };
  }

  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.test(safeArgs)) {
      level = RISK.DESTRUCTIVE;
      reasons.push(rule.reason);
      break;
    }
  }

  if (level !== RISK.DESTRUCTIVE) {
    if (NETWORK.has(subcommand)) {
      level = RISK.NETWORK;
      reasons.push('Contacts a remote.');
    } else if (!READ_ONLY.has(subcommand)) {
      level = RISK.WRITES;
      reasons.push('Modifies the repository.');
    }
  }

  return { level, reasons, allowed: true };
}

/**
 * Merges the model's claimed risk with the independently computed risk and
 * returns the stricter classification.
 *
 * @param {string} claimed
 * @param {RiskLevel} computed
 * @returns {RiskLevel}
 */
export function strictestRisk(claimed, computed) {
  const order = [RISK.SAFE, RISK.NETWORK, RISK.WRITES, RISK.DESTRUCTIVE, RISK.BLOCKED];
  const claimedLevel = order.includes(claimed) ? claimed : RISK.WRITES;
  return order.indexOf(claimedLevel) > order.indexOf(computed) ? claimedLevel : computed;
}

/**
 * Whether a confirmation prompt is required for this command, given the
 * user's configured policy.
 *
 * @param {RiskLevel} level
 * @param {'all'|'destructive'|'never'} policy
 */
export function requiresConfirmation(level, policy = 'all') {
  if (level === RISK.BLOCKED) return true;
  if (policy === 'never') return level === RISK.DESTRUCTIVE;
  if (policy === 'destructive') return level === RISK.DESTRUCTIVE;
  return level !== RISK.SAFE; // policy === 'all'
}

/** True when the command is a read-only inspection that is safe to auto-run. */
export function isReadOnly(args) {
  return classifyCommand(args).level === RISK.SAFE;
}
