/*
 * Records the animated demos in the README.
 *
 *   npm run demo        (builds the page first)
 *
 * Runs the real page in off-screen windows — nothing appears on screen and no
 * keyboard is taken — drives it with scripted pointer and keyboard input, and
 * captures frames at a steady rate into ffmpeg, which writes media/*.gif. The
 * shell is replaced by scripts/demo/preload.cjs: scripted replies, a pretend
 * microphone, no API calls.
 *
 * It plays on a real desktop: backdrop.jpg is a frame of one (menu bar, Dock
 * and all), and the jelly is kept between the two the way the app's window
 * is kept to the work area. The jelly is its own black. Needs ffmpeg.
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
/*
 * Three optional overrides, all defaulting to what this script always did:
 *
 *   DEMO_OUT      write somewhere other than media/
 *   DEMO_GROUND   a flat colour behind the scenes instead of the backdrop,
 *                 for recordings that go on a page rather than in the README
 *   DEMO_ONLY     a comma-separated list of scenes to keep
 *   DEMO_KEEP_MP4 also keep the h264 the GIF is made from
 */
const OUT = process.env.DEMO_OUT ? path.resolve(process.env.DEMO_OUT) : path.join(ROOT, 'media');
const ONLY = (process.env.DEMO_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const KEEP_MP4 = !!process.env.DEMO_KEEP_MP4;
const TMP = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jelly-demo-'));
const FPS = 30;
const W = 960, H = 624;                    // the backdrop's proportions
const MENU = 22, DOCK = 36;                // what the work area leaves out, in page px
const BACKDROP = `url("${path.join(__dirname, 'backdrop.jpg').replace(/"/g, '\\"')}")`;
/* What sits behind a scene: the photographed desktop, or a flat colour. */
const GROUND = process.env.DEMO_GROUND
  ? `${process.env.DEMO_GROUND}`
  : `#000 ${BACKDROP} center / cover no-repeat`;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
nativeTheme.themeSource = 'dark';
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let lastRest = null;
let schema = [];
let jellyWin = null;
ipcMain.on('demo:rest', (_e, rects) => { lastRest = rects[0]; });
ipcMain.on('demo:schema', (_e, s) => { schema = s; });
ipcMain.handle('demo:settings-get', () => ({
  schema,
  icons: true,
  assistant: {
    hasKey: true,
    model: 'claude-haiku-5-5',
    models: { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5' },
    speak: true,
  },
}));
ipcMain.on('demo:settings-set', (_e, key, value) => {
  jellyWin?.webContents.executeJavaScript(`window.demo.set(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
});

function offscreen(width, height, preload, page, { transparent = false } = {}) {
  const win = new BrowserWindow({
    width, height, show: false, transparent, backgroundColor: transparent ? '#00000000' : '#000000',
    webPreferences: { offscreen: true, preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(FPS);
  win.webContents.setAudioMuted(true);   // the chat makes sounds now; a demo run should not
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.error('[page]', message); });
  let frame = null;
  win.webContents.on('paint', (_e, _dirty, image) => { frame = image; });
  win.latest = () => frame;
  win.loadFile(path.join(ROOT, 'dist', page));
  return win;
}

/*
 * Grab whatever was last painted, FPS times a second, whether or not the page
 * changed — so still moments keep their real length — and pipe it to ffmpeg.
 */
/* alpha: keep the page's transparency (lossless, with alpha) through to a
   GIF with a see-through background. width: the GIF's width. */
function record(win, name, { alpha = false, width = 800 } = {}) {
  const size = win.getContentSize();
  const mp4 = path.join(TMP, `${name}.${alpha ? 'mkv' : 'mp4'}`);
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${size[0]}x${size[1]}`, '-r', String(FPS), '-i', '-',
    ...(alpha ? ['-c:v', 'ffv1', '-pix_fmt', 'bgra'] : ['-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv444p']), mp4,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const timer = setInterval(() => {
    const img = win.latest();
    if (!img) return;
    const s = img.getSize();
    if (s.width !== size[0] || s.height !== size[1]) return;
    ff.stdin.write(img.toBitmap());
  }, 1000 / FPS);
  return async () => {
    clearInterval(timer);
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
    await gif(mp4, path.join(OUT, `${name}.gif`), width, alpha);
    console.log('wrote', `media/${name}.gif`);
  };
}

/* A photo behind it: a full palette, and an ordered dither that stays put
   from frame to frame so only what moves is re-encoded. */
function gif(src, dest, width = 800, alpha = false) {
  const pal = alpha ? ':reserve_transparent=1' : '';
  /* With transparency every GIF frame is stored whole, so repeated frames
     are dropped (mpdecimate) and the ones kept are held for their time. */
  const thin = alpha ? 'mpdecimate,' : '';
  const use = alpha ? ':alpha_threshold=128' : '';
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', src,
      '-vf', `fps=20,${thin}scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full${pal}[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle${use}`,
      ...(alpha ? ['-fps_mode', 'vfr'] : []),
      '-loop', '0', dest,
    ], { stdio: 'inherit' });
    ff.on('close', code => (code ? reject(new Error(`ffmpeg ${code}`)) : resolve()));
  });
}

/* Pointer input, in page CSS px. */
const mouse = (win, type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
async function drag(win, from, to, ms, steps = 24) {
  mouse(win, 'mouseMove', from.x, from.y);
  mouse(win, 'mouseDown', from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    mouse(win, 'mouseMove', from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await wait(ms / steps);
  }
  mouse(win, 'mouseUp', to.x, to.y);
}
/* Rest rects are relative to the jelly's canvas, which starts under the menu bar. */
const center = () => ({ x: lastRest.x + lastRest.w / 2, y: MENU + lastRest.y + lastRest.h / 2 });
async function settle(timeout = 6000) {
  lastRest = null;
  const t0 = Date.now();
  while (!lastRest && Date.now() - t0 < timeout) await wait(50);
}
const js = (win, code) => win.webContents.executeJavaScript(code);

/* Type into the chat composer the way a person would, a letter at a time. */
async function typeInto(win, text) {
  for (let i = 1; i <= text.length; i++) {
    await js(win, `(() => { const t = document.querySelector('.jelly-chat textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text.slice(0, i))}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(45);
  }
}
const pressEnter = (win) => js(win, `document.querySelector('.jelly-chat textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);

async function jellyWindow() {
  const win = offscreen(W, H, path.join(__dirname, 'preload.cjs'), 'index.html');
  jellyWin = win;
  await new Promise(r => win.webContents.once('did-finish-load', r));
  /* The desktop behind it, and the jelly kept to the work area. */
  await win.webContents.insertCSS(`
    html, body { background: ${GROUND} !important; }
    #root { position: fixed !important; top: ${MENU}px; left: 0; right: 0; bottom: ${DOCK}px; height: auto !important; }
    #root > div:first-child { width: 100% !important; height: 100% !important; }
  `);
  await wait(300);
  return win;
}

/* `electron record.cjs settings` records only the scenes named; none, all. */
const only = process.argv.slice(2).filter(a => !a.startsWith('-') && !a.endsWith('.cjs'));
const want = (scene) => !only.length || only.includes(scene);

async function main() {
  let win, stop, c;

  if (want('fling')) {
    // 1 — fling: grab it off the floor, throw it at a wall, pull it off again.
    win = await jellyWindow();
    await settle();
    stop = record(win, 'fling');
    await wait(600);
    c = center();
    await drag(win, c, { x: c.x - 120, y: c.y - 260 }, 700);
    await drag(win, { x: c.x - 120, y: c.y - 260 }, { x: 80, y: 180 }, 220, 8);   // the throw
    await wait(1400);
    await settle(3000);
    c = center();
    await drag(win, c, { x: c.x + 330, y: c.y + 40 }, 1100);                         // peel it off
    await wait(1800);
    await stop();
    win.destroy();
  }

  if (want('chat')) {
    // 2 — hold: it winds itself up, dizzy, and bursts into the sidebar.
    win = await jellyWindow();
    await settle();
    await wait(400);
    stop = record(win, 'hold');
    await wait(500);
    c = center();
    mouse(win, 'mouseMove', c.x, c.y);
    mouse(win, 'mouseDown', c.x, c.y);
    await wait(900);
    mouse(win, 'mouseUp', c.x, c.y);
    await wait(2600);
    await stop();

    // 3 — chat: type, send, a reply with an action the body acts out.
    stop = record(win, 'chat');
    await wait(400);
    await typeInto(win, 'Tell me a jelly joke');
    await wait(300);
    await pressEnter(win);
    await wait(4600);
    await stop();

    // 4 — voice: press the mic, talk, it sends on the pause and answers.
    stop = record(win, 'voice');
    await wait(400);
    await js(win, `document.querySelector('.jelly-chat [aria-label="Talk"]').click()`);
    await wait(7600);
    await stop();
    win.destroy();
  }

  if (want('shapes')) {
    // 5 — shapes and colours: the blob, then the worm, through the palette.
    win = await jellyWindow();
    await settle();
    stop = record(win, 'shapes');
    await wait(500);
    for (const col of ['#f53d3d', '#f5a83c', '#2a22b8', '#0e0e10']) {
      await js(win, `window.demo.set('blobColor', '${col}')`);
      await wait(900);
    }
    await js(win, `window.demo.set('shape', 'Worm')`);
    for (const col of ['#f53d3d', '#0e0e10']) {
      await wait(1300);
      await js(win, `window.demo.set('blobColor', '${col}')`);
    }
    await wait(1200);
    await stop();
    win.destroy();
  }

  if (want('settings')) {
    // 6 — settings: just the window — rounded, with its traffic lights, on a
    // see-through background — its sections down the side, the assistant's key.
    // The controls come from a jelly describing itself; borrow one if this
    // scene runs on its own.
    if (!schema.length) { const j = await jellyWindow(); await wait(800); j.destroy(); }
    jellyWin = null;
    const sw = offscreen(640, 440, path.join(__dirname, 'settings-preload.cjs'), 'settings.html', { transparent: true });
    await new Promise(r => sw.webContents.once('did-finish-load', r));
    await sw.webContents.insertCSS(`
      /* An invisible image on the root stops the body's background from
       spreading to the whole page, so the corners stay see-through. */
      html { background: linear-gradient(transparent, transparent) !important; height: 100%; }
      body {
        position: relative; height: 100%;
        background: #1e1e1e !important; border-radius: 12px;
        clip-path: inset(0 round 12px);   /* overflow on body clips nothing: it goes to the viewport */
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12);
      }
      nav { background: #2a2a2c; }
      body::before {
        content: ''; position: absolute; top: 18px; left: 18px; width: 12px; height: 12px; border-radius: 50%;
        background: #ff5f57; box-shadow: 20px 0 #febc2e, 40px 0 #28c840; z-index: 5;
      }
    `);
    await wait(600);
    stop = record(sw, 'settings', { alpha: true, width: 640 });
    const nav = (label) => js(sw, `[...document.querySelectorAll('nav button')].find(b => b.textContent.endsWith(${JSON.stringify(label)}))?.click()`);
    await wait(700);
    // Drag the first slider across and back.
    await js(sw, `(async () => {
      const r = document.querySelector('input[type=range]');
      const from = Number(r.value), max = Number(r.max), min = Number(r.min);
      const go = (v) => { r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); };
      for (let i = 0; i <= 20; i++) { go(from + (max - from) * 0.6 * (i / 20)); await new Promise(z => setTimeout(z, 30)); }
      for (let i = 20; i >= 0; i--) { go(from + (max - from) * 0.6 * (i / 20)); await new Promise(z => setTimeout(z, 30)); }
    })()`);
    await wait(500);
    for (const s of ['Sticky', 'Body', 'Face', 'Sound']) { await nav(s); await wait(800); }
    await nav('Assistant');
    await wait(2200);
    await nav('Desktop');
    await wait(1200);
    await stop();
    sw.destroy();
  }

  // The icon, small, for the README header.
  await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(ROOT, 'assets/icon.png'), '-vf', 'scale=256:-1', path.join(OUT, 'icon.png')], { stdio: 'inherit' })
    .on('close', code => (code ? rej(new Error('icon')) : res())));
  console.log('wrote media/icon.png');
}

/* Scenes close their window before the next opens; that is not the end. */
app.on('window-all-closed', () => {});
app.whenReady().then(main).then(() => app.quit(), (err) => { console.error(err); app.exit(1); });
