/*
 * The Settings window.
 *
 * It owns no settings. The creature's own controls are described by the jelly
 * window and relayed by the shell; this page draws one row per control and
 * sends every change straight back, so a slider here moves the jelly as you
 * drag it. The shell keeps the values and saves them for the next launch.
 */
import type { Control } from './StickyJelly';

interface Section { title: string; controls: Control[] }
interface Assistant { hasKey: boolean; model: string; models: Record<string, string>; speak: boolean }

declare global {
  interface Window {
    settings: {
      get: () => Promise<{ schema: Section[]; icons: boolean; assistant: Assistant }>;
      set: (key: string, value: unknown) => void;
      icons: (on: boolean) => void;
      reset: () => Promise<void>;
      save: () => Promise<boolean>;
      onSchema: (fn: () => void) => void;
      saveKey: (key: string) => Promise<boolean>;
      removeKey: () => Promise<void>;
      model: (m: string) => void;
      speak: (on: boolean) => void;
      openConsole: () => void;
    };
  }
}

const nav = document.getElementById('nav')!;
const pane = document.getElementById('pane')!;
const title = document.getElementById('title')!;

let sections: Section[] = [];
let icons = true;
let assistant: Assistant = { hasKey: false, model: '', models: {}, speak: true };
let current = 0;

/* Enough decimals to show the step, no more. */
const fmt = (v: number, step: number) => {
  const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(d);
};

function row(label: string, control: HTMLElement, value?: HTMLElement) {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  r.append(l, control);
  if (value) r.append(value);
  return r;
}

function toggle(on: boolean, label: string, change: (on: boolean) => void) {
  const b = document.createElement('button');
  b.className = 'switch';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-checked', String(on));
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    change(next);
  });
  return b;
}

function controlRow(c: Control) {
  const send = (v: unknown) => {
    (c as { value: unknown }).value = v;
    window.settings.set(c.key, v);
  };
  switch (c.kind) {
    case 'number': {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      input.value = String(c.value);
      input.setAttribute('aria-label', c.label);
      const out = document.createElement('span');
      out.className = 'value';
      const paint = () => {
        const v = Number(input.value);
        out.textContent = fmt(v, c.step);
        input.style.setProperty('--p', `${((v - c.min) / (c.max - c.min)) * 100}%`);
      };
      paint();
      input.addEventListener('input', () => { paint(); send(Number(input.value)); });
      return row(c.label, input, out);
    }
    case 'boolean':
      return row(c.label, toggle(c.value, c.label, send));
    case 'option': {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', c.label);
      for (const o of c.options) sel.add(new Option(o, o, false, o === c.value));
      sel.addEventListener('change', () => send(sel.value));
      return row(c.label, sel);
    }
    case 'color': {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = c.value;
      input.setAttribute('aria-label', c.label);
      input.addEventListener('input', () => send(input.value));
      return row(c.label, input);
    }
  }
}

/* Settings that belong to the shell rather than the creature. */
function desktopSection() {
  const g = document.createElement('div');
  g.className = 'group';
  g.append(row('Move desktop icons aside', toggle(icons, 'Move desktop icons aside', (on) => {
    icons = on;
    window.settings.icons(on);
  })));
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent =
    'When the jelly comes to rest, icons under it move to the nearest free spot, and go back when it leaves. macOS asks once to let Sticky Jelly control Finder.';

  const reset = document.createElement('button');
  reset.textContent = 'Restore Defaults';
  reset.addEventListener('click', async () => {
    await window.settings.reset();
    await load();
  });
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(reset);
  return [g, note, actions];
}

/*
 * The chat behind the long-press. The key is typed here by its owner and goes
 * straight to the shell, which keeps it encrypted in the Keychain; this page
 * never sees it again, only whether one is saved.
 */
function assistantSection() {
  const g = document.createElement('div');
  g.className = 'group';

  const field = document.createElement('input');
  field.type = 'password';
  field.placeholder = assistant.hasKey ? 'Saved — paste a new key to replace it' : 'sk-ant-…';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Anthropic API key');
  field.className = 'key';
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.className = 'small';
  const keyRow = row('API key', field, save);
  const store = async () => {
    if (!field.value.trim()) return;
    await window.settings.saveKey(field.value);
    field.value = '';
    await load();
  };
  save.addEventListener('click', store);
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') store(); });

  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = assistant.hasKey ? 'Saved in your Keychain' : 'No key yet';
  const statusRow = row('Status', status);
  if (assistant.hasKey) {
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.className = 'small';
    remove.addEventListener('click', async () => { await window.settings.removeKey(); await load(); });
    statusRow.append(remove);
  }

  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Model');
  for (const [id, name] of Object.entries(assistant.models)) sel.add(new Option(name, id, false, id === assistant.model));
  sel.addEventListener('change', () => { assistant.model = sel.value; window.settings.model(sel.value); });

  const talk = toggle(assistant.speak, 'Talk back when I talk to it', (on) => {
    assistant.speak = on;
    window.settings.speak(on);
  });

  g.append(keyRow, statusRow, row('Model', sel), row('Talk back when I talk to it', talk));

  const note = document.createElement('p');
  note.className = 'note';
  note.append('Press and hold the jelly to chat — type, or press the microphone and talk (speech is recognised on your Mac). Uses your own Anthropic API key, billed per message to your account; Haiku is the cheapest. ');
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'Get a key in the Anthropic Console';
  link.addEventListener('click', (e) => { e.preventDefault(); window.settings.openConsole(); });
  note.append(link, '.');
  return [g, note];
}

function render() {
  const all = [...sections.map(s => s.title), 'Assistant', 'Desktop'];
  nav.replaceChildren(...all.map((t, i) => {
    const b = document.createElement('button');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = t[0];
    b.append(dot, t);
    b.setAttribute('aria-current', String(i === current));
    b.addEventListener('click', () => { current = i; render(); });
    return b;
  }));
  title.textContent = all[current];
  if (current < sections.length) {
    const g = document.createElement('div');
    g.className = 'group';
    g.append(...sections[current].controls.map(controlRow));
    pane.replaceChildren(g);
  } else if (current === sections.length) {
    pane.replaceChildren(...assistantSection());
  } else {
    pane.replaceChildren(...desktopSection());
  }
}

async function load() {
  const s = await window.settings.get();
  sections = s.schema;
  icons = s.icons;
  assistant = s.assistant;
  current = Math.min(current, sections.length + 1);
  render();
}

/*
 * Every change is already written a moment after it is made; the button is
 * for the reassurance of pressing it — it writes immediately and says so.
 */
const savedNote = document.getElementById('saved')!;
let noteTimer = 0;
document.getElementById('save')!.addEventListener('click', async () => {
  const ok = await window.settings.save();
  savedNote.textContent = ok
    ? `Saved — Sticky Jelly will open like this next time`
    : 'Could not save settings';
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { savedNote.textContent = 'Changes save automatically'; }, 4000);
});

/* The jelly window can reload after this one opened; redraw when it reports. */
window.settings.onSchema(load);
load();
