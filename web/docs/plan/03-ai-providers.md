# 3. AI provider integration architecture

**Decision:**
- **Anthropic** for brand intelligence, strategy and content (text, vision review, research).
- **OpenAI** for images.
- A modular layer so other providers (video, alternative image models, embeddings) can be added.

**Until credentials are configured:** labelled mock mode, with real-provider validation reported as
*pending*.

## 3.1 What exists today

| Piece | Location | Notes |
|---|---|---|
| Text provider | `src/server/ai/llm.ts` | Anthropic Messages API; structured outputs; adaptive thinking; refusal fallbacks; web search; typed error mapping |
| Image provider | `src/server/ai/image.ts` | OpenAI `gpt-image-1` (`OPENAI_IMAGE_MODEL`), a demo placeholder in mock mode, error classes |
| Mode switch | `src/server/ai/mode.ts` | Demo vs production; mock ignored in production unless explicitly allowed |
| Ledger | `src/server/agents/orchestrator.ts` (`runAgent`) | One `agent_runs` row per call; usage and cost; failed and retried attempts; unknown-usage counting |
| Pricing | `src/server/ai/pricing.ts` | Per-model token prices (env overrides); image prices from env |
| Embeddings | `src/server/memory` | Voyage, or a local hashing fallback |

## 3.2 Target design

```
                    ┌──────────────── route config (DB, per plan/brand overrides) ───────────────┐
 agent / job  ──►   │ route: "copy.caption" → { kind: text, provider: anthropic, model, effort } │
                    └──────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  ai.call(scope, route, request)
        │  1. policy: is AI allowed for this brand now (autonomy, pause)?
        │  2. credits: estimate → reserve (document 5); refuse if a hard cap would be exceeded
        │  3. provider registry → adapter (anthropic | openai | mock | …)
        │  4. retries/backoff, timeout, circuit breaker per provider
        │  5. meter: provider usage → cost (USD) → credits; settle the reservation
        ▼
  agent_runs (ledger)  ──►  usage_events  ──►  credit ledger · cost dashboard · alerts
```

### Provider interfaces (capability-based)

| Interface | Methods | Adapters |
|---|---|---|
| `TextProvider` | `structured(req, schema)`, `chat(req, tools)`, vision input, server tools (web search) | `anthropic`, `mock` |
| `ImageProvider` | `generate(prompt, size, quality)`; later `edit(image, mask, prompt)` | `openai`, `mock`; future adapters (e.g. other image models) |
| `VideoProvider` | `submit(spec)` → `jobId`; `poll(jobId)`; `fetch(jobId)` → file (always asynchronous) | To be selected (§3.6) |
| `EmbeddingProvider` | `embed(texts)` | `voyage`, `local` |

Every adapter returns **normalised usage** (input, output and cached tokens; images; video
seconds; searches) and a **provider request ID**, so costs can be reconciled with the provider's
dashboard.

### Routes instead of hardcoded models

A route names a job: `brand.profile`, `strategy.research`, `strategy.section`, `creative.concepts`,
`copy.pack`, `creative.review`, `image.generate`, `assistant.chat`. It maps to a provider, model,
effort and limits in configuration:
- defaults ship in code;
- overrides are stored in the database and editable in the admin panel, per plan or per brand.

This makes model changes, cost tiering and A/B evaluation a configuration change, not a deploy.

## 3.3 Model choice and cost levers

**Default:** Claude Opus 5.5 (`claude-opus-5-5`) for every text route. That is today's behaviour,
and it stays the default.

The levers below are **options for you to decide**. Each is measured on an evaluation set before it
is switched on.

| Lever | Typical effect | Where it fits |
|---|---|---|
| **Effort** per route | Large token savings on simple routes at `low`/`medium` | Captions, hashtags, short rewrites |
| **Prompt caching** of the brand-context prefix | Cache reads cost about 1/20 of input on Opus 5.5 ($0.20 vs $4 per MTok) | Every brand-scoped call; the context is large and stable |
| **Batch API** (50% off) | Half price, results within hours | Nightly analytics summaries, weekly reviews, bulk calendar production |
| Smaller model per route (Sonnet 5.5 at $2/$10 per MTok; Haiku 5.5 at $0.10/$0.50) | 2–40× cheaper per token | High-volume, low-judgement routes (classification, tagging, short variants), **only if** evals show equal quality |
| **Image quality** per plan (low / medium / high) | The biggest image-cost lever | Drafts at lower quality, finals at high |

Prices are Anthropic list prices as of Nov 2026; check the current price sheet.
`src/server/ai/pricing.ts` must carry the prices of every model a route can use (today it only
carries Opus 5.5).

## 3.4 Reliability

- **Retries:** retryable errors (429, 5xx, connection) back off and retry inside the call, then at
  job level (already in place). Non-retryable errors (400, auth, content policy) fail fast with a
  clear message.
- **Circuit breaker per provider:** after N consecutive service errors, pause new calls for that
  provider for a short window, and show "AI service degraded" instead of piling up retries.
- **Refusals:** Anthropic server-side fallbacks (`fallbacks: "default"`) stay on. Image content
  policy refusals are shown to the user and never retried.
- **Timeouts:** text calls stream or have generous timeouts. Image calls run in background jobs
  (180 s). Video is always submit-and-poll.
- **Idempotency:** job steps are idempotent (in place). Each call carries the job step ID so a
  recovered step never double-generates.
- **Provider outage:** the status shows on the dashboard. Jobs wait and retry instead of failing.

## 3.5 Metering accuracy (feeds the credit system)

| Case | Recorded as |
|---|---|
| Success | Provider-reported usage × price |
| Failure **with** usage (e.g. truncated or invalid output) | That usage is billed: the provider charged for it |
| Retry | Each attempt is its own usage line |
| No response (network drop, timeout) | `unknownUsageAttempts += 1`: possibly billed, shown separately, never shown as free |
| Demo mode | No usage (no provider called) |

Each day, provider totals from the admin and usage APIs (Anthropic Admin API cost report; OpenAI
usage API) are reconciled against the ledger. A difference over 5% raises an alert.

## 3.6 Video generation (new)

Video comes after images. It's needed for Reels, Shorts and later TikTok.
- **Selection** happens in P4-8 (document 7): shortlist candidate video-generation APIs, compare
  quality, length, aspect ratios, price per second and terms (commercial use, content
  provenance), and run a paid pilot.
- **Separate track: video assembly.** Templated motion from creatives, text and brand assets
  (FFmpeg or a rendering service) is cheaper and fully on-brand. It covers many Reels and Shorts
  without generative video.
- **Metering:** video seconds generated, plus transcoding minutes.

## 3.7 Security and data handling

- **Keys:** server-only environment secrets, separate per environment (dev, staging, prod), rotated
  after tests and on staff changes. `check:secrets` in CI blocks keys in client bundles. Keys are
  never logged; the live test suite scans its outputs for them.
- **Prompt injection:** brand documents, competitor pages, comments and calendar text are passed as
  *data*. Tool calls that publish or spend need a policy decision (document 6), not just model
  output.
- **Privacy:** the privacy policy discloses which data goes to which provider. Use the providers'
  data-retention and training opt-out settings for API traffic. EU and other data-residency
  requirements are assessed in the data-protection review.

## 3.8 Adding a provider (checklist)

1. Implement the interface adapter, with usage normalisation and error mapping.
2. Add prices to the pricing table (configurable).
3. Add a route config entry, disabled by default.
4. Add live tests (`*.live.ts`) and intercepted-request tests.
5. Run evals against the current provider on that route.
6. Enable per plan or brand through configuration.
