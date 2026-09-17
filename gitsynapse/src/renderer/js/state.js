/**
 * Application state.
 *
 * A single store object plus a tiny subscriber list. Views re-render on
 * `render` events; nothing polls. Keeping this explicit (rather than reaching
 * for a framework) matches the size of the app: one window, one repository,
 * one chat.
 */

const listeners = new Set();

export const state = {
  /** @type {string|null} */
  repoPath: null,
  /** @type {string} */
  repoName: '',
  /** @type {object|null} */
  status: null,
  /** @type {{inProgress:string|null}} */
  operationState: { inProgress: null },
  /** @type {Array} */
  remotes: [],
  /** @type {object|null} */
  gitInfo: null,
  /** @type {object|null} */
  settings: null,

  view: 'welcome',
  selectedFile: null,
  selectedStaged: false,
  selectedCommit: null,
  busy: false,
  lastCommand: null,
};

/** Subscribes to store changes. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies a patch and notifies subscribers. */
export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) listener(state);
}
