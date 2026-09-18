/**
 * Diagnostics and environment information.
 * The UI uses this to tell the user exactly what it will run before anything
 * touches their repository.
 */

import os from 'node:os';
import { versionOverride } from '../env.js';
import express from 'express';
import { gitVersion, resolveGitBinary } from '../git/runner.js';
import { getIdentity } from '../git/actions.js';
import { loadConfig, paths } from '../store.js';

export const systemRouter = express.Router();

/**
 * The identity git stamps on commits. The UI reads this to offer the fix when a
 * commit fails because nothing is configured.
 */
systemRouter.get('/git/identity', async (req, res) => {
  const repoPath = typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : undefined;
  try {
    res.json(await getIdentity(repoPath));
  } catch (error) {
    res.status(400).json({ error: 'identity_unavailable', message: error.message });
  }
});

systemRouter.get('/system/info', async (req, res) => {
  const version = await gitVersion();
  const config = loadConfig();

  res.json({
    app: { name: 'GitSynapse', version: versionOverride() || '1.0.0' },
    git: {
      found: version.length > 0,
      version,
      binary: resolveGitBinary(),
      note: version ? '' : 'Git was not found on PATH. Install Git for Windows and restart the app.',
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      shell: process.env.SHELL || process.env.ComSpec || '',
      hostname: os.hostname(),
    },
    storage: { configDir: paths.CONFIG_DIR },
    policy: {
      confirmPolicy: config.confirmPolicy,
      autoRunReadOnly: config.autoRunReadOnly,
      aiEnabled: config.aiEnabled,
    },
  });
});
