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
| [#28](https://github.com/groverstech/instagram-ai-automation/pull/28) | Reviewer account with MFA pre-enrolled (F-A1) | `fix/reviewer-mfa` → #29 | `580f63c` | 45180174897 green | A |
| [#30](https://github.com/groverstech/instagram-ai-automation/pull/30) | Account recovery (S11; migration 0018) | `feature/account-recovery` → #28 | `507c5d5` | 45180294021 green | A |
| [#31](https://github.com/groverstech/instagram-ai-automation/pull/31) | Organisation export memory bound (D6) | `fix/export-memory` → #30 | `02c89b2` | 45180297592 green | A |
| [#32](https://github.com/groverstech/instagram-ai-automation/pull/32) | RLS: refuse to start in strict mode when the role bypasses RLS (R-P0-7) | `fix/rls-strict-refusal` → #31 | `be65893` | 45181093942 green | A |
| [#33](https://github.com/groverstech/instagram-ai-automation/pull/33) | PR 4.4a: publish-attempt ledger, reconciliation, token health (migration 0019); sandbox gains finalSend and findRecentPost | `feature/p4-publish-ledger` → #34 (retargeted) | `dd068a3` | 45184903930 green | B |
| [#34](https://github.com/groverstech/instagram-ai-automation/pull/34) | Social sandbox and the full lifecycle journey in CI (Q1, R-P0-4) | `feature/sandbox-lifecycle` → #32 | `2ffc201` | 45183763244 green (includes the lifecycle step) | A |
| [#35](https://github.com/groverstech/instagram-ai-automation/pull/35) | Load test and ASVS L2 self-review (R-P1-7) | `docs/load-asvs-review` → #33 (retargeted; #33 merged in) | `e97d37b` | 45186220958 green | A |
| [#36](https://github.com/groverstech/instagram-ai-automation/pull/36) | `publish_attempts` under RLS (migration 0020), in the organisation export, and a per-post publishing history | `feature/publish-attempts-isolation` → #35 | `a53cf9e` | 45203675000 green | A |
| [#37](https://github.com/groverstech/instagram-ai-automation/pull/37) | Autonomy levels: Advisor, Assisted (default), Autonomous behind `AUTONOMOUS_PUBLISHING` (off); policy engine, three gates, safeguards, `agent_actions` (migration 0021) | `feature/autonomy-levels` → #36 | `f0518e9` | 45205797867 green | A |
| [#38](https://github.com/groverstech/instagram-ai-automation/pull/38) | PR 4.6: credit enforcement behind `CREDITS_MODE=enforce` (off); grants (migration 0022); reconciliation | `feature/credit-enforcement` → #37 | `a085bc8` | 45207079864 green | A |
| [#39](https://github.com/groverstech/instagram-ai-automation/pull/39) | Email verification, invitation emails, security notifications; Postmark/Resend adapters (migration 0023); extended lifecycle E2E | `feature/email-verification-invites` → #38 | `58a0f91` | 45302392288 green (includes the lifecycle step) | A |

**Stack order:** main → #12 → #13 → #14 → #15 → #17 → #18 → #19 → #20 → #21 → #22 → #23 → #24 → #25 → #26 → #27 → #29 → #28 → #30 → #31 → #32 → #34 → #33 → #35 → #36 → #37 → #38 → #39. **Linear**: #33 merged `feature/sandbox-lifecycle` and was retargeted onto #34; #35 merged #33 and was retargeted onto it. The lifecycle journey now goes through the publish ledger. #11 and #16 are independent.

**Migrations:** 0011 (#12), 0012 (#15), 0013 (#17), 0014 (#19), 0015 (#20), 0016 (#25), 0017 (#29), 0018 (#30), 0019 (#33), 0020 (#36), 0021 (#37), 0022 (#38), 0023 (#39). **Next free: 0024.**

## 2. Active work

None in progress: every authorised engineering item is in review (#12–#39). What remains needs owner decisions, infrastructure or external parties: see [PRIVATE_BETA_DECISIONS_REQUIRED.md](PRIVATE_BETA_DECISIONS_REQUIRED.md).

## 3. Known problems

- **Resolved:** the #33 gaps (`publish_attempts` in the RLS pilot and the organisation export) are fixed in #36.
- **Lifecycle runner (fixed in #39):** the E2E runner left the Next.js child process running after a run, so the next local run reached a stale server against a dropped database. The server now runs in its own process group, and the runner refuses a busy port.

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
| 23 Nov 2026 | Opened #32 (RLS strict-mode refusal) and #34 (social sandbox, plus the lifecycle journey: 10/10 locally, now a CI step). Session B opened #33 (PR 4.4a, 0019). CI green on #28, #30, #31, #32 and #33. Next (A): R-P1-7 load test and ASVS review; credit enforcement stays owner-gated (D-17). |
| 23 Nov 2026 | #34 CI green including the new lifecycle step (45183763244); regression 19/16/10/20 on the #34 build. Opened #35: load test (no errors at 10 and 25 concurrent clients; calendar ~20 pages/s, CPU-bound) and ASVS L2 self-review (gaps become decisions D-26 and D-27). |
| 23 Nov 2026 | Stack relinearised: #31 → #32 → #34 → #33 → #35 (merges only). Top of stack 472/472 on PG16. Session B has stopped new work and handed the next items back. Decisions: added autonomy levels and the plan-status confirmation to D-3. |
| 23 Nov 2026 | Full completion mandate. Verified: nothing merged; CI green on #33 (45184903930) and #35 (45186220958). Opened #36 (publish_attempts RLS + export + history, 0020), #37 (autonomy levels, 0021), #38 (PR 4.6 credit enforcement, off; 0022) and #39 (email verification, invitations, notifications, provider adapters; 0023; extended lifecycle E2E). Full suite 512/512 on PG16; lifecycle journey passes end to end, including verification, invitation, export and autonomy checks. The Phase 4 plan is recorded as the approved baseline, with the autonomy levels added. |
| 24 Nov 2026 | Owner review stage. Re-verified all 30 PRs: the same latest commits as reported, every one green on its latest commit, `main` unchanged (`b8a8353`). Integrated tree (stack + #16 + #11) merges with only the known `SECURITY.md` row; 513/513 tests and the browser journey 15/15 passed on stack + #16. **Defect found and fixed on #39 (`58a0f91`): `reviewer:setup` created the Meta reviewer unverified, which would block the review now that verification is required.** Added PRIVATE_BETA_OWNER_DECISION_PACK.md, the single register of open decisions. |

## 6. Operator emergency stop: every brand at once (pre-approval requested, decision F-6)

For an incident that needs all publishing stopped immediately, before an organisation-wide pause exists in the app. This is a production data change, so it runs only with your approval: either given in advance by approving F-6, or at the time.

1. **Pause every brand.** Run this with the migrate role:

   ```sql
   UPDATE brands SET publishing_paused_at = now(), publishing_pause_reason = 'Platform emergency stop' WHERE publishing_paused_at IS NULL;
   ```

   Every publish refuses at its claim, which re-checks the pause in its transaction immediately before sending. The red "Publishing paused" bar shows on every page.
2. **Optionally, stop the worker** (or the cron caller), so scheduled jobs don't run at all.
3. **Investigate.** The Security log and `agent_actions` show who approved and published what.
4. **Resume brand by brand** in the Content Calendar (admins). Future posts are re-queued; posts whose time passed go back to "approved".
