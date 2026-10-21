// samples.js — fictional test pitches for the pilot.
// "cached" holds a saved example AI answer so the demo still works when no
// AI service is connected (for example in the preview). On the deployed site
// with an API key, the live AI is always used instead.

export const SAMPLES = [
  {
    id: 'lumio',
    name: 'Lumio',
    tagline: 'AI scheduling for clinics · Vienna · passes screening',
    purpose: 'Test case: run from pitch to decision',
    pitch: `Lumio – AI scheduling for outpatient clinics

Lumio is a Vienna-based B2B software company. Our AI scheduling assistant automatically refills cancelled appointment slots and reduces no-shows for outpatient clinics.

Traction: We have 14 paying clinics, all in Austria. Monthly recurring revenue is €21k and grew 9% month over month in the last quarter. Clinics using Lumio report 31% fewer empty slots.

Team: We are a team of 4. Our CEO Anna Berger ran operations at a private clinic group for six years. Our CTO Daniel Huber built scheduling systems at a hospital software vendor.

Market: There are more than 60,000 outpatient clinics in the DACH region, and most still schedule appointments by phone.

Product: Lumio integrates with the three most widely used practice management systems in Austria. Setup takes less than a day.

The round: We are raising €500k at a €5m post-money valuation in our seed round. The money will fund our expansion into Germany and two additional engineers.`,
    analystExample: {
      note: 'Example analyst inputs from the group explainer (burn rate taken from Lumio’s financials).',
      values: { monthly_burn: 38000 },
      scores: { team: 4, market: 4, traction: 3, moat: 2, deal: 4 },
      scenarios: { pBig: 0.1, exitBig: 200000000, pMod: 0.25, exitMod: 30000000 },
      tranche: { milestone: 'Monthly revenue reaches €50k', months: 6 },
    },
    cached: {
      extract: {
        company_name: { value: 'Lumio', quote: 'Lumio is a Vienna-based B2B software company' },
        sector: { value: 'B2B software', quote: 'Lumio is a Vienna-based B2B software company' },
        stage: { value: 'Seed', quote: 'in our seed round' },
        region: { value: 'Austria', quote: 'Lumio is a Vienna-based B2B software company' },
        raise_amount: { value: 500000, quote: 'We are raising €500k at a €5m post-money valuation' },
        post_money_valuation: { value: 5000000, quote: 'We are raising €500k at a €5m post-money valuation' },
        monthly_revenue: { value: 21000, quote: 'Monthly recurring revenue is €21k' },
        paying_customers: { value: 14, quote: 'We have 14 paying clinics, all in Austria' },
        team_size: { value: 4, quote: 'We are a team of 4' },
        monthly_burn: { value: null, quote: null },
        possible_red_flags: [],
        notes: 'Monthly burn rate is not stated in the pitch.',
      },
      challenge: {
        counter_arguments: [
          'Traction is thin for a €5m valuation: 14 clinics and €21k monthly revenue, all in one country. The German expansion the round pays for is not yet tested.',
          'The expected value rests on a 10% chance of a €200m exit. Without that scenario the investment loses money, so the case is a bet on one outcome the team has not yet shown it can reach.',
          'Moat is scored 2: integrations with three Austrian practice systems can be copied by the practice-software vendors themselves.',
        ],
        biases: [
          { bias: 'Halo effect', why: 'Team is scored 4 on two founder bios. The score may reflect a strong pitch rather than checked references.' },
          { bias: 'Anchoring', why: 'Exit values may be anchored on the founders’ market size (60,000 clinics) rather than on comparable exits.' },
        ],
        most_fragile_assumption: 'The team score: dropping it from 4 to 2 lowers the score to 62 and turns the recommendation into Pass.',
        checks_before_deciding: [
          'Call two reference clinics and one former colleague of each founder before scoring the team.',
          'Ask for the monthly burn and runway plan and check that €500k covers the German launch to the €50k revenue milestone.',
        ],
      },
      worlds: {
        worlds: [
          {
            world: 'good', title: 'DACH scheduling standard',
            story: 'Lumio wins Germany on the back of its Austrian references, becomes the default scheduling add-on for outpatient clinics in DACH and is bought by a practice-software vendor or health-IT group.',
            probability: 0.08, exit_value_eur: 150000000,
            assumptions: [
              { text: 'Monthly revenue keeps growing about 9% a month for at least two more years, reaching roughly €350k a month.', basis: 'pitch', quote: 'Monthly recurring revenue is €21k and grew 9% month over month in the last quarter', benchmark_id: null, why: null },
              { text: 'German clinics adopt Lumio as fast as Austrian ones, helped by integrations with the main German practice systems built within 12 months.', basis: 'judgement', quote: null, benchmark_id: null, why: 'Today the integrations cover Austria only; Germany uses different practice systems.' },
              { text: 'The 31% reduction in empty slots holds up in independent measurement, so clinics pay without long pilots.', basis: 'pitch', quote: 'Clinics using Lumio report 31% fewer empty slots', benchmark_id: null, why: null },
              { text: 'Lumio is among the minority of seed companies that raise a Series A within two years.', basis: 'benchmark', quote: null, benchmark_id: 'B3', why: null },
            ],
            distinguishing_conditions: ['German expansion works within 18 months', 'No practice-software vendor builds the same feature into its own product'],
            early_signals: ['10 or more paying German clinics within 12 months', 'Monthly revenue above €50k by month 9', 'A practice-software vendor signs a partnership'],
          },
          {
            world: 'neutral', title: 'Solid Austrian niche',
            story: 'Lumio grows steadily in Austria and slowly in Germany. It stays small and is eventually sold to a regional health-IT company at a modest price.',
            probability: 0.27, exit_value_eur: 25000000,
            assumptions: [
              { text: 'Growth slows to 3–4% a month once the easy Austrian clinics are signed.', basis: 'judgement', quote: null, benchmark_id: null, why: 'Growth from a small base of 14 customers usually slows as the first, most enthusiastic clinics are signed.' },
              { text: 'Lumio stays limited to clinics on the three practice systems it already supports.', basis: 'pitch', quote: 'Lumio integrates with the three most widely used practice management systems in Austria', benchmark_id: null, why: null },
              { text: 'A sale at a modest price is the most common good outcome for companies of this type.', basis: 'benchmark', quote: null, benchmark_id: 'B4', why: null },
            ],
            distinguishing_conditions: ['Germany takes longer than planned but does not fail', 'Customers stay, but growth needs paid sales effort'],
            early_signals: ['Fewer than 5 German clinics after 12 months', 'Monthly revenue between €35k and €50k by month 12'],
          },
          {
            world: 'worst', title: 'Feature, not a company',
            story: 'A practice-software vendor adds automatic slot refilling to its own product. Lumio cannot raise a Series A and shuts down or is sold for less than invested.',
            probability: 0.65, exit_value_eur: 0,
            assumptions: [
              { text: 'Most seed companies do not reach a Series A within two years; Lumio is one of them.', basis: 'benchmark', quote: null, benchmark_id: 'B3', why: null },
              { text: 'Lumio depends on other companies\u2019 practice systems, which can copy the feature.', basis: 'pitch', quote: 'Lumio integrates with the three most widely used practice management systems in Austria', benchmark_id: null, why: null },
              { text: 'The €500k round runs out before the German launch proves itself.', basis: 'judgement', quote: null, benchmark_id: null, why: 'The pitch gives no burn rate or runway, so the time to the next round is unknown.' },
            ],
            distinguishing_conditions: ['A large vendor ships a competing feature', 'German clinics do not convert'],
            early_signals: ['A vendor announces built-in slot refilling', 'Customer churn appears in Austria', 'Next round talks stall after month 12'],
          },
        ],
        optimism_flags: [
          { quote: 'There are more than 60,000 outpatient clinics in the DACH region', concern: 'The market size counts all clinics, not those that would pay for this tool or use a supported practice system.' },
          { quote: 'Clinics using Lumio report 31% fewer empty slots', concern: 'Self-reported by customers, with no baseline or independent measurement given.' },
        ],
        key_uncertainty: 'Whether Lumio can sign German clinics on practice systems it does not support yet.',
      },
    },
  },
  {
    id: 'kornfeld',
    name: 'Kornfeld Snacks',
    tagline: 'Protein snacks · Munich · Series A',
    purpose: 'Clearly fails screening',
    pitch: `Kornfeld Snacks – protein you can actually enjoy

Kornfeld is a Munich-based consumer brand making high-protein snack bars from regional grains. We sell direct to consumers online and through 1,200 supermarkets in Germany.

Traction: More than 40,000 paying customers ordered from our online shop in the last twelve months. Revenue reached €310k in September. Our monthly burn is €240k.

Team: Kornfeld employs 22 people, including a five-person food science team.

The round: After closing our seed round in 2024, we are now raising a €3m Series A at a €20m post-money valuation to expand into Austria and Switzerland.`,
    analystExample: {
      note: 'Example analyst inputs for the screening demo.',
      values: {},
      scores: { team: 3, market: 3, traction: 4, moat: 2, deal: 3 },
      scenarios: { pBig: 0.05, exitBig: 150000000, pMod: 0.35, exitMod: 40000000 },
      tranche: { milestone: '', months: 6 },
    },
    cached: {
      extract: {
        company_name: { value: 'Kornfeld Snacks', quote: 'Kornfeld is a Munich-based consumer brand' },
        sector: { value: 'Consumer', quote: 'Kornfeld is a Munich-based consumer brand making high-protein snack bars' },
        stage: { value: 'Series A', quote: 'we are now raising a €3m Series A' },
        region: { value: 'Germany', quote: 'Kornfeld is a Munich-based consumer brand' },
        raise_amount: { value: 3000000, quote: 'we are now raising a €3m Series A at a €20m post-money valuation' },
        post_money_valuation: { value: 20000000, quote: 'we are now raising a €3m Series A at a €20m post-money valuation' },
        monthly_revenue: { value: 310000, quote: 'Revenue reached €310k in September' },
        paying_customers: { value: 40000, quote: 'More than 40,000 paying customers ordered from our online shop in the last twelve months' },
        team_size: { value: 22, quote: 'Kornfeld employs 22 people' },
        monthly_burn: { value: 240000, quote: 'Our monthly burn is €240k' },
        possible_red_flags: [],
        notes: 'Paying customers counts online shop customers only; supermarket sales are not included.',
      },
      challenge: null,
    },
  },
  {
    id: 'tessera',
    name: 'Tessera Robotics',
    tagline: 'Warehouse robot software · Linz · no valuation',
    purpose: 'Limitation: missing valuation stops the tool',
    pitch: `Tessera Robotics – one control layer for every warehouse robot

Tessera is a seed-stage B2B software startup from Linz, Austria. Our software lets warehouses run robots from different manufacturers in one fleet.

Traction: Three logistics companies pay for pilots, bringing in €6k of monthly revenue. Two more pilots start in spring.

Team: We are five people: two robotics PhDs from JKU Linz, two engineers and a commercial lead with ten years in logistics sales.

Finances: Our monthly burn is €45k.

The round: We are raising €600k to convert our pilots into full contracts. The valuation will be agreed with our lead investor.`,
    analystExample: {
      note: 'Example analyst inputs (the valuation is still missing, so the tool stops).',
      values: {},
      scores: { team: 4, market: 3, traction: 2, moat: 3, deal: 3 },
      scenarios: { pBig: 0.08, exitBig: 150000000, pMod: 0.25, exitMod: 25000000 },
      tranche: { milestone: 'Two pilots converted to full contracts', months: 6 },
    },
    cached: {
      extract: {
        company_name: { value: 'Tessera Robotics', quote: 'Tessera Robotics – one control layer for every warehouse robot' },
        sector: { value: 'B2B software', quote: 'Tessera is a seed-stage B2B software startup from Linz, Austria' },
        stage: { value: 'Seed', quote: 'Tessera is a seed-stage B2B software startup' },
        region: { value: 'Austria', quote: 'Tessera is a seed-stage B2B software startup from Linz, Austria' },
        raise_amount: { value: 600000, quote: 'We are raising €600k to convert our pilots into full contracts' },
        post_money_valuation: { value: null, quote: null },
        monthly_revenue: { value: 6000, quote: 'bringing in €6k of monthly revenue' },
        paying_customers: { value: 3, quote: 'Three logistics companies pay for pilots' },
        team_size: { value: 5, quote: 'We are five people' },
        monthly_burn: { value: 45000, quote: 'Our monthly burn is €45k' },
        possible_red_flags: [],
        notes: 'The pitch says the valuation will be agreed with the lead investor, so no valuation is given.',
      },
      challenge: null,
    },
  },
];

export const sampleById = (id) => SAMPLES.find((s) => s.id === id) || null;
