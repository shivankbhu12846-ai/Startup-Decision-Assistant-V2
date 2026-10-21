// model.js — the fixed rules ("Code" in the workflow).
// Pure functions only: the same inputs always give the same result,
// so every number can be checked by hand. No AI is used in this file.

export const FIELD_META = {
  company_name: { label: 'Company name', type: 'text' },
  sector: { label: 'Sector', type: 'choice', options: 'sectors' },
  stage: { label: 'Stage', type: 'choice', options: 'stages' },
  region: { label: 'HQ country / region', type: 'choice', options: 'regions' },
  raise_amount: { label: 'Amount raised in this round', type: 'eur' },
  post_money_valuation: { label: 'Post-money valuation', type: 'eur' },
  monthly_revenue: { label: 'Monthly revenue', type: 'eur' },
  paying_customers: { label: 'Paying customers', type: 'int' },
  team_size: { label: 'Team size', type: 'int' },
  monthly_burn: { label: 'Monthly burn', type: 'eur' },
};
export const FIELD_ORDER = Object.keys(FIELD_META);

// Key inputs count towards the "more than two missing" stop rule.
export const KEY_FIELDS = [
  'sector', 'stage', 'region', 'raise_amount', 'post_money_valuation',
  'monthly_revenue', 'paying_customers', 'team_size', 'monthly_burn',
];
// Critical inputs stop the process on their own: without them no
// ownership share or expected value can be calculated.
export const CRITICAL_FIELDS = ['raise_amount', 'post_money_valuation'];

export function defaultSettings() {
  return {
    version: 1,
    updatedAt: null,
    fundName: 'Pilot Seed Fund',
    options: {
      sectors: ['B2B software', 'AI', 'Fintech', 'Healthtech', 'Climate', 'Consumer', 'Hardware', 'Biotech', 'Other'],
      stages: ['Pre-seed', 'Seed', 'Series A', 'Series B or later'],
      regions: ['Austria', 'Germany', 'Switzerland', 'Other EU', 'United Kingdom', 'United States', 'Other'],
    },
    allowed: {
      sectors: ['B2B software', 'AI'],
      stages: ['Seed'],
      regions: ['Austria', 'Germany', 'Switzerland'],
    },
    ticketMin: 250000,
    ticketMax: 1000000,
    redFlags: [
      'Unresolved legal dispute',
      'Founder conflict or key founder leaving',
      'Unclear IP ownership',
      'Founders hold less than 50% after this round',
      'Business model depends on a regulatory grey zone',
    ],
    criteria: [
      { id: 'team', name: 'Team', weight: 25, anchors: {
        1: 'Solo founder or no relevant experience',
        3: 'Complete founding team with some domain experience',
        5: 'Repeat founders with deep domain expertise or a prior exit' } },
      { id: 'market', name: 'Market', weight: 25, anchors: {
        1: 'Small or shrinking niche (under €100m)',
        3: 'Sizeable market with moderate growth',
        5: 'Large, fast-growing market (over €1bn) with clear demand' } },
      { id: 'traction', name: 'Traction', weight: 20, anchors: {
        1: 'No paying customers yet',
        3: 'First paying customers and early recurring revenue',
        5: 'Strong recurring revenue growing over 15% a month' } },
      { id: 'moat', name: 'Moat', weight: 10, anchors: {
        1: 'Easy to copy, no defensibility',
        3: 'Some defensibility: data, integrations or switching costs',
        5: 'Strong moat: proprietary tech, network effects or regulation' } },
      { id: 'deal', name: 'Deal terms', weight: 20, anchors: {
        1: 'Valuation far above comparables or unfavourable terms',
        3: 'Market-standard valuation and terms',
        5: 'Attractive valuation and investor-friendly terms' } },
    ],
    threshold: 65,
    // A switch point within these margins makes the recommendation "fragile".
    fragility: { scorePoints: 1, relative: 0.25 },
    // Failure probability at or above this counts as "high uncertainty".
    highUncertaintyFailProb: 0.6,
    // "Waiting costs little": the expected value of waiting is within this
    // share of the best invest action.
    waitTolerance: 0.25,
    defaults: {
      dilutionToExit: 0.5,
      firstTrancheShare: 0.5,
      milestoneMonths: 6,
      progressIfSuccess: 0.9,
      progressIfFailure: 0.3,
      nextRoundStepUp: 2.5,
      allocationProb: 0.7,
      dilutionAfterNextRound: 0.4,
    },
    lessons: [],
  };
}

// ---------- helpers ----------
const isMissing = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
const n = (v) => (isMissing(v) ? NaN : Number(v));

// ---------- step 4 stop rule ----------
export function missingCheck(values) {
  const missingKey = KEY_FIELDS.filter((k) => isMissing(values[k]));
  const missingCritical = CRITICAL_FIELDS.filter((k) => isMissing(values[k]));
  const reasons = [];
  if (missingCritical.length) {
    reasons.push(`Critical input missing: ${missingCritical.map((k) => FIELD_META[k].label.toLowerCase()).join(', ')}. No ownership share or expected value can be calculated without it.`);
  }
  if (missingKey.length > 2) {
    reasons.push(`${missingKey.length} key inputs are missing (the limit is 2). Research them before anything is calculated.`);
  }
  return { missingKey, missingCritical, stop: reasons.length > 0, reasons };
}

// ---------- step 5 screening ----------
export function screening(settings, c) {
  const v = c.values;
  const ticket = n(c.ticket);
  const checks = [
    { id: 'sector', label: 'Sector', value: v.sector, pass: settings.allowed.sectors.includes(v.sector),
      rule: `one of ${settings.allowed.sectors.join(', ')}` },
    { id: 'stage', label: 'Stage', value: v.stage, pass: settings.allowed.stages.includes(v.stage),
      rule: `one of ${settings.allowed.stages.join(', ')}` },
    { id: 'region', label: 'Region', value: v.region, pass: settings.allowed.regions.includes(v.region),
      rule: `one of ${settings.allowed.regions.join(', ')}` },
    { id: 'ticket', label: 'Ticket size', value: ticket, pass: ticket >= settings.ticketMin && ticket <= settings.ticketMax,
      rule: `between €${fmtK(settings.ticketMin)} and €${fmtK(settings.ticketMax)}` },
    { id: 'redflags', label: 'Red flags', value: (c.redFlags || []).length ? c.redFlags.join('; ') : 'none',
      pass: !(c.redFlags || []).length, rule: 'none confirmed' },
  ];
  return { pass: checks.every((x) => x.pass), checks, failed: checks.filter((x) => !x.pass) };
}

function fmtK(x) {
  if (x >= 1e6) return `${+(x / 1e6).toFixed(2)}m`;
  if (x >= 1e3) return `${+(x / 1e3).toFixed(0)}k`;
  return String(x);
}

// ---------- step 6a score ----------
export function scoreOf(settings, scores) {
  const totalW = settings.criteria.reduce((a, cr) => a + Number(cr.weight || 0), 0);
  const parts = settings.criteria.map((cr) => {
    const s = Number(scores[cr.id]);
    const w = Number(cr.weight || 0);
    return { id: cr.id, name: cr.name, weight: w, score: s, points: totalW ? (w / totalW) * s * 20 : 0 };
  });
  const valid = parts.every((p) => p.score >= 1 && p.score <= 5);
  return { score: parts.reduce((a, p) => a + p.points, 0), parts, totalWeight: totalW, valid };
}

// ---------- step 6b/c expected value per action ----------
// Scenarios: big success (pBig, exitBig), moderate (pMod, exitMod), failure (rest, exit 0).
// "Progress" = the startup hits the tranche milestone or raises its next round.
// Two inputs describe how informative progress is:
//   a = chance that a startup which will eventually succeed shows progress
//   b = chance that a startup which will eventually fail still shows progress
// From these follow (Bayes' rule, always consistent with the scenarios):
//   P(progress) q = a·P(success) + b·P(failure)
//   P(failure | progress) = b·P(failure) / q
//   q · E[exit | progress] = a · E[exit]
export function evActions(c) {
  const errors = [];
  const V = n(c.values.post_money_valuation);
  const T = n(c.ticket);
  const { pBig, exitBig, pMod, exitMod } = c.scenarios;
  const pFail = 1 - pBig - pMod;
  const keep = 1 - c.dilutionToExit;
  const tr = c.tranche;
  const w = c.wait;
  const a = c.progress.ifSuccess;
  const b = c.progress.ifFailure;

  if (!(V > 0)) errors.push('Post-money valuation must be above zero.');
  if (!(T > 0)) errors.push('Ticket must be above zero.');
  if ([pBig, pMod].some((p) => !(p >= 0 && p <= 1)) || pFail < -1e-9) errors.push('Scenario probabilities must be between 0% and 100% and add up to at most 100%.');
  if ([exitBig, exitMod].some((x) => !(x >= 0))) errors.push('Exit values must be zero or more.');
  if (!(c.dilutionToExit >= 0 && c.dilutionToExit < 1)) errors.push('Dilution until exit must be between 0% and 99%.');
  if (!(tr.firstShare > 0 && tr.firstShare <= 1)) errors.push('First tranche must be between 1% and 100% of the ticket.');
  if (![a, b].every((x) => x >= 0 && x <= 1)) errors.push('Milestone probabilities must be between 0% and 100%.');
  if (!(w.stepUp > 0)) errors.push('Next-round valuation step-up must be above zero.');
  if (!(w.allocationProb >= 0 && w.allocationProb <= 1)) errors.push('Allocation probability must be between 0% and 100%.');
  if (!(w.dilutionAfter >= 0 && w.dilutionAfter < 1)) errors.push('Dilution after the next round must be between 0% and 99%.');
  if (errors.length) return { errors };

  const Eexit = pBig * exitBig + pMod * exitMod;
  const pSuccess = pBig + pMod;
  const q = a * pSuccess + b * pFail;
  const failIfProgress = q > 0 ? (b * pFail) / q : null;
  const own = T / V;

  const now = { ev: own * keep * Eexit - T, upfront: T, worst: T, ownership: own };

  const t1 = T * tr.firstShare;
  const t2 = T - t1;
  // second tranche is paid only if the milestone is hit (probability q)
  const evTr = (t1 / V) * keep * Eexit - t1 + ((t2 / V) * keep * a * Eexit - q * t2);
  const tranches = { ev: evTr, upfront: t1, worst: T, ownership: own, t1, t2, lossIfMissed: t1 };

  const Vn = V * w.stepUp;
  const ownN = T / Vn;
  const keepN = 1 - w.dilutionAfter;
  // we invest only if the next round happens (q) and we get an allocation
  const evW = w.allocationProb * (ownN * keepN * a * Eexit - q * T);
  const wait = { ev: evW, upfront: 0, worst: T, ownership: ownN, nextValuation: Vn };

  const pass = { ev: 0, upfront: 0, worst: 0, ownership: 0 };

  return {
    errors, pFail, pSuccess, Eexit, ownership: own,
    progressProb: q, failIfProgress,
    actions: { now, tranches, wait, pass },
  };
}

// ---------- decision rule ----------
export const ACTION_LABEL = {
  now: 'Invest now', tranches: 'Invest in tranches', wait: 'Wait for next round', pass: 'Pass',
};

// The core rule decides the category (pass / wait / invest). Sensitivity looks for
// switch points between categories; the final step picks now vs tranches.
function coreDecision(settings, c, sc, ev, miss) {
  const reasons = [];
  if (sc.score < settings.threshold) {
    reasons.push(`Score ${sc.score.toFixed(1)} is below the threshold of ${settings.threshold}.`);
    return { category: 'pass', reasons, why: 'score' };
  }
  const A = ev.actions;
  if (A.now.ev <= 0) {
    reasons.push('Expected value of investing is zero or negative.');
    return { category: 'pass', reasons, why: 'ev' };
  }
  reasons.push(`Score ${sc.score.toFixed(1)} meets the threshold of ${settings.threshold}.`);
  reasons.push('Expected value of investing is positive.');
  const best = Math.max(A.now.ev, A.tranches.ev);
  if (miss.missingKey.length >= 1 && A.wait.ev > 0 && A.wait.ev >= (1 - settings.waitTolerance) * best) {
    reasons.push(`Key evidence is still missing (${miss.missingKey.map((k) => FIELD_META[k].label.toLowerCase()).join(', ')}) and waiting keeps at least ${Math.round((1 - settings.waitTolerance) * 100)}% of the expected value.`);
    return { category: 'wait', reasons, why: 'wait' };
  }
  return { category: 'invest', reasons, why: 'invest' };
}

export function evaluate(settings, c, { withSensitivity = true } = {}) {
  const miss = missingCheck(c.values);
  if (miss.stop) return { stage: 'stopped', category: 'stopped', miss };
  const screen = screening(settings, c);
  if (!screen.pass) {
    return {
      stage: 'screened-out', category: 'pass', miss, screen,
      recommendation: { action: 'pass', reasons: screen.failed.map((f) => `Fails screening on ${f.label.toLowerCase()}: ${fmtVal(f.value)} is not ${f.rule}.`) },
    };
  }
  const sc = scoreOf(settings, c.scores);
  if (!sc.valid) return { stage: 'invalid', category: null, miss, screen, errors: ['Every criterion needs a score from 1 to 5.'] };
  const ev = evActions(c);
  if (ev.errors.length) return { stage: 'invalid', category: null, miss, screen, sc, errors: ev.errors };

  const core = coreDecision(settings, c, sc, ev, miss);
  const highUncertainty = ev.pFail >= settings.highUncertaintyFailProb;
  const sens = withSensitivity ? sensitivity(settings, c, core.category) : null;
  const fragile = sens ? sens.fragile : false;

  let action = core.category === 'invest' ? 'now' : core.category;
  const reasons = [...core.reasons];
  if (core.category === 'invest') {
    if ((highUncertainty || fragile) && ev.actions.tranches.ev > 0) {
      action = 'tranches';
      if (highUncertainty) reasons.push(`Uncertainty is high: failure probability ${(ev.pFail * 100).toFixed(0)}% is at or above ${(settings.highUncertaintyFailProb * 100).toFixed(0)}%.`);
      if (fragile) reasons.push(`A switch point is close to our estimate: ${sens.mostFragile.text}`);
    } else {
      reasons.push('Uncertainty is acceptable and no switch point is close to our estimate.');
    }
  }
  return {
    stage: 'analysed', category: core.category, miss, screen, sc, ev, highUncertainty, sens, fragile,
    recommendation: { action, reasons },
  };
}

function fmtVal(v) {
  if (typeof v === 'number') return `€${fmtK(v)}`;
  return v || 'not given';
}

// ---------- step 6d sensitivity ----------
const NUMERIC_PARAMS = [
  { id: 'pBig', label: 'Big-success probability', kind: 'pct', get: (c) => c.scenarios.pBig, set: (c, x) => { c.scenarios.pBig = x; } },
  { id: 'exitBig', label: 'Big-success exit value', kind: 'eur', get: (c) => c.scenarios.exitBig, set: (c, x) => { c.scenarios.exitBig = x; } },
  { id: 'pMod', label: 'Moderate-outcome probability', kind: 'pct', get: (c) => c.scenarios.pMod, set: (c, x) => { c.scenarios.pMod = x; } },
  { id: 'exitMod', label: 'Moderate exit value', kind: 'eur', get: (c) => c.scenarios.exitMod, set: (c, x) => { c.scenarios.exitMod = x; } },
  { id: 'valuation', label: 'Post-money valuation', kind: 'eur', get: (c) => n(c.values.post_money_valuation), set: (c, x) => { c.values.post_money_valuation = x; } },
  { id: 'dilution', label: 'Dilution until exit', kind: 'pct', get: (c) => c.dilutionToExit, set: (c, x) => { c.dilutionToExit = x; } },
];

const clone = (o) => JSON.parse(JSON.stringify(o));
const CAT_LABEL = { pass: 'Pass', wait: 'Wait for next round', invest: 'Invest', stopped: 'Stopped' };

function categoryOf(settings, c) {
  const r = evaluate(settings, c, { withSensitivity: false });
  return { cat: r.category, r };
}

function whyText(r) {
  if (r.stage === 'screened-out') return 'fails screening';
  if (r.category === 'pass' && r.sc && r.sc.score < Infinity) {
    return r.recommendation.reasons[0].replace(/\.$/, '').toLowerCase();
  }
  if (r.category === 'wait') return 'waiting becomes the better option';
  if (r.category === 'invest') return `score ${r.sc.score.toFixed(1)}, positive expected value`;
  return '';
}

export function fmtParam(kind, x) {
  if (kind === 'pct') return `${+(x * 100).toFixed(1)}%`;
  if (kind === 'eur') return `€${fmtK(x)}`;
  return String(x);
}

export function sensitivity(settings, c, baseCat) {
  const points = [];

  for (const cr of settings.criteria) {
    const cur = Number(c.scores[cr.id]);
    let best = null;
    for (let v = 1; v <= 5; v++) {
      if (v === cur) continue;
      const t = clone(c);
      t.scores[cr.id] = v;
      const { cat, r } = categoryOf(settings, t);
      if (cat && cat !== baseCat) {
        const d = Math.abs(v - cur);
        if (!best || d < best.distance || (d === best.distance && v < best.to)) {
          best = { param: cr.id, label: `${cr.name} score`, kind: 'score', from: cur, to: v, distance: d,
            closeness: d / settings.fragility.scorePoints, newCategory: cat, r };
        }
      }
    }
    if (best) {
      const sTxt = best.r.sc ? ` (score ${best.r.sc.score.toFixed(1)})` : '';
      best.text = `${best.label} ${best.from} → ${best.to} flips the recommendation to ${CAT_LABEL[best.newCategory]}${sTxt}.`;
      best.fragile = best.distance <= settings.fragility.scorePoints;
      delete best.r;
      points.push(best);
    }
  }

  for (const p of NUMERIC_PARAMS) {
    const base = p.get(c);
    if (!(base > 0)) continue;
    let found = null;
    for (let i = 1; i <= 300 && !found; i++) {
      for (const k of [1 - i * 0.01, 1 + i * 0.01]) {
        if (k <= 0) continue;
        const x = base * k;
        if (p.kind === 'pct' && x >= 1) continue;
        const t = clone(c);
        p.set(t, x);
        if (p.id === 'pBig' || p.id === 'pMod') {
          if (t.scenarios.pBig + t.scenarios.pMod > 1) continue;
        }
        const { cat, r } = categoryOf(settings, t);
        if (cat && cat !== baseCat) {
          const rel = Math.abs(k - 1);
          found = { param: p.id, label: p.label, kind: p.kind, from: base, to: x, rel,
            closeness: rel / settings.fragility.relative, newCategory: cat,
            text: `${p.label} ${fmtParam(p.kind, base)} → ${fmtParam(p.kind, x)} (${k > 1 ? '+' : '−'}${Math.round(rel * 100)}%) flips the recommendation to ${CAT_LABEL[cat]}: ${whyText(r)}.`,
            fragile: rel <= settings.fragility.relative + 1e-9 };
          break;
        }
      }
    }
    if (found) points.push(found);
  }

  points.sort((a, b) => a.closeness - b.closeness);
  return { points, fragile: points.some((p) => p.fragile), mostFragile: points[0] || null };
}

// ---------- convenience: build a case with fund defaults ----------
export function newCase(settings, extra = {}) {
  const d = settings.defaults;
  const scores = {};
  settings.criteria.forEach((cr) => { scores[cr.id] = 3; });
  return {
    id: `case-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    sampleId: null,
    pitchText: '',
    extraction: null,
    values: Object.fromEntries(FIELD_ORDER.map((k) => [k, null])),
    sources: {},
    redFlags: [],
    redFlagSuggestions: [],
    ticket: null,
    scores,
    scenarios: { pBig: 0.1, exitBig: 0, pMod: 0.25, exitMod: 0 },
    dilutionToExit: d.dilutionToExit,
    progress: { ifSuccess: d.progressIfSuccess, ifFailure: d.progressIfFailure },
    tranche: { firstShare: d.firstTrancheShare, milestone: '', months: d.milestoneMonths },
    wait: { stepUp: d.nextRoundStepUp, allocationProb: d.allocationProb, dilutionAfter: d.dilutionAfterNextRound },
    verified: false,
    challenge: null,
    ...extra,
  };
}
