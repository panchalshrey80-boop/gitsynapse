/**
 * Turns a failed git result into something a novice can act on.
 *
 * git's own words are precise and useless to a beginner: a missing identity
 * arrives as "Author identity unknown / *** Please tell me who you are", and the
 * reason this module exists is that the app used to pass that through as
 * "Request failed (HTTP 422)" — the actual text never reached the toast. Every
 * failing action now runs through here, so the message is always readable even
 * when nobody thought of the case in advance.
 */

const FIRST_LINE_MAX = 200;

/** Strips git's prefixes so the sentence reads as prose. */
function tidy(line) {
  return line
    .replace(/^(fatal|error|warning):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FIRST_LINE_MAX);
}

/**
 * Explain a non-zero git result.
 *
 * @param {{ok:boolean, code:number, stdout:string, stderr:string, args?:string[]}} result
 * @param {{action?: string}} [context]
 * @returns {{code:string, message:string, hint:string, needsIdentity?:boolean}}
 */
export function explainGitFailure(result, { action = '' } = {}) {
  const stderr = String(result?.stderr || '');
  const stdout = String(result?.stdout || '');
  const text = `${stderr}\n${stdout}`;
  const exit = Number.isFinite(result?.code) ? result.code : '?';

  // GIT_AUTHOR_* is in the environment: git refuses to guess who is committing.
  // This is the single most likely failure on a fresh machine, and the fix is
  // two settings the app can write itself.
  if (/Author identity unknown|Please tell me who you are|unable to auto-detect email address|empty ident name|Committer identity unknown/i.test(text)) {
    return {
      code: 'identity_missing',
      message: 'Git does not know who you are yet, so it will not record a commit. This is set once per machine.',
      hint: 'Enter your name and email, and GitSynapse will save them to your global git configuration. Nothing is sent anywhere — the name and email are stored in the commit itself, which is how git attributes work.',
      needsIdentity: true,
    };
  }

  // `git commit` with a clean tree exits 1. That is not an error worth an
  // apology, it is just a no-op the user should understand.
  if (/nothing to commit, working tree clean/i.test(text)) {
    return {
      code: 'nothing_to_commit',
      message: 'There is nothing to commit — the files on disk match the last commit.',
      hint: 'Edit a file, or make a new one, and it will appear in the Changes list.',
    };
  }

  if (/nothing added to commit but untracked files present/i.test(text)) {
    return {
      code: 'nothing_staged',
      message: 'Nothing is staged. Git only records what you stage, so the changes are still untracked.',
      hint: 'Use "Stage all", or the + button on each file, then commit again.',
    };
  }

  if (/no changes added to commit/i.test(text)) {
    return {
      code: 'nothing_staged',
      message: 'Nothing is staged, so there is nothing to record in this commit.',
      hint: 'Modifications to tracked files still need staging — use "Stage all", or the + button on each file.',
    };
  }

  if (/cannot do a partial commit during a merge/i.test(text)) {
    return {
      code: 'partial_commit_in_merge',
      message: 'During a merge every conflict must be resolved and staged before commit — git will not record only some of them.',
      hint: 'Resolve the remaining conflicts, then stage and commit everything at once.',
    };
  }

  if (/You have not concluded your merge|MERGE_HEAD exists/i.test(text)) {
    return {
      code: 'merge_in_progress',
      message: 'A merge is still in progress, so git will not make an unrelated commit.',
      hint: 'Finish the merge by committing it, or abort it from the banner at the top of the Changes view.',
    };
  }

  if (/not a git repository/i.test(text)) {
    return {
      code: 'not_a_repository',
      message: 'That folder is not a git repository, so git cannot run there.',
      hint: 'Open a different folder, or create a repository in that one from the Repositories menu.',
    };
  }

  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)|could not read Password|Invalid username or password/i.test(text)) {
    return {
      code: 'credentials_required',
      message: 'The remote asked for credentials, and GitSynapse runs git non-interactively so it cannot type them for you.',
      hint: 'Install Git Credential Manager, or add an SSH key, or run the same command once in a terminal so your credentials are cached.',
    };
  }

  if (/has no upstream branch|set-upstream|no upstream configured/i.test(text)) {
    return {
      code: 'no_upstream',
      message: 'This branch has never been pushed, so git does not know where to send it.',
      hint: 'Push it once with "set upstream" — then plain Push will work from then on.',
    };
  }

  if (/rejected.*non-fast-forward|fetch first|Updates were rejected/i.test(text)) {
    return {
      code: 'push_rejected',
      message: 'The remote has commits you do not have, so this push was refused.',
      hint: 'Fetch and review first, or pull with rebase, then push again.',
    };
  }

  if (/have diverged|diverged/i.test(text)) {
    return {
      code: 'diverged',
      message: 'Your branch and the remote branch have both moved on.',
      hint: 'Pull with rebase to put your commits on top of theirs, then push.',
    };
  }

  if (/Please commit your changes or stash them|Your local changes to the following files would be overwritten/i.test(text)) {
    return {
      code: 'dirty_working_tree',
      message: 'That would overwrite changes you have not committed yet, so git refused.',
      hint: 'Commit or stash your changes, then try again.',
    };
  }

  if (/not fully merged/i.test(text)) {
    return {
      code: 'branch_not_merged',
      message: 'That branch has commits that exist nowhere else, so git refused to delete it.',
      hint: 'Merge it first, or delete it anyway if those commits are disposable.',
    };
  }

  // A missing ref and a missing file produce the same git wording, so the
  // action decides which one the user is actually looking at.
  const refActions = new Set(['checkout', 'checkoutDetached', 'createBranch', 'renameBranch', 'deleteBranch',
    'merge', 'rebase', 'cherryPick', 'revert', 'reset', 'createTag', 'deleteTag', 'stashApply', 'stashDrop']);
  if (/pathspec .* did not match|did not match any file|unknown revision|bad revision|ambiguous argument/i.test(text)) {
    if (refActions.has(action)) {
      return {
        code: 'no_such_ref',
        message: 'There is no branch, tag or commit with that name in this repository.',
        hint: 'Refresh the list and pick one that exists — names are case sensitive.',
      };
    }
    return {
      code: 'no_such_path',
      message: 'Git could not find that file or folder in this repository.',
      hint: 'It may have been moved, renamed or deleted since the list was last refreshed.',
    };
  }

  // Anything unforeseen: git's own first non-empty line beats a generic
  // apology, because it at least names the problem.
  const line = stderr.split('\n').map((entry) => entry.trim()).find(Boolean)
    || stdout.split('\n').map((entry) => entry.trim()).find(Boolean);

  return {
    code: 'git_failed',
    message: line ? tidy(line) : `git ${action ? `${action} ` : ''}exited with code ${exit}.`,
    hint: 'The full command and its output are shown below.',
  };
}
