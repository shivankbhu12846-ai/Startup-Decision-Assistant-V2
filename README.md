# Startup investment decision tool

A one-page website that runs a startup pitch through the group's nine-step process:
fund rules → pitch → AI extraction → analyst verification → screening → analysis →
AI challenge → committee decision → log and monitoring.

- **AI** (steps 3 and 7) runs through a small Netlify Function, so the API key never reaches the browser.
- **Code** (steps 5 and 6) is plain JavaScript in `public/js/model.js`. Same inputs always give the same result.
- **People** confirm every AI value, score the criteria and make the final decision.

## Folder layout

```
netlify.toml                  Netlify settings (publish folder + functions folder)
netlify/functions/llm.mjs     the AI service at /api/llm (holds the key, fixed prompts only)
public/index.html             the website
public/css/app.css            styling
public/js/app.js              the user interface
public/js/model.js            screening, score, expected value, sensitivity, decision rule
public/js/prompts.js          the fixed AI instructions (shared by the site and the function)
public/js/samples.js          three fictional test pitches with saved example AI answers
public/js/fileread.js         reads uploaded PDF, Word, PowerPoint and text files in the browser
public/js/benchmarks.js       valuation benchmarks (with sources) and comparisons with the startup database
public/js/metrics.js          performance metrics, findings and the fictional example history
public/js/aichecks.js         checks on AI answers: quotes, benchmark ids, probabilities, web sources
public/data/yc-companies.json 6,300+ Y Combinator startups (open yc-oss dataset), built by tools/build_yc_dataset.py
tests/v2.test.mjs             tests for the version 2 features
public/vendor/                file-reading libraries (pdf.js, mammoth, JSZip), self-hosted
tests/model.test.mjs          checks the Lumio numbers and the stop rules
```

## Deploy on Netlify (about 10 minutes)

Netlify's drag-and-drop upload only publishes static files, not functions, so use one of these:

**Option A: GitHub (recommended for a group)**
1. Create a GitHub repository and upload this folder's contents.
2. In Netlify: *Add new site → Import an existing project → GitHub* → pick the repository.
3. Leave the build command empty. Netlify reads `netlify.toml` (publish folder `public`).
4. Deploy, then add the environment variables below and redeploy.

**Option B: Netlify CLI**
```
npm install -g netlify-cli
netlify login
netlify deploy --prod     # run inside this folder
```

### Environment variables

Netlify → *Site configuration → Environment variables*:

| Variable | Value |
|---|---|
| `LLM_API_KEY` | your provider's API key (required for live AI) |
| `LLM_PROVIDER` | `mistral` (default), `gemini`, `openai`, `anthropic` or `openrouter` |
| `LLM_MODEL` | optional; overrides the default model (`mistral-small-latest` for Mistral) |
| `APP_PASSCODE` | optional; users must enter it before AI calls work, so strangers can't use your quota |
| `WEB_SEARCH` | optional; `off` hides the live web search (it only works with `openrouter`) |

Redeploy after changing variables. The chip in the top right shows which provider and model are live.

### Getting a free Mistral key
1. Sign up at console.mistral.ai and choose the free *Experiment* plan (phone verification, no credit card).
2. Create an API key and paste it into `LLM_API_KEY`.

Requests on the free plan may be used to train Mistral's models, so use fictional or test pitches only.
Google's Gemini free tier is not allowed for apps used by people in the EEA, so use Gemini only on a paid key.

### Without a key
The site still works. The AI chip shows "demo mode" or "key not set", and the three sample pitches use saved
example AI answers so the full demo runs. Custom pitches can be entered manually in step 4.

## Uploading pitch files

Step 2 accepts PDF, Word (.docx), PowerPoint (.pptx) and text files, several at once (e.g. deck + financials).
The browser extracts the text; the file itself is never uploaded. The extracted text appears in the pitch box,
with [Page n] / [Slide n] markers, so the analyst can check and trim it before it goes to the AI.

- Up to 60,000 characters are sent (roughly a 30–40 slide deck).
- Scanned or image-only PDFs have no text to read; the tool says so. Export the deck as a PDF with text instead.
- Old formats (.doc, .ppt, Keynote) need to be saved as PDF, .docx or .pptx first.

## Version 2 features

**Good, neutral and worst world (step 4, AI).** The AI describes three futures and labels every assumption:
*pitch* (its quote is checked word for word), *benchmark* (must cite one of the facts B1, B2 … the tool sends), or *AI judgement*
(with its reasoning). It lists what must be true for each world, early signals for the next 12 months and the pitch's most
optimistic claims. "Use these numbers" copies the chances and exit values into the scenario estimates; the analyst can still change them.
Probabilities that do not add up to 100% are rescaled and the analyst is told.

**How this startup compares (step 6, code).** Pre-money valuation against published medians (PitchBook, Carta; every figure linked),
outcomes of startups in the same sector (shut down / acquired / public / still active, from YC companies started 2010–2019),
team size percentile and a list of similar companies.

**Recent news on comparable startups (step 6, AI web search).** Needs `LLM_PROVIDER=openrouter`. Uses OpenRouter's web search
(about $0.02 per search). Every item must name its source; the tool marks whether that source was among the pages the search returned.
Set `WEB_SEARCH=off` to hide it. There is no saved example: search results must be real.

**Sector benchmarks (tool page).** Pick a sector and region to see outcomes by the year companies started, valuation benchmarks
and a searchable company list.

**Performance metrics (tool page).** From the decision log: share of AI values analysts kept unchanged, quote-check rejections,
which fields needed fixing, override rate, predicted vs actual milestone rates (calibration, Brier score), and how overrides and
scores relate to outcomes. Findings come from fixed rules and suggest changes for partners to make in step 1 or in prompts.js.
An optional, clearly labelled example history of 24 fictional decisions shows the page before real outcomes exist.

To refresh the startup database: download https://yc-oss.github.io/api/companies/all.json and run
`python3 tools/build_yc_dataset.py all.json`.

## Data

Fund rules, cases and the decision log are stored in each person's browser (localStorage).
Use *Export all data* / *Import data* in step 9 to share them across the group.
A shared database (e.g. Netlify Blobs or Supabase) would be the next step if everyone should see the same log.

## The model in short

- **Score** = Σ (1–5 score × weight) converted to /100. Default weights: Team 25, Market 25, Traction 20, Moat 10, Deal terms 20.
- **Expected value (invest now)** = our stake × (1 − dilution until exit) × expected exit value − ticket.
- **Milestone / next round**: two inputs say how many future winners and how many future failures hit the milestone.
  Bayes' rule then gives the chance of hitting it and the lower failure risk afterwards, so the numbers always stay consistent.
- **Tranches**: first tranche now; second tranche only if the milestone is hit.
- **Wait**: invest at the next round's higher valuation, only if the round happens and we get an allocation.
- **Sensitivity**: changes one assumption at a time and lists the switch points where the recommendation flips.
- **Decision rule**: Pass if screening fails, score < threshold or EV ≤ 0. Wait if 1–2 key inputs are missing and waiting keeps most of the value.
  Tranches if failure chance ≥ 60% or a switch point is close. Otherwise invest now.
- **Stop rules**: missing valuation or round size, or more than two missing key inputs, stop the process. An AI value whose quote is not found
  word for word in the pitch is treated as missing. Overriding the recommendation requires a written rationale.

All thresholds and margins are editable in step 1.

## Demo script for the pilot

1. **Test case**: load Lumio → extract → *Fill in the example analyst inputs* → confirm → screening → analysis
   (score 72, invest now €875k vs tranches €929k → *Invest in tranches*) → AI challenge → committee → log.
2. **Changed assumption**: in step 6 move the *Team score* slider from 4 to 2: score 62, recommendation flips to *Pass*.
3. **Limitation**: load Tessera Robotics (no valuation) → step 4 shows *Stop: research missing data*.
4. **Fails screening**: load Kornfeld Snacks → fails on sector, stage and ticket size → goes to the committee as *Pass*.

Tip: set the review date in step 8 to today to show the reminder in step 9.

## Run the tests

```
npm test        # or: node tests/model.test.mjs && node tests/v2.test.mjs
```
