/*
 * Sticky Jelly, as a thing that lives on the desktop.
 *
 * The study and the app are the same component — this file is only the mount
 * and the wires the shell needs:
 *
 *   transparent   the ground is your wallpaper, not a colour
 *   onHover       whether the cursor is on the creature, so the shell can let
 *                 every other click through to whatever is behind it
 *   onRest        what it covers once it stops, so the shell can move desktop
 *                 icons out from under it
 *   onSettings    every control the study's panel has, so they can be shown
 *                 in a Settings window instead of floating over the desktop
 *   onSidebar     press and hold, and it stretches into a sidebar with a chat
 *                 on it
 */
import { StrictMode, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import StickyJelly, {
  type Rect, type SettingsBridge, type SidebarControl, type SidebarState,
} from './StickyJelly';
import Chat, { type VoiceApi } from './Chat';

declare global {
  interface Window {
    jelly?: {
      hover: (over: boolean) => void;
      rest: (rects: Rect[]) => void;
      settings: (schema: SettingsBridge['schema'], set: SettingsBridge['set']) => () => void;
      focus: () => void;
      chat: Parameters<typeof Chat>[0]['api'];
      voice?: VoiceApi;
    };
  }
}

function Desktop() {
  const [sidebar, setSidebar] = useState<SidebarState | null>(null);
  const control = useRef<SidebarControl | null>(null);

  const open = useRef(false);
  const onSidebar = useCallback((s: SidebarState | null) => {
    setSidebar(s);
    /* Typing needs the keyboard, which a floating window only gets on ask —
       but only on opening: a colour change while Settings is in front must
       not pull the keyboard away from it. */
    if (s && !open.current) window.jelly?.focus();
    open.current = !!s;
  }, []);
  const close = useCallback(() => control.current?.dismiss(), []);
  const faceTop = useCallback((top: boolean) => control.current?.setFaceTop(top), []);
  const talking = useCallback((on: boolean) => control.current?.setTalking(on), []);
  const act = useCallback((kind: Parameters<SidebarControl['act']>[0]) => control.current?.act(kind), []);

  const api = window.jelly?.chat;
  return (
    <>
      <StickyJelly
        viewMode="fullscreen"
        transparent
        onHover={(over) => window.jelly?.hover(over)}
        onRest={(rects) => window.jelly?.rest(rects)}
        onSettings={({ schema, set }) => window.jelly?.settings(schema, set)}
        onSidebar={api ? onSidebar : undefined}
        sidebarRef={control}
      />
      {sidebar && api && (
        <Chat
          state={sidebar}
          api={api}
          voice={window.jelly?.voice}
          onClose={close}
          onFaceTop={faceTop}
          onTalking={talking}
          onAction={act}
        />
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Desktop />
  </StrictMode>,
);
