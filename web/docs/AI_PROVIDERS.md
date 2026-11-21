# AI providers

How BrandPilot calls Anthropic (text) and OpenAI (images), and how it tracks usage and cost.
Introduced in PR 4.1. Status of real-provider validation is at the end.

## Providers and what they do

| Provider | Used for | Routes |
|---|---|---|
| **Anthropic Claude** | Brand intelligence and Brand DNA, strategy, personas and pillars, campaigns and calendars, copy, the marketing advisor, web research, visual brand review | every text and research route |
| **OpenAI GPT Image 2.6** | Creative Studio images and campaign visuals (Flare), image variations (Flare), precision edits (Sunburst) | `image.generate`, `image.variation`, `image.edit` |

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
| `src/server/ai/routes.ts` | Named jobs (18 routes) and how each resolves to a provider, model, effort or quality, timeout and attempts. |
| `src/server/ai/call.ts` | The executor: circuit breaker, attempts, retries, the per-attempt usage ledger. |
| `src/server/ai/errors.ts` | One error classification for both providers, driving retries, the circuit and user messages. |
| `src/server/ai/llm.ts` | Anthropic adapter (official SDK) and the demo-mode stand-ins. |
| `src/server/ai/image.ts` | OpenAI images adapter (generation, variations, edits) and the demo placeholder. |
| `src/server/ai/pricing.ts` | Cost estimates from reported usage at the rates in effect (price table, configuration, catalog list prices); anything unknown is unpriced. |
| `src/server/ai/billing.ts` | Provider-confirmed billing (imported by operators) and its reconciliation with the estimates. |
| `src/server/ai/usage.ts` | The usage ledger and monthly summaries per organisation and brand. |
| `src/server/ai/context.ts` | Attributes each attempt to its organisation, brand, user, task and run (set by `runAgent`). |
| `src/server/ai/overview.ts` | Settings → AI providers & usage. |

### Routes

Every AI call names its job. Text routes default to **Claude Opus 5.5** (the approved plan). Images
default to **GPT Image 2.6 Flare** for generation and variations, and **GPT Image 2.6 Sunburst** for
precision edits, at `high` quality. (`gpt-image-1` was shut down on 2026-10-23 and is no longer
accepted.)

| Route | Job |
|---|---|
| `brand.profile`, `brand.assets`, `brand.qa` | Brand DNA analysis, brand asset (vision) analysis, brand questions |
| `strategy.research`, `strategy.section`, `advisor.chat` | Market research (web search), strategy sections (personas, pillars, calendar…), the marketing advisor |
| `campaign.plan`, `content.calendar`, `content.copy`, `content.ideas` | Campaigns, calendars, captions, ideas |
| `creative.concepts`, `creative.review` | Creative concepts; Claude vision review of the rendered creative |
| `competitor.research`, `competitor.analysis`, `analytics.insights` | Competitor research and analysis, analytics insights |
| `image.generate`, `image.variation` | Image generation; variations of an existing image (rapid creative iteration) |
| `image.edit` | Precision edits: change only what the instruction names |

**Resolution, highest priority first:**
1. A database override in `ai_routes`: for the brand, then for the organisation's plan, then global.
2. Environment: `ANTHROPIC_MODEL`, `OPENAI_IMAGE_MODEL` (generation and variations),
   `OPENAI_IMAGE_EDIT_MODEL` (edits), `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_COMPLEXITY`, `AI_TEXT_TIMEOUT_MS`,
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

### Image models (verified)

Verified against OpenAI's official documentation (developers.openai.com: model pages, pricing page and
image generation guide) on **2026-11-11**:

| Model ID | OpenAI's description | Used for here |
|---|---|---|
| `gpt-image-2.6-flare` (default) | Image generation and editing for fast iteration | `image.generate`, `image.variation` |
| `gpt-image-2.6-sunburst` (default for edits) | For detailed visual work | `image.edit` |
| `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | Previous generation, same rates | Available by configuration |

Both 2.6 models are served by the Images API endpoints we call: `v1/images/generations` and
`v1/images/edits` (variations and edits send the current image there). Quality is `low`, `medium`,
`high`, `xhigh` or `max` (default `high`). `complexity` (`low`, `medium`, `high`, default `high`) is sent
only when configured and has no separate fee.

### How costs are calculated

Every cost is calculated **from the usage the provider reports in each response**, at the rates in
effect. There is **no universal per-image price**: a GPT Image call costs
text input tokens + image input tokens (edits and variations) + image output tokens, and the number of
output tokens depends on the quality, size and content. Each `usage_events` row records:
- the units: text input, image input, image output and any text output tokens;
- the parameters: quality, size and complexity (`params`);
- the model, the provider's request ID and the price source.

If a response reports no usage, the attempt is recorded as **unpriced** rather than guessed.

**Rates, highest priority first:**

| Source | Covers | `price_source` |
|---|---|---|
| **Price table** `ai_prices` (migration 0009): one row per model with the rates and the date they take effect | Any catalogued model, e.g. negotiated contract rates. Changes apply within a minute, **without a code change or redeploy**. | `ai_prices:<source>` |
| Environment: `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `AI_PRICE_WEB_SEARCH_PER_1K`; `OPENAI_IMAGE_PRICE_TEXT_INPUT_PER_MTOK`, `_IMAGE_INPUT_PER_MTOK`, `_OUTPUT_PER_MTOK` | Contract rates set per deployment | `config` |
| **Anthropic list prices**, retrieved 2026-11-10 | Opus 5.5, Sonnet 5.5, Haiku 5.5 (including its higher rate above 100k prompt tokens): input, output, cache reads, 5-minute and 1-hour cache writes; web search $10 per 1,000 | `anthropic-list-2026-11-10` |
| **OpenAI list prices**, retrieved 2026-11-11 from the official pricing page | GPT Image 2.6 and 2.5 Flare and Sunburst, per 1M tokens: text input $5, image input $8, image output $30 | `openai-list-2026-11-11` |
| none of the above, a fallback model not in the catalog, or no usage reported | — | `unpriced` |

Notes:
- OpenAI publishes cached-input rates (text $1.25, image $2), but they apply only through the Responses
  API, not to direct Images API calls, so they're not used here.
- OpenAI publishes no rate for image-model text output. If a response reports any, it's recorded and
  the price source says `; text output unpriced`.
- A price-table row example (rates in USD per 1M tokens; `textInput`, `imageInput`, `imageOutput` for
  images; `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `webSearchPer1k` for text):
  ```sql
  insert into ai_prices (id, provider, model, rates, source, effective_from)
  values (gen_random_uuid()::text, 'openai', 'gpt-image-2.6-flare',
          '{"textInput": 4, "imageInput": 6.4, "imageOutput": 24}', 'contract-2027', '2027-01-01');
  ```
  Rows are never edited in place: a new row with a later `effective_from` supersedes the previous one,
  so past estimates stay explainable.

### Estimated versus confirmed costs

- **Estimated:** the ledger cost above. It's shown in Settings and drives the optional spending limit.
- **Confirmed:** what the provider actually billed, imported by an operator from the providers' cost
  reports or invoices into `ai_billing`:
  ```
  npm run ai:billing -- import billing-2026-11.json   # [{ provider, model?, periodStart, periodEnd, usd, source, reference? }]
  npm run ai:billing -- report 2026-11                # estimated vs confirmed per provider and model
  ```
  The report also lists unpriced attempts and attempts with an unknown outcome (they may be billed).
  Providers bill the BrandPilot account as a whole, so confirmed amounts are **platform-level**: they're
  compared with the estimates of all organisations together, for operators only, and never shown to a
  customer organisation. Re-importing a line (same provider, model, period and source) updates it.
  Fetching cost reports automatically needs provider admin keys (follow-up F11); the
  console exports below need none.

### Reconciling with provider console exports

Both consoles export usage and cost data as CSV (Anthropic Console: Usage and Cost pages;
OpenAI dashboard: Usage). **No admin API keys are needed.**

```
npm run ai:billing -- reconcile anthropic usage-export.csv --since 2026-11-14T10:00:00Z --until 2026-11-14T12:00:00Z
npm run ai:billing -- reconcile anthropic cost-export.csv  --since … --until … --amount-unit cents   # if amounts are in cents
npm run ai:billing -- reconcile openai    cost-export.csv  --since … --until … --json result.json
```

- Columns are recognised by name (e.g. `model`, `uncached_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, `images`, `num_model_requests`, `amount`, `line_item`, `description`). The model
  can come from a line item or description ("Claude Opus 5.5 Usage - Output Tokens"). Any column
  can be mapped explicitly with `--map field="Column name"`. The report prints the columns it used.
- **Request level** only when the export has request IDs: each ledger attempt is matched by the
  provider request ID. **Neither provider's documented usage or cost data includes request IDs**
  (Anthropic's usage and cost reports and OpenAI's usage and costs reports are aggregated by time
  bucket and model, verified 2026-11-14), so in practice the comparison is **aggregate**: per
  model, over the same period. Request-level accuracy is never claimed from aggregate data.
- **Daily exports** are compared over the same whole UTC days. Any other use of the same API key
  on those days appears as a difference, so validations use a dedicated key or workspace.
- **Tokens** are compared exactly (metering). **Costs** are compared with the export's amounts;
  an export without amounts is priced at the same rates, which checks metering only, and the
  report says so. OpenAI's images usage report has image and request counts but no tokens.
- Excluded and listed separately: attempts with an unknown outcome (sent, no response: possibly
  billed, no usage), unpriced attempts, and blocked attempts (never sent).
- Usage can take time to appear in the consoles (Anthropic documents up to 24 hours for its
  analytics data), so exports are taken after that.

### Spending cap and run log (validation budgets)

`AI_SPEND_CAP_USD` sets a hard cap on estimated AI spending for the whole deployment, counted from
`AI_SPEND_CAP_SINCE` (default: the start of the month). It's checked **before every provider
request**: a request is sent only if

`committed spend + reserves of requests in flight + this request's worst case ≤ cap`.

- Worst cases: for text, the estimated prompt (about 3 characters per token, all priced at the
  highest input rate) plus the full output-token limit, plus web-search fees and results; for
  images, `AI_SPEND_CAP_IMAGE_RESERVE_USD` (default $1.00, far above OpenAI's published per-image
  output costs).
- Attempts that may have been billed but have no price (unknown outcome, unpriced) count at their
  reserve (`AI_SPEND_CAP_TEXT_RESERVE_USD`, default $0.50, or the image reserve).
- A refused request is recorded as `blocked` (`spend_cap`), and the user sees "The AI spending cap
  for this environment would be exceeded…". Nothing is sent.
- The in-flight reserve is per process: run a validation with a single app process.
- **Fails closed.** A cap that is set but malformed, or an `AI_SPEND_CAP_SINCE` that is set but
  not a date and time, refuses every request (it used to mean "no cap" / "start of month").
  `AI_SPEND_CAP_SINCE` is ISO 8601 in UTC, e.g. `2026-11-14T00:00:00Z`.
- `AI_SPEND_CAP_REQUIRED=true` refuses every provider request unless a valid cap and start time
  are set. Paid operator commands turn it on for their own process.

**Paid operator commands** (`npm run test:live`, `npm run ai:check-anthropic`) go through
`src/server/ai/paid-run-guard.ts`. Before anything can reach a provider they refuse to run unless:
- not in CI;
- `AI_SPEND_CAP_USD` is a positive number and `AI_SPEND_CAP_SINCE` a UTC time in the format above,
  not in the future;
- the usage ledger is persistent (`DATABASE_URL`, `PGLITE_DIR` or the default `.data/pg`; never
  `memory://`), so spending recorded by earlier runs counts. Both commands share that ledger;
- the spending already recorded since `AI_SPEND_CAP_SINCE` is below the cap.

During the run, required-cap mode is on and a network guard blocks any request to a provider host
(`api.anthropic.com`, `api.openai.com`, or a configured base URL) that doesn't hold a reservation
under the cap, i.e. that didn't go through the executor's check. Paid APIs with no cap accounting
(embeddings, `api.voyageai.com`) are blocked. `test:live` loads the guard through
`vitest.live.config.ts` (`setupFiles`) before any live test file, and the live test refuses to start
if it isn't active.

`npm run ai:billing -- log --since <ISO> --budget 10 [--json run-log.json]` lists every real
provider request: time, provider, route, model, attempt, outcome, HTTP status, the provider's
request ID, units, estimated cost, running total and remaining budget. It holds no keys or prompt
content.

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
- this month's requests by outcome, **estimated** cost and unpriced counts;
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
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.6-flare` | Generation and variations: `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `OPENAI_IMAGE_EDIT_MODEL` | `gpt-image-2.6-sunburst` | Precision edits (same choices) |
| `OPENAI_IMAGE_QUALITY` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `OPENAI_IMAGE_COMPLEXITY` | (not sent: OpenAI's default, `high`) | `low`, `medium`, `high` |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | public APIs | Gateways or proxies; https in staging and production |
| `AI_TEXT_TIMEOUT_MS` / `AI_IMAGE_TIMEOUT_MS` | 600000 / 180000 | Per attempt |
| `AI_MAX_ATTEMPTS` / `AI_IMAGE_MAX_ATTEMPTS` | 3 / 2 | Attempts per call |
| `AI_RETRY_BASE_MS` / `AI_RETRY_MAX_WAIT_MS` | 1000 / 60000 | Backoff base; longest `retry-after` honoured in-call |
| `AI_CIRCUIT_THRESHOLD` / `AI_CIRCUIT_OPEN_MS` | 5 / 30000 | Circuit breaker |
| Price variables | — | See "How costs are calculated". The retired `IMAGE_PRICE_USD*` variables are ignored, with a warning at boot. |
| `AI_MONTHLY_COST_LIMIT_USD`, `AI_MONTHLY_COST_LIMIT_USD_<PLAN>` | — | Optional spending limit |
| `AI_SPEND_CAP_USD`, `AI_SPEND_CAP_SINCE` | — | Hard cap for the whole deployment, checked before every request (validation budgets). Since: UTC, e.g. `2026-11-14T00:00:00Z`. Required by `test:live` and `ai:check-anthropic` |
| `AI_SPEND_CAP_REQUIRED` | — | `true`: refuse every provider request unless a valid cap is set (paid commands set it themselves) |
| `AI_SPEND_CAP_IMAGE_RESERVE_USD`, `AI_SPEND_CAP_TEXT_RESERVE_USD` | 1.00 / 0.50 | Worst-case reserve for an image request; fallback reserve for an unpriced text attempt |
| `LIVE_REPORT_DIR` | — | Where `test:live` writes `report.json`; Settings shows it |
| `AI_PROVIDER=mock` | — | Demo mode (refused in production) |

## Security

- **The Anthropic API key is sent in the `x-api-key` header**, with no prefix and no `Authorization`
  header (`anthropicAuth` in `llm.ts`; the installed SDK would otherwise send it as a bearer token).
  `ANTHROPIC_AUTH_TOKEN`, for gateways that take a bearer token, is used only when no API key is set.
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
| `ai-providers.test.ts` (31 tests) | The real adapters with the network intercepted: success, usage and cost recording, request IDs, cache pricing, invalid credentials, rate limits with `retry-after`, too-long waits, quota, overload, timeouts, refusals, invalid output, circuit breaker, routing and overrides, Haiku without fallbacks, default image models, per-token image pricing (list, configuration, price table by effective date), image generation, variations (Flare) and edits (Sunburst), OpenAI errors, estimated vs confirmed billing reconciliation, usage isolation between organisations, spending limits, demo mode never calling a provider, who may see the usage view | Passing, in CI |
| `claude-integration`, `strategist-claude`, `creative-providers` tests | Request shapes and accounting through real agent flows (intercepted) | Passing, in CI |
| `npm run test:live` | **Real** calls: image generation and all formats, image variations, precision edits, vision review, copy, invalid keys, ledger request IDs | **Pending: no production credentials yet.** Never runs in CI. |

## Real-provider validation: pending

No Anthropic or OpenAI keys have been configured yet (staging first, then production), so **no real
generation has been run**. Every result above comes from intercepted providers or demo mode, and none of it is
evidence of real output quality. When keys are configured on a server:
1. `LIVE_REPORT_DIR=/path npm run test:live` (real, paid calls: about one image, one variation, one
   edit and a few Claude calls). Each provider can be validated on its own: see `docs/DEMO.md`.
2. Manual runs of the creative and strategist flows (M1–M9 in `CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`),
   with screenshots.
3. Import the providers' cost reports for the period and run `npm run ai:billing -- report <YYYY-MM>`
   (target: estimates within 5% of confirmed).

Report these separately from PR 4.1's automated results.
