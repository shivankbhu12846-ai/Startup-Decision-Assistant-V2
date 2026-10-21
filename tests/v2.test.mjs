// Run with: node tests/v2.test.mjs
// Covers version 2: benchmarks, metrics and the checks on AI answers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as B from '../public/js/benchmarks.js';
import * as MX from '../public/js/metrics.js';
import { processWorlds, processPeers } from '../public/js/aichecks.js';
import { sampleById } from '../public/js/samples.js';

const yc = JSON.parse(fs.readFileSync(new URL('../public/data/yc-companies.json', import.meta.url))).companies;
const lumio = { company_name: 'Lumio', sector: 'B2B software', stage: 'Seed', region: 'Austria', raise_amount: 5e5, post_money_valuation: 5e6, team_size: 4 };

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

// ---------- benchmarks ----------
t('Dataset has thousands of companies with sectors and status', () => {
  assert.ok(yc.length > 5000);
  assert.ok(yc.filter((c) => c.sec.includes('Fintech')).length > 300);
  assert.ok(yc.every((c) => ['Active', 'Inactive', 'Acquired', 'Public'].includes(c.s)));
});

t('Lumio pre-money €4.5m is 25% below the European seed median of €6m', () => {
  const v = B.compareValuation(lumio);
  assert.equal(v.pre, 4.5e6);
  assert.equal(v.bm.id, 'eu-seed-2026q1');
  assert.equal(v.ratio, 0.75);
  assert.equal(v.verdict, 'below the median');
});

t('Fintech and AI use their own sector benchmark', () => {
  assert.equal(B.valuationBenchmarkFor('Fintech', 'Germany', 'Seed').id, 'eu-fintech-seed-2025');
  assert.equal(B.valuationBenchmarkFor('AI', 'Austria', 'Seed').id, 'eu-ai-seed-2025');
  assert.equal(B.valuationBenchmarkFor('Fintech', 'Germany', 'Series A').id, 'eu-seriesab-2026q1');
});

t('Sector outcome shares add up to 100%', () => {
  const s = B.sectorSummary(yc, 'Fintech');
  const sum = Object.values(s.mature.shares).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(s.mature.n > 50);
});

t('Benchmark facts are numbered B1, B2, … for the AI to cite', () => {
  const f = B.benchmarkFacts(yc, lumio);
  assert.deepEqual(f.map((x) => x.id), ['B1', 'B2', 'B3', 'B4', 'B5']);
  assert.match(f[0].text, /€4\.5m, below the median/);
});

t('Similar companies prefer the same region', () => {
  const s = B.similarCompanies(yc, { sector: 'Fintech', region: 'Austria', teamSize: 6 });
  assert.equal(s.length, 8);
  assert.ok(s[0].dach === 1);
});

// ---------- metrics ----------
t('Example history shows each kind of finding', () => {
  const m = MX.computeMetrics(MX.exampleHistory());
  assert.equal(m.n, 24);
  const areas = MX.findings(m).map((f) => f.area);
  ['AI extraction', 'Predictions', 'Committee', 'Score'].forEach((a) => assert.ok(areas.includes(a), a));
});

t('Extraction stats count kept, changed, rejected and added values', () => {
  const c = {
    extraction: { source: 'live', fields: {
      company_name: { status: 'found', draft: 'X' }, sector: { status: 'found', draft: 'AI' }, stage: { status: 'found', draft: 'Seed' },
      region: { status: 'found', draft: 'Austria' }, raise_amount: { status: 'found', draft: 500000 }, post_money_valuation: { status: 'found', draft: 5000000 },
      monthly_revenue: { status: 'found', draft: 252000 }, paying_customers: { status: 'quote-mismatch', draft: 14 },
      team_size: { status: 'missing', draft: null }, monthly_burn: { status: 'missing', draft: null } } },
    values: { company_name: 'X', sector: 'AI', stage: 'Seed', region: 'Austria', raise_amount: 500000, post_money_valuation: 5000000,
      monthly_revenue: 21000, paying_customers: 14, team_size: 4, monthly_burn: null },
  };
  const s = MX.extractionStats(c);
  assert.equal(s.aiFound, 7); assert.equal(s.aiKept, 6); assert.equal(s.aiChanged, 1);
  assert.deepEqual(s.changedFields, ['monthly_revenue']);
  assert.equal(s.aiRejected, 1); assert.equal(s.analystAdded, 2);
});

t('Review outcomes are read from step 9 reviews', () => {
  assert.equal(MX.outcomeOf({ reviews: [{ outcome: 'Milestone met: release second tranche' }] }), 'hit');
  assert.equal(MX.outcomeOf({ reviews: [{ outcome: 'Milestone missed: do not release' }] }), 'missed');
  assert.equal(MX.outcomeOf({ reviews: [] }), null);
});

// ---------- checks on AI answers ----------
const lumioSample = sampleById('lumio');
const facts = B.benchmarkFacts(yc, lumio);

t('Lumio example worlds pass every quote and benchmark check', () => {
  const r = processWorlds(lumioSample.cached.worlds, lumioSample.pitch, facts);
  assert.equal(r.failedChecks, 0, JSON.stringify(r.worlds.flatMap((w) => w.assumptions.filter((a) => a.check === 'fail'))));
  assert.equal(r.usable, true);
  assert.equal(r.issues.length, 0);
  assert.ok(Math.abs(r.worlds.reduce((a, w) => a + w.probability, 0) - 1) < 1e-9);
  assert.ok(r.flags.every((f) => f.found));
});

t('A made-up quote and an unknown benchmark fail the check', () => {
  const raw = JSON.parse(JSON.stringify(lumioSample.cached.worlds));
  raw.worlds[0].assumptions[0].quote = 'Revenue tripled last month';
  raw.worlds[1].assumptions[2].benchmark_id = 'B99';
  const r = processWorlds(raw, lumioSample.pitch, facts);
  assert.equal(r.failedChecks, 2);
});

t('Probabilities given in percent or not adding to 100% are fixed and reported', () => {
  const raw = JSON.parse(JSON.stringify(lumioSample.cached.worlds));
  raw.worlds[0].probability = 10; raw.worlds[1].probability = 30; raw.worlds[2].probability = 80; // percent, sums to 120
  const r = processWorlds(raw, lumioSample.pitch, facts);
  assert.ok(Math.abs(r.worlds[0].probability - 0.1 / 1.2) < 1e-9);
  assert.ok(r.issues.some((x) => /added up to 120%/.test(x)));
});

t('A missing world makes the answer unusable', () => {
  const raw = JSON.parse(JSON.stringify(lumioSample.cached.worlds));
  raw.worlds = raw.worlds.slice(0, 2);
  const r = processWorlds(raw, lumioSample.pitch, facts);
  assert.equal(r.usable, false);
});

t('Web results are matched against the sources the search returned', () => {
  const r = processPeers({ comparables: [
    { name: 'A', source_url: 'https://www.example.com/news/a/' },
    { name: 'B', source_url: 'https://other.com/b' },
    { name: 'C', source_url: 'not a url' },
  ] }, [{ url: 'https://example.com/news/a', title: 'A' }]);
  assert.deepEqual(r.comparables.map((x) => x.linked), [true, false, false]);
});

console.log(`\n${passed} tests passed`);
