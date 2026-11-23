# Private-beta progress

Live status of the engineering work: what's done, what's active, PR links, commit SHAs, CI, known problems, next steps. Updated at every checkpoint. Decisions you need to make are in [PRIVATE_BETA_DECISIONS_REQUIRED.md](PRIVATE_BETA_DECISIONS_REQUIRED.md).

Two Claude Code sessions work on the mandate: **A** (`session_017ArpCNvaij8Z6GvKqVyJLp`, this document's maintainer) and **B** (`session_017ArpCMgfHSvxLokzUCf95E`). They coordinate by message: one linear stack, migration numbers agreed in advance, and no pushes to each other's branches.

## 1. Open PRs (none merged; none reviewed)

| PR | Work | Branch → base | Head | CI on head | Session |
|---|---|---|---|---|---|
| [#11](https://github.com/groverstech/instagram-ai-automation/pull/11) | Readiness docs (this file and the others) | `claude/ai-social-marketing-platform-n9rlh6` → `main` | moves | green on each push | A |
| [#12](https://github.com/groverstech/instagram-ai-automation/pull/12)–[#15](https://github.com/groverstech/instagram-ai-automation/pull/15), [#17](https://github.com/groverstech/instagram-ai-automation/pull/17)–[#26](https://github.com/groverstech/instagram-ai-automation/pull/26) | Platform readiness, deletion, review pack, pause, MFA, step-up, credits, kill switch, audit export, data export, rotation, postcss, RLS pilot, job alerts | stack | see [audit §2](PRIVATE_BETA_LAUNCH_AUDIT.md#2-open-prs) | green (run IDs in the audit) | A |
| [#16](https://github.com/groverstech/instagram-ai-automation/pull/16) | Strict CSP | `feature/strict-csp` → `main` | `3259597` | 45060385217 green | A |
| [#27](https://github.com/groverstech/instagram-ai-automation/pull/27) | Enforce required MFA on actions and API routes; step-up for deletion; config fix | `fix/required-mfa-enforcement` → #26 | `52e9415` | 45169193918 green | B |
| [#29](https://github.com/groverstech/instagram-ai-automation/pull/29) | Invitation-only sign-up (`SIGNUP_MODE`, `beta_invites`, migration 0017) | `feature/invite-only-signup` → #27 | `495d693` | 45170143027 green | B |
| [#28](https://github.com/groverstech/instagram-ai-automation/pull/28) | Reviewer account with MFA pre-enrolled (F-A1) | `fix/reviewer-mfa` → #29 | `580f63c` | 45180174897 (running at writing) | A |
| [#30](https://github.com/groverstech/instagram-ai-automation/pull/30) | Account recovery (S11; migration 0018) | `feature/account-recovery` → #28 | `507c5d5` | 45180294021 (running at writing) | A |
| [#31](https://github.com/groverstech/instagram-ai-automation/pull/31) | Organisation export memory bound (D6) | `fix/export-memory` → #30 | `02c89b2` | 45180297592 (running at writing) | A |

**Stack order:** main → #12 → #13 → #14 → #15 → #17 → #18 → #19 → #20 → #21 → #22 → #23 → #24 → #25 → #26 → #27 → #29 → #28 → #30 → #31. #11 and #16 are independent.

**Migrations:** 0011 (#12), 0012 (#15), 0013 (#17), 0014 (#19), 0015 (#20), 0016 (#25), 0017 (#29), 0018 (#30); **0019 is reserved for session B's PR 4.4a**.

## 2. Active work

| Item | Owner | Status |
|---|---|---|
| R-P0-4: sandbox platform plus the full lifecycle E2E | A | Next |
| RLS: refuse to start in strict mode with `RLS_PILOT=on` and a superuser/`BYPASSRLS` role | A | Queued |
| R-P1-1: PR 4.4a publish ledger, idempotency, reconciliation, token health | B | Agreed; stacks on `fix/export-memory`, migration 0019 |

## 3. Known problems

- **Local test Postgres** (this session's environment) stops when the worker restarts, or is killed without a clean shutdown. Restart with `pg_ctlcluster 16 main start`. GitHub CI is unaffected.
- **Fixed-window rate-limit tests** can straddle a 15-minute boundary under load. The clock is now pinned in `auth-forms` (#20), `deletion` and `account-recovery` (#30); the fix on older branches lands as the stack merges.
- **`local/integration-check`** (local only, `cc0e40f`): stack #26 plus #16, kept for reference. It predates #27–#31.

## 4. How to resume (commands)

```
cd web
pg_ctlcluster 16 main start                         # local Postgres
TEST_DATABASE_URL=postgres://bp:bp@127.0.0.1:5432/postgres ./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit && npm run -s lint && npm run -s build
```

The browser regression scripts live in the session scratchpad. They aren't in the repository: they belong to this environment.

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
