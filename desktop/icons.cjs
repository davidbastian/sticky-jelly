/*
 * Desktop icons get out of the creature's way.
 *
 * macOS gives no app a say over another app's icons, but Finder is scriptable:
 * it will report where every desktop item sits and move one when told to. So
 * when the jelly comes to rest, the renderer sends the rectangles it covers,
 * and every icon under them is moved to the nearest free spot. Where each one
 * came from is remembered, and once the jelly has gone it is put back.
 *
 * Only on rest, never mid-flight: each Finder round trip is tens of
 * milliseconds and icons cannot be animated, so following a flung body would
 * be a desktop that flickers.
 *
 * The moves are real — Finder saves them — so the record of where things came
 * from is kept on disk, and anything still displaced is put back on quit and
 * again on the next launch in case the app did not get to.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');

/* Finder's desktop position is the centre of the icon image. The label hangs
   below it, up to two lines, and is wider than the image. */
const HALF_W = 46;
const ABOVE = 34;
const BELOW = 60;
/* Clear air kept between the body and an icon, in points. */
const MARGIN = 10;

function jxa(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 }, (err, out) => {
      if (err) reject(err);
      else resolve(out.trim() ? JSON.parse(out) : null);
    });
  });
}

const READ = `
  const F = Application('Finder');
  const items = F.desktop.items;
  const o = F.desktop.window.iconViewOptions;
  JSON.stringify({ names: items.name(), pos: items.desktopPosition(), arrangement: o.arrangement() });
`;

function writeScript(moves) {
  return `
    const F = Application('Finder');
    for (const m of ${JSON.stringify(moves)}) {
      try { F.desktop.items.byName(m.name).desktopPosition = { x: m.x, y: m.y }; } catch (e) {}
    }
    '';
  `;
}

const debug = process.env.JELLY_DEBUG ? (...a) => console.log('[icons]', ...a) : () => {};

const footprint = (x, y) => ({ x0: x - HALF_W, y0: y - ABOVE, x1: x + HALF_W, y1: y + BELOW });
const hits = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const inside = (f, area) =>
  f.x0 >= area.x && f.y0 >= area.y && f.x1 <= area.x + area.width && f.y1 <= area.y + area.height;

function createIconMover({ storePath, getArea }) {
  /* name → { ox, oy: where it was; sx, sy: where it was sent } */
  let moved = {};
  try { moved = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { /* first run */ }
  const save = () => {
    try { fs.writeFileSync(storePath, JSON.stringify(moved)); } catch { /* not fatal */ }
  };

  let enabled = true;
  let busy = false;
  /* Only the latest request matters: one that arrives while Finder is busy
     replaces whatever was waiting, which is told it was skipped. */
  let pending = null;
  let warned = false;

  async function arrange(obstacles) {
    debug('avoid', JSON.stringify(obstacles));
    const state = await jxa(READ);
    const { names, pos, arrangement } = state;

    /* Sorted desktops put icons back themselves; fighting it would loop. */
    if (arrangement !== 'not arranged' && arrangement !== 'snap to grid') {
      if (!warned) { warned = true; console.warn(`[icons] desktop is ${arrangement}; leaving it alone`); }
      return;
    }

    const here = new Map();
    names.forEach((n, i) => { if (!here.has(n)) here.set(n, pos[i]); });

    /* Forget anything that was deleted, or that you moved yourself since —
       putting it "back" would undo you. */
    for (const n of Object.keys(moved)) {
      const p = here.get(n);
      if (!p || Math.abs(p.x - moved[n].sx) > 4 || Math.abs(p.y - moved[n].sy) > 4) delete moved[n];
    }

    const blocks = obstacles.map(r => ({
      x0: r.x - MARGIN, y0: r.y - MARGIN, x1: r.x + r.w + MARGIN, y1: r.y + r.h + MARGIN,
    }));
    const blocked = (f) => blocks.some(b => hits(f, b));
    const area = getArea();

    /* Where every icon will end up: displaced ones go home if home is clear. */
    const target = new Map();
    for (const [n, p] of here) {
      const m = moved[n];
      target.set(n, m && !blocked(footprint(m.ox, m.oy)) ? { x: m.ox, y: m.oy } : { x: p.x, y: p.y });
    }

    /* A displaced icon's home stays reserved, so nothing else is parked there. */
    const homes = Object.values(moved).map(m => footprint(m.ox, m.oy));

    for (const [n, t] of target) {
      if (!blocked(footprint(t.x, t.y))) continue;
      const spot = freeSpot(n, t, target, homes, blocked, area);
      if (!spot) continue;
      target.set(n, spot);
    }

    const moves = [];
    for (const [n, t] of target) {
      const p = here.get(n);
      if (t.x === p.x && t.y === p.y) continue;
      moves.push({ name: n, x: t.x, y: t.y });
      const m = moved[n] || (moved[n] = { ox: p.x, oy: p.y });
      if (t.x === m.ox && t.y === m.oy) delete moved[n];
      else { m.sx = t.x; m.sy = t.y; }
    }
    save();
    debug('moving', moves.length);
    if (moves.length) await jxa(writeScript(moves));
  }

  /*
   * The nearest spot that is on screen, clear of the body and clear of every
   * other icon. Searched on a fine lattice anchored at the icon itself, so on
   * a sparse desktop it lands a whole step over and stays in line with its
   * column, and on a crowded one it can still find the gaps.
   */
  function freeSpot(name, from, target, homes, blocked, area) {
    const others = [];
    for (const [n, t] of target) if (n !== name) others.push(footprint(t.x, t.y));
    others.push(...homes);
    const step = 12;
    const cands = [];
    for (let y = area.y + ABOVE + ((from.y - area.y - ABOVE) % step); y + BELOW <= area.y + area.height; y += step) {
      for (let x = area.x + HALF_W + ((from.x - area.x - HALF_W) % step); x + HALF_W <= area.x + area.width; x += step) {
        cands.push({ x, y, d: Math.hypot(x - from.x, y - from.y) });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands) {
      const f = footprint(c.x, c.y);
      if (!inside(f, area) || blocked(f) || others.some(o => hits(f, o))) continue;
      return { x: Math.round(c.x), y: Math.round(c.y) };
    }
    return null;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (pending) {
      const { job, done } = pending;
      pending = null;
      try { await job(); } catch (e) { console.warn('[icons]', e.message); }
      done();
    }
    busy = false;
  }

  function queue(job) {
    return new Promise((done) => {
      if (pending) pending.done();
      pending = { job, done };
      pump();
    });
  }

  return {
    /* Rectangles in screen points, covering the body (and anything else of
       ours that should not sit on icons). */
    avoid(obstacles) {
      if (!enabled) return;
      queue(() => arrange(obstacles));
    },
    /* Everything still displaced goes home. */
    restore() {
      return queue(async () => {
        const moves = Object.entries(moved).map(([name, m]) => ({ name, x: m.ox, y: m.oy }));
        if (moves.length) {
          const { names, pos } = await jxa(READ);
          const here = new Map(names.map((n, i) => [n, pos[i]]));
          /* Only the ones still where we left them. */
          const back = moves.filter(({ name }) => {
            const p = here.get(name), m = moved[name];
            return p && Math.abs(p.x - m.sx) <= 4 && Math.abs(p.y - m.sy) <= 4;
          });
          if (back.length) await jxa(writeScript(back));
        }
        moved = {};
        save();
      });
    },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on;
      if (!on) this.restore();
    },
  };
}

module.exports = { createIconMover };
