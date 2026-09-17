/**
 * Plan executor.
 *
 * This is the single choke point through which every AI-proposed command must
 * pass, whether it was triggered by a button in the UI or auto-run. The rules
 * are enforced here rather than in the renderer, because a renderer can be
 * replaced by anyone with devtools open.
 */

import { runGitIn } from './runner.js';
import { RISK, IGNORE_ADVICE, classifyCommand, requiresConfirmation } from '../ai/safety.js';
import { loadConfig } from '../store.js';

/**
 * Re-validates a step immediately before execution.
 * @param {any} step
 * @returns {{ok:true, args:string[], verdict:object} | {ok:false, reason:string}}
 */
export function validateStep(step) {
  if (!step || !Array.isArray(step.args) || step.args.length === 0) {
    return { ok: false, reason: 'Malformed step: no arguments.' };
  }

  const args = step.args.map((arg) => String(arg));

  for (const arg of args) {
    if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
      return { ok: false, reason: 'Argument contains control characters.' };
    }
  }

  const verdict = classifyCommand(args);
  if (!verdict.allowed) {
    return { ok: false, reason: verdict.reasons.join(' ') };
  }

  return { ok: true, args, verdict };
}

/**
 * Decides what must happen before a step runs.
 *
 * Read-only commands are governed by `autoRunReadOnly`; everything else by the
 * confirmation policy. Destructive steps additionally require the caller to
 * pass `allowDestructive`, which is only set after a dialog that listed the
 * exact commands — a plan can never quietly rewrite history.
 *
 * @param {object} verdict
 * @param {{allowDestructive?:boolean}} options
 */
function needsConfirmation(verdict) {
  const config = loadConfig();
  if (verdict.level === RISK.SAFE) return !config.autoRunReadOnly;
  return requiresConfirmation(verdict.level, config.confirmPolicy);
}

/**
 * Runs one step.
 *
 * @param {string} repoPath
 * @param {object} step
 * @param {{confirmed?:boolean}} [options]
 * @returns {Promise<{status:'ran'|'blocked'|'needs_confirmation'|'failed', result?:object, verdict?:object, reason?:string}>}
 */
export async function executeStep(repoPath, step, options = {}) {
  const { confirmed = false, allowDestructive = false } = options;

  const validation = validateStep(step);
  if (!validation.ok) {
    return { status: 'blocked', reason: validation.reason };
  }

  const { args, verdict } = validation;

  // Destructive work needs the dedicated flag, not merely "the user clicked
  // once". A blanket approval of a plan must not cover a history rewrite it
  // never showed them.
  if (verdict.level === RISK.DESTRUCTIVE && !allowDestructive) {
    return { status: 'needs_confirmation', verdict };
  }

  if (!confirmed && needsConfirmation(verdict)) {
    return { status: 'needs_confirmation', verdict };
  }

  // All AI-proposed commands run through the same runner as the UI buttons:
  // argument vector, no shell, bounded time. No blanket override is passed, so
  // the timeout policy in command.js applies — a read gets 30s, a push 5 min.
  // A blanket 2-minute ceiling would leave the panel frozen on a stuck read.
  const result = await runGitIn(repoPath, args);

  if (!result.ok) {
    return {
      status: 'failed',
      verdict,
      result,
      reason: describeFailure(args, result),
    };
  }

  return { status: 'ran', verdict, result };
}

/**
 * Turns a failed step into the one line the user will actually read.
 *
 * Two failures need explaining rather than quoting: a command killed on its
 * deadline (the raw stderr is usually empty), and `git rm` aimed at files git
 * does not track — which is what happens when the copilot answers "delete the
 * __pycache__ folder" with a removal command.
 *
 * @param {string[]} args
 * @param {object} result
 * @returns {string}
 */
function describeFailure(args, result) {
  if (result.timedOut) {
    return result.stderr.trim().split('\n')[0];
  }

  const text = `${result.stderr}\n${result.stdout}`;
  if (args[0] === 'rm' && /did not match any file|pathspec .* did not match|did not match any files/i.test(text)) {
    return `Nothing matching that path is tracked by git, so "git rm" cannot delete it. ${IGNORE_ADVICE}`;
  }

  return (result.stderr || result.stdout || 'Command failed.').trim().split('\n')[0];
}

/**
 * Runs a full plan in order, stopping at the first step that needs a decision
 * or fails. Partial execution is itself a meaningful outcome and is reported
 * as such rather than being retried blindly.
 *
 * @param {string} repoPath
 * @param {object[]} steps
 * @param {{confirmed?:boolean, allowDestructive?:boolean}} [options]
 */
export async function executePlan(repoPath, steps, options = {}) {
  const executed = [];

  for (const step of steps) {
    const outcome = await executeStep(repoPath, step, options);
    executed.push({ step, outcome });

    if (outcome.status !== 'ran') {
      return {
        completed: false,
        stoppedAt: step,
        executed,
      };
    }
  }

  return { completed: true, stoppedAt: null, executed };
}
