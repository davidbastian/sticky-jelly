/*
 * The Settings window's half of the conversation: read every control with its
 * current value, change one, flip the icon mover, restore defaults, and set up
 * the assistant (API key, model). It hears back only when the jelly window has
 * re-described its controls.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.send('settings:set', key, value),
  icons: (on) => ipcRenderer.send('settings:icons', !!on),
  reset: () => ipcRenderer.invoke('settings:reset'),
  save: () => ipcRenderer.invoke('settings:save'),
  saveKey: (key, provider) => ipcRenderer.invoke('settings:key', key, provider),
  removeKey: (provider) => ipcRenderer.invoke('settings:key-remove', provider),
  provider: (p) => ipcRenderer.send('settings:provider', p),
  models: (p) => ipcRenderer.invoke('settings:models', p),
  model: (m) => ipcRenderer.send('settings:model', m),
  speak: (on) => ipcRenderer.send('settings:speak', !!on),
  openConsole: (provider) => ipcRenderer.send('settings:console', provider),
  onSchema: (fn) => { ipcRenderer.on('settings:schema', () => fn()); },
});
