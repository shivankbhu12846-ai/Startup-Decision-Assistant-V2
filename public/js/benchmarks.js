// benchmarks.js — compares a startup with published market data and with the
// open Y Combinator dataset. Pure functions: same inputs, same result. No AI.

// ---------- published valuation benchmarks (each figure links to its source) ----------
export const VALUATION_BENCHMARKS = [
  {
    id: 'eu-seed-2026q1', label: 'Europe, pre-seed and seed, Q1 2026', region: 'Europe', sector: null,
    preMoney: 6.0e6, dealSize: 2.0e6, currency: 'EUR',
    source: 'PitchBook data, reported by Crowdfund Insider (19 May 2026)',
    url: 'https://www.crowdfundinsider.com/2026/05/280281-european-vc-valuations-surge-in-early-2026-driven-by-later-stage-deals-and-ai-adoption-research/',
  },
  {
    id: 'eu-fintech-seed-2025', label: 'Europe, fintech, pre-seed and seed, 2025', region: 'Europe', sector: 'Fintech',
    preMoney: 7.8e6, dealSize: null, currency: 'EUR',
    source: 'PitchBook 2025 Annual European VC Valuations Report, via PitchBook News (13 Feb 2026)',
    url: 'https://pitchbook.com/news/articles/fintech-vc-valuations-race-ahead-in-europe',
  },
  {
    id: 'eu-ai-seed-2025', label: 'Europe, AI, pre-seed and seed, 2025', region: 'Europe', sector: 'AI',
    preMoney: 5.8e6, dealSize: null, currency: 'EUR',
    source: 'PitchBook 2025 Annual European VC Valuations Report, via PitchBook News (13 Feb 2026): fintech €7.8m is "exactly €2 million more than for AI"',
    url: 'https://pitchbook.com/news/articles/fintech-vc-valuations-race-ahead-in-europe',
  },
  {
    id: 'eu-seriesab-2026q1', label: 'Europe, Series A–B, Q1 2026', region: 'Europe', sector: null, stage: 'Series A',
    preMoney: 44.2e6, dealSize: 17.0e6, currency: 'EUR',
    source: 'PitchBook data, reported by Crowdfund Insider (19 May 2026)',
    url: 'https://www.crowdfundinsider.com/2026/05/280281-european-vc-valuations-surge-in-early-2026-driven-by-later-stage-deals-and-ai-adoption-research/',
  },
  {
    id: 'us-seed-2025q1', label: 'United States, seed, Q1 2025', region: 'US', sector: null,
    preMoney: 16e6, dealSize: null, currency: 'USD',
    source: 'Carta, State of Private Markets Q1 2025',
    url: 'https://carta.com/data/state-of-private-markets-q1-2025/',
  },
];

export const GRADUATION_BENCHMARKS = [
  { label: 'Seed rounds in Q1 2018 that reached Series A within two years', value: 0.306,
    source: 'Carta, cited by Chronograph', url: 'https://www.chronograph.pe/current-trends-in-the-series-a-and-seed-venture-markets/' },
  { label: 'Seed rounds in 2022 that reached Series A within two years', value: 0.15,
    source: 'Carta, cited by Chronograph (about 15%)', url: 'https://www.chronograph.pe/current-trends-in-the-series-a-and-seed-venture-markets/' },
];

const EU_REGIONS = ['Austria', 'Germany', 'Switzerland', 'Other EU', 'United Kingdom'];

export function valuationBenchmarkFor(sector, region, stage) {
  if (stage === 'Series A' || stage === 'Series B or later') {
    return VALUATION_BENCHMARKS.find((b) => b.id === 'eu-seriesab-2026q1');
  }
  const eu = EU_REGIONS.includes(region) || !region;
  if (!eu && region === 'United States') return VALUATION_BENCHMARKS.find((b) => b.id === 'us-seed-2025q1');
  return VALUATION_BENCHMARKS.find((b) => b.region === 'Europe' && b.sector === sector && !b.stage)
    || VALUATION_BENCHMARKS.find((b) => b.id === 'eu-seed-2026q1');
}

export function compareValuation(values) {
  const post = Number(values.post_money_valuation);
  const raise = Number(values.raise_amount);
  if (!(post > 0) || !(raise >= 0)) return null;
  const pre = post - raise;
  const bm = valuationBenchmarkFor(values.sector, values.region, values.stage);
  if (!bm) return null;
  const sameCurrency = bm.currency === 'EUR';
  const ratio = pre / bm.preMoney;
  let verdict;
  if (!sameCurrency) verdict = 'different currency, compare with care';
  else if (ratio < 0.75) verdict = 'well below the median';
  else if (ratio < 0.95) verdict = 'below the median';
  else if (ratio <= 1.05) verdict = 'close to the median';
  else if (ratio <= 1.33) verdict = 'above the median';
  else verdict = 'well above the median';
  const roundRatio = bm.dealSize && raise > 0 ? raise / bm.dealSize : null;
  return { pre, post, raise, bm, ratio, verdict, roundRatio };
}

// ---------- Y Combinator dataset ----------
export const COHORTS = [
  { id: 'c1', label: '2005–2014', from: 2005, to: 2014 },
  { id: 'c2', label: '2015–2019', from: 2015, to: 2019 },
  { id: 'c3', label: '2020–2022', from: 2020, to: 2022 },
  { id: 'c4', label: '2023 and later', from: 2023, to: 2100 },
];
export const STATUSES = ['Active', 'Acquired', 'Public', 'Inactive'];
export const STATUS_LABEL = { Active: 'Still active', Acquired: 'Acquired', Public: 'Went public', Inactive: 'Shut down' };

export function filterCompanies(companies, { sector = null, region = 'all' } = {}) {
  return companies.filter((c) => (!sector || c.sec.includes(sector))
    && (region === 'all' || (region === 'eu' && c.eu) || (region === 'dach' && c.dach)));
}

export function statusShares(list) {
  const n = list.length;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  list.forEach((c) => { if (counts[c.s] !== undefined) counts[c.s] += 1; });
  return { n, counts, shares: Object.fromEntries(STATUSES.map((s) => [s, n ? counts[s] / n : 0])) };
}

export function cohortTable(list) {
  return COHORTS.map((co) => ({ ...co, ...statusShares(list.filter((c) => c.y >= co.from && c.y <= co.to)) }));
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// share of peers with a smaller value (ties count half)
export function percentileRank(sortedValues, x) {
  if (!sortedValues.length || !(x >= 0)) return null;
  let below = 0; let equal = 0;
  for (const v of sortedValues) { if (v < x) below++; else if (v === x) equal++; }
  return (below + equal / 2) / sortedValues.length;
}

export function sectorSummary(companies, sector, region = 'all') {
  const list = filterCompanies(companies, { sector, region });
  const all = filterCompanies(companies, { region });
  const mature = list.filter((c) => c.y >= 2010 && c.y <= 2019);
  const matureAll = all.filter((c) => c.y >= 2010 && c.y <= 2019);
  return {
    sector, region, n: list.length,
    cohorts: cohortTable(list),
    mature: statusShares(mature),
    matureAll: statusShares(matureAll),
  };
}

// team size compared with companies of the same sector that joined YC in the last few years
export function compareTeam(companies, sector, teamSize, nowYear = new Date().getFullYear()) {
  if (!(teamSize > 0)) return null;
  const peers = filterCompanies(companies, { sector }).filter((c) => c.y >= nowYear - 3 && c.t > 0);
  const sizes = peers.map((c) => c.t).sort((a, b) => a - b);
  if (sizes.length < 10) return null;
  return { n: sizes.length, median: quantile(sizes, 0.5), p25: quantile(sizes, 0.25), p75: quantile(sizes, 0.75), rank: percentileRank(sizes, teamSize) };
}

// examples of similar companies: same sector, closest region first, then similar team size, recent first
export function similarCompanies(companies, { sector, region, teamSize }, limit = 8) {
  const wantDach = ['Austria', 'Germany', 'Switzerland'].includes(region);
  const wantEu = wantDach || EU_REGIONS.includes(region);
  return filterCompanies(companies, { sector })
    .map((c) => {
      let s = 0;
      if (wantDach && c.dach) s += 3; else if (wantEu && c.eu) s += 2;
      if (teamSize > 0 && c.t > 0) s += Math.max(0, 1.5 - Math.abs(Math.log(c.t / teamSize)));
      s += Math.max(0, (c.y - 2015) / 10);
      return { c, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

// a short fact sheet the AI scenario request can cite as "benchmark" evidence
export function benchmarkFacts(companies, values) {
  const facts = [];
  const v = compareValuation(values);
  if (v) {
    facts.push({ id: 'B1', text: `${v.bm.label}: median pre-money valuation ${fmtM(v.bm.preMoney, v.bm.currency)}${v.bm.dealSize ? `, median round ${fmtM(v.bm.dealSize, v.bm.currency)}` : ''} (${v.bm.source}). This startup: pre-money ${fmtM(v.pre, 'EUR')}, ${v.verdict}.` });
  }
  GRADUATION_BENCHMARKS.forEach((g, i) => facts.push({ id: `B${facts.length + 1}`, text: `${g.label}: ${Math.round(g.value * 100)}% (${g.source}).` }));
  if (companies?.length && values.sector) {
    const s = sectorSummary(companies, values.sector);
    if (s.mature.n >= 20) {
      const m = s.mature.shares;
      facts.push({ id: `B${facts.length + 1}`, text: `Y Combinator ${values.sector} companies from 2010–2019 (${s.mature.n} companies): ${pct(m.Inactive)} shut down, ${pct(m.Acquired)} acquired, ${pct(m.Public)} public, ${pct(m.Active)} still active.` });
    }
    const t = compareTeam(companies, values.sector, Number(values.team_size));
    if (t) facts.push({ id: `B${facts.length + 1}`, text: `Recent Y Combinator ${values.sector} companies have a median team of ${Math.round(t.median)} people (middle half: ${Math.round(t.p25)}–${Math.round(t.p75)}).` });
  }
  return facts;
}

function fmtM(x, cur) { return `${cur === 'USD' ? '$' : '€'}${(x / 1e6).toFixed(1).replace(/\.0$/, '')}m`; }
function pct(x) { return `${Math.round(x * 100)}%`; }
