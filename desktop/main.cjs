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
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

const DEV_URL = process.env.JELLY_DEV_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

let win = null;
let tray = null;
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
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
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
  createWindow();
  createTray();
});

/* The renderer is the only thing that knows where the body is. */
ipcMain.on('jelly:hover', (_e, over) => setClickThrough(!over));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
