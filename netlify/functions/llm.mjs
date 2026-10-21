// Netlify Function: /api/llm
// Holds the AI provider key on the server and only runs fixed tasks:
//   extract   step 3  pull values + quotes from the pitch
//   worlds    step 4  good / neutral / worst world with explicit assumptions
//   challenge step 7  devil's advocate
//   peers     step 6  live web search for comparable startups (OpenRouter only)
// The browser never sees the key and cannot send its own prompts, so the endpoint
// can't be used as a free chatbot.
//
// Environment variables (Netlify → Project configuration → Environment variables):
//   LLM_PROVIDER   mistral (default) | gemini | openai | anthropic | openrouter
//   LLM_API_KEY    the provider's API key (required)
//   LLM_MODEL      optional; overrides the default model for the provider
//   APP_PASSCODE   optional; if set, users must enter it before AI calls work
//   WEB_SEARCH     optional; set to "off" to disable the live web search button

import {
  EXTRACT_SYSTEM, buildExtractUser, CHALLENGE_SYSTEM, buildChallengeUser,
  WORLDS_SYSTEM, buildWorldsUser, PEERS_SYSTEM, buildPeersUser,
} from '../../public/js/prompts.js';

const DEFAULT_MODELS = {
  mistral: 'mistral-small-latest',
  gemini: 'gemini-flash-latest',
  openai: 'gpt-5-mini',
  anthropic: 'claude-haiku-5-5',
  openrouter: 'openrouter/auto',
};

const MAX_PITCH_CHARS = 60000; // a full pitch deck as text; keep in sync with public/js/app.js
const MAX_PAYLOAD_CHARS = 20000;
// Netlify stops synchronous functions after 60 s; leave room for the response
const TIMEOUT_MS = { extract: 40000, challenge: 40000, worlds: 52000, peers: 52000 };

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? '').trim();

function readSettings() {
  const provider = (env('LLM_PROVIDER') || 'mistral').toLowerCase();
  return {
    provider,
    model: env('LLM_MODEL') || DEFAULT_MODELS[provider] || '',
    key: env('LLM_API_KEY'),
    passcode: env('APP_PASSCODE'),
    webSearch: provider === 'openrouter' && env('WEB_SEARCH').toLowerCase() !== 'off',
  };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// ---------- provider calls: each returns { text, citations } ----------
async function callOpenAICompatible(url, cfg, system, user, { jsonMode = true, extraHeaders = {}, timeout, webSearch = false } = {}) {
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (webSearch) body.plugins = [{ id: 'web', max_results: 6 }];
  // gpt-5 family only accepts the default temperature
  if (!/(^|\/)gpt-5/.test(cfg.model)) body.temperature = 0;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}`, ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || data?.message || `Provider returned HTTP ${r.status}`);
  const msg = data?.choices?.[0]?.message || {};
  const citations = (msg.annotations || [])
    .filter((a) => a?.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title || '' }));
  return { text: msg.content ?? '', citations };
}

async function callGemini(cfg, system, user, { timeout }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Provider returned HTTP ${r.status}`);
  return { text: (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''), citations: [] };
}

async function callAnthropic(cfg, system, user, { timeout }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4000,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Provider returned HTTP ${r.status}`);
  return { text: (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), citations: [] };
}

async function callModel(cfg, system, user, opts) {
  switch (cfg.provider) {
    case 'mistral':
      return callOpenAICompatible('https://api.mistral.ai/v1/chat/completions', cfg, system, user, opts);
    case 'openai':
      return callOpenAICompatible('https://api.openai.com/v1/chat/completions', cfg, system, user, opts);
    case 'openrouter':
      // not every model behind OpenRouter supports JSON mode, so rely on the prompt
      return callOpenAICompatible('https://openrouter.ai/api/v1/chat/completions', cfg, system, user, {
        ...opts,
        jsonMode: false,
        extraHeaders: { 'X-Title': 'Startup investment decision tool' },
      });
    case 'gemini':
      return callGemini(cfg, system, user, opts);
    case 'anthropic':
      return callAnthropic(cfg, system, user, opts);
    default:
      throw new Error(`Unknown LLM_PROVIDER "${cfg.provider}". Use mistral, gemini, openai, anthropic or openrouter.`);
  }
}

function parseJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('The AI did not return valid JSON. Try again.');
}

const tooLong = (s, max) => typeof s === 'string' && s.length > max;

// ---------- handler ----------
export default async (req) => {
  const cfg = readSettings();

  if (req.method === 'GET') {
    return json(200, {
      configured: Boolean(cfg.key),
      provider: cfg.provider,
      model: cfg.model,
      passcodeRequired: Boolean(cfg.passcode),
      webSearch: cfg.webSearch,
    });
  }
  if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });

  if (!cfg.key) return json(503, { error: 'The AI service is not set up yet. Add LLM_API_KEY in the Netlify environment variables and redeploy.' });
  if (cfg.passcode && req.headers.get('x-app-passcode') !== cfg.passcode) {
    return json(401, { error: 'Wrong or missing passcode.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Request body must be JSON.' }); }
  const p = body.payload || {};

  let system; let user; let webSearch = false;
  if (body.task === 'extract') {
    const { pitchText, options, redFlags } = p;
    if (typeof pitchText !== 'string' || !pitchText.trim()) return json(400, { error: 'Paste the pitch text first.' });
    if (tooLong(pitchText, MAX_PITCH_CHARS)) return json(413, { error: `Pitch text is too long (max ${MAX_PITCH_CHARS} characters). Remove sections that are not relevant (team photos, legal text) and try again.` });
    if (!options?.sectors || !options?.stages || !options?.regions || !Array.isArray(redFlags)) return json(400, { error: 'Missing fund options.' });
    system = EXTRACT_SYSTEM;
    user = buildExtractUser({ pitchText, options, redFlags });
  } else if (body.task === 'challenge') {
    if (JSON.stringify(p).length > MAX_PAYLOAD_CHARS) return json(413, { error: 'Case data is too large.' });
    system = CHALLENGE_SYSTEM;
    user = buildChallengeUser(p);
  } else if (body.task === 'worlds') {
    if (typeof p.pitchText !== 'string' || !p.pitchText.trim()) return json(400, { error: 'The case has no pitch text.' });
    if (tooLong(p.pitchText, MAX_PITCH_CHARS)) return json(413, { error: 'Pitch text is too long.' });
    if (JSON.stringify({ ...p, pitchText: '' }).length > MAX_PAYLOAD_CHARS) return json(413, { error: 'Case data is too large.' });
    system = WORLDS_SYSTEM;
    user = buildWorldsUser(p);
  } else if (body.task === 'peers') {
    if (!cfg.webSearch) {
      return json(400, { error: cfg.provider === 'openrouter'
        ? 'Live web search is switched off (WEB_SEARCH=off).'
        : 'Live web search needs OpenRouter. Set LLM_PROVIDER to openrouter in Netlify.' });
    }
    if (JSON.stringify(p).length > 4000) return json(413, { error: 'Search request is too large.' });
    system = PEERS_SYSTEM;
    user = buildPeersUser(p);
    webSearch = true;
  } else {
    return json(400, { error: 'Unknown task.' });
  }

  try {
    const out = await callModel(cfg, system, user, { timeout: TIMEOUT_MS[body.task], webSearch });
    const result = parseJson(out.text);
    return json(200, { result, citations: out.citations, provider: cfg.provider, model: cfg.model });
  } catch (err) {
    const msg = err?.name === 'TimeoutError'
      ? 'The AI took too long to answer. Try again in a moment.'
      : `AI request failed: ${err?.message || err}`;
    return json(502, { error: msg });
  }
};

export const config = { path: '/api/llm' };
