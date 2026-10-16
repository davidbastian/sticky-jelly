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
const { shell, clipboard, Notification, systemPreferences } = require('electron');

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

/* AppleScript with its inputs passed as arguments, never pasted into the
   script — so a title with a quote in it can't break out. */
const osa = (script, ...args) => run('osascript', ['-e', `on run argv\n${script}\nend run`, ...args.map(String)]);
const jxa = (script, ...args) => run('osascript', ['-l', 'JavaScript', '-e', `function run(argv) {\n${script}\n}`, ...args.map(String)]);

const mins = (m) => (m < 1 ? `${Math.round(m * 60)} s` : `${+m.toFixed(1)} min`);

/* The Wi-Fi interface (usually en0), found once. */
let wifiPort = null;
async function wifiDevice() {
  if (wifiPort) return wifiPort;
  const out = await run('networksetup', ['-listallhardwareports']);
  const m = out.match(/Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/);
  wifiPort = m ? m[1] : 'en0';
  return wifiPort;
}

/* A picture for the model: shrunk to a size it reads well, as JPEG. */
async function imageFor(file) {
  const tmp = path.join(os.tmpdir(), `jelly-${process.pid}-${Date.now()}.jpg`);
  await run('sips', ['-Z', '1568', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', file, '--out', tmp]);
  const data = fs.readFileSync(tmp).toString('base64');
  fs.rmSync(tmp, { force: true });
  return { media_type: 'image/jpeg', data };
}

/* Typing for someone: never what looks like a card number or a password-ish
   secret. (Fields are checked too, on web pages.) */
const looksSensitive = (t) => /\b(?:\d[ -]?){13,19}\b/.test(t);

/*
 * Web pages: the browsers that take JavaScript from AppleScript, and how to
 * ask each one. The page script runs in the current tab of the front window.
 */
const BROWSERS = ['Safari', 'Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge'];
async function frontBrowser(pref) {
  if (pref && BROWSERS.includes(pref)) return pref;
  const running = (await run('osascript', ['-e', 'tell application "System Events" to get name of every application process whose background only is false']).catch(() => '')).split(', ').map(s => s.trim());
  const front = (await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']).catch(() => '')).trim();
  if (BROWSERS.includes(front)) return front;
  return BROWSERS.find(b => running.includes(b)) || 'Safari';
}
async function inPage(browser, js) {
  const script = browser === 'Safari'
    ? 'tell application "Safari" to do JavaScript (item 1 of argv) in current tab of front window'
    : `tell application "${browser}" to execute active tab of front window javascript (item 1 of argv)`;
  try {
    const out = (await osa(script, js)).trim();
    return out ? JSON.parse(out) : null;
  } catch (e) {
    if (/JavaScript from Apple Events|Allow JavaScript|-1708|not allowed/i.test(e.message)) {
      throw new Error(browser === 'Safari'
        ? 'Safari needs one setting: Safari › Settings › Advanced › tick "Show features for web developers", then Develop › "Allow JavaScript from Apple Events".'
        : `${browser} needs one setting: View › Developer › "Allow JavaScript from Apple Events".`);
    }
    if (/-1743|not authori/i.test(e.message)) throw new Error(`macOS needs permission for Sticky Jelly to control ${browser} (System Settings › Privacy & Security › Automation).`);
    throw new Error(e.message.split('\n')[0]);
  }
}
/* Shared by the page scripts: which fields must never be filled for someone. */
const PAGE_HELPERS = `
  const sensitive = (el) => {
    const a = [el.type, el.autocomplete, el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' ').toLowerCase();
    return el.type === 'password' || /cc-|card|cvv|cvc|csc|iban|ssn|social security|password|passcode|pin\\b|otp|one-time|security code/.test(a);
  };
  // A label's own words only — not the text of the field inside it.
  const ownText = (lab) => [...lab.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim() || lab.innerText;
  const labelOf = (el) => (el.getAttribute('aria-label') || (el.labels && el.labels[0] && ownText(el.labels[0])) || el.placeholder || (el.tagName === 'SELECT' ? el.name : el.innerText) || el.value || el.name || el.title || el.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const byId = (id) => document.querySelector('[data-jelly-id="' + id + '"]');
`;

function musicApp(pref) {
  if (pref === 'Spotify' || pref === 'Music') return pref;
  return fs.existsSync('/Applications/Spotify.app') ? 'Spotify' : 'Music';
}

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
    name: 'open_url',
    description: 'Open a web page (or a mailto: link) — in the default browser, or in a named one. Use it for anything that is a website rather than an installed app: YouTube, Gmail, Google, maps, a search on any site. Build the full URL yourself, e.g. https://www.youtube.com/results?search_query=lofi+beats or https://www.google.com/maps/search/coffee+near+me.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A full http(s):// or mailto: URL.' },
        browser: { type: 'string', enum: ['default', 'Safari', 'Google Chrome', 'Arc', 'Firefox', 'Microsoft Edge', 'Brave Browser'] },
      },
      required: ['url'], additionalProperties: false,
    },
    label: (i) => {
      try { const u = new URL(i.url); return `Opening ${u.protocol === 'mailto:' ? 'an email' : u.hostname.replace(/^www\./, '')}`; } catch { return 'Opening a link'; }
    },
    check: (i) => {
      try {
        const u = new URL(i.url);
        return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? null : 'only http, https and mailto links';
      } catch { return 'url must be a full URL'; }
    },
    async run(i) {
      if (i.browser && i.browser !== 'default') {
        try { await run('open', ['-a', i.browser, i.url]); return { opened: i.url, browser: i.browser }; }
        catch { /* not installed: fall back to the default browser */ }
      }
      await shell.openExternal(i.url);
      return { opened: i.url, browser: 'default' };
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

  // ── Power ───────────────────────────────────────────────────────────────
  {
    name: 'sleep_mac',
    description: 'Put the Mac to sleep, now or after some minutes.',
    input_schema: { type: 'object', properties: { in_minutes: { type: 'number', minimum: 0, maximum: 720 } }, additionalProperties: false },
    label: (i) => (i.in_minutes ? `Sleep in ${mins(i.in_minutes)}` : 'Going to sleep'),
    check: () => null,
    async run(i) {
      const later = Math.max(0, i.in_minutes || 0);
      // A moment's grace even "now", so the reply can be read first.
      setTimeout(() => run('pmset', ['sleepnow']).catch(() => {}), later ? later * 60000 : 2500);
      return { sleeping: later ? `in ${mins(later)}` : 'now' };
    },
  },
  {
    name: 'lock_screen',
    description: 'Lock the Mac right away (the user will need their password or Touch ID to come back).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Locking the screen',
    check: () => null,
    async run() {
      await new Promise(r => setTimeout(r, 1200));
      try {
        await osa('tell application "System Events" to keystroke "q" using {control down, command down}');
        return { locked: true };
      } catch {
        // Without Accessibility access: turning the display off locks it on
        // a Mac set to ask for the password straight away.
        await run('pmset', ['displaysleepnow']);
        return { locked: 'display off', note: 'For a real lock, allow Sticky Jelly in System Settings › Privacy & Security › Accessibility.' };
      }
    },
  },
  {
    name: 'display_off',
    description: 'Turn the display off without putting the Mac to sleep (music keeps playing).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Turning the display off',
    check: () => null,
    async run() {
      setTimeout(() => run('pmset', ['displaysleepnow']).catch(() => {}), 1500);
      return { done: true };
    },
  },
  {
    name: 'restart_or_shut_down',
    description: 'Restart or shut down the Mac, now or after some minutes. Apps are asked to quit normally, so unsaved work prompts as usual. The user approves it first.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['restart', 'shut_down'] }, in_minutes: { type: 'number', minimum: 0, maximum: 720 } },
      required: ['action'], additionalProperties: false,
    },
    label: (i) => (i.action === 'restart' ? 'Restarting' : 'Shutting down'),
    check: (i) => (i.action === 'restart' || i.action === 'shut_down' ? null : 'action must be restart or shut_down'),
    async run(i, { confirm }) {
      const verb = i.action === 'restart' ? 'Restart' : 'Shut down';
      const when = i.in_minutes ? `in ${mins(i.in_minutes)}` : 'now';
      const ok = await confirm({ title: `${verb} your Mac`, lines: [{ from: verb, to: when }], action: verb });
      if (!ok) return { declined: true, note: 'The user chose not to.' };
      const go = () => osa(`tell application "System Events" to ${i.action === 'restart' ? 'restart' : 'shut down'}`).catch(() => {});
      setTimeout(go, i.in_minutes ? i.in_minutes * 60000 : 2500);
      return { scheduled: when, note: 'Only while Sticky Jelly keeps running.' };
    },
  },

  // ── The Mac's state ─────────────────────────────────────────────────────
  {
    name: 'system_status',
    description: 'How the Mac is doing: battery (percent, charging, time left), Wi-Fi (on/off and network), free disk space, volume.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Checking the Mac',
    check: () => null,
    async run() {
      const out = {};
      try {
        const b = await run('pmset', ['-g', 'batt']);
        const m = b.match(/(\d+)%;\s*([^;]+);\s*([^\n]*)/);
        if (m) out.battery = { percent: +m[1], state: m[2].trim(), remaining: m[3].replace(/present: true/, '').trim() || undefined };
        else out.battery = 'none (a desktop Mac)';
      } catch { /* no battery info */ }
      try {
        const dev = await wifiDevice();
        out.wifi = { on: /On$/m.test(await run('networksetup', ['-getairportpower', dev])) };
        const net = await run('networksetup', ['-getairportnetwork', dev]).catch(() => '');
        const name = net.match(/Current Wi-Fi Network: (.+)/);
        if (name) out.wifi.network = name[1].trim();
      } catch { /* no Wi-Fi */ }
      try {
        const df = (await run('df', ['-k', '/System/Volumes/Data'])).trim().split('\n').pop().split(/\s+/);
        out.disk = { freeGB: Math.round(+df[3] / 1024 / 1024), usedPercent: df[4] };
      } catch { /* skip */ }
      try { out.volume = +(await osa('output volume of (get volume settings)')).trim(); } catch { /* skip */ }
      return out;
    },
  },
  {
    name: 'set_wifi',
    description: 'Turn Wi-Fi on or off.',
    input_schema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'], additionalProperties: false },
    label: (i) => (i.on ? 'Wi-Fi on' : 'Wi-Fi off'),
    check: (i) => (typeof i.on === 'boolean' ? null : 'on is required'),
    async run(i) {
      try { await run('networksetup', ['-setairportpower', await wifiDevice(), i.on ? 'on' : 'off']); }
      catch (e) { return { error: e.message }; }
      return { wifi: i.on ? 'on' : 'off' };
    },
  },

  // ── Music ───────────────────────────────────────────────────────────────
  {
    name: 'music',
    description: 'Control Spotify or Apple Music: play, pause, next, previous, what is playing, or find something to play by name, artist or playlist (search).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'now_playing', 'search'] },
        query: { type: 'string', description: 'For search: a song, artist, album, playlist or mood.' },
        app: { type: 'string', enum: ['Spotify', 'Music'], description: 'Leave out to use Spotify if installed, else Apple Music.' },
      },
      required: ['action'], additionalProperties: false,
    },
    label: (i) => ({ play: 'Playing', pause: 'Pausing', next: 'Next track', previous: 'Previous track', now_playing: "Checking what's playing", search: `Finding “${i.query || 'music'}”` }[i.action] || 'Music'),
    check: (i) => (i.action === 'search' && !str(i.query) ? 'search needs a query' : null),
    async run(i) {
      const appName = musicApp(i.app);
      const cmd = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' }[i.action];
      try {
        if (cmd) {
          await osa(`tell application "${appName}" to ${cmd}`);
          return { done: i.action, app: appName };
        }
        if (i.action === 'now_playing') {
          const out = await osa(`tell application "${appName}"\nif player state is playing then\nreturn (name of current track) & " — " & (artist of current track)\nelse\nreturn "nothing playing"\nend if\nend tell`);
          return { app: appName, now_playing: out.trim() };
        }
        // search
        if (appName === 'Spotify') {
          await shell.openExternal(`spotify:search:${encodeURIComponent(i.query)}`);
          return { app: 'Spotify', note: 'Opened the Spotify search; the user picks what to play.' };
        }
        const out = await osa(`set q to item 1 of argv
tell application "Music"
  set hits to (every playlist whose name contains q)
  if hits is not {} then
    play item 1 of hits
    return "playlist: " & name of item 1 of hits
  end if
  set hits to (every track of library playlist 1 whose name contains q or artist contains q or album contains q)
  if hits is not {} then
    play item 1 of hits
    return "track: " & (name of item 1 of hits) & " — " & (artist of item 1 of hits)
  end if
  return "not found"
end tell`, i.query);
        return { app: 'Music', result: out.trim() };
      } catch (e) {
        return { error: `${appName}: ${e.message.split('\n')[0]}` };
      }
    },
  },

  // ── Notes and drafts ────────────────────────────────────────────────────
  {
    name: 'add_note',
    description: 'Save a note in Apple Notes. The user approves it first.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'], additionalProperties: false,
    },
    label: () => 'Saving a note',
    check: (i) => (str(i.title) && typeof i.body === 'string' ? null : 'title and body are required'),
    async run(i, { confirm }) {
      const ok = await confirm({ title: 'Save to Notes', lines: [{ from: i.title, to: `${i.body.slice(0, 60)}${i.body.length > 60 ? '…' : ''}` }], action: 'Save it' });
      if (!ok) return { declined: true, note: 'The user chose not to save it.' };
      const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `<h1>${esc(i.title)}</h1>${esc(i.body).split('\n').map(l => `<div>${l || '<br>'}</div>`).join('')}`;
      try { await osa('tell application "Notes" to make new note with properties {body:item 1 of argv}', html); }
      catch (e) { return { error: /not allowed|-1743/i.test(e.message) ? 'macOS needs permission for Sticky Jelly to use Notes (System Settings › Privacy & Security › Automation).' : e.message }; }
      return { saved: i.title };
    },
  },
  {
    name: 'draft_email',
    description: 'Open a new email draft in the user\'s mail app with the recipient, subject and body filled in. It is never sent — the user sends it.',
    input_schema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['subject', 'body'], additionalProperties: false,
    },
    label: () => 'Drafting an email',
    check: (i) => (typeof i.subject === 'string' && typeof i.body === 'string' ? null : 'subject and body are required'),
    async run(i) {
      const q = new URLSearchParams({ subject: i.subject, body: i.body }).toString().replace(/\+/g, '%20');
      await shell.openExternal(`mailto:${encodeURIComponent(i.to || '').replace(/%40/g, '@')}?${q}`);
      return { drafted: true, note: 'Draft opened; not sent.' };
    },
  },
  {
    name: 'draft_message',
    description: 'Prepare a message for Messages: the text goes on the clipboard and Messages opens (to the person, if a phone number or email is given) for the user to paste and send. It is never sent automatically.',
    input_schema: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Phone number or email, if known.' }, text: { type: 'string' } },
      required: ['text'], additionalProperties: false,
    },
    label: () => 'Preparing a message',
    check: (i) => (typeof i.text === 'string' && i.text.length ? null : 'text is required'),
    async run(i) {
      clipboard.writeText(i.text);
      if (str(i.to) && /^[+\d\s()-]{5,}$|@/.test(i.to)) await shell.openExternal(`imessage://${encodeURIComponent(i.to.replace(/\s/g, '')).replace(/%40/g, '@')}`);
      else await run('open', ['-a', 'Messages']);
      return { copied: true, note: 'The text is on the clipboard; Messages is open. The user pastes and sends it.' };
    },
  },

  // ── Seeing ──────────────────────────────────────────────────────────────
  {
    name: 'look_at_screen',
    description: 'Take a screenshot of the main display and look at it, to explain, summarise or help with what the user is looking at. The user approves it each time.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Looking at your screen',
    check: () => null,
    async run(_i, { confirm, hidden }) {
      const ok = await confirm({ title: 'Look at your screen?', lines: [{ from: 'A screenshot of your main display', to: 'sent to the assistant' }], action: 'Show it' });
      if (!ok) return { declined: true, note: 'The user chose not to share their screen.' };
      if (systemPreferences.getMediaAccessStatus('screen') === 'denied') {
        return { error: 'Sticky Jelly needs Screen Recording permission: System Settings › Privacy & Security › Screen & System Audio Recording, then restart Sticky Jelly.' };
      }
      const file = path.join(os.tmpdir(), `jelly-screen-${process.pid}.png`);
      // The jelly steps out of the picture while it is taken.
      const take = () => run('screencapture', ['-x', '-m', '-t', 'png', file]);
      if (hidden) await hidden(take); else await take();
      try { return { image: await imageFor(file), note: 'This is the user\'s screen right now.' }; }
      finally { fs.rmSync(file, { force: true }); }
    },
  },
  {
    name: 'read_file',
    description: 'Read a file inside the home folder so you can summarise it, answer questions about it or use it: text and code, PDF, Word/RTF/HTML documents, and images (which you see).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, max_chars: { type: 'integer', minimum: 1000, maximum: 120000 } },
      required: ['path'], additionalProperties: false,
    },
    label: (i) => `Reading ${path.basename(i.path || '')}`,
    check: (i) => (str(i.path) ? null : 'path is required'),
    async run(i) {
      const p = resolveHome(i.path);
      if (!p || !insideHome(p) || inLibrary(p)) return { error: 'Only files inside your home folder (not Library).' };
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return { error: `No file at ${pretty(p)}.` };
      const ext = path.extname(p).slice(1).toLowerCase();
      const limit = i.max_chars || 60000;
      const clip = (t) => ({ file: pretty(p), text: t.slice(0, limit), truncated: t.length > limit || undefined, chars: t.length });
      try {
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tiff', 'bmp'].includes(ext)) return { file: pretty(p), image: await imageFor(p) };
        if (ext === 'pdf') {
          const t = await jxa("ObjC.import('PDFKit'); const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); return d.isNil() ? '' : ObjC.unwrap(d.string);", p);
          return t.trim() ? clip(t) : { file: pretty(p), error: 'No text in this PDF (it may be scanned images).' };
        }
        if (['doc', 'docx', 'rtf', 'rtfd', 'odt', 'html', 'htm', 'webarchive', 'wordml'].includes(ext)) {
          return clip(await run('textutil', ['-convert', 'txt', '-stdout', p]));
        }
        if (fs.statSync(p).size > 4 * 1024 * 1024) return { error: 'That file is too big to read here.' };
        const t = fs.readFileSync(p, 'utf8');
        if (t.includes('\u0000')) return { error: "That isn't a text file I can read." };
        return clip(t);
      } catch (e) { return { error: e.message.split('\n')[0] }; }
    },
  },

  // ── Typing and web pages ────────────────────────────────────────────────
  {
    name: 'type_text',
    description: 'Type text where the user\'s cursor is, in whatever app they were using (a text field they clicked into: a browser box, a document, a chat). Optionally press Enter after (asks the user first, since that may send or submit). Never for passwords, card numbers or other secrets.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, press_enter: { type: 'boolean' } },
      required: ['text'], additionalProperties: false,
    },
    label: (i) => `Typing ${i.text.length > 24 ? `“${i.text.slice(0, 24)}…”` : `“${i.text}”`}`,
    check: (i) => (typeof i.text === 'string' && i.text.length ? null : 'text is required'),
    async run(i, { confirm, typeAway }) {
      if (looksSensitive(i.text)) return { error: "That looks like a card number — I won't type that. The user can type it themselves." };
      if (!typeAway) return { error: 'Not available.' };
      if (!systemPreferences.isTrustedAccessibilityClient(true)) {
        return { error: 'To type for you, Sticky Jelly needs Accessibility: System Settings › Privacy & Security › Accessibility, switch on Sticky Jelly, then ask again.' };
      }
      if (i.press_enter) {
        const ok = await confirm({ title: 'Type it and press Enter', lines: [{ from: i.text.slice(0, 80), to: 'then Enter — this may send or submit' }], action: 'Type it' });
        if (!ok) return { declined: true, note: 'The user chose not to.' };
      }
      // Pasted rather than keyed, so any character comes out right; the
      // clipboard is put back afterwards.
      const into = await typeAway(async () => {
        const before = clipboard.readText();
        clipboard.writeText(i.text);
        await osa('tell application "System Events" to keystroke "v" using command down');
        await new Promise(r => setTimeout(r, 180));
        if (i.press_enter) await osa('tell application "System Events" to key code 36');
        setTimeout(() => clipboard.writeText(before), 600);
      });
      return { typed: i.text.length, into, entered: !!i.press_enter };
    },
  },
  {
    name: 'browser_read_page',
    description: 'Read the page open in the front browser window (Safari, Chrome, Arc, Brave or Edge): its URL and title, the fields, buttons and links on it (each with an id to use with browser_fill and browser_click), and its text.',
    input_schema: {
      type: 'object',
      properties: { browser: { type: 'string', enum: BROWSERS } },
      additionalProperties: false,
    },
    label: () => 'Reading the page',
    check: () => null,
    async run(i) {
      const browser = await frontBrowser(i.browser);
      try {
        const page = await inPage(browser, `(() => { ${PAGE_HELPERS}
          window.__jellyN = window.__jellyN || 0;
          const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const items = [];
          for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select, button, a[href], [role=button], [contenteditable=true]')) {
            if (items.length >= 150 || !shown(el)) continue;
            if (!el.dataset.jellyId) el.dataset.jellyId = String(++window.__jellyN);
            const tag = el.tagName.toLowerCase();
            const kind = tag === 'a' ? 'link' : tag === 'button' || el.getAttribute('role') === 'button' || ['submit', 'button'].includes(el.type) ? 'button' : 'field';
            const it = { id: +el.dataset.jellyId, kind, label: labelOf(el) };
            if (kind === 'field') { it.type = tag === 'input' ? el.type : tag; if (sensitive(el)) it.sensitive = true; else if (el.value) it.value = String(el.value).slice(0, 60); }
            if (kind === 'link') it.href = el.getAttribute('href').slice(0, 80);
            items.push(it);
          }
          return JSON.stringify({ url: location.href, title: document.title, items, text: document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 5000) });
        })()`);
        return { browser, ...page };
      } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill fields on the front browser page, by the ids from browser_read_page. Text fields, text areas, selects (by option text) and editable areas. Password, card and other sensitive fields are refused — the user fills those.',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, value: { type: 'string' } }, required: ['id', 'value'], additionalProperties: false } },
        browser: { type: 'string', enum: BROWSERS },
      },
      required: ['fields'], additionalProperties: false,
    },
    label: (i) => `Filling ${i.fields?.length || ''} field${i.fields?.length === 1 ? '' : 's'}`,
    check: (i) => (Array.isArray(i.fields) && i.fields.length ? null : 'fields are required'),
    async run(i) {
      if (i.fields.some(f => looksSensitive(f.value))) return { error: "One of those looks like a card number — I won't fill that." };
      const browser = await frontBrowser(i.browser);
      try {
        const result = await inPage(browser, `(() => { ${PAGE_HELPERS}
          const fields = ${JSON.stringify(i.fields)};
          const done = [], refused = [], missing = [];
          for (const f of fields) {
            const el = byId(f.id);
            if (!el) { missing.push(f.id); continue; }
            if (sensitive(el)) { refused.push(labelOf(el) || f.id); continue; }
            el.focus();
            if (el.tagName === 'SELECT') {
              const opt = [...el.options].find(o => o.text.trim().toLowerCase() === f.value.toLowerCase() || o.value === f.value) || [...el.options].find(o => o.text.toLowerCase().includes(f.value.toLowerCase()));
              if (opt) el.value = opt.value; else { missing.push(f.id); continue; }
            } else if (el.isContentEditable) {
              document.execCommand('selectAll', false); document.execCommand('insertText', false, f.value);
            } else {
              // The native setter, so frameworks (React and co.) notice.
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, f.value);
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            done.push(labelOf(el) || f.id);
          }
          return JSON.stringify({ filled: done, refused, missing });
        })()`);
        return { browser, ...result, ...(result.refused?.length ? { note: 'Sensitive fields were left for the user.' } : {}) };
      } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'browser_click',
    description: 'Click a button or link on the front browser page, by its id from browser_read_page. Anything that buys, pays, orders, sends, posts, submits, deletes or signs up is shown to the user to approve first. Never use it to log in.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, browser: { type: 'string', enum: BROWSERS } },
      required: ['id'], additionalProperties: false,
    },
    label: () => 'Clicking',
    check: (i) => (Number.isInteger(i.id) ? null : 'id is required'),
    async run(i, { confirm }) {
      const browser = await frontBrowser(i.browser);
      try {
        const info = await inPage(browser, `(() => { ${PAGE_HELPERS}
          const el = byId(${i.id});
          if (!el) return JSON.stringify(null);
          return JSON.stringify({ label: labelOf(el), submit: el.type === 'submit' || (el.tagName === 'BUTTON' && !!el.form && el.type !== 'button'), host: location.hostname });
        })()`);
        if (!info) return { error: 'That element is gone — read the page again.' };
        const risky = info.submit || /buy|pay|order|purchase|checkout|check out|send|post|publish|submit|delete|remove|confirm|subscribe|sign ?up|book|reserve|donate|transfer|place/i.test(info.label);
        if (/log ?in|sign ?in/i.test(info.label)) return { error: "I don't log in for people — the user can press that one." };
        if (risky) {
          const ok = await confirm({ title: `Press “${info.label || 'this button'}”?`, lines: [{ from: info.label || 'Button', to: info.host }], action: 'Press it' });
          if (!ok) return { declined: true, note: 'The user chose not to press it.' };
        }
        await inPage(browser, `(() => { ${PAGE_HELPERS} const el = byId(${i.id}); if (el) { el.scrollIntoView({ block: 'center' }); el.click(); } return JSON.stringify(!!el); })()`);
        await new Promise(r => setTimeout(r, 1200));
        const after = await inPage(browser, 'JSON.stringify({ url: location.href, title: document.title })').catch(() => null);
        return { clicked: info.label, now: after };
      } catch (e) { return { error: e.message }; }
    },
  },

  // ── The jelly's own time ────────────────────────────────────────────────
  {
    name: 'focus_timer',
    description: 'Start a focus session (Pomodoro): the jelly slowly gets sleepier as the time runs out, then bounces and starts the break; notifications mark both ends.',
    input_schema: {
      type: 'object',
      properties: { minutes: { type: 'number', minimum: 1, maximum: 180 }, break_minutes: { type: 'number', minimum: 0, maximum: 60 }, label: { type: 'string' } },
      additionalProperties: false,
    },
    label: (i) => `Focus for ${mins(i.minutes || 25)}`,
    check: () => null,
    async run(i, { focus }) {
      if (!focus) return { error: 'Not available.' };
      const ends = focus(i.minutes || 25, i.break_minutes ?? 5, i.label || '');
      return { focusing: true, ends };
    },
  },
  {
    name: 'jelly_away',
    description: 'Hide the jelly itself for a while (do not disturb); it comes back on its own, or from its menu-bar icon.',
    input_schema: { type: 'object', properties: { minutes: { type: 'number', minimum: 1, maximum: 1440 } }, required: ['minutes'], additionalProperties: false },
    label: (i) => `Away for ${mins(i.minutes)}`,
    check: (i) => (typeof i.minutes === 'number' ? null : 'minutes is required'),
    async run(i, { away }) {
      if (!away) return { error: 'Not available.' };
      return { away: true, back: away(i.minutes) };
    },
  },
  {
    name: 'watch_folder',
    description: 'From now on, automatically tidy NEW files that land in a folder (like Downloads) into subfolders by type: Images, Documents, Videos, Audio, Archives, Installers, Code. Existing files are left alone (use organize_files for those). Set stop to true to stop watching. The user approves it first.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, stop: { type: 'boolean' } },
      required: ['path'], additionalProperties: false,
    },
    label: (i) => (i.stop ? `Stop tidying ${path.basename(i.path || '')}` : `Tidying ${path.basename(i.path || '')}`),
    check: (i) => (str(i.path) ? null : 'path is required'),
    async run(i, { confirm, watch }) {
      if (!watch) return { error: 'Not available.' };
      const p = resolveHome(i.path);
      if (!p || !insideHome(p) || inLibrary(p) || p === HOME) return { error: 'Only a folder inside your home folder (not Library, not home itself).' };
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return { error: `No folder at ${pretty(p)}.` };
      if (i.stop) return { watching: watch.stop(p) };
      const ok = await confirm({
        title: `Keep ${pretty(p)} tidy`,
        lines: [{ from: 'New images, documents, videos…', to: `${pretty(p)}/Images, /Documents, …` }, { from: 'Existing files', to: 'left where they are' }],
        action: 'Keep it tidy',
      });
      if (!ok) return { declined: true, note: 'The user chose not to.' };
      return { watching: watch.start(p) };
    },
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
