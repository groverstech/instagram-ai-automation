# Production deployment

BrandPilot is one Next.js application (UI, API, server actions) plus background workers, shipped
as **one container image with three roles**. This document covers:
- the environment and configuration;
- the deployment procedure;
- operations: health, migrations, backups, monitoring;
- what must be in place before real customers use it.

Design decisions are recorded in [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md). The
security model is in [SECURITY.md](SECURITY.md).

> **Status (PR 4.0):** the container image, configuration validation, health checks, locked
> migrations and graceful workers are implemented and tested.
>
> **Not yet decided or provisioned:** the hosting platform, managed Postgres/Redis providers,
> object storage (Cloudflare R2 arrives in PR 4.2), the error-tracking and email providers, and a
> deploy pipeline. See [§10](#10-outstanding-production-prerequisites).

## 1. Environments

`DEPLOY_ENV` says what a deployment *is*. It's independent of `NODE_ENV`, because any local
`next start` also runs with `NODE_ENV=production`.

| `DEPLOY_ENV` | Use | Configuration errors |
|---|---|---|
| `development` (default) | Local development, PGlite, local disk | Logged as warnings |
| `test` | Automated tests | Logged as warnings |
| `demo` | Demos and E2E (demo AI mode allowed) | Logged as warnings |
| `staging` | Pre-production; production-like infrastructure | **Stop the process at boot** |
| `production` | Real customers | **Stop the process at boot** |

At start-up, the web, worker and migrate roles all validate the configuration
(`src/server/config.ts`). In staging and production, any error stops the process with a
`config.refused` log line that **names the variables, never their values**.

The process stops when:
- `APP_SECRET` is missing or shorter than 32 characters;
- `DATABASE_URL` is missing (PGlite isn't allowed);
- local-disk storage is used without the explicit single-instance opt-in;
- demo AI mode is set in production;
- there are no Anthropic credentials;
- `APP_URL` isn't https;
- a platform or Stripe credential is half-configured;
- `CRON_SECRET` is too short.

## 2. Runtime requirements

| Requirement | Detail |
|---|---|
| Container | `web/Dockerfile`: Node 22, runs as an unprivileged user, liveness `HEALTHCHECK` built in. Or run directly with Node 22 LTS: `npm ci && npm run build && npm start`. |
| Process model | Long-running processes (serverless isn't supported: workers and the in-process scheduler need persistent processes). |
| Instances | Web: one or more (rate limits and AI concurrency leases are shared through Postgres; the edge flood limiter in `middleware.ts` is per instance). Workers: one or more per queue. |
| Database | PostgreSQL 15+ with **pgvector**. The app runs `create extension if not exists vector`; grant that permission, or create the extension beforehand. |
| Storage | Production must not depend on one server's disk. Object storage (Cloudflare R2) arrives in PR 4.2. Until then, staging and production need `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true` **and** a persistent, backed-up volume, which limits you to a **single web instance** (or a shared volume). |
| HTTPS | Required. Terminate TLS at your load balancer or CDN. Session cookies are `Secure` in production; HSTS is sent on every response. |
| Proxy and client IP | Set `TRUSTED_PROXY_HOPS` to the number of proxies **you control** that append to `X-Forwarded-For` (default 1), or `CLIENT_IP_HEADER` to a header your edge sets and strips from incoming requests (e.g. `cf-connecting-ip` behind Cloudflare). Login, sign-up and flood limits key on this IP. |

## 3. Container image and roles

Build the image:
```bash
docker build -t brandpilot:$(git rev-parse --short HEAD) web
```
Pass `--build-arg BASE_IMAGE=<mirror>/node:22-bookworm-slim` to build from a registry mirror.

| Role | Command | Notes |
|---|---|---|
| Web | `docker run … brandpilot` (default `web`) | Listens on `$PORT` (3000). `GET /api/health/live` and `/api/health/ready`. |
| Worker | `docker run … brandpilot worker` | `WORKER_QUEUES=jobs,ai` (default), or `jobs` (publishing, metric syncs) or `ai` (strategist and creative-studio tasks), to scale them separately. Requires `DATABASE_URL`. Set `RUN_JOBS_IN_PROCESS=false` on web instances when workers run. |
| Migrate | `docker run … brandpilot migrate` | Applies pending migrations under a Postgres advisory lock, then exits (non-zero on failure). |

**The entrypoint `exec`s each process**, so it receives `SIGTERM` directly:
- **Web:** Next shuts down gracefully.
- **Worker:** stops claiming work, lets in-flight work finish (up to `WORKER_DRAIN_MS`, default
  120 s), then exits 0.
- **Anything a stopped worker leaves behind** is recovered by another worker after its heartbeat
  goes stale (about 2 minutes for AI tasks).
- **Interrupted publishes** are never re-sent automatically. The post is marked failed with a
  "check the account" message (see SECURITY.md).

## 4. Deploy procedure

1. **Back up** the database (or confirm the latest PITR point).
2. **Migrate:** run the `migrate` role with the new image. It's safe to run concurrently (advisory
   lock) and idempotent. It refuses unsafe configuration in staging and production.
3. **Deploy web**, rolling, with `MIGRATE_ON_START=false`. New instances join the load balancer
   once `/api/health/ready` returns 200.
4. **Deploy workers.** Old workers drain on `SIGTERM`.
5. **Smoke test:**
   - `/api/health/ready` returns 200;
   - sign in;
   - open the Creative Studio and the Strategist;
   - check worker logs for `worker.started`.

**Migrations are additive** (expand and contract). A release never drops a column or table the
previous release still uses, so **rollback = redeploy the previous image tag**. The database
doesn't need to be rolled back.

**`MIGRATE_ON_START`:**
- Default `true`, for backward compatibility: the app migrates at start-up, now under the same
  advisory lock, so concurrent starts are safe.
- In staging and production, set it to `false` and use step 2. Instances then never change the
  schema, and readiness reports pending migrations as not ready.

**Large tables:** indexes are created inside the migration transaction. That's fine at today's
sizes; for tables with millions of rows, create indexes `CONCURRENTLY` in a separate step first.

## 5. Health checks

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /api/health/live` | The process is up (no dependencies) | Liveness / restart decisions; the container `HEALTHCHECK` |
| `GET /api/health/ready` | 200 when the database is reachable, migrations are current, storage passes a write–read–delete round trip, and configuration has no errors; 503 otherwise, with per-check status | Load-balancer readiness; deploy gating |

Both are unauthenticated, return no configuration values or secrets, aren't counted by the flood
limiter, and are never cached. Responses carry `version` from `APP_VERSION` or `GIT_SHA`, if set.

## 6. Environment variables

**Required in staging and production** (boot refuses without them):

| Variable | Purpose |
|---|---|
| `DEPLOY_ENV` | `staging` or `production` (§1) |
| `APP_URL` | Public https URL, e.g. `https://app.example.com`. OAuth redirects, Stripe return URLs, signed media links. |
| `APP_SECRET` | 32+ random characters (`openssl rand -base64 48`). Encrypts OAuth tokens at rest, signs links, keys the audit-log IP hashes. Rotating it invalidates stored tokens (users reconnect accounts). |
| `DATABASE_URL` | Postgres connection string (`postgres://…`). |
| `ANTHROPIC_API_KEY` | Claude API key, for every AI feature. |

**Deployment and operations:**

| Variable | Default | Purpose |
|---|---|---|
| `MIGRATE_ON_START` | `true` | `false` = instances never migrate; use the migrate role (§4) |
| `DATABASE_POOL_MAX` | `10` | Connections per process. Size against your pooler or database limit: instances × processes × pool. |
| `RUN_JOBS_IN_PROCESS` | `true` | `false` on web instances when dedicated workers run |
| `WORKER_QUEUES` | `jobs,ai` | Which work a worker takes (§3) |
| `WORKER_INTERVAL_MS` / `WORKER_DRAIN_MS` | `15000` / `120000` | Worker poll interval / maximum drain time on shutdown |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies you control that append to `X-Forwarded-For` (0 = none) |
| `CLIENT_IP_HEADER` | — | Edge-set client-IP header, e.g. `cf-connecting-ip`; takes precedence |
| `STORAGE_DRIVER` | `local` | `local` now; `s3` (R2 or S3) from PR 4.2 |
| `STORAGE_DIR` | `./.data/files` | Local storage root |
| `ALLOW_LOCAL_STORAGE_IN_PRODUCTION` | — | `true` only for a single-instance pilot with a persistent, backed-up volume |
| `APP_VERSION` / `GIT_SHA` | — | Reported by the health endpoints |
| `EMAIL_PROVIDER` / `EMAIL_FROM` | `log` | Transactional email. Only `log` exists until a provider is chosen; it never claims delivery and is refused in staging and production. |
| `CRON_SECRET` | — | Protects `GET /api/cron/tick` (`Authorization: Bearer <secret>`), at least 32 characters. Missing or short means the endpoint refuses every call (503). Failed attempts are rate-limited per IP. |

**AI:**

| Variable | Purpose |
|---|---|
| `ANTHROPIC_MODEL` | Override the default `claude-opus-5-5` |
| `STRATEGIST_WEB_SEARCH` | `off` disables web research (findings are then labelled hypotheses) |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `AI_PRICE_WEB_SEARCH_PER_1K` | Override the AI cost estimates |
| `VOYAGE_API_KEY` | Semantic embeddings for brand memory (local hashing otherwise) |
| `IMAGE_PROVIDER`, `OPENAI_API_KEY` | AI images (`IMAGE_PROVIDER=none` disables them; brand-photo and type-led creatives still work) |
| `OPENAI_IMAGE_MODEL` | Image model (default `gpt-image-1`) |
| `IMAGE_PRICE_USD`, `IMAGE_PRICE_USD_1024X1024` / `_1024X1536` / `_1536X1024` | Price per image for cost reporting. Unset means images are counted but shown as unpriced, never guessed. |
| `CREATIVE_BRAND_CHECK` | `off` skips the Claude vision review (deterministic checks still run) |
| `AI_PROVIDER=mock` | **Demo mode.** Never in production: boot refuses it there. Elsewhere with `NODE_ENV=production` it needs `AI_ALLOW_MOCK_IN_PRODUCTION=true` (demos and E2E only). |

**Integrations:**

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY` | Billing (the webhook secret is required whenever the key is set) |
| `META_APP_ID`/`META_APP_SECRET`, `LINKEDIN_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`, `PINTEREST_CLIENT_ID`/`_SECRET`, `TIKTOK_CLIENT_KEY`/`_SECRET` | Social OAuth apps (each pair must be set together) |
| `META_GRAPH_VERSION`, `LINKEDIN_VERSION` | Pinned platform API versions |
| `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_SHA256` | Android TWA asset links (see `ANDROID.md`) |

**Before enabling AI images in production**, run the live provider suite once with the production
keys: `npm run test:live`. It makes real, paid calls (about one image and a few Claude calls) and
never runs in CI. It refuses demo mode and reports a provider without a key as `not_run`. See
`CREATIVE_STUDIO_REAL_AI_TEST_PLAN.md`.

## 7. Secrets handling

- **Where secrets live:** only in the platform's secret manager, never in the repository, the
  image or chat. `.env*` files are git-ignored and excluded from the Docker build context; the
  image contains no secrets.
- **Client bundles:**
  - no `NEXT_PUBLIC_` variables;
  - CI runs `npm run check:secrets` after every build, and it fails if client bundles read a
    server-only variable, contain a known secret value, or contain key-shaped strings.
- **Logs:** structured JSON. Secret-looking field names are redacted, and key-shaped values are
  masked. The configuration validator reports variable names only.
- **OAuth tokens:** AES-256-GCM encrypted at rest with `APP_SECRET`.
- **Separate secrets per environment** (staging never shares production keys). Rotate after
  personnel changes and after any test campaign that shared keys.

## 8. Network security (required)

The app fetches brand and competitor websites server-side (`src/server/web.ts`):
- http/https only, ports 80 and 443, no credentials in URLs, no internal hostnames;
- DNS resolved once, with every address checked to be public, and the **connection pinned to the
  validated IP** (no DNS rebinding);
- every redirect re-validated (at most 4 hops), an 8 s timeout, and a 400 KB cap.

Other outbound requests go only to fixed provider hosts. Two allowlists apply:
- font files only from `fonts.gstatic.com`;
- LinkedIn upload URLs (which receive a bearer token) only to LinkedIn's own HTTPS hosts.

**Also enforce at the network layer** (defence in depth):
- **Block egress** from the app to private ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`,
  `127/8`, `169.254/16`, `fc00::/7`, `fe80::/10`) and to cloud metadata endpoints:
  - on AWS, require IMDSv2 with hop limit 1;
  - on GCP, block `metadata.google.internal` for the app's service account.
- **Allow egress only to:**
  - `api.anthropic.com`, `api.openai.com`, `api.voyageai.com`, `api.stripe.com`;
  - `fonts.googleapis.com` and `fonts.gstatic.com`;
  - the social platform APIs;
  - public websites on ports 80 and 443.

## 9. Operations

### Rate limits

Limits are defined in `src/server/ratelimit.ts` (per user and per organisation, shared through
Postgres) and `src/middleware.ts` (per IP, per instance).

| Area | Limit |
|---|---|
| AI actions | 30/min and 300/hour per user; 90/min per organisation |
| Heavy AI (brand, asset, strategy, campaign, creative, competitor) | 6 per 10 min per user; 20 per 10 min per organisation |
| Concurrent AI tasks | 2 per user; per organisation 2 / 4 / 10 (Starter / Growth / Agency) |
| Uploads | 20 requests per 10 min per user, 60 per organisation; at most 20 files and 50 MB per request, 15 MB per file |
| Image rendering | 600/min per user |
| Sign-in / sign-up | 10 per 15 min per email and per IP (hashed keys) |
| Per-IP flood limit | 120 mutating requests/min, 600 API GETs/min (health checks excluded) |
| Monthly AI quota | By plan: 200 / 2,000 / 20,000 AI runs (replaced by credits in PRs 4.5–4.6) |

HTTP routes return **429** with `Retry-After`; server actions return `{ ok: false, status: 429 }`.
For large deployments, also put a CDN or WAF rate limit in front.

### Background jobs

| Setup | How jobs run |
|---|---|
| Single instance | In-process every 30 s (`RUN_JOBS_IN_PROCESS` default) |
| Several instances | `RUN_JOBS_IN_PROCESS=false` on web, plus worker deployments (§3); or call `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute |

**Durability and duplicate protection:**
- **AI tasks** (`ai_tasks`) are persistent: atomic claims, heartbeats, recovery within about
  2–3 minutes after a crash, idempotent steps, and retries with backoff for temporary provider
  errors.
- **Publishing:** the claim is atomic, so a post is published once even when "publish now" and the
  scheduler race. A publish interrupted mid-flight is **not** retried automatically; the post is
  flagged for a human to check the platform first.

### Logging, errors and monitoring

- **Logs:** one JSON object per line on stdout and stderr (`ts`, `level`, `event`, fields). Ship
  them to your log platform. Every response carries `X-Request-Id` (kept from the load balancer
  if well formed).
- **Errors:** unexpected errors go through `captureError` (`src/server/monitoring.ts`): an
  `error.captured` log line with a reference ID, which users see instead of internal messages.
  Plug in an error tracker with `addErrorReporter` once one is chosen.
- **Alerts to configure:**
  - `/api/health/ready` failing;
  - container restarts;
  - `"level":"error"` rate;
  - `config.refused`;
  - `db.migrate.failed`;
  - `jobs.publish_interrupted`;
  - `worker.stopped` with `drained: false`;
  - `ratelimit.*` spikes;
  - Anthropic and OpenAI spend.

### Backup and disaster recovery (requirements)

| Item | Requirement |
|---|---|
| Database | Managed Postgres with **point-in-time recovery**; daily snapshots kept 30 days; a backup before every migration |
| Files | Until R2 (PR 4.2): snapshot the `STORAGE_DIR` volume daily. With R2: object versioning or replication on the private bucket. |
| Targets | **RPO ≤ 15 minutes, RTO ≤ 4 hours** |
| Restore drill | Quarterly: restore the database and files into a fresh environment, run the migrate role, and check `/api/health/ready`, sign-in and a brand's data. Record the time taken. |
| Secrets | `APP_SECRET` must be backed up in the secret manager. Losing it means stored OAuth tokens can't be decrypted (users reconnect accounts). |

### Third-party configuration

- **Stripe:** register a webhook at `{APP_URL}/api/billing/webhook`.
- **OAuth apps:** register `{APP_URL}/api/oauth/{platform}/callback` with each platform.
- **Anthropic:** make the web search tool available to the API key's organisation, and set spend
  limits in the Anthropic Console.

## 10. Outstanding production prerequisites

| Prerequisite | Status | Owner |
|---|---|---|
| Hosting platform (container platform, or AWS ECS / Cloud Run) | **Decision pending** | You |
| Managed Postgres (pgvector, PITR, pooler) and Redis | **Decision pending** | You |
| Object storage: Cloudflare R2 account, buckets, token, delivery domain | Pending; adapter in PR 4.2 | You, then PR 4.2 |
| Error tracker (e.g. Sentry) and a log or trace backend | **Decision pending**; the hook is ready | You, then a follow-up |
| Email provider | **Decision pending**; the interface is ready | You, then a follow-up |
| Deploy pipeline (push image, migrate, rolling deploy, approval gate for production) | **Not built**: depends on the hosting choice. CI builds and smoke-tests the image but pushes and deploys nothing. | Follow-up once hosting is chosen |
| Anthropic and OpenAI production keys | Pending; real-provider validation stays **pending** until configured | You |
| Egress firewall and metadata protection | To configure on the platform | You / ops |
| Load test, penetration test, RLS rollout | Planned in PR 4.9 | — |

## 11. Go-live checklist

- [ ] `DEPLOY_ENV=production`; the boot log shows no `config.problem` errors.
- [ ] Migrate role ran; `/api/health/ready` returns 200 on every instance.
- [ ] Object storage configured (PR 4.2), or the single-instance local-storage opt-in with a
      backed-up volume.
- [ ] Database PITR and snapshot schedule confirmed; restore drill done once.
- [ ] Egress firewall blocks private ranges and metadata endpoints.
- [ ] `TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER` match the real proxy chain (check one login's audit
      entry is attributed correctly).
- [ ] Logs shipped; the alerts in §9 configured; Anthropic and Stripe spend alerts set.
- [ ] Real-provider validation run (`npm run test:live` plus the manual checks) with production
      keys.
- [ ] One live brand analysed, and one strategy generated, end to end with real keys.
