# Sticky Jelly

A soft-body creature that lives on your desktop. Grab it, stretch it, fling it across the screen. It clings to the edges like a sticky-hand toy and peels off point by point when you pull hard enough.

Everywhere you are not touching it, your desktop works normally — the window only takes the mouse where the creature actually is.

![Sticky Jelly](media/jelly.gif)

---

## Run it

```bash
npm install
npm run dev     # the creature in a browser tab, for working on it
npm run start   # build, then open it as a desktop app
```

`npm run dist` packages a `.app` and a `.dmg` with electron-builder.

## What it does

**It sticks.** Every point on the body grabs the edge it touches and holds until the pull beats its stickiness, then lets go one point at a time — so peeling it off a corner feels like peeling, not like a release.

**It has moods.** Every few seconds the face changes: teeth, an arc of extra eyes, a cyclops, sleepy lids, a surprised O, twins at either end of the worm. The eyes track your cursor with a little inertia, so it looks at you late.

**It makes noise.** Splats when it lands on an edge, pops as points peel, and a rubber creak while you stretch it. All synthesised — there are no audio files in here.

**Two bodies.** A pressurised ring that behaves like a blob, and a thick rope that slinks like a worm.

## The desktop part

Three things make it a creature on your desktop rather than a window with a creature in it:

**Click-through, except on the body.** A transparent window still swallows every click that lands on it, which would put a dead rectangle over your files. So the window ignores the mouse by default, and the page tells the shell when your cursor is actually on the creature — the same test the grab uses, so anything you can click is something you could have grabbed.

**No frame, no dock icon.** It sits above ordinary windows at floating level, on every space, with a menu-bar item to hide or quit it. There is nothing to minimise.

**The whole work area.** The window is the screen, so the edges it sticks to are your screen's edges.

Press **G** to show the controls — physics, stickiness, body, face, sound — and again to hide them.

## How it works

The body is a verlet soft-body: points with a previous position, a pressure term that keeps a ring inflated, and constraints that hold the shape without making it rigid. Physics runs in device pixels at a fixed 120Hz step, decoupled from the frame rate.

Rendering is Three.js with an orthographic camera mapped one world unit to one pixel, so simulation coordinates are drawn without conversion. The outline is re-triangulated into a `BufferGeometry` every frame; the face is a pool of circle and triangle meshes that are moved rather than rebuilt.

## Where it came from

It began as a study on [davidbastian.black](https://davidbastian.black/?p=sticky-jelly) — one of a set of interface experiments — and became an app because a creature that sticks to the edges of a canvas wants to stick to the edges of a screen instead.

The study and this app share the component. Two props exist only for the desktop build: `transparent`, which drops the coloured ground so your wallpaper shows through, and `onHover`, which reports whether the cursor is on the body.

## Licence

MIT © David Bastian
