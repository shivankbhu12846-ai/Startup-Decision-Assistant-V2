// metrics.js — performance metrics over the decision log. Pure functions, no AI.
// Measures three things: how accurate the AI extraction was, how often the
// committee followed the recommendation, and whether predictions came true.
import { FIELD_META } from './model.js';

const FIELD_KEYS = Object.keys(FIELD_META);

// ---------- what each decision record contributes ----------
// Captured at decision time (step 8). Exported so app.js and tests use the same logic.
export function extractionStats(c) {
  const ex = c.extraction;
  const out = { aiFound: 0, aiKept: 0, aiChanged: 0, aiRejected: 0, analystAdded: 0, changedFields: [], rejectedFields: [] };
  if (!ex || ex.source === 'manual') return { ...out, manual: true };
  for (const k of FIELD_KEYS) {
    const f = ex.fields[k];
    const final = c.values[k];
    if (f.status === 'found') {
      out.aiFound += 1;
      if (String(final) === String(f.draft)) out.aiKept += 1;
      else { out.aiChanged += 1; out.changedFields.push(k); }
    } else if (['no-quote', 'quote-mismatch', 'invalid'].includes(f.status)) {
      out.aiRejected += 1; out.rejectedFields.push(k);
      if (final !== null && final !== undefined && final !== '') out.analystAdded += 1;
    } else if (final !== null && final !== undefined && final !== '') {
      out.analystAdded += 1;
    }
  }
  return out;
}

// outcome of a decision from its reviews: 'hit' | 'missed' | null (not known yet)
export function outcomeOf(rec) {
  if (rec.outcome) return rec.outcome;
  for (const r of rec.reviews || []) {
    if (/Milestone met|On track/.test(r.outcome)) return 'hit';
    if (/Milestone missed|Write-off/.test(r.outcome)) return 'missed';
  }
  return null;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---------- the metrics ----------
export function computeMetrics(records) {
  const n = records.length;
  const withAI = records.filter((r) => r.metrics && !r.metrics.manual);
  const sum = (k) => withAI.reduce((a, r) => a + (r.metrics[k] || 0), 0);
  const aiFound = sum('aiFound'); const aiKept = sum('aiKept'); const aiChanged = sum('aiChanged'); const aiRejected = sum('aiRejected');

  const fieldChanges = {};
  const fieldRejects = {};
  withAI.forEach((r) => {
    (r.metrics.changedFields || []).forEach((k) => { fieldChanges[k] = (fieldChanges[k] || 0) + 1; });
    (r.metrics.rejectedFields || []).forEach((k) => { fieldRejects[k] = (fieldRejects[k] || 0) + 1; });
  });
  const perField = FIELD_KEYS.map((k) => ({ k, label: FIELD_META[k].label, changed: fieldChanges[k] || 0, rejected: fieldRejects[k] || 0,
    changeRate: withAI.length ? (fieldChanges[k] || 0) / withAI.length : 0 }))
    .sort((a, b) => (b.changed + b.rejected) - (a.changed + a.rejected));

  const analysed = records.filter((r) => r.results?.recommendation);
  const overrides = analysed.filter((r) => r.decision?.override);
  const overrideDirections = {};
  overrides.forEach((r) => { const key = `${r.results.recommendation}→${r.decision.action}`; overrideDirections[key] = (overrideDirections[key] || 0) + 1; });

  const withOutcome = records.filter((r) => outcomeOf(r) && typeof r.results?.progressProb === 'number');
  const hits = withOutcome.filter((r) => outcomeOf(r) === 'hit');
  const bins = [
    { label: 'Under 40%', from: 0, to: 0.4 },
    { label: '40–60%', from: 0.4, to: 0.6 },
    { label: 'Over 60%', from: 0.6, to: 1.01 },
  ].map((b) => {
    const inBin = withOutcome.filter((r) => r.results.progressProb >= b.from && r.results.progressProb < b.to);
    return { ...b, n: inBin.length, predicted: mean(inBin.map((r) => r.results.progressProb)),
      actual: inBin.length ? inBin.filter((r) => outcomeOf(r) === 'hit').length / inBin.length : null };
  });
  const brier = withOutcome.length ? mean(withOutcome.map((r) => (r.results.progressProb - (outcomeOf(r) === 'hit' ? 1 : 0)) ** 2)) : null;
  const followed = withOutcome.filter((r) => !r.decision.override);
  const overridden = withOutcome.filter((r) => r.decision.override);
  const hitRate = (a) => (a.length ? a.filter((r) => outcomeOf(r) === 'hit').length / a.length : null);
  const scoreHit = mean(hits.map((r) => r.results.score).filter((x) => typeof x === 'number'));
  const scoreMiss = mean(withOutcome.filter((r) => outcomeOf(r) === 'missed').map((r) => r.results.score).filter((x) => typeof x === 'number'));

  return {
    n,
    ai: { cases: withAI.length, found: aiFound, kept: aiKept, changed: aiChanged, rejected: aiRejected,
      accuracy: aiFound ? aiKept / aiFound : null, rejectionRate: aiFound + aiRejected ? aiRejected / (aiFound + aiRejected) : null, perField },
    committee: { analysed: analysed.length, overrides: overrides.length, overrideRate: analysed.length ? overrides.length / analysed.length : null, overrideDirections,
      challengeRate: analysed.length ? analysed.filter((r) => r.metrics?.challengeRun).length / analysed.length : null,
      aiScenarioRate: analysed.length ? analysed.filter((r) => r.metrics?.scenarioSource === 'ai-worlds').length / analysed.length : null },
    outcomes: { known: withOutcome.length, hitRate: hitRate(withOutcome), predicted: mean(withOutcome.map((r) => r.results.progressProb)), bins, brier,
      followedHitRate: hitRate(followed), overriddenHitRate: hitRate(overridden), followedN: followed.length, overriddenN: overridden.length, scoreHit, scoreMiss },
  };
}

// ---------- plain-language findings (fixed rules, not AI) ----------
export function findings(m) {
  const out = [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const topField = m.ai.perField[0];
  if (topField && topField.changed + topField.rejected >= 2 && m.ai.cases >= 5) {
    out.push({ area: 'AI extraction', text: `${topField.label} was corrected or rejected in ${topField.changed + topField.rejected} of ${m.ai.cases} cases, more than any other field.`,
      action: 'Add a sharper rule for this field to the extraction instruction (prompts.js), for example how to tell monthly from annual revenue.' });
  }
  if (m.ai.accuracy !== null && m.ai.found >= 20) {
    out.push({ area: 'AI extraction', text: `Analysts kept ${pct(m.ai.accuracy)} of the AI's quoted values unchanged; the quote check rejected ${pct(m.ai.rejectionRate)}.`,
      action: m.ai.accuracy < 0.9 ? 'Keep the "confirm every value" step mandatory; the AI is not accurate enough to skip it.' : 'Accuracy is high, but keep confirming: one wrong valuation changes every number.' });
  }
  const o = m.outcomes;
  if (o.known >= 6 && o.predicted !== null) {
    const gap = o.hitRate - o.predicted;
    if (Math.abs(gap) >= 0.08) {
      out.push({ area: 'Predictions', text: `The model predicted milestones would be hit ${pct(o.predicted)} of the time on average; ${pct(o.hitRate)} actually were.`,
        action: gap < 0 ? 'The model is too optimistic. In step 1, lower "Future failures that still hit it" or the default success probabilities.' : 'The model is too pessimistic. Consider raising the milestone probabilities in step 1.' });
    } else {
      out.push({ area: 'Predictions', text: `Predicted (${pct(o.predicted)}) and actual (${pct(o.hitRate)}) milestone rates are close.`, action: 'No change needed yet. Check again when more reviews are in.' });
    }
  }
  if (o.overriddenN >= 3 && o.followedN >= 3 && o.overriddenHitRate !== null && o.followedHitRate !== null) {
    const worse = o.overriddenHitRate < o.followedHitRate;
    out.push({ area: 'Committee', text: `When the committee followed the recommendation, ${pct(o.followedHitRate)} of milestones were hit; after overrides, ${pct(o.overriddenHitRate)}.`,
      action: worse ? 'Overrides have done worse so far. Ask for evidence beyond the pitch before overriding a Pass.' : 'Overrides have done as well or better. Look at the written rationales: they may show a criterion the score is missing.' });
  }
  if (o.scoreHit !== null && o.scoreMiss !== null && o.known >= 6) {
    const diff = o.scoreHit - o.scoreMiss;
    out.push({ area: 'Score', text: `Startups that hit their milestone scored ${o.scoreHit.toFixed(1)} on average; those that missed scored ${o.scoreMiss.toFixed(1)}.`,
      action: diff < 3 ? 'The score barely separates winners from losers. Review the weights and anchors in step 1.' : 'The score separates the two groups. Keep the current weights.' });
  }
  return out;
}

// ---------- fictional example history for the demo ----------
// Deterministic (same every time), clearly marked demo: true, never mixed into the decision log.
export const EXAMPLE_SEED = 24; // chosen so the example shows each kind of finding
export function exampleHistory(seedStart = EXAMPLE_SEED) {
  let seed = seedStart;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const names = ['Arvio', 'Bricklane Data', 'Calyx Pay', 'Dunefield', 'Ember Health', 'Fjordly', 'Gantry AI', 'Halden Labs', 'Isarloop', 'Juniper Ledger',
    'Kestrel Ops', 'Lindwurm', 'Mosaik HR', 'Northgrid', 'Ortelius', 'Pilsner Analytics', 'Quaestor', 'Rheinwerk AI', 'Salzach Robotics', 'Tannenbaum Pay',
    'Umbra Security', 'Vela Clinics', 'Wachau Data', 'Xylo Freight'];
  const sectors = ['B2B software', 'AI', 'Fintech', 'Healthtech', 'B2B software', 'AI'];
  const actions = ['now', 'tranches', 'wait', 'pass'];
  return names.map((name, i) => {
    const score = Math.round((58 + rnd() * 30) * 10) / 10;
    const rec = score < 65 ? 'pass' : rnd() < 0.55 ? 'tranches' : rnd() < 0.7 ? 'now' : 'wait';
    let action = rec;
    const overrideRoll = rnd();
    if (overrideRoll < 0.3) action = rec === 'pass' ? (rnd() < 0.6 ? 'tranches' : 'now') : (rnd() < 0.5 ? 'pass' : actions[(actions.indexOf(rec) + 1) % 3]);
    const progressProb = Math.round((0.35 + rnd() * 0.35) * 100) / 100;
    // outcomes: the model is a bit optimistic, overrides of a Pass do worse, higher scores do better
    const pHit = Math.max(0.05, Math.min(0.95, progressProb - 0.15 + (score - 72) / 25 - (rec === 'pass' && action !== 'pass' ? 0.3 : 0)));
    const invested = action === 'now' || action === 'tranches';
    const known = invested && i < 20;
    const outcome = known ? (rnd() < pHit ? 'hit' : 'missed') : null;
    const changed = [];
    if (rnd() < 0.4) changed.push('monthly_revenue');
    if (rnd() < 0.2) changed.push('monthly_burn');
    if (rnd() < 0.1) changed.push('post_money_valuation');
    const rejected = rnd() < 0.3 ? ['paying_customers'] : [];
    const found = 9 - rejected.length - (rnd() < 0.3 ? 1 : 0);
    const month = String(1 + (i % 12)).padStart(2, '0');
    return {
      demo: true, id: `demo-${i}`, company: name, sector: sectors[i % sectors.length],
      decidedAt: `${i < 12 ? 2024 : 2025}-${month}-15T10:00:00.000Z`,
      results: { score, recommendation: rec, progressProb },
      decision: { action, override: action !== rec },
      metrics: { aiFound: found, aiKept: found - changed.length, aiChanged: changed.length, aiRejected: rejected.length, analystAdded: rejected.length,
        changedFields: changed, rejectedFields: rejected, challengeRun: rnd() < 0.7, scenarioSource: rnd() < 0.4 ? 'ai-worlds' : 'analyst' },
      outcome,
    };
  });
}
