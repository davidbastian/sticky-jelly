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
  saveKey: (key) => ipcRenderer.invoke('settings:key', key),
  removeKey: () => ipcRenderer.invoke('settings:key-remove'),
  model: (m) => ipcRenderer.send('settings:model', m),
  speak: (on) => ipcRenderer.send('settings:speak', !!on),
  openConsole: () => ipcRenderer.send('settings:console'),
  onSchema: (fn) => { ipcRenderer.on('settings:schema', () => fn()); },
});
