# Phase 4: Production Readiness & Platform Foundation, implementation plan

**Status:** detailed plan for review. The overall direction is approved (8 Nov 2026).
**Implementation starts only after this plan is approved.**

**Baseline:** `main` at `f47e245` (Phase 3 merged). The detailed reference designs are documents
1–9 in this folder. This plan is the one to approve.

**Ground rules for every PR in this phase**
- **Existing functionality and architecture stay intact.** Every PR runs the full current
  suites:
  - 151 unit and integration tests;
  - the strategist, creative-studio and QA browser suites;
  - the tenant-isolation tests;
  - the migration upgrade tests.
- **One feature branch and one PR per major deliverable** (§2). **Nothing is merged without your
  explicit approval.**
- **Demo vs real.** Mock (demo-mode) results are never reported as real-provider validation.
  Every PR description has separate *Demo-mode evidence* and *Real-provider evidence* sections.
  Real-provider items stay **pending** until they've run with real credentials.
- **Secrets:** configured only as deployment secrets. Never in GitHub, chat, logs or
  screenshots. CI's `check:secrets` guards client bundles.

## 1. Order of work (by dependency)

```
Stage 1   WS6 Infrastructure baseline (PR 4.0)
            │  production Postgres, staging, CI/CD, migration job, monitoring, backups
            ▼
Stage 2   ┌─ WS1 Real AI providers (PR 4.1) ───────────────┐
(parallel)├─ WS2 R2 storage & CDN (PR 4.2) ────────────────┤
          └─ WS3a Platform readiness (PR 4.3) ──► app-review submissions start (your accounts)
            ▼                                   │
Stage 3   ┌─ WS3b Instagram + Facebook publishing (PR 4.4)   needs 4.2 (public JPEG/CDN) + 4.3
(parallel)└─ WS4a Credits, shadow mode (PR 4.5)              needs 4.1 (usage events)
            ▼
Stage 4   ┌─ WS4b Credits enforcement, top-ups (PR 4.6)      after one shadow billing period
(parallel)├─ WS3c LinkedIn organisations (PR 4.7)            after LinkedIn approval
          └─ WS3d YouTube (PR 4.8)                           after Google approvals; needs 4.2 video
            ▼
Stage 5   WS5 Security & scalability review (PR 4.9)        load test, review, RLS pilot, DR drill
```

**Why this order:**
- **WS6 first:** every later PR needs staging, production Postgres, the migration job and
  monitoring.
- **WS3a early:** platform reviews take weeks and need public legal pages and callbacks before
  anything can be submitted.
- **Instagram publishing after R2:** Meta must fetch JPEG media from a public URL.
- **Credits after the provider layer:** credits are computed from its usage events.
- **Enforcement only after a shadow period:** it proves the numbers first.
- **LinkedIn and YouTube** wait for their platform approvals.

## 2. Pull requests and feature branches

| PR | Branch | Workstream | Stage |
|---|---|---|---|
| 4.0 | `feature/p4-infra-baseline` | WS6 (+ WS5 job reliability, monitoring and backups) | 1 |
| 4.1 | `feature/p4-ai-providers` | WS1 | 2 |
| 4.2 | `feature/p4-storage-r2` | WS2 | 2 |
| 4.3 | `feature/p4-platform-readiness` | WS3a | 2 |
| 4.4 | `feature/p4-meta-publishing` | WS3b | 3 |
| 4.5 | `feature/p4-credits-shadow` | WS4a | 3 |
| 4.6 | `feature/p4-credits-enforce` | WS4b | 4 |
| 4.7 | `feature/p4-linkedin` | WS3c | 4 |
| 4.8 | `feature/p4-youtube` | WS3d | 4 |
| 4.9 | `feature/p4-security-scale` | WS5 | 5 |

Each branch starts from the latest `main` after the PRs it depends on have been merged.

---

## WS1. Real AI provider integration (PR 4.1)

**Goal:**
- OpenAI image generation;
- Anthropic brand intelligence, marketing strategy and AI visual review;
- provider fallback, error handling and usage tracking.

All of it is validated with real credentials.

### Technical architecture

- **Provider registry**, building on `src/server/ai/{llm,image,mode}.ts`:
  - `TextProvider` (Anthropic), `ImageProvider` (OpenAI) and `mock`;
  - every adapter returns normalised usage plus the provider's request ID;
  - design in document 3.
- **Routes** name each job (`brand.profile`, `brand.qa`, `strategy.research`, `strategy.section`,
  `creative.concepts`, `copy.pack`, `creative.review`, `image.generate`, `assistant.chat`) and map
  it to provider, model, effort and parameters:
  - code defaults, with database overrides per plan or brand;
  - **the default model stays Claude Opus 5.5** for every text route; any change is a
    configuration decision you make after evals.
- **Image generation** (`gpt-image-1`): quality (low, medium or high) configurable per route, plan
  or brand. Sizes come from the format (existing `sizeFor`). The prompt is built from the
  brand-grounded art direction. Brand colours, fonts, logo and text are always composited by our
  renderer, never drawn by the model.
- **Visual review:** the rendered PNG plus the approved brand profile go to Claude
  (`creative.review` route). The reviewer and model are recorded (already in place).
- **Fallback and error handling:**
  - **Refusals:** Anthropic server-side fallbacks stay on (`fallbacks: "default"`).
  - **Retryable errors** (429, 5xx, connection): retried in the call, then at job level with
    backoff (existing engine).
  - **Non-retryable errors** (400, auth, content policy): fail fast with a clear message.
  - **Circuit breaker per provider:** after N consecutive service errors, new calls pause for a
    short window. Jobs wait instead of failing, and the UI shows "AI service degraded".
  - **No silent provider switching for images:** a second image provider is configuration only,
    off by default.
- **Usage tracking:** one `usage_events` row per provider attempt, with outcome success, failed,
  retried or unknown. Written in the same transaction as the `agent_runs` update. Costs come from
  the price table, which now covers every routable model and every image size and quality.
- **Prompt caching** of the stable brand-context prefix; cache-read tokens are recorded.
- **Provider status page (admin):**
  - mode (demo or production);
  - whether each key is configured (yes or no; never the value);
  - error rates and circuit state;
  - the last `test:live` report.

### Database changes

Migration `0008_ai_routes_usage`, additive, with an upgrade test:
- `ai_routes(key, kind, provider, model, params jsonb, scope_type, scope_id, active, updated_by,
  updated_at)`, unique on `(key, scope_type, scope_id)`;
- `usage_events(id, org_id, brand_id, user_id, task_id, run_id, route, provider, model, kind,
  units jsonb, usd_cost, outcome, provider_request_id, created_at)`, indexed on
  `(org_id, created_at)` and `(brand_id, created_at)`;
- `agent_runs.org_id`, backfilled from `brands`, for organisation-level queries.

### Dependencies

PR 4.0 (staging, Postgres, monitoring).

### External API requirements

- **Anthropic:** an API key with the organisation's rate-limit tier sized for the expected
  concurrency, and access to Claude Opus 5.5 and the web search tool.
- **OpenAI:** an API key; `gpt-image-1` access, which may need organisation verification;
  outbound HTTPS to `api.openai.com`.
- Both keys are **server secrets**: deployment secret store, staging and production keys kept
  separate.

### Estimated effort

**2.5–3 eng-weeks**, plus **0.5 week** for the validation run once keys exist.

### Testing

- **Unit and integration:**
  - route resolution and overrides;
  - price coverage: every routable model and image size has a price, enforced by a test;
  - usage events for success, failure, retry and unknown;
  - circuit breaker;
  - caching accounting;
  - demo mode never calls paid APIs (existing test, extended to every route).
- **Intercepted-provider tests** for every route: request shape, usage parsing, error mapping.
- **Live suite (`npm run test:live`, manual, real keys):**
  - image generation and renders in all 12 formats;
  - brand profile analysis;
  - a strategy section;
  - copy pack and vision review;
  - invalid keys;
  - output scanned for secrets.

  A provider without a key reports `not_run`.
- **Manual end-to-end runs M1–M9** and the image quality and brand-consistency evaluation
  (`CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`), with real-provider screenshots.
- **Cost reconciliation** against the Anthropic and OpenAI usage reports.

### Acceptance criteria

- All routes resolve; Opus 5.5 is the default; prices cover every routable model.
- Demo-mode guarantees hold.
- **Real validation:**
  - `test:live` passes for OpenAI images, Anthropic brand analysis, strategy, copy and vision
    review;
  - M1–M9 pass;
  - average quality score ≥ 3.5 on the rubric;
  - costs reconcile within 5%.
- If keys aren't available at review time, the PR can be accepted for its code with real
  validation **explicitly pending**, and it is completed in a follow-up evidence update.

### Risks and mitigation

| Risk | Mitigation |
|---|---|
| Image quality or brand fit below expectations | Rubric evaluation before launch; art-direction prompt tuning; brand-photo and type-led fallbacks already exist |
| Provider rate limits at launch | Request a higher Anthropic tier early; per-provider token buckets (WS5); jobs queue instead of failing |
| Cost overrun | Usage events feed credits (WS4); per-route effort and image quality; batch API for non-urgent work |
| `gpt-image-1` access or verification delay | Start OpenAI organisation verification now; the brand-photo and type-led sources work meanwhile |
| Model or API changes | Pinned model IDs in configuration; intercepted tests; live suite before each upgrade |

---

## WS2. Cloudflare R2 storage and CDN (PR 4.2)

**Goal:**
- secure image and video storage;
- CDN delivery;
- private access with signed URLs;
- multi-tenant isolation;
- provider-independent, so the files can move to AWS S3.

### Technical architecture

The full design is in document 4. In summary:
- **`StorageProvider` interface:** `put`, `get`, `head`, `remove`, `list`, `copy`, `presignGet`,
  `presignPut`, `publicUrl`. Adapters:
  - **S3-compatible** (AWS SDK v3; R2 is selected by endpoint; AWS S3 later is a configuration
    change);
  - **LocalDisk** (development and tests).
- **Two buckets:** `bp-private` (everything; never public) and `bp-delivery` (publish media and
  render cache; served through a CDN custom domain; unguessable keys; lifecycle expiry).
- **Tenant key layout:** `org/<orgId>/brand/<brandId>/{assets|creatives|renders|publish}/…`.
  Keys are built only server-side from authorised database IDs, and every read checks the prefix
  against the caller.
- **Uploads:**
  1. The app validates role, quota, type and size.
  2. It returns a **presigned PUT** to a `pending/` key.
  3. The client uploads directly to R2.
  4. On `complete`, the server `head`s the object and checks magic bytes, size and image decode,
     then moves the object to its final key.

  Multipart is used for video.
- **Downloads:** short-lived **presigned GET** (about 5 minutes) with `Content-Disposition`. Private
  previews use presigned GETs; delivery keys use the CDN.
- **Render cache:** keyed by a hash of the creative's content, format, slide and renderer version.
  An unchanged creative is never re-rendered.
- **Publish derivatives:** JPEG (sRGB) for Instagram, written to the delivery bucket at publish
  time.
- **Video storage:** originals, a poster frame and a metadata probe. Transcoding is not part of
  Phase 4.
- **Lifecycle:** pending files 24 h; renders 30 days; publish media 14 days after confirmation;
  exports 7 days. A nightly usage and reconciliation job.

### Database changes

Migration `0009_storage`:
- `uploads(id, org_id, brand_id, key, mime, max_bytes, status, expires_at, created_by,
  created_at)`;
- `storage_usage(org_id, brand_id, bytes, objects, measured_at)`.

Existing `path` columns hold the new keys after the migration job runs. The job copies files to
the new keys and updates the rows; it is resumable and idempotent. No column is dropped.

### Dependencies

PR 4.0 (staging, secrets, background workers for the migration and lifecycle jobs).

### External API requirements

- **Cloudflare:**
  - an account with R2 enabled;
  - two buckets;
  - an R2 API token scoped to those buckets (object read and write);
  - a delivery subdomain on your domain (for example `media.yourdomain`) attached to the
    delivery bucket;
  - lifecycle rules configured.
- **CI:** MinIO as a service container (S3-compatible, no external credentials).

### Estimated effort

**2.5–3 eng-weeks.**

### Testing

- **Adapter contract tests** against LocalDisk and **MinIO in CI**: put, get, head, list,
  presign, copy, remove.
- **Tenant isolation:** another organisation's key is refused even with a valid object ID;
  randomised cross-tenant attempts.
- **Uploads:** a wrong type, oversize file, mismatched magic bytes or expired pending upload is
  rejected or cleaned up.
- **Render cache:** an edit gives a new hash; an unchanged creative causes no render (counter).
- **Publish derivative:** the Instagram media is JPEG at the right size.
- **Migration job:** resumes after interruption; zero missing objects afterwards.
- **Live:** an R2 check in `test:live` when R2 credentials exist (`not_run` otherwise).
- **Browser:** upload, preview, download and ZIP on desktop and mobile, against MinIO on staging.

### Acceptance criteria

- All media goes through the adapter, with no local-disk dependency in production.
- Tenant prefix enforcement is tested.
- Unchanged creatives aren't re-rendered.
- Local files are migrated with a reconciliation report showing zero missing objects.
- The R2 live check passes with your credentials.

### Risks and mitigation

| Risk | Mitigation |
|---|---|
| Migration data loss | Copy-then-switch; local disk kept read-only for one release; reconciliation report before deleting anything |
| Signed URL leakage | Short lifetimes; delivery bucket holds only publishable media; private originals never public |
| CDN caching private data | Private bucket is never behind the CDN; `Cache-Control: private` on app-proxied responses |
| Vendor lock-in | One S3 code path; a move to AWS S3 is configuration plus an object copy |

---

## WS3. Social media integrations (PRs 4.3, 4.4, 4.7, 4.8)

**Order:** Instagram and Facebook first, LinkedIn and YouTube next. Covers OAuth, developer app
registration and API approval. The full platform details are in document 2. TikTok and X later
use the same provider interface.

### Technical architecture

- **Provider interface** (extends `src/server/social`):
  - `oauth` (authorise, exchange, refresh, revoke), `discover`, `publish` (with an idempotency key),
    `status` (reconciliation), `metrics`, `limits`;
  - **`mediaProfiles`** (formats, aspect ratios, sizes, codecs);
  - **capabilities derived** from what the provider implements, plus the approved permissions
    (configuration flags) and the scopes the account granted. This fixes defect D2.
- **Publish-attempt ledger:** one row per attempt with an idempotency key unique per post and
  account. Before retrying an uncertain attempt, the worker **reads the platform** to check
  whether the post went out, so there are never duplicates.
- **Token health:** expiry tracking, reconnect prompts and email before expiry; deauthorise
  callbacks mark accounts disconnected.
- **PR 4.3, platform readiness:**
  - public `/privacy`, `/terms` and `/data-deletion` pages, rendered from editable markdown with
    your legal text;
  - Meta **data-deletion callback** (`signed_request` verified with the app secret; returns a
    status URL and confirmation code) and **deauthorise callback**;
  - a self-serve account and brand deletion flow;
  - a reviewer demo workspace seed;
  - submission packs and screencast scripts;
  - **D1:** Instagram media as JPEG;
  - **D2:** honest capabilities.
- **PR 4.4, Instagram and Facebook:**
  - the publish ledger, reconciliation and token health;
  - **Instagram:** images, carousels, Reels and Stories (using uploaded video files), with the
    publishing limit read from `content_publishing_limit`;
  - **Facebook Pages:** photo, multi-photo and video;
  - Business Use Case rate-limit headers respected.
- **PR 4.7, LinkedIn:** organisation scopes and organisation-URN posting (image, multi-image,
  document), and organisation analytics. Behind `LINKEDIN_ORG_POSTING` until Community Management
  API approval. This fixes defect D3.
- **PR 4.8, YouTube:**
  - OAuth with the consent screen in production status;
  - channel discovery;
  - resumable upload of **user-provided videos and Shorts** (no video generation in Phase 4);
  - scheduled publish (`publishAt`) and analytics.

### Database changes

| Migration | PR | Changes |
|---|---|---|
| `0010_platform_readiness` | 4.3 | `data_deletion_requests(id, platform, external_user_id, confirmation_code UNIQUE, status, requested_at, completed_at, details jsonb)`; `social_accounts.deauthorized_at`, `revoked_at` |
| `0011_publish_ledger` | 4.4 | `publish_attempts(id, post_id, social_account_id, idempotency_key UNIQUE, attempt, status, request jsonb, response jsonb, external_id, error, started_at, finished_at)`; `social_accounts.health jsonb`, `last_checked_at`; `platform_settings(platform, key, value jsonb)` holding the approved-permission flags |
| — | 4.7, 4.8 | No new tables expected; organisation and channel identifiers go in the existing `social_accounts.meta` |

### Dependencies

- 4.3 needs 4.0.
- 4.4 needs 4.2 (public JPEG and video URLs) and 4.3.
- 4.7 needs 4.4 and **LinkedIn approval**.
- 4.8 needs 4.4, 4.2 (video storage) and **Google OAuth verification plus the YouTube API audit**.

### External API requirements (your accounts; start now)

| Platform | Requirements |
|---|---|
| Meta (Instagram and Facebook) | Meta developer app (Business type); business verification; Advanced Access for `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `business_management`; Tech Provider / Access Verification; privacy policy, terms and data-deletion URLs; app icon; test Instagram Business and Facebook Page accounts |
| LinkedIn | Developer app; verified company Page; **Community Management API** application (Development then Standard tier), likely as a dedicated app; scopes `w_organization_social`, `r_organization_social`, `rw_organization_admin`, `r_organization_admin` |
| Google (YouTube) | GCP project; YouTube Data API v3 and Analytics API; OAuth consent screen (production status); verified domain; **OAuth app verification** for sensitive scopes (`youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`); **YouTube API audit** (public uploads and quota); a test channel |

All details are marked *(verify)* in document 2 and must be re-checked when submitting.

### Estimated effort

| PR | Eng-weeks |
|---|---|
| 4.3 Platform readiness | 1.5–2 |
| 4.4 Instagram and Facebook publishing | 3–4 |
| 4.7 LinkedIn | 1.5–2 |
| 4.8 YouTube | 2 |
| **Total** | **8–10** |

Platform review waiting time runs in parallel.

### Testing

- **Readiness:**
  - `signed_request` verification (valid, tampered, expired);
  - the deletion job removes exactly that user's data;
  - a deauthorised account stops publishing;
  - legal pages reachable without login.
- **Publishing:**
  - intercepted Graph, LinkedIn and YouTube API tests for every media type;
  - **crash and retry tests:** kill the worker between the container and publish steps; no
    duplicates after recovery;
  - rate-limit header back-off;
  - capability matrix equals the implemented methods.
- **Live, manual:** publish to **test accounts** on each platform (image, carousel, Reel, Story,
  Page post, LinkedIn organisation post, YouTube Short), with screenshots of the live posts and
  insights. Reported under *Real-provider evidence*.
- **Browser:** connect, select accounts, schedule, publish and disconnect, on desktop and mobile.

### Acceptance criteria

- **4.3:**
  - pages live (with your legal text, or marked draft and **not submitted**);
  - deletion callback verified;
  - submission packs complete;
  - you can submit the Meta review.
- **4.4:** live publishes to test Instagram and Facebook accounts for every supported type; no
  duplicates under crash tests; capabilities honest.
- **4.7 and 4.8:** live organisation post and YouTube upload on test accounts after approval.

### Risks and mitigation

| Risk | Mitigation |
|---|---|
| App review rejection or delay | Submit early (after 4.3); screencasts show every permission; the privacy policy names each platform's data; plan for one resubmission |
| Platform API or version changes | Pinned API versions; a version-upgrade calendar; intercepted tests; limits read at runtime |
| Duplicate or missing posts | Idempotency keys, reconciliation reads, and the attempt ledger |
| Token expiry breaking schedules | Expiry tracking, reconnect emails, and pre-flight token checks before scheduled publishes |
| YouTube quota and private-only uploads before the audit | Request the audit early; Shorts and uploads stay "beta" until approved |

---

## WS4. Subscription and AI credit system (PRs 4.5, 4.6)

**Goal:**
- configurable plans and monthly AI credits;
- usage tracking and billing controls;
- per-organisation and per-brand limits;
- an admin usage dashboard;
- AI cost target about 15–20% of revenue, with **nothing hardcoded**.

### Technical architecture

The full design is in document 5. In summary:
- **Configuration tables:**
  - `plans`: Stripe price IDs, included credits, limits, features;
  - `credit_packs`;
  - `rate_cards`: provider prices → USD → credits; versioned with effective dates;
  - all editable in the admin panel, with an audit log.
- **The credit value is a configuration item** (default 1 credit = $0.01 of provider cost).
  Text, image and video are tracked separately and drawn from one balance.
- **Ledger:** append-only `credit_ledger` (grant, top-up, reserve, settle, release, refund,
  adjustment, expire), with idempotency keys.
- **Per AI call:**
  1. Estimate.
  2. **Atomic reservation**, checking the organisation balance and cap and the brand cap.
  3. Provider call.
  4. Settle the actual usage; release the remainder.
- **Caps:**
  - organisation monthly cap; per-brand monthly caps;
  - per-organisation **USD hard cap** (a platform safety net);
  - alerts at **70%, 90% and 100%** by email and in-app, once per period;
  - at 100%, AI work stops at the next step boundary.
- **Billing:**
  - monthly grant on Stripe `invoice.paid`;
  - top-up packs through Stripe Checkout (one-time), with optional auto top-up up to a cap;
  - plan upgrades and downgrades handled.
- **Failed and retried attempts:** true cost is always recorded. Whether customers are charged
  credits for them is a policy setting, **default "not charged"** (your decision to confirm).
- **Dashboards:**
  - **customer usage page:** by brand, kind and route; caps; top-ups;
  - **admin cost dashboard:** provider cost by provider, model, kind, organisation, brand and
    day; failed, retried and unknown; AI cost as a % of revenue per plan and organisation;
    reconciliation status; organisations above the target margin.
- **Rollout:**
  - **PR 4.5** runs credits in **shadow mode**: computed and shown, while today's run quota stays
    enforced.
  - **PR 4.6** switches enforcement on after one billing period of matching numbers.

### Database changes

| Migration | PR | Changes |
|---|---|---|
| `0012_credits` | 4.5 | `plans`, `credit_packs`, `rate_cards`, `credit_accounts`, `brand_credit_limits`, `credit_ledger` (`UNIQUE idempotency_key`), `usage_alerts` (`UNIQUE` on organisation, brand, period, threshold); `workspaces.plan_id` backfilled from `workspaces.plan`; seed rows **from today's plan values** |
| `0013_credits_enforce` | 4.6 | `credit_accounts.auto_topup`; the `workspaces.plan` text column is kept until a later cleanup PR |

`src/lib/plans.ts` is removed in 4.6.

### Dependencies

- 4.5 needs 4.1 (usage events) and 4.0 (email).
- 4.6 needs 4.5 plus one shadow billing period.

### External API requirements

- **Stripe:** product and price IDs for plans and top-up packs (test mode first); webhook endpoint
  secret; Customer Portal configuration.
- Email provider (from 4.0) for alerts.
- Anthropic and OpenAI usage and cost reporting for reconciliation (admin API access where
  available).

### Estimated effort

| PR | Eng-weeks |
|---|---|
| 4.5 Credits, shadow mode | 2.5–3 |
| 4.6 Credits, enforcement and top-ups | 1.5–2 |
| **Total** | **4–5** |

### Testing

- **Ledger:**
  - arithmetic;
  - **50 concurrent reservations against the last credits never overdraw**;
  - idempotent Stripe webhooks: a replayed event grants once;
  - expiry ordering.
- **Caps:** organisation, brand and USD caps stop calls **before** the provider is called. A test
  asserts no provider request was made.
- **Alerts:** each threshold sent exactly once per period per organisation and brand.
- **Backfill:** `usage_events` and ledger totals equal `agent_runs` costs.
- **Configuration:** plan or rate-card changes take effect from their effective date; history is
  unchanged.
- **Browser:**
  - usage page;
  - admin dashboard;
  - top-up purchase in **Stripe test mode**;
  - cap reached → clear message and top-up link;
  - desktop and mobile.

### Acceptance criteria

- **Shadow period:** credits computed for 100% of AI calls; the dashboard matches ledger totals;
  provider reconciliation within 5%.
- **Enforcement:**
  - caps stop calls before the provider;
  - alerts sent once;
  - top-ups work in Stripe test mode;
  - `PLANS` and `aiRunsPerMonth` removed;
  - every existing paid plan has equivalent or better limits after migration.

### Risks and mitigation

| Risk | Mitigation |
|---|---|
| Wrong rate card leads to under- or over-charging | Shadow mode first; USD hard cap; versioned rate cards; daily reconciliation alerts |
| Concurrency overdraft | Atomic reservation in one statement; concurrency tests |
| Disruption for existing customers | Seeds mirror today's limits; enforcement only after shadow mode; clear in-app notices |
| Stripe webhook loss | Idempotent handlers; nightly Stripe reconciliation job |

---

## WS5. Production security and scalability (PR 4.0 parts, plus PR 4.9)

**Scope:**
- multi-tenant security review;
- background job reliability;
- API rate limiting;
- monitoring and logging;
- backup and disaster recovery;
- scaling to thousands of organisations.

Details are in document 9.

### Technical architecture

- **Tenant security:**
  - application scoping (existing, tested);
  - storage-prefix enforcement (WS2);
  - **Postgres Row-Level Security pilot** on the 3 hottest tenant tables, keyed on a
    per-transaction `app.org_id`, behind a flag;
  - randomised cross-tenant tests in CI;
  - an OWASP ASVS L2 review covering:
    - authentication and sessions, CSRF, uploads;
    - SSRF in URL fetchers (competitor research, asset import);
    - webhooks, headers and CSP;
    - dependency audit and the secrets inventory.
- **Background jobs** (in PR 4.0):
  - **dedicated worker processes** per job class (AI, render, publish, metrics) on the existing
    engine;
  - `FOR UPDATE SKIP LOCKED` batch claims;
  - per-organisation fair scheduling;
  - dead-job and stuck-job alerts;
  - graceful shutdown (stop claiming, finish or release, then exit).
- **Rate limiting:**
  - per-user and per-organisation limits stay in Postgres (they're transactional);
  - **hot counters** (request flood, per-provider token buckets, per-platform budgets) move to
    **Redis**;
  - Cloudflare WAF and rate rules at the edge;
  - the proxy trusts `X-Forwarded-For` only from Cloudflare.
- **Monitoring and logging** (in PR 4.0):
  - Sentry (server and client);
  - OpenTelemetry traces with `org_id` and `brand_id` span attributes;
  - structured JSON logs with request and job IDs and **no secrets or tokens** (redaction tests);
  - SLO dashboards.
- **Backup and disaster recovery** (set up in PR 4.0, drilled in PR 4.9):
  - Postgres PITR with daily snapshots, retained 30 days;
  - R2 object versioning or replication for the private bucket;
  - a documented restore procedure;
  - **targets: RPO ≤ 15 minutes, RTO ≤ 4 hours**;
  - a quarterly restore drill.
- **Scalability:**
  - indexes (`campaigns.brand_id`, `competitors.brand_id`);
  - `org_id` on hot tables;
  - monthly partitioning plan for append-only tables (`usage_events`, `credit_ledger`,
    `agent_runs`, metrics), implemented when volumes require it, with retention policies;
  - a k6 load test at the document 9 targets.

### Database changes

| Migration | PR | Changes |
|---|---|---|
| `0007_ops_indexes` | 4.0 | `campaigns_brand_idx`, `competitors_brand_idx`, plus a job-claim index if missing |
| `0014_rls_pilot` | 4.9 | RLS policies on 3 tenant tables, enabled per environment by a setting; full rollout is a later decision |

### Dependencies

Monitoring, workers and backups land in 4.0. The review and load test (4.9) run after 4.1–4.6,
so they test the real system.

### External requirements

- Sentry project;
- OpenTelemetry backend (for example Grafana Cloud or Honeycomb);
- Redis (managed);
- Cloudflare WAF;
- optional external pen-test vendor.

### Estimated effort

**3–4 eng-weeks** for PR 4.9, plus the security and reliability parts of 4.0 (counted in WS6).

### Testing

- Randomised cross-tenant suite.
- Log redaction tests.
- Worker kill-and-restart tests: no lost or duplicated jobs.
- Rate-limit tests at the edge and in the app.
- k6 scenarios, with document 9 §9.5 targets:
  - p95 page time < 500 ms at 500 concurrent users;
  - 2,000 posts due in one minute published within 3 minutes with zero duplicates;
  - AI queue p95 wait < 60 s;
  - zero overdraft under concurrency.
- Restore drill from backup into a fresh environment, timed.

### Acceptance criteria

- No open critical or high findings.
- Load targets met, or remediation planned and approved.
- Restore drill within RTO, with data within RPO.
- RLS pilot results documented, with a recommendation.

### Risks and mitigation

| Risk | Mitigation |
|---|---|
| RLS breaks queries | Pilot behind a flag on 3 tables; full suites with RLS on in CI before any rollout |
| Load-test environment differs from production | Staging is sized like production for the test window |
| Alert fatigue | SLO-based alerts only; severity routing |

---

## WS6. Deployment and infrastructure (PR 4.0)

**Scope:** production environment configuration, CI/CD, database migrations, monitoring and
alerting, and deployment documentation.

### Technical architecture

- **Containerisation:** a multi-stage Dockerfile (Node 22; `npm ci`, then build, then a slim
  runtime image) with **one image and several roles**:
  - `web` (Next.js server);
  - `worker` with a job class flag (`ai`, `render`, `publish`, `metrics`);
  - `migrate` (one-shot).
- **Hosting:** container-based and always-on, since serverless isn't supported (persistent
  workers). There are two practical routes; **your choice**:
  - **A, managed container platform** (Render, Fly.io or Railway): fastest to start.
  - **B, AWS ECS Fargate or Google Cloud Run** (always-on CPU): more control, a natural next step at
    scale.

  The image and configuration work on both.
- **Data services:**
  - managed **Postgres 15+ with pgvector**, PITR and a pooler (Neon, Supabase or AWS RDS; **your
    choice**);
  - managed **Redis**;
  - **Cloudflare** for DNS, CDN, WAF and R2.
- **Environments:** `development` (PGlite and local disk, unchanged), `staging` and `production`.
  Separate secrets, databases, buckets and provider keys. Staging uses demo mode or real keys
  with lower limits.
- **Configuration:**
  - a typed configuration module validates every environment variable at boot and **refuses to
    start** production with missing or unsafe values (for example `AI_PROVIDER=mock`, a short
    `APP_SECRET`, or PGlite);
  - `.env.example` documents everything;
  - secrets live only in the platform's secret store.
- **Database migrations:**
  - moved **out of app start-up** into the one-shot `migrate` job, run **before** each deploy;
  - guarded by a **Postgres advisory lock**, so concurrent runs can't race;
  - backup snapshot first;
  - all migrations additive (expand and contract: drop only in a later release after code stops
    using a column);
  - each with an upgrade test.
- **CI/CD** (GitHub Actions):
  - **CI (existing, extended):** typecheck, lint, unit and integration tests, build,
    `check:secrets`, **MinIO and Postgres service containers**, the migration upgrade tests, and
    the Playwright smoke suite.
  - **CD:**
    1. On merge to `main`: build and push the image (tagged with the commit SHA) → run `migrate`
       on staging → deploy to staging → smoke tests.
    2. **Production promotion is manual** (a GitHub Environment with required reviewer approval):
       `migrate`, then a rolling deploy, then smoke tests.
    3. Rollback = redeploy the previous image tag. Migrations are additive, so the previous code
       still works.
- **Monitoring and alerting:**
  - uptime checks (web, worker heartbeat, cron);
  - Sentry alerts;
  - queue depth and age, publish failure rate and AI error rate;
  - credit-reconciliation drift;
  - backup success;
  - alerts routed to email or Slack (your choice).
- **Documentation:** rewrite `docs/DEPLOYMENT.md`:
  - environments, the secrets inventory and the first-deploy runbook;
  - migrations, rollback, scaling workers and restore;
  - incident response and on-call basics.

### Database changes

- `0007_ops_indexes` (above).
- No schema changes for deployment itself. Migrations change *how* they run, not their content.

### Dependencies

None. This is the first PR.

### External requirements (your choices and accounts)

- Hosting platform (route A or B).
- Managed Postgres with pgvector and Redis.
- A domain on Cloudflare.
- Sentry and an OpenTelemetry backend.
- An email provider.
- A GitHub Environment with production reviewers.

### Estimated effort

**3–3.5 eng-weeks**, including the 4.0 parts of WS5 (workers, monitoring, backups).

### Testing

- Image builds in CI.
- `migrate` job: idempotent, lock-protected (two concurrent runs, one waits), upgrade tests.
- Boot-time configuration validation refuses unsafe production configurations (unit tests).
- Staging deploy with smoke tests (login, studio render, strategist read, job round trip).
- Rollback rehearsal on staging.
- Worker graceful shutdown under load.

### Acceptance criteria

- Staging is deployed automatically from `main`.
- Production promotion requires approval.
- Migrations run only in the `migrate` job, under a lock.
- An injected error appears in Sentry with its trace.
- Alerts fire on queue age and a stopped worker.
- The backup and restore procedure is documented and rehearsed once on staging.
- **All existing suites pass unchanged.**

### Risks and mitigation

| Risk | Mitigation |
|---|---|
| Migration race or failure during deploy | Advisory lock; backup first; additive-only; previous image stays deployable |
| Configuration drift between staging and production | One typed configuration schema; boot-time validation; documented inventory |
| Hosting choice delays the start | The Dockerfile and CI work proceed independently; the platform adapter is a small part |

---

## 3. Migration summary

| # | Name | PR | Type |
|---|---|---|---|
| 0007 | `ops_indexes` | 4.0 | Indexes |
| 0008 | `ai_routes_usage` | 4.1 | New tables, plus `agent_runs.org_id` (backfilled) |
| 0009 | `storage` | 4.2 | New tables; data moved by a job, not SQL |
| 0010 | `platform_readiness` | 4.3 | New table, plus columns on `social_accounts` |
| 0011 | `publish_ledger` | 4.4 | New tables, plus columns |
| 0012 | `credits` | 4.5 | New tables, plus `workspaces.plan_id` (backfilled), seed rows |
| 0013 | `credits_enforce` | 4.6 | Columns |
| 0014 | `rls_pilot` | 4.9 | Policies, enabled by setting |

All are additive, with backfills where needed. Each has an upgrade test from the previous
migration using legacy rows. They run in the locked `migrate` job.

**Migration numbers are assigned at merge time.** If PRs merge in a different order, they're
renumbered before merge; Drizzle orders them by journal index.

## 4. Effort and timeline

| Workstream | PRs | Eng-weeks |
|---|---|---|
| WS6 Deployment and infrastructure (+ WS5 baseline) | 4.0 | 3–3.5 |
| WS1 Real AI providers | 4.1 | 2.5–3 (+0.5 validation) |
| WS2 R2 storage and CDN | 4.2 | 2.5–3 |
| WS3 Social integrations | 4.3, 4.4, 4.7, 4.8 | 8–10 |
| WS4 Credits | 4.5, 4.6 | 4–5 |
| WS5 Security and scalability review | 4.9 | 3–4 |
| **Total** | 10 PRs | **about 24–29 eng-weeks** |

**With 3 engineers following the stages in §1:**
- about **10–12 weeks** of development;
- LinkedIn and YouTube completion depends on platform approvals;
- the credit enforcement switch waits one billing period after PR 4.5.

External costs are in document 8.

## 5. Inputs needed from you

| Needed for | Item |
|---|---|
| 4.0 | Hosting route A or B (or approval of my recommendation); Postgres, Redis, Sentry, OpenTelemetry and email providers; alert channel; GitHub production reviewers |
| 4.1 | Anthropic and OpenAI keys for staging and production, as deployment secrets |
| 4.2 | Cloudflare account with R2, two buckets, scoped token, delivery subdomain |
| 4.3 | Legal text (privacy, terms, data deletion), or approval for clearly marked drafts; Meta, LinkedIn and Google developer accounts; business verification documents; test social accounts |
| 4.5 and 4.6 | Credit value, plan allowances and top-up packs (seeded from today's values until you set them); Stripe price IDs; **policy on charging credits for failed attempts** (proposed default: not charged) |

## 6. What approval of this plan means

- I start **PR 4.0** on `feature/p4-infra-baseline`, then the Stage 2 PRs as their inputs
  become available.
- Each PR comes to you with tests, demo-mode and real-provider evidence (labelled separately) and
  screenshots. **None is merged without your explicit approval.**
- Any change of scope or order is proposed to you before it's made.
