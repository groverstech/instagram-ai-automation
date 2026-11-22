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

## Deferred to PR 4.6, by design

These parts of document 5 need Stripe or enforcement. They are left out of shadow mode on purpose:

- the credit ledger (grants on `invoice.paid`, top-ups, reserve, settle and release on every call);
- credit packs and Stripe price IDs in the plans table;
- the USD hard cap per organisation;
- pausing AI-dependent autonomous publishing at 100%;
- the platform admin cost dashboard.

Plan keys stay fixed (`starter`, `growth`, `agency`) until Stripe prices move into configuration.
