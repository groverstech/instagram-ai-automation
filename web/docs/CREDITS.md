# Plans and AI credits (PR 4.5: shadow mode)

The design is in `docs/plan/05-credits-billing.md`. This page covers what is built now and how to
operate it.

## What's built

| Part | Where | Status |
|---|---|---|
| Plans as configuration | `plans` table, `src/server/credits.ts` | Live: names, display prices, limits (brands, seats, social accounts, AI runs a month) and included credits. Seeded from the values formerly hardcoded in `src/lib/plans.ts`. |
| Credit settings | `credit_settings` (one row) | Credit value (default $0.01 of estimated provider cost), the failed-attempt policy (default: not charged), and the alert thresholds (default 70, 90 and 100%). |
| Credits used | Computed from `usage_events` (the usage ledger from PR 4.1) | Shown in Settings → AI credits to owners and admins with access to every brand: by kind, by brand and by AI job. |
| Organisation and brand caps | `credit_limits`; Settings → AI credits | Owners and admins set them. It's a spending control, so it needs a recent second factor, like billing. Audited as `credits.cap_change`. |
| Alerts | `usage_alerts`; `evaluateCreditAlerts` | Each threshold is alerted once per month and scope. Each alert goes to the Security log (`credits.alert`), the structured log, and an email to owners and admins (through the email hook; until a provider is chosen it's logged as not sent). |
| Enforcement | — | **Not on.** In shadow mode nothing is refused on credits. The plan's monthly AI-run limit (and the optional `AI_MONTHLY_COST_LIMIT_USD`) stays the enforced limit. Reaching 100% is logged as `credits.shadow_would_block`. |

How credits are calculated:

- Credits = estimated provider cost ÷ credit value.
- Successful attempts are charged.
- Failed and retried attempts are charged only if the policy is switched on.
- Demo (`mock`) calls and unpriced attempts are never charged.
- The organisation's cap is its own setting if one is set; otherwise it's the plan's included credits; otherwise there's no cap.

## Operating it: `npm run credits`

Run it with the server's database configuration. Every change is audited with the `--by` name.

```
npm run credits -- show
npm run credits -- plan growth --included-credits 1500 --by "Your name"
npm run credits -- plan agency --price 299 --seats 25 --ai-runs 20000 --by "Your name"
npm run credits -- settings --credit-value 0.01 --charge-failed false --thresholds 70,90,100 --by "Your name"
npm run credits -- shadow 2026-12      # per organisation: AI runs vs credits, and whether credits would have stopped it
```

`CREDITS_MODE` can be `shadow` (the default) or `off`. `off` stops alerts, but Settings still shows the numbers. The value `enforce` is refused until PR 4.6.

## Owner decisions (before enforcement in PR 4.6)

- Included credits per plan. They're unset, so no allowance is assumed. The margin model in `05-credits-billing.md` §5.7 gives `included = price × target share ÷ credit value`.
- The credit value.
- The failed-attempt policy.
- Top-up packs and their Stripe prices.

## Enforcement (PR 4.6): built, off by default

`CREDITS_MODE=enforce` turns it on. It stays **off** (shadow is the default) until you approve it after a shadow period: **decision D-17**.

| Part | Where |
|---|---|
| **Gate** in `openAttempt()`'s transaction, under the usage-ledger lock, so concurrent requests are checked one at a time and each sees the others' reservations | `ai/credit-gate.ts` |
| **Used** = charged credits this month + every open reservation (pending attempts at their worst case). **Cap** = the organisation's own cap, else the plan's included credits, plus this month's grants. A brand cap applies to that brand as well | `creditPositions` |
| **Reserve, settle, release:** the ledger's pending row holds the worst case; settlement replaces it with the real cost, or nothing for an uncharged failure | `spend-cap.ts` (unchanged) |
| **Refusal:** nothing is sent or charged. The attempt is recorded as `blocked` with `errorKind = credits`. The message says how many credits are left and points to Settings → AI credits | `AICreditLimitError` |
| **Shadow mode:** the same check logs `credits.shadow_would_refuse` and allows the request, so the shadow period shows exactly what enforcement would have refused | `creditGate` |
| **Fail closed in enforce mode:** if the balance can't be computed, the request isn't sent (`AIAccountingError`) | `creditGate` |
| **Grants:** top-ups and adjustments per month, idempotent per `reference` (an invoice or checkout id), audited as `config.credits_grant` | `credit_grants` (migration 0022, RLS pilot policy), `grantCredits`, `npm run credits -- grant` |
| **Reconciliation:** what Settings shows (charged + reserved) must equal what the gate enforces. It also lists stale reservations (pending for over an hour) and unpriced attempts; the exit code is 1 on a mismatch | `reconcileCredits`, `npm run credits -- reconcile [YYYY-MM]` |
| **Settings → AI credits** shows the mode ("Enforced"), credits left, open reservations and grants | `credits-card.tsx` |

**Cost when no cap applies (review L2):** the gate first checks whether any cap applies: the organisation's own cap, the plan's included credits, or a brand cap. That takes two small reads. Only when a cap exists does it read the usage sums. Both happen inside the same locked transaction, so correctness and concurrency are unchanged; most requests (no cap) do two reads instead of six. Tested by counting reads.

**Not attributable:** requests without an organisation (platform CLIs, connectivity checks) are allowed and logged as `credits.unattributed_request` in enforce mode. Every customer AI action runs through the agent orchestrator, which sets the organisation and brand.

**Tests:** `credit-enforcement.test.ts`, on Postgres 16 and on PGlite:
- the exact boundary, with charged and reserved credits both counting;
- the failed-attempt policy, demo calls and last month;
- grants, including idempotency and negative adjustments;
- brand caps and plan allowances;
- shadow and off modes, and unattributed requests;
- through the real request path with a stub provider:
  - a refused request is never sent;
  - reservation, then settlement and release;
  - a provider failure releases the reservation;
  - six parallel requests against room for two, so exactly two are sent;
- reconciliation.

## Still open (owner decisions or Stripe)

- **Activation:** `CREDITS_MODE=enforce` after a shadow period (D-17), plus the plans' included credits, the credit value and the failed-attempt policy.
- **Top-up packs as Stripe products:** the grant mechanism is ready. The checkout and webhook need your prices, and Stripe live configuration is owner-controlled.
- **Grants on `invoice.paid`:** not needed while allowances are per calendar month from the plan. Revisit if allowances should follow billing periods.
- **Pausing AI-dependent autonomous publishing at 100%:** the autonomy policy already requires a person whenever AI is stopped. A credit-based pause is a follow-up.
- **The platform admin cost dashboard:** `npm run ai:billing` and `npm run credits -- shadow | reconcile` cover operators today.

Plan keys stay fixed (`starter`, `growth`, `agency`) until Stripe prices move into configuration.
