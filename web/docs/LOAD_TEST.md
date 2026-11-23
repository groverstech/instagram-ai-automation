# Load test (PR 4.9 remainder, roadmap R-P1-7)

A first measurement of how one production web process behaves under concurrent signed-in use. This **isn't** a production capacity test. That needs the real hosting (decision D-4) and runs again there.

## Setup (23 Nov 2026)

| | |
|---|---|
| **Build** | `next build` / `next start` (production), one Node 22 process, `RUN_JOBS_IN_PROCESS=false` |
| **Database** | PostgreSQL 16 on the same machine |
| **Machine** | 4 vCPU, 16 GB (the development container) |
| **Data** | An agency organisation with 3 brands, 1,500 posts (500 per brand, ±30 days), 300 creatives, metrics for 375 published posts |
| **AI** | Demo mode (no provider calls on these pages anyway) |
| **Load** | `e2e/load.cjs`: one signed-in session, N concurrent clients per page, 20 s per page, fetching pages without a browser |

## Results

| Page | Concurrency 10: req/s | p50 | p95 | p99 | Concurrency 25: req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|---|---|---|
| `/api/health/ready` | 206 | 47 ms | 67 ms | 75 ms | 273 | 91 ms | 120 ms | 143 ms | 0 |
| `/campaigns` | 80 | 117 ms | 183 ms | 216 ms | 79 | 315 ms | 378 ms | 448 ms | 0 |
| `/analytics` | 72 | 130 ms | 221 ms | 246 ms | 71 | 352 ms | 453 ms | 516 ms | 0 |
| `/dashboard` | 41 | 239 ms | 346 ms | 454 ms | 38 | 650 ms | 820 ms | 862 ms | 0 |
| `/settings` | 37 | 263 ms | 388 ms | 431 ms | 41 | 597 ms | 798 ms | 876 ms | 0 |
| `/calendar` | 20 | 482 ms | 674 ms | 806 ms | 19 | 1,363 ms | 1,791 ms | 1,863 ms | 0 |

## Findings

1. **No errors at either level.** Throughput is flat from 10 to 25 clients, so the process is CPU-bound, and latency grows with the queue as expected.
2. **The Content Calendar is the heaviest page.**
   - A single request takes 67 ms, and its main query 0.3 ms (`explain analyze`).
   - But the page carries **439 KB** (about 250 posts with captions for the visible month, plus creatives), and rendering it bounds throughput at about 20 pages a second per process.
   - Fine for an invitation-only beta: tens of people, each opening the calendar now and then.
   - Worth improving before larger scale: send post summaries in the month grid and load captions when a post opens.
3. **The database isn't the bottleneck** at this data volume. The indexes are used (`posts_brand_sched_idx`).
4. **Scaling:**
   - a second web process doubles page throughput;
   - more than one **instance** needs shared object storage (PR 4.2) and stays single-instance until then (decision D-10).

## Re-run

```
npm run build && DATABASE_URL=… npx next start -p 3100   # in one shell
EMAIL=… PASSWORD=… DUR=20 CONC=10,25 node e2e/load.cjs   # in another
```

`load.cjs` signs in through the browser once (Playwright), then uses the session cookie.
