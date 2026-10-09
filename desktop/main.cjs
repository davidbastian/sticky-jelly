/*
 * The shell: one transparent, frameless, always-on-top window with the jelly
 * in it, and nothing else.
 *
 * The whole trick is click-through. A transparent window still swallows every
 * click that lands on it, so a creature taking up a fifth of the screen would
 * put a dead rectangle over your desktop. Instead the window ignores the mouse
 * by default and the renderer tells it when the cursor is actually on the
 * body — `setIgnoreMouseEvents(true, { forward: true })` keeps move events
 * coming while clicks pass straight through to whatever is behind.
 *
 * Only the body is clickable, so the jelly can sit over your files and you can
 * still use them.
 */
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createIconMover } = require('./icons.cjs');
const { createAssistant } = require('./assistant.cjs');

const DEV_URL = process.env.JELLY_DEV_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

let win = null;
let tray = null;
let icons = null;
let settingsWin = null;
let assistant = null;
/* Kept so the tray can report and toggle it. */
let clickThrough = true;

function setClickThrough(on) {
  if (!win) return;
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    /*
     * The creature needs room to be flung around, so the window is the whole
     * work area rather than a small box: the jelly sticks to the window's
     * edges, and those edges should be the screen's.
     */
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    /* Above ordinary windows but below menus and dialogs, so it never covers
       something you are trying to read. */
    alwaysOnTop: true,
    /* It belongs on whichever desktop you are looking at. */
    visibleOnAllWorkspaces: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      /* A toy at 60fps in the background is a laptop with no battery. The
         renderer is throttled when nothing is on top of it; see jelly.tsx. */
      backgroundThrottling: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  setClickThrough(true);

  if (isDev) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));

  win.on('closed', () => { win = null; });
}

/*
 * A menu-bar item, because a window with no frame and no dock presence is
 * otherwise a thing you cannot quit.
 */
function createTray() {
  /*
   * The same creature in the menu bar, as a template image: black with the
   * eyes punched out, which macOS tints itself — so it is correct in light
   * mode, in dark mode, and while the menu is pulled down. A coloured icon up
   * there would be wrong in two of the three.
   */
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  if (!icon.isEmpty()) icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Sticky Jelly');
  const menu = Menu.buildFromTemplate([
    { label: 'Sticky Jelly', enabled: false },
    { type: 'separator' },
    {
      label: 'Hide',
      click: () => { if (win) (win.isVisible() ? win.hide() : win.show()); },
    },
    { label: 'Settings…', accelerator: 'CommandOrControl+,', click: openSettings },
    { label: 'About Sticky Jelly', click: showAbout },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
}

/*
 * Settings.
 *
 * The jelly window describes its controls once it has built them (with their
 * defaults), the shell lays any saved values over the top and sends those
 * back, and from then on it is the one copy of the truth: the Settings window
 * reads it, changes go through it to the jelly, and it is written to disk a
 * moment after the last change.
 */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let saved = {};
let schema = [];
let defaults = {};

function loadSettings() {
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { saved = {}; }
}
let saveTimer = null;
function writeSettings() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(settingsPath(), JSON.stringify(saved, null, 2)); return true; } catch { return false; }
}
/* Every change is written a moment after the last one; Save writes now. */
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 300);
}
ipcMain.handle('settings:save', () => writeSettings());
function setControl(key, value) {
  for (const sec of schema) for (const c of sec.controls) if (c.key === key) c.value = value;
  win?.webContents.send('jelly:set', key, value);
}

ipcMain.on('jelly:schema', (_e, s) => {
  schema = s;
  defaults = {};
  for (const sec of schema) for (const c of sec.controls) defaults[c.key] = c.value;
  for (const [k, v] of Object.entries(saved)) if (k in defaults) setControl(k, v);
  settingsWin?.webContents.send('settings:schema');
});
ipcMain.handle('settings:get', () => ({
  schema,
  icons: icons.enabled,
  assistant: {
    hasKey: assistant.hasKey(),
    model: saved.__model || assistant.defaultModel,
    models: assistant.models,
  },
}));
ipcMain.handle('settings:key', (_e, key) => {
  if (typeof key !== 'string' || !key.trim()) return false;
  assistant.saveKey(key);
  return true;
});
ipcMain.handle('settings:key-remove', () => { assistant.removeKey(); });
ipcMain.on('settings:model', (_e, model) => {
  if (!assistant.models[model]) return;
  saved.__model = model;
  saveSettings();
});
ipcMain.on('settings:console', () => shell.openExternal('https://console.anthropic.com/settings/keys'));

/*
 * The chat. One turn at a time: text streams back to the jelly window as it
 * arrives, and the call resolves when the reply is done (or failed).
 */
ipcMain.handle('chat:send', (e, text) => {
  if (typeof text !== 'string' || !text.trim()) return { error: 'Nothing to send.' };
  const model = saved.__model || assistant.defaultModel;
  return assistant.send(text, model, (delta) => {
    if (!e.sender.isDestroyed()) e.sender.send('chat:delta', delta);
  });
});
ipcMain.on('chat:stop', () => assistant.stop());
ipcMain.on('chat:reset', () => assistant.reset());
ipcMain.handle('chat:transcript', () => assistant.transcript());
/* The sidebar needs the keyboard; an always-on-top window does not get it
   by itself. */
ipcMain.on('jelly:focus', () => {
  if (!win) return;
  app.focus({ steal: true });
  win.focus();
});
ipcMain.on('settings:set', (_e, key, value) => {
  saved[key] = value;
  setControl(key, value);
  saveSettings();
});
ipcMain.on('settings:icons', (_e, on) => {
  icons.setEnabled(on);
  saved.__moveIcons = on;
  saveSettings();
});
ipcMain.handle('settings:reset', () => {
  for (const [k, v] of Object.entries(defaults)) setControl(k, v);
  saved = { __moveIcons: icons.enabled };
  saveSettings();
});

/* Who made it, in the standard About panel. */
const AUTHOR = { name: 'David Bastian', url: 'https://davidbastian.black', email: 'd@davidbastian.red' };
function showAbout() {
  app.setAboutPanelOptions({
    applicationName: 'Sticky Jelly',
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} ${AUTHOR.name}`,
    credits: `Made by ${AUTHOR.name}\n${AUTHOR.url.replace('https://', '')}\n${AUTHOR.email}`,
    website: AUTHOR.url,
    authors: [AUTHOR.name],
  });
  app.focus({ steal: true });
  app.showAboutPanel();
}

/* A real window, with a title bar and a close button, like any app's. */
function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); app.focus({ steal: true }); return; }
  settingsWin = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 520,
    minHeight: 400,
    title: 'Sticky Jelly Settings',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    backgroundColor: '#00000000',
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  /* Above the jelly, which floats above everything else. */
  settingsWin.setAlwaysOnTop(true, 'floating', 1);
  if (isDev) settingsWin.loadURL(new URL('settings.html', DEV_URL.replace(/index\.html$/, '')).href);
  else settingsWin.loadFile(path.join(__dirname, '../dist/settings.html'));
  settingsWin.once('ready-to-show', () => { settingsWin.show(); app.focus({ steal: true }); });
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* The menu bar while the Settings window is in front: ⌘, and the edit keys. */
function createAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: 'About Sticky Jelly', click: showAbout },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(() => {
  /*
   * The dock icon is the creature on its red ground — the same mark the menu
   * bar carries, drawn once in assets/make-icons.py.
   *
   * In the packaged app the icon comes from the bundle; running from source
   * there is no bundle, so it is set by hand or the dock shows Electron's.
   */
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
  loadSettings();
  assistant = createAssistant({ keyPath: path.join(app.getPath('userData'), 'anthropic-key.bin') });
  icons = createIconMover({
    storePath: path.join(app.getPath('userData'), 'displaced-icons.json'),
    getArea: () => screen.getPrimaryDisplay().workArea,
  });
  if (saved.__moveIcons === false) icons.setEnabled(false);
  /* Anything a previous run left displaced — a crash, a force quit. */
  icons.restore();
  createAppMenu();
  createWindow();
  createTray();
});

/* Icons go home before the app goes. */
let restored = false;
app.on('before-quit', (e) => {
  if (restored) return;
  e.preventDefault();
  restored = true;
  icons.restore().finally(() => app.quit());
});

/* The renderer is the only thing that knows where the body is. */
ipcMain.on('jelly:hover', (_e, over) => setClickThrough(!over));

/* Page CSS px are screen points offset by where the window sits. */
ipcMain.on('jelly:rest', (_e, rects) => {
  if (!win || !win.isVisible() || !Array.isArray(rects)) return;
  const b = win.getBounds();
  icons.avoid(rects.map(r => ({ x: r.x + b.x, y: r.y + b.y, w: r.w, h: r.h })));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
