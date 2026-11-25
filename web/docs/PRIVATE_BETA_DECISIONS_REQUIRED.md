# Decisions required from the owner

> **Superseded on 24 Nov 2026 by [PRIVATE_BETA_OWNER_DECISION_PACK.md](PRIVATE_BETA_OWNER_DECISION_PACK.md) §4**, the single register of open decisions, grouped A–G with recommendations. The decision IDs below (D-1 to D-28) are kept for reference, and the pack maps them to its own IDs. Where the two differ, the pack is current.


Every decision below needs you: engineering won't make it. Each has options, consequences, cost and a recommendation. Status and evidence are in [PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md](PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md); sequencing is in [PRIVATE_BETA_ROADMAP.md](PRIVATE_BETA_ROADMAP.md).

Costs are indicative (late 2026 list prices as remembered, **not verified**). Check current pricing before choosing.

## 1. Merges (blocks everything)

**D-1. Review and merge the open PRs.**
- **What:** 29 PRs: #11 (docs), #16, and the stack #12 → #39 (order in PRIVATE_BETA_PROGRESS.md §1). None has a review yet.
- **Recommendation:**
  - review in stack order;
  - merge #11 and #16 first;
  - then the stack, using the retargeting steps in [the audit §3](PRIVATE_BETA_LAUNCH_AUDIT.md#3-dependency-graph-and-merge-order).
- **Risk if delayed:** the stack grows, and so does the merge effort.

## 2. Scope

**D-2. Confirm the private-beta definition** ([LAUNCH_READINESS.md §2](LAUNCH_READINESS.md)): Instagram and Facebook publishing; human approval before every publish; no autonomous publishing; credits in shadow mode.

**D-3. Features in the mandate's inventory that the approved Phase 4 plan didn't adopt.** They come from the [Phase 4 proposal](PHASE4_PROPOSAL.md); the plan's PRs 4.0–4.9 don't include them.

| Feature (proposal module) | Effort | Recommendation |
|---|---|---|
| Client sign-off approvals, comments, approval inbox (P4-7) | 4–6 days | Defer. Today: editor → admin approval, and brand-scoped client users can submit posts and see their brand |
| Cross-platform analytics and attribution per pillar, campaign and creative (P4-3) | 5–7 days | Defer. Today: Instagram and Facebook metrics plus AI performance analysis |
| Optimisation loop: weekly review agent with approvable change sets (P4-5) | 5–7 days | Defer. Today: AI analysis on the Analytics page, and strategy revisions |
| Cross-brand agency reporting | 2–3 days | Defer. Today: organisation usage and credits by brand |
| Smart scheduling, competitor monitoring, autonomous agents (P4-2, P4-4, P4-6) | Each 4+ days | Defer |

**Resolved (23 Nov):**
- You confirmed the Phase 4 plan as the approved first-release baseline. `plan/README.md` now says so.
- You added the three autonomy levels to the scope. They are built in #37: Assisted is the default, and Autonomous is unavailable until D-28.

**Your choice:** add any of these to the first release (they become P1 and are built), or confirm they're deferred.

## 3. Infrastructure (blocks the beta)

| ID | Decision | Options | Recommendation | Indicative cost | Blocks beta? |
|---|---|---|---|---|---|
| D-4 | Hosting (O1) | A: container platform (Fly.io, Render, Railway) with managed Postgres. B: AWS (ECS, RDS) | A: one web and one worker instance; Postgres with PITR | ~USD 50–150 a month | Yes |
| D-5 | Production database role | An ordinary role (no superuser, no `BYPASSRLS`) for the app, and a privileged role only for `db:migrate` | Yes, from day one | None | Yes |
| D-6 | Row-level security trial | `RLS_PILOT=on` on staging, then production | Yes, after D-5 | None | Recommended |
| D-7 | Email provider (O3) | Postmark or Resend: both adapters are built and tested against stubs (#39). Amazon SES would need an adapter | Postmark or Resend; go-live steps in `docs/EMAIL.md` (domain DNS, key in the secret store, egress) | ~USD 0–20 a month | Yes: email verification is required in production, plus invitations and password reset |
| D-8 | Error tracking and uptime (O2, O4) | Sentry plus Better Stack or UptimeRobot | Sentry; uptime checks on `/api/health/ready` and `/api/health/jobs` | ~USD 0–30 a month | Yes |
| D-9 | Object storage: authorise PR 4.2 (R2) | Authorise now, or accept a single-instance beta on local disk with backups | Accept a single instance for the beta (D-10); authorise 4.2 before scaling or before carousels and Reels | R2 ~USD 0–15 a month at beta scale | No, if D-10 is accepted |
| D-10 | Single-instance beta (F5) | Accept, or require 4.2 first | Accept, with a restore drill | — | — |
| D-11 | Egress firewall (F7) | Platform network policy or a proxy | With the hosting choice | Platform-dependent | Yes |
| D-12 | Backups and restore drill (D1) | Managed PITR plus a monthly drill | Yes | Included with managed Postgres | Yes |

## 4. Configuration values

| ID | Setting | Recommendation | Blocks beta? |
|---|---|---|---|
| D-13 | `AI_TRIPWIRE_USD` (per provider, per 15 minutes) | About 3–5× normal 15-minute spend; start at USD 5 for a small beta and tune | Yes (a value is needed) |
| D-14 | `AI_MONTHLY_COST_LIMIT_USD` (per organisation, or per plan) | Set per plan; for example USD 20 for beta organisations | Yes |
| D-15 | Provider-side budgets (Anthropic and OpenAI consoles) | Monthly budget at the expected total; **no auto-reload** | Yes |
| D-16 | `AUDIT_RETENTION_DAYS` | 400 (default), or per your privacy notice | No |
| D-17 | Credit value, plan allowances, failed-attempt policy, then **turning enforcement on** (`CREDITS_MODE=enforce`, built in #38) after a shadow period | Run the beta in shadow; compare with `npm run credits -- shadow` and `-- reconcile`; enforce before paid plans | No |
| D-18 | `SIGNUP_MODE` and the beta list (#29) | `invite_only` (the default in production); add invitees with `npm run beta:invite` | Yes (the list) |

| D-28 | **Autonomous publishing** (`AUTONOMOUS_PUBLISHING=on`, built in #37) | Keep off for the beta. Before turning it on: two weeks on test accounts (one brand Assisted, one Autonomous) with zero unapproved restricted posts, zero duplicates and zero cap overruns; then per brand, by owners, with step-up | No (it stays off) |

### Account policy (from the ASVS L2 self-review, #35)

| ID | Decision | Options | Recommendation | Blocks beta? |
|---|---|---|---|---|
| D-26 | Password policy: the minimum is 8; ASVS L2 asks for 12, plus a breached-password check | (a) a 12-character minimum for new passwords and resets, existing passwords unchanged; (b) also check against breached passwords: Have I Been Pwned k-anonymity API (free, one outbound request per password change; only a 5-character hash prefix leaves the server) or a bundled top-100k list; (c) keep 8 | (a) plus the HIBP check. About 1 day | No, but recommended |
| D-27 | Session length: 30 days absolute, no idle timeout | (a) owners and admins: 12-hour idle and 7-day absolute; others: 30 days; (b) the same for everyone; (c) keep 30 days (step-up already protects sensitive actions) | (a). About 0.5 day | No, but recommended |

## 5. External parties

| ID | Item | Recommendation | Blocks beta? |
|---|---|---|---|
| D-19 | Legal text: privacy, terms, data deletion, DPA (L1) | From counsel; the pages are ready (#12). Optionally mention the data export (#22) in "Your rights" | Yes |
| D-20 | Meta developer app, business verification, test accounts; then submission (P4) | Start now: it's the longest pole. Pack and reviewer account ready (#14, #28) | Yes, for Instagram and Facebook publishing |
| D-21 | Live AI validation (A1, A2) | Approve the plan in [roadmap §5](PRIVATE_BETA_ROADMAP.md): ≤ USD 7.01 in total, hard caps, Anthropic first | Yes |
| D-22 | Independent tenant-isolation review (F8) | Before beta | Recommended |
| D-23 | Penetration test (F9) | Before public launch | Your call |
| D-24 | Platform terms review (L2) | With counsel | Yes |

## 6. Launch

**D-25. Approve the beta launch and the first invitations**, once every P0 gate in the checklist passes or is explicitly accepted as a risk.
