/**
 * Diagnostics and environment information.
 * The UI uses this to tell the user exactly what it will run before anything
 * touches their repository.
 */

import os from 'node:os';
import { versionOverride } from '../env.js';
import express from 'express';
import { gitVersion, resolveGitBinary } from '../git/runner.js';
import { loadConfig, paths } from '../store.js';

export const systemRouter = express.Router();

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
