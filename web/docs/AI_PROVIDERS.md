# AI providers

How BrandPilot calls Anthropic (text) and OpenAI (images), and how it tracks usage and cost.
Introduced in PR 4.1. Status of real-provider validation is at the end.

## Providers and what they do

| Provider | Used for | Routes |
|---|---|---|
| **Anthropic Claude** | Brand intelligence and Brand DNA, strategy, personas and pillars, campaigns and calendars, copy, the marketing advisor, web research, visual brand review | every text and research route |
| **OpenAI GPT image models** | Creative Studio images, campaign visuals, image variations | `image.generate`, `image.edit` |

Brand colours, fonts, logo and text are always composited by our renderer, never drawn by the image
model. Generated images are stored through the storage abstraction (`src/server/storage`), so they
move to Cloudflare R2 with PR 4.2 without changes here.

## Architecture

```
agent  ──llm().structured({ route, … })──▶  routes.ts  (model, effort, limits)
                                            │
                                            ▼
                                 call.ts executor ── circuit.ts (per provider)
                                 │  attempt → adapter (llm.ts: Anthropic SDK · image.ts: OpenAI HTTP)
                                 │  classify errors (errors.ts) → retry / stop
                                 ▼
                       usage_events (one row per attempt)   agent_runs (one row per agent call)
```

| Module | Role |
|---|---|
| `src/server/ai/catalog.ts` | **The only place models and prices live.** Text models with Anthropic list prices (dated), their capabilities (server-side refusal fallbacks, web search tool), and the image models the OpenAI adapter may use. |
| `src/server/ai/routes.ts` | Named jobs (17 routes) and how each resolves to a provider, model, effort or quality, timeout and attempts. |
| `src/server/ai/call.ts` | The executor: circuit breaker, attempts, retries, the per-attempt usage ledger. |
| `src/server/ai/errors.ts` | One error classification for both providers, driving retries, the circuit and user messages. |
| `src/server/ai/llm.ts` | Anthropic adapter (official SDK) and the demo-mode stand-ins. |
| `src/server/ai/image.ts` | OpenAI images adapter (generation and edits) and the demo placeholder. |
| `src/server/ai/pricing.ts` | Cost estimates from the catalog and configuration; anything unknown is unpriced. |
| `src/server/ai/usage.ts` | The usage ledger and monthly summaries per organisation and brand. |
| `src/server/ai/context.ts` | Attributes each attempt to its organisation, brand, user, task and run (set by `runAgent`). |
| `src/server/ai/overview.ts` | Settings → AI providers & usage. |

### Routes

Every AI call names its job. Text routes default to **Claude Opus 5.5** (the approved plan); images
default to `gpt-image-1` at `high` quality.

| Route | Job |
|---|---|
| `brand.profile`, `brand.assets`, `brand.qa` | Brand DNA analysis, brand asset (vision) analysis, brand questions |
| `strategy.research`, `strategy.section`, `advisor.chat` | Market research (web search), strategy sections (personas, pillars, calendar…), the marketing advisor |
| `campaign.plan`, `content.calendar`, `content.copy`, `content.ideas` | Campaigns, calendars, captions, ideas |
| `creative.concepts`, `creative.review` | Creative concepts; Claude vision review of the rendered creative |
| `competitor.research`, `competitor.analysis`, `analytics.insights` | Competitor research and analysis, analytics insights |
| `image.generate`, `image.edit` | Image generation and variations |

**Resolution, highest priority first:**
1. A database override in `ai_routes`: for the brand, then for the organisation's plan, then global.
2. Environment: `ANTHROPIC_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`, `AI_TEXT_TIMEOUT_MS`,
   `AI_IMAGE_TIMEOUT_MS`, `AI_MAX_ATTEMPTS`, `AI_IMAGE_MAX_ATTEMPTS`.
3. Code defaults.

Overrides are validated against the catalog: an unknown model, a research route on a model without
the web search tool, or an out-of-range parameter is ignored and logged (`ai.route_override_invalid`).
The configuration check refuses unknown models at boot. **Changing a model is a configuration
decision made after evaluation**, not a code change. To route to a model that isn't in the catalog,
add it there with its prices first.

There is no admin screen for overrides yet; rows are written by an operator. Settings shows which
model each job uses.

### Calls, retries and failures

SDK retries are **off**, so every request that reaches the network is seen, recorded and counted.

| Failure | Kind | What happens |
|---|---|---|
| 401 | `auth` | Not retried. "The AI service rejected the API key…" |
| 403 | `permission` | Not retried (account or model access). |
| Anthropic `billing_error`, OpenAI 429 `insufficient_quota` | `quota` | Not retried. "…run out of credit or hit its spending limit." |
| 429 | `rate_limit` | Retried after the provider's `retry-after` (or backoff). A wait longer than `AI_RETRY_MAX_WAIT_MS` (60 s) fails now, and background jobs retry later. |
| 529 / overloaded | `overloaded` | Retried with exponential backoff and jitter. |
| 5xx, 409 | `server` | Retried, unless the provider says `x-should-retry: false`. |
| Timeout, dropped connection | `timeout`, `network` | **Outcome unknown**: the provider may have processed and billed it. Text: retried. **Images: not retried**, so an image is never paid for twice without the user deciding. |
| Refusal | `refusal` | Billed, recorded as refused, not retried. Anthropic server-side fallbacks are on for models that support them. |
| Content policy (`moderation_blocked`) | `content_policy` | Recorded as refused, not retried; the user edits the art direction. |
| Truncated or invalid output | `output_invalid` | Billed, retried. |

Attempts per call: 3 for text, 2 for images (configurable). Background jobs (strategist, Creative
Studio batches) retry failed steps later, only for failures that can clear by themselves
(`isTransient`), and never re-run finished steps.

**Circuit breaker:** after `AI_CIRCUIT_THRESHOLD` (5) consecutive service failures, calls to that
provider pause for `AI_CIRCUIT_OPEN_MS` (30 s), recorded as `blocked`, with "The AI service is having
problems right now…". Then one probe call is let through. Rate limits, auth and quota don't count. The
state is per process.

### Prompt caching

Each agent's system prompt is sent as one block marked for prompt caching, since it repeats across
calls. Cache reads and writes (by TTL) are recorded and priced. Prompts below the model's minimum
cacheable size simply aren't cached.

## Usage and cost tracking

**`usage_events`** (migration 0008) has one row per provider attempt, whatever the outcome. Each row
records:
- the organisation, brand, user, task and run;
- the route, provider, model and kind;
- the attempt number and outcome: `success`, `retried`, `failed`, `refused`, `unknown` (sent, no
  response) or `blocked` (not sent);
- the error kind and HTTP status;
- the units the provider reported: input, output, cache-read and cache-write tokens, web searches,
  images and image tokens;
- the estimated cost and its **price source**;
- the provider's **request ID**, for reconciliation against provider reports;
- the latency.

`agent_runs` keeps one row per agent call with the total over all attempts, and now records its
organisation (`workspace_id`, backfilled by the migration).

**Prices**, all from `catalog.ts` or configuration, never guessed:

| Source | Covers | `price_source` |
|---|---|---|
| Anthropic list prices, retrieved 2026-11-10 from the pricing page | Opus 5.5, Sonnet 5.5, Haiku 5.5 (including its higher rate above 100k prompt tokens): input, output, cache reads, 5-minute and 1-hour cache writes; web search $10 per 1,000 | `anthropic-list-2026-11-10` |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `AI_PRICE_WEB_SEARCH_PER_1K` | A negotiated Anthropic contract | `config` |
| `OPENAI_IMAGE_PRICE_TEXT_INPUT_PER_MTOK`, `_IMAGE_INPUT_PER_MTOK`, `_OUTPUT_PER_MTOK` | OpenAI image tokens, as reported per response | `config:tokens` |
| `IMAGE_PRICE_USD_<QUALITY>_<SIZE>`, `IMAGE_PRICE_USD_<SIZE>`, `IMAGE_PRICE_USD` | OpenAI per image | `config:per-image` |
| none of the above, a fallback model not in the catalog, or a demo call | — | `unpriced`, `unknown`, `demo` |

No OpenAI prices are built in: OpenAI's pricing couldn't be verified when this was written. Until
image prices are configured, images are counted and shown as **unpriced**.

**These are estimates for budgets and dashboards.** The providers' invoices are the source of truth.
Reconciling the ledger against the providers' usage and cost reports (by request ID and totals) is
part of real-provider validation; their admin APIs need separate admin keys.

**Limits and entitlements:**
- The existing plan limit (AI runs per month) still applies.
- **Optional monthly spending limit**, from estimated cost in the ledger:
  `AI_MONTHLY_COST_LIMIT_USD`, or `AI_MONTHLY_COST_LIMIT_USD_<PLAN>` per plan. Unset means no limit.
- Credits (PRs 4.5–4.6) build on `usage_events`. Each row already carries organisation, brand,
  route, units and cost, so credit accounting, failed and retried counts and configurable entitlements
  need no change to how usage is recorded.

**Settings → AI providers & usage** (owners and admins with access to every brand) shows:
- the mode (live or demo) and whether each provider's key is configured, never the value;
- each provider's model and degraded state;
- the live-validation status;
- this month's requests by outcome, estimated cost and unpriced counts;
- usage by model and by brand;
- the spending limit;
- which model each job uses.

## Configuration

All keys are server-side environment variables (deployment secret store), never in code, the
repository, logs or the browser. `npm run check:secrets` scans client bundles.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | — | Claude. Required in staging and production. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Default text model (catalogued models only) |
| `OPENAI_API_KEY` | — | Images. Without it, AI images are unavailable; brand-photo and type-led creatives still work. |
| `IMAGE_PROVIDER` | `openai` | `none` turns AI images off |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` | `low`, `medium`, `high` |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | public APIs | Gateways or proxies; https in staging and production |
| `AI_TEXT_TIMEOUT_MS` / `AI_IMAGE_TIMEOUT_MS` | 600000 / 180000 | Per attempt |
| `AI_MAX_ATTEMPTS` / `AI_IMAGE_MAX_ATTEMPTS` | 3 / 2 | Attempts per call |
| `AI_RETRY_BASE_MS` / `AI_RETRY_MAX_WAIT_MS` | 1000 / 60000 | Backoff base; longest `retry-after` honoured in-call |
| `AI_CIRCUIT_THRESHOLD` / `AI_CIRCUIT_OPEN_MS` | 5 / 30000 | Circuit breaker |
| Price variables | — | See the table above |
| `AI_MONTHLY_COST_LIMIT_USD`, `AI_MONTHLY_COST_LIMIT_USD_<PLAN>` | — | Optional spending limit |
| `LIVE_REPORT_DIR` | — | Where `test:live` writes `report.json`; Settings shows it |
| `AI_PROVIDER=mock` | — | Demo mode (refused in production) |

## Security

- **Keys stay on the server.** They're read from the environment and never logged (log redaction),
  returned to the browser (Settings shows only "key configured") or included in error messages.
- **OpenAI requests** carry a keyed hash of the organisation as `safety_identifier`, so abuse reports
  can be traced without sending our IDs or user data.
- **Usage data is organisation-wide**, so only owners and admins with access to every brand see it;
  the server re-checks, and refusals are audited.
- Brand content sent to providers is the brand's own material, labelled as data, not instructions
  (existing agent prompts).

## Testing

| Suite | What it proves | Status |
|---|---|---|
| `ai-providers.test.ts` (25 tests) | The real adapters with the network intercepted: success, usage and cost recording, request IDs, cache pricing, invalid credentials, rate limits with `retry-after`, too-long waits, quota, overload, timeouts, refusals, invalid output, circuit breaker, routing and overrides, Haiku without fallbacks, image pricing sources, image generation and variations, OpenAI errors, usage isolation between organisations, spending limits, demo mode never calling a provider, who may see the usage view | Passing, in CI |
| `claude-integration`, `strategist-claude`, `creative-providers` tests | Request shapes and accounting through real agent flows (intercepted) | Passing, in CI |
| `npm run test:live` | **Real** calls: image generation and all formats, image variations, vision review, copy, invalid keys, ledger request IDs | **Pending: no production credentials yet.** Never runs in CI. |

## Real-provider validation: pending

No Anthropic or OpenAI production keys have been configured, so **no real generation has been
run**. Every result above comes from intercepted providers or demo mode, and none of it is
evidence of real output quality. When keys are configured on a server:
1. `LIVE_REPORT_DIR=/path npm run test:live` (real, paid calls: about one image, one variation and a
   few Claude calls).
2. Manual runs of the creative and strategist flows (M1–M9 in `CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`),
   with screenshots.
3. Reconcile the ledger against the providers' usage reports (target: within 5%).

Report these separately from PR 4.1's automated results.
