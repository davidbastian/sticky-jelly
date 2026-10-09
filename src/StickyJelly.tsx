import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import GUI from 'lil-gui';

// A flat black jelly creature — soft-body verlet points you can grab, stretch
// and fling. It clings to the canvas edges and corners like a sticky-hand toy,
// peeling off point by point when the pull gets too strong. Googly eyes track
// the cursor with springy inertia; every few seconds it changes mood — teeth,
// arcs of extra eyes, a cyclops, sleepy lids, a surprised O (after the
// black-blob poster references).
//
// Two body shapes: 'Blob' (pressurised ring) and 'Worm' (thick rope that
// slinks and stretches like a snake). Physics is a CPU verlet sim; rendering
// is WebGL (Three.js, orthographic, flat colors): the outline is rebuilt and
// re-triangulated into a BufferGeometry every frame, the face is a pool of
// circle/triangle meshes. Web Audio adds splats on stick, pops on peel and a
// rubber creak while the body is stretched.

interface Pt {
  x: number; y: number;      // current position
  px: number; py: number;    // previous position (verlet)
  stuck: boolean;
  ax: number; ay: number;    // stick anchor
  cd: number;                // re-stick cooldown (steps) after peeling
}

/*
 * `transparent` and `onHover` exist for the desktop build and change nothing
 * on the site.
 *
 * On the page the creature lives on a coloured ground, which is the study. On
 * a desktop it has to live on your wallpaper, so the clear colour goes and the
 * canvas keeps its alpha — the jelly is then the only thing drawn, and the
 * window behind it can be see-through.
 *
 * `onHover` is how the shell knows whether the cursor is on the creature or on
 * the desktop behind it. Only this file can answer that: the body is a verlet
 * outline that moves every frame, so a rectangle would be wrong the moment it
 * stretched. It reports on pointer move and the shell turns click-through on
 * and off with it.
 *
 * `onRest` reports what the creature covers once it has stopped moving — its
 * bounding box — so the shell can move desktop icons out from underneath.
 * Never mid-flight: only after the body has held within a few pixels for a
 * moment.
 *
 * `onSettings` hands the shell a description of every control and a way to
 * set one, so settings can live in a window of their own.
 *
 * `onSidebar` / `sidebarRef` are the long-press: hold still on the body and it
 * stretches up the nearer side of the screen into a tall panel, face in the
 * middle, for the page to put a chat on. Still a soft body the whole time —
 * every point is pulled toward the panel's outline by a spring rather than
 * placed on it, so it stretches into shape and keeps wobbling there.
 */
interface Props {
  viewMode?: string;
  canvasRounded?: boolean;
  canvasShadow?: boolean;
  transparent?: boolean;
  onHover?: (over: boolean) => void;
  onRest?: (rects: Rect[]) => void;
  onSettings?: (bridge: SettingsBridge) => (() => void) | void;
  onSidebar?: (state: SidebarState | null) => void;
  sidebarRef?: MutableRefObject<SidebarControl | null>;
}

/* Where the sidebar formed, in CSS px, and the body colour to draw on. */
/* `below` is the strip left free under the body, where the composer drips to. */
export interface SidebarState {
  x: number; y: number; w: number; h: number; below: number;
  side: 'left' | 'right'; color: string;
}
export interface SidebarControl {
  dismiss: () => void;
  /* Face in the middle while the chat is empty, up top once it has content. */
  setFaceTop: (top: boolean) => void;
  /* Its mouth chatters while a reply streams in. */
  setTalking: (on: boolean) => void;
  /* Do something with its body — what the assistant writes as *wiggles*. */
  act: (kind: JellyAction) => void;
}

export type JellyAction = 'wiggle' | 'bounce' | 'blush' | 'spin' | 'shiver' | 'melt';

/* Which of its moves an action written by the assistant means. */
export function actionKind(text: string): JellyAction {
  const t = text.toLowerCase();
  if (/bounc|hop|jump|boing/.test(t)) return 'bounce';
  if (/blush|flush|pink/.test(t)) return 'blush';
  if (/spin|twirl|dizzy|roll/.test(t)) return 'spin';
  if (/shiver|shudder|trembl|shake|quiver/.test(t)) return 'shiver';
  if (/melt|droop|sag|flop|puddle|sigh/.test(t)) return 'melt';
  return 'wiggle';
}

const ACT_LEN: Record<JellyAction, number> = {
  wiggle: 1.1, bounce: 0.6, blush: 1.8, spin: 1.4, shiver: 0.9, melt: 1.6,
};

export type Control =
  | { key: string; label: string; kind: 'number'; value: number; min: number; max: number; step: number }
  | { key: string; label: string; kind: 'boolean'; value: boolean }
  | { key: string; label: string; kind: 'option'; value: string; options: string[] }
  | { key: string; label: string; kind: 'color'; value: string };

export interface SettingsBridge {
  schema: { title: string; controls: Control[] }[];
  set: (key: string, value: unknown) => void;
}

/* lil-gui keeps its ranges on underscored fields; read them once here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(c: any): Control {
  const base = { key: c.property as string, label: c._name as string };
  const cls = c.domElement.classList;
  if (cls.contains('boolean')) return { ...base, kind: 'boolean', value: c.getValue() };
  if (cls.contains('option')) return { ...base, kind: 'option', value: c.getValue(), options: c._values };
  if (cls.contains('color')) return { ...base, kind: 'color', value: c.getValue() };
  return { ...base, kind: 'number', value: c.getValue(), min: c._min, max: c._max, step: c._step };
}

/* CSS px, relative to the page. */
export interface Rect { x: number; y: number; w: number; h: number }

const PALETTES: Record<string, string> = {
  Red:    '#f53d3d',
  Orange: '#f5a83c',
  Blue:   '#2a22b8',
};

type Mood = 'classic' | 'toothy' | 'manyEyes' | 'cyclops' | 'sleepy' | 'surprised' | 'twins';

const SUBDIV = 6;      // smoothed outline samples per soft-body point (blob)
const CAP = 7;         // outline samples per rounded worm end-cap
const MAX_EYES = 9;
const MAX_TEETH = 8;

export default function StickyJellyProject({
  viewMode, canvasRounded, canvasShadow, transparent = false, onHover, onRest, onSettings,
  onSidebar, sidebarRef,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  /* Held in a ref so the effect can call the latest one without re-running:
     the whole simulation is built in that effect and must not restart. */
  const hover = useRef(onHover);
  hover.current = onHover;
  const rest = useRef(onRest);
  rest.current = onRest;
  const settings = useRef(onSettings);
  settings.current = onSettings;
  const sidebarCb = useRef(onSidebar);
  sidebarCb.current = onSidebar;

  useEffect(() => {
    const mount = mountRef.current!;
    const dpr = Math.min(devicePixelRatio, 2);

    // ── Renderer / scene ─────────────────────────────────────────────────────
    // Physics runs in device pixels; the buffer is sized to match 1:1
    // (pixelRatio 1) and an orthographic camera maps world units = pixels,
    // y down, so sim coordinates render without any conversion.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent });
    renderer.setPixelRatio(1);
    if (transparent) renderer.setClearAlpha(0);
    renderer.domElement.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab;';
    mount.appendChild(renderer.domElement);
    const canvas = renderer.domElement;

    const scene = new THREE.Scene();
    /* No ground on the desktop: the wallpaper is the ground. */
    scene.background = transparent ? null : new THREE.Color(PALETTES.Red);
    const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 100);
    camera.position.z = 10;

    let W = 1, H = 1, animId = 0;
    const onResize = () => {
      const r = mount.getBoundingClientRect();
      W = Math.round(r.width  * dpr);
      H = Math.round(r.height * dpr);
      renderer.setSize(W, H, false); // keep the CSS 100% sizing
      camera.right  = W;
      camera.bottom = H;
      camera.updateProjectionMatrix();
      rebuild(); // body size derives from the canvas — rescale with it
    };
    // Observer wired up after rebuild() exists (it's referenced above but
    // only ever called once both are defined).
    const obs = new ResizeObserver(onResize);

    // ── Config / GUI ─────────────────────────────────────────────────────────
    const cfg = {
      // Physics
      gravity:      2140,
      damping:      0.954,
      elasticity:   0.05,  // spring stiffness along the outline/spine
      stretchiness: 0,     // how much the body yields when pulled past rest length
      squish:       0,     // radial (shape-memory) stiffness — low = gooier (blob)
      bend:         0.97,  // bending resistance between skip-one neighbours
      pressure:     0.55,  // inflation back toward rest area (blob)
      iterations:   6,
      wobble:       2.5,   // idle jitter so it always feels alive
      breathe:      0.02,  // slow rest-radius pulse (blob)
      // Sticky
      sticky:        true,
      stickiness:    12,   // peel threshold (px) — how hard a point holds on
      stickDistance: 8,    // how close to an edge before it grabs on
      cornerBoost:   6,    // corners are extra sticky
      contactGive:   0.25, // how much a stuck point visibly strains before peeling
      friction:      0.5,  // tangential drag while touching (not stuck to) an edge
      restickDelay:  0.08, // seconds a peeled point stays free before it can re-grab
      // Body
      shape:      'Blob', // 'Blob' | 'Worm'
      size:       0.185,  // blob radius as fraction of min canvas dimension
      wormLength: 0.9,    // worm length as fraction of min canvas dimension
      thickness:  0.05,   // worm half-thickness as fraction of min canvas dimension
      points:     48,
      blobColor:  '#0e0e10',
      // Face
      eyeSize:    0.05,  // fraction of the face reference radius
      pupilSize:  0.45,  // fraction of eye radius
      eyeSpacing: 0.35,
      eyeHeight:  0,
      lookRange:  0.42,  // pupil travel as fraction of eye radius
      googlyness: 0.55,  // pupil spring looseness — high = wobbly googly eyes
      blinkEvery: 4,
      faceJiggle: 1.0,
      // Moods
      moodEvery:       6,
      mouthChance:     0.85,
      manyEyesChance:  0.3,
      cyclopsChance:   0.15,
      sleepyChance:    0.1,
      surprisedChance: 0.1,
      twinsChance:     0.35, // worm only — eyes at both ends
      extraEyes:       6,
      teeth:           5,
      // Look
      palette: 'Red',
      bgColor: PALETTES.Red,
      // Throw
      throwPower: 1.0,
      grabRadius: 90,
      // Sound
      sndOn:           true,
      sndVolume:       0.37,
      sndStretchStyle: 'Bubbles', // 'Creak' | 'Rubber' | 'Bubbles' | 'Zipper'
      sndDrag:         0,         // stretch loudness while the body is pulled
      sndStickStyle:   'Wet',     // 'Wet' | 'Thud' | 'Slap' | 'Boing'
      sndStick:        0,         // splat when points slap onto an edge
      sndPeelStyle:    'Pop',     // 'Pop' | 'Tick' | 'Pluck' | 'Velcro'
      sndPeel:         0.5,       // pop when points peel off
    };

    const isWorm = () => cfg.shape === 'Worm';

    const guiContainer = document.getElementById('gui-project');
    if (guiContainer) guiContainer.innerHTML = '';
    const gui = new GUI({ title: 'Sticky Jelly', container: guiContainer || undefined });

    /*
     * On the desktop the panel is never shown: settings live in a real
     * Settings window the shell opens. The panel is still built, because every
     * controller is wired to the same cfg the simulation reads and carries the
     * onChange that applies it — so the window drives these controllers by
     * property (`onSettings`), and a slider there behaves exactly like one
     * here, rebuilds included.
     */
    if (transparent) gui.domElement.style.display = 'none';

    const fPhys = gui.addFolder('Physics');
    fPhys.add(cfg, 'gravity',      0, 4000, 10).name('Gravity');
    fPhys.add(cfg, 'damping',      0.9, 1, 0.001).name('Damping');
    fPhys.add(cfg, 'elasticity',   0.05, 1, 0.01).name('Elasticity');
    fPhys.add(cfg, 'stretchiness', 0, 0.9, 0.01).name('Stretchiness');
    fPhys.add(cfg, 'squish',       0, 1, 0.01).name('Shape Memory');
    fPhys.add(cfg, 'bend',         0, 1, 0.01).name('Bend Resist');
    fPhys.add(cfg, 'pressure',     0, 2, 0.01).name('Pressure');
    fPhys.add(cfg, 'iterations',   1, 12, 1).name('Solver Iterations');
    fPhys.add(cfg, 'wobble',       0, 20, 0.1).name('Idle Wobble');
    fPhys.add(cfg, 'breathe',      0, 0.1, 0.001).name('Breathe');

    const fStick = gui.addFolder('Sticky');
    fStick.add(cfg, 'sticky').name('Sticky Edges').onChange((v: boolean) => {
      if (!v) pts.forEach(p => { p.stuck = false; });
    });
    fStick.add(cfg, 'stickiness',    0.5, 60, 0.5).name('Stickiness (Peel)');
    fStick.add(cfg, 'stickDistance', 1, 30, 1).name('Stick Distance');
    fStick.add(cfg, 'cornerBoost',   1, 6, 0.1).name('Corner Boost');
    fStick.add(cfg, 'contactGive',   0, 0.9, 0.01).name('Contact Give');
    fStick.add(cfg, 'friction',      0, 1, 0.01).name('Edge Friction');
    fStick.add(cfg, 'restickDelay',  0, 0.5, 0.01).name('Re-stick Delay (s)');

    const fBody = gui.addFolder('Body');
    fBody.add(cfg, 'shape', ['Blob', 'Worm']).name('Shape').onChange(() => rebuild());
    fBody.add(cfg, 'size',       0.08, 0.35, 0.005).name('Blob Size').onChange(() => rebuild());
    fBody.add(cfg, 'wormLength', 0.3, 1.5, 0.01).name('Worm Length').onChange(() => { if (isWorm()) rebuild(); });
    fBody.add(cfg, 'thickness',  0.02, 0.12, 0.002).name('Worm Thickness').onChange(() => { if (isWorm()) rebuild(); });
    fBody.add(cfg, 'points',     10, 64, 1).name('Points').onChange(() => rebuild());
    fBody.addColor(cfg, 'blobColor').name('Body Color');

    const fFace = gui.addFolder('Face');
    fFace.add(cfg, 'eyeSize',    0.02, 0.3, 0.005).name('Eye Size');
    fFace.add(cfg, 'pupilSize',  0.15, 0.8, 0.01).name('Pupil Size');
    fFace.add(cfg, 'eyeSpacing', 0.1, 0.9, 0.01).name('Eye Spacing');
    fFace.add(cfg, 'eyeHeight',  -0.3, 0.6, 0.01).name('Eye Height');
    fFace.add(cfg, 'lookRange',  0, 0.6, 0.01).name('Look Range');
    fFace.add(cfg, 'googlyness', 0, 1, 0.01).name('Googlyness');
    fFace.add(cfg, 'blinkEvery', 1, 12, 0.5).name('Blink Every (s)');
    fFace.add(cfg, 'faceJiggle', 0, 3, 0.05).name('Face Jiggle');

    const fMood = gui.addFolder('Moods');
    fMood.add(cfg, 'moodEvery',       1, 20, 0.5).name('Change Every (s)');
    fMood.add(cfg, 'mouthChance',     0, 1, 0.05).name('Mouth Chance');
    fMood.add(cfg, 'manyEyesChance',  0, 1, 0.05).name('Many-Eyes Chance');
    fMood.add(cfg, 'cyclopsChance',   0, 1, 0.05).name('Cyclops Chance');
    fMood.add(cfg, 'sleepyChance',    0, 1, 0.05).name('Sleepy Chance');
    fMood.add(cfg, 'surprisedChance', 0, 1, 0.05).name('Surprised Chance');
    fMood.add(cfg, 'twinsChance',     0, 1, 0.05).name('Twins (Worm)');
    fMood.add(cfg, 'extraEyes',       3, MAX_EYES, 1).name('Extra Eyes');
    fMood.add(cfg, 'teeth',           3, MAX_TEETH, 1).name('Teeth');

    const fLook = gui.addFolder('Look');
    const bgCtrl = fLook.addColor(cfg, 'bgColor').name('Background');
    fLook.add(cfg, 'palette', ['Red', 'Orange', 'Blue']).name('Palette').onChange((v: string) => {
      cfg.bgColor = PALETTES[v];
      bgCtrl.updateDisplay();
    });
    /* No ground on the desktop, so nothing here to set. */
    if (transparent) fLook.hide();

    const fThrow = gui.addFolder('Throw');
    fThrow.add(cfg, 'throwPower', 0, 3, 0.05).name('Throw Power');
    fThrow.add(cfg, 'grabRadius', 20, 300, 5).name('Grab Radius');

    const fSnd = gui.addFolder('Sound');
    fSnd.add(cfg, 'sndOn').name('Sound');
    fSnd.add(cfg, 'sndVolume', 0, 1, 0.01).name('Master Volume');
    fSnd.add(cfg, 'sndStretchStyle', ['Creak', 'Rubber', 'Bubbles', 'Zipper']).name('Stretch Style');
    fSnd.add(cfg, 'sndDrag',   0, 1, 0.01).name('Stretch Volume');
    fSnd.add(cfg, 'sndStickStyle', ['Wet', 'Thud', 'Slap', 'Boing']).name('Splat Style');
    fSnd.add(cfg, 'sndStick',  0, 1, 0.01).name('Splat Volume');
    fSnd.add(cfg, 'sndPeelStyle', ['Pop', 'Tick', 'Pluck', 'Velcro']).name('Peel Style');
    fSnd.add(cfg, 'sndPeel',   0, 1, 0.01).name('Peel Volume');

    const controllers = new Map(gui.controllersRecursive().map(c => [c.property, c]));
    const unbindSettings = settings.current?.({
      schema: gui.folders.filter(f => !f._hidden).map(f => ({
        title: f._title,
        controls: f.controllers.map(describe),
      })),
      set: (key, value) => controllers.get(key)?.setValue(value),
    });

    // ── Soft body ────────────────────────────────────────────────────────────
    let pts: Pt[] = [];
    let restR = 0;          // blob rest radius (device px)
    let restEdge = 0;       // rest length between adjacent points / spine segments
    let restArea = 0;       // blob rest area
    let thickR = 0;         // worm half-thickness (device px)
    let thickGoal = 0;      // what thickR eases toward (the sidebar fattens the worm)

    const centroid = () => {
      let cx = 0, cy = 0;
      for (const p of pts) { cx += p.x; cy += p.y; }
      return { x: cx / pts.length, y: cy / pts.length };
    };

    const polyArea = () => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        a += p.x * q.y - q.x * p.y;
      }
      return Math.abs(a) / 2;
    };

    // ── Body mesh — outline rebuilt + retriangulated in place each frame ────
    // DoubleSide everywhere: the y-down camera flips triangle winding, so
    // front-side-only materials would backface-cull the whole flat scene.
    const bodyMat = new THREE.MeshBasicMaterial({ color: cfg.blobColor, side: THREE.DoubleSide });
    const bodyMesh = new THREE.Mesh(new THREE.BufferGeometry(), bodyMat);
    bodyMesh.frustumCulled = false;
    scene.add(bodyMesh);
    let outline: THREE.Vector2[] = [];

    const allocBodyGeometry = (M: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * 3), 3));
      geo.setIndex(new THREE.BufferAttribute(new Uint16Array((M - 2) * 3), 1));
      bodyMesh.geometry.dispose();
      bodyMesh.geometry = geo;
      outline = Array.from({ length: M }, () => new THREE.Vector2());
    };

    const triangulateOutline = () => {
      const M = outline.length;
      const pos = bodyMesh.geometry.attributes.position as THREE.BufferAttribute;
      for (let j = 0; j < M; j++) pos.setXYZ(j, outline[j].x, outline[j].y, 0);
      pos.needsUpdate = true;

      const tris = THREE.ShapeUtils.triangulateShape(outline, []);
      const index = bodyMesh.geometry.index as THREE.BufferAttribute;
      const arr = index.array as Uint16Array;
      let k = 0;
      for (const t of tris) {
        if (k + 3 > arr.length) break;
        arr[k++] = t[0]; arr[k++] = t[1]; arr[k++] = t[2];
      }
      // Degenerate padding if the (self-intersecting) outline dropped triangles
      while (k < arr.length) arr[k++] = 0;
      index.needsUpdate = true;
    };

    const updateBlobGeometry = () => {
      const n = pts.length;
      // Same quadratic smoothing as a canvas path: each point is the control,
      // segment endpoints are the midpoints to its neighbours.
      let j = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[(i + n - 1) % n], c = pts[i], b = pts[(i + 1) % n];
        const sx = (a.x + c.x) / 2, sy = (a.y + c.y) / 2;
        const ex = (c.x + b.x) / 2, ey = (c.y + b.y) / 2;
        for (let s = 1; s <= SUBDIV; s++) {
          const t = s / SUBDIV, u = 1 - t;
          outline[j++].set(
            u * u * sx + 2 * u * t * c.x + t * t * ex,
            u * u * sy + 2 * u * t * c.y + t * t * ey,
          );
        }
      }
      triangulateOutline();
    };

    const updateWormGeometry = () => {
      const n = pts.length;
      // Thick-stroke outline: offset the spine sideways by the half-thickness,
      // walk down the left flank, around the tail cap, back up the right
      // flank and around the head cap.
      let j = 0;
      const nx: number[] = [], ny: number[] = [], tx: number[] = [], ty: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        tx[i] = dx / d; ty[i] = dy / d;
        nx[i] = -ty[i]; ny[i] = tx[i];
      }
      for (let i = 0; i < n; i++) outline[j++].set(pts[i].x + nx[i] * thickR, pts[i].y + ny[i] * thickR);
      // Tail cap: half-circle from +normal to -normal through the tangent
      const tail = pts[n - 1];
      let a0 = Math.atan2(ny[n - 1], nx[n - 1]);
      for (let k = 1; k <= CAP; k++) {
        const a = a0 - (Math.PI * k) / (CAP + 1);
        outline[j++].set(tail.x + Math.cos(a) * thickR, tail.y + Math.sin(a) * thickR);
      }
      for (let i = n - 1; i >= 0; i--) outline[j++].set(pts[i].x - nx[i] * thickR, pts[i].y - ny[i] * thickR);
      // Head cap: from -normal back around to +normal through -tangent
      const head = pts[0];
      a0 = Math.atan2(-ny[0], -nx[0]);
      for (let k = 1; k <= CAP; k++) {
        const a = a0 - (Math.PI * k) / (CAP + 1);
        outline[j++].set(head.x + Math.cos(a) * thickR, head.y + Math.sin(a) * thickR);
      }
      triangulateOutline();
    };

    // Long-press → sidebar (see summon()).
    const HOLD_MS = 700, HOLD_SLOP = 10;       // hold time, and how far it may drift (CSS px)
    const SIDE_W = 380, SIDE_GAP = 14;         // panel width and its margin from the screen edge
    const SIDE_BELOW = 66;                     // room under the body for the composer drop
    const FACE_TOP = 124;                      // face height from the top once the chat has content
    let holdAt = 0, holdX = 0, holdY = 0;      // holdAt 0 = not holding
    /* yb: the bottom of everything the sidebar owns — the body, and the
       composer drop hanging under it. */
    let side: { x0: number; y0: number; x1: number; y1: number; yb: number; right: boolean } | null = null;
    let sideTargets: { x: number; y: number }[] = [];
    let sideSaved = { restEdge: 0, thickR: 0 };
    let faceTop = false;
    let sideState: SidebarState | null = null;  // last reported, to resend when the colour changes
    // Talking: the mouth flaps toward a new random openness every few
    // hundredths of a second, sprung so it reads as chatter, not flicker.
    let talking = false, talkOpen = 0, talkGoal = 0, talkNext = 0;
    // An action in progress: what, and how much of it is left (seconds).
    let actKind: JellyAction | '' = '', actLeft = 0;
    const actAmp = () => (actKind ? Math.max(0, actLeft / ACT_LEN[actKind]) : 0);
    const blushColor = new THREE.Color('#ff5fa2');
    /* 0 → 1 over the hold. Winds the creature up: it shakes harder, swells,
       spins its eyes and runs through colours faster and faster, dizzy, until
       it bursts into the sidebar. */
    let charge = 0;
    const dizzy = new THREE.Color();

    const rebuild = () => {
      // The mount can legitimately measure 0x0 for a frame (first layout);
      // spawn nothing until the ResizeObserver reports a real size.
      if (side) dismiss();
      if (W < 4 || H < 4) { pts = []; restR = 0; return; }
      const prev = pts.length && (restR > 1 || thickR > 1) ? centroid() : { x: W / 2, y: H * 0.35 };
      const c = {
        x: Math.max(0, Math.min(W, prev.x)),
        y: Math.max(0, Math.min(H, prev.y)),
      };
      const n = Math.round(cfg.points);
      pts = [];
      if (isWorm()) {
        thickR = thickGoal = cfg.thickness * Math.min(W, H);
        const total = Math.min(cfg.wormLength * Math.min(W, H), W - thickR * 4);
        restEdge = total / (n - 1);
        restR = 0; restArea = 0;
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          const x = c.x + (t - 0.5) * total;
          pts.push({ x, y: c.y, px: x, py: c.y, stuck: false, ax: 0, ay: 0, cd: 0 });
        }
        allocBodyGeometry(2 * n + 2 * CAP);
      } else {
        thickR = thickGoal = 0;
        restR = cfg.size * Math.min(W, H);
        restEdge = 2 * restR * Math.sin(Math.PI / n);
        restArea = Math.PI * restR * restR;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = c.x + Math.cos(a) * restR;
          const y = c.y + Math.sin(a) * restR;
          pts.push({ x, y, px: x, py: y, stuck: false, ax: 0, ay: 0, cd: 0 });
        }
        allocBodyGeometry(n * SUBDIV);
      }
    };
    obs.observe(mount);
    onResize();

    // ── Face meshes — pooled circles (eyes/pupils/mouth) and triangles ───────
    const circleGeo = new THREE.CircleGeometry(1, 40);
    const whiteMat  = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const pupilMat  = new THREE.MeshBasicMaterial({ color: cfg.blobColor, side: THREE.DoubleSide });
    const eyes = Array.from({ length: MAX_EYES }, () => {
      const white = new THREE.Mesh(circleGeo, whiteMat);
      const pupil = new THREE.Mesh(circleGeo, pupilMat);
      white.position.z = 1;
      pupil.position.z = 2;
      white.visible = pupil.visible = false;
      scene.add(white, pupil);
      return { white, pupil };
    });
    const mouthMesh = new THREE.Mesh(circleGeo, whiteMat); // surprised "O"
    mouthMesh.position.z = 1;
    mouthMesh.visible = false;
    scene.add(mouthMesh);
    // Unit tooth: apex points +y (down on screen with the flipped camera)
    const toothGeo = new THREE.BufferGeometry();
    toothGeo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]), 3));
    toothGeo.setIndex([0, 2, 1]);
    const teethMeshes = Array.from({ length: MAX_TEETH }, () => {
      const m = new THREE.Mesh(toothGeo, whiteMat);
      m.position.z = 1;
      m.visible = false;
      scene.add(m);
      return m;
    });

    // ── Audio — lazy-built on first pointer interaction ──────────────────────
    let audioCtx: AudioContext | null = null;
    let master!: GainNode;
    let dragGain!: GainNode;       // 'Creak' bed — filtered noise
    let dragFilter!: BiquadFilterNode;
    let rubberGain!: GainNode;     // 'Rubber' bed — low sawtooth growl
    let rubberOsc!: OscillatorNode;
    let noiseBuf: AudioBuffer | null = null;
    let lastSplat = 0, lastPeel = 0;
    let nextStretchEvt = 0;        // scheduler for 'Bubbles'/'Zipper' stretch styles

    const initAudio = () => {
      if (audioCtx) return;
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      audioCtx = new AC();
      master = audioCtx.createGain();
      master.gain.value = cfg.sndVolume;
      master.connect(audioCtx.destination);
      noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // Two continuous stretch beds, both silent until the body is under
      // tension; the active Stretch Style decides which one gets gain.
      const src = audioCtx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      dragFilter = audioCtx.createBiquadFilter();
      dragFilter.type = 'bandpass';
      dragFilter.frequency.value = 400;
      dragFilter.Q.value = 3;
      dragGain = audioCtx.createGain();
      dragGain.gain.value = 0;
      src.connect(dragFilter); dragFilter.connect(dragGain); dragGain.connect(master);
      src.start();
      rubberOsc = audioCtx.createOscillator();
      rubberOsc.type = 'sawtooth';
      rubberOsc.frequency.value = 60;
      const rubberLp = audioCtx.createBiquadFilter();
      rubberLp.type = 'lowpass';
      rubberLp.frequency.value = 320;
      rubberGain = audioCtx.createGain();
      rubberGain.gain.value = 0;
      rubberOsc.connect(rubberLp); rubberLp.connect(rubberGain); rubberGain.connect(master);
      rubberOsc.start();
    };

    // Short one-shots used by the event-based stretch styles
    const playStretchBlip = (tension: number) => {
      if (!audioCtx) return;
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(250 + Math.random() * 250 + tension * 400, t);
      osc.frequency.exponentialRampToValueAtTime(150 + tension * 200, t + 0.06);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(cfg.sndDrag * 0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + 0.07);
    };
    const playStretchTick = () => {
      if (!audioCtx || !noiseBuf) return;
      const t = audioCtx.currentTime;
      const src = audioCtx.createBufferSource();
      src.buffer = noiseBuf;
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2800;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(cfg.sndDrag * 0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
      src.connect(hp); hp.connect(g); g.connect(master);
      src.start(t, Math.random(), 0.02);
    };

    // Filtered noise burst — shared building block for the one-shot styles
    const noiseBurst = (
      t: number, dur: number, type: BiquadFilterType,
      f0: number, f1: number, q: number, vol: number,
    ) => {
      const src = audioCtx!.createBufferSource();
      src.buffer = noiseBuf!;
      const filt = audioCtx!.createBiquadFilter();
      filt.type = type;
      filt.frequency.setValueAtTime(f0, t);
      filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
      filt.Q.value = q;
      const g = audioCtx!.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filt); filt.connect(g); g.connect(master);
      src.start(t, Math.random(), dur + 0.02);
    };

    const toneBurst = (
      t: number, dur: number, type: OscillatorType,
      f0: number, f1: number, vol: number,
    ) => {
      const osc = audioCtx!.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(25, f1), t + dur);
      const g = audioCtx!.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + dur + 0.02);
    };

    // Splat when points smack onto an edge — flavour picked by Splat Style
    const playSplat = (impact: number) => {
      if (!audioCtx || !noiseBuf || !cfg.sndOn || cfg.sndStick <= 0) return;
      const t = audioCtx.currentTime;
      if (t - lastSplat < 0.07) return;
      lastSplat = t;
      const vol = cfg.sndStick * Math.min(1, impact);
      switch (cfg.sndStickStyle) {
        case 'Thud': // deep dry landing, almost all fundamental
          toneBurst(t, 0.18, 'sine', 85, 28, vol * 0.9);
          noiseBurst(t, 0.06, 'lowpass', 300, 120, 0.5, vol * 0.3);
          break;
        case 'Slap': // bright hand-slap crack
          noiseBurst(t, 0.06, 'bandpass', 1600, 900, 1.5, vol * 0.7);
          toneBurst(t, 0.07, 'sine', 220, 90, vol * 0.3);
          break;
        case 'Boing': // springy cartoon wobble
          toneBurst(t, 0.28, 'triangle', 240, 70, vol * 0.6);
          toneBurst(t + 0.02, 0.24, 'triangle', 320, 95, vol * 0.3);
          break;
        default: // 'Wet' — low noise thud + pitch-drop thump
          noiseBurst(t, 0.13, 'lowpass', 700, 160, 0.6, vol * 0.8);
          toneBurst(t, 0.14, 'sine', 110, 42, vol * 0.5);
      }
    };

    // Little pop when a point un-peels from the surface — flavour by Peel Style
    const playPeel = () => {
      if (!audioCtx || !noiseBuf || !cfg.sndOn || cfg.sndPeel <= 0) return;
      const t = audioCtx.currentTime;
      if (t - lastPeel < 0.05) return;
      lastPeel = t;
      const vol = cfg.sndPeel;
      switch (cfg.sndPeelStyle) {
        case 'Tick': // dry click
          noiseBurst(t, 0.015, 'highpass', 3200, 3000, 0.8, vol * 0.45);
          break;
        case 'Pluck': // plucked-band tone, pitch falls as it lets go
          toneBurst(t, 0.09, 'triangle', 620, 210, vol * 0.4);
          break;
        case 'Velcro': // a few crackles ripping in quick succession
          for (let i = 0; i < 3; i++) {
            noiseBurst(t + i * 0.018, 0.02, 'bandpass', 1400 + Math.random() * 1800, 1200, 2, vol * 0.3);
          }
          break;
        default: { // 'Pop' — rising bandpass squeak
          const src = audioCtx.createBufferSource();
          src.buffer = noiseBuf;
          const bp = audioCtx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(700, t);
          bp.frequency.exponentialRampToValueAtTime(1900, t + 0.05);
          bp.Q.value = 4;
          const g = audioCtx.createGain();
          g.gain.setValueAtTime(vol * 0.4, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
          src.connect(bp); bp.connect(g); g.connect(master);
          src.start(t, Math.random(), 0.07);
        }
      }
    };

    // Per-frame physics event accumulators consumed by the audio layer
    let stickNew = 0, peelNew = 0, stickImpact = 0;

    // ── Pointer ──────────────────────────────────────────────────────────────
    const ac = new AbortController();
    const evt = { signal: ac.signal };
    let mx = -1e4, my = -1e4;          // cursor in device px (for the eyes)
    let dragIdx = -1;
    let dragX = 0, dragY = 0;
    let ptrVx = 0, ptrVy = 0;
    let lastPtrX = 0, lastPtrY = 0, lastPtrT = 0;


    const toLocal = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
    };

    canvas.addEventListener('pointerdown', (e) => {
      initAudio();
      if (side) return; // the chat is on top of it; nothing to grab
      const { x, y } = toLocal(e);
      let best = -1, bestD = cfg.grabRadius * dpr;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - x, pts[i].y - y);
        if (d < bestD) { bestD = d; best = i; }
      }
      // Also allow grabbing from the middle of the blob body
      if (best < 0 && pts.length && !isWorm()) {
        const c = centroid();
        if (Math.hypot(c.x - x, c.y - y) < restR) {
          best = 0;
          for (let i = 1; i < pts.length; i++) {
            if (Math.hypot(pts[i].x - x, pts[i].y - y) <
                Math.hypot(pts[best].x - x, pts[best].y - y)) best = i;
          }
        }
      }
      if (best >= 0) {
        dragIdx = best;
        pts[best].stuck = false;
        dragX = x; dragY = y;
        lastPtrX = x; lastPtrY = y; lastPtrT = performance.now();
        ptrVx = 0; ptrVy = 0;
        try { canvas.setPointerCapture(e.pointerId); } catch { /* touch quirk */ }
        canvas.style.cursor = 'grabbing';
        if (sidebarCb.current) { holdAt = performance.now(); holdX = x; holdY = y; }
      }
    }, evt);

    /*
     * Is the cursor on the creature?
     *
     * Near any body point counts, and so does the middle of a blob — the same
     * two tests the grab uses, so what the shell lets you click is exactly what
     * you could have grabbed. A worm has no inside, so it is the points only.
     */
    const overBody = (x: number, y: number) => {
      if (side && x >= side.x0 && x <= side.x1 && y >= side.y0 && y <= side.yb) return true;
      const reach = cfg.grabRadius * dpr;
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - x, pts[i].y - y) < reach) return true;
      }
      if (pts.length && !isWorm()) {
        const c = centroid();
        if (Math.hypot(c.x - x, c.y - y) < restR) return true;
      }
      return false;
    };

    /* On the window, not the canvas: the sidebar's chat sits over the canvas
       and would otherwise hide the cursor from both the eyes and the shell. */
    let wasOver: boolean | null = null;
    window.addEventListener('pointermove', (e) => {
      const { x, y } = toLocal(e);
      mx = x; my = y;
      if (holdAt && Math.hypot(x - holdX, y - holdY) > HOLD_SLOP * dpr) holdAt = 0;
      if (hover.current) {
        const over = dragIdx >= 0 || overBody(x, y);
        /* Only on the edges: this fires at pointer rate and crosses a process
           boundary in the desktop build. */
        if (over !== wasOver) { wasOver = over; hover.current(over); }
      }
      if (dragIdx >= 0) {
        dragX = x; dragY = y;
        const now = performance.now();
        const dt = Math.max(1, now - lastPtrT) / 1000;
        ptrVx = ptrVx * 0.7 + ((x - lastPtrX) / dt) * 0.3;
        ptrVy = ptrVy * 0.7 + ((y - lastPtrY) / dt) * 0.3;
        lastPtrX = x; lastPtrY = y; lastPtrT = now;
      }
    }, evt);

    const release = () => {
      holdAt = 0;
      if (dragIdx >= 0) {
        const p = pts[dragIdx];
        // Verlet velocity injection: previous position encodes the fling
        p.px = p.x - ptrVx * cfg.throwPower * STEP;
        p.py = p.y - ptrVy * cfg.throwPower * STEP;
        dragIdx = -1;
      }
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', release, evt);
    canvas.addEventListener('pointercancel', release, evt);

    // ── Physics step ─────────────────────────────────────────────────────────
    const STEP = 1 / 120;
    const CORNER_ZONE = 48;

    const step = (t: number) => {
      const n = pts.length;
      const worm = isWorm();
      const mrg = worm ? thickR : 0; // the worm's surface is thickR out from its spine
      const amp = actAmp();
      const melting = actKind === 'melt' ? amp : 0;
      // Melting lets the sidebar sag under a little gravity before it recovers.
      const g = (side ? cfg.gravity * 0.25 * melting : cfg.gravity) * dpr * STEP * STEP;
      /* Holding still charges a shake, so the long-press is felt coming. */
      const jit = (cfg.wobble + charge * charge * 70 + (actKind === 'shiver' ? amp * 45 : 0)) * dpr * STEP * 8;
      if (worm) thickR += (thickGoal - thickR) * 0.08;
      const breatheR = restR * (1 + Math.sin(t * 1.7) * cfg.breathe);

      // Integrate
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (p.cd > 0) p.cd--;
        if (i === dragIdx) { p.x = dragX; p.y = dragY; p.px = dragX; p.py = dragY; continue; }
        if (p.stuck) { p.x = p.ax; p.y = p.ay; p.px = p.ax; p.py = p.ay; }
        const vx = (p.x - p.px) * cfg.damping;
        const vy = (p.y - p.py) * cfg.damping;
        p.px = p.x; p.py = p.y;
        p.x += vx + (Math.random() - 0.5) * jit;
        p.y += vy + g + (Math.random() - 0.5) * jit;
        // Wiggle: a sideways wave running round the body.
        if (actKind === 'wiggle') p.x += Math.sin(t * 26 + i * 0.7) * amp * 1.4 * dpr;
      }

      // Sidebar: every point springs toward its place on the panel outline.
      // A pull, not a placement — momentum carries it past and back, so the
      // body stretches into the shape and keeps a little give once there.
      if (side) {
        for (let i = 0; i < n; i++) {
          const p = pts[i], t = sideTargets[i];
          if (!t) continue;
          const k = 0.05 * (1 - melting * 0.85);
          p.x += (t.x - p.x) * k;
          p.y += (t.y - p.y) * k;
        }
      }

      // Constraints
      const iters = Math.round(cfg.iterations);
      const bendRest = worm || side ? restEdge * 2 : 2 * restR * Math.sin(2 * Math.PI / n);
      for (let k = 0; k < iters; k++) {
        // Pressure + radial shape memory only apply to the closed blob —
        // the worm holds its form from segment + bend constraints alone.
        if (!worm && !side) {
          const c = centroid();
          const area = polyArea();
          // Swells as the hold charges — about to burst.
          const deficit = (restArea * (1 + charge * charge * 0.45) - area) / restArea;
          if (cfg.pressure > 0 && Math.abs(deficit) > 0.001) {
            const push = deficit * cfg.pressure * restR * 0.03;
            for (let i = 0; i < n; i++) {
              const p = pts[i];
              if (i === dragIdx) continue;
              const dx = p.x - c.x, dy = p.y - c.y;
              const d = Math.hypot(dx, dy) || 1;
              p.x += (dx / d) * push;
              p.y += (dy / d) * push;
            }
          }
          if (cfg.squish > 0) {
            for (let i = 0; i < n; i++) {
              const p = pts[i];
              if (i === dragIdx) continue;
              const dx = p.x - c.x, dy = p.y - c.y;
              const d = Math.hypot(dx, dy) || 1;
              const tx = c.x + (dx / d) * breatheR;
              const ty = c.y + (dy / d) * breatheR;
              p.x += (tx - p.x) * cfg.squish * 0.5;
              p.y += (ty - p.y) * cfg.squish * 0.5;
            }
          }
        }

        // Distance constraints: adjacent (elasticity) and skip-one (bend).
        // The blob is a ring (wraps), the worm is an open chain.
        for (const [gap, rest, stiff] of [
          [1, restEdge, cfg.elasticity],
          [2, bendRest, cfg.bend],
        ] as [number, number, number][]) {
          if (stiff <= 0) continue;
          const count = worm ? n - gap : n;
          for (let i = 0; i < count; i++) {
            const bi = (i + gap) % n;
            const a = pts[i], b = pts[bi];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy) || 1;
            let diff = ((d - rest) / d) * 0.5 * stiff;
            // Stretchiness: yield when pulled past rest length, so the body
            // can be dragged out long like a snake and slowly gather back.
            if (d > rest) diff *= 1 - cfg.stretchiness;
            const aPin = i === dragIdx, bPin = bi === dragIdx;
            if (aPin && bPin) continue;
            const aw = aPin ? 0 : bPin ? 2 : 1;
            const bw = bPin ? 0 : aPin ? 2 : 1;
            a.x += dx * diff * aw; a.y += dy * diff * aw;
            b.x -= dx * diff * bw; b.y -= dy * diff * bw;
          }
        }
      }

      // Edges: collide, stick, peel
      const sd = cfg.stickDistance * dpr;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (i === dragIdx) continue;

        if (p.stuck) {
          // The constraints have been pulling p away from its anchor all
          // step — that drift is the tension. Past the threshold it peels
          // off (with a little snap); below it, it strains but holds.
          const pull = Math.hypot(p.x - p.ax, p.y - p.ay);
          const nearCorner =
            (Math.min(p.ax - mrg, W - mrg - p.ax) < CORNER_ZONE * dpr) &&
            (Math.min(p.ay - mrg, H - mrg - p.ay) < CORNER_ZONE * dpr);
          const thresh = cfg.stickiness * dpr * (nearCorner ? cfg.cornerBoost : 1);
          if (!cfg.sticky || pull > thresh) {
            p.stuck = false; // peel! keep the strained position → springs back
            p.cd = Math.round(cfg.restickDelay / STEP);
            peelNew++;
          } else {
            p.x = p.ax + (p.x - p.ax) * cfg.contactGive;
            p.y = p.ay + (p.y - p.ay) * cfg.contactGive;
            p.px = p.x; p.py = p.y;
          }
          continue;
        }

        let touched = false;
        if (p.x < mrg)     { p.x = mrg;     touched = true; }
        if (p.x > W - mrg) { p.x = W - mrg; touched = true; }
        if (p.y < mrg)     { p.y = mrg;     touched = true; }
        if (p.y > H - mrg) { p.y = H - mrg; touched = true; }
        const nearEdge =
          p.x - mrg < sd || (W - mrg) - p.x < sd ||
          p.y - mrg < sd || (H - mrg) - p.y < sd;

        if (touched && cfg.friction > 0) {
          // Kill part of the tangential slide so it doesn't skate along edges
          p.px += (p.x - p.px) * cfg.friction;
          p.py += (p.y - p.py) * cfg.friction;
        }
        if (cfg.sticky && !side && p.cd <= 0 && (touched || nearEdge)) {
          stickNew++;
          stickImpact = Math.max(stickImpact, Math.hypot(p.x - p.px, p.y - p.py));
          p.stuck = true;
          p.ax = Math.max(mrg, Math.min(W - mrg, p.x));
          p.ay = Math.max(mrg, Math.min(H - mrg, p.y));
        }
      }
    };

    // ── Face state ───────────────────────────────────────────────────────────
    let mood: Mood = 'classic';
    let moodTimer = cfg.moodEvery;
    let blinkT = 1;          // 1 = open, animates to 0 and back
    let blinkPhase = 0;      // 0 idle, 1 closing, 2 opening
    let blinkTimer = 2.5;
    let pendingMood: Mood | null = null;
    let facX = 0, facY = 0, facVx = 0, facVy = 0, faceInit = false;
    let tfX = 0, tfY = 0, tfVx = 0, tfVy = 0;   // second face anchor (worm tail)
    // Googly pupils: a loose spring, shared offset state for every eye
    let pupX = 0, pupY = 0, pupVx = 0, pupVy = 0;

    const pickMood = (): Mood => {
      const entries: [Mood, number][] = [
        ['toothy',    cfg.mouthChance],
        ['manyEyes',  cfg.manyEyesChance],
        ['cyclops',   cfg.cyclopsChance],
        ['sleepy',    cfg.sleepyChance],
        ['surprised', cfg.surprisedChance],
      ];
      if (isWorm()) entries.push(['twins', cfg.twinsChance]);
      // Classic always keeps a slice of the pie so the plain face comes back
      const total = entries.reduce((s, e) => s + e[1], 0) + Math.max(0.15, 1 - entries.reduce((s, e) => s + e[1], 0));
      let r = Math.random() * total;
      for (const [m, w] of entries) {
        if (r < w) return m;
        r -= w;
      }
      return 'classic';
    };

    const updateFace = (dt: number) => {
      // Mood changes hide behind a blink so the face never pops mid-stare
      // In the sidebar it keeps a plain face: it is listening.
      if (side) {
        if (mood !== 'classic' && blinkPhase === 0) { pendingMood = 'classic'; blinkPhase = 1; }
      } else if ((moodTimer -= dt) <= 0 && blinkPhase === 0) {
        moodTimer = cfg.moodEvery * (0.6 + Math.random() * 0.8);
        const next = pickMood();
        if (next !== mood) { pendingMood = next; blinkPhase = 1; }
      }
      blinkTimer -= dt;
      if (blinkTimer <= 0 && blinkPhase === 0) {
        blinkTimer = cfg.blinkEvery * (0.5 + Math.random());
        blinkPhase = 1;
      }
      const BLINK_SPEED = 14;
      if (blinkPhase === 1) {
        blinkT -= dt * BLINK_SPEED;
        if (blinkT <= 0) {
          blinkT = 0;
          if (pendingMood) { mood = pendingMood; pendingMood = null; }
          blinkPhase = 2;
        }
      } else if (blinkPhase === 2) {
        blinkT += dt * BLINK_SPEED;
        if (blinkT >= 1) { blinkT = 1; blinkPhase = 0; }
      }

      // Face anchor spring-follows the head (worm) or centroid (blob), so the
      // face jiggles with the jelly instead of gliding rigidly.
      const worm = isWorm();
      let target = worm ? pts[0] : centroid();
      let tail = worm ? pts[pts.length - 1] : target;
      if (side) {
        target = tail = {
          x: (side.x0 + side.x1) / 2,
          y: faceTop ? side.y0 + FACE_TOP * dpr : (side.y0 + side.y1) / 2,
        };
      }
      if (!faceInit) { facX = target.x; facY = target.y; tfX = tail.x; tfY = tail.y; faceInit = true; }
      const j = Math.max(0.05, cfg.faceJiggle);
      facVx += ((target.x - facX) * 220 * j - facVx * 16) * dt;
      facVy += ((target.y - facY) * 220 * j - facVy * 16) * dt;
      facX += facVx * dt;
      facY += facVy * dt;
      tfVx += ((tail.x - tfX) * 220 * j - tfVx * 16) * dt;
      tfVy += ((tail.y - tfY) * 220 * j - tfVy * 16) * dt;
      tfX += tfVx * dt;
      tfY += tfVy * dt;

      if (talking && side) {
        if ((talkNext -= dt) <= 0) {
          talkGoal = 0.15 + Math.random() * 0.85;
          talkNext = 0.05 + Math.random() * 0.09;
        }
      } else talkGoal = 0;
      talkOpen += (talkGoal - talkOpen) * Math.min(1, dt * 28);

      // Googly pupils: loose spring chasing the look direction
      const lx = mx - facX, ly = my - facY;
      const ld = Math.hypot(lx, ly);
      let tx = ld > 1 ? lx / ld : 0;
      let ty = ld > 1 ? ly / ld : 0;
      // Dizzy: the pupils start to roll, faster as the hold charges.
      if (charge > 0.15 || actKind === 'spin') {
        const a = (performance.now() / 1000) * (6 + Math.max(charge, actKind === 'spin' ? 0.6 : 0) * 18);
        tx = Math.cos(a); ty = Math.sin(a);
        if (charge > 0.45 && mood !== 'surprised') { mood = 'surprised'; pendingMood = null; }
      }
      const loose = 30 + (1 - cfg.googlyness) * 300;
      const dampP = 4 + (1 - cfg.googlyness) * 20;
      pupVx += ((tx - pupX) * loose - pupVx * dampP) * dt;
      pupVy += ((ty - pupY) * loose - pupVy * dampP) * dt;
      pupX += pupVx * dt;
      pupY += pupVy * dt;
      const pd = Math.hypot(pupX, pupY);
      if (pd > 1) { pupX /= pd; pupY /= pd; }
    };

    const placeEye = (slot: number, x: number, y: number, r: number, blink: number) => {
      const { white, pupil } = eyes[slot];
      white.visible = true;
      white.position.x = x;
      white.position.y = y;
      white.scale.set(r, Math.max(r * 0.06, r * blink), 1);
      if (blink > 0.25) {
        const pr = r * cfg.pupilSize;
        const range = (r - pr) * cfg.lookRange * 2;
        pupil.visible = true;
        pupil.position.x = x + pupX * range;
        pupil.position.y = y + pupY * range * blink;
        pupil.scale.set(pr, pr * blink, 1);
      } else {
        pupil.visible = false;
      }
    };

    const placeTeeth = (cx: number, baseY: number, R: number) => {
      const count = Math.min(MAX_TEETH, Math.round(cfg.teeth));
      const toothW = R * 0.075, toothH = R * 0.1, gap = R * 0.018;
      const total = count * toothW + (count - 1) * gap;
      for (let i = 0; i < count; i++) {
        const x0 = cx - total / 2 + i * (toothW + gap);
        // subtle arc so the row smiles a little
        const dyArc = Math.sin((i / (count - 1)) * Math.PI) * R * -0.02;
        const m = teethMeshes[i];
        m.visible = true;
        m.position.x = x0 + toothW / 2;
        m.position.y = baseY + dyArc;
        m.scale.set(toothW, toothH, 1);
      }
    };

    const updateFaceMeshes = () => {
      for (const e of eyes) { e.white.visible = e.pupil.visible = false; }
      for (const m of teethMeshes) m.visible = false;
      mouthMesh.visible = false;

      const worm = isWorm();
      // Face reference radius: blob squash-scales with its area, the worm
      // face keys off its thickness so eyes stay proportional to the body.
      /* A fattened sidebar worm keeps the face it had. */
      const faceThick = side ? sideSaved.thickR : thickR;
      const R = worm
        ? faceThick * 8
        : restR * Math.max(0.55, Math.min(1.5, Math.sqrt(polyArea() / restArea)));
      const eyeR = cfg.eyeSize * R;
      // Sleepy: heavy lids — eyes never open past a slit
      const effBlink = mood === 'sleepy' ? Math.min(blinkT, 0.35) : blinkT;

      const ex = worm ? faceThick * 1.5 * cfg.eyeSpacing : cfg.eyeSpacing * R * 0.5;
      const ey = worm ? 0 : -cfg.eyeHeight * R;

      if (mood === 'manyEyes') {
        const count = Math.min(MAX_EYES, Math.round(cfg.extraEyes));
        if (worm) {
          // A row of eyes down the first half of the back, like passengers
          const n = pts.length;
          for (let i = 0; i < count; i++) {
            const idx = Math.round((i * 0.45 * (n - 1)) / (count - 1));
            placeEye(i, pts[idx].x, pts[idx].y, eyeR * 0.8, effBlink);
          }
        } else {
          const arcR = R * 0.52;
          const a0 = Math.PI * 1.15, a1 = Math.PI * 1.85; // across the top
          for (let i = 0; i < count; i++) {
            const a = a0 + ((a1 - a0) * i) / (count - 1);
            placeEye(i, facX + Math.cos(a) * arcR, facY + Math.sin(a) * arcR + eyeR * 0.4, eyeR * 0.55, effBlink);
          }
        }
        return;
      }

      if (mood === 'cyclops') {
        placeEye(0, facX, facY + ey * 0.5, eyeR * 1.9, effBlink);
        return;
      }

      if (mood === 'twins') {
        // Worm only: a little face at each end (the upside-down-U reference)
        placeEye(0, facX - ex, facY + ey, eyeR * 0.9, effBlink);
        placeEye(1, facX + ex, facY + ey, eyeR * 0.9, effBlink);
        placeEye(2, tfX - ex, tfY + ey, eyeR * 0.9, effBlink);
        placeEye(3, tfX + ex, tfY + ey, eyeR * 0.9, effBlink);
        return;
      }

      const bigger = mood === 'surprised' ? 1.4 : 1;
      placeEye(0, facX - ex, facY + ey, eyeR * bigger, effBlink);
      placeEye(1, facX + ex, facY + ey, eyeR * bigger, effBlink);

      if (mood === 'toothy') {
        placeTeeth(facX, facY + ey + eyeR + R * 0.22, R);
      } else if (mood === 'surprised') {
        mouthMesh.visible = true;
        mouthMesh.position.x = facX;
        mouthMesh.position.y = facY + ey + eyeR * bigger + R * 0.16;
        const mr = eyeR * 0.9;
        mouthMesh.scale.set(mr * 0.85, mr, 1);
      } else if (talkOpen > 0.03) {
        mouthMesh.visible = true;
        mouthMesh.position.x = facX;
        mouthMesh.position.y = facY + ey + eyeR + R * 0.18;
        const mr = eyeR * 0.85;
        mouthMesh.scale.set(mr * (1.1 - talkOpen * 0.3), mr * talkOpen, 1);
      }
    };

    // ── Loop ─────────────────────────────────────────────────────────────────
    let lastT = performance.now();
    let acc = 0;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;

      acc += dt;
      if (pts.length) {
        let steps = 0;
        while (acc > STEP && steps < 4) {
          step(now / 1000);
          acc -= STEP;
          steps++;
        }
        if (steps === 4) acc = 0; // drop backlog after a long frame (tab switch)
        updateFace(dt);
      }

      // Audio: consume the physics events gathered this frame
      if (audioCtx) {
        const t = audioCtx.currentTime;
        master.gain.setTargetAtTime(cfg.sndOn ? cfg.sndVolume : 0, t, 0.05);
        if (stickNew > 0) playSplat(Math.min(1, stickImpact / (6 * dpr)));
        if (peelNew > 0) playPeel();
        // Stretch sound: tension = how far past rest the dragged point's
        // neighbour springs are stretched; the style decides how it sounds.
        let tension = 0;
        if (dragIdx >= 0 && pts.length > 1 && cfg.sndOn && cfg.sndDrag > 0) {
          const n = pts.length;
          const worm = isWorm();
          const nb = [dragIdx - 1, dragIdx + 1]
            .map(i => (worm ? (i >= 0 && i < n ? i : -1) : (i + n) % n))
            .filter(i => i >= 0);
          for (const i of nb) {
            const d = Math.hypot(pts[i].x - pts[dragIdx].x, pts[i].y - pts[dragIdx].y);
            tension = Math.max(tension, d / restEdge - 1);
          }
          tension = Math.min(1, tension * 0.6);
        }
        const style = cfg.sndStretchStyle;
        // 'Creak'/'Rubber' are continuous beds; 'Bubbles'/'Zipper' fire
        // one-shots whose rate speeds up with tension.
        const creakG  = style === 'Creak'  ? tension * cfg.sndDrag * 0.5  : 0;
        const rubberG = style === 'Rubber' ? tension * cfg.sndDrag * 0.35 : 0;
        dragGain.gain.setTargetAtTime(creakG, t, 0.06);
        dragFilter.frequency.setTargetAtTime(250 + tension * 950, t, 0.06);
        rubberGain.gain.setTargetAtTime(rubberG, t, 0.06);
        rubberOsc.frequency.setTargetAtTime(55 + tension * 130, t, 0.06);
        if (tension > 0.04 && t >= nextStretchEvt) {
          if (style === 'Bubbles') {
            playStretchBlip(tension);
            nextStretchEvt = t + 0.28 - tension * 0.2;
          } else if (style === 'Zipper') {
            playStretchTick();
            nextStretchEvt = t + 0.13 - tension * 0.1;
          }
        }
      }
      stickNew = 0; peelNew = 0; stickImpact = 0;

      /* No ground to recolour when the window is the ground. */
      if (scene.background) (scene.background as THREE.Color).set(cfg.bgColor);
      bodyMat.color.set(cfg.blobColor);
      /* The chat is drawn in the body's colour; keep it in step when that
         changes under it (from Settings, say). */
      if (sideState && sideState.color !== cfg.blobColor) {
        sideState = { ...sideState, color: cfg.blobColor };
        sidebarCb.current?.(sideState);
      }
      if (actKind === 'blush') bodyMat.color.lerp(blushColor, Math.sin(Math.min(1, actAmp()) * Math.PI) * 0.75);
      if (charge > 0.1) {
        // Cycles through the hues, speeding up, blended in as the hold builds.
        const k = Math.min(1, (charge - 0.1) / 0.45);
        dizzy.setHSL(((now / 1000) * (1.5 + charge * 7)) % 1, 0.9, 0.56);
        bodyMat.color.lerp(dizzy, k);
      }
      pupilMat.color.copy(bodyMat.color);
      bodyMesh.visible = pts.length > 0;
      if (pts.length) {
        if (isWorm()) updateWormGeometry();
        else updateBlobGeometry();
        updateFaceMeshes();
      } else {
        for (const e of eyes) { e.white.visible = e.pupil.visible = false; }
        for (const m of teethMeshes) m.visible = false;
        mouthMesh.visible = false;
      }
      if (actKind && (actLeft -= dt) <= 0) { actKind = ''; actLeft = 0; }
      // Builds while held; let go (or burst) and it settles back over ~¼s.
      charge = holdAt ? Math.min(1, (now - holdAt) / HOLD_MS) : Math.max(0, charge - dt * 4);
      if (holdAt && now - holdAt > HOLD_MS && pts.length) summon();
      if (rest.current && pts.length) checkRest(now);
      renderer.render(scene, camera);
    };

    // ── Sidebar ──────────────────────────────────────────────────────────────
    function rrPath(x0: number, y0: number, x1: number, y1: number, r: number) {
      // A rounded rectangle walked from the middle of its right edge, turning
      // the same way the blob's points are numbered (clockwise on screen).
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const a = (x1 - x0) / 2, b = (y1 - y0) / 2;
      const segs: { len: number; at: (u: number) => { x: number; y: number } }[] = [];
      const line = (ax: number, ay: number, bx: number, by: number) => segs.push({
        len: Math.hypot(bx - ax, by - ay),
        at: (u) => ({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u }),
      });
      const arc = (ox: number, oy: number, a0: number) => segs.push({
        len: (Math.PI / 2) * r,
        at: (u) => ({ x: ox + Math.cos(a0 + u * Math.PI / 2) * r, y: oy + Math.sin(a0 + u * Math.PI / 2) * r }),
      });
      line(cx + a, cy, cx + a, cy + b - r);
      arc(cx + a - r, cy + b - r, 0);
      line(cx + a - r, cy + b, cx - a + r, cy + b);
      arc(cx - a + r, cy + b - r, Math.PI / 2);
      line(cx - a, cy + b - r, cx - a, cy - b + r);
      arc(cx - a + r, cy - b + r, Math.PI);
      line(cx - a + r, cy - b, cx + a - r, cy - b);
      arc(cx + a - r, cy - b + r, Math.PI * 1.5);
      line(cx + a, cy - b + r, cx + a, cy);
      const L = segs.reduce((t, sg) => t + sg.len, 0);
      const at = (d: number) => {
        d = ((d % L) + L) % L;
        for (const sg of segs) {
          if (d <= sg.len) return sg.at(sg.len ? d / sg.len : 0);
          d -= sg.len;
        }
        return segs[0].at(0);
      };
      return { L, at, cx, cy };
    }

    const sidebarTargets = (sd: NonNullable<typeof side>) => {
      const n = pts.length;
      if (isWorm()) {
        // The spine runs down the middle; the worm fattens to fill the width.
        const half = (sd.x1 - sd.x0) / 2;
        const top = sd.y0 + half, len = sd.y1 - sd.y0 - half * 2;
        thickGoal = half;
        restEdge = len / (n - 1);
        return pts.map((_, i) => ({ x: sd.x0 + half, y: top + (len * i) / (n - 1) }));
      }
      const path = rrPath(sd.x0, sd.y0, sd.x1, sd.y1, Math.min(sd.x1 - sd.x0, sd.y1 - sd.y0) * 0.22);
      restEdge = path.L / n;
      // Start where point 0 already points, so nothing has to cross over.
      const c = centroid();
      const want = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
      let d0 = 0, best = Infinity;
      for (let k = 0; k < 360; k++) {
        const q = path.at((path.L * k) / 360);
        const diff = Math.abs(Math.atan2(Math.sin(Math.atan2(q.y - path.cy, q.x - path.cx) - want),
          Math.cos(Math.atan2(q.y - path.cy, q.x - path.cx) - want)));
        if (diff < best) { best = diff; d0 = (path.L * k) / 360; }
      }
      // Walk the same way round as the body's own numbering.
      let wind = 0;
      for (let i = 0; i < n; i++) {
        const p = pts[i], q = pts[(i + 1) % n];
        wind += p.x * q.y - q.x * p.y;
      }
      const dir = wind >= 0 ? 1 : -1;
      return pts.map((_, i) => path.at(d0 + dir * (path.L * i) / n));
    };

    function summon() {
      holdAt = 0;
      if (dragIdx >= 0) { dragIdx = -1; canvas.style.cursor = 'grab'; }
      const c = centroid();
      const right = c.x > W / 2;
      const gap = SIDE_GAP * dpr;
      const w = Math.min(SIDE_W * dpr, W * 0.45);
      const x0 = right ? W - gap - w : gap;
      side = { x0, y0: gap, x1: x0 + w, y1: H - gap - SIDE_BELOW * dpr, yb: H - gap, right };
      sideSaved = { restEdge, thickR: thickGoal };
      for (const p of pts) p.stuck = false;
      faceTop = false;
      sideTargets = sidebarTargets(side);
      if (hover.current) { wasOver = true; hover.current(true); }
      sideState = {
        x: side.x0 / dpr, y: side.y0 / dpr, w: w / dpr, h: (side.y1 - side.y0) / dpr, below: SIDE_BELOW,
        side: right ? 'right' : 'left', color: cfg.blobColor,
      };
      sidebarCb.current?.(sideState);
    }

    /* Let go of the shape: springs off, gravity on, and the jelly gathers
       itself back up as it falls. */
    function dismiss() {
      if (!side) return;
      side = null;
      talking = false;
      sideState = null;
      sideTargets = [];
      restEdge = sideSaved.restEdge;
      thickGoal = sideSaved.thickR;
      faceTop = false;
      anchor = null;
      sidebarCb.current?.(null);
    }

    if (sidebarRef) sidebarRef.current = {
      dismiss,
      setFaceTop: (top) => { faceTop = top; },
      setTalking: (on) => { talking = on; },
      act: (kind) => {
        actKind = kind;
        actLeft = ACT_LEN[kind];
        // A bounce is a single kick upward; the springs (or gravity) do the rest.
        if (kind === 'bounce') for (const p of pts) { if (!p.stuck) p.py = p.y + 16 * dpr; }
      },
    };

    // ── At rest ──────────────────────────────────────────────────────────────
    // The body's box is held against an anchor; any edge drifting past REST_PX
    // (or a grab) restarts the clock. Comparing against the anchor rather than
    // the last frame means a slow crawl still counts as moving.
    const REST_PX = 6, REST_MS = 600;
    type Box = { x0: number; y0: number; x1: number; y1: number };
    let anchor: Box | null = null;
    let restSent: Box | null = null;
    let restSince = 0;
    const bodyBox = () => {
      const m = isWorm() ? thickR : 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x - m); y0 = Math.min(y0, p.y - m);
        x1 = Math.max(x1, p.x + m); y1 = Math.max(y1, p.y + m);
      }
      return { x0, y0, x1, y1 };
    };
    const near = (a: Box | null, b: Box | null) => !!a && !!b &&
      Math.abs(a.x0 - b.x0) < REST_PX * dpr && Math.abs(a.y0 - b.y0) < REST_PX * dpr &&
      Math.abs(a.x1 - b.x1) < REST_PX * dpr && Math.abs(a.y1 - b.y1) < REST_PX * dpr;
    const checkRest = (now: number) => {
      const b = bodyBox();
      if (side) b.y1 = Math.max(b.y1, side.yb); // the composer drop covers icons too
      if (dragIdx >= 0 || !near(anchor, b)) { anchor = b; restSince = now; return; }
      if (now - restSince < REST_MS || near(restSent, b)) return;
      restSent = b;
      rest.current!([{ x: b.x0 / dpr, y: b.y0 / dpr, w: (b.x1 - b.x0) / dpr, h: (b.y1 - b.y0) / dpr }]);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      unbindSettings?.();
      if (sidebarRef) sidebarRef.current = null;
      ac.abort();
      obs.disconnect();
      gui.destroy();
      if (audioCtx) audioCtx.close().catch(() => {});
      bodyMesh.geometry.dispose();
      bodyMat.dispose();
      circleGeo.dispose();
      toothGeo.dispose();
      whiteMat.dispose();
      pupilMat.dispose();
      renderer.dispose();
      if (mount.contains(canvas)) mount.removeChild(canvas);
    };
  }, []);

  const portrait = viewMode !== 'fullscreen';
  return (
    <div
      className="w-screen h-screen flex items-center justify-center overflow-hidden"
      style={{ background: transparent ? 'transparent' : '#111114' }}
    >
      <div
        ref={mountRef}
        style={{
          width:        portrait ? 'min(70dvh, 100vw)'      : '100%',
          height:       portrait ? 'min(93.33dvh, 133.33vw)': '100%',
          borderRadius: (portrait && canvasRounded) ? '12px' : '0',
          boxShadow:    (portrait && canvasShadow)  ? '0 0 40px rgba(0,0,0,0.8)' : 'none',
          overflow: 'hidden',
          position: 'relative',
        }}
      />
    </div>
  );
}
