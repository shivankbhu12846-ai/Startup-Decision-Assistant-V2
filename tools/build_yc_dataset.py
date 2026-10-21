"""Builds public/data/yc-companies.json from the open yc-oss dataset.

Source: https://github.com/yc-oss/api  (public list of Y Combinator companies, refreshed daily)
Run:    python3 tools/build_yc_dataset.py path/to/all.json
        (download all.json from https://yc-oss.github.io/api/companies/all.json first)
"""
import json, re, sys, datetime, os

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'yc-companies.json')
raw = json.load(open(SRC))

AI_TAGS = {'AI', 'Generative AI', 'Machine Learning', 'AI Assistant', 'Artificial Intelligence', 'Deep Learning', 'NLP', 'Computer Vision', 'LLM', 'AIOps', 'Conversational AI'}
CLIMATE_TAGS = {'Climate', 'Climatetech', 'Clean Energy', 'Energy', 'Sustainability', 'Carbon Capture and Removal', 'Renewable Energy', 'Solar Power', 'Batteries', 'Clean Tech', 'Cleantech'}
HARDWARE_TAGS = {'Hardware', 'Hard Tech', 'Robotics', 'IoT', 'Drones', 'Manufacturing', 'Semiconductors', '3D Printing', 'Space Exploration'}
BIOTECH_TAGS = {'Biotech', 'Therapeutics', 'Drug Discovery', 'Synthetic Biology', 'Genomics', 'Biology'}
DACH = ('Germany', 'Austria', 'Switzerland')

def sectors(c):
    tags = set(c.get('tags') or [])
    ind, sub = c.get('industry') or '', c.get('subindustry') or ''
    out = []
    if ind == 'B2B' or 'SaaS' in tags or 'B2B' in tags: out.append('B2B software')
    if tags & AI_TAGS: out.append('AI')
    if ind == 'Fintech' or 'Fintech' in tags: out.append('Fintech')
    if ind == 'Healthcare' or tags & {'Health Tech', 'Digital Health', 'Healthcare'}: out.append('Healthtech')
    if tags & CLIMATE_TAGS or 'Climate' in sub or 'Energy' in sub: out.append('Climate')
    if ind == 'Consumer': out.append('Consumer')
    if tags & HARDWARE_TAGS or 'Manufacturing and Robotics' in sub or 'Aviation and Space' in sub: out.append('Hardware')
    if tags & BIOTECH_TAGS or 'Therapeutics' in sub or 'Drug Discovery' in sub: out.append('Biotech')
    return out

def year(batch):
    m = re.search(r'(\d{4})', batch or '')
    if m: return int(m.group(1))
    m = re.search(r'[WSFX](\d{2})$', batch or '')
    return 2000 + int(m.group(1)) if m else None

rows = []
for c in raw:
    y = year(c.get('batch'))
    if not y: continue
    regions = c.get('regions') or []
    loc = c.get('all_locations') or ''
    rows.append({
        'n': c.get('name'),
        'o': (c.get('one_liner') or '')[:140],
        'y': y,
        's': c.get('status'),
        't': c.get('team_size') or None,
        'sec': sectors(c),
        'sub': (c.get('subindustry') or '').split(' -> ')[-1],
        'eu': 1 if ('Europe' in regions or 'United Kingdom' in regions) else 0,
        'dach': 1 if any(x in loc for x in DACH) else 0,
        'loc': loc.split(';')[0].strip()[:60],
        'u': c.get('url'),
    })

meta = {
    'source': 'Y Combinator company directory via the open yc-oss/api dataset',
    'sourceUrl': 'https://github.com/yc-oss/api',
    'downloaded': datetime.date.today().isoformat(),
    'count': len(rows),
    'notes': [
        'Only companies that went through Y Combinator: a selected, mostly US sample.',
        'Status is as listed by YC (Active, Inactive = shut down, Acquired, Public). "Active" can include companies that have stalled.',
        'No revenue or valuation data. Use the valuation benchmarks for prices.',
    ],
}
json.dump({'meta': meta, 'companies': rows}, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
print(OUT, len(rows), os.path.getsize(OUT) // 1024, 'KB')
