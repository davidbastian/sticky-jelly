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
 */
const fs = require('node:fs');
const { safeStorage } = require('electron');
const Anthropic = require('@anthropic-ai/sdk').default;

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

Sometimes the user talks to you out loud and hears your reply spoken. Write so it sounds natural read aloud.`;

function createAssistant({ keyPath }) {
  let history = [];
  let current = null;   // the in-flight stream, so it can be stopped

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

    /* The text of the conversation so far, for a page that reloads. */
    transcript() {
      return history.map(m => ({
        role: m.role,
        text: typeof m.content === 'string'
          ? m.content
          : m.content.filter(b => b.type === 'text').map(b => b.text).join(''),
      }));
    },

    reset() { current?.abort(); history = []; },

    stop() { current?.abort(); },

    /*
     * One turn. Text arrives through onDelta as it streams; the promise
     * resolves when the reply is complete, or with an error message to show
     * in its place.
     */
    async send(text, model, onDelta) {
      history.push({ role: 'user', content: text });
      let stream;
      try {
        const c = client();
        const params = {
          model: MODELS[model] ? model : DEFAULT_MODEL,
          max_tokens: 16000,
          system: SYSTEM,
          messages: history,
          /* Chat rarely needs deep thinking, and low effort answers sooner. */
          output_config: { effort: 'low' },
          cache_control: { type: 'ephemeral' },
        };
        /* Sonnet and Opus can hand a declined request to another model
           server-side; Haiku has no fallback, so it uses the plain endpoint. */
        stream = params.model === 'claude-haiku-5-5'
          ? c.messages.stream(params)
          : c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
        current = stream;
        stream.on('text', (delta) => onDelta(delta));
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') {
          history.pop();
          return { error: "That's not something I can help with." };
        }
        /* Exactly as returned — see the note at the top. */
        history.push({ role: 'assistant', content: msg.content });
        return { ok: true };
      } catch (err) {
        if (stream?.aborted || err instanceof Anthropic.APIUserAbortError) {
          history.pop();
          return { stopped: true };
        }
        history.pop();
        return { error: explain(err) };
      } finally {
        current = null;
      }
    },
  };
}

module.exports = { createAssistant };
