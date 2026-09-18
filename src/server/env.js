/**
 * Environment and filesystem conventions.
 *
 * The app was called GitDesk before 1.0.0. Its environment variables and config
 * directory are part of an interface real users and CI scripts already depend
 * on, so the new names are preferred and the old ones are still read. Nothing
 * breaks on upgrade, and nothing has to be migrated by hand.
 *
 *   GITSYNAPSE_*   preferred
 *   GITDESK_*      still honoured
 *
 * @typedef {object} EnvAlias
 * @property {string} suffix  Preferred suffix, e.g. 'CONFIG_DIR'.
 * @property {string} [legacy] Suffix used before the rename, if it differed.
 */

import os from 'node:os';
import path from 'node:path';

/** Suffix used by every pre-1.0 variable. */
const LEGACY_PREFIX = 'GITDESK_';
const PREFIX = 'GITSYNAPSE_';

/**
 * Reads a setting under its current name, falling back to the pre-1.0 name.
 *
 * @param {string} suffix
 * @param {string} [legacy]
 * @returns {string|undefined}
 */
export function env(suffix, legacy = suffix) {
  const current = process.env[`${PREFIX}${suffix}`];
  if (current !== undefined && current !== '') return current;

  const previous = process.env[`${LEGACY_PREFIX}${legacy}`];
  if (previous !== undefined && previous !== '') return previous;

  return undefined;
}

/** Where settings, the machine secret and chat history live. */
export function configDir() {
  const configured = env('CONFIG_DIR');
  if (configured) return configured;
  return path.join(os.homedir(), '.gitsynapse');
}

/** The port the local server listens on. */
export function port(defaultPort = 4173) {
  const parsed = Number.parseInt(env('PORT') || '', 10);
  return Number.isFinite(parsed) ? parsed : defaultPort;
}

/** Interface to bind. Loopback unless a container or test asks otherwise. */
export function bindHost() {
  return env('BIND') || '127.0.0.1';
}

/** Extra hostnames the guard will accept (comma separated). */
export function allowedHosts() {
  return env('ALLOWED_HOSTS') || '';
}

/** Overrides the git executable, used by the process-runner tests. */
export function gitBinary() {
  return env('GIT_BINARY');
}

/** Reported by the system-info endpoint and the installer's version metadata. */
export function versionOverride() {
  return env('VERSION');
}

/** True when stack traces should reach the client. */
export function debugEnabled() {
  return Boolean(env('DEBUG'));
}
