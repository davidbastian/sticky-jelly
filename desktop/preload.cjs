/*
 * One message, one direction: the renderer says whether the cursor is on the
 * creature, and the shell turns click-through on and off with it.
 *
 * Nothing else is exposed. The page is a jelly; it has no business reaching
 * into the machine.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jelly', {
  hover: (over) => ipcRenderer.send('jelly:hover', !!over),
});
