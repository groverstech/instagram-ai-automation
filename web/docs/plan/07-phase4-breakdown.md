# 7. Phase 4 implementation breakdown

**Goal:** make BrandPilot production-ready, and close the loop: Approve → Schedule → Publish →
Measure → Learn → Optimise.

**How it ships:** each work package is its own pull request, or a short series of them, with
tests, browser evidence and screenshots. **No PR is merged, and no package starts, without your
approval.** Approving this breakdown approves the *plan*, not the merges.

## 7.1 Work packages

| ID | Package | Scope (summary) | Depends on | Est. (eng-weeks) |
|---|---|---|---|---|
| **P4-0a** | App-review prerequisites | Public privacy, terms and data-deletion pages (your legal text); Meta data-deletion and deauthorise callbacks; account and data deletion flow; a reviewer demo workspace seed; the screencast environment on staging | — | 1–1.5 |
| **P4-0b** | Operations baseline | Managed Postgres with pooling; separate worker deployment; Sentry and OpenTelemetry; transactional email; staging; backups and PITR; secrets inventory; a health and status endpoint | — | 2 |
| **P4-0c** | Real-provider validation | `test:live` and the PR #6 test plan with production keys; cost reconciliation | Credentials (yours) | 0.5 |
| **P4-1** | Storage and CDN (R2) | S3 adapter, tenant keys, presigned upload and download, render cache, publish derivatives (JPEG), lifecycle, migration job | P4-0b | 2.5–3 |
| **P4-2** | Plans, credits, spend controls | Configurable plans and rate cards, credit ledger, reservations, organisation and brand caps, 70/90/100% alerts, top-ups, customer usage page, admin cost dashboard, shadow mode | P4-0b (email) | 3–4 |
| **P4-3a** | Publishing core + Instagram + Facebook | Publish-attempt ledger, idempotency, reconciliation, token health and reconnect, derived capabilities, media profiles; Instagram image, carousel, Reels and Stories; Facebook photo, multi-photo and video; fixes D1 and D2 | P4-1, P4-0a | 3–4 |
| **P4-3b** | LinkedIn organisations | Community Management API scopes, organisation URN posting (image, multi-image, document), organisation analytics; fixes D3 | P4-3a, LinkedIn approval | 1.5–2 |
| **P4-3c** | YouTube | Resumable upload, Shorts, thumbnails, scheduling, analytics | P4-3a, P4-8, Google approvals | 2 |
| **P4-4** | Approvals and collaboration | Multi-step approval, client sign-off, comments, approval inbox, SLAs and reminders, bulk actions, four-eyes option | P4-0b (email) | 2–3 |
| **P4-5** | Analytics and attribution | Insights per platform, daily snapshots, normalised metrics, performance by pillar, campaign, creative style, format and visual source; KPI roll-ups against strategy objectives | P4-3a | 3 |
| **P4-6** | Autonomy and policy engine | The three levels, brand rules UI, policy engine at every gate, emergency pause, warm-up, anomaly auto-pause, daily digest, `agent_actions` audit | P4-3a, P4-4, P4-2 | 3–4 |
| **P4-7** | Learn and optimise | Weekly performance-review agent and change sets; strategy refresh from results; competitor monitoring (scheduled snapshots, change detection, digest); scheduled agents with brand memory | P4-5, P4-6 | 3–4 |
| **P4-8** | Video pipeline | Template-based video assembly from creatives (FFmpeg); transcoding to platform profiles; video-generation provider pilot and selection; video credits | P4-1, P4-2 | 3–4 |
| **P4-9** | Scale and launch hardening | The items in document 9 not already covered, a load test at target scale, penetration test, data-protection review, runbooks, status page | All | 2–3 |

**Total:** about **31–39 engineer-weeks**. With 3 engineers working in parallel that is roughly
**3½–4½ months**, excluding platform-review waiting time, which overlaps.

## 7.2 Dependency graph

```
P4-0a ──────────────► (platform submissions: Meta now; LinkedIn, Google in parallel)
   │                                   │
   ▼                                   ▼
P4-0b ──► P4-1 ──► P4-3a ──► P4-3b (after LinkedIn approval)
   │         │        │  └──► P4-3c (after P4-8 + Google approvals)
   │         │        ├──► P4-5 ─────────────┐
   │         └──► P4-8                       ▼
   ├──► P4-2 ───────────────► P4-6 ──► P4-7
   └──► P4-4 ───────────────►   ▲
                                │
P4-0c (when credentials exist; blocks "production-ready" for AI features)
P4-9 (last; scale items start in P4-0b)
```

**Critical path:** P4-0b → P4-1 → P4-3a → P4-6 → P4-7.

**In parallel:** P4-0a (week 1, so submissions can start); P4-2 and P4-4 alongside P4-1 and P4-3a;
P4-8 after P4-1.

## 7.3 Proposed order of PRs

1. **P4-0a** app-review prerequisites. *Smallest; unblocks the reviews. Recommended first.*
2. **P4-0b** operations baseline.
3. **P4-1** storage and CDN.
4. **P4-2** plans and credits. Runs in shadow mode first; enforcement switched on in a follow-up PR.
5. **P4-3a** publishing core with Instagram and Facebook. Demo-ready for the Meta review screencast.
6. **P4-4** approvals and collaboration.
7. **P4-5** analytics and attribution.
8. **P4-6** autonomy and policy engine. Assisted stays the default; Autonomous behind a per-brand
   opt-in.
9. **P4-3b** LinkedIn, when approved.
10. **P4-8** video pipeline, then **P4-3c** YouTube.
11. **P4-7** learn and optimise.
12. **P4-9** scale and launch hardening.

## 7.4 Acceptance criteria per package (summary)

| Package | Accepted when |
|---|---|
| P4-0a | Public pages live on the production domain; the Meta deletion callback returns a confirmation code and deletes the data (tested); submissions filed |
| P4-0b | Staging mirrors production; an alert fires on an injected error; restore drill passed |
| P4-1 | All files served from R2; tenant prefix enforced (test); no re-render for unchanged creatives (counter); local disk migrated |
| P4-2 | No overdraft under concurrency; caps stop calls before the provider (test); alerts once each; admin dashboard reconciles with provider reports within 5% |
| P4-3a | Live publish to test Instagram and Facebook accounts (image, carousel, Reel); no duplicates under crash and retry tests; capabilities match the implementation |
| P4-4 | Multi-step approval with a client user; reminders sent; audit of approvals |
| P4-5 | Metrics for every published post on enabled platforms; reports by pillar, campaign and creative |
| P4-6 | Decision-table tests; pause stops in-flight publishes; 2-week Assisted and Autonomous trial on test accounts with zero violations |
| P4-7 | A weekly change set generated, approved and reflected in the next calendar version |
| P4-8 | Reels and Shorts produced from templates; provider pilot report with cost per second |
| P4-9 | Load test passes the targets in document 9; pen-test findings closed |

## 7.5 Kept intact

Existing functionality is covered by the current suites, which run on every PR:
- 151 unit and integration tests;
- the strategist, creative and QA browser suites;
- the isolation tests.

New packages add their own tests and screenshots. Demo mode stays available and labelled for
development and E2E. Real-provider validation remains *pending* until credentials are configured.
