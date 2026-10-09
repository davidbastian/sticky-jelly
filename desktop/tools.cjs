/*
 * What the jelly can do on your Mac.
 *
 * Each tool is a definition Claude sees (name, description, input schema) and
 * a function the shell runs when Claude asks for it. Looking is free: opening
 * apps and folders, finding files, reading the calendar. Anything that
 * changes something — moving files, adding events or reminders — goes through
 * `confirm` first, which puts the plan in front of you with Do it / Not now,
 * and nothing happens unless you say so.
 *
 * Files are kept to your home folder, never inside ~/Library, never
 * overwritten (a clash gets " 2"), and only ever moved to the Trash, never
 * deleted.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shell, clipboard, Notification } = require('electron');

const HOME = os.homedir();

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/* ~/Desktop, Desktop, /Users/me/Desktop → absolute, inside home, or null. */
function resolveHome(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  if (s === '~') s = HOME;
  else if (s.startsWith('~/')) s = path.join(HOME, s.slice(2));
  else if (!path.isAbsolute(s)) s = path.join(HOME, s);
  s = path.resolve(s);
  return s;
}
const insideHome = (p) => p === HOME || p.startsWith(HOME + path.sep);
const inLibrary = (p) => p.startsWith(path.join(HOME, 'Library') + path.sep) || p === path.join(HOME, 'Library');
const pretty = (p) => (insideHome(p) ? '~' + p.slice(HOME.length) : p);

/* A free name next to an existing one: "Report.pdf" → "Report 2.pdf". */
function freeName(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest), ext = path.extname(dest), base = path.basename(dest, ext);
  for (let i = 2; i < 1000; i++) {
    const p = path.join(dir, `${base} ${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return null;
}

const KINDS = {
  folder: 'public.folder', image: 'public.image', pdf: 'com.adobe.pdf', document: 'public.text',
  presentation: 'public.presentation', spreadsheet: 'public.spreadsheet', video: 'public.movie',
  audio: 'public.audio', app: 'com.apple.application-bundle',
};

function calendarHelper() {
  const p = path.join(__dirname, 'bin', 'jelly-calendar');
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}
async function calendar(...args) {
  const outText = await run(calendarHelper(), args, { timeout: 60000 });
  const o = JSON.parse(outText);
  if (o.error) throw new Error(o.error);
  return o;
}

const str = (v) => typeof v === 'string' && v.trim().length > 0;

/* Local time, the way the user reads their clock: "2026-10-08T11:43". */
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/*
 * The tools. `label` is what the chat shows while it runs ("Opening Spotify").
 * `check` validates the input before anything runs; a string back is the
 * problem, handed to Claude so it can try again.
 */
const TOOLS = [
  {
    name: 'open_app',
    description: 'Open (launch or bring forward) an application on the Mac by its name, like "Safari", "Spotify" or "Figma".',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The application name as it appears in /Applications, without .app.' } },
      required: ['name'], additionalProperties: false,
    },
    label: (i) => `Opening ${i.name}`,
    check: (i) => (str(i.name) ? null : 'name is required'),
    async run(i) {
      try { await run('open', ['-a', i.name.trim()]); }
      catch { return { error: `Couldn't find an app called "${i.name}".` }; }
      return { opened: i.name };
    },
  },
  {
    name: 'open_path',
    description: 'Open a folder (in Finder) or a file (in its default app) inside the user\'s home folder. Paths can start with ~ or be relative to home, like "Downloads". Set reveal to show a file selected in Finder instead of opening it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        reveal: { type: 'boolean', description: 'Show it in Finder instead of opening it.' },
      },
      required: ['path'], additionalProperties: false,
    },
    label: (i) => `${i.reveal ? 'Showing' : 'Opening'} ${path.basename(i.path || '') || 'home'}`,
    check: (i) => (str(i.path) ? null : 'path is required'),
    async run(i) {
      const p = resolveHome(i.path);
      if (!p || !insideHome(p)) return { error: 'Only places inside your home folder.' };
      if (!fs.existsSync(p)) return { error: `Nothing at ${pretty(p)}.` };
      if (i.reveal) shell.showItemInFolder(p);
      else {
        const err = await shell.openPath(p);
        if (err) return { error: err };
      }
      return { opened: pretty(p) };
    },
  },
  {
    name: 'find_files',
    description: 'Search the user\'s files with Spotlight by name, optionally filtered by kind, folder and how recently they changed. Returns the newest matches first, with their paths.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Part of the file name to look for. Leave out to match any name.' },
        kind: { type: 'string', enum: ['any', ...Object.keys(KINDS)] },
        folder: { type: 'string', description: 'Only look inside this folder (default: the whole home folder).' },
        changed_within_days: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    label: (i) => (i.name ? `Looking for “${i.name}”` : 'Looking through your files'),
    check: (i) => (i.name || (i.kind && i.kind !== 'any') || i.changed_within_days ? null : 'give a name, a kind or changed_within_days'),
    async run(i) {
      const dir = i.folder ? resolveHome(i.folder) : HOME;
      if (!dir || !insideHome(dir)) return { error: 'Only inside your home folder.' };
      const terms = [];
      if (str(i.name)) terms.push(`kMDItemFSName == "*${i.name.replace(/["\\*]/g, '')}*"cd`);
      if (i.kind && KINDS[i.kind]) terms.push(`kMDItemContentTypeTree == "${KINDS[i.kind]}"`);
      if (i.changed_within_days) terms.push(`kMDItemFSContentChangeDate >= $time.today(-${Math.round(i.changed_within_days)})`);
      let lines;
      try { lines = (await run('mdfind', ['-onlyin', dir, terms.join(' && ')])).split('\n').filter(Boolean); }
      catch (e) { return { error: `Search failed: ${e.message}` }; }
      const found = lines
        .filter(p => !inLibrary(p) && !p.includes('/node_modules/') && !p.includes('/.'))
        .slice(0, 400)
        .map(p => { try { const s = fs.statSync(p); return { path: pretty(p), modified: stamp(s.mtime), size: s.isDirectory() ? undefined : s.size }; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => (a.modified < b.modified ? 1 : -1))
        .slice(0, i.limit || 20);
      return { count: lines.length, results: found };
    },
  },
  {
    name: 'list_folder',
    description: 'List what is in a folder inside the home folder (newest first), with each item\'s kind, size and date. Use it to see what is there before organising.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 300 } },
      required: ['path'], additionalProperties: false,
    },
    label: (i) => `Looking in ${path.basename(resolveHome(i.path) || '') || 'home'}`,
    check: (i) => (str(i.path) ? null : 'path is required'),
    async run(i) {
      const dir = resolveHome(i.path);
      if (!dir || !insideHome(dir) || inLibrary(dir)) return { error: 'Only folders inside your home folder (not Library).' };
      let names;
      try { names = fs.readdirSync(dir); } catch { return { error: `Can't read ${pretty(dir)}.` }; }
      const items = names.filter(n => !n.startsWith('.')).map(n => {
        try {
          const s = fs.statSync(path.join(dir, n));
          return { name: n, kind: s.isDirectory() ? 'folder' : (path.extname(n).slice(1).toLowerCase() || 'file'), size: s.isDirectory() ? undefined : s.size, modified: stamp(s.mtime) };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => (a.modified < b.modified ? 1 : -1));
      return { folder: pretty(dir), total: items.length, items: items.slice(0, i.limit || 150) };
    },
  },
  {
    name: 'organize_files',
    description: 'Move files and folders inside the home folder (into new or existing folders, or to a new name), and optionally move some to the Trash. The user is shown the whole plan and must approve it, so put every change for the task into one call. Destination folders are created as needed; nothing is ever overwritten or permanently deleted.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One short line describing the plan, shown to the user.' },
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string', description: 'The new full path (folder + name).' } },
            required: ['from', 'to'], additionalProperties: false,
          },
        },
        trash: { type: 'array', items: { type: 'string' }, description: 'Paths to move to the Trash. Only when the user asked for it.' },
      },
      required: ['summary', 'moves'], additionalProperties: false,
    },
    label: (i) => i.summary || 'Organising files',
    check: (i) => (str(i.summary) && Array.isArray(i.moves) && (i.moves.length || (i.trash || []).length) ? null : 'summary and at least one move or trash item are required'),
    async run(i, { confirm }) {
      const moves = [], trash = [], problems = [];
      for (const m of i.moves || []) {
        const from = resolveHome(m.from), to = resolveHome(m.to);
        if (!from || !to || !insideHome(from) || !insideHome(to) || inLibrary(from) || inLibrary(to)) { problems.push(`${m.from}: outside your home folder`); continue; }
        if (!fs.existsSync(from)) { problems.push(`${pretty(from)}: not found`); continue; }
        if (from === to) continue;
        moves.push({ from, to });
      }
      for (const t of i.trash || []) {
        const p = resolveHome(t);
        if (!p || !insideHome(p) || inLibrary(p) || p === HOME) { problems.push(`${t}: can't trash that`); continue; }
        if (!fs.existsSync(p)) { problems.push(`${pretty(p)}: not found`); continue; }
        trash.push(p);
      }
      if (!moves.length && !trash.length) return { error: 'Nothing to do.', problems };

      const lines = [
        ...moves.map(m => ({ from: pretty(m.from), to: pretty(m.to) })),
        ...trash.map(p => ({ from: pretty(p), to: 'Trash' })),
      ];
      const ok = await confirm({ title: i.summary, lines, action: 'Do it' });
      if (!ok) return { declined: true, note: 'The user chose not to do this. Nothing was changed.' };

      let moved = 0, trashed = 0;
      for (const m of moves) {
        try {
          fs.mkdirSync(path.dirname(m.to), { recursive: true });
          const dest = freeName(m.to);
          if (!dest) throw new Error('no free name');
          fs.renameSync(m.from, dest);
          moved++;
        } catch (e) { problems.push(`${pretty(m.from)}: ${e.message}`); }
      }
      for (const p of trash) {
        try { await shell.trashItem(p); trashed++; } catch (e) { problems.push(`${pretty(p)}: ${e.message}`); }
      }
      return { moved, trashed, problems };
    },
  },
  {
    name: 'calendar_events',
    description: 'Read events from the user\'s calendars between two local dates or times ("2026-10-09", "2026-10-09T14:00"). A date alone as the end includes that whole day.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'], additionalProperties: false,
    },
    label: () => 'Looking at your calendar',
    check: (i) => (str(i.from) && str(i.to) ? null : 'from and to are required'),
    async run(i) {
      try { return await calendar('events', i.from, i.to); } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'add_calendar_event',
    description: 'Add an event to the user\'s calendar. Times are local ("2026-10-10T13:00"); a date alone makes an all-day event. The user approves it first.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
        location: { type: 'string' }, notes: { type: 'string' },
        calendar: { type: 'string', description: 'Name of the calendar; leave out for the default.' },
      },
      required: ['title', 'start'], additionalProperties: false,
    },
    label: (i) => `Adding “${i.title}”`,
    check: (i) => (str(i.title) && str(i.start) ? null : 'title and start are required'),
    async run(i, { confirm }) {
      const when = i.end ? `${i.start.replace('T', ' ')} – ${i.end.replace('T', ' ')}` : i.start.replace('T', ' ');
      const ok = await confirm({
        title: 'Add to your calendar',
        lines: [{ from: i.title, to: when }, ...(i.location ? [{ from: 'Where', to: i.location }] : [])],
        action: 'Add it',
      });
      if (!ok) return { declined: true, note: 'The user chose not to add it.' };
      try { return await calendar('add-event', JSON.stringify(i)); } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'reminders_list',
    description: 'Read the user\'s reminders that are not done yet.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Checking your reminders',
    check: () => null,
    async run() {
      try { return await calendar('reminders'); } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'add_reminder',
    description: 'Add a reminder for the user, optionally due at a local date or time ("2026-10-09T17:00"), which also alerts them then. The user approves it first.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, due: { type: 'string' }, notes: { type: 'string' }, list: { type: 'string' } },
      required: ['title'], additionalProperties: false,
    },
    label: (i) => `Adding a reminder`,
    check: (i) => (str(i.title) ? null : 'title is required'),
    async run(i, { confirm }) {
      const ok = await confirm({
        title: 'Add a reminder',
        lines: [{ from: i.title, to: i.due ? i.due.replace('T', ' ') : 'no due time' }],
        action: 'Add it',
      });
      if (!ok) return { declined: true, note: 'The user chose not to add it.' };
      try { return await calendar('add-reminder', JSON.stringify(i)); } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'set_timer',
    description: 'Start a timer. When it ends the user gets a notification and the jelly bounces.',
    input_schema: {
      type: 'object',
      properties: { minutes: { type: 'number', minimum: 0.1, maximum: 1440 }, label: { type: 'string' } },
      required: ['minutes'], additionalProperties: false,
    },
    label: (i) => `Timer for ${i.minutes < 1 ? Math.round(i.minutes * 60) + ' s' : i.minutes + ' min'}`,
    check: (i) => (typeof i.minutes === 'number' && i.minutes > 0 && i.minutes <= 1440 ? null : 'minutes must be between 0.1 and 1440'),
    async run(i, { onTimer }) {
      const ends = new Date(Date.now() + i.minutes * 60000);
      setTimeout(() => {
        new Notification({ title: 'Sticky Jelly', body: i.label ? `Time's up: ${i.label}` : "Time's up!" }).show();
        onTimer?.(i.label || '');
      }, i.minutes * 60000);
      return { set: true, ends: ends.toTimeString().slice(0, 5) };
    },
  },
  {
    name: 'set_volume',
    description: 'Set the Mac\'s output volume (0–100), or mute / unmute it.',
    input_schema: {
      type: 'object',
      properties: { percent: { type: 'integer', minimum: 0, maximum: 100 }, mute: { type: 'boolean' } },
      additionalProperties: false,
    },
    label: (i) => (i.mute === true ? 'Muting' : i.mute === false && i.percent === undefined ? 'Unmuting' : `Volume to ${i.percent}%`),
    check: (i) => (typeof i.percent === 'number' || typeof i.mute === 'boolean' ? null : 'give percent or mute'),
    async run(i) {
      const parts = [];
      if (typeof i.percent === 'number') parts.push(`set volume output volume ${Math.max(0, Math.min(100, Math.round(i.percent)))}`);
      if (typeof i.mute === 'boolean') parts.push(`set volume ${i.mute ? 'with' : 'without'} output muted`);
      try { await run('osascript', ['-e', parts.join('\n')]); } catch (e) { return { error: e.message }; }
      return { done: true };
    },
  },
  {
    name: 'set_dark_mode',
    description: 'Switch the Mac between dark and light appearance.',
    input_schema: { type: 'object', properties: { dark: { type: 'boolean' } }, required: ['dark'], additionalProperties: false },
    label: (i) => (i.dark ? 'Going dark' : 'Going light'),
    check: (i) => (typeof i.dark === 'boolean' ? null : 'dark is required'),
    async run(i) {
      try {
        await run('osascript', ['-e', `tell application "System Events" to tell appearance preferences to set dark mode to ${i.dark}`]);
      } catch (e) {
        return { error: /not allowed|-1743/i.test(e.message) ? 'macOS needs permission for Sticky Jelly to control System Events (System Settings › Privacy & Security › Automation).' : e.message };
      }
      return { done: true };
    },
  },
  {
    name: 'read_clipboard',
    description: 'Read the text currently on the clipboard.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Reading the clipboard',
    check: () => null,
    async run() { return { text: clipboard.readText().slice(0, 20000) }; },
  },
  {
    name: 'copy_to_clipboard',
    description: 'Put text on the clipboard so the user can paste it.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    label: () => 'Copying to the clipboard',
    check: (i) => (typeof i.text === 'string' ? null : 'text is required'),
    async run(i) { clipboard.writeText(i.text); return { copied: i.text.length }; },
  },
];

const byName = new Map(TOOLS.map(t => [t.name, t]));

/* What Claude is told about the tools (the API shape only). */
function definitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/* Run one tool_use block; always resolves to something to send back. */
async function execute(block, ctx) {
  const tool = byName.get(block.name);
  if (!tool) return { error: `There is no tool called ${block.name}.` };
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const problem = tool.check(input);
  if (problem) return { error: `Invalid input: ${problem}` };
  try { return await tool.run(input, ctx); } catch (e) { return { error: e.message || 'It failed.' }; }
}

const labelFor = (block) => {
  const tool = byName.get(block.name);
  try { return tool ? tool.label(block.input || {}) : block.name; } catch { return block.name; }
};

module.exports = { definitions, execute, labelFor };
