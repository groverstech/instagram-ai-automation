# 1. Production-readiness roadmap

## 1.1 Where BrandPilot stands (8 Nov 2026)

| Area | State |
|---|---|
| Brand intelligence, strategist, creative studio (PR #6, merged into `main` as `f47e245`) | Built and tested in demo mode; **real-provider validation pending** (no credentials yet) |
| Multi-tenant auth, roles, client (brand-scoped) users | Built; isolation tested in the browser |
| Persistent job engine (claim, heartbeat, recovery, retries) | Built; recovery tested |
| Cost ledger (per agent run, failed and retried attempts) | Built; tokens priced; images priced from configuration |
| Social OAuth and publishers | Code exists for Instagram, Facebook, LinkedIn and Pinterest; YouTube and TikTok are declared only. **Not validated against live platforms.** |
| Storage | Local disk only (`STORAGE_DIR`) |
| Database | PGlite by default; Postgres via `DATABASE_URL` |
| Billing | Stripe checkout and webhooks; **plans hardcoded in code** |

## 1.2 Defects and gaps found in this review (must fix before launch)

| # | Finding | Impact | Fix (work package) |
|---|---|---|---|
| D1 | Instagram publishing sends a **PNG** URL (`/api/public/media/<token>.png`). Meta's content publishing API accepts **JPEG** images only. | Real Instagram image publishes are expected to fail. | Serve the published media as JPEG (sRGB) from R2 or the CDN (P4-1, P4-3) |
| D2 | The capability matrix marks Instagram and Facebook **carousel and video publishing as "supported"**, but the publishers implement only single-image posts. | The UI can promise things the publisher can't do. | Make capabilities reflect the implementation; add carousel and Reels publishing (P4-3) |
| D3 | LinkedIn requests only `w_member_social` (post as a *person*). Company Page posting needs the Community Management API's organisation scopes. | Brands can't post to their LinkedIn Page. | Organisation scopes after Community Management API approval (P4-3, document 2) |
| D4 | No public **privacy policy**, **terms**, **data deletion instructions** or **Meta data-deletion callback**. | Blocks Meta App Review, Google OAuth verification and LinkedIn approval. | P4-0a (first work package) |
| D5 | Plans, prices and limits are **hardcoded** (`src/lib/plans.ts`). The AI quota counts *runs*, not cost. | Violates decision 4; can't control margins. | Configurable plans and the credit ledger (P4-2) |
| D6 | Creative images are **rendered on every request** (`private, max-age=60`); the publish URL renders again on each platform fetch. | CPU cost and latency grow with traffic. | Content-addressed render cache in R2 behind the CDN (P4-1) |
| D7 | Storage keys have no organisation segment (`brands/<id>/…`). | Harder per-tenant lifecycle, export and deletion. | Tenant-prefixed key layout (P4-1) |
| D8 | No transactional email (invites, alerts, approvals). | Usage alerts and approval notifications can't reach people. | Email provider (P4-0b) |
| D9 | No error tracking or tracing; logs only. | Slow incident response. | Sentry plus OpenTelemetry (P4-0b) |

## 1.3 Roadmap

The roadmap is ordered by dependency. Each line is a PR or a small group of PRs. Detail is in
document 7.

### Stage A: foundations (start immediately, in parallel with platform reviews)

- **P4-0a App-review prerequisites:** public pages (privacy, terms, data deletion), the Meta
  data-deletion and deauthorise callbacks, a verified domain, app icons and branding, and a
  reviewer test account with demo data. *Unblocks every platform submission.*
- **P4-0b Operations baseline:**
  - managed Postgres with pgvector and connection pooling;
  - separate worker processes;
  - Sentry, OpenTelemetry and structured logs;
  - transactional email;
  - backups and point-in-time restore;
  - an environment and secrets inventory;
  - a staging environment.
- **P4-0c Real-provider validation:** run `npm run test:live` and the PR #6 test plan once credentials
  are configured. *Blocks calling the creative side production-ready.*

### Stage B: platform services

- **P4-1 Storage and CDN (R2):** the adapter, signed URLs, tenant key layout, the render cache,
  JPEG publish derivatives, lifecycle jobs, and migration of the local files.
- **P4-2 Plans, credits and spend controls:** configurable plans, the credit ledger, reservations,
  hard caps, alerts, top-ups, and the admin cost dashboard.
- **P4-3 Publishing reliability, Instagram then Facebook:** the publish-attempt ledger, idempotency,
  reconciliation, token health, carousel and Reels, and correct capabilities. LinkedIn and YouTube
  follow as approvals land.

### Stage C: closed loop

- **P4-4 Approvals and collaboration:** multi-step approval, comments, an inbox, bulk actions,
  client sign-off.
- **P4-5 Analytics and attribution:** insights per platform, daily snapshots, performance by
  pillar, campaign and creative.
- **P4-6 Autonomy and policy engine:** Advisor, Assisted and Autonomous levels; the brand rules UI;
  emergency pause; audit.
- **P4-7 Optimisation loop and agents:** weekly performance review, change sets, competitor
  monitoring, scheduled agents.

### Stage D: launch hardening

- Load test at the target scale (document 9).
- Security review and penetration test.
- A data-protection review: data map, DPA, retention, subject-access and deletion flows.
- An incident runbook.
- A status page.
- Restore drill.

## 1.4 Launch checklist (exit criteria)

**Security**
- [ ] No secrets in the repository or client bundles (`check:secrets` in CI).
- [ ] Secrets in the platform's secret store, and rotated after testing.
- [ ] OAuth tokens encrypted at rest (AES-256-GCM, already in place); key rotation procedure documented.
- [ ] Penetration test findings fixed or accepted in writing.
- [ ] Rate limits, quotas and spend caps enforced server-side.

**Data**
- [ ] Postgres backups with point-in-time restore; restore drill passed.
- [ ] R2 versioning or replication for originals; lifecycle rules active.
- [ ] Tenant export and tenant deletion flows tested end to end.

**Platforms**
- [ ] Instagram and Facebook app approved for production permissions; LinkedIn and YouTube approved or clearly marked "coming soon".
- [ ] Live publish tests to test accounts on every enabled platform.

**AI**
- [ ] `test:live` report archived with production keys.
- [ ] Costs reconciled with the provider dashboards within 5%.
- [ ] Mock mode impossible in production (enforced; already tested).

**Operations**
- [ ] Error tracking, tracing, uptime checks and alerts routed to on-call.
- [ ] Worker autoscaling and dead-job alerting.
- [ ] A status page.

**Legal**
- [ ] Privacy policy, terms and DPA published.
- [ ] Platform terms reviewed (content ownership, data retention).

**Product**
- [ ] Human approval is the default for every brand; autonomy opt-in tested.
- [ ] Emergency pause tested.
