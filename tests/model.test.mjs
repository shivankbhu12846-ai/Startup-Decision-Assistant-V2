// Run with: node tests/model.test.mjs
import assert from 'node:assert/strict';
import { defaultSettings, newCase, evaluate } from '../public/js/model.js';

const S = defaultSettings();

function lumio() {
  const c = newCase(S);
  Object.assign(c.values, {
    company_name: 'Lumio', sector: 'B2B software', stage: 'Seed', region: 'Austria',
    raise_amount: 500000, post_money_valuation: 5000000, monthly_revenue: 21000,
    paying_customers: 14, team_size: 4, monthly_burn: 38000,
  });
  c.ticket = 500000;
  c.scores = { team: 4, market: 4, traction: 3, moat: 2, deal: 4 };
  c.scenarios = { pBig: 0.1, exitBig: 200e6, pMod: 0.25, exitMod: 30e6 };
  return c;
}

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

t('Lumio score is 72/100', () => {
  const r = evaluate(S, lumio());
  assert.equal(r.stage, 'analysed');
  assert.equal(r.sc.score.toFixed(1), '72.0');
});

t('Lumio invest-now EV is €0.875m with max loss €500k', () => {
  const r = evaluate(S, lumio());
  assert.equal(Math.round(r.ev.actions.now.ev), 875000);
  assert.equal(r.ev.actions.now.worst, 500000);
});

t('Lumio tranches EV ≈ €0.93m with €250k upfront', () => {
  const r = evaluate(S, lumio());
  assert.equal(Math.round(r.ev.actions.tranches.ev / 1000), 929);
  assert.equal(r.ev.progressProb.toFixed(2), '0.51');
  assert.equal(r.ev.actions.tranches.upfront, 250000);
});

t('Lumio recommendation is tranches (high uncertainty)', () => {
  const r = evaluate(S, lumio());
  assert.equal(r.recommendation.action, 'tranches');
  assert.equal(r.highUncertainty, true);
});

t('Lumio switch point: team 4 → 2 drops score to 62 and passes', () => {
  const r = evaluate(S, lumio());
  const team = r.sens.points.find((p) => p.param === 'team');
  assert.equal(team.to, 2);
  assert.equal(team.newCategory, 'pass');
  assert.match(team.text, /62\.0/);
});

t('Team slider at 2 flips recommendation to pass', () => {
  const c = lumio(); c.scores.team = 2;
  const r = evaluate(S, c);
  assert.equal(r.recommendation.action, 'pass');
  assert.equal(r.sc.score.toFixed(1), '62.0');
});

t('Missing valuation stops the tool', () => {
  const c = lumio(); c.values.post_money_valuation = null;
  const r = evaluate(S, c);
  assert.equal(r.stage, 'stopped');
  assert.deepEqual(r.miss.missingCritical, ['post_money_valuation']);
});

t('Three missing key inputs stop the tool', () => {
  const c = lumio(); c.values.monthly_burn = null; c.values.team_size = null; c.values.monthly_revenue = null;
  assert.equal(evaluate(S, c).stage, 'stopped');
});

t('Two missing key inputs do not stop the tool', () => {
  const c = lumio(); c.values.monthly_burn = null; c.values.team_size = null;
  assert.notEqual(evaluate(S, c).stage, 'stopped');
});

t('Consumer Series A startup fails screening', () => {
  const c = lumio();
  Object.assign(c.values, { sector: 'Consumer', stage: 'Series A', region: 'Germany', post_money_valuation: 20e6, raise_amount: 3e6 });
  c.ticket = 3e6;
  const r = evaluate(S, c);
  assert.equal(r.stage, 'screened-out');
  assert.equal(r.recommendation.action, 'pass');
  assert.deepEqual(r.screen.failed.map((f) => f.id), ['sector', 'stage', 'ticket']);
});

t('Probability sweeps stay valid: big-success probability has a switch point', () => {
  const r = evaluate(S, lumio());
  const p = r.sens.points.find((x) => x.param === 'pBig');
  assert.ok(p, r.sens.points.map((x) => x.param).join(','));
  assert.equal(p.newCategory, 'pass');
});

t('A confirmed red flag fails screening', () => {
  const c = lumio(); c.redFlags = ['Unclear IP ownership'];
  assert.equal(evaluate(S, c).stage, 'screened-out');
});

t('Low uncertainty and no close switch point gives invest now', () => {
  const c = lumio(); c.scenarios = { pBig: 0.15, exitBig: 200e6, pMod: 0.35, exitMod: 30e6 };
  c.scores.team = 5;
  const r = evaluate(S, c);
  assert.equal(r.highUncertainty, false);
  assert.equal(r.recommendation.action, 'now', JSON.stringify(r.sens.points.map((p) => p.text)));
});

t('Out-of-range probabilities give a readable error', () => {
  const c = lumio(); c.progress.ifSuccess = 1.4;
  const r = evaluate(S, c);
  assert.equal(r.stage, 'invalid');
  assert.ok(r.errors[0].length > 20);
});

console.log(`\n${passed} tests passed`);
