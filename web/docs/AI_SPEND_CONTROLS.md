# AI spending controls: current state and production architecture

Status: PR 4.1 implements the foundation (one accounted path for every paid request, a fail-closed
usage ledger, a deployment-wide hard cap for validation and staging). This document describes how
the production controls build on it. A global cap is **not** meant to be the only control: it is
the last line of defence, below per-organisation and per-brand limits and credits.

## 1. Foundation (implemented in PR 4.1)

| Piece | Where | What it guarantees |
|---|---|---|
| Single executor | `src/server/ai/call.ts` | Every paid provider attempt runs through `execute()`: circuit breaker, retries, accounting. |
| Fail-closed ledger | `src/server/ai/spend-cap.ts`, `usage_events` | A `pending` row with the attempt's worst-case `reserve_usd` is committed **before** sending, under an advisory lock; refused if it can't be written; settled in place afterwards. |
| Attribution | `src/server/ai/context.ts`, `agents/orchestrator.ts` | Each row carries organisation (`workspace_id`), brand, user, task and run. |
| Hard cap | `AI_SPEND_CAP_*` | Deployment-wide ceiling; required in staging and for paid operator commands. |
| Network guard | `src/server/ai/paid-run-guard.ts` | In staging and paid commands, provider requests without an open attempt are blocked at `fetch`. |
| Monthly organisation limit | `src/server/quota.ts` | Soft limit checked before each AI action (estimated cost this month). |

The one primitive every future control uses is the same: **a check and a pending reservation in one
transaction, before sending**, against a sum over `usage_events` filtered by a scope.

## 2. Production architecture (to build)

All limits below are evaluated inside `openAttempt()`'s transaction, in this order, and the first
that would be exceeded refuses the request (recorded as `blocked` with the limit that refused it).
Each is a `(scope, period, amount, action)` rule:

### 2.1 Platform-wide emergency protection (first, always on in production)
- **Global hard ceiling** per period (e.g. per day and per month) far above normal usage, from the
  existing `AI_SPEND_CAP_*` mechanism generalised to rolling windows.
- **Kill switch**: a row in an `ai_controls` table (and an env override) that stops all paid
  requests, or all requests for one provider or model, within seconds and without a deploy.
  Checked in `openAttempt()`; changing it is an audited admin action.
- **Rate-of-spend tripwire**: if spend in the last N minutes exceeds a threshold (runaway loop,
  abuse, pricing change), automatically switch to the kill-switch state for that provider and page
  the on-call engineer. Auto-clear only by a person.
- **Provider-side limits** (Anthropic Console, OpenAI project budgets) stay configured as the
  independent backstop; production and staging use separate keys and projects.

### 2.2 Organisation-level spending limits
- `org_spend_limits(workspace_id, period, hard_usd, soft_usd, alert_thresholds)` with defaults per
  plan (today's `AI_MONTHLY_COST_LIMIT_USD_<PLAN>` becomes the default row).
- **Hard** limit: enforced per request in `openAttempt()`, counting pending reserves, so concurrent
  requests can't overshoot (the current monthly check runs once per action and ignores in-flight
  work: it becomes this).
- **Soft** limit: requests continue; owners are alerted and the UI shows the state.
- Owners can lower limits themselves; raising above the plan's ceiling needs billing approval.

### 2.3 Brand-level spending controls
- `brand_spend_limits(brand_id, period, hard_usd, soft_usd)`, optional, set by organisation owners
  and admins within the organisation's limit (an agency can give each client brand its own budget).
- Same enforcement point and counting as organisation limits; scope = `brand_id`.
- Optionally per route kind (e.g. a brand may use text but not image generation).

### 2.4 Subscription-based AI credits (PRs 4.5–4.6)
- Credits are the customer-facing unit; dollars stay internal. A `credit_ledger` (append-only:
  grants per billing period, purchases, refunds, expiries, consumption) per organisation.
- **Reserve, then settle**, exactly like the spend ledger: `openAttempt()` reserves the attempt's
  worst-case credits (from a per-route/per-model price table, versioned) in the same transaction;
  settlement converts actual usage to credits and releases the difference. Unknown outcomes keep
  the reservation until reconciled. Pending rows from crashed processes are released by a
  reconciler after provider usage confirms them.
- Insufficient credits refuse the request before sending, with an upgrade or top-up message.
- Credit prices are derived from provider list prices plus margin; a provider price change updates
  the table (`ai_prices`) and is audited.

### 2.5 Configurable hard limits and alerts
- Alerts at configurable thresholds (e.g. 50/80/100%) per organisation, brand and the platform:
  email to owners, in-app banner, and platform alerts to operations. De-duplicated per period.
- Daily reconciliation job: estimated ledger vs provider usage/cost exports (`ai:billing reconcile`
  exists as a CLI) with an alert when the difference exceeds a tolerance, and settlement of stale
  `pending` / `unknown` rows from confirmed provider usage.
- Dashboards: spend by organisation, brand, route, model; pending and unknown counts; refusals by
  limit.

### 2.6 Required properties for every control
- Checked **before sending**, in the reservation transaction; never after the fact only.
- Fail closed: if a limit can't be read or the reservation can't be written, refuse.
- Counts pending reserves (in flight, interrupted) so concurrency and crashes can't overshoot.
- Each refusal is recorded with its reason; no silent skips.
- Never falls back to another provider or model to get around a limit.

## 3. Provider and endpoint coverage

| Provider / endpoint | Used by | Status |
|---|---|---|
| Anthropic Messages API (`api.anthropic.com/v1/messages`): structured output, web-search research, the assistant's tool loop | `ai/llm.ts` (`structured`, `research`, `anthropicMessage`) | **Accounted**: inside `execute()`; worst case includes the full output limit, images/PDFs, web searches, and (with server-side fallbacks) the routed model plus every fallback target it may hand over to, each at its own rates (`SERVER_FALLBACK_TARGETS`). A fallback-served attempt is priced per model from `usage.iterations`. If any model that may run can't be priced, or a model's fallback-target list isn't confirmed (Opus 5.5: sent without fallbacks under a cap; a request asking for them in any form is refused), the request has no worst case and is refused under a cap (fail-closed). |
| OpenAI Images: generations, edits (variations and precise edits) (`api.openai.com/v1/images/*`) | `ai/image.ts` | **Accounted**: inside `execute()`; reserve `AI_SPEND_CAP_IMAGE_RESERVE_USD` (default $1), an estimate, not a guaranteed maximum: the settled cost can exceed it. The executor never retries an image whose outcome is unknown, but a background creative job can be re-queued after a timeout (up to 3 attempts), so the same image may be requested and charged for again; each attempt is reserved and settled to the ledger. |
| Voyage embeddings (`api.voyageai.com/v1/embeddings`) | `ai/embeddings.ts` (only when `VOYAGE_API_KEY` is set) | **Not accounted. Blocked** whenever a cap is required (staging, paid commands, `AI_SPEND_CAP_REQUIRED=true`): boot refuses the key and the network guard blocks the host. **Gap**: in production without required-cap mode it is neither; see "Open items". |
| Any provider API URL supplied by a user (website analysis, `web.ts`) | `server/web.ts` | **Blocked**: `api.*` hosts of Anthropic, OpenAI and Voyage are refused as web pages. |
| `npm run ai:check-anthropic` | operator | One request through `llm.ts` → `execute()`; network guard allows exactly one, with `x-api-key`. |
| `npm run test:live` | operator | All provider calls through the app's own paths; guard installed before any test file. |
| Demo / mock mode | all routes | No network; recorded with provider `mock`, never counted as spend. |

Enforcement that keeps this true:
- `paid-run-guard.test.ts` fails if any file other than the adapters references a provider client,
  endpoint or `messages.create(`, and checks every Anthropic call in `llm.ts` sits in an `execute()`.
- The provider test suites run with the network guard installed: a provider request without a
  pending ledger row fails them.
- Staging and paid commands install the network guard at runtime.

### Open items
1. **Voyage in production**: route it through `execute()` as an `embedding` route kind with a
   per-token price and reserve, or make it refuse unless accounted. Until then production should
   not set `VOYAGE_API_KEY` (the local embedder is the default).
2. **Network guard in production**: today installed in staging and paid commands; turn it on in
   production once the guard has run in staging for a release.

## 4. Requirements for integrating a new AI provider or endpoint

A new provider, model family or endpoint is merged only when:
1. Every request goes through `execute()` with a route (`ai/routes.ts`) and kind, so it gets the
   pending reservation, cap/limit checks, circuit breaker, retries and settlement.
2. It supplies a **worst-case cost** per attempt that is never below the real cost (inputs, maximum
   output, tools, media, fallbacks), and a `price()`/`units()` from reported usage, with dated list
   prices in `ai/catalog.ts` or `ai_prices`.
3. The SDK's own retries are off (`maxRetries: 0` or equivalent): the executor sees every attempt.
4. It classifies errors (`ai/errors.ts`): which outcomes mean "sent, no response" (may be billed),
   which are retryable, and whether unknown outcomes may be retried.
5. Its host is added to the network guard's capped hosts and to `web.ts`'s provider block list,
   and the static test's allow-list names its adapter file.
6. Keys are server-only (added to `check:secrets`'s list), never logged, and configured per
   environment with provider-side spending limits.
7. There is a mock-mode path (no network) and a `test:live` case that runs only under the paid-run
   guard.
8. It never falls back to a different provider automatically.
9. Usage export reconciliation (`ai/reconcile-export.ts`) supports its console export.
