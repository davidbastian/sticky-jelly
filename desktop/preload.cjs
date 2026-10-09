/*
 * The renderer says whether the cursor is on the creature, so the shell can
 * turn click-through on and off, and what it covers once it stops, so the
 * shell can move desktop icons out of the way. It also describes its controls
 * once, and the shell sends back changes made in the Settings window. And
 * the sidebar chat: send a message, hear the reply as it streams.
 *
 * Nothing else is exposed. The page is a jelly; it has no business reaching
 * into the machine.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jelly', {
  hover: (over) => ipcRenderer.send('jelly:hover', !!over),
  rest: (rects) => ipcRenderer.send('jelly:rest', rects),
  focus: () => ipcRenderer.send('jelly:focus'),
  chat: {
    send: (text) => ipcRenderer.invoke('chat:send', text),
    onDelta: (fn) => {
      const on = (_e, d) => fn(d);
      ipcRenderer.on('chat:delta', on);
      return () => ipcRenderer.off('chat:delta', on);
    },
    stop: () => ipcRenderer.send('chat:stop'),
    reset: () => ipcRenderer.send('chat:reset'),
    transcript: () => ipcRenderer.invoke('chat:transcript'),
    prefs: () => ipcRenderer.invoke('chat:prefs'),
  },
  voice: {
    start: () => ipcRenderer.send('voice:start'),
    stop: () => ipcRenderer.send('voice:stop'),
    on: (fn) => {
      const on = (_e, ev) => fn(ev);
      ipcRenderer.on('voice:event', on);
      return () => ipcRenderer.off('voice:event', on);
    },
  },
  /* Every control, described once; the shell answers with changes to apply. */
  settings: (schema, set) => {
    ipcRenderer.send('jelly:schema', schema);
    const on = (_e, key, value) => set(key, value);
    ipcRenderer.on('jelly:set', on);
    return () => ipcRenderer.off('jelly:set', on);
  },
});
