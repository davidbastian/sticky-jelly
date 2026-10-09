/*
 * The Settings window's stand-in for the README demos: the real controls (as
 * the demo jelly described them), an assistant that already has a key, and
 * changes forwarded to the demo jelly so sliders move it. Nothing is saved.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('demo:settings-get'),
  set: (key, value) => ipcRenderer.send('demo:settings-set', key, value),
  icons: () => {},
  reset: async () => {},
  save: async () => true,
  onSchema: () => {},
  saveKey: async () => true,
  removeKey: async () => {},
  model: () => {},
  speak: () => {},
  openConsole: () => {},
});
