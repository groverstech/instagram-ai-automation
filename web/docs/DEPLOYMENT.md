# Production deployment requirements

BrandPilot is a single Next.js app (UI, API and server actions) plus an optional background
worker. These are the requirements for running it safely with real customers.

## 1. Runtime

| Requirement | Detail |
|---|---|
| Node.js | 22 LTS. Build with `npm ci && npm run build`, run with `npm start`. |
| Process model | Long-running Node server. Serverless is not supported: uploads are stored on local disk and the in-process scheduler needs a persistent process. |
| Instances | One or more. The precise rate limits and AI concurrency leases live in Postgres, so they are shared. The edge flood limiter in `middleware.ts` is per instance. |
| Persistent disk | Required for `STORAGE_DIR` (uploads, generated images) until an object-storage adapter exists. With several instances, mount the same shared volume on each. Back it up. |
| HTTPS | Required. Terminate TLS at your load balancer or proxy. Session cookies are `Secure` in production. |
| Reverse proxy | Must set `X-Forwarded-For` to the real client IP and **overwrite** any client-supplied value. Login, sign-up and flood limits key on it. |

## 2. Database

- PostgreSQL 15+ with the **pgvector** extension available. The app runs `create extension if not exists vector`, so the database role needs permission for it, or create the extension beforehand.
- Set `DATABASE_URL`. Migrations in `drizzle/` run automatically at start-up and are additive.
- Embedded PGlite (no `DATABASE_URL`) is for development only.
- Back up the database daily and test restores.
- Optional housekeeping: rate-limit rows older than one day are pruned automatically. You can also run `delete from rate_limit_buckets where window_start < now() - interval '1 day'` nightly.

## 3. Environment variables

**Required**

| Variable | Purpose |
|---|---|
| `APP_URL` | Public https URL, e.g. `https://app.example.com`. Used for OAuth redirects, Stripe return URLs and signed media links. |
| `APP_SECRET` | 32+ random characters. Encrypts OAuth tokens at rest and signs links. **In production, any operation needing it fails until it is set** (there is no insecure fallback). |
| `DATABASE_URL` | Postgres connection string. |
| `ANTHROPIC_API_KEY` | Claude API key for every AI feature. |

**Optional**

| Variable | Purpose |
|---|---|
| `ANTHROPIC_MODEL` | Override the default `claude-opus-5-5`. |
| `STRATEGIST_WEB_SEARCH` | `off` disables web research in the Marketing Strategist (findings are then labelled hypotheses). |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `AI_PRICE_WEB_SEARCH_PER_1K` | Override the AI cost estimates shown in the app. |
| `VOYAGE_API_KEY` | Semantic embeddings for brand memory (local hashing otherwise). |
| `IMAGE_PROVIDER`, `OPENAI_API_KEY` | AI imagery for creatives (`IMAGE_PROVIDER=none` for typographic layouts only). |
| `STORAGE_DIR` | Upload directory (default `./.data/files`). |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY` | Billing. |
| `META_APP_ID`/`SECRET`, `LINKEDIN_*`, `GOOGLE_*`, `PINTEREST_*`, `TIKTOK_*` | Social platform OAuth apps. |
| `CRON_SECRET` | Protects `GET /api/cron/tick` for an external scheduler. |
| `RUN_JOBS_IN_PROCESS` | Set `false` when running `npm run worker` separately (Postgres only). |
| `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_SHA256` | Android TWA asset links (see `ANDROID.md`). |

**Never set in production:** `AI_PROVIDER=mock`. Production ignores it unless `AI_ALLOW_MOCK_IN_PRODUCTION=true`, which is for demos and E2E only.

## 4. Secrets handling
- Keep secrets in your platform's secret manager, never in the repository. `.env*` files are git-ignored.
- **No secret is read by client code:**
  - There are no `NEXT_PUBLIC_` variables.
  - CI runs `npm run check:secrets` after every build. It fails if client bundles read a server-only variable, contain a known secret value, or contain key-shaped strings.
- **Logs are structured JSON.** Field names that look secret (token, key, secret, password, authorization, cookie, signature) are redacted, and key-shaped values (`sk-ant-…`, `sk_live_…`, `whsec_…`, bearer tokens) are masked.
- **OAuth tokens** are AES-256-GCM encrypted at rest with `APP_SECRET`. Rotating `APP_SECRET` invalidates stored tokens: users must reconnect their accounts.

## 5. Network security (required)

The app fetches brand websites server-side.

**What the app enforces** (`src/server/web.ts`):
- http/https only, on ports 80 and 443.
- No credentials in URLs, and no internal hostnames.
- DNS is resolved once, and every address must be public. The connection is **pinned to the validated IP**, so DNS rebinding can't redirect it.
- Every redirect is re-validated, with at most 4 hops.
- 8-second timeout and a 400 KB response cap.

**Also enforce at the network layer** (defence in depth):
- Block egress from the app to private ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `127/8`, `169.254/16`, `fc00::/7`, `fe80::/10`) and to cloud metadata endpoints.
  - On AWS, require IMDSv2 with hop limit 1.
  - On GCP, block `metadata.google.internal` from the app's service account where possible.
- Allow egress only to what the app needs:
  - `api.anthropic.com` and, optionally, `api.voyageai.com`, `api.openai.com`, `api.stripe.com`.
  - The social platform APIs.
  - Public websites on ports 80 and 443.

## 6. Rate limits and abuse protection

All limits are defined in `src/server/ratelimit.ts` (per user and per organisation, shared via Postgres) and `src/middleware.ts` (per IP, per instance).

| Area | Limit |
|---|---|
| AI actions (copy, ideas, Q&A, assistant) | 30/min and 300/hour per user; 90/min per organisation |
| Heavy AI (brand analysis, asset analysis, strategy, campaigns, creatives, competitor research) | 6 per 10 min per user; 20 per 10 min per organisation |
| Concurrent AI tasks | 2 per user; per organisation 2 (Starter), 4 (Growth), 10 (Agency). A strategist run holds one lease for its whole run (15 min, renewed while it works). |
| Uploads | 20 requests per 10 min per user, 60 per organisation; at most 20 files and 50 MB per request, 15 MB per file |
| Image rendering | 600/min per user |
| Sign-in / sign-up | 10 per 15 min per email and per IP (hashed keys) |
| Per-IP flood limit | 120 mutating requests/min, 600 API GETs/min |
| Monthly AI quota | By plan: 200 / 2,000 / 20,000 AI runs |

**How limits are reported:**
- HTTP routes and the edge limiter return **HTTP 429** with `Retry-After`.
- Server actions return `{ ok: false, status: 429, retryAfter, error }`, which the UI shows as a message. Server actions always use HTTP 200 by framework design.

For large deployments, also put a WAF or CDN rate limit in front.

## 7. Background jobs
- **Single instance, PGlite or Postgres:** jobs run in-process every 30 seconds.
- **Several instances:** set `RUN_JOBS_IN_PROCESS=false`, then either run one `npm run worker` process, or call `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute.

- **Strategist jobs** are persistent (`ai_tasks`). After a restart or crash they are recovered automatically within about 2–3 minutes by whichever runner is active (in-process tick, `npm run worker`, or the cron route), without re-running finished sections or re-charging rate limits. On serverless hosting, schedule `GET /api/cron/tick` every minute so recovery doesn't depend on a user having the page open.

## 8. Third-party configuration
- **Stripe:** register a webhook at `{APP_URL}/api/billing/webhook` (see README).
- **OAuth apps:** register `{APP_URL}/api/oauth/{platform}/callback` with each platform.
- **Anthropic:** make sure the web search tool is available to the API key's organisation (the strategist's market research uses it; without it, research is labelled hypotheses-only). Set spend limits on the API key's workspace in the Anthropic Console as a cost backstop.

## 9. Go-live checklist
- [ ] `APP_URL` (https), `APP_SECRET`, `DATABASE_URL` and `ANTHROPIC_API_KEY` set. `AI_PROVIDER` unset.
- [ ] pgvector available; migrations ran (check the logs at first start).
- [ ] Persistent, backed-up `STORAGE_DIR`; database backups scheduled.
- [ ] Egress firewall blocks private ranges and metadata endpoints.
- [ ] Proxy sets `X-Forwarded-For` correctly.
- [ ] One live brand analysed end to end with the real API key (onboarding → profile → Q&A).
- [ ] One live strategy generated end to end with the real API key: research shows verified findings with working source links; every section passes review; the cost estimate matches the Anthropic Console roughly.
- [ ] Logs shipped to your log platform; alerts on `"level":"error"` and `ratelimit.*` spikes.
- [ ] Anthropic and Stripe spend alerts configured.
