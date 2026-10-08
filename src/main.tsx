/*
 * Sticky Jelly, as a thing that lives on the desktop.
 *
 * The study and the app are the same component — this file is only the mount
 * and the two wires the shell needs:
 *
 *   transparent   the ground is your wallpaper, not a colour
 *   onHover       whether the cursor is on the creature, so the shell can let
 *                 every other click through to whatever is behind it
 *
 * There is no GUI here. The study mounts lil-gui into #gui-project, which this
 * page does not have, and the component already treats that as optional — a
 * desktop toy with a control panel floating next to it is a demo, not a toy.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import StickyJelly from './StickyJelly';

declare global {
  interface Window {
    jelly?: { hover: (over: boolean) => void };
  }
}

function Desktop() {
  return (
    <StickyJelly
      viewMode="fullscreen"
      transparent
      onHover={(over) => window.jelly?.hover(over)}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Desktop />
  </StrictMode>,
);
