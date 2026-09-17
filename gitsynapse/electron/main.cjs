/**
 * Electron main process.
 *
 * This file is the desktop shell only. All git and AI work happens in the local
 * server (src/server), which the shell starts on an ephemeral port and then
 * loads in a sandboxed window. Keeping the boundary there means the exact same
 * code runs in a browser during development and inside the packaged app.
 *
 * CommonJS on purpose: Electron's ESM support still varies by version, and the
 * server is loaded with a dynamic import() so an ESM codebase can be reused.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');

// Enforce a single window; a second launch focuses the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {import('node:http').Server|null} */
let server = null;
/** @type {BrowserWindow|null} */
let window = null;

const state = {
  boundsFile: null,
};

function readWindowBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(state.boundsFile, 'utf8'));
    if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) return saved;
  } catch {
    // First run, or the file was removed.
  }
  return { width: 1400, height: 900 };
}

function saveWindowBounds() {
  if (!window || window.isDestroyed()) return;
  try {
    fs.writeFileSync(state.boundsFile, JSON.stringify(window.getNormalBounds()), { mode: 0o600 });
  } catch {
    // Window geometry is a nicety; never fail a quit over it.
  }
}

async function startLocalServer() {
  const { startServer } = await import(
    new URL('../src/server/index.js', `file://${__filename.replace(/\\/g, '/')}`).href
  );
  // Port 0 → the OS picks a free port, so two copies of the app never collide.
  const started = await startServer({ port: 0 });
  server = started.server;
  return started.url;
}

function createWindow(url) {
  nativeTheme.themeSource = 'dark';

  window = new BrowserWindow({
    ...readWindowBounds(),
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#08080a',
    title: 'GitSynapse',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      // The renderer is untrusted-by-default: no Node, context isolation on,
      // and no remote module. Everything it needs comes over HTTP from the
      // local server or through the narrow preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  window.once('ready-to-show', () => window.show());

  window.on('resize', saveWindowBounds);
  window.on('move', saveWindowBounds);
  window.on('close', saveWindowBounds);

  // Nothing in this app should navigate away from its own origin, and no
  // window should ever open inside the app. Both are hard-blocked.
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  window.loadURL(url);

  window.on('closed', () => {
    window = null;
  });
}

/**
 * The only privileged capability exposed to the renderer: a native folder
 * picker. Everything else goes through the HTTP API, which keeps the trust
 * boundary in one place.
 */
function registerIpc() {
  ipcMain.handle('gitsynapse:pick-folder', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(window, {
      title: options.title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: options.defaultPath || app.getPath('home'),
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('gitsynapse:open-external', async (_event, target) => {
    if (typeof target === 'string' && /^https?:/.test(target)) await shell.openExternal(target);
  });

  ipcMain.handle('gitsynapse:reveal', async (_event, target) => {
    if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target);
  });
}

async function boot() {
  const configDir = process.env.GITSYNAPSE_CONFIG_DIR || path.join(app.getPath('userData'), 'config');
  process.env.GITSYNAPSE_CONFIG_DIR = configDir;
  // userData is derived from the product name, so 1.0.0 looks in a different
  // folder than 0.x did. Point the server at the old one so it can copy the
  // settings (and the machine key the saved API key is encrypted with) across.
  process.env.GITSYNAPSE_LEGACY_CONFIG_DIR = path.join(app.getPath('appData'), 'GitDesk', 'config');
  process.env.GITSYNAPSE_VERSION = app.getVersion();
  fs.mkdirSync(configDir, { recursive: true });
  state.boundsFile = path.join(configDir, 'window.json');

  registerIpc();

  let url;
  try {
    url = await startLocalServer();
  } catch (error) {
    dialog.showErrorBox(
      'GitSynapse could not start',
      `The local server failed to start.\n\n${error.message}\n\n` +
        'Check that the folder is writable, then try again.',
    );
    app.quit();
    return;
  }

  createWindow(url);
}

app.whenReady().then(boot);

app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.on('window-all-closed', () => {
  // Windows and Linux: closing the window ends the app. macOS keeps it alive.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

app.on('before-quit', () => {
  saveWindowBounds();
  if (server) {
    server.close();
    server = null;
  }
});

// Defence in depth: refuse to attach to any webview and block throttling
// workarounds that would keep the CPU awake in the background.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
