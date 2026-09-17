/**
 * GitSynapse local server.
 *
 * Responsibilities:
 *  - Serve the renderer (plain HTML/CSS/ES modules, no build step).
 *  - Expose a small JSON API for reading repositories and running actions.
 *  - Proxy the copilot to the configured AI provider so the API key never reaches the
 *    browser context.
 *
 * Runs on loopback only. See guard.js for the Host/Origin validation that
 * closes the DNS-rebinding hole a bare loopback bind leaves open.
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { bindHost, debugEnabled, port as configuredPort } from './env.js';
import { isAllowedHost, isAllowedOrigin, localOnlyGuard, rateLimit } from './guard.js';
import { repoRouter } from './routes/repo.js';
import { actionRouter } from './routes/actions.js';
import { aiRouter } from './routes/ai.js';
import { systemRouter } from './routes/system.js';
import { gitVersion } from './git/runner.js';
import { paths } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.resolve(here, '..', 'renderer');

export const DEFAULT_PORT = configuredPort();

/**
 * Bind address. Loopback by default: a desktop app has no business listening on
 * a network interface. `GITSYNAPSE_BIND` exists for containerised or hosted
 * previews, where a proxy needs to reach the port — the Host/Origin guard in
 * guard.js still applies, and GITSYNAPSE_ALLOWED_HOSTS must name the proxy.
 */
export const HOST = bindHost();

/**
 * Builds the Express application. Exported separately from {@link startServer}
 * so tests can mount it without binding a port.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(localOnlyGuard);
  app.use(express.json({ limit: '2mb' }));

  // Broad limiter for reads and a tighter one for AI calls, which cost money.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }));
  app.use('/api/ai', rateLimit({ windowMs: 60_000, max: 60 }));

  // The renderer is served with no-cache so a stale UI can never talk to a
  // newer API.
  app.use(
    express.static(RENDERER_DIR, {
      extensions: ['html'],
      setHeaders: (res) => res.set('Cache-Control', 'no-store'),
    }),
  );

  app.use('/api', repoRouter);
  app.use('/api', actionRouter);
  app.use('/api', aiRouter);
  app.use('/api', systemRouter);

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'gitsynapse' }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}` });
  });

  // Unknown paths fall back to the app shell so the single-page UI can route.
  app.get('*', (req, res) => {
    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin, req.headers.host)) {
      res.status(403).send('Blocked: this server only serves localhost.');
      return;
    }
    res.sendFile(path.join(RENDERER_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars -- Express requires the 4-arg shape.
  app.use((error, req, res, next) => {
    const status = error.status && Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error('[gitsynapse] request failed:', error);
    res.status(status).json({
      error: error.code || 'internal_error',
      message: status >= 500 ? 'Something went wrong inside GitSynapse.' : error.message,
      detail: debugEnabled() ? error.stack : undefined,
    });
  });

  return app;
}

/**
 * Starts the server and resolves once it is listening.
 * @param {{port?:number}} [options]
 * @returns {Promise<{server:import('node:http').Server, port:number, url:string}>}
 */
export function startServer({ port = DEFAULT_PORT } = {}) {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        // Pick a free port rather than failing: two windows of the app should
        // not fight over a hard-coded number.
        const fallback = app.listen(0, HOST);
        fallback.once('listening', () => {
          const actual = fallback.address().port;
          resolve({ server: fallback, port: actual, url: `http://${HOST}:${actual}` });
        });
        fallback.once('error', reject);
        return;
      }
      reject(error);
    });

    server.once('listening', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://${HOST}:${actual}` });
    });
  });
}

/** Writes the active port where the Electron main process can find it. */
function writePortFile(port) {
  try {
    fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(paths.CONFIG_DIR, 'server.port'), String(port), { mode: 0o600 });
  } catch {
    // Non-fatal: only Electron needs this.
  }
}

/** CLI entry point. */
async function main() {
  const { url, port } = await startServer();
  writePortFile(port);

  const version = await gitVersion();

  console.log('');
  console.log('  GitSynapse is running');
  console.log(`  UI        ${url}`);
  console.log(`  git       ${version || 'NOT FOUND — install Git and restart'}`);
  console.log(`  settings  ${paths.CONFIG_FILE}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[gitsynapse] failed to start:', error.message);
    process.exit(1);
  });
}
