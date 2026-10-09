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

`npm run dist` packages a `.app` and a `.dmg` with electron-builder, into `release/`.

## What it does

**It sticks.** Every point on the body grabs the edge it touches and holds until the pull beats its stickiness, then lets go one point at a time — so peeling it off a corner feels like peeling, not like a release.

**It has moods.** Every few seconds the face changes: teeth, an arc of extra eyes, a cyclops, sleepy lids, a surprised O, twins at either end of the worm. The eyes track your cursor with a little inertia, so it looks at you late.

**It makes noise.** Splats when it lands on an edge, pops as points peel, and a rubber creak while you stretch it. All synthesised — there are no audio files in here.

**Two bodies.** A pressurised ring that behaves like a blob, and a thick rope that slinks like a worm.

**It talks.** Press and hold it for a moment and it winds itself up — shaking harder, swelling, rolling its eyes and running through colours faster and faster, dizzy — then bursts up the nearer side of the screen into a tall sidebar, still a soft body the whole way, with its face in the middle and the question curved under it like a smile. The buttons on it are white goo, like its eyes. The message box is a drop of the body itself — black, with white letters — that oozes out of the bottom as the sidebar opens, pinches off, and hangs just below; the send button melts into it, and drips bud off the top while it thinks. While it waits for an answer three little drops bounce and melt into each other; once the answer comes, its mouth chatters and each word drops in like a blob landing — stretched as it falls, squashed as it hits. Ask it anything; the face moves up and the conversation takes its place. Esc or × lets go, and it gathers itself back into a blob as it falls.

The chat runs on Claude through your own Anthropic API key: paste it into Settings › Assistant, where it is stored encrypted in your Keychain. Claude Haiku 5.5 is the default (the cheapest — roughly a twentieth of a cent a message); Sonnet 5.5 and Opus 5.5 are a menu away. Billing is per message to your Anthropic account, separate from any Claude subscription.

## The desktop part

Three things make it a creature on your desktop rather than a window with a creature in it:

**Click-through, except on the body.** A transparent window still swallows every click that lands on it, which would put a dead rectangle over your files. So the window ignores the mouse by default, and the page tells the shell when your cursor is actually on the creature — the same test the grab uses, so anything you can click is something you could have grabbed.

**No frame, no dock icon.** It sits above ordinary windows at floating level, on every space, with a menu-bar item to hide or quit it. There is nothing to minimise.

**The whole work area.** The window is the screen, so the edges it sticks to are your screen's edges.

**Icons get out of the way.** When the jelly comes to rest, any desktop icon under it is moved by Finder to the nearest free spot, and put back once the jelly leaves. Only on rest — Finder can't animate icons, so following a flung body would flicker. Where each icon came from is kept on disk, and everything goes home on quit (or on the next launch, after a crash). macOS asks once to let Sticky Jelly control Finder. A desktop sorted by name, kind or date is left alone, since Finder would put the icons straight back.

**A real Settings window.** Physics, stickiness, body, face, moods, throw and sound — the study's controls — live in a Settings window opened from the menu-bar item or with ⌘,. Changes apply as you drag and are saved for the next launch.

## How it works

The body is a verlet soft-body: points with a previous position, a pressure term that keeps a ring inflated, and constraints that hold the shape without making it rigid. Physics runs in device pixels at a fixed 120Hz step, decoupled from the frame rate.

Rendering is Three.js with an orthographic camera mapped one world unit to one pixel, so simulation coordinates are drawn without conversion. The outline is re-triangulated into a `BufferGeometry` every frame; the face is a pool of circle and triangle meshes that are moved rather than rebuilt.

## Where it came from

It began as a study on [davidbastian.black](https://davidbastian.black/?p=sticky-jelly) — one of a set of interface experiments — and became an app because a creature that sticks to the edges of a canvas wants to stick to the edges of a screen instead.

The study and this app share the component. Two props exist only for the desktop build: `transparent`, which drops the coloured ground so your wallpaper shows through, and `onHover`, which reports whether the cursor is on the body.

## Licence

MIT © David Bastian
