# Private beta: what only the owner can do

As of 25 Nov 2026, all of the first-release engineering is merged to `main` and green in CI. Every
item below needs an account, money, a legal statement or a third party: none can be done from the
repository. They're in the order they unblock each other. Recommended choices, prices and the
reasoning are in [PRIVATE_BETA_DECISIONS_REQUIRED.md](PRIVATE_BETA_DECISIONS_REQUIRED.md) (D-numbers).

## Start now (long lead times)

1. **Meta developer app** (D-20): create the app, start business verification, add the test
   Facebook Page and Instagram professional account. Submission comes later (step 11).
2. **Legal text from counsel** (D-19, D-24): privacy notice, terms, data deletion, DPA; platform
   terms review. The pages are built and marked draft until the text arrives
   (`LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL`).

## Staging

3. **Hosting and managed Postgres with point-in-time recovery** (D-4, D-10, D-12): one web and one
   worker instance from the CI-built image; a persistent volume for files (single-instance beta,
   D-9) or authorise R2 (PR 4.2).
4. **Database roles** (D-5): an owner role for migrations and an ordinary app role. After the first
   migration, run `deploy/app-role-grants.sql` (DEPLOYMENT §4).
5. **Email provider** (D-7): Postmark or Resend account, sending domain with SPF/DKIM, API key.
6. **AI keys with provider-side budgets and no auto-reload** (D-13, D-15): a dedicated Anthropic key
   (and OpenAI only if images are approved). Staging limits are preset in
   `deploy/staging.env.example` (hard cap USD 25, tripwire USD 5 an hour); change them if you want.
7. **Fill in `deploy/staging.env.example`** in the platform's secret store, deploy, and run the
   staging rehearsal against it (DEPLOYMENT §4, "Staging rehearsal").
8. **Name the operators** (at most two) in DEPLOYMENT §9, and record the date of the staging
   emergency-stop drill there. The drill is the "emergency-stop" part of the rehearsal.
9. **Error tracking and uptime monitoring** (D-8): create a Sentry project and set `SENTRY_DSN`
   (the reporter is built in); an uptime check on `/api/health/ready` and `/api/health/jobs`
   (needs `CRON_SECRET`).

## Before the first invitation

10. **Live AI validation** (D-21, A1, A2): approve the paid run (≤ USD 7.01, hard-capped), then
    reconcile the estimates with the provider's export.
11. **Meta app review** (P4): submit with the pack in `docs/submissions/META.md` once the public
    domain and the final legal text exist; until approval, beta users are added as app testers.
    Then a live publish to the test accounts (P6).
12. **Accept or decide the remaining security settings** (D-26 password policy, D-27 session length,
    D-22 independent isolation review, D-11 egress firewall with the host). Defaults ship as they are
    today; the recommendations are in the decisions document.
13. **Invite the beta users**: `npm run beta:invite -- add <email> --by <you>` on staging/production.

## Kept off until you authorise them separately

- Credit enforcement (`CREDITS_MODE=enforce`, D-17): runs in shadow mode; turn on after one shadow
  period with the plan allowances set.
- Autonomous publishing (`AUTONOMOUS_PUBLISHING=on`, D-28): the open blockers are listed in
  `docs/AUTONOMY.md`.
- Paid plans through Stripe: optional for the beta (plans can be assigned by the operator).

## Before a public launch (not needed for the private beta)

Penetration test (D-23), status page (O5), scaling beyond one instance (O6, R2 storage).
