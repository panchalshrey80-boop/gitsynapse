/**
 * Local settings and chat-history persistence.
 *
 * One API key is kept per provider, so switching from Mesh to Groq and back
 * does not make the user re-paste a key they already entered. Every key is
 * encrypted at rest with AES-256-GCM; the ciphertext is derived
 * from a per-installation random secret stored with 0600 permissions, so the
 * ciphertext is useless if config.json alone is copied off the machine. This is
 * not protection against an attacker who already has read access to the user's
 * home directory — nothing at this layer can be — it is protection against
 * backups, screenshots and casual inspection.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PROVIDER_ID, PROVIDERS, providerOrDefault, providerSummaries } from './ai/providers.js';
import { configDir as resolveConfigDir, env } from './env.js';

const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SECRET_FILE = path.join(CONFIG_DIR, 'machine.key');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const MAX_HISTORY_SESSIONS = 40;

const DEFAULT_CONFIG = {
  provider: DEFAULT_PROVIDER_ID,
  // provider id -> encrypted key. A `null` value means "saved then cleared".
  apiKeys: {},
  // Pre-1.0 single-key field. Read for migration, never written again.
  apiKeyEnc: null,
  // provider id -> base URL override (tests, self-hosted gateways).
  baseUrlOverrides: {},
  // Legacy single-value base URL override, kept readable for the same reason.
  baseUrl: null,
  model: '',
  // provider id -> cached model ids.
  modelsCache: {},
  confirmPolicy: 'all', // 'all' | 'destructive' | 'never'
  autoRunReadOnly: true,
  theme: 'grok-dark',
  recentRepos: [],
  lastRepo: null,
  showRawOutput: true,
  aiEnabled: true,
};

const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);

/**
 * Shows enough of a key to recognise it and not enough to use it.
 * Short keys are masked whole rather than leaking most of their length.
 */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 6)}${'•'.repeat(12)}${key.slice(-4)}`;
}

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Copies settings across from the pre-1.0 directory name, once.
 *
 * The app changed name in 1.0.0, and the config directory changed with it. The
 * encrypted API key is bound to `machine.key`, so copying config.json alone
 * would leave an undecryptable key behind — all three files move together, and
 * only when the new directory has no config yet.
 *
 * Best effort by design: a read-only or missing legacy directory is not an
 * error, it just means there is nothing to migrate.
 */
function migrateLegacyConfig() {
  if (fs.existsSync(CONFIG_FILE)) return;

  // Where the old directory was, if anyone knows better than we do. Electron
  // passes this because `userData` is derived from the product name, so only it
  // can name the previous folder on Windows.
  const pointed = env('LEGACY_CONFIG_DIR');

  // An explicit config directory means exactly that directory, and nothing
  // else. Without this, a test sandbox or a second profile would inherit the
  // settings of whatever sits in the user's home folder.
  if (!pointed && env('CONFIG_DIR')) return;

  const legacyDirs = pointed ? [pointed] : [path.join(os.homedir(), '.gitdesk')];

  for (const legacy of legacyDirs) {
    const source = path.join(legacy, 'config.json');
    if (!fs.existsSync(source)) continue;

    try {
      ensureDir();
      for (const file of ['config.json', 'machine.key', 'history.json']) {
        const from = path.join(legacy, file);
        if (!fs.existsSync(from)) continue;
        fs.copyFileSync(from, path.join(CONFIG_DIR, file));
      }
      return;
    } catch {
      // A failed migration must not stop the app from starting.
    }
  }
}

migrateLegacyConfig();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes atomically so a crash mid-write cannot corrupt settings. */
function writeJson(file, data, mode = 0o600) {
  ensureDir();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(temporary, file);
}

function machineSecret() {
  ensureDir();
  try {
    const existing = fs.readFileSync(SECRET_FILE);
    if (existing.length === 32) return existing;
  } catch {
    // First run.
  }
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineSecret(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

let configCache = null;

/**
 * Brings a config file written by an earlier version into the current shape.
 *
 * A plain `{ ...defaults, ...stored }` merge is not enough: pre-1.0 files store
 * `modelsCache` as an array and `baseUrl` as a string, and those values would
 * override the new object defaults with the wrong type — silently breaking the
 * model list and the per-provider URL override for anyone upgrading.
 *
 * Converted in memory on every read, and never written back on its own, so a
 * newer build can still be downgraded without losing anything.
 *
 * @param {Record<string, unknown>} stored
 */
function normaliseConfig(stored) {
  const config = { ...DEFAULT_CONFIG, ...stored };

  if (!PROVIDER_IDS.includes(config.provider)) config.provider = DEFAULT_PROVIDER_ID;
  if (typeof config.provider !== 'string') config.provider = DEFAULT_PROVIDER_ID;

  if (!config.apiKeys || typeof config.apiKeys !== 'object' || Array.isArray(config.apiKeys)) {
    config.apiKeys = {};
  }

  // Pre-1.0 cached one list, fetched from Mesh, which was the only provider.
  if (Array.isArray(config.modelsCache)) {
    config.modelsCache = config.modelsCache.length
      ? { [DEFAULT_PROVIDER_ID]: config.modelsCache }
      : {};
  } else if (!config.modelsCache || typeof config.modelsCache !== 'object') {
    config.modelsCache = {};
  }

  if (!config.baseUrlOverrides || typeof config.baseUrlOverrides !== 'object'
    || Array.isArray(config.baseUrlOverrides)) {
    config.baseUrlOverrides = {};
  }

  // A string baseUrl meant "override Mesh". Keep it meaningful for the provider
  // that was active when it was written.
  if (typeof config.baseUrl === 'string' && config.baseUrl) {
    const id = typeof stored.provider === 'string' && PROVIDER_IDS.includes(stored.provider)
      ? stored.provider
      : DEFAULT_PROVIDER_ID;
    if (!config.baseUrlOverrides[id]) config.baseUrlOverrides[id] = config.baseUrl;
  }

  if (typeof config.model !== 'string') config.model = '';
  if (typeof config.apiKeyEnc !== 'string') config.apiKeyEnc = null;

  return config;
}

export function loadConfig() {
  if (configCache) return configCache;
  configCache = normaliseConfig(readJson(CONFIG_FILE, {}));
  return configCache;
}

export function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  configCache = merged;
  writeJson(CONFIG_FILE, merged);
  return merged;
}

/**
 * The raw API key for a provider, server-side only.
 * Never send this to the browser.
 *
 * @param {string} [providerId] Defaults to the active provider.
 */
export function getApiKey(providerId) {
  const config = loadConfig();
  const id = providerId || config.provider || DEFAULT_PROVIDER_ID;

  const stored = config.apiKeys?.[id];
  if (stored) return decrypt(stored);

  // Anything saved before providers existed belongs to Mesh, which was the only
  // option then. Read it, so an upgrade does not look like the key vanished.
  if (id === DEFAULT_PROVIDER_ID) return decrypt(config.apiKeyEnc);

  return '';
}

/**
 * Stores a key for one provider.
 *
 * An empty string deletes that provider's key without touching the others,
 * which is what "clear my key" has to mean once there is more than one.
 *
 * @param {string} apiKey
 * @param {string} [providerId]
 */
export function setApiKey(apiKey, providerId) {
  const config = loadConfig();
  const id = providerId || config.provider || DEFAULT_PROVIDER_ID;
  const trimmed = (apiKey || '').trim();

  const apiKeys = { ...(config.apiKeys || {}) };
  if (trimmed) apiKeys[id] = encrypt(trimmed);
  else delete apiKeys[id];

  // Migrated: the legacy field would otherwise resurrect a cleared key.
  saveConfig({ apiKeys, apiKeyEnc: null });
  return trimmed.length > 0;
}

/** The base URL override in force for a provider, if any. */
export function getBaseUrlOverride(providerId) {
  const config = loadConfig();
  const id = providerId || config.provider || DEFAULT_PROVIDER_ID;
  const stored = config.baseUrlOverrides?.[id];
  if (stored) return stored;
  if (id === DEFAULT_PROVIDER_ID && config.baseUrl) return config.baseUrl;
  return undefined;
}

/** Which providers currently hold a key, so the UI can say so without one. */
function keyStatus() {
  const config = loadConfig();
  const status = {};
  for (const provider of PROVIDER_IDS) {
    status[provider] = getApiKey(provider).length > 0;
  }
  return status;
}

/** Renderer-safe settings payload: the key is replaced by a mask. */
export function publicSettings() {
  const config = loadConfig();
  const provider = providerOrDefault(config.provider);
  const key = getApiKey(provider.id);
  const saved = keyStatus();
  return {
    provider: provider.id,
    providerLabel: provider.label,
    providers: providerSummaries(),
    keysSaved: saved,
    // Materialised so the dialog and the model pill show the provider's default
    // rather than an empty box before anything has been saved.
    model: config.model || provider.defaultModel,
    modelsCache: config.modelsCache[provider.id] || [],
    confirmPolicy: config.confirmPolicy,
    autoRunReadOnly: config.autoRunReadOnly,
    theme: config.theme,
    recentRepos: config.recentRepos,
    lastRepo: config.lastRepo,
    showRawOutput: config.showRawOutput,
    aiEnabled: config.aiEnabled,
    hasApiKey: key.length > 0,
    apiKeyMask: maskKey(key),
    // Which providers already hold a key, so the picker can show it without the
    // settings call needing one round trip per provider.
    providerKeyCount: Object.values(saved).filter(Boolean).length,
    configDir: CONFIG_DIR,
  };
}

export function rememberRepo(repoPath) {
  const config = loadConfig();
  const recent = [repoPath, ...config.recentRepos.filter((entry) => entry !== repoPath)].slice(0, 12);
  saveConfig({ recentRepos: recent, lastRepo: repoPath });
}

/**
 * Forgets which repository was last open, so the next launch lands on the
 * welcome screen. The entry stays in `recentRepos`: closing a repository is not
 * a request to remove it from history.
 */
export function forgetRepo(repoPath) {
  const config = loadConfig();
  if (repoPath && config.lastRepo && config.lastRepo !== repoPath) return;
  saveConfig({ lastRepo: null });
}

/* ------------------------------------------------------------------ *
 * Chat history
 * ------------------------------------------------------------------ */

export function loadSessions() {
  const data = readJson(HISTORY_FILE, { sessions: [] });
  return Array.isArray(data.sessions) ? data.sessions : [];
}

export function saveSession(session) {
  if (!session || typeof session.id !== 'string') return loadSessions();
  const others = loadSessions().filter((entry) => entry.id !== session.id);
  const sessions = [session, ...others].slice(0, MAX_HISTORY_SESSIONS);
  writeJson(HISTORY_FILE, { sessions });
  return sessions;
}

export function deleteSession(id) {
  const sessions = loadSessions().filter((entry) => entry.id !== id);
  writeJson(HISTORY_FILE, { sessions });
  return sessions;
}

export const paths = { CONFIG_DIR, CONFIG_FILE, HISTORY_FILE };
