# 5. Subscription and AI credit architecture

**Decision:**
- Credit-based AI consumption, with monthly credits per plan.
- Separate tracking for text, image and video.
- Organisation and brand limits, with configurable monthly hard caps.
- Alerts at 70%, 90% and 100%.
- Paid top-ups.
- An admin dashboard of actual provider costs.
- Failed requests and retries tracked accurately.
- AI cost target of about 15–20% of subscription revenue.
- **Nothing hardcoded.**

## 5.1 Today (to replace)

- `src/lib/plans.ts` hardcodes plan prices and limits (defect D5).
- `assertAiQuota` counts **runs** per month, not cost.
- Stripe Checkout and webhooks map two price IDs from env to plan names.
- The cost ledger (`agent_runs.usage`, `cost_usd`, unknown-usage counts) already exists. It is the
  data source the new system builds on.

## 5.2 Concepts

| Concept | Meaning |
|---|---|
| **Credit** | The unit customers see. **1 credit = a configured amount of provider cost** (default $0.01). It's the same for text, image and video, so one balance covers everything, while usage is still reported per kind. |
| **Rate card** | Configuration that turns provider usage into USD cost (provider prices) and USD into credits (credit value, plus an optional per-kind multiplier). Versioned with effective dates. |
| **Plan** | Configuration: price IDs, included monthly credits, limits (brands, seats, social accounts, storage, max image quality, video minutes, highest autonomy level allowed), and features. |
| **Credit pack** | A configured top-up product (credits, price ID, expiry). |
| **Credit account** | Per organisation. An optional **brand allocation** (hard cap per brand) and an optional per-user cap. |
| **Ledger** | Append-only entries; the balance is their sum. |

## 5.3 Data model (new tables)

```
plans(id, key, name, active, stripe_price_ids jsonb, included_credits, limits jsonb, features jsonb, version, effective_from)
credit_packs(id, key, credits, stripe_price_id, expires_after_days, active)
rate_cards(id, version, effective_from, credit_value_usd, providers jsonb)
      -- providers: { "anthropic:claude-opus-5-5": {input, output, cacheRead, cacheWrite, perSearch},
      --              "openai:gpt-image-1": {"1024x1024:high": usd, …}, "video:<provider>": {perSecond} }
credit_accounts(org_id PK, period_start, period_end, monthly_cap_credits, hard_cap_usd, auto_topup jsonb)
brand_credit_limits(brand_id PK, org_id, monthly_cap_credits)
credit_ledger(id, org_id, brand_id NULL, kind, credits, usd_cost NULL, ref_type, ref_id, idempotency_key UNIQUE, created_at)
      -- kind: grant | topup | reserve | settle | release | refund | adjustment | expire
usage_events(id, org_id, brand_id, user_id, task_id, run_id, route, provider, model,
             kind text|image|video|search|embedding, units jsonb, usd_cost, credits,
             outcome success|failed|retried|unknown, provider_request_id, created_at)
usage_alerts(org_id, brand_id NULL, period_start, threshold 70|90|100, sent_at)  -- unique → each alert sent once
```

- `agent_runs` stays as the execution record. **`usage_events`** is the billing record: one row
  per provider call, written in the same transaction as the run update.
- Monthly roll-ups (`usage_daily`) are materialised for the dashboard.

## 5.4 Flow for every AI call

1. **Estimate.** The route config holds a typical cost (for example, a copy pack is about N
   credits; an image is priced from size and quality on the rate card).
2. **Reserve, atomically.** In a single statement, check the organisation's period balance, the
   organisation cap and the brand cap, then insert a `reserve` entry. If a hard cap would be
   exceeded, refuse with a clear message and a link to top up. No provider call is made.
3. **Call the provider** through the provider layer (document 3).
4. **Settle.** Insert `settle` for the actual usage (from the provider's reported usage, through
   the rate card), and `release` for the unused reservation. Record a `usage_events` row with its
   outcome.
5. **Failures:**
   - provider-reported usage on a failed attempt is recorded at its true cost;
   - retries are separate events;
   - "no response" is recorded as `unknown`, with a cost estimate flagged as an estimate.

**Whether customers are charged credits for failed or retried attempts is a policy setting.**
The default is *not to charge*: the platform absorbs it, and it still shows in the admin cost
dashboard. True cost is always tracked either way.

## 5.5 Limits and alerts

- **Organisation monthly cap:** included credits plus top-ups, or a lower cap the owner sets. A
  hard stop at 100% unless auto top-up is enabled. Auto top-up has its own monthly maximum.
- **Brand caps:** the owner or an admin allocates a monthly cap per brand. The brand stops at its
  cap even if the organisation has credits left.
- **USD hard cap (platform safety):** a per-organisation ceiling on actual provider cost per month,
  independent of credits. It protects against rate-card errors.
- **Alerts at 70%, 90% and 100%** of the organisation and brand caps:
  - email to owners and admins, plus an in-app banner;
  - each alert is sent once per period (enforced by the unique key);
  - 100% also triggers an automatic pause of autonomous publishing that would need AI
    (document 6).
- **Agents and jobs** reserve before every step. A job that hits a cap stops at a step boundary
  with "paused: credit limit". It resumes after a top-up and is never half-written.

## 5.6 Top-ups and periods

- **Top-ups:**
  1. Stripe Checkout (one-time payment) for a credit pack.
  2. The webhook (`checkout.session.completed`, deduplicated by Stripe event ID) inserts a `topup`
     ledger entry.
  3. Top-up credits expire after the pack's configured period.
- **Monthly grant:** on `invoice.paid` for the subscription, insert a `grant` for the plan's
  included credits for the new period. Unused included credits expire at the period end by
  default (configurable rollover).
- **Spending order:** included credits first, then top-ups by earliest expiry.
- **Plan changes:**
  - **Upgrade:** grant the difference, pro rata (configurable).
  - **Downgrade:** applies at the next period.

## 5.7 Margin model: how to set credit allowances

For a plan priced at **P** per month, a target AI-cost share **s** (0.15–0.20), and a credit value
**c** (USD of provider cost per credit):

```
included_credits = (P × s) / c
```

These are illustrative figures only. **Prices are not set by this document**, and the provider
costs are estimates to be replaced with measured averages from `usage_events`.

| Example unit (Opus 5.5 at $4/$20 per MTok, list) | Rough provider cost | Credits at c = $0.01 |
|---|---|---|
| Copy pack (about 6k input incl. cached brand context, 2k output) | about $0.05–0.07 | about 5–7 |
| Brand check vision review (image plus context, short output) | about $0.03–0.06 | about 3–6 |
| Full strategy (7 agents, with web research) | about $1–3 | about 100–300 |
| `gpt-image-1` portrait image, high quality | check the OpenAI price sheet; historically about $0.25 | about 25 |

**Measuring and enforcing the target:**
- The admin dashboard computes **actual AI cost ÷ subscription revenue** per plan and per
  organisation, and flags organisations above the target.
- Rate cards and allowances are adjusted through configuration, versioned and taking effect at the
  next period.
- The levers in document 3 §3.3 (effort, caching, batch, image quality per plan) are the
  engineering ways to lower cost per credit.

## 5.8 Dashboards

**Customer (owner and admin):**
- credits used and remaining this period, by brand and by kind (text, image, video);
- the top routes ("what used my credits");
- alerts and caps settings; top-up purchase and history;
- an invoice link (Stripe portal).

**Platform admin (internal):**
- actual provider cost by provider, model, kind, route, organisation, brand and day;
- revenue per organisation (from Stripe), and AI cost as a % of revenue;
- failed, retried and unknown-usage counts and their cost;
- daily reconciliation status against the provider usage reports;
- organisations above target margin;
- rate-card and plan configuration editors, with an audit log of every change.

Internal admin access is a separate platform role. Workspace owners never see other
organisations.

## 5.9 Migration from today

1. Seed `plans` from the current `PLANS` constant (the same values, now configuration). Map the
   existing Stripe price IDs.
2. Backfill `usage_events` from `agent_runs` (cost is already recorded).
3. Run credits in **shadow mode** for one billing period: compute and show credits, but enforce
   only the old run quota. Compare the results.
4. Switch enforcement to credits; remove `PLANS` and `aiRunsPerMonth`.

## 5.10 Tests

- **Ledger:**
  - reserve, settle and release under concurrency: no overdraft with 50 parallel reservations
    against the last credits;
  - idempotent webhooks: a replayed Stripe event grants once.
- **Caps:** an organisation cap, a brand cap and a USD hard cap each stop a call *before* the
  provider is called. A test asserts no provider request was made.
- **Alerts:** each threshold sent exactly once per period, organisation and brand.
- **Failed, retried and unknown accounting:** matches the provider-reported usage in intercepted
  tests.
- **Configuration:** changing a plan or rate card applies from its effective date; old periods are
  unchanged.
