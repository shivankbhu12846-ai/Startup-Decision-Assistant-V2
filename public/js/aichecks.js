// aichecks.js — checks applied to AI answers before anyone sees them.
// Pure functions (no page code), so they are covered by the automatic tests.

const pct = (x) => `${Math.round(x * 100)}%`;

export const normText = (s) => String(s ?? '').toLowerCase()
  .replace(/[‘’‚‛′`]/g, "'")
  .replace(/[“”„″"]/g, '')
  .replace(/[–—−]/g, '-')
  .replace(/'/g, '')
  .replace(/[\s ]+/g, ' ')
  .trim()
  .replace(/^[\s.,;:…-]+|[\s.,;:…-]+$/g, '');

export function sameSource(a, b) {
  try {
    const x = new URL(a); const y = new URL(b);
    return x.hostname.replace(/^www\./, '') === y.hostname.replace(/^www\./, '') && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch { return false; }
}

export function processPeers(raw, citations) {
  const cites = (citations || []).filter((x) => /^https?:/.test(x.url));
  const arr = (a) => (Array.isArray(a) ? a : []);
  const comparables = arr(raw?.comparables).map((x) => ({
    name: String(x?.name || ''), country: String(x?.country || ''), what: String(x?.what_they_do || ''),
    event: String(x?.latest_event || ''), date: String(x?.date || ''), amount: x?.amount ? String(x.amount) : '',
    url: /^https?:\/\//.test(x?.source_url || '') ? x.source_url : '',
  })).filter((x) => x.name);
  comparables.forEach((x) => { x.linked = Boolean(x.url) && cites.some((cc) => sameSource(cc.url, x.url)); });
  return { comparables, trend: String(raw?.sector_trend || ''), trendSources: arr(raw?.trend_sources).filter((u) => /^https?:\/\//.test(u)),
    caveats: String(raw?.caveats || ''), citations: cites };
}

export function processWorlds(raw, pitch, facts) {
  const np = normText(pitch);
  const ids = new Set((facts || []).map((f) => f.id));
  const arr = (a) => (Array.isArray(a) ? a.map(String).filter(Boolean) : []);
  const list = Array.isArray(raw?.worlds) ? raw.worlds : [];
  const issues = [];
  const worlds = ['good', 'neutral', 'worst'].map((key) => {
    const w = list.find((x) => String(x?.world || '').toLowerCase() === key);
    if (!w) return null;
    let p = Number(w.probability);
    if (p > 1 && p <= 100) p /= 100; // given in percent
    const exit = key === 'worst' ? 0 : Math.max(0, Number(w.exit_value_eur) || 0);
    if (key === 'worst' && Number(w.exit_value_eur) > 0) issues.push('The worst world had an exit value above €0; the model treats failure as €0.');
    const assumptions = (Array.isArray(w.assumptions) ? w.assumptions : []).map((a) => {
      const basis = ['pitch', 'benchmark', 'judgement'].includes(a?.basis) ? a.basis : 'judgement';
      let check = 'ok'; let note = '';
      if (basis === 'pitch') {
        if (!a.quote) { check = 'fail'; note = 'No quote given'; } else if (!np.includes(normText(a.quote))) { check = 'fail'; note = 'Quote not found in the pitch'; }
      }
      if (basis === 'benchmark' && !ids.has(a?.benchmark_id)) { check = 'fail'; note = 'Benchmark not in the data sent'; }
      return { text: String(a?.text || ''), basis, quote: a?.quote ? String(a.quote) : '', benchmarkId: a?.benchmark_id ? String(a.benchmark_id) : '', why: a?.why ? String(a.why) : '', check, note };
    }).filter((a) => a.text);
    return { key, title: String(w.title || ''), story: String(w.story || ''), probability: Number.isFinite(p) ? p : null, exit, assumptions,
      conditions: arr(w.distinguishing_conditions), signals: arr(w.early_signals) };
  });
  if (worlds.some((w) => !w)) issues.unshift('The AI did not return all three worlds. Run it again.');
  const present = worlds.filter(Boolean);
  if (present.some((w) => !(w.probability >= 0 && w.probability <= 1))) issues.unshift('Some probabilities are missing or not between 0% and 100%. Run it again.');
  const sum = present.reduce((a, w) => a + (w.probability || 0), 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.011) {
    present.forEach((w) => { w.probability /= sum; });
    issues.push(`The AI's probabilities added up to ${pct(sum)}. They were scaled so they add up to 100%.`);
  }
  const flags = (Array.isArray(raw?.optimism_flags) ? raw.optimism_flags : []).map((x) => ({ quote: String(x?.quote || ''), concern: String(x?.concern || ''),
    found: Boolean(x?.quote) && np.includes(normText(x.quote)) })).filter((x) => x.quote || x.concern);
  const failedChecks = present.reduce((a, w) => a + w.assumptions.filter((x) => x.check === 'fail').length, 0);
  const usable = present.length === 3 && present.every((w) => w.probability >= 0 && w.probability <= 1);
  return { worlds, issues, flags, keyUncertainty: String(raw?.key_uncertainty || ''), failedChecks, usable };
}
