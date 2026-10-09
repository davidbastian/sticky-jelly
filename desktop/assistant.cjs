/*
 * The chat behind the sidebar.
 *
 * The conversation lives here, in the shell, not in the page: every reply is
 * kept exactly as the API returned it — thinking blocks included — and sent
 * back unchanged on the next turn, which is what lets the model keep its
 * reasoning across the conversation. The page only ever sees the text.
 *
 * The API key is the user's own. It is typed into Settings, encrypted with the
 * Keychain-backed safeStorage, and never leaves this process except to
 * Anthropic.
 *
 * It can act on the Mac (desktop/tools.cjs): a turn may be several requests —
 * Claude asks for tools, the shell runs them and sends the results back —
 * until it has its answer. The web search runs on Anthropic's side.
 */
const fs = require('node:fs');
const { safeStorage } = require('electron');
const Anthropic = require('@anthropic-ai/sdk').default;
const tools = require('./tools.cjs');

const MODELS = {
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
};
const DEFAULT_MODEL = 'claude-haiku-5-5';

/* Never changes mid-conversation: an edited system prompt would invalidate
   the thinking blocks already in the history. */
const SYSTEM = `You are Sticky Jelly: a small, soft, black jelly creature that lives on the user's Mac desktop. When they press and hold you, you stretch into a sidebar and become their assistant.

Be genuinely helpful first and a jelly second — a light, warm personality is welcome, but never at the expense of a useful answer. Keep replies short by default and go longer only when the question needs it.

The sidebar is narrow (about 380 pixels) and shows plain text. Write in short paragraphs. Simple "-" bullet lists and \`inline code\` are fine; avoid headings, tables and wide code blocks.

You have a body, and you can use it. When it suits the moment, include one short action between single asterisks — like *wiggles*, *bounces*, *blushes*, *spins*, *shivers* or *melts a little* — and your body really does it on the user's screen. One action at most per reply, often none, and never on serious or sad topics. Never use asterisks for anything else.

Sometimes the user talks to you out loud and hears your reply spoken. Write so it sounds natural read aloud.

You can do things on the user's Mac with your tools: open apps, folders and files; find files; look in and tidy folders; read their calendar and reminders and add to them; set timers; change the volume or dark mode; use the clipboard; and search the web. Use them whenever they help — don't describe how the user could do it themselves when you can just do it. Paths are inside the user's home folder (~). Look before you change things: list a folder before organising it, and put every move for a task into one organize_files call. Anything that changes something is shown to the user to approve, so don't ask for permission in words first; if they decline, accept it and move on. Never trash anything unless they asked. Each message starts with the user's current local date and time; use it for "today", "tomorrow" and so on. After using tools, say briefly what you did.`;

/* Haiku takes the basic web search; the newer one (which filters results
   itself) is for Sonnet and Opus. */
const webSearch = (model) => ({
  type: model === 'claude-haiku-5-5' ? 'web_search_20250305' : 'web_search_20260209',
  name: 'web_search',
  max_uses: 3,
});

/* Prepended to every message, so "tomorrow" means something. */
function now() {
  const d = new Date();
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `(Now: ${day}, ${time}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}; ${iso})`;
}

function createAssistant({ keyPath }) {
  let history = [];
  let current = null;   // the in-flight stream, so it can be stopped
  let halted = false;   // Stop pressed: end the turn, even between requests

  const readKey = () => {
    try {
      const buf = fs.readFileSync(keyPath);
      return safeStorage.decryptString(buf);
    } catch { return null; }
  };

  function client() {
    const key = readKey();
    if (key) return new Anthropic({ apiKey: key });
    /* No saved key: fall back to whatever the SDK finds (ANTHROPIC_API_KEY,
       an `ant auth login` profile). If there is nothing, it throws here. */
    return new Anthropic();
  }

  function explain(err) {
    if (err instanceof Anthropic.AuthenticationError) return 'That API key was not accepted. Check it in Settings › Assistant.';
    if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model. Check your Anthropic Console.';
    if (err instanceof Anthropic.RateLimitError) return 'Too many requests just now — try again in a moment.';
    if (err instanceof Anthropic.BadRequestError && /credit|billing/i.test(err.message)) return 'Your Anthropic account is out of credit. Add some under Billing in the Anthropic Console.';
    if (err instanceof Anthropic.APIConnectionError) return 'I could not reach Anthropic. Are you online?';
    if (err instanceof Anthropic.APIError) return `Something went wrong on Anthropic's side (${err.status ?? 'error'}). Try again.`;
    if (/api ?key|credentials|auth/i.test(String(err && err.message))) return 'Add your Anthropic API key in Settings › Assistant to start chatting.';
    return 'Something went wrong. Try again.';
  }

  return {
    models: MODELS,
    defaultModel: DEFAULT_MODEL,

    hasKey: () => !!readKey(),
    saveKey(key) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available');
      fs.writeFileSync(keyPath, safeStorage.encryptString(key.trim()), { mode: 0o600 });
    },
    removeKey() { try { fs.unlinkSync(keyPath); } catch { /* already gone */ } },

    /* The text of the conversation so far, for a page that reloads: what
       was said, without the timestamps, tool calls or tool results. */
    transcript() {
      const lines = [];
      for (const m of history) {
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        const text = blocks.filter(b => b.type === 'text' && !b.text.startsWith('(Now:')).map(b => b.text).join('');
        if (text.trim()) lines.push({ role: m.role, text });
      }
      return lines;
    },

    reset() { halted = true; current?.abort(); history = []; },

    stop() { halted = true; current?.abort(); },

    /*
     * One turn. Text arrives through onDelta as it streams, from however many
     * requests the turn takes; each tool shows up through onTool as it runs.
     * `confirm` puts a change in front of the user and resolves true or false.
     * The promise resolves when the reply is complete, or with an error
     * message to show in its place.
     */
    async send(text, model, { onDelta, onTool, confirm, onTimer }) {
      const base = history.length;
      halted = false;
      history.push({ role: 'user', content: [{ type: 'text', text: now() }, { type: 'text', text }] });
      const chosen = MODELS[model] ? model : DEFAULT_MODEL;
      const ctx = { confirm, onTimer };
      let stream;
      let pendingTools = null;   // tool_use blocks sent but not yet answered
      try {
        const c = client();
        for (let round = 0; round < 10; round++) {
          const params = {
            model: chosen,
            max_tokens: 16000,
            system: SYSTEM,
            messages: history,
            tools: [...tools.definitions(), webSearch(chosen)],
            /* Chat rarely needs deep thinking, and low effort answers sooner. */
            output_config: { effort: 'low' },
            cache_control: { type: 'ephemeral' },
          };
          /* Sonnet and Opus can hand a declined request to another model
             server-side; Haiku has no fallback, so it uses the plain endpoint. */
          stream = chosen === 'claude-haiku-5-5'
            ? c.messages.stream(params)
            : c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
          current = stream;
          stream.on('text', (delta) => onDelta(delta));
          /* The web search runs on Anthropic's side; show it as it happens. */
          stream.on('streamEvent', (ev) => {
            if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use') {
              onTool({ id: ev.content_block.id, label: 'Searching the web', state: 'running' });
            } else if (ev.type === 'content_block_start' && ev.content_block.type === 'web_search_tool_result') {
              onTool({ id: ev.content_block.tool_use_id, label: 'Searching the web', state: 'done' });
            }
          });
          const msg = await stream.finalMessage();
          current = null;

          if (msg.stop_reason === 'refusal') {
            history.length = base;
            return { error: "That's not something I can help with." };
          }
          /* Exactly as returned — see the note at the top. */
          history.push({ role: 'assistant', content: msg.content });

          // The server paused its own search loop: send it straight back.
          if (msg.stop_reason === 'pause_turn') continue;

          const uses = msg.content.filter(b => b.type === 'tool_use');
          if (msg.stop_reason !== 'tool_use' || !uses.length) return { ok: true };

          // A reply cut off mid-tool-call can't be trusted to run.
          if (msg.stop_reason === 'max_tokens') {
            history.push({ role: 'user', content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Cut off before the input was complete; not run.' })) });
            return { ok: true };
          }

          // One at a time, so approvals come one card after another.
          pendingTools = uses;
          const results = [];
          for (const u of uses) {
            const label = tools.labelFor(u);
            onTool({ id: u.id, label, state: 'running' });
            const result = await tools.execute(u, ctx);
            const failed = !!result.error;
            onTool({ id: u.id, label, state: result.declined ? 'declined' : failed ? 'error' : 'done' });
            results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result), ...(failed ? { is_error: true } : {}) });
          }
          pendingTools = null;
          // Every result in one message.
          history.push({ role: 'user', content: results });
          if (halted) return { stopped: true };
        }
        return { ok: true };
      } catch (err) {
        const aborted = stream?.aborted || err instanceof Anthropic.APIUserAbortError;
        if (pendingTools) {
          // Tool calls must always be answered, even when stopped midway.
          history.push({ role: 'user', content: pendingTools.map(u => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Stopped by the user.' })) });
        } else if (history.length === base + 1) {
          history.length = base;   // nothing came back at all: forget the question
        }
        return aborted ? { stopped: true } : { error: explain(err) };
      } finally {
        current = null;
      }
    },
  };
}

module.exports = { createAssistant };
