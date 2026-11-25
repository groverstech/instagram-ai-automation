# 9. Scaling to thousands of organisations with many brands each

**Target for design and load testing:** 5,000 organisations, 15,000 brands, 30,000 connected
social accounts, and about 500,000 posts per month. Peaks come at popular posting times, such as
the top of the hour.

## 9.1 What already scales

- **Tenant model:** organisation (workspace) → brands → everything else. Every query and action
  is scoped by brand on the server, and client users are limited to their brands.
- **Persistent job engine:** an atomic claim, heartbeat, recovery and idempotent steps, so many
  workers can run safely.
- **Concurrency limits** per user and per organisation (plan-based), and rate limits per
  user and organisation.
- **The cost ledger** per call.

## 9.2 Required changes

| # | Area | Today | Change | Package |
|---|---|---|---|---|
| S1 | Database engine | PGlite default | **Managed Postgres only** in production (pgvector, PITR), with **connection pooling** (PgBouncer or a provider pooler) | P4-0b |
| S2 | Tenant key on hot tables | `brand_id` on most tables; organisation found through `brands` | Store `org_id` on hot and append-only tables (`agent_runs`, `usage_events`, `posts`, metrics, `agent_actions`, `credit_ledger`) for organisation-level queries without joins | P4-2, P4-5 |
| S3 | Defence-in-depth isolation | Application-level scoping (tested) | **Postgres Row-Level Security** on tenant tables, keyed on a per-transaction `app.org_id` setting. A missed `WHERE` then can't leak another tenant's data. Platform admin and migration roles bypass it explicitly. | P4-9 |
| S4 | Large append-only tables | Single tables | **Monthly partitions** for `agent_runs`, `usage_events`, `post_metrics` snapshots, `agent_actions` and `credit_ledger`; retention policies; daily roll-up tables for dashboards | P4-2, P4-5 |
| S5 | Missing indexes | `campaigns.brand_id` and `competitors.brand_id` unindexed | Add the indexes; review every tenant query plan in the load test | P4-0b |
| S6 | Job execution | Workers claim with a conditional UPDATE; one tick loop | `FOR UPDATE SKIP LOCKED` batch claims; **separate worker pools** per job class (AI, render, publish, metrics, video) with independent autoscaling; **fair scheduling per organisation** so one tenant's bulk job can't starve others | P4-0b, P4-3a |
| S7 | Publishing bursts | Scheduler publishes when a post is due | **Pre-render and pre-upload** media minutes before the due time; spread start times by a few seconds within the minute; publish pool sized for the burst; per-account and per-app platform rate-limit budgets (read from platform headers) | P4-3a |
| S8 | Rendering cost | Rendered on every view and every platform fetch | **Content-addressed render cache** in R2 behind the CDN (document 4); render workers separate from web | P4-1 |
| S9 | Rate-limit storage | Database bucket rows written per request | Move hot counters (request rate limits, provider token buckets) to **Redis** or the edge (Cloudflare rate limiting). Keep the database for quotas and credits, which need transactions. | P4-0b |
| S10 | AI provider throughput | Calls made as jobs need them | **Global per-provider token buckets** (requests and tokens per minute, from the organisation's provider tier); jobs queue instead of failing on 429; request higher tiers ahead of growth; batch API for non-urgent work | P4-2 |
| S11 | Metrics sync | Polling | Spread polling across the day with jitter; platform webhooks where available; incremental windows (recent posts often, older posts rarely, none after 90 days) | P4-5 |
| S12 | Brand context assembly | Built per AI task from the database | Cache the approved brand profile and context prefix per brand version (in memory or Redis), and use **prompt caching** on the provider side (document 3) | P4-2 |
| S13 | Storage layout | `brands/<id>/…` | `org/<orgId>/brand/<brandId>/…` (document 4) for per-tenant usage, export and deletion | P4-1 |
| S14 | Vector memory | pgvector on `brand_memories` | HNSW index; always filter by brand first, and partition by brand range if recall or latency drops; cap memories per brand with pruning | P4-9 |
| S15 | Observability | Logs | Traces with `org_id` and `brand_id` as span attributes (not metric labels, to avoid high-cardinality metrics); per-tenant cost and usage from `usage_events`; SLO alerts | P4-0b |
| S16 | Noisy neighbours | Concurrency limits per organisation | Plus per-organisation queue shares, credit caps (document 5) and storage quotas | P4-2 |
| S17 | Tenant lifecycle | Manual | Self-serve export (ZIP of data plus media); deletion with a 30-day grace period, then purge of the database rows and storage prefix, with an audit record | P4-1, P4-9 |

## 9.3 Data growth (at the target)

| Data | Rough volume | Handling |
|---|---|---|
| Posts | About 0.5 M per month | Indexed by brand and scheduled time |
| Post metric snapshots | About 10–15 M rows per month (daily for 30 days, then weekly to 90 days) | Monthly partitions, roll-ups, retention |
| `agent_runs` and `usage_events` | Several M rows per month | Monthly partitions; roll-ups for dashboards |
| Media | Several TB per year | R2 (no egress fees) plus lifecycle rules (document 4) |

## 9.4 Deployment shape

```
Cloudflare (DNS, CDN, WAF, rate limiting)
   │
   ├── Web/API (Next.js), stateless, N instances, autoscaled on CPU/latency
   ├── Workers: ai · render · publish · metrics · video  (separate pools, autoscaled on queue depth)
   ├── Postgres (primary + PITR; read replica for dashboards and analytics later)
   ├── Redis (rate limits, token buckets, short-lived caches)
   └── R2 (private + delivery buckets)
```

- Single region at first, with global CDN delivery.
- Read replicas and a second region only when latency or data residency requires them.

## 9.5 Load-test targets (P4-9)

| Scenario | Target |
|---|---|
| App pages (authenticated, p95) | < 500 ms server time at 500 concurrent users |
| Publishing burst: 2,000 posts due in the same minute | All published within 3 minutes; zero duplicates; platform rate limits respected |
| AI job queue (normal load) | p95 wait before start < 60 s; provider 429s absorbed without job failures |
| Credit reservations: 50 concurrent against one organisation's last credits | Zero overdraft |
| Tenant isolation under load | Zero cross-tenant reads (RLS plus application checks, verified by randomised tests) |
