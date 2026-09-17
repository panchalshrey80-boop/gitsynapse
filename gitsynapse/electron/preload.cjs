/**
 * Preload bridge. Intentionally tiny.
 *
 * Only the native folder picker and a couple of shell helpers cross this
 * boundary. Repository access, git execution and the AI copilot all travel over
 * loopback HTTP so there is exactly one place where privilege is exercised.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitSynapseNative', {
  isDesktop: true,
  platform: process.platform,

  /**
   * Opens the OS folder picker.
   * @param {{title?:string, defaultPath?:string}} [options]
   * @returns {Promise<string|null>} chosen path, or null when cancelled
   */
  pickFolder: (options = {}) => ipcRenderer.invoke('gitsynapse:pick-folder', options),

  /** Opens an http(s) URL in the user's default browser. */
  openExternal: (url) => ipcRenderer.invoke('gitsynapse:open-external', url),

  /** Selects a file in Explorer / Finder. */
  reveal: (target) => ipcRenderer.invoke('gitsynapse:reveal', target),
});
