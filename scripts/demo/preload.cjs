/*
 * Stand-ins for the shell, for recording the README demos.
 *
 * The same page as the app, with the same `window.jelly` / `window.settings`
 * surface, but nothing real behind it: replies and speech are scripted, no
 * API is called, no microphone opened, nothing spoken aloud. The recorder
 * (record.cjs) drives the page and reads the jelly's position through the
 * `demo:*` messages.
 */
const { contextBridge, ipcRenderer } = require('electron');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* What the jelly says, word by word, in the chat scenes. */
const REPLIES = [
  "Why did the jelly stay home? It was feeling a little set. *wiggles happily* I'll be here all week.",
  "Easy: go for a short walk, drink some water, then pick the one thing that matters most today. *bounces* You've got this.",
];
let replyIndex = 0;
const deltaFns = new Set();

let setControl = null;
const voiceFns = new Set();

contextBridge.exposeInMainWorld('jelly', {
  hover: () => {},
  rest: (rects) => ipcRenderer.send('demo:rest', rects),
  focus: () => {},
  settings: (schema, set) => { setControl = set; ipcRenderer.send('demo:schema', schema); return () => {}; },
  chat: {
    async send() {
      const text = REPLIES[replyIndex++ % REPLIES.length];
      await wait(900);
      for (const w of text.split(/(?<= )/)) {
        deltaFns.forEach(fn => fn(w));
        await wait(110);
      }
      return { ok: true };
    },
    onDelta: (fn) => { deltaFns.add(fn); return () => deltaFns.delete(fn); },
    stop: () => {},
    reset: () => {},
    transcript: async () => [],
    prefs: async () => ({ speak: false }),
  },
  voice: {
    /* A pretend listen: levels while "speaking", the words arriving, a pause. */
    async start() {
      const emit = (ev) => voiceFns.forEach(fn => fn(ev));
      emit({ type: 'ready' });
      const words = 'I feel a bit tired today, any ideas?'.split(' ');
      let said = '';
      for (const w of words) {
        for (let k = 0; k < 3; k++) { emit({ type: 'level', value: 0.35 + Math.random() * 0.6 }); await wait(70); }
        said += (said ? ' ' : '') + w;
        emit({ type: 'partial', text: said });
      }
      for (let k = 0; k < 8; k++) { emit({ type: 'level', value: 0.05 }); await wait(90); }
      emit({ type: 'final', text: said });
      emit({ type: 'end' });
    },
    stop: () => {},
    on: (fn) => { voiceFns.add(fn); return () => voiceFns.delete(fn); },
  },
});

/* For the recorder: set a control as the Settings window would. */
contextBridge.exposeInMainWorld('demo', {
  set: (key, value) => { setControl?.(key, value); },
});
