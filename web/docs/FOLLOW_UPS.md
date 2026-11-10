# Production-readiness follow-ups

Requirements recorded when PR 4.0 (infrastructure baseline) was approved. **None of these is
implemented by PR 4.0.** The absence of each one is a known gap, documented in
[SECURITY.md](SECURITY.md) and [DEPLOYMENT.md](DEPLOYMENT.md), and not evidence that it's done.
Update the status here only when the work is merged **and** its acceptance checks pass.

| # | Requirement | Status | Target | Acceptance |
|---|---|---|---|---|
| F1 | **Sign-up privacy:** sign-up must not reveal whether an email is already registered | **Not implemented.** Sign-up currently answers "An account with this email already exists." | With email verification, once the email provider exists (PR 4.6 or the email follow-up) | Sign-up gives the same response and timing for new and existing emails; the account owner learns of the attempt by email; tests compare both paths |
| F2 | **Strict Content Security Policy** | **Not implemented.** Only `frame-ancestors`, `base-uri`, `form-action` and `object-src` are set; no `script-src`. | Its own PR before launch (by PR 4.9 at the latest) | Per-request nonces for Next's inline scripts; `script-src 'self' 'nonce-…' 'strict-dynamic'` and no `unsafe-inline`; no CSP violations across the browser regression suite; header tests |
| F3 | **Multi-factor authentication** | **Not implemented**; planning required | Plan now; build it in its own PR after PR 4.6 (email for recovery) and before the first external agency or paying customer | TOTP with hashed recovery codes; required for owners and admins; a fresh second factor for role, member, billing and social-connection changes; "sign out everywhere"; MFA events in the audit log; tests and a browser check |
| F4 | **Audit-log retention and export** | **Not implemented** | PR 4.9 | Configurable retention with scheduled deletion; per-organisation export (CSV or JSON) that keeps the Security log's authorisation and detail allow-list; the export itself is audited; tests |
| F5 | **Horizontal scaling beyond one instance** | **Requirements documented** ([DEPLOYMENT.md §12](DEPLOYMENT.md#12-scaling-beyond-one-instance)); **not implemented or validated**. Production runs one web instance. | R2 in PR 4.2; edge or Redis rate limits and a load test in PR 4.9 | Every §12 requirement met; a load test at the target instance count passes; the §12 list is kept current as features land |
| F6 | **Automated deployment pipeline** | **Not implemented.** CI builds and smoke-tests the image; nothing is pushed or deployed. | Production-readiness roadmap, once the hosting platform is chosen | Image pushed to a registry per commit; the migrate step runs before web; rolling deploy gated on `/api/health/ready`; a manual approval gate for production; one-step rollback to the previous image; documented and rehearsed |

Other prerequisites that stay open (hosting decision, managed Postgres and Redis, error tracker,
email provider, API keys and real-provider validation, egress firewall, penetration test) are in
[DEPLOYMENT.md §10](DEPLOYMENT.md#10-outstanding-production-prerequisites).
