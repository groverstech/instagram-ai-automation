# Demo and staging validation guide (PR 4.1)

How to run BrandPilot locally, try the AI features in **Demo mode** (no keys, no cost), and validate
each real provider in **staging**. Provider details are in [AI_PROVIDERS.md](AI_PROVIDERS.md).

## 1. Demo mode vs Live AI mode

| | Demo mode | Live AI mode |
|---|---|---|
| How it's set | `AI_PROVIDER=mock` | `AI_PROVIDER` unset, with `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for images) |
| Indicator | An amber **DEMO MODE** bar on every page: "No AI provider is called…" | A green **LIVE AI** bar naming the providers and image model: "Requests use real providers and are billed." |
| Text | Deterministic stand-in output marked `[Demo]` | Claude Opus 5.5 (configurable) |
| Images | A placeholder labelled **DEMO IMAGE**, **DEMO VARIATION** or **DEMO EDIT** | GPT Image 2.6 Flare (generation, variations) and Sunburst (precision edits) |
| Cost | None. Usage shows as "Demo (no provider called)" with no cost. | Estimated per request from the provider's reported usage |
| Allowed in | Development and tests; a demo or staging server only with `AI_ALLOW_MOCK_IN_PRODUCTION=true`. Refused in production. | Everywhere |

Demo mode needs no credentials at all, so it works whatever keys exist or don't. Demo output is
never presented as real: the bar, the placeholder labels and the usage table all say so.

## 2. Local setup

Requirements: Node.js 20+ (22 recommended). No database to install: without `DATABASE_URL`, the app
runs embedded Postgres (PGlite) in `./.data/pg`.

```bash
cd web
npm install
cp .env.example .env.local
```

**Demo mode** (no keys): add these lines to `.env.local`:
```
AI_PROVIDER=mock
APP_SECRET=<any random string of at least 32 characters>
```

**Live AI mode** (your own keys, billed to your provider accounts): leave `AI_PROVIDER` empty and set
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env.local`. `.env.local` is git-ignored; never commit it.

Then:
```bash
npm run dev            # http://localhost:3000
# or, closer to production (Demo mode under `next start` also needs AI_ALLOW_MOCK_IN_PRODUCTION=true):
npm run build && npm start
```

Sign up at `/signup`, create an organisation and a brand, and complete onboarding. In Demo mode the
Brand Intelligence agent fills the profile with labelled stand-in content within seconds.

## 3. Walkthrough

### Creative Studio: create → variation → edit

1. **Creative Studio** → write a brief (e.g. "Spring table: speckled stoneware plates styled for a
   slow brunch, soft morning light").
2. Visual source: **AI image**. Choose a format, style and number of variations, then **Generate**.
   A job panel shows progress and its cost so far.
3. Open a creative → **Design** tab. Below the preview:
   - **Create a variation**: an optional direction ("warmer light, closer crop") → **Create variation**.
     Keeps the subject and mood, with a fresh composition (GPT Image 2.6 Flare). Replaces the current
     image.
   - **Edit this image**: an instruction ("make the tablecloth terracotta") → **Edit image**. Changes only
     what you describe and keeps everything else (GPT Image 2.6 Sunburst). Replaces the current image.
4. Brand colours, logo and text are composited by BrandPilot on top of the image, never drawn by the
   model. Run the **Brand check**, edit copy, export or schedule as before.

In Demo mode each step shows a labelled placeholder and the note "Demo mode: shows a labelled
placeholder; no image provider is called."

### Settings → AI providers & usage

Visible to owners and admins with access to every brand. It shows:
- the mode badge (**Demo mode** or **Live providers**);
- each provider's purpose, model and price source, e.g. "OpenAI list prices (retrieved 2026-11-11), per
  token from reported usage";
- whether a key is configured (never its value) and whether a provider is paused by the circuit
  breaker;
- live-validation status (from the last `npm run test:live` report);
- this month's requests by outcome (succeeded, retried, failed or refused, outcome unknown);
- the **estimated** cost and unpriced count, the optional spending limit, and usage by model and by brand;
- **Which model does each job use?**: every route and its model, including overrides.

Costs here are estimates. Confirmed provider billing is reconciled by operators at platform level
(`npm run ai:billing`), never shown to a customer organisation.

## 4. Staging: configuring and validating credentials

**Configuring keys:**
- Set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the **staging** environment's secret store only.
  Never in the repository, `.env.example`, documentation, tickets or chat.
- Keys are read on the server only. The client bundle scan (`npm run check:secrets`, in CI) fails the
  build if a server-only variable or key pattern reaches browser code, and logs redact them.
- **Production keys stay separate**: different keys (ideally separate provider projects with their own
  spending limits) in production's own secret store. Staging never holds production keys, and
  `DEPLOY_ENV=staging` vs `production` keeps the configurations apart.
- Set a monthly spending limit in both provider consoles before testing.

**Validate each provider on its own** (real, paid calls; never in CI). Run on the staging server or a
machine with the staging keys, with outbound HTTPS to `api.anthropic.com` and `api.openai.com`:

```bash
cd web
# Anthropic only: copy pack, vision review, ledger. Image tests are reported "not_run".
ANTHROPIC_API_KEY=… LIVE_REPORT_DIR=./live-anthropic npm run test:live

# OpenAI only: generation (fixed concept), all formats, variation (Flare), edit (Sunburst), ledger.
OPENAI_API_KEY=… LIVE_REPORT_DIR=./live-openai npm run test:live

# Both: the full flow, with Claude writing the concept.
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… LIVE_REPORT_DIR=./live-report npm run test:live
```
(Behind an HTTPS proxy, add `NODE_USE_ENV_PROXY=1`.)

Each run writes `report.json`, the raw image, the variation, the edit and every rendered format. Each
check is `passed`, `failed` or `not_run` (a missing key is never reported as passed). The run fails if a
key value appears in any output file. Point the server's `LIVE_REPORT_DIR` at a report to show it in
Settings.

**Then:**
1. Run the Creative Studio walkthrough above in Live AI mode and keep screenshots.
2. Check the ledger: `npm run ai:billing -- report <YYYY-MM>`, after importing the providers' cost
   report for the period (`npm run ai:billing -- import <file.json>`). Target: estimates within 5% of
   confirmed.
3. Record the results under F10 in [FOLLOW_UPS.md](FOLLOW_UPS.md), separately from the automated
   test results.

## 5. Troubleshooting

| Symptom | Cause |
|---|---|
| Yellow "AI is not configured" bar | No `ANTHROPIC_API_KEY` and not in Demo mode |
| "The AI service rejected the API key…" | Wrong or revoked key (not retried) |
| "…run out of credit or hit its spending limit" | Provider quota or billing limit (not retried) |
| "The AI service is having problems right now…" | Circuit breaker open after repeated provider failures; it retries automatically after 30 s |
| Image costs show "unpriced" | The response reported no usage, or the model has no rates; see AI_PROVIDERS.md |
| Boot refuses `OPENAI_IMAGE_MODEL=gpt-image-1` | That model was shut down on 2026-10-23; use the defaults or another catalogued model |
