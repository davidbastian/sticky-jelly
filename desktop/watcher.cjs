/*
 * Folders the jelly keeps tidy.
 *
 * When asked (and approved), it watches a folder like Downloads and moves
 * each NEW file into a subfolder by type — Images, Documents, Videos, Audio,
 * Archives, Installers, Code — once the file has stopped growing. Files that
 * were already there, folders, hidden files, anything still downloading and
 * types it doesn't know are left alone. Nothing is overwritten (a clash gets
 * " 2"). The list of watched folders is saved, so it carries on after a
 * restart.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KINDS = {
  Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'tif', 'tiff', 'bmp', 'raw', 'avif'],
  Documents: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'md', 'pages', 'odt', 'xls', 'xlsx', 'csv', 'numbers', 'ppt', 'pptx', 'key', 'epub'],
  Videos: ['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm'],
  Audio: ['mp3', 'wav', 'm4a', 'aiff', 'aif', 'flac', 'aac', 'ogg'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  Installers: ['dmg', 'pkg', 'mpkg'],
  Code: ['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'sh', 'swift', 'rb', 'go'],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, exts]) => exts.map(e => [e, k])));
const PARTIAL = /\.(crdownload|download|part|partial|tmp)$/i;

const pretty = (p) => p.replace(os.homedir(), '~');

function freeName(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest), ext = path.extname(dest), base = path.basename(dest, ext);
  for (let i = 2; i < 1000; i++) {
    const p = path.join(dir, `${base} ${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return null;
}

function createWatcher({ load, save, notify }) {
  const watching = new Map();   // folder → { watcher, known: Set, timers: Map }
  let tidied = 0, summaryTimer = null;

  /* One notification for a burst of files, not one each. */
  function report(folder) {
    tidied++;
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
      notify(`Tidied ${tidied} new file${tidied === 1 ? '' : 's'} in ${path.basename(folder)}`);
      tidied = 0;
    }, 20000);
  }

  /* Move a new file once its size has held still for a few seconds. */
  function consider(folder, name) {
    const w = watching.get(folder);
    if (!w || name.startsWith('.') || PARTIAL.test(name) || w.known.has(name)) return;
    const kind = KIND_OF.get(path.extname(name).slice(1).toLowerCase());
    if (!kind) return;
    const file = path.join(folder, name);
    clearTimeout(w.timers.get(name));
    let lastSize = -1;
    const check = () => {
      let st;
      try { st = fs.statSync(file); } catch { w.timers.delete(name); return; }   // gone again
      if (!st.isFile()) return;
      if (st.size !== lastSize) { lastSize = st.size; w.timers.set(name, setTimeout(check, 3000)); return; }
      w.timers.delete(name);
      try {
        const dir = path.join(folder, kind);
        fs.mkdirSync(dir, { recursive: true });
        const dest = freeName(path.join(dir, name));
        if (dest) { fs.renameSync(file, dest); report(folder); }
      } catch { /* leave it be */ }
    };
    w.timers.set(name, setTimeout(check, 1500));
  }

  function start(folder) {
    if (watching.has(folder)) return list();
    let names = [];
    try { names = fs.readdirSync(folder); } catch { return list(); }
    const w = { known: new Set(names), timers: new Map(), watcher: null };
    w.watcher = fs.watch(folder, (_event, name) => {
      if (!name) return;
      // A file that leaves and comes back counts as new.
      if (!fs.existsSync(path.join(folder, name))) { w.known.delete(name); return; }
      consider(folder, name);
    });
    watching.set(folder, w);
    save([...watching.keys()]);
    return list();
  }

  function stop(folder) {
    const w = watching.get(folder);
    if (w) {
      w.watcher.close();
      for (const t of w.timers.values()) clearTimeout(t);
      watching.delete(folder);
      save([...watching.keys()]);
    }
    return list();
  }

  const list = () => [...watching.keys()].map(pretty);

  // Pick up where the last run left off.
  for (const folder of load() || []) if (fs.existsSync(folder)) start(folder);

  return { start, stop, list, folders: () => [...watching.keys()] };
}

module.exports = { createWatcher };
