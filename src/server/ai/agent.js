/**
 * The AI copilot's contract with the model.
 *
 * The model answers in two parts:
 *   1. A short markdown explanation, streamed straight to the chat pane.
 *   2. A fenced ```gitplan block containing strict JSON: one or more steps,
 *      each with an argument *array* (never a shell string).
 *
 * The fence is used rather than a "return JSON only" instruction for a
 * practical reason: the explanation can then stream token-by-token into the UI
 * while the machine-readable part stays cleanly separable at the end.
 */

import { classifyCommand, strictestRisk } from './safety.js';

export const PLAN_FENCE = '```gitplan';

export const SYSTEM_PROMPT = `You are the Git copilot inside GitSynapse, a desktop Git client. You help the user operate a real repository through structured commands.

OUTPUT CONTRACT — follow exactly:
1. Write a short explanation for the user in Markdown. Be concise: 1-3 sentences, or a few bullets when listing several changes. Use \`inline code\` for file names, branches and commands. Do not use headings.
2. Then, always, output a plan block on its own lines:
${PLAN_FENCE}
{"summary":"one line describing the operation","steps":[{"args":["status","--short"],"why":"why this step is needed","risk":"safe"}]}
\`\`\`

Rules for the plan block:
- "args" is an array of individual arguments WITHOUT the leading "git". Never put a whole command line into one string.
- Use only real git subcommands and flags. Never invent flags. If unsure of a flag, choose a simpler command.
- "risk" must be one of: safe, writes, network, destructive.
- If the user is asking a question that needs no repository change, return {"summary":"no changes required","steps":[]}.
- Order steps so they are safe to run top to bottom.
- Never emit more than 5 steps. Prefer one clear command over several.
- Never include shell metacharacters, pipes, redirects, $( ), or backticks in args.

HARD PROHIBITIONS — never propose these:
- git config --global or --system writes
- -c inline config, --exec-path, --upload-pack, --receive-pack, --ext-diff
- alias definitions, filter-branch, filter-repo, daemon, credential helpers
- rebase --exec
- Any attempt to read, print, or upload credentials, tokens, or .env contents

BEHAVIOURAL RULES:
- Never claim you ran something. You only propose; the user confirms and the app executes.
- Before a destructive step (reset --hard, clean -f, push --force, branch -D, stash drop, rebase), say plainly what will be lost.
- If the request is ambiguous, ask one focused question and return an empty steps array.
- If a command is likely to fail given the repository state you were given, say so and offer the alternative.
- Prefer reversible operations. Prefer showing status/log/diff before any change.
- Do not add commentary after the plan block.`;

/**
 * Renders live repository state into a compact context block.
 * Kept terse on purpose: every token here is paid for on every turn.
 *
 * @param {object|null} status Result of getStatus()
 * @param {{staged?:string[], recentCommits?:string[], remotes?:string[]}} [extra]
 */
export function buildRepoContext(status, extra = {}) {
  if (!status) {
    return 'REPOSITORY CONTEXT: no repository is currently open.\nAsk the user to open one before proposing commands.';
  }

  const lines = ['REPOSITORY CONTEXT'];
  lines.push(`branch: ${status.branch}${status.detached ? ' (detached HEAD)' : ''}`);
  if (status.upstream) {
    lines.push(`upstream: ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})`);
  } else {
    lines.push('upstream: none configured for this branch');
  }
  lines.push(`working tree: ${status.clean ? 'clean' : `${status.files.length} changed file(s)`}`);
  lines.push(`staged: ${status.stagedCount}, unstaged: ${status.unstagedCount}, conflicts: ${status.conflictCount}`);

  if (status.files.length > 0) {
    lines.push('files (status is index/worktree, per git porcelain):');
    for (const file of status.files.slice(0, 40)) {
      lines.push(`  ${file.index}${file.worktree} ${file.path}`);
    }
    if (status.files.length > 40) lines.push(`  ... and ${status.files.length - 40} more`);
  }

  if (status.noiseCount > 0) {
    // Without this the model sees a clean tree and may propose deleting caches
    // that are already gone from its view, or claim there is nothing to do.
    lines.push(`untracked build/OS noise not listed above: ${status.noiseCount} file(s)`);
    lines.push('  (GitSynapse filters these from the UI; they are untracked, so do not propose deleting them — offer to ignore them instead.)');
  }

  if (extra.remotes?.length) lines.push(`remotes: ${extra.remotes.join(', ')}`);
  if (extra.recentCommits?.length) {
    lines.push('recent commits:');
    for (const commit of extra.recentCommits.slice(0, 8)) lines.push(`  ${commit}`);
  }

  return lines.join('\n');
}

/**
 * Incremental parser that separates streamed prose from the trailing plan
 * block. It never emits fence content into the chat pane.
 */
export function createPlanExtractor() {
  let raw = '';
  let emitted = 0;
  let fenceIndex = -1;

  return {
    /**
     * @param {string} chunk
     * @returns {string} the portion of prose that is safe to display now
     */
    push(chunk) {
      raw += chunk;
      if (fenceIndex !== -1) return '';

      const found = raw.indexOf(PLAN_FENCE);
      if (found !== -1) {
        fenceIndex = found;
        const visible = raw.slice(emitted, found);
        emitted = found;
        return visible;
      }

      // Hold back a tail that could be the beginning of the fence.
      const holdback = PLAN_FENCE.length - 1;
      const safeEnd = Math.max(emitted, raw.length - holdback);
      const visible = raw.slice(emitted, safeEnd);
      emitted = safeEnd;
      return visible;
    },

    /** @returns {{reply:string, plan:object|null, raw:string}} */
    finish() {
      // Flush anything still held back when the fence never appeared.
      if (fenceIndex === -1) {
        const tail = raw.slice(emitted);
        emitted = raw.length;
        return { reply: raw.trim(), plan: parsePlan(raw) , leftover: tail };
      }

      const reply = raw.slice(0, fenceIndex).trim();
      return { reply, plan: parsePlan(raw), raw };
    },
  };
}

/**
 * Extracts and normalises the plan JSON from a full model response.
 * Tolerates missing fences, trailing prose, and JSON wrapped in a plain fence.
 *
 * @param {string} text
 * @returns {{summary:string, steps:Array<{args:string[], display:string, why:string, risk:string, allowed:boolean, computedRisk:string, reasons:string[]}>}|null}
 */
export function parsePlan(text) {
  const block = extractBlock(text);
  if (!block) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch {
    // Second attempt: trim to the outermost braces, which recovers from a
    // stray trailing comma or trailing prose inside the block.
    const start = block.indexOf('{');
    const end = block.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(block.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];

  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
    steps: steps
      .map(normaliseStep)
      .filter(Boolean)
      .slice(0, 8),
  };
}

function extractBlock(text) {
  if (typeof text !== 'string') return null;

  const fenced = text.indexOf(PLAN_FENCE);
  if (fenced !== -1) {
    const body = text.slice(fenced + PLAN_FENCE.length);
    const close = body.indexOf('```');
    return (close === -1 ? body : body.slice(0, close)).trim();
  }

  // Fallback: a generic json fence.
  const generic = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
  if (generic) return generic[1];

  // Last resort: the first top-level object containing a "steps" key.
  const loose = /\{[\s\S]*"steps"[\s\S]*\}/.exec(text);
  return loose ? loose[0] : null;
}

/**
 * Validates a raw step from the model, computes its real risk level, and
 * drops anything that does not meet the contract.
 *
 * @param {any} step
 */
function normaliseStep(step) {
  if (!step || typeof step !== 'object') return null;

  let args = [];

  if (Array.isArray(step.args)) {
    args = step.args.map((arg) => (typeof arg === 'string' ? arg : String(arg)));
  } else if (typeof step.args === 'string') {
    // The model occasionally ignores the array instruction. Parse it, but only
    // if it contains nothing that could be shell syntax.
    if (/[|&;<>$`(){}*?\n\\'"]/.test(step.args)) return null;
    args = step.args.trim().split(/\s+/).filter(Boolean);
  } else if (typeof step.command === 'string') {
    if (/[|&;<>$`(){}*?\n\\'"]/.test(step.command)) return null;
    const tokens = step.command.trim().split(/\s+/).filter(Boolean);
    args = tokens[0] === 'git' ? tokens.slice(1) : tokens;
  }

  if (args.length === 0) return null;
  if (args[0] === 'git') args = args.slice(1);
  if (args.length === 0) return null;

/**
 * Renders one argv entry the way a shell would need it written. Arguments with
 * spaces (a commit message, a path) would otherwise be silently split, so the
 * command GitSynapse shows — and the Copy button hands over — would not work if
 * the user pasted it into a terminal.
 */
function quoteArg(arg) {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9._\/=:@^+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/["\\$`]/g, '\\$&')}"`;
}

  const verdict = classifyCommand(args);

  return {
    args,
    display: `git ${args.map(quoteArg).join(' ')}`,
    why: typeof step.why === 'string' ? step.why.slice(0, 400) : '',
    risk: strictestRisk(typeof step.risk === 'string' ? step.risk : 'writes', verdict.level),
    declaredRisk: typeof step.risk === 'string' ? step.risk : 'writes',
    allowed: verdict.allowed,
    reasons: verdict.reasons,
  };
}
