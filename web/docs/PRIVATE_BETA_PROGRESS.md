# Private-beta progress

Live status of the engineering work. What only the owner can do is in
[PRIVATE_BETA_OWNER_ACTIONS.md](PRIVATE_BETA_OWNER_ACTIONS.md); decisions with options and
recommendations are in [PRIVATE_BETA_DECISIONS_REQUIRED.md](PRIVATE_BETA_DECISIONS_REQUIRED.md).

## 1. State of `main` (25 Nov 2026)

- **Everything is merged.** On the owner's instruction, the stack #11–#40 was merged in dependency order with merge commits (each PR retargeted to `main` first), then #16 after `main` was merged into it. No PRs are open.
- **The merge resolved one conflict:** the "known gaps" table in `docs/SECURITY.md`, keeping #16's strict-CSP row and the stack's two-step-verification row.
- **`main` is identical to the integration validated before merging:** 565/565 on Postgres 16, the lifecycle journey 16/16 under strict CSP, typecheck, lint, build and secret scan.
- **CI on `main`:** green on the #40 merge commit (run 45537397148). The intermediate runs were cancelled by the workflow's concurrency setting.
- **Migrations:** 0000–0025. **Next free: 0026.**
- **Off until separately authorised:** Autonomous publishing and credit enforcement.

## 2. Release completion (25 Nov 2026)

Found and fixed while taking the merged product through its journeys:

| Finding | Fix |
|---|---|
| Sign-up said "An account with this email already exists" (S5/F1) | Where verification is required, sign-up signs nobody in and answers every address the same way; the existing account's owner is emailed (rate-limited) |
| An app database role without access to the migration journal made readiness report "0 migrations applied" forever, so a staging set up as RLS requires would never become ready | `deploy/app-role-grants.sql` (tables, journal, default privileges for later migrations); readiness names the missing grant; real-Postgres test |
| No in-app password change (ASVS 2.1.5) | Account → Security: current password required, rate-limited, other sessions signed out, audited, emailed |
| Error tracking needed a vendor integration before `SENTRY_DSN` could do anything | Dependency-free Sentry reporter (envelope API), redacted context, config check |
| Dashboard scrolled sideways at phone width; the same grid pattern on 9 other screens | Single-column grids that can shrink |
| Security log showed raw event codes for newer events | Labels for every event, enforced by the type |
| "1 posts" | Plurals |

Added: `npm run e2e:staging` (also in CI): strict staging mode as an ordinary role under RLS, with
invite-only sign-up, required two-step verification, onboarding, the emergency-stop drill and the
reviewer account. `deploy/staging.env.example` is the complete staging configuration, validated
against the strict checks.

Exploratory pass: 15 pages × owner and editor × desktop and phone, plus AI insights, competitor
research, campaigns, the assistant, billing without Stripe, two-step verification and the operator
emergency stop end to end. No page errors and no 4xx or 5xx responses after the fixes.

## 3. How to resume

```
cd web
TEST_DATABASE_URL=postgres://… npx vitest run          # full suite on Postgres 16
npx tsc --noEmit && npm run -s lint && npm run -s build
E2E_ADMIN_URL=postgres://… npm run e2e:lifecycle       # the customer journey (sandbox, demo AI)
E2E_ADMIN_URL=postgres://… npm run e2e:staging         # strict staging rehearsal
```

## 4. Operator emergency stop

`npm run publishing:stop` (DEPLOYMENT §9). A brand admin's "Resume publishing" can't lift it; only
`publishing:stop -- resume` does. **Don't pause brands with SQL:** brand admins could resume that
themselves. If the CLI can't run, use the `INSERT INTO publishing_stops …` fallback in DEPLOYMENT §9.

## 5. Checkpoints

| Date | Checkpoint |
|---|---|
| 22 Nov 2026 | Baseline verified (§1). Tracker created; plan documents brought onto `main` with it. Next: PR 4.3 platform readiness. |
| 22 Nov 2026 | Opened #12 (4.3a: legal pages, Meta callbacks, capabilities, JPEG; CI green) and #13 (4.3b: self-service deletion, stacked on #12). Evidence: 373/373 tests on Postgres 16; browser regression 19/16/10/20 passing. Next: 4.3c (reviewer demo workspace, submission packs), then emergency pause (R2). |
| 22 Nov 2026 | Opened #14 (4.3c: Meta submission pack, `reviewer:setup`). Finding: the Meta review and single-image beta publishing don't depend on R2 for a single-instance beta. Next: emergency pause (R2), then strict CSP (F2). |
| 22 Nov 2026 | Opened #15 (emergency pause, R2; stacked on #14 for migration numbering). 378/378 tests; regression 19/16/10/20. Next: strict CSP (F2, S6). |
| 22 Nov 2026 | Opened #16 (strict CSP, F2; from `main`). 349/349 tests; regression 19/16/10/20 under the policy. Next: MFA (F3, S7). |
| 22 Nov 2026 | Opened #17 (MFA F3a; stacked on #15). 386/386 tests; regression 19/16/10/20; browser checks in optional and required modes. Recorded O7 (Next.js postcss advisory). Next: F3b, then PR 4.5 (credits shadow mode). |
| 22 Nov 2026 | Opened #18 (MFA F3b; stacked on #17): 391/391 tests, CI green (45065217077), browser check 9/9, regression 19/16/10/20. Opened #19 (PR 4.5 credits shadow mode; stacked on #18): 400/400 tests, browser check 6/6, regression 19/16/10/20. Next: F12 (AI kill switch and tripwire). |
| 23 Nov 2026 | #19 CI green (45067038811). Opened #20 (F12 kill switch and tripwire; stacked on #19): 407/407 tests, regression 19/16/10/20. Next: F4 (audit-log retention and export) and tenant export. |
| 23 Nov 2026 | #20 CI was red on a pre-existing flaky test (the login limiter's fixed 15-minute window straddled during the run); fixed by pinning the clock (c22bb34), CI green (45108409393). Opened #21 (F4; stacked on #20): 413/413 tests, browser check 7/7, regression 19/16/10/20. Next: tenant data export (D4). |
| 23 Nov 2026 | #21 CI green (45109461233). Opened #22 (D4 organisation data export; stacked on #21): 418/418 tests, browser check 4/4, regression 19/16/10/20. Next: `APP_SECRET` rotation without reconnects (S3). |
| 23 Nov 2026 | #22 CI green (45110486063). Opened #23 (S3 `APP_SECRET` rotation; stacked on #22): 424/424 tests, end-to-end rotation check 6/6, regression 19/16/10/20. O7: npm override points Next.js at the project's patched postcss (audit clean, CSS byte-identical); PR next. Then: RLS pilot (S8). |
| 23 Nov 2026 | #23 and #24 CI green (45112480510, 45113497809). Opened #24 (O7 postcss override) and #25 (S8 RLS pilot; stacked on #24): 430/430 tests, RLS browser check 6/6 as an ordinary role, regression 19/16/10/20. The authorised code queue is now in review; the remaining gates need owner decisions, infrastructure or external parties (see Owner decisions). |
| 23 Nov 2026 | #25 CI green (45115332161). Opened #26 (O4 code part; stacked on #25): 433/433 tests, regression 19/16/10/20. Corrected statuses of S6, D3, P1, P2, P3, P7 and R2 to In review. All authorised code work is now in review; what remains needs owner decisions, infrastructure or external parties. |
| 23 Nov 2026 | Full-mandate reconciliation. Verified all 16 open PRs (heads, bases, CI on head SHAs; no reviews yet) and the stack + #16 integration (434/434, regression 19/16/10/20, CSP feature checks clean). Added PRIVATE_BETA_LAUNCH_AUDIT.md, PRIVATE_BETA_ROADMAP.md and PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md; the gate tables moved to the checklist. New findings: reviewer vs MFA (P8), no account recovery (S11), export memory (D6), no lifecycle E2E (Q1). Next: R-P0-1 to R-P0-4. |
| 23 Nov 2026 | Session B opened #27 (required MFA enforced on actions and routes) and #29 (invitation-only sign-up, 0017). Session A opened #28 (reviewer MFA), #30 (account recovery, 0018 after renumbering) and #31 (export memory), restacked by merging after #29 (no force-push). Top of stack 453/453 on PG16. Added PRIVATE_BETA_DECISIONS_REQUIRED.md and PRIVATE_BETA_PROGRESS.md; decisions and checkpoints moved out of LAUNCH_READINESS.md. Next (A): RLS strict-mode refusal, sandbox lifecycle E2E. Next (B): PR 4.4a on `fix/export-memory`, migration 0019. |
| 23 Nov 2026 | Opened #32 (RLS strict-mode refusal) and #34 (social sandbox, plus the lifecycle journey: 10/10 locally, now a CI step). Session B opened #33 (PR 4.4a, 0019). CI green on #28, #30, #31, #32 and #33. Next (A): R-P1-7 load test and ASVS review; credit enforcement stays owner-gated (D-17). |
| 23 Nov 2026 | #34 CI green including the new lifecycle step (45183763244); regression 19/16/10/20 on the #34 build. Opened #35: load test (no errors at 10 and 25 concurrent clients; calendar ~20 pages/s, CPU-bound) and ASVS L2 self-review (gaps become decisions D-26 and D-27). |
| 23 Nov 2026 | Stack relinearised: #31 → #32 → #34 → #33 → #35 (merges only). Top of stack 472/472 on PG16. Session B has stopped new work and handed the next items back. Decisions: added autonomy levels and the plan-status confirmation to D-3. |
| 23 Nov 2026 | Full completion mandate. Verified: nothing merged; CI green on #33 (45184903930) and #35 (45186220958). Opened #36 (publish_attempts RLS + export + history, 0020), #37 (autonomy levels, 0021), #38 (PR 4.6 credit enforcement, off; 0022) and #39 (email verification, invitations, notifications, provider adapters; 0023; extended lifecycle E2E). Full suite 512/512 on PG16; lifecycle journey passes end to end, including verification, invitation, export and autonomy checks. The Phase 4 plan is recorded as the approved baseline, with the autonomy levels added. |
| 24 Nov 2026 | Owner review stage. Re-verified all 30 PRs: the same latest commits as reported, every one green on its latest commit, `main` unchanged (`b8a8353`). Integrated tree (stack + #16 + #11) merges with only the known `SECURITY.md` row; 513/513 tests and the browser journey 15/15 passed on stack + #16. **Defect found and fixed on #39 (`58a0f91`): `reviewer:setup` created the Meta reviewer unverified, which would block the review now that verification is required.** Added PRIVATE_BETA_OWNER_DECISION_PACK.md, the single register of open decisions. |

| 24 Nov 2026 | Adversarial review of the stack: H1 (edits after approval published without re-approval) and M1 (time changes left stale jobs) found, plus M2–M5 and L1–L8. Docs corrected at once (M5). Hardening PR #40 fixes H1, M1, M2 (Autonomous stays off), M4, L1–L6 and L8; the new concurrency test also found and fixed a membership-deleting race in invitation acceptance. Local: 541/541 on PG16, 542/542 integrated with #16, browser journey 16/16 (also with #16), migrations 0000–0024 on a fresh PG16. CI's first run on #40 failed on a pre-existing journey race (approval text vs commit), fixed in `b694e7e`. |
| 25 Nov 2026 | Owner authorised the merge and release completion. Merged #11–#40 and #16 (merge commits; documented SECURITY.md resolution); `main` identical to the validated integration. Release-completion fixes in §2; staging rehearsal added to CI. |
