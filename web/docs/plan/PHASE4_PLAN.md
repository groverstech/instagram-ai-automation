# Phase 4: Production Readiness & Platform Foundation

**Status:** plan for approval. **No Phase 4 implementation starts until this plan is approved.**

**Context:** builds on Phase 3 (PR #6) and the planning set in this folder (documents 1–9).

**Rules for the whole phase:**
- Existing functionality is preserved. All current suites run on every PR: unit and integration
  tests, the strategist, creative and QA browser suites, and isolation.
- Mock (demo-mode) results are **never** reported as real-provider validation. Real-provider items
  are marked *pending* until they run with real credentials.
- Each major deliverable is a **separate PR**. No PR is merged without your approval.

## 1. Scope

| # | Priority (your order) | Phase 4 deliverable | PR |
|---|---|---|---|
| 1 | Real OpenAI image generation | Provider and route configuration; configurable image quality; image pricing via the rate card; the live suite run with real keys; quality and brand-consistency evaluation | **4.1 Real AI providers** |
| 2 | Real Anthropic analysis and visual review | Same PR: pricing for every routable model, prompt caching of the brand context, usage events, provider status page; live validation of brand analysis, strategy, copy and the vision review | **4.1** |
| 3 | Cloudflare R2 storage and CDN | S3-compatible adapter, tenant key layout, presigned upload and download, render cache, publish derivatives (JPEG), lifecycle, migration of local files | **4.3 Storage & CDN** |
| 4 | Platform registrations and API approval preparation | Public legal pages (with your text), Meta data-deletion and deauthorise callbacks, account deletion, reviewer demo workspace, submission packs; publishing fixes needed for review demos (D1 JPEG media, D2 honest capabilities, D3 LinkedIn organisation scopes behind a flag) | **4.2 App-review readiness** |
| 5 | Subscription, AI credits and usage | Configurable plans and rate cards, credit ledger with reservations, organisation and brand caps, 70/90/100% alerts, top-ups, customer usage page, admin cost dashboard, shadow mode, then enforcement | **4.4 Credits (shadow)**, **4.5 Credits (enforce + top-ups)** |
| 6 | Production security and scalability review | Postgres production setup and pooling, missing indexes, worker separation, error tracking and tracing, transactional email, RLS design and pilot, load test, security review report | **4.0 Ops baseline** (first) and **4.6 Security & scale review** (last) |

**Out of scope (later phases):** approvals and collaboration, analytics and attribution, autonomy
and the policy engine, the optimisation loop, the video pipeline, YouTube. They're described in
documents 6–7 and come after Phase 4.

## 2. Sequence and dependencies

```
4.0 Ops baseline ──┬──► 4.1 Real AI providers ──► (live validation when keys exist)
  (Postgres, pool, │
   email, Sentry,  ├──► 4.2 App-review readiness ──► platform submissions (your accounts)
   workers, idx)   │          │
                   ├──► 4.3 Storage & CDN ◄──┘ (JPEG publish media served from R2/CDN)
                   │
                   └──► 4.4 Credits (shadow) ──► 4.5 Credits (enforce, top-ups, dashboard)
                                                        │
                    all of the above ──────────────────►  4.6 Security & scale review
```

| PR | Depends on | Blocked by external input |
|---|---|---|
| 4.0 | — | Choice of Postgres host, Redis host and email provider |
| 4.1 | 4.0 | **Anthropic and OpenAI keys** for the validation run (the code can merge before; validation is reported as pending) |
| 4.2 | 4.0 | **Your legal text** (or approved "draft" placeholders); your Meta, LinkedIn and Google accounts for submission |
| 4.3 | 4.0 | **R2 account, buckets, API token, CDN domain** |
| 4.4 | 4.0, 4.1 (usage events) | Plan and credit values (configuration, can start with today's values) |
| 4.5 | 4.4 after one shadow period | Stripe price IDs for top-up packs |
| 4.6 | All | Pen-test vendor (optional) |

**Recommended order:** 4.0 → (4.1, 4.2 and 4.3 in parallel) → 4.4 → 4.5 → 4.6.

## 3. Work breakdown

### PR 4.0: Operations baseline

- **Database:** Postgres-only production configuration (PGlite stays for dev and tests); pooling
  settings; a statement timeout; a migration-runner job.
- **Indexes:** `campaigns.brand_id`, `competitors.brand_id` (finding S5).
- **Workers:** a worker entry point split by job class (AI, render, publish, metrics), sharing
  today's engine; `FOR UPDATE SKIP LOCKED` batch claims.
- **Observability:** Sentry (server and client), OpenTelemetry traces with `org_id` and `brand_id`
  span attributes, structured logs.
- **Email:** a transactional email adapter (provider by configuration) for invites and, later,
  alerts.
- **Health:** a health and readiness endpoint; a staging deployment profile.
- **Tests:** worker claim concurrency; migration upgrade test (0006 → 0007); email adapter
  contract with a fake.

### PR 4.1: Real AI providers (priorities 1 and 2)

- **Provider registry and routes** (document 3):
  - an `ai_routes` table with code defaults; routes for brand analysis, strategy, concepts, copy,
    review, image and assistant;
  - **the default model stays Claude Opus 5.5**; routes allow changes through configuration only.
- **Pricing:** prices for every model a route can select; image prices per size and quality.
- **Image quality** is configurable per route, plan or brand (low, medium, high).
- **Prompt caching** of the brand-context prefix; cache hits are recorded in usage.
- **`usage_events`:** one row per provider call (success, failed, retried, unknown).
- **Provider status page** (admin): mode (demo or production), key configured yes or no (never the
  value), last live-test report, error rates.
- **Validation (when keys exist):**
  - `npm run test:live` (image generation, renders in all 12 formats, vision review, copy pack,
    invalid keys);
  - the manual runs M1–M9 and the quality evaluation in `CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`;
  - cost reconciliation against the provider dashboards.

  Results are attached to the PR as a *separate* evidence section. Until then the PR states
  "real-provider validation pending".
- **Tests:** route resolution; price coverage (every routable model has a price); caching usage
  accounting; intercepted provider tests for every route; demo mode still never calls paid APIs.

### PR 4.2: App-review readiness (priority 4)

- **Public pages:** `/privacy`, `/terms`, `/data-deletion`. Content comes from your legal text,
  rendered from markdown files you can edit. Without the text, the pages are clearly marked
  **"Draft — pending legal review"** and must not be submitted to a platform.
- **Meta callbacks:** a **data-deletion callback** (`signed_request` verified with the app
  secret) that deletes or queues deletion of that Meta user's data and returns a status URL and
  confirmation code; a **deauthorise** callback that revokes the account tokens and marks the
  accounts disconnected.
- **Account and brand data deletion:** a self-serve flow plus the deletion job (database rows plus
  storage prefix after 4.3).
- **Reviewer demo workspace:** a seed script and a dedicated reviewer login on staging.
- **Publishing fixes reviewers will exercise:**
  - **D1:** Instagram publish media as JPEG (sRGB). It is served from the signed app route first,
    then from R2/CDN after 4.3.
  - **D2:** capabilities derived from what is implemented, so carousel and video aren't offered
    until built.
  - **D3:** LinkedIn organisation scopes and organisation-URN posting behind the config flag
    `LINKEDIN_ORG_POSTING`, which stays off until Community Management API approval.
- **Submission packs** (documents and screencast scripts) per document 2, §2.7.
- **Tests:**
  - `signed_request` verification (valid, tampered, expired);
  - the deletion job removes exactly that user's data;
  - a deauthorised account stops publishing;
  - the Instagram media is JPEG;
  - the capability matrix matches the implemented methods;
  - LinkedIn organisation posting with intercepted requests;
  - browser: legal pages reachable without login, footer links.

### PR 4.3: Storage & CDN (priority 3)

Implements document 4:
- the S3 adapter (R2 and S3 through one code path) and the LocalDisk adapter;
- two buckets (private and delivery), the tenant key layout and prefix enforcement;
- presigned PUT with verification on completion;
- presigned GET for downloads;
- the content-addressed render cache;
- publish derivatives;
- lifecycle rules (documented and set);
- reconciliation and a nightly usage job;
- a resumable migration job from local disk.

**Tests:**
- adapter contract tests against LocalDisk and **MinIO in CI** (S3-compatible, no external
  credentials);
- tenant prefix refusal;
- upload validation (type, size, magic bytes);
- render-cache hits (render counter);
- the migration job (resume after interruption);
- an R2 live check in `test:live` when R2 credentials exist (pending otherwise).

### PR 4.4: Credits, shadow mode (priority 5)

Implements document 5:
- tables (§4), seeded from the current plans with the same values;
- rate cards;
- the credit ledger with reserve, settle and release;
- organisation and brand caps (calculated, **not enforced** in this PR);
- alerts **calculated and logged** (not sent);
- the customer usage page;
- the admin cost dashboard (provider cost by provider, model, kind, organisation and brand;
  failed, retried and unknown).

The current run quota remains the enforced limit.

**Tests:**
- ledger arithmetic;
- concurrent reservations (no overdraft);
- idempotent grants;
- the backfill of `usage_events` from `agent_runs`;
- dashboard totals equal the ledger totals.

### PR 4.5: Credits, enforcement and top-ups (priority 5)

- Enforcement switched on: caps stop calls **before** the provider is called.
- 70/90/100% alerts sent by email and in-app, once per period.
- Stripe one-time credit packs and auto top-up with a cap.
- The monthly grant on `invoice.paid`; plan upgrades and downgrades.
- The USD hard cap per organisation.
- `PLANS` and `aiRunsPerMonth` removed.

**Tests:**
- a test asserting no provider request is made when over the cap;
- alert de-duplication;
- webhook replay (grants once);
- top-up flows with Stripe test mode;
- browser: the usage page and top-up purchase in Stripe test mode.

### PR 4.6: Security & scalability review (priority 6)

**Security review** against the OWASP ASVS L2 checklist:
- authentication and sessions; tenant isolation (including randomised cross-tenant tests); OAuth
  token handling; webhooks; uploads; SSRF in URL fetchers (competitor research, asset import);
  dependency audit; headers and CSP; secrets inventory.

**Scalability:**
- a load test (k6) at the targets in document 9 §9.5, against staging;
- a Postgres query-plan review of the tenant queries;
- an **RLS pilot** on the 3 hottest tenant tables behind a flag, with the full design document.

**Deliverables:** findings with severity and fixes (fixed in this PR or tracked), and the
load-test report. An external pen test is optional.

## 4. Database migrations

All additive, with backfills, and each with an **upgrade test** from the previous migration (the
same pattern as 0004–0006). No destructive change happens until the PR after the one that stops
using a column.

| Migration | PR | Changes |
|---|---|---|
| `0007_ops_indexes` | 4.0 | `CREATE INDEX campaigns_brand_idx`, `competitors_brand_idx`; job-claim support index on `jobs(status, run_at)` if missing |
| `0008_ai_routes_usage` | 4.1 | `ai_routes(key, kind, provider, model, params jsonb, scope_type, scope_id, active, updated_by, updated_at)`; `usage_events(…)` (document 5 §5.3) with indexes `(org_id, created_at)`, `(brand_id, created_at)`; `agent_runs.org_id` added and backfilled from brands |
| `0009_app_review` | 4.2 | `data_deletion_requests(id, platform, external_user_id, confirmation_code UNIQUE, status, requested_at, completed_at, details jsonb)`; `social_accounts.deauthorized_at`, `revoked_at` |
| `0010_storage` | 4.3 | `uploads(id, org_id, brand_id, key, mime, max_bytes, status, expires_at, created_by)`; `storage_usage(org_id, brand_id, bytes, objects, measured_at)`; `storage_key` columns where today's `path` is local-only; a backfill job (not SQL) moves the files |
| `0011_credits` | 4.4 | `plans`, `credit_packs`, `rate_cards`, `credit_accounts`, `brand_credit_limits`, `credit_ledger` (`UNIQUE idempotency_key`), `usage_alerts` (`UNIQUE org, brand, period, threshold`); `workspaces.plan_id` (backfilled from `workspaces.plan`); seed rows from the current `PLANS` values |
| `0012_credits_enforce` | 4.5 | `credit_accounts.auto_topup` settings; drop nothing yet. `workspaces.plan` (text) is dropped in a later PR. |

Migrations run with the existing Drizzle migrator. In production they run as a separate step
before deploy, with backups taken first (PR 4.0).

## 5. Testing strategy

| Layer | What | Where |
|---|---|---|
| Unit and integration (vitest, PGlite) | Every new module, plus the existing 151 tests | CI on every PR |
| Migration upgrade tests | Each new migration from the previous state, with legacy rows | CI |
| Contract tests | Storage adapter against MinIO; email adapter against a fake; provider adapters with intercepted requests | CI (MinIO as a service container) |
| Live provider tests (`npm run test:live`) | Real OpenAI, Anthropic and R2, plus invalid-key handling | **Manual, with real keys only.** Never in CI. Reported separately. Missing keys are `not_run`, never passed. |
| Browser E2E (Playwright) | Existing strategist, creative and QA suites, plus new flows: legal pages, deletion request, upload, usage page, admin cost dashboard, top-up (Stripe test mode) | Run per PR, with screenshots attached |
| Security | Cross-tenant randomised tests; webhook signature tests; upload validation; dependency audit | CI, plus the 4.6 review |
| Load | k6 scenarios from document 9 §9.5 | Staging, in 4.6 |

Evidence is labelled **Demo mode** or **Real provider**, and the PR template carries both sections.
A screenshot taken in demo mode is never used as real-provider evidence.

## 6. Acceptance criteria

| PR | Accepted when |
|---|---|
| 4.0 | Staging runs on Postgres with pooling; workers deploy separately; an injected error appears in Sentry with a trace; restore drill documented; all existing suites green |
| 4.1 | All routes resolve with Opus 5.5 by default; every routable model is priced; demo mode never calls paid APIs (test). **Real validation:** `test:live` passes for OpenAI images and Anthropic review and copy with real keys, M1–M9 pass, the quality bar is met (average ≥ 3.5, test plan §4), costs reconcile within 5%. Until keys exist, the PR is accepted with real validation explicitly **pending**. |
| 4.2 | Pages live (with legal text, or clearly marked draft and not submitted); deletion callback verified with a valid and a tampered `signed_request`; Instagram media is JPEG; capabilities honest; submission packs complete; **you can submit the Meta review** |
| 4.3 | All media through the adapter; tenant prefix enforced; unchanged creatives not re-rendered; local files migrated with zero missing objects; R2 live check passes once credentials exist |
| 4.4 | Shadow credits computed for every call; no overdraft under 50 concurrent reservations; dashboard totals equal the ledger |
| 4.5 | Caps stop calls before the provider (test); each alert sent exactly once; top-ups work in Stripe test mode; `PLANS` constant removed |
| 4.6 | No open critical or high findings; load-test targets met or remediation planned and approved; RLS pilot results documented |

## 7. Effort

| PR | Eng-weeks |
|---|---|
| 4.0 Ops baseline | 2 |
| 4.1 Real AI providers | 1.5–2, plus 0.5 for the validation run once keys exist |
| 4.2 App-review readiness | 1.5–2 |
| 4.3 Storage & CDN | 2.5–3 |
| 4.4 Credits (shadow) | 2–2.5 |
| 4.5 Credits (enforce, top-ups) | 1.5–2 |
| 4.6 Security & scale review | 2–3 |
| **Total** | **about 13.5–16.5 eng-weeks**, about 6–8 weeks with 2–3 engineers in parallel |

External costs are in document 8.

## 8. Inputs needed from you

1. **Anthropic and OpenAI API keys**, configured as server secrets in the deployment environment.
   They must never be pasted in chat or GitHub.
2. **Cloudflare:** an R2-enabled account, two buckets, a scoped API token, and a delivery
   subdomain on your domain.
3. **Legal text:** privacy policy, terms, data deletion. Or approval to ship clearly marked draft
   placeholders.
4. **Platform accounts:** Meta Business (with verification documents), a LinkedIn company Page
   admin, and a Google Cloud project owner.
5. **Hosting choices:** managed Postgres (with pgvector), Redis, an email provider and Sentry, or
   approval for my recommendation in PR 4.0.
6. **Commercial values:** credit value, plan allowances and top-up packs. All are configuration,
   and today's limits are used until you set them.
