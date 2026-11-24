# Owner decision pack: merge review and controlled release

Prepared on 24 Nov 2026, for the owner review and controlled release-preparation stage.

This document is the **single register of open owner decisions**. It replaces the decision lists in `PRIVATE_BETA_DECISIONS_REQUIRED.md`, which now points here. Progress and evidence remain in `PRIVATE_BETA_PROGRESS.md` and `PRIVATE_BETA_ACCEPTANCE_CHECKLIST.md`.

Nothing here has been executed. No PR is merged, nothing is deployed, nothing has been spent, and no real customer or account has been contacted.

Costs are indicative list prices as remembered (**not verified**). Check current pricing before choosing.

## 1. Engineering completion assessment

**Code complete:** every first-release item that doesn't depend on an external service or an owner decision is in review, in 30 open PRs. That covers:
- the Phase 4 baseline;
- the three autonomy levels;
- credit enforcement (off);
- email verification and invitations;
- publish-history isolation.

**Evidence, verified 24 Nov:**
- **CI:** every PR is green on its current latest commit (§2).
- **Integrated test:** the whole stack plus #16 and #11 merges with one known one-line conflict. That combination passes 513/513 tests on PostgreSQL 16 and the 15-step browser journey with no page errors.
- **Dependency audit:** 0 vulnerabilities. **Client-bundle secret check:** passes.

**One defect found and fixed during this review (#39, `58a0f91`):**
- `reviewer:setup` created the Meta reviewer account with its email unverified.
- Verification is required in staging and production since #39, so the platform reviewer would have stopped at "Check your inbox".
- The account is now created as verified, with a test that fails without the fix.

**Not product-ready:** the beta needs the infrastructure, providers, legal text, platform approvals and reviews in §4. None of them can be completed in code.

## 2. PRs: order, latest commits, CI

`main` is still `b8a8353`, so nothing has been merged since #10.

| Order | PR | Branch → base | Latest commit | Latest CI run | Changed since the last report? |
|---|---|---|---|---|---|
| 1 | #11 readiness docs | `claude/ai-social-marketing-platform-n9rlh6` → `main` | moves with these docs | green on each push (`d9f8da2`: 45241862254) | docs only |
| 2 | #12 platform readiness (0011) | `feature/p4-platform-readiness` → `main` | `4562fbd` | 45033382749 ✅ | no |
| 3 | #13 self-service deletion | `feature/p4-self-service-deletion` → #12 | `e5ff264` | 45036146002 ✅ | no |
| 4 | #14 Meta pack, reviewer | `feature/p4-review-pack` → #13 | `7c0e99d` | 45037295205 ✅ | no |
| 5 | #15 emergency pause (0012) | `feature/emergency-pause` → #14 | `8ba7657` | 45038847898 ✅ | no |
| 6 | #17 MFA (0013) | `feature/mfa` → #15 | `97139f9` | 45062279085 ✅ | no |
| 7 | #18 step-up | `feature/mfa-step-up` → #17 | `6669d30` | 45065217077 ✅ | no |
| 8 | #19 credits shadow (0014) | `feature/p4-credits-shadow` → #18 | `abbb804` | 45067038811 ✅ | no |
| 9 | #20 kill switch (0015) | `feature/ai-kill-switch` → #19 | `c22bb34` | 45108409393 ✅ | no |
| 10 | #21 audit export, retention | `feature/audit-retention-export` → #20 | `3f11c01` | 45109461233 ✅ | no |
| 11 | #22 organisation export | `feature/tenant-export` → #21 | `5691c83` | 45110486063 ✅ | no |
| 12 | #23 secret rotation | `feature/secret-rotation` → #22 | `f080411` | 45112480510 ✅ | no |
| 13 | #24 postcss override | `fix/postcss-override` → #23 | `7526702` | 45113497809 ✅ | no |
| 14 | #25 RLS pilot (0016) | `feature/rls-pilot` → #24 | `5f5e220` | 45115332161 ✅ | no |
| 15 | #26 job alerts | `feature/job-alerts` → #25 | `55e0d8d` | 45116319604 ✅ | no |
| 16 | #27 required-MFA enforcement | `fix/required-mfa-enforcement` → #26 | `52e9415` | 45169193918 ✅ | no |
| 17 | #29 invite-only sign-up (0017) | `feature/invite-only-signup` → #27 | `495d693` | 45170143027 ✅ | no |
| 18 | #28 reviewer MFA | `fix/reviewer-mfa` → #29 | `580f63c` | 45180174897 ✅ | no |
| 19 | #30 account recovery (0018) | `feature/account-recovery` → #28 | `507c5d5` | 45180294021 ✅ | no |
| 20 | #31 export memory | `fix/export-memory` → #30 | `02c89b2` | 45180297592 ✅ | no |
| 21 | #32 RLS strict refusal | `fix/rls-strict-refusal` → #31 | `be65893` | 45181093942 ✅ | no |
| 22 | #34 sandbox, lifecycle E2E | `feature/sandbox-lifecycle` → #32 | `2ffc201` | 45183763244 ✅ | no |
| 23 | #33 publish ledger (0019) | `feature/p4-publish-ledger` → #34 | `dd068a3` | 45184903930 ✅ | no |
| 24 | #35 load test, ASVS review | `docs/load-asvs-review` → #33 | `e97d37b` | 45186220958 ✅ | no |
| 25 | #36 publish_attempts isolation (0020) | `feature/publish-attempts-isolation` → #35 | `a53cf9e` | 45203675000 ✅ | no |
| 26 | #37 autonomy levels (0021) | `feature/autonomy-levels` → #36 | `f0518e9` | 45205797867 ✅ | no |
| 27 | #38 credit enforcement, off (0022) | `feature/credit-enforcement` → #37 | `a085bc8` | 45207079864 ✅ | no |
| 28 | #39 email, invitations (0023) | `feature/email-verification-invites` → #38 | **`58a0f91`** | 45302392288 ✅ (including the browser journey) | **yes:** the reviewer fix in §1 |
| 29 | #16 strict CSP | `feature/strict-csp` → `main` | `3259597` | 45060385217 ✅ | no |

**Migrations:**
- `0011`–`0023`, contiguous, with no gaps or duplicates. The journal has 24 entries (`0000`–`0023`); #11 and #16 add none. The next free number is `0024`.
- They are additive. Two also write data:
  - `0014` seeds the plan configuration;
  - `0023` marks accounts that existed before email verification as verified.
- The RLS migrations (`0016`, `0020`, `0021`, `0022`) enable policies that change nothing until `RLS_PILOT=on` sets an organisation.

## 3. Merge sequence and risks

### Recommended method

Use GitHub's **"Create a merge commit"** for every PR.
- **Not "Squash" or "Rebase":** both replace the commits that the next PR in the stack builds on. The next PR would then show the earlier changes again and conflict.
- **Don't merge out of order.**

### Sequence

1. **#11 (docs).** It merges cleanly with everything.
2. **#12 → #39 in the order of §2,** one at a time. After each merge, the next PR's base must become `main`:
   - GitHub does this automatically when the merged PR's branch is deleted on merge ("Automatically delete head branches", or the Delete branch button).
   - Otherwise, edit the next PR's base to `main` before merging it.
   - Never delete a branch whose child PR hasn't been retargeted: GitHub would close that child PR.
3. **#16 last.** One table row in `docs/SECURITY.md` conflicts with the stack.
   - Update #16 from `main` (a merge commit, no history rewrite). Keep both rows: the CSP row from #16 and the MFA row from the stack.
   - Wait for #16's CI, then merge it. This exact resolution was tested: 513/513 and the browser journey 15/15.
   - Updating #16's branch needs your go-ahead at that point (decision A-2).
4. **Wait for a final green CI run on `main` after the last merge.**
   - CI cancels an older run on `main` when a newer one starts, so only the last merge's run is guaranteed to finish.
   - Treat that run as the merge gate before anything is deployed.

**Faster alternative:** review everything, retarget #39 to `main`, and merge it once. It brings in the whole stack. GitHub normally marks the contained PRs as merged; close any that it doesn't, with a comment. This is quicker but leaves less per-PR traceability. I recommend the one-at-a-time sequence.

### Remaining merge risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A PR closes by accident because its base branch was deleted before retargeting | Medium with 28 stacked PRs | Retarget first, or let GitHub auto-retarget on merge. Check each next PR's base before merging it |
| The `SECURITY.md` conflict | Certain, trivial | Step 3 above |
| `main` CI cancelled during fast merges | Certain | The final run on `main` is the gate (step 4) |
| Deploying a partly merged `main` | Low | Don't deploy until #39 and #16 are both merged and `main` is green |
| Behaviour changes users notice after deployment | Expected | Invitations now wait for acceptance. Email verification is required in staging and production, so **staging needs the email provider first** (§5 step 5). Owners and admins must set up two-step verification at first sign-in |
| No human review of the code yet (checklist Q2) | — | Review in the stack order. Each PR description lists its tests and risks |

## 4. Consolidated decision register

**Resolved and not repeated:**
- **D-2:** the beta definition, confirmed on 24 Nov: Assisted, a person approves every post, Autonomous off, credits not enforced.
- **D-3:** scope. The Phase 4 plan is the baseline, and the autonomy levels are built.

**Column key:**
- **Blocks:** M = merge, D = deployment, B = beta launch.
- **Defer?** says whether the decision can safely wait.

### A. Merge approval

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| A-1 (D-1) | Review and merge the 30 PRs | Approve, in the §3 sequence | Everything downstream needs `main` | Reviewer time: 28 merges plus CI | No customer impact until deployed | M, D, B | No |
| A-2 | Merge method, and permission to update #16 from `main` when its turn comes | Merge commits; yes to the #16 update (a merge, no history rewrite) | The only method that keeps the stack intact. The #16 conflict is one tested row | None | None | M | No |

### B. Hosting and infrastructure

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| B-1 (D-4) | Hosting, domain and TLS, secrets store | A container platform (Fly.io, Render or Railway): one web and one worker instance, managed Postgres 16 with PITR, the platform's secret store, a custom domain with TLS | The image is already built and smoke-tested in CI. Least operations for a small beta | ~USD 50–150 a month | Secrets out of the repository; HSTS and TLS at the edge | D, B | No |
| B-2 (D-5) | Production database role | An ordinary role for the app (no superuser, no `BYPASSRLS`); a privileged role only for `db:migrate` | Required for row-level security to mean anything. The app refuses to start if it's wrong with the pilot on | None | Strong tenant-isolation backstop | D | No |
| B-3 (D-6) | RLS pilot | `RLS_PILOT=on` on staging, then production after a week clean | Second isolation layer under the application checks; measured overhead is negligible | None | Limits the damage of any missed filter | B (recommended) | Could wait, but not advised |
| B-4 (D-12) | Backups and restore drill | Managed PITR (7+ days); a restore drill on staging before launch, then monthly | Data-loss protection is a launch gate | Usually included | Recovery from mistakes and incidents | B | No |
| B-5 (D-11) | Outbound firewall | Allow only: Meta Graph, the AI providers, the email provider, Sentry, Stripe; block cloud metadata addresses | The SSRF backstop under the app's own fetch checks | Platform-dependent | Limits server-side request forgery | B | No |
| B-6 (D-10, D-9) | Single instance vs object storage (PR 4.2, R2) | Accept a single-instance beta with local disk on a persistent volume, backed up. Authorise 4.2 before scaling, carousels or Reels | 4.2 is a week of work and isn't needed for single-image beta publishing | R2 later: ~USD 0–15 a month | One instance means a short outage on restarts; acceptable for tens of users | B (the choice) | 4.2 itself: yes |

### C. Email and monitoring

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| C-1 (D-7) | Email provider | Postmark (or Resend). Both adapters are built. Steps in `docs/EMAIL.md`: domain DNS (SPF, DKIM, DMARC), a send-only key in the secret store, egress allow-list | Verification is mandatory in staging and production; invitations and password reset need it | ~USD 0–20 a month | Account recovery and verified addresses; security notifications | D (staging sign-ups), B | No |
| C-2 (D-8) | Error tracking and uptime | Sentry (free or team tier), plus Better Stack or UptimeRobot on `/api/health/ready` and `/api/health/jobs` | Dead jobs, the tripwire and stalled publishing must page someone | ~USD 0–30 a month | Faster incident response | B | No |
| C-3 | Status page | Defer | Unnecessary for tens of invited users | ~USD 0–30 a month | — | — | Yes |

### D. AI spending and budget controls

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| D-1s (D-21) | Live AI validation | Approve the 4-step plan (roadmap §5): expected ≤ USD 7.01, hard cap `AI_SPEND_CAP_USD=10`, dedicated keys with a provider budget of USD 10 or less, Anthropic first | Real providers are unverified beyond one connectivity call | ≤ USD 10 one-off | No customer data used | B | No |
| D-2s (D-13) | `AI_TRIPWIRE_USD` | USD 5 per provider per 15 minutes, tuned after a week | Stops runaway spend automatically | None | — | D | No |
| D-3s (D-14) | `AI_MONTHLY_COST_LIMIT_USD` | USD 20 per beta organisation | Caps any one organisation | Bounds your bill | Customers see a clear limit message | D | No |
| D-4s (D-15) | Provider-side budgets | Monthly budgets at the expected total; **auto-reload off** | Last line of defence outside the app | None | — | D | No |
| D-5s (D-17) | Credit enforcement (`CREDITS_MODE=enforce`) | **Keep shadow mode for the beta.** Compare with `npm run credits -- shadow` and `-- reconcile`; decide allowances and the credit value before paid plans | Hard limits already exist without it (run quota, organisation USD limit, tripwire, kill switch) | None now | None now | — | Yes, until paid plans |
| D-6s (D-16) | Audit-log retention | Keep the 400-day default | Matches the drafted privacy text | None | — | — | Yes |

### E. Legal and platform approvals

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| E-1 (D-19) | Privacy policy, terms, data-deletion text, DPA | Commission from counsel now; the pages exist and show "draft" until final | Needed for Meta review and for inviting anyone | Counsel fees | Legal basis for processing customer data | B | No |
| E-2 (D-24) | Platform terms review (Meta) | Same counsel engagement | Avoids policy strikes | Included above | — | B | No |
| E-3 (D-20) | Meta developer app, business verification, test accounts; then review | **Start now.** It's the longest pole (weeks). The pack and reviewer account are ready (#14, #28, plus today's fix) | Instagram and Facebook publishing is the beta's core | Free; your time | Until approved, beta users can be added as app testers | B (publishing) | No |
| E-4 | LinkedIn and YouTube approvals | Defer: they're labelled "coming soon" | Not in the beta definition | — | — | — | Yes |

### F. Security reviews and beta acceptance

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| F-1 (D-22) | Independent tenant-isolation review | Before the first invitation, scoped to the access guards, RLS and exports. Start from `docs/ASVS_L2_REVIEW.md` | The highest-impact risk for a multi-tenant product | ~2–4 reviewer-days | Customer data separation | B | No |
| F-2 (D-23) | Penetration test | After the staging deploy, before public launch (not before the invite-only beta) | Expensive; most value on the final build | ~USD 5–15k | — | Public launch | Yes, for the private beta |
| F-3 (D-18) | Beta list and `SIGNUP_MODE` | `invite_only` (the default); add invitees with `npm run beta:invite` **only after launch approval** | Keeps the beta closed | None | No uninvited accounts | B | No |
| F-4 (D-25) | Approve the launch and the first invitations | When every gate in §6 is closed | — | — | — | B | — |
| F-5 (D-28) | Autonomous publishing | **Keep off for the beta.** Turn it on only after two weeks on test accounts with zero unapproved restricted posts, duplicates or cap overruns, and after F-6 | Every post then has a human approval | None | Prevents unreviewed public posts | — | Yes |
| F-6 (D-29) | Organisation-wide pause | **Post-beta improvement, but required before F-5 or before onboarding an agency with more than 5 brands.** For the beta: pre-approve the operator emergency stop in `PRIVATE_BETA_PROGRESS.md` §6 | See §7 | ~0.5–1 day to build later | See §7 | — | Yes, under the stated conditions |

### G. Account policies and optional improvements

| ID | Decision | Recommendation | Why | Cost / operations | Security and customer impact | Blocks | Defer? |
|---|---|---|---|---|---|---|---|
| G-1 (D-26) | Password policy | A 12-character minimum for new passwords, plus a Have I Been Pwned k-anonymity check | ASVS L2. About 1 day | Free API; one outbound call per password change | Fewer weak and breached passwords | — | Yes, but do before public launch |
| G-2 (D-27) | Session length | Owners and admins: 12-hour idle, 7-day absolute; others keep 30 days | ASVS L2. About 0.5 day | None | Shorter exposure of stolen admin sessions | — | Yes, but do before public launch |
| G-3 | Sign-up enumeration (S5) | Fix with the email provider: "check your inbox" for both new and existing addresses | Invite-only limits exposure today | ~1 day | Hides which emails have accounts | — | Yes |
| G-4 | Calendar payload optimisation, Next.js 16 upgrade, P2 features | Post-beta | Not needed at beta scale | — | — | — | Yes |

## 5. Deployment sequence (dependency order; nothing executed)

| # | Step | Depends on | Automated | Needs you or a provider |
|---|---|---|---|---|
| 1 | Merge the PRs (§3) and confirm `main` CI is green | A-1, A-2 | CI | You merge |
| 2 | Create the hosting project, Postgres 16 with PITR, a persistent volume, the secret store, and the domain with TLS | B-1, B-4 | Infrastructure config can be scripted | You (account, billing) |
| 3 | Database roles: a privileged role used only by the `migrate` job, and an ordinary role in the web and worker `DATABASE_URL` | 2, B-2 | SQL script can be prepared | You run or approve it |
| 4 | Secrets: `APP_SECRET`, `CRON_SECRET`, provider keys (validation keys only), `DEPLOY_ENV=staging` | 2 | — | You enter them in the secret store (never in chat or the repository) |
| 5 | Email: domain DNS, Postmark or Resend key, `EMAIL_PROVIDER`, `EMAIL_FROM` | C-1 | — | You and the provider |
| 6 | Monitoring: Sentry DSN; uptime checks on `/api/health/ready` and `/api/health/jobs` | C-2 | Checks are defined in DEPLOYMENT §9 | You and the provider |
| 7 | Outbound firewall allow-list, plus a check that metadata addresses are blocked | B-5 | A test script can verify blocked and allowed hosts | You apply it |
| 8 | Object storage: local volume for the beta (B-6); R2 only when 4.2 is authorised | B-6 | — | You |
| 9 | **Staging deploy:** run the image's `migrate` role (DEPLOYMENT §4), then web and worker; `/api/health/ready` returns 200 | 1–7 | Migration, health and smoke checks | You approve the deploy |
| 10 | **Restore drill** on staging: point-in-time restore to a new database, then run the checks | 9, B-4 | Check script | You run it (provider console) |
| 11 | **RLS pilot:** `RLS_PILOT=on` on staging; the app refuses to start if the role bypasses RLS; a week clean | 9, B-3 | Start-up check and tests | You approve the flag |
| 12 | **Spending settings:** tripwire, monthly limit, provider budgets with no auto-reload | D-2s–D-4s | — | You (provider consoles) |
| 13 | **Live AI validation** within the USD 10 cap; reconcile with `npm run ai:billing` | 12, D-1s | `npm run test:live` and the reconciliation | You approve the run |
| 14 | **Meta:** app live with test accounts; live publish tests to test accounts (P6); submit the review | E-1–E-3, 9 | The reviewer account comes from `reviewer:setup` | You and Meta |
| 15 | **Security:** independent isolation review on staging; fix or accept the findings | 9, F-1 | — | External reviewer |
| 16 | **Beta acceptance:** browser journey on staging with the real email provider and Meta test accounts (no real customers); every P0 checklist gate closed or accepted | 9–15 | The lifecycle journey can run against staging | You sign off |
| 17 | **Production deploy:** the same steps as 2–12 on production; `RLS_PILOT=on` after the staging week | 16 | Same as staging | You approve |
| 18 | **Launch:** add the beta list; send the first invitations | 17, F-3, F-4 | `npm run beta:invite` | **You approve** |
| — | Penetration test | 17 | — | External, before public launch |

## 6. Beta launch blockers (all owner or external)

1. Merges, with `main` green (A-1, A-2).
2. Hosting, database role, secrets, backups and restore drill, outbound firewall (B-1, B-2, B-4, B-5).
3. Email provider live (C-1) and monitoring paging someone (C-2).
4. Spending settings set (D-2s to D-4s) and live AI validation passed and reconciled (D-1s).
5. Legal text final and platform terms reviewed (E-1, E-2).
6. Meta: test-account publishing works (P6), and the app is approved or beta users are added as testers (E-3).
7. Independent isolation review done (F-1).
8. Your launch approval (F-4).

## 7. Beta safety defaults and the organisation-wide pause

**Defaults, confirmed in code and documentation, that stay in force for the beta:**

| Default | Where it's enforced | Evidence |
|---|---|---|
| **Assisted** is the default autonomy level for every brand | `brands.autonomy_level` defaults to `assisted` (migration 0021) | `autonomy.test.ts`; the browser journey shows "In effect: Assisted" |
| **Autonomous is disabled** | `AUTONOMOUS_PUBLISHING` defaults to off; Settings can't select it; a brand stored at Autonomous works as Assisted | `autonomy.test.ts` (switch off), browser journey |
| **A person approves every post before publishing: NOT YET GUARANTEED (review finding H1, 24 Nov)** | The publish path refuses a post with no recorded approval, and policy approvals exist only when Autonomous is on. **But until H1 is fixed, an editor can change an approved post's hashtags, target account or format without the approval being invalidated, and the changed post publishes.** A fix is in progress on the hardening PR | Reproduced by review probe P1 |
| **The emergency pause stops publishing that hasn't been sent yet** | The pause is checked when a post is claimed for publishing, at every autonomy level. A publish that was already claimed before the pause can still go out during its few seconds of rendering and sending. **No pause can recall a request already sent to a platform** | Property test: 600 combinations and 500 random contexts never allowed; `autonomy.test.ts` |
| **Credit enforcement disabled until separately authorised** | `CREDITS_MODE` defaults to shadow; enforce only when set explicitly; a warning in staging and production | `credit-enforcement.test.ts` |
| **No automatic AI budget top-ups** | The app has no purchasing or top-up code; grants are only operator-entered (CLI); provider consoles must have auto-reload off (D-4s) | Code review; `docs/CREDITS.md` |
| **No real customer invitations before launch approval** | `SIGNUP_MODE=invite_only` by default in staging and production; the beta list is empty until `npm run beta:invite` is run | `invite-only-signup.test.ts` |

**Organisation-wide pause: recommendation and risk.**
- **Recommendation:** a post-beta improvement, not a beta requirement, under three conditions:
  1. Autonomous stays off.
  2. No organisation in the beta has more than 5 brands.
  3. You pre-approve the operator emergency stop described in `PRIVATE_BETA_PROGRESS.md` §6.
- **Required before** Autonomous (F-5) or larger agencies join.
- **Risk of launching with per-brand pause only:**
  - In an incident across a whole organisation (a compromised admin account, a bad bulk approval, a platform policy problem), someone must pause each brand separately, one click per brand. For an agency with many brands, posts on not-yet-paused brands can go out in the meantime.
  - In the beta this is limited: posts need a person's approval (with the H1 gap until it's fixed), organisations are small, and an operator can stop new publishing for every brand at once (break-glass procedure).
- **The operator emergency stop:** one SQL statement pauses every brand. Each publish then refuses at its claim, because the pause is re-checked there. Stopping the worker also halts scheduled publishing.
- **Caveat:** the SQL stop doesn't cancel queued jobs, but each one refuses at its claim. Resuming is per brand in the Content Calendar, which re-queues future posts.

## 8. Recommended next three actions

1. **Start the long external items today:** create the Meta developer app and start business verification (E-3), and commission the legal text (E-1, E-2). These take weeks and gate everything else.
2. **Choose and set up hosting and providers:** B-1 (container platform with managed Postgres), C-1 (Postmark or Resend), C-2 (Sentry and an uptime checker). Then approve the spending settings and the ≤ USD 10 live validation (D-1s to D-4s).
3. **Review and merge the 30 PRs** in the §3 sequence with merge commits, and approve the #16 update when its turn comes. Afterwards, approve the staging deploy (§5 step 9).

## 9. Confirmation

During this review stage:
- no PR was merged;
- nothing was deployed;
- no infrastructure or external service was changed;
- no paid API call was made;
- no email was sent, and no real customer or social account was used;
- credit enforcement and Autonomous publishing stay off.

**The only repository changes:**
- one defect fix on #39 (§1);
- documentation on #11 (this file and the updates it lists).

No history was rewritten and no branch was force-pushed.
