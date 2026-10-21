// app.js — the user interface. Calculations live in model.js, AI prompts in
// prompts.js, and the AI call itself in the Netlify function (/api/llm).
import * as M from './model.js';
import { SAMPLES, sampleById } from './samples.js';
import { EXTRACT_SYSTEM, EXTRACT_FIELDS_SPEC, CHALLENGE_SYSTEM, WORLDS_SYSTEM } from './prompts.js';
import * as B from './benchmarks.js';
import * as MX from './metrics.js';
import { normText, processPeers, processWorlds } from './aichecks.js';
import { readPitchFile, ACCEPT, MAX_FILE_MB } from './fileread.js';

const API = '/api/llm';
const MAX_PITCH_CHARS = 60000; // keep in sync with netlify/functions/llm.mjs

// ---------- storage (browser only; export/import moves data between people) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(`sdt.${k}`); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`sdt.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(`sdt.${k}`); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(`sdt.${k}`, v); } catch { /* ignore */ } },
};

function loadSettings() {
  const saved = store.get('settings', null);
  const d = M.defaultSettings();
  if (!saved) return d;
  return { ...d, ...saved, options: { ...d.options, ...saved.options }, allowed: { ...d.allowed, ...saved.allowed },
    fragility: { ...d.fragility, ...saved.fragility }, defaults: { ...d.defaults, ...saved.defaults } };
}

const state = {
  settings: loadSettings(),
  draft: null,
  cases: store.get('cases', []),
  activeId: store.get('activeId', null),
  log: store.get('log', []),
  step: 2,
  ai: { checked: false, live: false, label: 'Checking AI…', reason: '' },
  busy: null,
  error: null,
  needPasscode: false,
  whatIf: null,
  confirmReset: false,
  decisionError: null,
  fileBusy: null,
  fileError: null,
  yc: null,
  ycError: null,
  bench: { sector: 'Fintech', region: 'all', q: '' },
  metricsExample: true,
};

function save() {
  store.set('settings', state.settings);
  store.set('cases', state.cases);
  store.set('activeId', state.activeId);
  store.set('log', state.log);
}

// ---------- formatting helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const isEmpty = (v) => v === null || v === undefined || v === '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (m) => { const d = new Date(); d.setMonth(d.getMonth() + Number(m || 0)); return d.toISOString().slice(0, 10); };

function fmtEur(x) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  const neg = x < 0; const a = Math.abs(x);
  let s;
  if (a >= 1e6) s = `€${(a / 1e6).toFixed(2).replace(/\.?0+$/, '')}m`;
  else if (a >= 1e3) s = `€${Math.round(a / 1e3)}k`;
  else s = `€${Math.round(a)}`;
  return (neg ? '−' : '') + s;
}
const pct = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const fmtInt = (x) => (isEmpty(x) ? '—' : Number(x).toLocaleString('en-US'));
const fmtFull = (x) => (isEmpty(x) ? '' : Number(x).toLocaleString('en-US'));

function fmtField(k, v) {
  if (isEmpty(v)) return '—';
  const t = M.FIELD_META[k].type;
  if (t === 'eur') return fmtEur(v);
  if (t === 'int') return fmtInt(v);
  return esc(v);
}

// Accepts "5m", "€500k", "5,000,000", "5.000.000", "21000", "1.5 mio"
function parseMoney(str) {
  if (typeof str === 'number') return str;
  let s = String(str ?? '').trim().toLowerCase().replace(/€|eur|euro|\s/g, '');
  if (!s) return null;
  const m = s.match(/^(-?[\d.,]+)(k|tsd|m|mn|mio|million|bn|b|mrd)?$/);
  if (!m) return NaN;
  let num = m[1];
  const hasComma = num.includes(','); const hasDot = num.includes('.');
  if (hasComma && hasDot) {
    num = num.indexOf(',') < num.indexOf('.') ? num.replace(/,/g, '') : num.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    num = /^\d{1,3}(,\d{3})+$/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.');
  } else if (hasDot) {
    num = /^\d{1,3}(\.\d{3})+$/.test(num) ? num.replace(/\./g, '') : num;
  }
  let v = Number(num);
  const mult = { k: 1e3, tsd: 1e3, m: 1e6, mn: 1e6, mio: 1e6, million: 1e6, bn: 1e9, b: 1e9, mrd: 1e9 }[m[2]] || 1;
  v *= mult;
  return Number.isFinite(v) ? v : NaN;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- cases ----------
function activeCase() { return state.cases.find((c) => c.id === state.activeId) || null; }

function makeCase(sampleId = null) {
  const c = M.newCase(state.settings);
  c.confirmed = {};
  if (sampleId) {
    const s = sampleById(sampleId);
    c.sampleId = s.id; c.pitchText = s.pitch; c.label = s.name;
  }
  state.cases.unshift(c);
  state.activeId = c.id;
  state.whatIf = null; state.error = null; state.needPasscode = false; state.fileError = null;
  save();
  return c;
}

function caseName(c) { return c.values?.company_name || c.label || 'Untitled case'; }

// ---------- workflow state ----------
const STEPS = [
  { n: 1, name: 'Set fund rules', q: 'What does our fund want, and what are the rules of the game?', actor: 'human', who: 'Human' },
  { n: 2, name: 'Submit startup', q: 'Which startup are we looking at?', actor: 'human', who: 'Human' },
  { n: 3, name: 'AI extracts inputs', q: 'What are the key facts in this pitch?', actor: 'ai', who: 'AI (LLM)' },
  { n: 4, name: 'Verify and score', q: 'Are these facts right, and how good is this startup?', actor: 'human', who: 'Human' },
  { n: 5, name: 'Screening', q: 'Is this startup even eligible for our fund?', actor: 'code', who: 'Code (fixed rules)' },
  { n: 6, name: 'Analysis', q: 'How good is it, what could we earn, and what should we do?', actor: 'code', who: 'Code (fixed rules)' },
  { n: 7, name: 'AI challenge', q: 'What could we be getting wrong?', actor: 'ai', who: 'AI (LLM)' },
  { n: 8, name: 'Committee decides', q: 'What do we actually do?', actor: 'human', who: 'Human' },
  { n: 9, name: 'Log and monitor', q: 'Did it work out, and what do we learn?', actor: 'data', who: 'System + Human' },
];
const TAG = { human: 'tag-human', ai: 'tag-ai', code: 'tag-code', data: 'tag-data' };

function flow(c) {
  const f = { hasPitch: false, extracted: false, verifyOk: false, verified: false, result: null, screenPass: false, decided: false };
  if (!c) return f;
  f.hasPitch = Boolean(c.pitchText && c.pitchText.trim());
  f.extracted = Boolean(c.extraction);
  f.miss = M.missingCheck(c.values);
  f.unconfirmed = M.FIELD_ORDER.filter((k) => !isEmpty(c.values[k]) && !c.confirmed?.[k]);
  const scoresOk = state.settings.criteria.every((cr) => c.scores[cr.id] >= 1 && c.scores[cr.id] <= 5);
  f.evErrors = f.miss.stop ? [] : M.evActions(c).errors || [];
  f.blockers = [];
  if (!f.extracted) f.blockers.push('Run the AI extraction (step 3) or enter the values manually.');
  if (f.miss.stop) f.blockers.push('Stop rule: research the missing inputs first.');
  if (f.unconfirmed.length) f.blockers.push(`Confirm ${f.unconfirmed.length} value${f.unconfirmed.length > 1 ? 's' : ''} against the pitch.`);
  if (!(c.ticket > 0)) f.blockers.push('Enter our ticket size.');
  if (!scoresOk) f.blockers.push('Score every criterion from 1 to 5.');
  if (f.evErrors.length) f.blockers.push(...f.evErrors);
  f.verifyOk = f.blockers.length === 0;
  f.verified = Boolean(c.verified) && f.verifyOk;
  if (f.verified) {
    f.result = M.evaluate(state.settings, c);
    f.screenPass = f.result.stage !== 'screened-out';
  }
  f.decided = Boolean(c.decisionId);
  return f;
}

function available(n, f) {
  if (n === 'bench' || n === 'metrics') return true;
  switch (n) {
    case 1: case 2: case 9: return true;
    case 3: return f.hasPitch;
    case 4: return f.extracted;
    case 5: case 8: return f.verified;
    case 6: case 7: return f.verified && f.screenPass;
    default: return false;
  }
}

function dueReviews() {
  const t = today();
  return state.log.filter((r) => r.status === 'open' && r.decision.reviewDate && r.decision.reviewDate <= t);
}

// ---------- AI ----------
async function checkAI() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(API, { signal: ctrl.signal });
    clearTimeout(timer);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('json')) throw new Error('no function');
    const d = await r.json();
    if (d.configured) {
      state.ai = { checked: true, live: true, label: `AI: ${d.provider} · ${d.model}`, passcodeRequired: d.passcodeRequired, webSearch: Boolean(d.webSearch), reason: '' };
    } else {
      state.ai = { checked: true, live: false, label: 'AI: key not set',
        reason: 'The AI service is not set up yet. Add LLM_API_KEY in the Netlify environment variables and redeploy. Until then, the sample pitches use saved example answers.' };
    }
  } catch {
    state.ai = { checked: true, live: false, label: 'AI: demo mode',
      reason: 'No AI service is connected here (this is a preview without the server function). The sample pitches use saved example answers. On the deployed Netlify site with an API key, the live AI is used.' };
  }
  renderTop();
  if ([4, 6].includes(state.step)) render();
}

async function callAI(task, payload, cached) {
  if (!state.ai.live) {
    if (cached) { await sleep(800); return { result: clone(cached), source: 'cached', model: 'saved example answer' }; }
    throw new Error(`${state.ai.reason || 'No AI service is connected.'} This pitch has no saved example answer.`);
  }
  const headers = { 'content-type': 'application/json' };
  const pc = session.get('passcode');
  if (pc) headers['x-app-passcode'] = pc;
  const r = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ task, payload }) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { state.needPasscode = true; throw new Error(data.error || 'This site needs a passcode before the AI can be used.'); }
  if (!r.ok) throw new Error(data.error || `The AI service returned an error (HTTP ${r.status}).`);
  return { result: data.result, citations: data.citations || [], source: 'live', model: `${data.provider} · ${data.model}` };
}

function processExtraction(raw, pitch) {
  const S = state.settings;
  const np = normText(pitch);
  const fields = {};
  for (const k of M.FIELD_ORDER) {
    const meta = M.FIELD_META[k];
    const item = raw && typeof raw[k] === 'object' && raw[k] !== null ? raw[k] : { value: raw?.[k] ?? null, quote: null };
    let value = item.value;
    const quote = item.quote ? String(item.quote) : '';
    let status = null;
    if (isEmpty(value)) { value = null; status = 'missing'; } else {
      if (meta.type === 'eur' || meta.type === 'int') {
        const v = typeof value === 'number' ? value : parseMoney(String(value));
        value = Number.isFinite(v) ? v : null;
        if (value === null) status = 'missing';
      }
      if (!status && meta.type === 'choice' && !S.options[meta.options].includes(value)) status = 'invalid';
      if (!status) {
        if (!quote.trim()) status = 'no-quote';
        else if (!np.includes(normText(quote))) status = 'quote-mismatch';
        else status = 'found';
      }
    }
    fields[k] = { draft: value, value: status === 'found' ? value : null, quote, status };
  }
  const flags = Array.isArray(raw?.possible_red_flags) ? raw.possible_red_flags : [];
  const redFlags = flags
    .filter((x) => x && S.redFlags.includes(x.flag))
    .map((x) => ({ flag: x.flag, quote: String(x.quote || ''), verified: Boolean(x.quote) && np.includes(normText(x.quote)) }));
  return { fields, redFlags, notes: typeof raw?.notes === 'string' ? raw.notes : '' };
}

async function runExtraction() {
  const c = activeCase(); if (!c) return;
  const sample = c.sampleId ? sampleById(c.sampleId) : null;
  const cached = sample && sample.pitch === c.pitchText ? sample.cached.extract : null;
  state.busy = 'extract'; state.error = null; render();
  try {
    const S = state.settings;
    const out = await callAI('extract', { pitchText: c.pitchText, options: S.options, redFlags: S.redFlags }, cached);
    const p = processExtraction(out.result, c.pitchText);
    c.extraction = { ...p, source: out.source, model: out.model, at: new Date().toISOString(), pitchText: c.pitchText };
    applyExtraction(c);
    state.needPasscode = false;
  } catch (e) {
    state.error = { task: 'extract', message: e.message || String(e) };
  }
  state.busy = null; save(); render();
}

function applyExtraction(c) {
  const ex = c.extraction;
  c.values = Object.fromEntries(M.FIELD_ORDER.map((k) => [k, ex.fields[k].value]));
  c.sources = Object.fromEntries(M.FIELD_ORDER.map((k) => [k, { by: 'ai', quote: ex.fields[k].quote, status: ex.fields[k].status }]));
  c.confirmed = {};
  c.redFlagSuggestions = ex.redFlags;
  c.redFlags = [];
  c.ticket = c.values.raise_amount ?? null;
  c.verified = false;
  c.challenge = null;
  if (c.values.company_name) c.label = c.values.company_name;
}

function manualEntry() {
  const c = activeCase(); if (!c) return;
  const fields = Object.fromEntries(M.FIELD_ORDER.map((k) => [k, { draft: null, value: null, quote: '', status: 'manual' }]));
  c.extraction = { fields, redFlags: [], notes: 'Values entered manually by the analyst (no AI extraction).', source: 'manual', model: 'none', at: new Date().toISOString(), pitchText: c.pitchText };
  applyExtraction(c);
  state.error = null; state.step = 4; save(); render();
}

function challengePayload(c, r) {
  const S = state.settings;
  const A = r.ev.actions;
  return {
    fund_rules: { score_threshold: S.threshold, criteria_weights_percent: Object.fromEntries(S.criteria.map((cr) => [cr.name, cr.weight])) },
    startup: Object.fromEntries(M.FIELD_ORDER.map((k) => [M.FIELD_META[k].label, c.values[k]])),
    our_ticket_eur: c.ticket,
    our_ownership: +r.ev.ownership.toFixed(4),
    scores_1_to_5: Object.fromEntries(S.criteria.map((cr) => [cr.name, c.scores[cr.id]])),
    scenarios: {
      big_success: { probability: c.scenarios.pBig, exit_value_eur: c.scenarios.exitBig },
      moderate: { probability: c.scenarios.pMod, exit_value_eur: c.scenarios.exitMod },
      failure: { probability: +r.ev.pFail.toFixed(4), exit_value_eur: 0 },
      dilution_until_exit: c.dilutionToExit,
    },
    results: {
      score_out_of_100: +r.sc.score.toFixed(1),
      expected_value_eur: { invest_now: Math.round(A.now.ev), invest_in_tranches: Math.round(A.tranches.ev), wait_for_next_round: Math.round(A.wait.ev), pass: 0 },
      worst_case_loss_eur: { invest_now: A.now.worst, invest_in_tranches: A.tranches.worst, wait_for_next_round: A.wait.worst, pass: 0 },
      capital_paid_upfront_eur: { invest_now: A.now.upfront, invest_in_tranches: A.tranches.upfront },
    },
    tranche_plan: { first_tranche_eur: A.tranches.t1, second_tranche_eur: A.tranches.t2, milestone: c.tranche.milestone || 'not set', months: c.tranche.months },
    recommendation: M.ACTION_LABEL[r.recommendation.action],
    reasons: r.recommendation.reasons,
    switch_points: r.sens.points.map((p) => p.text),
  };
}

async function runChallenge() {
  const c = activeCase(); const f = flow(c);
  if (!f.result || f.result.stage !== 'analysed') return;
  const sample = c.sampleId ? sampleById(c.sampleId) : null;
  const cached = sample && sample.pitch === c.pitchText ? sample.cached.challenge : null;
  state.busy = 'challenge'; state.error = null; render();
  try {
    const payload = challengePayload(c, f.result);
    const out = await callAI('challenge', payload, cached);
    c.challenge = { result: out.result, source: out.source, model: out.model, at: new Date().toISOString(),
      basedOn: { score: f.result.sc.score, action: f.result.recommendation.action } };
    state.needPasscode = false;
  } catch (e) {
    state.error = { task: 'challenge', message: e.message || String(e) };
  }
  state.busy = null; save(); render();
}

// ---------- rendering: shell ----------
function renderTop() {
  const chip = document.getElementById('ai-chip');
  chip.textContent = state.ai.label;
  chip.className = `ai-chip ${state.ai.checked ? (state.ai.live ? 'live' : 'demo') : ''}`;
  chip.title = state.ai.live ? 'Live AI connected through the Netlify function' : state.ai.reason;

  const sel = document.getElementById('case-select');
  sel.innerHTML = state.cases.map((c) => `<option value="${esc(c.id)}" ${c.id === state.activeId ? 'selected' : ''}>${esc(caseName(c))}${c.decisionId ? ' (decided)' : ''}</option>`).join('');
}

function renderRail(c, f) {
  const due = dueReviews().length;
  const ol = document.getElementById('steps');
  ol.innerHTML = STEPS.map((s) => {
    const ok = available(s.n, f);
    let stateTxt = ''; let cls = ''; let done = false;
    if (s.n === 2 && f.hasPitch) done = true;
    if (s.n === 3 && f.extracted) { done = true; stateTxt = c.extraction.source === 'cached' ? 'Example' : ''; }
    if (s.n === 4 && f.extracted) {
      if (f.miss.stop) { stateTxt = 'Stop'; cls = 'stop'; } else if (f.verified) done = true;
    }
    if (s.n === 5 && f.verified) { done = true; stateTxt = f.screenPass ? 'Pass' : 'Fail'; cls = f.screenPass ? 'ok' : 'fail'; }
    if (s.n === 6 && f.verified && f.screenPass && f.result.stage === 'analysed') { done = true; stateTxt = M.ACTION_LABEL[f.result.recommendation.action].replace('Invest in ', '').replace('Wait for next round', 'Wait'); }
    if (s.n === 7 && c?.challenge) done = true;
    if (s.n === 8 && f.decided) done = true;
    if (s.n === 9 && due) { stateTxt = `${due} due`; cls = 'stop'; }
    const sub = s.n === 1 ? esc(state.settings.fundName) : esc(s.who);
    return `<li><button type="button" class="step-btn ${done ? 'done' : ''}" data-action="goto" data-step="${s.n}" data-actor="${s.actor}"
      ${s.n === state.step ? 'aria-current="step"' : ''} ${ok ? '' : 'disabled'}>
      <span class="step-num"><span>${s.n}</span></span>
      <span class="step-text"><span class="step-name">${esc(s.name)}</span><span class="step-sub">${sub}</span></span>
      <span class="step-state ${cls}">${esc(stateTxt)}</span></button></li>`;
  }).join('');
  const tools = [
    { id: 'bench', name: 'Sector benchmarks', sub: 'Startup database', icon: '▥' },
    { id: 'metrics', name: 'Performance metrics', sub: 'How well we decide', icon: '%' },
  ];
  document.getElementById('tools').innerHTML = tools.map((t) => `<li><button type="button" class="step-btn" data-action="goto" data-step="${t.id}" data-actor="tool" ${state.step === t.id ? 'aria-current="step"' : ''}>
    <span class="step-num"><span>${t.icon}</span></span>
    <span class="step-text"><span class="step-name">${esc(t.name)}</span><span class="step-sub">${esc(t.sub)}</span></span><span></span></button></li>`).join('');
}

function stepHead(n, extra = '') {
  const s = STEPS[n - 1];
  return `<div class="step-head">
    <div class="step-head-row"><span class="eyebrow">Step ${n} of 9</span><span class="tag ${TAG[s.actor]}">${esc(s.who)}</span>${extra}</div>
    <h1>${esc(s.q)}</h1>
  </div>`;
}

function decidedBanner(c) {
  if (!c?.decisionId) return '';
  const rec = state.log.find((r) => r.id === c.decisionId);
  return `<div class="banner banner-info"><div><strong>This case was decided${rec ? ` on ${esc(rec.decidedAt.slice(0, 10))}: ${esc(M.ACTION_LABEL[rec.decision.action])}` : ''}.</strong>
    <p>The decision record in step 9 is a fixed snapshot. Changes you make here are not added to it. Start a new case to assess the startup again.</p></div></div>`;
}

let lastFocus = null;
function render() {
  const c = activeCase();
  const f = flow(c);
  if (!available(state.step, f)) state.step = c ? 2 : 1;
  renderTop();
  renderRail(c, f);
  const main = document.getElementById('main');
  const focusId = document.activeElement?.id;
  const sel = document.activeElement && 'selectionStart' in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const views = { 1: viewRules, 2: viewSubmit, 3: viewExtract, 4: viewVerify, 5: viewScreen, 6: viewAnalysis, 7: viewChallenge, 8: viewDecide, 9: viewLog, bench: viewBench, metrics: viewMetrics };
  main.innerHTML = views[state.step](c, f);
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && main.contains(el)) {
      el.focus({ preventScroll: true });
      if (sel && 'setSelectionRange' in el) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
    }
  }
  lastFocus = focusId;
}

function goto(n) {
  state.step = n; state.error = null; state.decisionError = null; state.confirmReset = false;
  if (n === 1) state.draft = clone(state.settings);
  render();
  document.getElementById('main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---------- step 1: fund rules ----------
function viewRules() {
  const d = state.draft || (state.draft = clone(state.settings));
  const dirty = JSON.stringify(d) !== JSON.stringify(state.settings);
  const totalW = d.criteria.reduce((a, cr) => a + Number(cr.weight || 0), 0);
  const chipGroup = (key) => d.options[key].map((o) => `<button type="button" class="chip-toggle" data-action="toggle-allowed" data-key="${key}" data-val="${esc(o)}" aria-pressed="${d.allowed[key].includes(o)}">${esc(o)}</button>`).join('');
  const dd = d.defaults;
  const pctInput = (id, path, v, hint = '') => `<label class="field" for="${id}"><span>${hint}</span><div class="with-suffix"><input type="number" id="${id}" data-draft="${path}" data-kind="pct" min="0" max="100" step="1" value="${Math.round(v * 1000) / 10}"><span>%</span></div></label>`;
  return `${stepHead(1, `<span class="pill pill-neutral">Version ${d.version}${state.settings.updatedAt ? ` · saved ${esc(state.settings.updatedAt.slice(0, 10))}` : ''}</span>`)}
  <p class="lead muted">A partner defines the strategy once. Everything later is calculated from these settings, so changing a weight here changes every recommendation. Each decision record keeps a copy of the rules it was made under.</p>

  <section class="panel">
    <div class="panel-head"><h2>Hard constraints</h2><span class="hint">Yes/no checks in step 5. One “no” and the startup is out.</span></div>
    <label class="field" for="fund-name"><span>Fund name</span><input type="text" id="fund-name" data-draft="fundName" value="${esc(d.fundName)}"></label>
    <div class="stack"><span class="label-mono">Sectors we invest in</span><div class="chips">${chipGroup('sectors')}</div></div>
    <div class="stack"><span class="label-mono">Stages</span><div class="chips">${chipGroup('stages')}</div></div>
    <div class="stack"><span class="label-mono">Regions</span><div class="chips">${chipGroup('regions')}</div></div>
    <div class="grid-2">
      <label class="field" for="ticket-min"><span>Smallest ticket</span><input type="text" class="money" id="ticket-min" data-draft="ticketMin" data-kind="money" value="${fmtFull(d.ticketMin)}"><span class="hint">${fmtEur(d.ticketMin)}</span></label>
      <label class="field" for="ticket-max"><span>Largest ticket</span><input type="text" class="money" id="ticket-max" data-draft="ticketMax" data-kind="money" value="${fmtFull(d.ticketMax)}"><span class="hint">${fmtEur(d.ticketMax)}</span></label>
    </div>
    <label class="field" for="red-flags"><span>Red flags (one per line)</span><textarea id="red-flags" rows="5" data-draft="redFlags" data-kind="lines">${esc(d.redFlags.join('\n'))}</textarea><span class="hint">The AI suggests matching red flags from this list. The analyst confirms them in step 4.</span></label>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Criteria, weights and score anchors</h2>
      <span class="pill ${totalW === 100 ? 'pill-good' : 'pill-warn'}">Weights total ${totalW}%${totalW === 100 ? '' : ' · scaled to 100'}</span></div>
    <p class="small muted">Score = each 1–5 score × its weight, converted to /100 (a 5 on every criterion = 100). Anchors tell the analyst what a 1, 3 and 5 mean.</p>
    <div class="table-wrap anchors-table"><table>
      <thead><tr><th>Criterion</th><th class="num">Weight %</th><th>1 means</th><th>3 means</th><th>5 means</th><th></th></tr></thead>
      <tbody>${d.criteria.map((cr, i) => `<tr>
        <td><input type="text" id="cr-name-${i}" data-draft="criteria.${i}.name" value="${esc(cr.name)}" aria-label="Criterion name"></td>
        <td class="num" style="min-width:90px"><input type="number" id="cr-w-${i}" data-draft="criteria.${i}.weight" data-kind="num" min="0" max="100" step="1" value="${cr.weight}" aria-label="Weight"></td>
        ${[1, 3, 5].map((a) => `<td style="min-width:170px"><input type="text" id="cr-a${a}-${i}" data-draft="criteria.${i}.anchors.${a}" value="${esc(cr.anchors[a])}" aria-label="Anchor ${a}"></td>`).join('')}
        <td><button type="button" class="btn btn-small btn-ghost btn-danger" data-action="remove-criterion" data-i="${i}" ${d.criteria.length <= 2 ? 'disabled' : ''} aria-label="Remove ${esc(cr.name)}">Remove</button></td>
      </tr>`).join('')}</tbody></table></div>
    <div><button type="button" class="btn btn-small" data-action="add-criterion">Add criterion</button></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Decision rule</h2><span class="hint">Used by the code in step 6</span></div>
    <div class="grid-3">
      <label class="field" for="threshold"><span>Score threshold (/100)</span><input type="number" id="threshold" data-draft="threshold" data-kind="num" min="0" max="100" value="${d.threshold}"></label>
      ${pctInput('hu', 'highUncertaintyFailProb', d.highUncertaintyFailProb, 'High uncertainty if failure chance ≥')}
      ${pctInput('wt', 'waitTolerance', d.waitTolerance, 'Waiting “costs little” if EV drops ≤')}
      <label class="field" for="frag-score"><span>Fragile if a score change of ≤ … points flips it</span><input type="number" id="frag-score" data-draft="fragility.scorePoints" data-kind="num" min="0" max="4" step="1" value="${d.fragility.scorePoints}"></label>
      ${pctInput('frag-rel', 'fragility.relative', d.fragility.relative, 'Fragile if a numeric change of ≤ … flips it')}
    </div>
    <details><summary>The decision rule in full</summary>
      <div class="table-wrap"><table><thead><tr><th>Recommendation</th><th>When</th></tr></thead><tbody>
        <tr><td>Pass</td><td>Fails screening, or score below ${d.threshold}, or expected value ≤ 0.</td></tr>
        <tr><td>Wait for next round</td><td>Score and expected value pass, but 1–2 key inputs are still missing and waiting keeps at least ${pct(1 - d.waitTolerance)} of the expected value.</td></tr>
        <tr><td>Invest in tranches</td><td>Score ≥ ${d.threshold} and expected value &gt; 0, but failure chance ≥ ${pct(d.highUncertaintyFailProb)} or a switch point is within the fragility margin.</td></tr>
        <tr><td>Invest now</td><td>Score ≥ ${d.threshold}, expected value &gt; 0, uncertainty below the limit and no close switch point.</td></tr>
      </tbody></table></div>
    </details>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Default assumptions for new cases</h2><span class="hint">The analyst can change them per startup in step 4</span></div>
    <div class="grid-3">
      ${pctInput('dd-dil', 'defaults.dilutionToExit', dd.dilutionToExit, 'Dilution from now until exit')}
      ${pctInput('dd-t1', 'defaults.firstTrancheShare', dd.firstTrancheShare, 'First tranche, share of ticket')}
      <label class="field" for="dd-months"><span>Months until milestone review</span><input type="number" id="dd-months" data-draft="defaults.milestoneMonths" data-kind="num" min="1" max="36" value="${dd.milestoneMonths}"></label>
      ${pctInput('dd-ps', 'defaults.progressIfSuccess', dd.progressIfSuccess, 'Future winners that hit the milestone')}
      ${pctInput('dd-pf', 'defaults.progressIfFailure', dd.progressIfFailure, 'Future failures that still hit it')}
      <label class="field" for="dd-step"><span>Next-round valuation step-up (×)</span><input type="number" id="dd-step" data-draft="defaults.nextRoundStepUp" data-kind="num" min="1" step="0.1" value="${dd.nextRoundStepUp}"></label>
      ${pctInput('dd-alloc', 'defaults.allocationProb', dd.allocationProb, 'Chance we still get into the next round')}
      ${pctInput('dd-dn', 'defaults.dilutionAfterNextRound', dd.dilutionAfterNextRound, 'Dilution after the next round')}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Lessons from past decisions</h2><span class="tag tag-data">From step 9</span></div>
    ${d.lessons.length ? `<ul class="switch-list">${d.lessons.map((l) => `<li><span class="label-mono">${esc(l.date)}</span><span>${esc(l.text)}</span></li>`).join('')}</ul>` : '<p class="muted small">No lessons recorded yet. Add them in step 9 after reviewing past decisions, then adjust weights or anchors here.</p>'}
  </section>

  <div class="nav-row">
    <div class="row">
      <button type="button" class="btn btn-primary" data-action="save-rules" ${dirty ? '' : 'disabled'}>Save fund rules</button>
      <button type="button" class="btn" data-action="discard-rules" ${dirty ? '' : 'disabled'}>Discard changes</button>
      ${dirty ? '<span class="pill pill-warn">Unsaved changes</span>' : ''}
    </div>
    <button type="button" class="btn btn-ghost btn-danger" data-action="defaults-rules">${state.confirmReset === 'rules' ? 'Click again to restore defaults' : 'Restore default rules'}</button>
  </div>`;
}

function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = val;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }

// ---------- step 2: submit ----------
function pitchCount(c) {
  const n = (c?.pitchText || '').length;
  return `${n.toLocaleString('en-US')} / ${MAX_PITCH_CHARS.toLocaleString('en-US')} characters${n > MAX_PITCH_CHARS ? ' · too long: shorten it before sending' : ''}`;
}

function viewSubmit(c) {
  const files = c?.files || [];
  const tooLong = (c?.pitchText || '').length > MAX_PITCH_CHARS;
  return `${stepHead(2)}
  <p class="lead muted">Upload the pitch deck or other documents, paste the text, or pick a test pitch. The text below is exactly what the AI will read.</p>

  <section class="panel">
    <div class="panel-head"><h2>Upload pitch documents</h2><span class="hint">PDF, Word (.docx), PowerPoint (.pptx) or text · up to ${MAX_FILE_MB} MB each</span></div>
    <label class="dropzone ${state.fileBusy ? 'busy' : ''}" id="dropzone" for="pitch-files">
      <input type="file" id="pitch-files" accept="${ACCEPT}" multiple hidden>
      ${state.fileBusy
    ? `<span class="row"><span class="spinner" style="color:var(--human)"></span><span id="file-progress">${esc(state.fileBusy)}</span></span>`
    : `<strong>Drop files here or click to choose</strong><span class="small muted">The text is read in your browser. The file itself is not uploaded anywhere. Add a deck and a financial summary together if you have both.</span>`}
    </label>
    ${state.fileError ? `<div class="banner banner-stop"><div><strong>A file could not be read.</strong><p>${esc(state.fileError)}</p></div></div>` : ''}
    ${files.length ? `<div class="stack"><span class="label-mono">Read into this case</span>${files.map((f) => `<div class="row small"><span class="pill pill-good">✓ ${esc(f.name)}</span><span class="muted">${f.units ? `${f.units} ${f.unitName}${f.units === 1 ? '' : 's'} · ` : ''}${f.chars.toLocaleString('en-US')} characters</span></div>`).join('')}</div>` : ''}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Test pitches</h2><span class="hint">Loading one starts a new case</span></div>
    <div class="samples">
      ${SAMPLES.map((s) => `<button type="button" class="sample" data-action="load-sample" data-id="${s.id}" aria-pressed="${c?.sampleId === s.id}">
        <strong>${esc(s.name)}</strong><span class="small muted">${esc(s.tagline)}</span><span class="label-mono">${esc(s.purpose)}</span></button>`).join('')}
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Pitch text</h2><span class="hint" id="pitch-count">${pitchCount(c)}</span></div>
    <label class="field" for="pitch"><span class="sr-only" hidden>Pitch text</span>
      <textarea class="pitch" id="pitch" data-case="pitchText" placeholder="Upload a file above, or paste the pitch summary, deck text or financial summary here.">${esc(c?.pitchText || '')}</textarea></label>
    ${files.length ? '<p class="small muted">Check the text read from the files. Slide numbers and page numbers are kept so you can find each quote in the original. You can delete parts that are not relevant, such as team photos or legal boilerplate.</p>' : ''}
    ${c?.extraction && c.extraction.pitchText !== c.pitchText ? '<div class="banner banner-warn"><div><strong>The pitch text changed after the AI extraction.</strong><p>Run the extraction again so the values and quotes match the new text.</p></div></div>' : ''}
  </section>
  <div class="nav-row"><span></span>
    <button type="button" class="btn btn-ai" data-action="to-extract" ${c?.pitchText?.trim() && !tooLong ? '' : 'disabled'}>${c?.extraction && c.extraction.pitchText === c.pitchText ? 'Continue to AI extraction' : 'Send to AI for extraction'}</button>
  </div>`;
}

async function handleFiles(fileList) {
  const list = [...(fileList || [])];
  if (!list.length || state.fileBusy) return;
  let c = activeCase();
  // Start a fresh case unless the current one is an unsent draft of the user's own
  if (!c || c.sampleId || c.extraction || c.decisionId) {
    if (c && !c.pitchText.trim() && !c.decisionId) state.cases = state.cases.filter((x) => x.id !== c.id);
    c = makeCase();
  }
  c.files = c.files || [];
  state.fileError = null;
  const errors = [];
  for (const file of list) {
    state.fileBusy = `Reading ${file.name}…`; render();
    try {
      const r = await readPitchFile(file, (msg) => {
        state.fileBusy = `${file.name}: ${msg}`;
        const el = document.getElementById('file-progress');
        if (el) el.textContent = state.fileBusy;
      });
      const header = `=== From file: ${r.name} ===`;
      c.pitchText = c.pitchText.trim() ? `${c.pitchText.trim()}\n\n${header}\n${r.text}` : (list.length > 1 || c.files.length ? `${header}\n${r.text}` : r.text);
      c.files.push({ name: r.name, chars: r.chars, units: r.units, unitName: r.unitName, at: new Date().toISOString() });
      if (!c.label) c.label = r.name.replace(/\.[^.]+$/, '');
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  state.fileBusy = null;
  state.fileError = errors.length ? errors.join(' ') : null;
  save(); render();
  const ok = list.length - errors.length;
  if (ok) toast(`Read ${ok} file${ok > 1 ? 's' : ''}. Check the text, then send it to the AI.`);
}

// ---------- step 3: AI extraction ----------
const STATUS_PILL = {
  found: '<span class="pill pill-good">Found · quote checked</span>',
  missing: '<span class="pill pill-stop">Missing</span>',
  'no-quote': '<span class="pill pill-stop">No quote → missing</span>',
  'quote-mismatch': '<span class="pill pill-stop">Quote not in pitch → missing</span>',
  invalid: '<span class="pill pill-stop">Not an allowed option → missing</span>',
  manual: '<span class="pill pill-neutral">Enter manually</span>',
};

function errorBlock(task) {
  if (!state.error || state.error.task !== task) return '';
  return `<div class="banner banner-stop"><div><strong>The AI step did not run.</strong><p>${esc(state.error.message)}</p>
    ${state.needPasscode ? `<div class="row"><label class="field" for="passcode"><span>Site passcode</span><input type="text" id="passcode" autocomplete="off"></label><button type="button" class="btn btn-small" data-action="save-passcode">Save passcode</button></div>` : ''}
    <div class="row"><button type="button" class="btn btn-small" data-action="${task === 'extract' ? 'run-extract' : 'run-challenge'}">Try again</button>
    ${task === 'extract' ? '<button type="button" class="btn btn-small" data-action="manual-entry">Enter the values manually instead</button>' : ''}</div></div></div>`;
}

function promptDetails(kind) {
  if (kind === 'extract') {
    return `<details><summary>View the fixed instruction sent with every pitch</summary><pre class="prompt">${esc(EXTRACT_SYSTEM)}\n\nRequired output:\n${esc(EXTRACT_FIELDS_SPEC)}</pre></details>`;
  }
  return `<details><summary>View the fixed devil’s-advocate instruction</summary><pre class="prompt">${esc(CHALLENGE_SYSTEM)}</pre></details>`;
}

function viewExtract(c) {
  const ex = c.extraction;
  const busy = state.busy === 'extract';
  let body = '';
  if (busy) {
    body = `<section class="panel"><div class="row"><span class="spinner" style="color:var(--ai)"></span><span>${state.ai.live ? `Sending the pitch and the fixed instruction to ${esc(state.ai.label.replace('AI: ', ''))}…` : 'Loading the saved example answer…'}</span></div></section>`;
  } else if (!ex) {
    body = `<section class="panel">
      <p>The tool sends the pitch text plus a fixed instruction to the AI. The AI pulls out the values the model needs and quotes the sentence each one came from. Anything it cannot find is flagged as missing, never guessed.</p>
      <div class="row"><button type="button" class="btn btn-ai" data-action="run-extract">Run AI extraction</button>
      <button type="button" class="btn btn-ghost" data-action="manual-entry">Skip AI and enter values manually</button></div>
      ${promptDetails('extract')}</section>`;
  } else {
    const nFound = M.FIELD_ORDER.filter((k) => ex.fields[k].status === 'found').length;
    const rejected = M.FIELD_ORDER.filter((k) => ['no-quote', 'quote-mismatch', 'invalid'].includes(ex.fields[k].status)).length;
    body = `<section class="panel">
      <div class="panel-head"><h2>Draft table</h2>
        <div class="provenance">${ex.source === 'cached' ? '<span class="pill pill-warn">Saved example answer (no live AI here)</span>' : ex.source === 'manual' ? '<span class="pill pill-neutral">Manual entry</span>' : `<span class="pill pill-ai">Live AI · ${esc(ex.model)}</span>`}<span>${esc(new Date(ex.at).toLocaleString('en-GB'))}</span></div></div>
      <p class="small muted">${nFound} of ${M.FIELD_ORDER.length} values found with a supporting quote.${rejected ? ` ${rejected} value${rejected > 1 ? 's were' : ' was'} rejected because the quote was missing or not found in the pitch.` : ''} The code checks every quote against the pitch text: an extracted number without a matching quote is treated as missing.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Field</th><th>AI value</th><th>Supporting quote</th><th>Check</th></tr></thead>
        <tbody>${M.FIELD_ORDER.map((k) => {
          const fl = ex.fields[k];
          return `<tr><td>${esc(M.FIELD_META[k].label)}</td><td class="${M.FIELD_META[k].type === 'text' || M.FIELD_META[k].type === 'choice' ? '' : 'num'}">${fmtField(k, fl.draft)}</td>
            <td>${fl.quote ? `<span class="quote">${esc(fl.quote)}</span>` : '<span class="muted">—</span>'}</td><td>${STATUS_PILL[fl.status] || ''}</td></tr>`;
        }).join('')}</tbody></table></div>
      ${ex.redFlags.length ? `<div class="stack"><span class="label-mono">Possible red flags suggested by the AI</span>${ex.redFlags.map((r) => `<div><span class="pill pill-stop">${esc(r.flag)}</span> <span class="quote">${esc(r.quote)}</span></div>`).join('')}</div>` : '<p class="small muted">No red flags from the fund’s list were found in the pitch.</p>'}
      ${ex.notes ? `<div class="ai-card"><span class="label-mono">AI notes</span><p>${esc(ex.notes)}</p></div>` : ''}
      <div class="row"><button type="button" class="btn btn-small" data-action="run-extract">Run extraction again</button><span class="hint">Running again replaces the values in step 4.</span></div>
      ${promptDetails('extract')}
    </section>`;
  }
  return `${stepHead(3)}${errorBlock('extract')}${body}
  <div class="nav-row"><button type="button" class="btn" data-action="goto" data-step="2">Back to pitch</button>
    <button type="button" class="btn btn-primary" data-action="goto" data-step="4" ${ex && !busy ? '' : 'disabled'}>Verify and score</button></div>`;
}

// ---------- step 4: verify and score ----------
function inputFor(k, v, S) {
  const meta = M.FIELD_META[k];
  const id = `v-${k}`;
  if (meta.type === 'choice') {
    const opts = S.options[meta.options];
    return `<select id="${id}" data-field="${k}" aria-label="${esc(meta.label)}"><option value="">Missing</option>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (meta.type === 'text') return `<input type="text" id="${id}" data-field="${k}" value="${esc(v ?? '')}" placeholder="Missing" aria-label="${esc(meta.label)}">`;
  return `<input type="text" class="money" id="${id}" data-field="${k}" value="${fmtFull(v)}" placeholder="Missing" inputmode="decimal" aria-label="${esc(meta.label)}">`;
}

function viewVerify(c, f) {
  const S = state.settings;
  const ex = c.extraction;
  const sample = c.sampleId ? sampleById(c.sampleId) : null;
  const ev = !f.miss.stop ? M.evActions(c) : null;
  const pctField = (id, bind, v, label, hint = '') => `<label class="field" for="${id}"><span>${label}</span><div class="with-suffix"><input type="number" id="${id}" data-casenum="${bind}" data-kind="pct" min="0" max="100" step="1" value="${Math.round(v * 1000) / 10}"><span>%</span></div>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const moneyField = (id, bind, v, label) => `<label class="field" for="${id}"><span>${label}</span><input type="text" class="money" id="${id}" data-casenum="${bind}" data-kind="money" value="${fmtFull(v)}" inputmode="decimal"><span class="hint">${fmtEur(v)}</span></label>`;

  const stop = f.miss.stop ? `<div class="banner banner-stop"><div><strong>Stop: research missing data</strong>
    <ul>${f.miss.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <p>Add the missing values from your own research (financials, a call with the founders), or go back and paste a fuller pitch. Nothing is calculated until this is resolved.</p></div></div>` : '';

  const rows = M.FIELD_ORDER.map((k) => {
    const src = c.sources?.[k] || {};
    const fl = ex.fields[k];
    const v = c.values[k];
    const conf = Boolean(c.confirmed?.[k]);
    const key = M.KEY_FIELDS.includes(k);
    const crit = M.CRITICAL_FIELDS.includes(k);
    const aiCell = ex.source === 'manual' ? '<span class="muted">—</span>' : `${fmtField(k, fl.draft)} ${fl.status !== 'found' ? STATUS_PILL[fl.status] : ''}${fl.quote ? `<div class="quote">${esc(fl.quote)}</div>` : ''}`;
    let status;
    if (isEmpty(v)) status = `<span class="pill pill-stop">Missing${crit ? ' · critical' : key ? ' · key' : ''}</span>`;
    else if (src.by === 'analyst') status = '<span class="pill pill-good">Entered by analyst</span>';
    else status = `<button type="button" class="btn btn-small" data-action="confirm-field" data-k="${k}" aria-pressed="${conf}">${conf ? 'Confirmed ✓' : 'Confirm'}</button>`;
    return `<tr><td>${esc(M.FIELD_META[k].label)}${crit ? ' <span class="label-mono">critical</span>' : ''}</td><td>${aiCell}</td><td style="min-width:170px">${inputFor(k, v, S)}</td><td>${status}</td></tr>`;
  }).join('');

  const flags = S.redFlags.map((rf, i) => {
    const sug = (c.redFlagSuggestions || []).find((x) => x.flag === rf);
    return `<label class="confirm-box" for="rf-${i}"><input type="checkbox" id="rf-${i}" data-redflag="${esc(rf)}" ${c.redFlags.includes(rf) ? 'checked' : ''}>
      <span><strong>${esc(rf)}</strong>${sug ? `<br><span class="pill pill-ai">Suggested by AI</span> <span class="quote">${esc(sug.quote)}</span>` : ''}</span></label>`;
  }).join('');

  const criteria = S.criteria.map((cr) => {
    const s = c.scores[cr.id];
    const anchor = cr.anchors[s] || (s === 2 ? `Between “${cr.anchors[1]}” and “${cr.anchors[3]}”` : s === 4 ? `Between “${cr.anchors[3]}” and “${cr.anchors[5]}”` : 'Not scored yet');
    return `<div class="criterion"><div><strong>${esc(cr.name)}</strong><div class="hint">weight ${cr.weight}%</div></div>
      <div class="seg" role="group" aria-label="${esc(cr.name)} score">${[1, 2, 3, 4, 5].map((v) => `<button type="button" data-action="score" data-c="${cr.id}" data-v="${v}" aria-pressed="${s === v}">${v}</button>`).join('')}</div>
      <div class="anchor">${esc(anchor)}</div></div>`;
  }).join('');

  const pFail = 1 - c.scenarios.pBig - c.scenarios.pMod;
  const prog = ev && !ev.errors?.length ? ev : null;

  return `${stepHead(4)}${decidedBanner(c)}
  <p class="lead muted">Check every AI value against the source and confirm or correct it. Then score each criterion with the fund’s anchors and enter the scenario estimates.</p>
  ${stop}
  ${sample ? `<div class="banner banner-info"><div><strong>Test case: ${esc(sample.name)}</strong><p>${esc(sample.analystExample.note)}</p>
    <div class="row"><button type="button" class="btn btn-small" data-action="example-inputs">Fill in the example analyst inputs</button></div></div></div>` : ''}

  <section class="panel">
    <div class="panel-head"><h2>Confirm the inputs</h2>
      <div class="row"><span class="pill ${f.miss.missingKey.length > 2 || f.miss.missingCritical.length ? 'pill-stop' : f.miss.missingKey.length ? 'pill-warn' : 'pill-good'}">${f.miss.missingKey.length} of ${M.KEY_FIELDS.length} key inputs missing</span>
      <button type="button" class="btn btn-small" data-action="confirm-all" ${f.unconfirmed.length ? '' : 'disabled'}>Confirm all ${f.unconfirmed.length || ''}</button></div></div>
    <p class="small muted">Money accepts “500k”, “5m” or “5,000,000”. Typing a value counts as the analyst’s own input. Stop rules: a missing valuation or round size stops the process; so do more than two missing key inputs.</p>
    <div class="table-wrap"><table><thead><tr><th>Field</th><th>AI draft and quote</th><th>Confirmed value</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Our ticket</h2><span class="hint">Checked against the ticket range in screening</span></div>
    <div class="grid-2">
      ${moneyField('ticket', 'ticket', c.ticket, 'Amount we would invest')}
      <div class="stack"><span class="label-mono">Our stake</span><span class="num">${c.ticket > 0 && c.values.post_money_valuation > 0 ? `${pct(c.ticket / c.values.post_money_valuation, 1)} of the company at ${fmtEur(c.values.post_money_valuation)} post-money` : 'Needs ticket and valuation'}</span></div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Red flags</h2><span class="hint">Any confirmed red flag fails screening</span></div>
    <div class="stack">${flags}</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Score each criterion</h2><span class="hint">1–5, using the fund’s anchors</span></div>
    <div>${criteria}</div>
  </section>

  ${worldsHTML(c, f)}

  <section class="panel">
    <div class="panel-head"><h2>Scenario estimates</h2>${c.scenarioSource === 'ai-worlds' ? '<span class="pill pill-ai">Numbers taken from the AI worlds</span>' : '<span class="hint">Chances of success and possible exit values (company value at exit)</span>'}</div>
    <div class="grid-2">
      ${pctField('p-big', 'scenarios.pBig', c.scenarios.pBig, 'Big success: probability')}
      ${moneyField('x-big', 'scenarios.exitBig', c.scenarios.exitBig, 'Big success: exit value')}
      ${pctField('p-mod', 'scenarios.pMod', c.scenarios.pMod, 'Moderate outcome: probability')}
      ${moneyField('x-mod', 'scenarios.exitMod', c.scenarios.exitMod, 'Moderate outcome: exit value')}
    </div>
    <div class="row"><span class="pill ${pFail < 0 ? 'pill-stop' : 'pill-neutral'}">Failure: ${pct(pFail)} · exit value €0</span>
      ${pctField('dil', 'dilutionToExit', c.dilutionToExit, 'Dilution from now until exit', 'Later rounds shrink our stake')}</div>
  </section>

  <details class="panel" ${c.tranche.milestone ? '' : 'open'}>
    <summary><strong>Tranche and waiting assumptions</strong> <span class="hint">used to compare the four actions</span></summary>
    <div class="section">
      <div class="grid-2">
        <label class="field" for="milestone"><span>Milestone for the second tranche</span><input type="text" id="milestone" data-casetext="tranche.milestone" value="${esc(c.tranche.milestone)}" placeholder="e.g. Monthly revenue reaches €50k"></label>
        <label class="field" for="months"><span>Months until the milestone review</span><input type="number" id="months" data-casenum="tranche.months" data-kind="num" min="1" max="36" value="${c.tranche.months}"></label>
        ${pctField('t1', 'tranche.firstShare', c.tranche.firstShare, 'First tranche, share of ticket', `${fmtEur((c.ticket || 0) * c.tranche.firstShare)} now, ${fmtEur((c.ticket || 0) * (1 - c.tranche.firstShare))} on the milestone`)}
      </div>
      <div class="grid-2">
        ${pctField('ps', 'progress.ifSuccess', c.progress.ifSuccess, 'Of startups that will succeed, how many hit this milestone?')}
        ${pctField('pf', 'progress.ifFailure', c.progress.ifFailure, 'Of startups that will fail, how many still hit it?')}
      </div>
      ${prog ? `<p class="small">→ Chance of hitting the milestone: <strong>${pct(prog.progressProb)}</strong>. If it is hit, the failure risk falls from ${pct(prog.pFail)} to <strong>${pct(prog.failIfProgress)}</strong>. The same signal is used for raising a next round.</p>` : ''}
      <div class="grid-3">
        <label class="field" for="stepup"><span>Next-round valuation step-up (×)</span><input type="number" id="stepup" data-casenum="wait.stepUp" data-kind="num" min="1" step="0.1" value="${c.wait.stepUp}"></label>
        ${pctField('alloc', 'wait.allocationProb', c.wait.allocationProb, 'Chance we still get into that round')}
        ${pctField('dn', 'wait.dilutionAfter', c.wait.dilutionAfter, 'Dilution after the next round')}
      </div>
    </div>
  </details>

  ${f.blockers.length ? `<div class="banner banner-warn"><div><strong>Before screening</strong><ul>${f.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div></div>` : ''}
  <div class="nav-row"><button type="button" class="btn" data-action="goto" data-step="3">Back to AI draft</button>
    <button type="button" class="btn btn-primary" data-action="to-screening" ${f.verifyOk ? '' : 'disabled'}>Run screening</button></div>`;
}

// ---------- step 5: screening ----------
function viewScreen(c, f) {
  const sc = M.screening(state.settings, c);
  return `${stepHead(5)}${decidedBanner(c)}
  <p class="lead muted">Each hard constraint is a yes/no check. One “no” and the startup is out, however attractive it looks. Constraints are not trade-offs, so they are kept out of the score.</p>
  <section class="panel">
    <div class="table-wrap"><table><thead><tr><th>Check</th><th>This startup</th><th>Fund rule</th><th>Result</th></tr></thead><tbody>
      ${sc.checks.map((x) => `<tr><td>${esc(x.label)}</td><td>${typeof x.value === 'number' ? fmtEur(x.value) : esc(x.value || 'not given')}</td><td class="muted">${esc(x.rule)}</td>
        <td>${x.pass ? '<span class="pill pill-good">✓ Yes</span>' : '<span class="pill pill-stop">✗ No</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    ${sc.pass
    ? '<div class="banner banner-info"><div><strong>Passes screening.</strong><p>The startup is eligible. Continue to the analysis.</p></div></div>'
    : `<div class="banner banner-stop"><div><strong>Fails screening: pass on this startup.</strong><p>Failed on ${esc(sc.failed.map((x) => x.label.toLowerCase()).join(', '))}. The case skips the analysis and goes to the committee as “Pass”, with the reason logged.</p></div></div>`}
  </section>
  <div class="nav-row"><button type="button" class="btn" data-action="goto" data-step="4">Back to verification</button>
    ${sc.pass ? '<button type="button" class="btn btn-primary" data-action="goto" data-step="6">Run the analysis</button>' : '<button type="button" class="btn btn-primary" data-action="goto" data-step="8">Send to committee as Pass</button>'}</div>`;
}

// ---------- step 6: analysis ----------
function whatIfCase(c) {
  const w = state.whatIf;
  if (!w || w.caseId !== c.id) return null;
  const same = state.settings.criteria.every((cr) => w.scores[cr.id] === c.scores[cr.id])
    && Math.abs(w.pBig - c.scenarios.pBig) < 1e-9 && w.valuation === c.values.post_money_valuation;
  if (same) return null;
  const t = clone(c);
  Object.assign(t.scores, state.whatIf.scores);
  t.scenarios.pBig = state.whatIf.pBig;
  t.values.post_money_valuation = state.whatIf.valuation;
  return t;
}

function resultsHTML(c, r, isWhatIf) {
  const S = state.settings;
  if (r.stage === 'invalid') return `<div class="banner banner-stop"><div><strong>The analysis cannot run.</strong><ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>`;
  if (r.stage !== 'analysed') return `<div class="banner banner-stop"><div><strong>No analysis: ${esc(r.stage)}</strong></div></div>`;
  const A = r.ev.actions;
  const rec = r.recommendation.action;
  const maxAbs = Math.max(...Object.values(A).map((a) => Math.abs(a.ev)), 1);
  const colors = ['var(--code)', 'var(--human)', 'var(--ai)', 'var(--data)', 'var(--muted)', 'var(--good)'];
  const order = ['now', 'tranches', 'wait', 'pass'];
  const t = r.ev;
  return `
  <div class="rec" data-rec="${rec}">
    <div><span class="label-mono">${isWhatIf ? 'What-if recommendation' : 'Recommendation'}</span>
      <div class="rec-action">${esc(M.ACTION_LABEL[rec])}</div>
      <ul>${r.recommendation.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <div class="rec-score"><span class="label-mono">Score</span><div class="big">${r.sc.score.toFixed(1)}</div><span class="small muted">threshold ${S.threshold}</span></div>
  </div>

  <div class="section"><h3>a · Score</h3>
    <div class="scorebar" role="img" aria-label="Score ${r.sc.score.toFixed(1)} out of 100, threshold ${S.threshold}">
      ${r.sc.parts.map((p, i) => `<div class="seg-part" style="width:${p.points}%;background:${colors[i % colors.length]}" title="${esc(p.name)}: ${p.score} × ${p.weight}% = ${p.points.toFixed(1)}">${p.points >= 7 ? esc(p.name) : ''}</div>`).join('')}
      <div class="threshold" style="left:${S.threshold}%"><span>${S.threshold}</span></div>
    </div>
    <div class="scale"><span>0</span><span>50</span><span>100</span></div>
    <p class="small muted">${r.sc.parts.map((p) => `${esc(p.name)} ${p.score} × ${p.weight}%`).join(' · ')} → ${r.sc.score.toFixed(1)}/100</p>
  </div>

  <div class="section"><h3>b–c · Expected value and maximum loss per action</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Action</th><th class="num">Expected value</th><th style="min-width:110px"></th><th class="num">Paid upfront</th><th class="num">Worst-case loss</th><th class="num">Our stake</th></tr></thead>
      <tbody>${order.map((k) => {
        const a = A[k];
        const w = Math.abs(a.ev) / maxAbs * 100;
        return `<tr class="${k === rec ? 'is-rec' : ''}"><td>${esc(M.ACTION_LABEL[k])}${k === rec ? ' <span class="pill pill-good">Recommended</span>' : ''}</td>
          <td class="num">${fmtEur(a.ev)}</td><td><div class="evbar ${a.ev < 0 ? 'neg' : ''}" style="width:${w}%"></div></td>
          <td class="num">${fmtEur(a.upfront)}</td><td class="num">${fmtEur(a.worst)}</td><td class="num">${a.ownership ? pct(a.ownership, 1) : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
    <p class="small muted">Tranches: ${fmtEur(A.tranches.t1)} now; ${fmtEur(A.tranches.t2)} only if the milestone is hit (${pct(t.progressProb)} chance). If the milestone is missed, the loss is limited to ${fmtEur(A.tranches.lossIfMissed)}. Waiting: we invest at ${fmtEur(A.wait.nextValuation)} only if the next round happens and we get an allocation.</p>
  </div>

  <div class="section"><h3>d · Sensitivity: where the recommendation flips</h3>
    ${r.sens.points.length ? `<ul class="switch-list">${r.sens.points.map((p) => `<li>${p.fragile ? '<span class="pill pill-stop">Fragile</span>' : '<span class="pill pill-neutral">Far</span>'}<span>${esc(p.text)}</span></li>`).join('')}</ul>` : '<p class="muted">No single change within the tested range flips the recommendation.</p>'}
    <p class="small muted">One assumption is changed at a time. A switch point counts as fragile when it is within ${S.fragility.scorePoints} score point or ±${pct(S.fragility.relative)} of our estimate.</p>
  </div>

  <details><summary>How these numbers are calculated</summary>
    <div class="stack small">
      <p><strong>Expected exit value</strong> = ${pct(c.scenarios.pBig)} × ${fmtEur(c.scenarios.exitBig)} + ${pct(c.scenarios.pMod)} × ${fmtEur(c.scenarios.exitMod)} + ${pct(t.pFail)} × €0 = <strong>${fmtEur(t.Eexit)}</strong></p>
      <p><strong>Invest now</strong> = stake ${pct(t.ownership, 1)} × (1 − ${pct(c.dilutionToExit)} dilution) × ${fmtEur(t.Eexit)} − ${fmtEur(c.ticket)} = <strong>${fmtEur(A.now.ev)}</strong></p>
      <p><strong>Milestone</strong>: ${pct(c.progress.ifSuccess)} of future winners and ${pct(c.progress.ifFailure)} of future failures hit it, so the chance is ${pct(t.pSuccess)} × ${pct(c.progress.ifSuccess)} + ${pct(t.pFail)} × ${pct(c.progress.ifFailure)} = ${pct(t.progressProb)}. After a hit, the failure risk is ${pct(t.failIfProgress)}.</p>
      <p><strong>Invest in tranches</strong> = value of the first ${fmtEur(A.tranches.t1)} + (value of the second ${fmtEur(A.tranches.t2)} if the milestone is hit) × ${pct(t.progressProb)} = <strong>${fmtEur(A.tranches.ev)}</strong></p>
      <p><strong>Wait</strong> = ${pct(c.wait.allocationProb)} allocation chance × ${pct(t.progressProb)} next-round chance × (stake ${pct(A.wait.ownership, 1)} at ${fmtEur(A.wait.nextValuation)} × (1 − ${pct(c.wait.dilutionAfter)}) × expected exit after progress − ${fmtEur(c.ticket)}) = <strong>${fmtEur(A.wait.ev)}</strong></p>
      <p>All of this runs as fixed code in the browser (model.js). The same inputs always give the same result.</p>
    </div>
  </details>`;
}

function sliderRows(c, w) {
  const S = state.settings;
  const rows = S.criteria.map((cr) => `<div class="slider-row"><label for="wi-${cr.id}">${esc(cr.name)} score</label>
    <input type="range" id="wi-${cr.id}" min="1" max="5" step="1" value="${w.scores[cr.id]}" data-wi="score.${cr.id}">
    <output for="wi-${cr.id}" id="wo-${cr.id}">${w.scores[cr.id]}${w.scores[cr.id] !== c.scores[cr.id] ? ` (was ${c.scores[cr.id]})` : ''}</output></div>`).join('');
  return `${rows}
    <div class="slider-row"><label for="wi-pbig">Big-success probability</label>
      <input type="range" id="wi-pbig" min="0" max="${Math.round((1 - c.scenarios.pMod) * 100)}" step="1" value="${Math.round(w.pBig * 100)}" data-wi="pBig">
      <output id="wo-pbig">${pct(w.pBig)}</output></div>
    <div class="slider-row"><label for="wi-val">Post-money valuation</label>
      <input type="range" id="wi-val" min="1000000" max="${Math.max(30000000, c.values.post_money_valuation * 3)}" step="250000" value="${w.valuation}" data-wi="valuation">
      <output id="wo-val">${fmtEur(w.valuation)}</output></div>`;
}

function viewAnalysis(c, f) {
  const wc = whatIfCase(c);
  const r = wc ? M.evaluate(state.settings, wc) : f.result;
  const w = state.whatIf && state.whatIf.caseId === c.id ? state.whatIf : { scores: { ...c.scores }, pBig: c.scenarios.pBig, valuation: c.values.post_money_valuation };
  return `${stepHead(6)}${decidedBanner(c)}
  <p class="lead muted">Four calculations in one block: score, expected value, comparison of the four actions, and sensitivity. Then the decision rule gives a recommendation.</p>
  <section class="panel"><div id="results" class="section">${resultsHTML(wc || c, r, Boolean(wc))}</div></section>
  <section class="panel whatif ${wc ? 'active' : ''}" id="whatif">
    <div class="panel-head"><h2>Change one assumption</h2>
      <div class="row">${wc ? '<span class="pill pill-warn">What-if: the saved case is unchanged</span>' : '<span class="hint">Move a slider and watch the recommendation</span>'}
      <button type="button" class="btn btn-small" data-action="reset-whatif" ${wc ? '' : 'disabled'}>Reset to confirmed values</button></div></div>
    <div class="stack" id="sliders">${sliderRows(c, w)}</div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>e · How this startup compares</h2><span class="tag tag-code">Code · fixed data</span></div>
    ${compareHTML(c)}
  </section>
  ${peersHTML(c)}
  <div class="nav-row"><button type="button" class="btn" data-action="goto" data-step="5">Back to screening</button>
    <button type="button" class="btn btn-ai" data-action="goto" data-step="7">Ask the AI to challenge this</button></div>`;
}

function refreshAnalysis() {
  const c = activeCase(); const f = flow(c);
  const wc = whatIfCase(c);
  const r = wc ? M.evaluate(state.settings, wc) : f.result;
  document.getElementById('results').innerHTML = resultsHTML(wc || c, r, Boolean(wc));
  const w = state.whatIf;
  state.settings.criteria.forEach((cr) => {
    const o = document.getElementById(`wo-${cr.id}`);
    if (o) o.textContent = `${w.scores[cr.id]}${w.scores[cr.id] !== c.scores[cr.id] ? ` (was ${c.scores[cr.id]})` : ''}`;
  });
  document.getElementById('wo-pbig').textContent = pct(w.pBig);
  document.getElementById('wo-val').textContent = fmtEur(w.valuation);
  const box = document.getElementById('whatif');
  box.classList.toggle('active', Boolean(wc));
  const head = box.querySelector('.panel-head .row');
  head.innerHTML = `${wc ? '<span class="pill pill-warn">What-if: the saved case is unchanged</span>' : '<span class="hint">Move a slider and watch the recommendation</span>'}
    <button type="button" class="btn btn-small" data-action="reset-whatif" ${wc ? '' : 'disabled'}>Reset to confirmed values</button>`;
  renderRail(c, f);
}

// ---------- step 7: AI challenge ----------
function viewChallenge(c, f) {
  const r = f.result;
  const ch = c.challenge;
  const busy = state.busy === 'challenge';
  const stale = ch && (Math.abs(ch.basedOn.score - r.sc.score) > 1e-9 || ch.basedOn.action !== r.recommendation.action);
  let body;
  if (busy) {
    body = `<section class="panel"><div class="row"><span class="spinner" style="color:var(--ai)"></span><span>${state.ai.live ? 'Asking the AI to argue against the recommendation…' : 'Loading the saved example answer…'}</span></div></section>`;
  } else if (!ch) {
    body = `<section class="panel">
      <p>The tool sends the confirmed inputs, the results and the switch points to the AI, with the instruction to argue against the recommendation: <strong>${esc(M.ACTION_LABEL[r.recommendation.action])}</strong>.</p>
      <div class="row"><button type="button" class="btn btn-ai" data-action="run-challenge">Run the devil’s advocate</button></div>
      ${promptDetails('challenge')}
      <details><summary>View the case data that will be sent</summary><pre class="prompt">${esc(JSON.stringify(challengePayload(c, r), null, 2))}</pre></details>
    </section>`;
  } else {
    const x = ch.result || {};
    const list = (a) => (Array.isArray(a) ? a : []);
    body = `<section class="panel">
      <div class="panel-head"><h2>Challenge report for the committee</h2>
        <div class="provenance">${ch.source === 'cached' ? '<span class="pill pill-warn">Saved example answer (no live AI here)</span>' : `<span class="pill pill-ai">Live AI · ${esc(ch.model)}</span>`}<span>${esc(new Date(ch.at).toLocaleString('en-GB'))}</span></div></div>
      ${stale ? '<div class="banner banner-warn"><div><strong>The case changed after this challenge was written.</strong><p>Run it again so it argues against the current recommendation.</p></div></div>' : ''}
      <div class="ai-card"><span class="label-mono">Strongest arguments against</span><ol>${list(x.counter_arguments).map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
      <div class="ai-card"><span class="label-mono">Likely biases</span><ul>${list(x.biases).map((b) => `<li><strong>${esc(b.bias)}</strong>: ${esc(b.why)}</li>`).join('')}</ul></div>
      <div class="ai-card"><span class="label-mono">Most fragile assumption</span><p>${esc(x.most_fragile_assumption || '—')}</p></div>
      <div class="ai-card"><span class="label-mono">Checks before deciding</span><ul>${list(x.checks_before_deciding).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
      <p class="small muted">AI output never goes straight into a decision. The committee reads it next to the code’s results in step 8.</p>
      <div class="row"><button type="button" class="btn btn-small" data-action="run-challenge">Run again</button></div>
    </section>`;
  }
  return `${stepHead(7)}${decidedBanner(c)}${errorBlock('challenge')}${body}
  <div class="nav-row"><button type="button" class="btn" data-action="goto" data-step="6">Back to analysis</button>
    <button type="button" class="btn btn-primary" data-action="goto" data-step="8" ${busy ? 'disabled' : ''}>Go to committee</button></div>`;
}

// ---------- step 8: committee ----------
function viewDecide(c, f) {
  const r = f.result;
  const recAction = r.recommendation.action;
  const d = c.draftDecision || (c.draftDecision = { action: recAction, rationale: '', members: '', milestone: c.tranche.milestone || '', reviewDate: addMonths(c.tranche.months) });
  const override = d.action !== recAction;
  const analysed = r.stage === 'analysed';
  const A = analysed ? r.ev.actions : null;
  const options = analysed ? ['now', 'tranches', 'wait', 'pass'] : ['pass'];
  const ch = c.challenge?.result;
  return `${stepHead(8)}${decidedBanner(c)}
  <p class="lead muted">The committee reviews the recommendation, the switch points and the AI challenge, then chooses an action. It may differ from the recommendation; then a written rationale is mandatory.</p>
  <section class="panel">
    <div class="rec" data-rec="${recAction}"><div><span class="label-mono">Recommendation from the code</span><div class="rec-action">${esc(M.ACTION_LABEL[recAction])}</div>
      <ul>${r.recommendation.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      ${analysed ? `<div class="rec-score"><span class="label-mono">Score</span><div class="big">${r.sc.score.toFixed(1)}</div></div>` : ''}</div>
    ${analysed && r.sens.mostFragile ? `<p class="small"><strong>Most fragile assumption:</strong> ${esc(r.sens.mostFragile.text)}</p>` : ''}
    ${analysed ? (ch ? `<div class="ai-card"><span class="label-mono">AI challenge in brief</span><p>${esc((ch.counter_arguments || [])[0] || '')}</p>${(ch.biases || []).length ? `<p class="small muted">Possible biases: ${esc(ch.biases.map((b) => b.bias).join(', '))}</p>` : ''}</div>` : '<div class="banner banner-warn"><div><strong>The AI challenge has not been run.</strong><p>You can still decide, but the committee has no structured second opinion.</p></div></div>') : '<p class="small muted">Screened out, so there is no analysis or AI challenge. Pass is the only action.</p>'}
  </section>

  <section class="panel">
    <h2>Committee decision</h2>
    <div class="stack" role="radiogroup" aria-label="Final action">
      ${options.map((k) => `<label class="confirm-box" for="act-${k}"><input type="radio" name="act" id="act-${k}" value="${k}" data-decision="action" ${d.action === k ? 'checked' : ''}>
        <span><strong>${esc(M.ACTION_LABEL[k])}</strong>${k === recAction ? ' <span class="pill pill-good">Recommended</span>' : ''}${A ? `<br><span class="small muted">Expected value ${fmtEur(A[k].ev)} · worst case ${fmtEur(A[k].worst)}</span>` : ''}</span></label>`).join('')}
    </div>
    ${d.action === 'tranches' && A ? `<div class="grid-2">
      <label class="field" for="dec-milestone"><span>Milestone for the second tranche</span><input type="text" id="dec-milestone" data-decision="milestone" value="${esc(d.milestone)}" placeholder="e.g. Monthly revenue reaches €50k"></label>
      <div class="stack"><span class="label-mono">Tranches</span><span>${fmtEur(A.tranches.t1)} now, ${fmtEur(A.tranches.t2)} if the milestone is met</span></div></div>` : ''}
    ${d.action !== 'pass' ? `<label class="field" for="dec-review"><span>${d.action === 'tranches' ? 'Milestone review date' : d.action === 'wait' ? 'Revisit date' : 'First review date'}</span><input type="date" id="dec-review" data-decision="reviewDate" value="${esc(d.reviewDate)}"><span class="hint">The log reminds a partner when this date arrives.</span></label>` : ''}
    <label class="field" for="dec-rationale"><span>${override ? 'Written rationale (required: the committee overrides the recommendation)' : 'Rationale'}</span>
      <textarea id="dec-rationale" rows="4" data-decision="rationale" placeholder="Why did the committee choose this action?">${esc(d.rationale)}</textarea></label>
    <label class="field" for="dec-members"><span>Committee members present</span><input type="text" id="dec-members" data-decision="members" value="${esc(d.members)}" placeholder="Names or initials"></label>
    ${override ? '<div class="banner banner-warn"><div><strong>Override</strong><p>The committee is departing from the recommendation. The rationale is mandatory and is stored with the decision.</p></div></div>' : ''}
    ${state.decisionError ? `<div class="banner banner-stop"><div><strong>Not recorded yet.</strong><p>${esc(state.decisionError)}</p></div></div>` : ''}
  </section>
  <div class="nav-row"><button type="button" class="btn" data-action="goto" data-step="${analysed ? 7 : 5}">Back</button>
    <button type="button" class="btn btn-primary" data-action="record-decision" ${c.decisionId ? 'disabled' : ''}>${c.decisionId ? 'Decision recorded' : 'Record decision'}</button></div>`;
}

function recordDecision() {
  const c = activeCase(); const f = flow(c); const r = f.result;
  const d = c.draftDecision;
  const recAction = r.recommendation.action;
  const override = d.action !== recAction;
  if (override && !d.rationale.trim()) { state.decisionError = 'The committee overrides the recommendation, so a written rationale is required.'; render(); return; }
  if (d.action === 'tranches' && !d.milestone.trim()) { state.decisionError = 'Set the milestone for the second tranche.'; render(); return; }
  if (d.action !== 'pass' && !d.reviewDate) { state.decisionError = 'Set a review date.'; render(); return; }
  const S = state.settings;
  const analysed = r.stage === 'analysed';
  const rec = {
    id: `dec-${Date.now().toString(36)}`,
    caseId: c.id,
    company: caseName(c),
    decidedAt: new Date().toISOString(),
    settingsVersion: S.version,
    rules: { threshold: S.threshold, criteria: S.criteria.map((cr) => ({ name: cr.name, weight: cr.weight })), allowed: S.allowed, ticketMin: S.ticketMin, ticketMax: S.ticketMax },
    inputs: { values: clone(c.values), sources: clone(c.sources), ticket: c.ticket, redFlags: clone(c.redFlags), scores: clone(c.scores), scenarios: clone(c.scenarios),
      dilutionToExit: c.dilutionToExit, progress: clone(c.progress), tranche: clone(c.tranche), wait: clone(c.wait) },
    pitchText: c.pitchText,
    sourceFiles: (c.files || []).map((f) => f.name),
    results: {
      screening: r.screen ? r.screen.checks.map((x) => ({ label: x.label, pass: x.pass })) : null,
      score: analysed ? +r.sc.score.toFixed(1) : null,
      actions: analysed ? Object.fromEntries(Object.entries(r.ev.actions).map(([k, a]) => [k, { ev: Math.round(a.ev), upfront: a.upfront, worst: a.worst }])) : null,
      switchPoints: analysed ? r.sens.points.map((p) => p.text) : [],
      recommendation: recAction,
      reasons: r.recommendation.reasons,
      progressProb: analysed ? +r.ev.progressProb.toFixed(4) : null,
    },
    metrics: { ...MX.extractionStats(c), challengeRun: Boolean(c.challenge), scenarioSource: c.scenarioSource || 'analyst' },
    ai: { extraction: c.extraction ? { source: c.extraction.source, model: c.extraction.model, notes: c.extraction.notes } : null, challenge: c.challenge ? clone(c.challenge) : null,
      worlds: c.worlds ? clone(c.worlds) : null, peers: c.peers ? clone(c.peers) : null },
    decision: {
      action: d.action, override, rationale: d.rationale.trim(), members: d.members.trim(),
      milestone: d.action === 'tranches' ? d.milestone.trim() : '',
      trancheNow: d.action === 'tranches' ? r.ev.actions.tranches.t1 : null,
      trancheLater: d.action === 'tranches' ? r.ev.actions.tranches.t2 : null,
      reviewDate: d.action === 'pass' ? null : d.reviewDate,
    },
    status: d.action === 'pass' ? 'closed' : 'open',
    reviews: [],
  };
  state.log.unshift(rec);
  c.decisionId = rec.id;
  state.decisionError = null;
  save();
  toast(`Decision recorded: ${M.ACTION_LABEL[d.action]}`);
  goto(9);
}

// ---------- step 9: log and monitor ----------
function viewLog() {
  const due = dueReviews();
  const rows = state.log.map((rec) => {
    const isDue = due.includes(rec);
    const statusPill = rec.status === 'closed' ? '<span class="pill pill-neutral">Closed</span>' : isDue ? '<span class="pill pill-stop">Review due</span>' : '<span class="pill pill-good">Monitoring</span>';
    const reviewOpts = rec.decision.action === 'tranches'
      ? ['Milestone met: release second tranche', 'Milestone missed: do not release', 'Extend the deadline']
      : ['On track', 'Concerns: watch closely', 'Write-off', 'Revisit: assess as a new case'];
    return `<details class="record" ${isDue ? 'open' : ''}><summary>
      <span><strong>${esc(rec.company)}</strong> · ${esc(M.ACTION_LABEL[rec.decision.action])}${rec.decision.override ? ' <span class="pill pill-warn">Override</span>' : ''}<br>
      <span class="small muted">Decided ${esc(rec.decidedAt.slice(0, 10))} · recommended ${esc(M.ACTION_LABEL[rec.results.recommendation])}${rec.results.score !== null ? ` · score ${rec.results.score}` : ''}${rec.decision.reviewDate ? ` · review ${esc(rec.decision.reviewDate)}` : ''}</span></span>
      ${statusPill}</summary>
      <div class="record-body">
        <dl class="kv">
          <dt>Rationale</dt><dd>${esc(rec.decision.rationale || '—')}</dd>
          <dt>Committee</dt><dd>${esc(rec.decision.members || '—')}</dd>
          ${rec.decision.milestone ? `<dt>Milestone</dt><dd>${esc(rec.decision.milestone)} · ${fmtEur(rec.decision.trancheNow)} paid, ${fmtEur(rec.decision.trancheLater)} on the milestone</dd>` : ''}
          <dt>Reasons from the code</dt><dd>${esc(rec.results.reasons.join(' '))}</dd>
          ${rec.results.actions ? `<dt>Expected values</dt><dd class="num">${Object.entries(rec.results.actions).map(([k, a]) => `${esc(M.ACTION_LABEL[k])} ${fmtEur(a.ev)}`).join(' · ')}</dd>` : ''}
          ${rec.results.switchPoints.length ? `<dt>Closest switch point</dt><dd>${esc(rec.results.switchPoints[0])}</dd>` : ''}
          ${rec.sourceFiles?.length ? `<dt>Source files</dt><dd>${esc(rec.sourceFiles.join(', '))}</dd>` : ''}
          <dt>AI used</dt><dd>Extraction: ${esc(rec.ai.extraction ? `${rec.ai.extraction.source} (${rec.ai.extraction.model})` : '—')} · Challenge: ${esc(rec.ai.challenge ? `${rec.ai.challenge.source} (${rec.ai.challenge.model})` : 'not run')}</dd>
          <dt>Rules version</dt><dd>${rec.settingsVersion} · threshold ${rec.rules.threshold} · ${esc(rec.rules.criteria.map((cr) => `${cr.name} ${cr.weight}%`).join(', '))}</dd>
        </dl>
        ${rec.reviews.length ? `<div class="stack"><span class="label-mono">Reviews</span><ul class="switch-list">${rec.reviews.map((rv) => `<li><span class="label-mono">${esc(rv.date)}</span><span><strong>${esc(rv.outcome)}</strong>${rv.notes ? `: ${esc(rv.notes)}` : ''}</span></li>`).join('')}</ul></div>` : ''}
        ${rec.status === 'open' ? `<div class="section"><span class="label-mono">Record a review</span>
          <div class="grid-2">
            <label class="field" for="rv-out-${rec.id}"><span>Outcome</span><select id="rv-out-${rec.id}">${reviewOpts.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
            <label class="field" for="rv-next-${rec.id}"><span>Next review date (if it stays open)</span><input type="date" id="rv-next-${rec.id}" value="${addMonths(6)}"></label>
          </div>
          <label class="field" for="rv-notes-${rec.id}"><span>Notes</span><textarea id="rv-notes-${rec.id}" rows="2" placeholder="What did the partner find?"></textarea></label>
          <div><button type="button" class="btn btn-small btn-primary" data-action="save-review" data-id="${rec.id}">Save review</button></div></div>` : ''}
      </div></details>`;
  }).join('');

  return `${stepHead(9)}
  <p class="lead muted">Every decision is saved with its inputs, scores, results, AI output, final action and reasons. When a review date arrives, the tool reminds a partner. Lessons feed back into the fund rules in step 1.</p>
  ${due.length ? `<div class="banner banner-stop"><div><strong>${due.length} review${due.length > 1 ? 's are' : ' is'} due</strong><p>${esc(due.map((d) => `${d.company} (${d.decision.reviewDate})`).join(', '))}. Open the record below to log the review.</p></div></div>` : ''}
  <section class="panel">
    <div class="panel-head"><h2>Decision log</h2><span class="pill pill-neutral">${state.log.length} decision${state.log.length === 1 ? '' : 's'}</span></div>
    ${state.log.length ? `<div class="stack">${rows}</div>` : '<p class="muted">No decisions yet. Record one in step 8 and it appears here with its review date.</p>'}
    <p class="small muted">Tip for the demo: set a review date of today in step 8 to see the reminder straight away.</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Lessons learned</h2><span class="hint">Saved to the fund rules</span></div>
    <label class="field" for="lesson-text"><span>What should change in how we decide?</span><textarea id="lesson-text" rows="2" placeholder="e.g. Team scores were too generous without reference calls: tighten the team anchors."></textarea></label>
    <div class="row"><button type="button" class="btn btn-small" data-action="add-lesson">Save lesson</button>
      <button type="button" class="btn btn-small btn-ghost" data-action="goto" data-step="1">Open fund rules to adjust weights or anchors</button></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Data</h2><span class="hint">Stored in this browser only</span></div>
    <p class="small muted">Use export and import to share the fund rules, cases and decision log with the rest of the group.</p>
    <div class="row">
      <button type="button" class="btn btn-small" data-action="export">Export all data (JSON)</button>
      <label class="btn btn-small" for="import-file">Import data<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      <button type="button" class="btn btn-small btn-ghost btn-danger" data-action="reset-all">${state.confirmReset === 'all' ? 'Click again to delete everything' : 'Delete all data'}</button>
    </div>
  </section>`;
}

// =====================================================================
// Version 2: startup database, AI worlds, web search, performance metrics
// =====================================================================

// ---------- startup database (Y Combinator open data) ----------
let ycPromise = null;
function loadYC() {
  if (!ycPromise) {
    ycPromise = fetch('data/yc-companies.json')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { state.yc = d; state.ycError = null; if (['bench', 6, 4].includes(state.step)) render(); return d; })
      .catch((e) => { ycPromise = null; state.ycError = `The startup database could not be loaded (${e.message}). Reload the page to try again.`; render(); return null; });
  }
  return ycPromise;
}
const ycCompanies = () => state.yc?.companies || null;

const STATUS_ORDER = ['Active', 'Inactive', 'Acquired', 'Public']; // fixed order = fixed colours (chart slots 1–4)
const STATUS_SLOT = { Active: 1, Inactive: 2, Acquired: 3, Public: 4 };

function statusPill(s) {
  const cls = { Active: 'pill-neutral', Inactive: 'pill-stop', Acquired: 'pill-good', Public: 'pill-good' }[s] || 'pill-neutral';
  return `<span class="pill ${cls}">${esc(B.STATUS_LABEL[s] || s)}</span>`;
}

function stackedBar(shares, label, n) {
  const parts = STATUS_ORDER.filter((s) => shares[s] > 0);
  return `<div class="stackrow">
    <div class="stackrow-label"><span>${esc(label)}</span><span class="muted small num">${n.toLocaleString('en-US')} companies</span></div>
    <div class="stack-bar" role="img" aria-label="${esc(label)}: ${STATUS_ORDER.map((s) => `${B.STATUS_LABEL[s]} ${pct(shares[s])}`).join(', ')}">
      ${parts.map((s) => `<div class="stack-seg s${STATUS_SLOT[s]}" style="width:${(shares[s] * 100).toFixed(2)}%" title="${esc(B.STATUS_LABEL[s])}: ${pct(shares[s])}"></div>`).join('')}
    </div><span></span><span class="small muted num stack-values">${STATUS_ORDER.map((s) => `${esc(B.STATUS_LABEL[s])} ${pct(shares[s])}`).join(' · ')}</span></div>`;
}

function statusLegend() {
  return `<div class="legend-row">${STATUS_ORDER.map((s) => `<span class="legend-item"><span class="swatch s${STATUS_SLOT[s]}"></span>${esc(B.STATUS_LABEL[s])}</span>`).join('')}</div>`;
}

function companyRows(list) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Company</th><th>What it does</th><th class="num">YC year</th><th>Status</th><th>Location</th><th class="num">Team</th></tr></thead>
    <tbody>${list.map((x) => `<tr><td><a href="${esc(x.u)}" target="_blank" rel="noopener">${esc(x.n)}</a></td><td class="small">${esc(x.o)}</td>
      <td class="num">${x.y}</td><td>${statusPill(x.s)}</td><td class="small">${esc(x.loc || '—')}</td><td class="num">${x.t || '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function dataSourceNote() {
  const m = state.yc?.meta;
  if (!m) return '';
  return `<details><summary>About this data</summary><div class="stack small">
    <p>${esc(m.source)}, downloaded ${esc(m.downloaded)} (${m.count.toLocaleString('en-US')} companies). <a href="${esc(m.sourceUrl)}" target="_blank" rel="noopener">Source</a></p>
    <ul>${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p>Sectors are matched from YC's industry and tags, so one company can count in several sectors (for example AI and Fintech).</p></div></details>`;
}

// ---------- step 6: how this startup compares ----------
function compareHTML(c) {
  const v = c.values;
  const vc = B.compareValuation(v);
  const companies = ycCompanies();
  let body = '';

  if (vc) {
    const max = Math.max(vc.pre, vc.bm.preMoney) * 1.25;
    const diff = vc.ratio - 1;
    body += `<div class="section"><h3>Valuation</h3>
      <div class="dotscale" role="img" aria-label="Pre-money ${fmtEur(vc.pre)} compared with median ${fmtEur(vc.bm.preMoney)}">
        <div class="dotscale-line"></div>
        <div class="dot s1" style="left:${(vc.pre / max * 100).toFixed(1)}%" title="This startup: ${fmtEur(vc.pre)}"><span>This startup ${fmtEur(vc.pre)}</span></div>
        <div class="dot dot-median" style="left:${(vc.bm.preMoney / max * 100).toFixed(1)}%" title="Median: ${vc.bm.currency === 'USD' ? '$' : '€'}${(vc.bm.preMoney / 1e6).toFixed(1)}m"><span>Median ${vc.bm.currency === 'USD' ? '$' : '€'}${(vc.bm.preMoney / 1e6).toFixed(1).replace(/\.0$/, '')}m</span></div>
      </div>
      <p>Pre-money valuation ${fmtEur(vc.pre)} (${fmtEur(vc.post)} post-money minus the ${fmtEur(vc.raise)} round) is <strong>${esc(vc.verdict)}</strong>${vc.bm.currency === 'EUR' ? ` (${diff >= 0 ? '+' : '−'}${Math.round(Math.abs(diff) * 100)}%)` : ''} for <strong>${esc(vc.bm.label)}</strong>.
      ${vc.roundRatio ? ` The round is ${pct(vc.roundRatio)} of the median round size (${fmtEur(vc.bm.dealSize)}).` : ''}</p>
      <p class="small muted">Source: <a href="${esc(vc.bm.url)}" target="_blank" rel="noopener">${esc(vc.bm.source)}</a>. A median only says where the middle is; it does not say what this startup is worth.</p></div>`;
  }

  if (!companies) {
    body += state.ycError ? `<div class="banner banner-warn"><div><p>${esc(state.ycError)}</p></div></div>` : '<p class="muted small"><span class="spinner" style="color:var(--code);display:inline-block;vertical-align:middle"></span> Loading the startup database…</p>';
  } else if (v.sector && v.sector !== 'Other') {
    const s = B.sectorSummary(companies, v.sector);
    const t = B.compareTeam(companies, v.sector, Number(v.team_size));
    body += `<div class="section"><h3>How ${esc(v.sector)} startups have done</h3>
      <p class="small muted">Y Combinator companies that started in 2010–2019, so enough time has passed to see outcomes.</p>
      ${statusLegend()}
      ${stackedBar(s.mature.shares, `${v.sector}`, s.mature.n)}
      ${stackedBar(s.matureAll.shares, 'All sectors', s.matureAll.n)}
      ${t ? `<p>Team of ${v.team_size}: larger than <strong>${pct(t.rank)}</strong> of recent ${esc(v.sector)} companies in the dataset (median ${Math.round(t.median)}, middle half ${Math.round(t.p25)}–${Math.round(t.p75)} people).</p>` : ''}
    </div>
    <div class="section"><h3>Similar companies in the database</h3>
      <p class="small muted">Same sector, closest region first, then similar team size and more recent. Click a name to open its YC profile.</p>
      ${companyRows(B.similarCompanies(companies, { sector: v.sector, region: v.region, teamSize: Number(v.team_size) }))}
      ${dataSourceNote()}
    </div>`;
  }
  return body;
}

// ---------- step 6: live web search (OpenRouter) ----------
function defaultPeerQuery(c) {
  const text = (c.pitchText || '').replace(/\[(Page|Slide) \d+\]/g, ' ').replace(/=== From file:[^\n]*===/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = text.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
  return sentences.slice(0, 300);
}

async function runPeers() {
  const c = activeCase();
  const q = (c.peerQuery ?? defaultPeerQuery(c)).trim();
  state.busy = 'peers'; state.error = null; render();
  try {
    const out = await callAI('peers', { sector: c.values.sector, stage: c.values.stage, region: c.values.region, description: q.slice(0, 600) }, null);
    c.peers = { ...processPeers(out.result, out.citations), source: out.source, model: out.model, at: new Date().toISOString(), query: q };
    state.needPasscode = false;
  } catch (e) {
    state.error = { task: 'peers', message: e.message || String(e) };
  }
  state.busy = null; save(); render();
}

function peersHTML(c) {
  const busy = state.busy === 'peers';
  const live = state.ai.live && state.ai.webSearch;
  const q = c.peerQuery ?? defaultPeerQuery(c);
  const p = c.peers;
  let res = '';
  if (busy) {
    res = '<div class="row"><span class="spinner" style="color:var(--ai)"></span><span>Searching the web and reading the results… this can take up to a minute.</span></div>';
  } else if (p) {
    const nLinked = p.comparables.filter((x) => x.linked).length;
    res = `<div class="provenance"><span class="pill pill-ai">Live AI web search · ${esc(p.model)}</span><span>${esc(new Date(p.at).toLocaleString('en-GB'))}</span>
        <span>${p.citations.length} source${p.citations.length === 1 ? '' : 's'} returned by the search · ${nLinked} of ${p.comparables.length} items match a returned source</span></div>
      ${p.comparables.length ? `<div class="table-wrap"><table><thead><tr><th>Company</th><th>What happened</th><th>Source check</th></tr></thead><tbody>
        ${p.comparables.map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.country)}${x.what ? ` · ${esc(x.what)}` : ''}</div></td>
          <td>${esc(x.event)}${x.amount ? ` <span class="num">(${esc(x.amount)})</span>` : ''}${x.date ? `<div class="small muted">${esc(x.date)}</div>` : ''}</td>
          <td>${x.linked ? '<span class="pill pill-good">✓ Source returned by search</span>' : '<span class="pill pill-warn">Not confirmed</span>'}${x.url ? `<div class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">Open source</a></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No comparable startups with a reliable source were found.</p>'}
      ${p.trend ? `<div class="ai-card"><span class="label-mono">Funding climate in this sector</span><p>${esc(p.trend)}</p></div>` : ''}
      ${p.caveats ? `<p class="small muted">${esc(p.caveats)}</p>` : ''}
      ${p.citations.length ? `<details><summary>All sources returned by the search (${p.citations.length})</summary><ul class="small">${p.citations.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a></li>`).join('')}</ul></details>` : ''}
      <p class="small muted">“Not confirmed” means the AI named a page that the search did not return. Open it and check before relying on it.</p>`;
  }
  return `<section class="panel">
    <div class="panel-head"><h2>Recent news on comparable startups</h2><span class="tag tag-ai">AI · live web search</span></div>
    <p class="small muted">Searches the internet for recent funding rounds, sales and shutdowns of similar startups, with links to every source. Costs about €0.02 per search. Less reliable than the fixed data above, so check the sources.</p>
    ${live ? '' : `<div class="banner banner-warn"><div><p>${state.ai.live ? 'Live web search needs OpenRouter. Set LLM_PROVIDER to openrouter in Netlify to use it.' : 'Live web search only works on the deployed site with an OpenRouter key. There is no saved example, because search results must be real.'}</p></div></div>`}
    <label class="field" for="peer-query"><span>Description used for the search</span>
      <textarea id="peer-query" rows="3" data-peerquery="1">${esc(q)}</textarea>
      <span class="hint">This text and the sector, stage and region are sent to the search. Remove anything confidential first.</span></label>
    <div class="row"><button type="button" class="btn btn-ai" data-action="run-peers" ${live && !busy ? '' : 'disabled'}>${p ? 'Search again' : 'Search the web'}</button></div>
    ${errorBlock('peers')}
    ${res}
  </section>`;
}

// ---------- step 4: good, neutral and worst world ----------
const WORLD_META = {
  good: { label: 'Good world', maps: 'Big success', pill: 'pill-good' },
  neutral: { label: 'Neutral world', maps: 'Moderate outcome', pill: 'pill-warn' },
  worst: { label: 'Worst world', maps: 'Failure (exit €0)', pill: 'pill-stop' },
};

function worldsPayload(c) {
  return {
    pitchText: c.pitchText,
    startup: Object.fromEntries(M.FIELD_ORDER.map((k) => [M.FIELD_META[k].label, c.values[k]])),
    ticket: c.ticket,
    benchmarkFacts: B.benchmarkFacts(ycCompanies(), c.values),
  };
}

async function runWorlds() {
  const c = activeCase();
  const sample = c.sampleId ? sampleById(c.sampleId) : null;
  const cached = sample && sample.pitch === c.pitchText ? sample.cached.worlds : null;
  state.busy = 'worlds'; state.error = null; render();
  try {
    await loadYC();
    const payload = worldsPayload(c);
    const out = await callAI('worlds', payload, cached);
    c.worlds = { ...processWorlds(out.result, c.pitchText, payload.benchmarkFacts), facts: payload.benchmarkFacts,
      source: out.source, model: out.model, at: new Date().toISOString(), basedOn: JSON.stringify(c.values) };
    state.needPasscode = false;
  } catch (e) {
    state.error = { task: 'worlds', message: e.message || String(e) };
  }
  state.busy = null; save(); render();
  document.getElementById('worlds')?.scrollIntoView({ block: 'start' });
}

function basisPill(a) {
  if (a.basis === 'pitch') return a.check === 'ok' ? '<span class="pill pill-good">Pitch · quote checked ✓</span>' : `<span class="pill pill-stop">Pitch · ${esc(a.note)}</span>`;
  if (a.basis === 'benchmark') return a.check === 'ok' ? `<span class="pill pill-neutral">Benchmark ${esc(a.benchmarkId)}</span>` : `<span class="pill pill-stop">${esc(a.note)}</span>`;
  return '<span class="pill pill-ai">AI judgement</span>';
}

function worldsHTML(c, f) {
  const busy = state.busy === 'worlds';
  const W = c.worlds;
  const canRun = !f.miss.stop && c.pitchText?.trim();
  let body = '';
  if (busy) {
    body = `<div class="row"><span class="spinner" style="color:var(--ai)"></span><span>${state.ai.live ? 'The AI is writing three worlds and their assumptions… this can take up to a minute.' : 'Loading the saved example answer…'}</span></div>`;
  } else if (!W) {
    body = `<div class="row"><button type="button" class="btn btn-ai" data-action="run-worlds" ${canRun ? '' : 'disabled'}>Generate the three worlds</button>
      ${canRun ? '' : '<span class="hint">Resolve the missing inputs first.</span>'}</div>
      <details><summary>View the fixed instruction</summary><pre class="prompt">${esc(WORLDS_SYSTEM)}</pre></details>
      <details><summary>View the benchmark facts that will be sent</summary><ul class="small">${B.benchmarkFacts(ycCompanies(), c.values).map((x) => `<li><strong>${x.id}</strong> ${esc(x.text)}</li>`).join('')}</ul></details>`;
  } else {
    const stale = W.basedOn !== JSON.stringify(c.values);
    const applied = c.scenarioSource === 'ai-worlds';
    const g = W.worlds[0]; const n = W.worlds[1]; const wst = W.worlds[2];
    body = `<div class="provenance">${W.source === 'cached' ? '<span class="pill pill-warn">Saved example answer (no live AI here)</span>' : `<span class="pill pill-ai">Live AI · ${esc(W.model)}</span>`}<span>${esc(new Date(W.at).toLocaleString('en-GB'))}</span>
        <span>${W.failedChecks ? `<span class="pill pill-stop">${W.failedChecks} assumption${W.failedChecks > 1 ? 's' : ''} failed the check</span>` : '<span class="pill pill-good">All quotes and benchmarks checked</span>'}</span></div>
      ${stale ? '<div class="banner banner-warn"><div><strong>The inputs changed after these worlds were written.</strong><p>Run it again so the worlds match the current values.</p></div></div>' : ''}
      ${W.issues.length ? `<div class="banner banner-warn"><div><ul>${W.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
      ${W.keyUncertainty ? `<div class="ai-card"><span class="label-mono">The question that decides which world happens</span><p>${esc(W.keyUncertainty)}</p></div>` : ''}
      <div class="worlds-grid">${W.worlds.map((w) => (w ? `<article class="world world-${w.key}">
        <div class="world-head"><span class="pill ${WORLD_META[w.key].pill}">${WORLD_META[w.key].label}</span><span class="label-mono">→ ${WORLD_META[w.key].maps}</span></div>
        <h3>${esc(w.title)}</h3>
        <div class="world-nums"><div><span class="label-mono">Chance</span><strong class="num">${pct(w.probability)}</strong></div><div><span class="label-mono">Exit value</span><strong class="num">${fmtEur(w.exit)}</strong></div></div>
        <p class="small">${esc(w.story)}</p>
        <div class="stack"><span class="label-mono">Assumptions</span>
          <ul class="assumptions">${w.assumptions.map((a) => `<li>${basisPill(a)}<span>${esc(a.text)}</span>
            ${a.basis === 'pitch' && a.quote ? `<span class="quote">${esc(a.quote)}</span>` : ''}
            ${a.basis === 'benchmark' ? `<span class="small muted">${esc((W.facts.find((x) => x.id === a.benchmarkId) || {}).text || '')}</span>` : ''}
            ${a.basis === 'judgement' && a.why ? `<span class="small muted">Why: ${esc(a.why)}</span>` : ''}</li>`).join('')}</ul></div>
        ${w.conditions.length ? `<div class="stack"><span class="label-mono">Must be true for this world, not the others</span><ul class="tight">${w.conditions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${w.signals.length ? `<div class="stack"><span class="label-mono">Early signals in the next 12 months</span><ul class="tight">${w.signals.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </article>` : '<article class="world"><p class="muted">Missing</p></article>')).join('')}</div>
      ${W.flags.length ? `<div class="stack"><span class="label-mono">Where the pitch may be too optimistic</span><ul class="switch-list">${W.flags.map((x) => `<li><span class="pill ${x.found ? 'pill-warn' : 'pill-stop'}">${x.found ? 'Pitch claim' : 'Quote not found'}</span><span><span class="quote">${esc(x.quote)}</span><br>${esc(x.concern)}</span></li>`).join('')}</ul></div>` : ''}
      ${W.usable ? `<div class="table-wrap"><table><thead><tr><th>Scenario input</th><th class="num">Current value</th><th class="num">From the AI worlds</th></tr></thead><tbody>
        <tr><td>Big success: probability</td><td class="num">${pct(c.scenarios.pBig)}</td><td class="num">${pct(g.probability)}</td></tr>
        <tr><td>Big success: exit value</td><td class="num">${fmtEur(c.scenarios.exitBig)}</td><td class="num">${fmtEur(g.exit)}</td></tr>
        <tr><td>Moderate outcome: probability</td><td class="num">${pct(c.scenarios.pMod)}</td><td class="num">${pct(n.probability)}</td></tr>
        <tr><td>Moderate outcome: exit value</td><td class="num">${fmtEur(c.scenarios.exitMod)}</td><td class="num">${fmtEur(n.exit)}</td></tr>
        <tr><td>Failure: probability</td><td class="num">${pct(1 - c.scenarios.pBig - c.scenarios.pMod)}</td><td class="num">${pct(wst.probability)}</td></tr>
      </tbody></table></div>
      <div class="row"><button type="button" class="btn btn-primary" data-action="use-worlds" ${applied && !stale ? 'disabled' : ''}>${applied ? 'AI numbers in use' : 'Use these numbers'}</button>
        <button type="button" class="btn btn-small" data-action="run-worlds">Run again</button>
        <span class="hint">You can still change every number in “Scenario estimates” below.</span></div>` : '<div class="row"><button type="button" class="btn btn-small" data-action="run-worlds">Run again</button></div>'}`;
  }
  return `<section class="panel" id="worlds">
    <div class="panel-head"><h2>AI scenarios: good, neutral and worst world</h2><span class="tag tag-ai">AI suggests · analyst decides</span></div>
    <p class="small muted">Pitches are optimistic. The AI starts from base rates, describes three futures and labels every assumption: from the pitch (quote checked word for word), from benchmark data, or its own judgement.</p>
    ${errorBlock('worlds')}${body}
  </section>`;
}

// ---------- tool page: sector benchmarks ----------
function viewBench() {
  const companies = ycCompanies();
  const b = state.bench;
  const sectors = state.settings.options.sectors.filter((s) => s !== 'Other');
  const regions = [['all', 'All regions'], ['eu', 'Europe'], ['dach', 'Germany, Austria, Switzerland']];
  let body;
  if (!companies) {
    body = state.ycError ? `<div class="banner banner-stop"><div><p>${esc(state.ycError)}</p></div></div>` : '<section class="panel"><div class="row"><span class="spinner" style="color:var(--code)"></span><span>Loading 6,000+ startups…</span></div></section>';
  } else {
    const s = B.sectorSummary(companies, b.sector, b.region);
    const m = s.mature;
    const list = B.filterCompanies(companies, { sector: b.sector, region: b.region });
    const q = b.q.trim().toLowerCase();
    const shown = list.filter((x) => !q || x.n.toLowerCase().includes(q) || x.o.toLowerCase().includes(q) || (x.sub || '').toLowerCase().includes(q))
      .sort((a, z) => z.y - a.y || a.n.localeCompare(z.n)).slice(0, 40);
    const team = B.compareTeam(B.filterCompanies(companies, { region: b.region }), b.sector, 1);
    const vbs = B.VALUATION_BENCHMARKS;
    body = `
    <div class="kpis">
      <div class="kpi"><span class="label-mono">Companies</span><strong class="num">${s.n.toLocaleString('en-US')}</strong><span class="small muted">${esc(b.sector)} · ${esc(regions.find((r) => r[0] === b.region)[1])}</span></div>
      ${m.n >= 10 ? `<div class="kpi"><span class="label-mono">Shut down</span><strong class="num">${pct(m.shares.Inactive)}</strong><span class="small muted">of ${m.n} started 2010–2019</span></div>
      <div class="kpi"><span class="label-mono">Acquired or public</span><strong class="num">${pct(m.shares.Acquired + m.shares.Public)}</strong><span class="small muted">of ${m.n} started 2010–2019</span></div>
      <div class="kpi"><span class="label-mono">Still active</span><strong class="num">${pct(m.shares.Active)}</strong><span class="small muted">of ${m.n} started 2010–2019</span></div>` : '<div class="kpi"><span class="label-mono">Outcomes</span><strong>Too few</strong><span class="small muted">Fewer than 10 companies from 2010–2019</span></div>'}
      ${team ? `<div class="kpi"><span class="label-mono">Median team</span><strong class="num">${Math.round(team.median)}</strong><span class="small muted">recent companies</span></div>` : ''}
    </div>
    <section class="panel">
      <div class="panel-head"><h2>Outcomes by the year companies started</h2><span class="tag tag-code">Code · fixed data</span></div>
      <p class="small muted">Older groups have had more time, so their outcomes are more final. Recent groups are mostly still active because it is too early to tell.</p>
      ${statusLegend()}
      <div class="stack">${s.cohorts.filter((co) => co.n > 0).map((co) => stackedBar(co.shares, co.label, co.n)).join('')}</div>
      <details><summary>Show as a table</summary><div class="table-wrap"><table><thead><tr><th>Started</th><th class="num">Companies</th>${STATUS_ORDER.map((st) => `<th class="num">${esc(B.STATUS_LABEL[st])}</th>`).join('')}</tr></thead>
        <tbody>${s.cohorts.map((co) => `<tr><td>${esc(co.label)}</td><td class="num">${co.n}</td>${STATUS_ORDER.map((st) => `<td class="num">${co.n ? pct(co.shares[st]) : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Valuation benchmarks</h2><span class="hint">Published medians, with sources</span></div>
      <div class="table-wrap"><table><thead><tr><th>Market</th><th class="num">Median pre-money</th><th class="num">Median round</th><th>Source</th></tr></thead><tbody>
        ${vbs.map((x) => `<tr class="${x.sector === b.sector ? 'is-rec' : ''}"><td>${esc(x.label)}</td><td class="num">${x.currency === 'USD' ? '$' : '€'}${(x.preMoney / 1e6).toFixed(1)}m</td><td class="num">${x.dealSize ? `${x.currency === 'USD' ? '$' : '€'}${(x.dealSize / 1e6).toFixed(1)}m` : '—'}</td><td class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)}</a></td></tr>`).join('')}
        ${B.GRADUATION_BENCHMARKS.map((g) => `<tr><td colspan="2">${esc(g.label)}</td><td class="num">${pct(g.value)}</td><td class="small"><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.source)}</a></td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted">No published source in this set gives seed valuations for every sector. Where a sector has no figure, the tool compares with the overall European seed median.</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Companies</h2><span class="hint">${list.length.toLocaleString('en-US')} in this selection · newest first · showing up to 40</span></div>
      <label class="field" for="bench-q"><span>Search by name or what they do</span><input type="text" id="bench-q" data-bench="q" value="${esc(b.q)}" placeholder="e.g. payments, insurance, scheduling"></label>
      ${shown.length ? companyRows(shown) : '<p class="muted">No companies match.</p>'}
      ${dataSourceNote()}
    </section>`;
  }
  return `<div class="step-head"><div class="step-head-row"><span class="eyebrow">Tool</span><span class="tag tag-code">Code · fixed data</span></div>
    <h1>How are other startups in this sector doing?</h1></div>
  <p class="lead muted">Outcomes of more than 6,000 Y Combinator startups, plus published valuation benchmarks. Choose a sector and a region.</p>
  <section class="panel"><div class="grid-2">
    <label class="field" for="bench-sector"><span>Sector</span><select id="bench-sector" data-bench="sector">${sectors.map((x) => `<option ${x === b.sector ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    <div class="stack"><span class="label-mono">Region</span><div class="chips">${regions.map(([id, label]) => `<button type="button" class="chip-toggle" data-action="bench-region" data-region="${id}" aria-pressed="${b.region === id}">${esc(label)}</button>`).join('')}</div></div>
  </div></section>
  ${body}`;
}

// ---------- tool page: performance metrics ----------
function hbar(value, max, slot, label) {
  return `<div class="hbar"><div class="hbar-fill s${slot}" style="width:${max ? Math.max(1, value / max * 100) : 0}%" title="${esc(label)}"></div></div>`;
}

function viewMetrics() {
  const real = state.log.filter((r) => !r.demo);
  const useExample = state.metricsExample;
  const records = useExample ? [...MX.exampleHistory(), ...real] : real;
  const m = MX.computeMetrics(records);
  const F = MX.findings(m);
  const o = m.outcomes;
  const fieldsShown = m.ai.perField.filter((x) => x.changed + x.rejected > 0).slice(0, 6);
  const fmax = Math.max(1, ...fieldsShown.map((x) => x.changed + x.rejected));

  const tiles = `<div class="kpis">
    <div class="kpi"><span class="label-mono">Decisions</span><strong class="num">${m.n}</strong><span class="small muted">${useExample ? `${real.length} real + ${m.n - real.length} example` : 'real decisions'}</span></div>
    <div class="kpi"><span class="label-mono">AI values kept</span><strong class="num">${m.ai.accuracy === null ? '—' : pct(m.ai.accuracy)}</strong><span class="small muted">unchanged by the analyst</span></div>
    <div class="kpi"><span class="label-mono">Quote check</span><strong class="num">${m.ai.rejectionRate === null ? '—' : pct(m.ai.rejectionRate)}</strong><span class="small muted">of AI values rejected</span></div>
    <div class="kpi"><span class="label-mono">Overrides</span><strong class="num">${m.committee.overrideRate === null ? '—' : pct(m.committee.overrideRate)}</strong><span class="small muted">committee departed from the recommendation</span></div>
    <div class="kpi"><span class="label-mono">Milestones hit</span><strong class="num">${o.hitRate === null ? '—' : pct(o.hitRate)}</strong><span class="small muted">${o.predicted === null ? 'no outcomes yet' : `predicted ${pct(o.predicted)} · ${o.known} known`}</span></div>
  </div>`;

  const calib = o.bins.filter((bn) => bn.n > 0);
  return `<div class="step-head"><div class="step-head-row"><span class="eyebrow">Tool</span><span class="tag tag-code">Code · from the decision log</span></div>
    <h1>How well are our decisions and the AI performing?</h1></div>
  <p class="lead muted">Compares what the AI and the model said with what analysts corrected, what the committee decided and what happened later. The findings point to changes that partners make in the fund rules or the AI instructions. Nothing changes automatically.</p>
  <section class="panel">
    <label class="confirm-box" for="metrics-example"><input type="checkbox" id="metrics-example" data-metrics-example="1" ${useExample ? 'checked' : ''}>
      <span><strong>Include the example history</strong><br><span class="small muted">24 fictional past decisions from 2024–2025, so the metrics can be shown before real outcomes exist. Startup outcomes take years. Real decisions from step 9 are always included (${real.length} so far).</span></span></label>
    ${useExample ? '<div class="banner banner-warn"><div><strong>Example data</strong><p>Most numbers on this page come from fictional decisions. They show how the metrics work, not how this fund performs.</p></div></div>' : ''}
  </section>
  ${m.n ? `${tiles}
  <section class="panel">
    <div class="panel-head"><h2>What the data suggests</h2><span class="hint">Fixed rules, not AI</span></div>
    ${F.length ? `<ul class="findings">${F.map((x) => `<li><span class="pill pill-neutral">${esc(x.area)}</span><div><p>${esc(x.text)}</p><p class="small"><strong>Suggested change:</strong> ${esc(x.action)}</p></div></li>`).join('')}</ul>` : '<p class="muted">Not enough data for findings yet. They appear once there are about 6 decisions with known outcomes.</p>'}
    <div><button type="button" class="btn btn-small" data-action="goto" data-step="1">Open fund rules</button></div>
  </section>
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><h2>Which AI values needed fixing</h2></div>
      <div class="legend-row"><span class="legend-item"><span class="swatch s1"></span>Corrected by analyst</span><span class="legend-item"><span class="swatch s2"></span>Rejected by quote check</span></div>
      ${fieldsShown.length ? `<div class="stack">${fieldsShown.map((x) => `<div class="barrow"><span class="small">${esc(x.label)}</span>
        <div class="hbar">${x.changed ? `<div class="hbar-fill s1" style="width:${x.changed / fmax * 100}%" title="Corrected: ${x.changed}"></div>` : ''}${x.rejected ? `<div class="hbar-fill s2" style="width:${x.rejected / fmax * 100}%" title="Rejected: ${x.rejected}"></div>` : ''}</div>
        <span class="small num">${x.changed + x.rejected} of ${m.ai.cases}</span></div>`).join('')}</div>` : '<p class="muted small">No corrections recorded.</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Predicted vs actual milestones</h2></div>
      <div class="legend-row"><span class="legend-item"><span class="swatch s1"></span>Predicted chance</span><span class="legend-item"><span class="swatch s2"></span>Actually hit</span></div>
      ${calib.length ? `<div class="stack">${calib.map((bn) => `<div class="barrow2"><span class="small">${esc(bn.label)} <span class="muted">(${bn.n})</span></span>
        <div class="stack-tight"><div class="pairbar">${hbar(bn.predicted, 1, 1, `Predicted ${pct(bn.predicted)}`)}<span class="small num">${pct(bn.predicted)}</span></div>
        <div class="pairbar">${hbar(bn.actual, 1, 2, `Hit ${pct(bn.actual)}`)}<span class="small num">${pct(bn.actual)}</span></div></div></div>`).join('')}</div>
        <p class="small muted">If the model is well calibrated, the two bars in each row are about the same length.${o.brier !== null ? ` Brier score ${o.brier.toFixed(2)} (0 is perfect, 0.25 is a coin flip).` : ''}</p>` : '<p class="muted small">No milestone outcomes yet. Record reviews in step 9.</p>'}
    </section>
  </div>
  <section class="panel">
    <div class="panel-head"><h2>Committee and score</h2></div>
    <div class="table-wrap"><table><thead><tr><th>Measure</th><th class="num">Value</th><th>Based on</th></tr></thead><tbody>
      <tr><td>Milestones hit when the recommendation was followed</td><td class="num">${o.followedHitRate === null ? '—' : pct(o.followedHitRate)}</td><td class="small muted">${o.followedN} decisions with known outcome</td></tr>
      <tr><td>Milestones hit after an override</td><td class="num">${o.overriddenHitRate === null ? '—' : pct(o.overriddenHitRate)}</td><td class="small muted">${o.overriddenN} decisions with known outcome</td></tr>
      <tr><td>Average score of startups that hit their milestone</td><td class="num">${o.scoreHit === null ? '—' : o.scoreHit.toFixed(1)}</td><td class="small muted">score out of 100</td></tr>
      <tr><td>Average score of startups that missed</td><td class="num">${o.scoreMiss === null ? '—' : o.scoreMiss.toFixed(1)}</td><td class="small muted">score out of 100</td></tr>
      <tr><td>Cases where the AI challenge was run</td><td class="num">${m.committee.challengeRate === null ? '—' : pct(m.committee.challengeRate)}</td><td class="small muted">${m.committee.analysed} analysed cases</td></tr>
      <tr><td>Cases using the AI worlds for scenario numbers</td><td class="num">${m.committee.aiScenarioRate === null ? '—' : pct(m.committee.aiScenarioRate)}</td><td class="small muted">${m.committee.analysed} analysed cases</td></tr>
    </tbody></table></div>
  </section>
  <details class="panel"><summary><strong>All decisions in these metrics</strong> <span class="hint">${m.n}</span></summary>
    <div class="table-wrap"><table><thead><tr><th>Company</th><th>Decided</th><th class="num">Score</th><th>Recommended</th><th>Decided</th><th class="num">Predicted</th><th>Outcome</th></tr></thead><tbody>
      ${records.map((r) => `<tr><td>${esc(r.company)}${r.demo ? ' <span class="pill pill-warn">Example</span>' : ''}</td><td class="small">${esc((r.decidedAt || '').slice(0, 10))}</td><td class="num">${typeof r.results?.score === 'number' ? r.results.score.toFixed(1) : '—'}</td>
        <td>${esc(M.ACTION_LABEL[r.results?.recommendation] || '—')}</td><td>${esc(M.ACTION_LABEL[r.decision?.action] || '—')}${r.decision?.override ? ' <span class="pill pill-warn">Override</span>' : ''}</td>
        <td class="num">${typeof r.results?.progressProb === 'number' ? pct(r.results.progressProb) : '—'}</td><td>${{ hit: '<span class="pill pill-good">Milestone hit</span>', missed: '<span class="pill pill-stop">Missed</span>' }[MX.outcomeOf(r)] || '<span class="muted small">Not known yet</span>'}</td></tr>`).join('')}
    </tbody></table></div></details>` : '<section class="panel"><p class="muted">No decisions yet. Record decisions in step 8, or include the example history above.</p></section>'}`;
}

// ---------- events ----------
const actions = {
  goto: (el) => goto(/^\d+$/.test(el.dataset.step) ? Number(el.dataset.step) : el.dataset.step),
  'load-sample': (el) => {
    const cur = activeCase();
    if (cur && !cur.pitchText.trim() && !cur.decisionId) state.cases = state.cases.filter((x) => x.id !== cur.id);
    makeCase(el.dataset.id);
    render();
    toast(`Loaded ${sampleById(el.dataset.id).name} as a new case`);
  },
  'to-extract': () => {
    const c = activeCase();
    goto(3);
    if (!c.extraction || c.extraction.pitchText !== c.pitchText) runExtraction();
  },
  'run-extract': () => runExtraction(),
  'manual-entry': () => manualEntry(),
  'save-passcode': () => {
    const v = document.getElementById('passcode').value.trim();
    session.set('passcode', v); state.needPasscode = false; state.error = null; render(); toast('Passcode saved for this browser session');
  },
  'confirm-field': (el) => {
    const c = activeCase(); c.confirmed[el.dataset.k] = !c.confirmed[el.dataset.k]; c.verified = false; save(); render();
  },
  'confirm-all': () => {
    const c = activeCase(); M.FIELD_ORDER.forEach((k) => { if (!isEmpty(c.values[k])) c.confirmed[k] = true; }); save(); render();
  },
  'example-inputs': () => {
    const c = activeCase(); const s = sampleById(c.sampleId); const ex = s.analystExample;
    Object.entries(ex.values).forEach(([k, v]) => { c.values[k] = v; c.sources[k] = { ...(c.sources[k] || {}), by: 'analyst' }; c.confirmed[k] = true; });
    Object.assign(c.scores, ex.scores);
    Object.assign(c.scenarios, ex.scenarios);
    Object.assign(c.tranche, ex.tranche);
    c.verified = false; c.draftDecision = null; save(); render(); toast('Example analyst inputs filled in. Confirm the AI values to continue.');
  },
  score: (el) => {
    const c = activeCase(); c.scores[el.dataset.c] = Number(el.dataset.v); c.verified = false; c.draftDecision = null; save(); render();
  },
  'to-screening': () => {
    const c = activeCase(); c.verified = true; c.draftDecision = null; state.whatIf = null; save(); goto(5);
  },
  'reset-whatif': () => { state.whatIf = null; render(); },
  'run-challenge': () => runChallenge(),
  'run-worlds': () => runWorlds(),
  'use-worlds': () => {
    const c = activeCase(); const W = c.worlds;
    if (!W?.usable) return;
    const [g, n] = W.worlds;
    c.scenarios = { pBig: +g.probability.toFixed(4), exitBig: g.exit, pMod: +n.probability.toFixed(4), exitMod: n.exit };
    c.scenarioSource = 'ai-worlds'; c.verified = false; c.draftDecision = null;
    save(); render(); toast('Scenario estimates now use the AI worlds. Check them, then run screening again.');
  },
  'run-peers': () => runPeers(),
  'bench-region': (el) => { state.bench.region = el.dataset.region; render(); },
  'record-decision': () => recordDecision(),
  'save-review': (el) => {
    const rec = state.log.find((r) => r.id === el.dataset.id);
    const outcome = document.getElementById(`rv-out-${rec.id}`).value;
    const notes = document.getElementById(`rv-notes-${rec.id}`).value.trim();
    const next = document.getElementById(`rv-next-${rec.id}`).value;
    rec.reviews.push({ date: today(), outcome, notes });
    const final = /release|Write-off|Revisit/.test(outcome) && !/Extend/.test(outcome);
    if (final) rec.status = 'closed'; else rec.decision.reviewDate = next || addMonths(6);
    save(); render(); toast(final ? 'Review saved. The record is closed.' : `Review saved. Next review on ${rec.decision.reviewDate}.`);
  },
  'add-lesson': () => {
    const t = document.getElementById('lesson-text').value.trim();
    if (!t) { toast('Write the lesson first.'); return; }
    state.settings.lessons.push({ date: today(), text: t }); save(); render(); toast('Lesson saved to the fund rules');
  },
  'toggle-allowed': (el) => {
    const d = state.draft; const list = d.allowed[el.dataset.key]; const v = el.dataset.val;
    d.allowed[el.dataset.key] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    render();
  },
  'add-criterion': () => {
    state.draft.criteria.push({ id: `c${Date.now().toString(36)}`, name: 'New criterion', weight: 0, anchors: { 1: '', 3: '', 5: '' } });
    render();
  },
  'remove-criterion': (el) => { state.draft.criteria.splice(Number(el.dataset.i), 1); render(); },
  'save-rules': () => {
    const d = state.draft;
    d.version = (state.settings.version || 1) + 1; d.updatedAt = new Date().toISOString();
    state.settings = clone(d); state.draft = clone(d);
    state.cases.forEach((c) => { d.criteria.forEach((cr) => { if (!(cr.id in c.scores)) c.scores[cr.id] = null; }); });
    save(); render(); toast(`Fund rules saved as version ${d.version}`);
  },
  'discard-rules': () => { state.draft = clone(state.settings); render(); },
  'defaults-rules': () => {
    if (state.confirmReset !== 'rules') { state.confirmReset = 'rules'; render(); return; }
    const lessons = state.draft.lessons;
    state.draft = { ...M.defaultSettings(), version: state.settings.version, lessons };
    state.confirmReset = false; render(); toast('Default rules loaded. Save to apply them.');
  },
  export: () => {
    const data = { exportedAt: new Date().toISOString(), app: 'startup-investment-decision-tool', settings: state.settings, cases: state.cases, log: state.log };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `decision-tool-export-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'reset-all': () => {
    if (state.confirmReset !== 'all') { state.confirmReset = 'all'; render(); return; }
    state.settings = M.defaultSettings(); state.cases = []; state.log = []; state.confirmReset = false;
    makeCase('lumio'); state.step = 2; save(); render(); toast('All data deleted. Lumio is loaded as a fresh case.');
  },
};

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.dataset.action !== 'defaults-rules' && el.dataset.action !== 'reset-all') state.confirmReset = false;
  actions[el.dataset.action]?.(el, e);
}

function readKind(el) {
  const k = el.dataset.kind;
  if (k === 'pct') return el.value === '' ? NaN : Number(el.value) / 100;
  if (k === 'money') return parseMoney(el.value);
  if (k === 'num') return el.value === '' ? NaN : Number(el.value);
  if (k === 'lines') return el.value.split('\n').map((x) => x.trim()).filter(Boolean);
  return el.value;
}

function onInput(e) {
  const el = e.target;
  const c = activeCase();
  if (el.dataset.case === 'pitchText') {
    c.pitchText = el.value; save();
    document.getElementById('pitch-count').textContent = pitchCount(c);
    const btn = document.querySelector('[data-action="to-extract"]');
    if (btn) btn.disabled = !el.value.trim() || el.value.length > MAX_PITCH_CHARS;
    return;
  }
  if (el.dataset.wi) {
    if (!state.whatIf || state.whatIf.caseId !== c.id) state.whatIf = { caseId: c.id, scores: { ...c.scores }, pBig: c.scenarios.pBig, valuation: c.values.post_money_valuation };
    const [kind, id] = el.dataset.wi.split('.');
    if (kind === 'score') state.whatIf.scores[id] = Number(el.value);
    if (kind === 'pBig') state.whatIf.pBig = Number(el.value) / 100;
    if (kind === 'valuation') state.whatIf.valuation = Number(el.value);
    refreshAnalysis();
    return;
  }
  if (el.dataset.peerquery) { c.peerQuery = el.value; save(); return; }
  if (el.dataset.bench === 'q') { state.bench.q = el.value; render(); return; }
  if (el.dataset.decision && el.type !== 'radio' && el.type !== 'date') {
    c.draftDecision[el.dataset.decision] = el.value; save();
  }
}

function onChange(e) {
  const el = e.target;
  const c = activeCase();
  if (el.id === 'case-select') {
    state.activeId = el.value; state.whatIf = null; state.error = null; save();
    const f = flow(activeCase());
    state.step = [8, 7, 6, 5, 4, 3, 2].find((n) => available(n, f)) || 2;
    if (activeCase().decisionId) state.step = 9;
    render(); return;
  }
  if (el.id === 'import-file') { importFile(el.files[0]); return; }
  if (el.id === 'pitch-files') { const fl = [...el.files]; el.value = ''; handleFiles(fl); return; }
  if (el.dataset.draft) {
    let v = readKind(el);
    if (el.dataset.kind && el.dataset.kind !== 'lines' && Number.isNaN(v)) { toast('Enter a number.'); render(); return; }
    setPath(state.draft, el.dataset.draft, v);
    setTimeout(render, 0); return;
  }
  if (el.dataset.field) {
    const k = el.dataset.field; const meta = M.FIELD_META[k];
    let v = el.value.trim();
    if (meta.type === 'eur' || meta.type === 'int') {
      v = v === '' ? null : parseMoney(v);
      if (Number.isNaN(v)) { toast(`“${el.value}” is not a number. Try 500k, 5m or 5000000.`); setTimeout(render, 0); return; }
      if (meta.type === 'int' && v !== null) v = Math.round(v);
    }
    if (v === '') v = null;
    const changed = v !== c.values[k];
    c.values[k] = v;
    if (changed) { c.sources[k] = { ...(c.sources[k] || {}), by: 'analyst' }; c.confirmed[k] = v !== null; }
    if (k === 'raise_amount' && (c.ticket === null || c.ticket === undefined)) c.ticket = v;
    if (k === 'company_name' && v) c.label = v;
    c.verified = false; c.draftDecision = null; save(); setTimeout(render, 0); return;
  }
  if (el.dataset.bench === 'sector') { state.bench.sector = el.value; state.bench.q = ''; render(); return; }
  if (el.dataset.metricsExample) { state.metricsExample = el.checked; render(); return; }
  if (el.dataset.casenum) {
    const v = readKind(el);
    if (Number.isNaN(v) || v === null) { toast('Enter a number.'); setTimeout(render, 0); return; }
    setPath(c, el.dataset.casenum, v);
    if (el.dataset.casenum.startsWith('scenarios.')) c.scenarioSource = 'analyst';
    c.verified = false; c.draftDecision = null; save(); setTimeout(render, 0); return;
  }
  if (el.dataset.casetext) { setPath(c, el.dataset.casetext, el.value); c.draftDecision = null; save(); return; }
  if (el.dataset.redflag) {
    const rf = el.dataset.redflag;
    c.redFlags = el.checked ? [...new Set([...c.redFlags, rf])] : c.redFlags.filter((x) => x !== rf);
    c.verified = false; c.draftDecision = null; save(); setTimeout(render, 0); return;
  }
  if (el.dataset.decision) {
    c.draftDecision[el.dataset.decision] = el.value; state.decisionError = null; save();
    if (el.type === 'radio') setTimeout(render, 0);
  }
}

function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d.settings || !Array.isArray(d.cases) || !Array.isArray(d.log)) throw new Error('This file is not an export from this tool.');
      state.settings = { ...M.defaultSettings(), ...d.settings };
      state.cases = d.cases; state.log = d.log;
      state.activeId = d.cases[0]?.id || null;
      if (!state.activeId) makeCase('lumio');
      save(); render(); toast(`Imported ${d.cases.length} cases and ${d.log.length} decisions`);
    } catch (err) { toast(`Import failed: ${err.message}`); }
  };
  reader.readAsText(file);
}

// ---------- start ----------
function start() {
  if (!state.cases.length) makeCase('lumio');
  if (!activeCase()) state.activeId = state.cases[0].id;
  document.getElementById('main').addEventListener('click', onClick);
  document.getElementById('steps').addEventListener('click', onClick);
  document.getElementById('tools').addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  const main = document.getElementById('main');
  main.addEventListener('dragover', (e) => {
    const dz = e.target.closest?.('#dropzone');
    if (!dz) return;
    e.preventDefault(); dz.classList.add('over');
  });
  main.addEventListener('dragleave', (e) => { e.target.closest?.('#dropzone')?.classList.remove('over'); });
  main.addEventListener('drop', (e) => {
    const dz = e.target.closest?.('#dropzone');
    if (!dz) return;
    e.preventDefault(); dz.classList.remove('over');
    handleFiles(e.dataTransfer?.files);
  });
  // stop a file dropped next to the drop zone from opening in the browser tab
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!e.target.closest?.('#dropzone')) e.preventDefault(); });
  document.getElementById('new-case').addEventListener('click', () => { makeCase(); goto(2); toast('New case started. Paste a pitch or load a test pitch.'); });
  render();
  checkAI();
  loadYC();
  const due = dueReviews().length;
  if (due) toast(`${due} review${due > 1 ? 's are' : ' is'} due. See step 9.`);
}

start();
