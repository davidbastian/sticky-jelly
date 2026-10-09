/*
 * The chat that sits on the jelly once it has stretched into a sidebar.
 *
 * It draws no panel of its own: the stretched body behind it is the panel, so
 * this is only text and a composer laid over the creature, in a colour picked
 * to read on whatever the body colour is. While the conversation is empty the
 * face sits in the middle with the question under it; once there is something
 * to read, the face moves up and the messages take its place.
 *
 * The conversation itself is kept by the shell (see desktop/assistant.cjs);
 * this asks for the transcript on open, so closing and reopening the sidebar
 * picks up where it left off.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { actionKind, type ChatSound, type JellyAction, type SidebarState } from './StickyJelly';

/* fresh: written during this visit, so its words get the drop-in. */
interface Line { role: 'user' | 'assistant'; text: string; error?: boolean; fresh?: boolean }

interface ChatApi {
  send: (text: string) => Promise<{ ok?: boolean; error?: string; stopped?: boolean }>;
  onDelta: (fn: (d: string) => void) => () => void;
  stop: () => void;
  reset: () => void;
  transcript: () => Promise<{ role: 'user' | 'assistant'; text: string }[]>;
  prefs: () => Promise<{ speak: boolean }>;
}

type VoiceEvent =
  | { type: 'ready' } | { type: 'end' }
  | { type: 'level'; value: number }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; message: string };

export interface VoiceApi {
  start: () => void;
  stop: () => void;
  on: (fn: (ev: VoiceEvent) => void) => () => void;
}

/*
 * Actions: the assistant writes *wiggles*, and the jelly does it. Bold
 * (**…**) is unwrapped first so it is never mistaken for one. A live reply
 * hides a half-written action until its closing asterisk arrives.
 */
const ACT = /\*([^*\n]{1,60})\*/g;
type Part = { kind: 'text'; v: string } | { kind: 'act'; v: string };
function parse(text: string, live: boolean): Part[] {
  const t = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  const out: Part[] = [];
  let last = 0;
  for (const m of t.matchAll(ACT)) {
    if (m.index! > last) out.push({ kind: 'text', v: t.slice(last, m.index) });
    out.push({ kind: 'act', v: m[1].trim() });
    last = m.index! + m[0].length;
  }
  let rest = t.slice(last);
  if (live) { const open = rest.indexOf('*'); if (open >= 0) rest = rest.slice(0, open); }
  else rest = rest.replace(/\*/g, '');
  if (rest) out.push({ kind: 'text', v: rest });
  return out;
}

/* What gets read aloud: the words, not the actions or the markup. */
function spoken(text: string) {
  return parse(text, true)
    .filter(p => p.kind === 'text')
    .map(p => p.v)
    .join('')
    .replace(/`/g, '')
    .replace(/^\s*-\s+/gm, '');
}

/* Light text on a dark body, dark text on a light one. */
function ink(hex: string) {
  const v = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.55
    ? { text: '#f4f4f5', soft: 'rgba(255,255,255,0.55)', fill: 'rgba(255,255,255,0.1)', line: 'rgba(255,255,255,0.16)' }
    : { text: '#111113', soft: 'rgba(0,0,0,0.5)', fill: 'rgba(0,0,0,0.07)', line: 'rgba(0,0,0,0.14)' };
}

export default function Chat({ state, api, voice, onClose, onFaceTop, onTalking, onAction, onSound }: {
  state: SidebarState;
  api: ChatApi;
  voice?: VoiceApi;
  onClose: () => void;
  onFaceTop: (top: boolean) => void;
  onTalking?: (on: boolean) => void;
  onAction?: (kind: JellyAction) => void;
  onSound?: (kind: ChatSound) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hot, setHot] = useState<{ id: string; kind: 'hover' | 'press' } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef(0);
  /* Spoken replies: utterances still queued, and whether the text is done. */
  const voiceOut = useRef({ queued: 0, streaming: false });

  /* A jiggle on every send, restarted even if the last one is still going. */
  function jiggle() {
    const el = composer.current;
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }
  const c = ink(state.color);

  /* Fade in once the body has mostly stretched into place. */
  useEffect(() => {
    const t = setTimeout(() => { setShown(true); input.current?.focus(); }, 420);
    api.transcript().then(t => setLines(t));
    return () => clearTimeout(t);
  }, [api]);

  useEffect(() => { onFaceTop(lines.length > 0); }, [lines.length, onFaceTop]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /* Nothing keeps talking or listening once the sidebar is gone. */
  useEffect(() => () => {
    speechSynthesis.cancel();
    voice?.stop();
  }, [voice]);

  /* Esc closes, from anywhere in the window. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Grow the composer with its text, up to a point. */
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  /* Read a piece of the reply aloud; the mouth keeps moving until the last
     queued piece has been said. */
  function say(text: string) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.04;
    u.pitch = 1.3;   // a little higher: it is a small creature
    const out = voiceOut.current;
    out.queued++;
    u.onstart = () => onTalking?.(true);
    u.onend = u.onerror = () => {
      out.queued = Math.max(0, out.queued - 1);
      if (!out.queued && !out.streaming) onTalking?.(false);
    };
    speechSynthesis.speak(u);
  }

  function shush() {
    speechSynthesis.cancel();
    voiceOut.current.queued = 0;
    onTalking?.(false);
  }

  async function send(spokenText?: string) {
    const text = (spokenText ?? draft).trim();
    if (busy) return;
    jiggle();
    if (!text) return;
    shush();
    setDraft('');
    setBusy(true);
    onSound?.('send');
    setLines(l => [...l, { role: 'user', text }, { role: 'assistant', text: '', fresh: true }]);
    // Little gurgles until the first word arrives.
    let gurgle = window.setTimeout(function bubble() {
      onSound?.('think');
      gurgle = window.setTimeout(bubble, 260 + Math.random() * 320);
    }, 450);
    const appendLast = (fn: (line: Line) => Line | null) => setLines(l => {
      const last = fn(l[l.length - 1]);
      return last ? [...l.slice(0, -1), last] : l.slice(0, -1);
    });

    // Talk back only when talked to, and only if that is switched on.
    const talkBack = spokenText !== undefined && (await api.prefs()).speak;
    const out = voiceOut.current;
    out.streaming = true;
    let acc = '', fired = 0, said = 0;
    const speakUpTo = (final: boolean) => {
      const plain = spoken(acc);
      let upto = plain.length;
      if (!final) {
        // Whole sentences only while it is still arriving.
        upto = -1;
        for (const m of plain.matchAll(/[.!?…:;](\s)|\n/g)) upto = m.index! + 1;
      }
      if (upto > said) {
        const chunk = plain.slice(said, upto).trim();
        said = upto;
        if (chunk) say(chunk);
      }
    };

    /* The mouth moves from the first word to the last (or the last word said). */
    const off = api.onDelta(d => {
      clearTimeout(gurgle);
      onTalking?.(true);
      // A blip per word as it babbles — unless it is saying them out loud.
      if (!talkBack) {
        const words = d.split(/\s+/).filter(Boolean).slice(0, 4);
        words.forEach((_, k) => window.setTimeout(() => onSound?.('word'), k * 55));
      }
      acc += d;
      appendLast(line => ({ ...line, text: line.text + d }));
      // Act out every action as soon as its closing asterisk lands.
      const acts = [...acc.replace(/\*\*([^*\n]+)\*\*/g, '$1').matchAll(ACT)];
      for (; fired < acts.length; fired++) {
        const kind = actionKind(acts[fired][1]);
        onAction?.(kind);
        onSound?.(kind);
      }
      if (talkBack) speakUpTo(false);
    });
    const res = await api.send(text);
    off();
    clearTimeout(gurgle);
    if (!res.error && !res.stopped) onSound?.('done');
    out.streaming = false;
    if (talkBack && !res.error && !res.stopped) speakUpTo(true);
    if (!out.queued) onTalking?.(false);
    if (res.error) appendLast(line => ({ ...line, text: res.error!, error: true, fresh: false }));
    else if (res.stopped) appendLast(line => (line.text ? line : null));
    setBusy(false);
    input.current?.focus();
  }

  /*
   * Talk to it: the words appear in the composer as you say them, and when
   * you pause it sends them. Pressing the mic again sends straight away.
   */
  function toggleMic() {
    if (!voice) return;
    if (listening) { voice.stop(); return; }
    if (busy) return;
    shush();
    setDraft('');
    setListening(true);
    let heard = '', failed = '';
    const off = voice.on(ev => {
      if (ev.type === 'level') setLevel(ev.value);
      else if (ev.type === 'partial') { heard = ev.text; setDraft(ev.text); }
      else if (ev.type === 'final') heard = ev.text || heard;
      else if (ev.type === 'error') failed = ev.message;
      else if (ev.type === 'end') {
        off();
        setListening(false);
        setLevel(0);
        if (failed) {
          setDraft('');
          setLines(l => [...l, { role: 'assistant', text: failed, error: true }]);
        } else if (heard.trim()) send(heard);
        else setDraft('');
      }
    });
    voice.start();
  }

  function stopAll() {
    api.stop();
    shush();
  }

  function newChat() {
    stopAll();
    api.reset();
    setLines([]);
    input.current?.focus();
  }

  const empty = lines.length === 0;
  const root: CSSProperties = {
    position: 'fixed',
    left: state.x, top: state.y, width: state.w, height: state.h,
    /* The bottom stays clear of the body's rounded corners; the composer
       hangs below the body, outside this box. */
    padding: '16px 18px 40px',
    boxSizing: 'border-box',
    /* Spelled out: the page styles every child of #root as a centred flexbox. */
    display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch',
    overflow: 'visible',
    color: c.text,
    font: '14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
    opacity: shown ? 1 : 0,
    transition: 'opacity 0.25s ease',
    zIndex: 10,
    userSelect: 'text',
    WebkitUserSelect: 'text',
    ['--blob' as string]: c.text,
    ['--ink' as string]: state.color,
  };

  /* Hover and press live on the real buttons; the blob behind reacts. */
  const heat = (id: string) => (hot?.id === id ? ` is-${hot.kind}` : '');
  const hotProps = (id: string) => ({
    onPointerEnter: () => setHot({ id, kind: 'hover' }),
    onPointerLeave: () => setHot(null),
    onPointerDown: () => setHot({ id, kind: 'press' }),
    onPointerUp: () => setHot({ id, kind: 'hover' }),
  });
  const canSend = busy || !!draft.trim();

  return (
    <div className={`jelly-chat${busy ? ' busy' : ''}`} style={root} role="dialog" aria-label="Sticky Jelly chat">
      <style>{GOO_CSS}</style>
      {/* The goo: blur, then a hard alpha threshold, so shapes that come close
          melt into each other like the body they sit on. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <filter id="jelly-goo-small" x="-50%" y="-100%" width="200%" height="300%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
        </filter>
        <filter id="jelly-goo" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
        </filter>
      </svg>

      <div className="goo-stack head">
        <div className="goo-layer" aria-hidden="true">
          {!empty && <span className={`blob pill wob-a${heat('new')}`}>New chat</span>}
          <span className={`blob dot wob-b${heat('close')}`} />
        </div>
        <div className="goo-front">
          {!empty && <button className="ghost pill" {...hotProps('new')} onClick={newChat}>New chat</button>}
          <button className="ghost dot" {...hotProps('close')} onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {empty ? (
        /* The face is drawn at the panel's middle; the question sits under it,
           measured from the panel itself rather than the space left over. */
        <div style={{ flex: 1 }}>
          <Smile text="What can I help with?" play={shown} />
        </div>
      ) : (
        <div
          ref={scroller}
          className={`log${scrolling ? ' scrolling' : ''}`}
          onScroll={() => {
            setScrolling(true);
            clearTimeout(scrollTimer.current);
            scrollTimer.current = window.setTimeout(() => setScrolling(false), 900);
          }}
          style={{
            flex: 1, overflowY: 'auto', marginTop: 148, paddingRight: 10,
            display: 'flex', flexDirection: 'column', gap: 12,
          }}
        >
          {lines.map((l, i) => l.role === 'user' ? (
            <div key={i} className="bubble" style={{
              alignSelf: 'flex-end', maxWidth: '85%', background: c.fill,
              padding: '8px 13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{l.text}</div>
          ) : (
            <div key={i} style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: l.error ? c.soft : c.text,
            }}>
              {l.text
                ? (l.error ? l.text : <Reply text={l.text} fresh={!!l.fresh} live={busy && i === lines.length - 1} />)
                : <Thinking />}
            </div>
          ))}
        </div>
      )}

      {/* A drop of the body itself: it oozes out of the bottom when the
          sidebar opens, hangs on a neck, and pinches off to sit just below. */}
      <div ref={composer} className={`goo-stack composer${shown ? ' ooze' : ''}`} style={{ bottom: -(state.below - 6) }}>
        <div className="goo-layer" aria-hidden="true">
          <span className="neck" />
          <span className={`blob field wob-wide${focused ? ' is-focus' : ''}`}>
            <span className="drop" style={{ left: '18%' }} />
            <span className="drop" style={{ left: '52%', animationDelay: '-1.6s' }} />
            <span className="drop" style={{ left: '78%', animationDelay: '-2.9s' }} />
          </span>
          {voice && (
            <span
              className={`blob send mic wob-a${listening ? ' is-listening' : ''}${heat('mic')}`}
              style={{ ['--lvl' as string]: level }}
            />
          )}
          <span className={`blob send wob-b${canSend ? '' : ' is-idle'}${heat('send')}`} />
        </div>
        <div className="goo-front">
          <span className="field-wrap">
            <textarea
              ref={input}
              value={draft}
              rows={1}
              aria-label="Ask anything"
              onChange={e => setDraft(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
              }}
            />
            {!draft && <Hint key={listening ? 'l' : 'a'} text={listening ? 'Listening…' : 'Ask anything…'} />}
          </span>
          {voice && (
            <button
              className="ghost send"
              {...hotProps('mic')}
              onClick={toggleMic}
              aria-label={listening ? 'Stop listening and send' : 'Talk'}
              aria-pressed={listening}
              disabled={busy && !listening}
            >
              <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
                <rect x="4" y="1" width="6" height="9" rx="3" fill="currentColor" />
                <path d="M1.5 7.5a5.5 5.5 0 0 0 11 0M7 13v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <button
            className="ghost send"
            {...hotProps('send')}
            onClick={busy ? stopAll : () => send()}
            aria-label={busy ? 'Stop' : 'Send'}
            disabled={!canSend}
          >
            {busy ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2.5" fill="currentColor" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/*
 * A reply, word by word, as it streams: each new word drops in from above
 * like a blob landing — stretched as it falls, squashed as it lands, then
 * settled. Words already on the page keep their keys and so never replay;
 * only the ones that just arrived move.
 */
function Words({ text }: { text: string }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((p, i) => (/^\s*$/.test(p) ? p : <span key={i} className="word">{p}</span>))}
    </>
  );
}

/*
 * The placeholder, alive: a ripple of jelly bounce runs through it letter by
 * letter, rests, and comes round again — it is listening, go ahead.
 */
function Hint({ text }: { text: string }) {
  return (
    <span className="hint" aria-hidden="true">
      {[...text].map((ch, i) => (
        <span key={i} style={{ animationDelay: `${i * 0.06}s` }}>{ch}</span>
      ))}
    </span>
  );
}

/*
 * A reply: its words, and its actions — no asterisks, but a little tag that
 * moves the way it reads (a wiggle wiggles, a bounce bounces) while the
 * jelly does the real thing.
 */
function Reply({ text, fresh, live }: { text: string; fresh: boolean; live: boolean }) {
  return (
    <>
      {parse(text, live).map((p, i) => p.kind === 'act'
        ? <Action key={i} text={p.v} />
        : fresh ? <Words key={i} text={p.v} /> : <span key={i}>{p.v}</span>)}
    </>
  );
}

function Action({ text }: { text: string }) {
  return (
    <span className={`act act-${actionKind(text)}`} aria-label={`(${text})`}>
      {[...text].map((ch, i) => (
        <span key={i} aria-hidden="true" style={{ animationDelay: `${i * 0.045}s` }}>{ch}</span>
      ))}
    </span>
  );
}

/* Waiting for the first word: three drops that bounce and melt together. */
function Thinking() {
  return (
    <span className="thinking" role="status" aria-label="Thinking">
      <i /><i /><i />
    </span>
  );
}

/*
 * The question, written along a smile under the face.
 *
 * It arrives flat and springs into the curve — past it and back, like the
 * body does — while the letters pop in one after another along the line;
 * then the smile keeps breathing, a little deeper and back.
 */
function Smile({ text, play }: { text: string; play: boolean }) {
  const path = useRef<SVGPathElement>(null);
  /* The curve is only a little longer than the words, so they ride all of
     it — up at both ends, like a mouth. */
  const W = 340, Y = 12, DEPTH = 30, X0 = 62, X1 = 278;
  const id = 'jelly-smile';

  useEffect(() => {
    if (!play) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      // Under-damped spring from flat to the smile, then a slow breath.
      const spring = 1 - Math.exp(-t * 5) * Math.cos(t * 11);
      const breath = 1 + Math.sin(Math.max(0, t - 0.9) * 1.8) * 0.12 * Math.min(1, Math.max(0, t - 0.9));
      const d = still ? DEPTH : DEPTH * spring * breath;
      path.current?.setAttribute('d', `M ${X0} ${Y} Q ${W / 2} ${Y + d * 2} ${X1} ${Y}`);
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [play]);

  return (
    <svg
      viewBox={`0 0 ${W} 70`}
      width="100%"
      aria-label={text}
      role="img"
      style={{ position: 'absolute', left: 18, right: 18, width: 'calc(100% - 36px)', top: 'calc(50% + 40px)', overflow: 'visible' }}
    >
      <path id={id} ref={path} d={`M ${X0} ${Y} Q ${W / 2} ${Y} ${X1} ${Y}`} fill="none" />
      <text fill="currentColor" fontSize="20" fontWeight="600" letterSpacing="-0.2" aria-hidden="true">
        <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
          {[...text].map((ch, i) => (
            <tspan key={i} className="smile-letter" style={{ animationDelay: `${0.05 + i * 0.028}s` }}>{ch}</tspan>
          ))}
        </textPath>
      </text>
    </svg>
  );
}

/*
 * The controls are drawn twice, stacked in one grid cell: blobs behind, under
 * the goo filter, and the real buttons and text on top, unfiltered — the
 * filter would melt the glyphs too. The blobs breathe, droplets bud off the
 * top of the composer (faster while a reply streams), and hover and press
 * swell and squish them on an overshooting spring.
 */
const GOO_CSS = `
.jelly-chat .goo-stack { display: grid; flex: none; }
.jelly-chat .goo-stack > * { grid-area: 1 / 1; display: flex; gap: 4px; }
.jelly-chat .goo-layer { filter: url(#jelly-goo); pointer-events: none; user-select: none; -webkit-user-select: none; }
/* A filtered element paints in the positioned pass, over plain siblings —
   so the real controls need their own place in that order, on top. */
.jelly-chat .goo-front { position: relative; z-index: 1; }
.jelly-chat .head { align-self: stretch; margin: 18px 16px 0; --fill: var(--blob); --fg: var(--blob); }
/* Soft, not solid: the goo is faded after it is shaped (a see-through fill
   would be cut away by the filter's alpha threshold). */
.jelly-chat .head .goo-layer { opacity: 0.16; }
/* New chat on the left, close on the right — apart, so they don't melt. */
.jelly-chat .head > * { justify-content: flex-start; }
.jelly-chat .head .dot { margin-left: auto; }
/* The composer is the body's colour, with the eyes' white for its letters. */
.jelly-chat .composer {
  position: absolute; left: 8px; right: 8px;
  --fill: var(--ink); --fg: var(--blob);
  transform-origin: 50% 0; visibility: hidden;
}
.jelly-chat .composer.ooze { visibility: visible; animation: jelly-ooze 0.95s cubic-bezier(0.3, 0.9, 0.4, 1) both; }
.jelly-chat .composer .goo-layer { align-items: stretch; position: relative; }
.jelly-chat .composer .goo-front { align-items: flex-end; }
.jelly-chat .neck {
  position: absolute; left: 50%; top: -24px; width: 70px; height: 40px; margin-left: -35px;
  border-radius: 50%; background: var(--fill); scale: 0 0;
}
.jelly-chat .ooze .neck { animation: jelly-neck 1.4s ease-in both; }

.jelly-chat .blob {
  display: block; position: relative; background: var(--fill);
  transition: scale 0.55s cubic-bezier(0.3, 1.9, 0.5, 1);
}
.jelly-chat .pill { height: 30px; padding: 0 14px; border-radius: 15px; font-size: 12px; font-weight: 600; line-height: 30px; box-sizing: border-box; }
.jelly-chat .blob.pill { color: transparent; }
.jelly-chat .dot { width: 30px; height: 30px; border-radius: 50%; }
.jelly-chat .field { flex: 1; border-radius: 22px; }
.jelly-chat .send { width: 40px; height: 40px; border-radius: 50%; flex: none; }
.jelly-chat .blob.send { align-self: flex-end; }

.jelly-chat .is-hover { scale: 1.14; }
.jelly-chat .is-press { scale: 0.84; transition-duration: 0.12s; }
.jelly-chat .is-focus { scale: 1.01 1.08; }
.jelly-chat .is-idle { scale: 0.78; }
.jelly-chat .is-listening { scale: calc(1.05 + var(--lvl, 0) * 0.4); transition-duration: 0.09s; }

/* The conversation: a thin bar in the body's own ink, only while scrolling
   or hovered, and the text fading out at both ends rather than cut off. */
.jelly-chat .log {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
          mask-image: linear-gradient(to bottom, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
  padding-top: 8px; padding-bottom: 8px;
}
.jelly-chat .log::-webkit-scrollbar { width: 5px; }
.jelly-chat .log::-webkit-scrollbar-track { background: transparent; margin: 14px 0; }
.jelly-chat .log::-webkit-scrollbar-thumb { background: transparent; border-radius: 999px; transition: background 0.3s; }
.jelly-chat .log:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--blob) 18%, transparent); }
.jelly-chat .log.scrolling::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--blob) 38%, transparent); }

/* Actions, acted out in type as well as in the body. */
.jelly-chat .act {
  display: inline-block; white-space: pre; margin: 0 2px; padding: 0 9px;
  border-radius: 999px; font-size: 13px; font-weight: 600;
  background: color-mix(in srgb, var(--blob) 12%, transparent);
  color: color-mix(in srgb, var(--blob) 85%, transparent);
  animation: jelly-pop 0.5s cubic-bezier(0.3, 1.7, 0.5, 1) both;
}
.jelly-chat .act > span {
  display: inline-block; transform-origin: 50% 80%;
  animation: act-wiggle 1.4s ease-in-out infinite;
}
.jelly-chat .act-bounce > span { animation-name: act-bounce; animation-duration: 1.1s; }
.jelly-chat .act-spin > span { animation-name: act-spin; animation-duration: 2.6s; transform-origin: 50% 55%; }
.jelly-chat .act-shiver > span { animation-name: act-shiver; animation-duration: 0.22s; }
.jelly-chat .act-melt > span { animation-name: act-melt; animation-duration: 2.8s; transform-origin: 50% 100%; }
.jelly-chat .act-blush { color: #ff8cc0; background: rgba(255, 95, 162, 0.18); }
.jelly-chat .act-blush > span { animation-name: act-glow; animation-duration: 1.8s; }
@keyframes act-wiggle { 0%, 100% { rotate: 0deg; } 25% { rotate: -10deg; } 75% { rotate: 10deg; } }
@keyframes act-bounce { 0%, 55%, 100% { translate: 0 0; } 25% { translate: 0 -5px; } 40% { translate: 0 1px; } }
@keyframes act-spin { 0%, 45% { rotate: 0deg; } 75%, 100% { rotate: 360deg; } }
@keyframes act-shiver { 0%, 100% { translate: 0 0; } 25% { translate: -0.7px 0.4px; } 75% { translate: 0.7px -0.4px; } }
@keyframes act-melt { 0%, 100% { translate: 0 0; scale: 1 1; } 50% { translate: 0 2px; scale: 1.12 0.78; } }
@keyframes act-glow { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

.jelly-chat .ghost {
  border: 0; background: transparent; color: var(--fg); font: inherit;
  display: grid; place-items: center; cursor: pointer; padding: 0;
}
.jelly-chat .ghost.pill { padding: 0 14px; }
.jelly-chat .ghost:disabled { cursor: default; opacity: 0.45; }
.jelly-chat .ghost:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; border-radius: 999px; }

.jelly-chat textarea {
  flex: 1; resize: none; border: 0; outline: none; background: transparent;
  color: var(--fg); font: inherit; padding: 10px 16px; max-height: 140px; box-sizing: border-box;
  caret-color: var(--fg);
}
.jelly-chat .field-wrap { flex: 1; position: relative; display: flex; }
.jelly-chat .hint {
  position: absolute; left: 16px; top: 10px; pointer-events: none; white-space: pre;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
}
.jelly-chat .hint span {
  display: inline-block; transform-origin: 50% 100%;
  animation: jelly-wave 2.8s ease-in-out infinite;
}
@keyframes jelly-wave {
  0%, 34%, 100% { transform: none; }
  8%  { transform: translateY(-4px) scale(0.9, 1.15); }
  17% { transform: translateY(1px) scale(1.1, 0.9); }
  25% { transform: translateY(-1px) scale(0.98, 1.02); }
}

.jelly-chat .drop {
  position: absolute; top: 8px; width: 17px; height: 17px; margin-left: -8px;
  border-radius: 50%; background: var(--fill);
  animation: jelly-drip 4.2s ease-in-out infinite;
}
.jelly-chat.busy .drop { animation-duration: 1.3s; }

.jelly-chat .bubble {
  border-radius: 18px 18px 6px 18px; transform-origin: 100% 100%;
  animation: jelly-pop 0.55s cubic-bezier(0.3, 1.7, 0.5, 1) both, jelly-shape 5s ease-in-out infinite;
}
/* The composer and the words in it jiggle as a message leaves. Both layers
   run it from the same frame, on the individual translate/scale properties,
   so it stacks on the ooze and breathing rather than replacing them. */
.jelly-chat .composer.shake > * { animation: jelly-send 0.6s cubic-bezier(0.3, 0.8, 0.4, 1); }

.jelly-chat .wob-a { animation: jelly-breathe 2.7s ease-in-out infinite; }
.jelly-chat .wob-b { animation: jelly-breathe 3.3s ease-in-out -1.1s infinite; }
.jelly-chat .wob-wide { animation: jelly-breathe-wide 3.8s ease-in-out infinite; }

@keyframes jelly-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.06, 0.93); } }
@keyframes jelly-breathe-wide { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.006, 0.95); } }
@keyframes jelly-drip {
  0%, 100% { translate: 0 0; scale: 1; }
  45% { translate: 0 -20px; scale: 0.8; }
  62% { translate: 0 -23px; scale: 0.55; }
}
/* Out of the body: stretched thin as it leaves, overshoots, settles. */
@keyframes jelly-ooze {
  0%   { transform: translateY(-58px) scale(0.35, 0.3); }
  45%  { transform: translateY(6px) scale(0.9, 1.18); }
  70%  { transform: translateY(-3px) scale(1.04, 0.92); }
  85%  { transform: translateY(1px) scale(0.99, 1.02); }
  100% { transform: none; }
}
/* The strand back up to the body: thick while it drips, then it thins and
   snaps. */
@keyframes jelly-neck {
  0%   { scale: 0.9 1.2; }
  50%  { scale: 0.7 1; }
  80%  { scale: 0.18 0.7; }
  100% { scale: 0 0; }
}
.jelly-chat .word {
  display: inline-block; transform-origin: 50% 100%;
  animation: jelly-word 0.5s cubic-bezier(0.3, 1.6, 0.5, 1) both;
}
.jelly-chat .thinking {
  display: inline-flex; gap: 2px; padding: 8px 4px; filter: url(#jelly-goo-small);
}
.jelly-chat .thinking i {
  width: 10px; height: 10px; border-radius: 50%; background: currentColor; display: block;
  animation: jelly-bob 0.9s ease-in-out infinite;
}
.jelly-chat .thinking i:nth-child(2) { animation-delay: 0.12s; }
.jelly-chat .thinking i:nth-child(3) { animation-delay: 0.24s; }
@keyframes jelly-word {
  0%   { opacity: 0; transform: translateY(-9px) scale(0.7, 1.35); }
  55%  { opacity: 1; transform: translateY(1px) scale(1.15, 0.8); }
  100% { opacity: 1; transform: none; }
}
@keyframes jelly-bob {
  0%, 100% { transform: translateY(0) scale(1.15, 0.85); }
  45%      { transform: translateY(-9px) scale(0.85, 1.15); }
}
@keyframes jelly-send {
  0%   { translate: 0 0; scale: 1 1; }
  14%  { translate: -5px 1px; scale: 1.03 0.9; }
  30%  { translate: 4px -1px; scale: 0.98 1.06; }
  46%  { translate: -3px 0; scale: 1.01 0.97; }
  62%  { translate: 2px 0; scale: 1 1.01; }
  80%  { translate: -1px 0; scale: 1 1; }
  100% { translate: 0 0; scale: 1 1; }
}
@keyframes jelly-pop {
  0%   { scale: 0.4; opacity: 0; }
  60%  { opacity: 1; }
  100% { scale: 1; opacity: 1; }
}
@keyframes jelly-shape {
  0%, 100% { border-radius: 18px 18px 6px 18px; }
  50% { border-radius: 20px 15px 8px 21px; }
}
.jelly-chat .smile-letter { opacity: 0; animation: jelly-letter 0.35s ease-out forwards; }
@keyframes jelly-letter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .jelly-chat .smile-letter { animation: none; opacity: 1; }
  .jelly-chat .wob-a, .jelly-chat .wob-b, .jelly-chat .wob-wide,
  .jelly-chat .drop, .jelly-chat .bubble, .jelly-chat .composer.ooze, .jelly-chat .ooze .neck,
  .jelly-chat .composer.shake > *, .jelly-chat .word, .jelly-chat .thinking i,
  .jelly-chat .hint span, .jelly-chat .act, .jelly-chat .act > span { animation: none; }
}
`;
