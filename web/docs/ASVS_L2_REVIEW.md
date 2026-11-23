# OWASP ASVS 4.0.3 Level 2: self-review

Part of the PR 4.9 remainder (roadmap R-P1-7).

**This is a self-assessment by the engineering sessions that wrote the code.** It isn't a substitute for the independent isolation review (F8) or the penetration test (F9): it's the map those reviewers can start from.

The status covers the open-PR stack (#12–#34) as integrated, not `main` alone.

Status values:
- **Met:** implemented, with tests or browser checks as evidence.
- **Partial:** part of the requirement is met; the gap is stated.
- **Gap:** not met.
- **Owner:** depends on hosting or a decision.

## V1 Architecture, design and threat modelling

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Documented security architecture and trust boundaries | Partial | `ARCHITECTURE.md`, `SECURITY.md`, `ARCHITECTURE_DECISIONS.md` | No formal threat model (STRIDE or similar); recommended before the penetration test |
| Centralised access control and validation | Met | `auth/guard.ts` (`requireBrandForUser`, `requireWorkspaceRoleForUser`), `safe()` for actions, zod schemas | — |
| Tenant isolation layered in the database | Partial | Application scoping everywhere; RLS pilot on 4 tenant tables: brands, posts, creatives, publish_attempts (#25, #32, migration 0020) | See `RLS_PILOT.md` |

## V2 Authentication

| Area | Status | Evidence | Gap |
|---|---|---|---|
| 2.1.1 Password length of at least 12 characters | **Gap** | The minimum is **8** (`signUp`, `resetPassword`) | Raising it changes account policy: **decision D-26** |
| 2.1.7 Check against breached passwords | **Gap** | — | Needs an external k-anonymity API (for example Have I Been Pwned) or a bundled list: **decision D-26** |
| 2.2.1 Anti-automation on authentication | Met | Rate limits per email and IP on sign-in, sign-up, MFA, password reset (`ratelimit.ts`); invitation-only sign-up (#29) | — |
| 2.2.3 Notify the user after credential changes | Gap (O3) | Password reset, MFA changes and sign-ins are in the Security log | Emails need a provider (D-7) |
| 2.4 Credential storage | Met | scrypt with per-password salt; rehash on upgrade (`password.ts`) | — |
| 2.5 Credential recovery | Met | #30: random 256-bit single-use tokens, 30 minutes, hashed, no enumeration, sessions ended, MFA kept; audited operator recovery | Delivery by email waits for O3 |
| 2.7 and 2.8 One-time passwords and MFA | Met | TOTP (RFC 6238), replay protection, hashed and key-tagged recovery codes, required for owners and admins and **enforced on actions and routes** (#17, #27), step-up for sensitive actions (#18) | — |

## V3 Session management

| Area | Status | Evidence | Gap |
|---|---|---|---|
| 3.2 Session tokens | Met | 256-bit random token; only its SHA-256 is stored; a new session at sign-in and after MFA | — |
| 3.3.1 Logout invalidates the session | Met | `destroySession` deletes the server-side session row | — |
| 3.3.2 Re-authentication and timeouts | Partial | 30-day absolute expiry; the pending-MFA session lasts 10 minutes; a fresh factor (15 minutes) for sensitive actions | **No idle timeout**, and 30 days is long for admins. Shortening is an account policy: **decision D-27** |
| 3.3.4 See and end other sessions | Partial | "Sign out everywhere else" (#18) | No list of active sessions |
| 3.4 Cookie attributes | Met | `HttpOnly`, `SameSite=Lax`, `Secure` in production, path `/` | — |
| 3.5 Token-based sessions | Met (N/A) | No bearer tokens for users; OAuth state is signed and bound to a browser nonce | — |

## V4 Access control

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Deny by default; checks enforced on the server | Met | Every action and route goes through the guards; `audit-access.test.ts`, `members.test.ts`, `review-hardening.test.ts` | — |
| IDOR on brand and organisation resources | Met | Brand-scoped queries with tests across organisations and brands; the campaign-filter gap was fixed in #25 | Independent review (F8) |
| Sensitive operations need extra verification | Met | Step-up (#18; deletion in #27) | — |
| Administrative interfaces | Met | Operator actions are CLIs only (credits, AI controls, users, beta invites, secrets), each audited | — |

## V5 Validation, sanitisation and encoding

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Input validation | Met | zod schemas on server actions; size limits on text and uploads | — |
| Output encoding and XSS | Met | React escaping; a safe Markdown renderer for legal pages; strict CSP (#16) | — |
| SSRF | Partial | Public-IP-pinned fetcher, ports 80 and 443 only (`web.ts`) | Egress firewall (F7, owner) |
| Injection | Met | Drizzle parameterised queries; no string-built SQL with user input | — |

## V6 Cryptography

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Data at rest | Met | AES-256-GCM with random IVs for OAuth tokens and TOTP secrets; key ids and rotation (#23) | — |
| Randomness | Met | `crypto.randomBytes` for tokens, codes and nonces | — |
| Key management | Partial | `APP_SECRET` with `APP_SECRET_PREVIOUS` rotation | Secret store at deployment (S2, owner) |

## V7 Errors and logging

| Area | Status | Evidence | Gap |
|---|---|---|---|
| No sensitive data in logs or errors | Met | Redaction of secret-looking fields and key-shaped values; reference IDs instead of internal errors | — |
| Security event logging | Met | Audit log of authentication, members, billing, social, AI controls, exports, recovery; retention (#21) | — |
| Log integrity | Partial | Append-only by the application | The same database role could alter rows; a separate audit role later |

## V8 Data protection

| Area | Status | Evidence | Gap |
|---|---|---|---|
| No caching of sensitive responses | Met | `Cache-Control: private, no-store` on pages; `no-store` on exports | — |
| Sensitive data in URLs | Partial | No credentials in URLs | Password-reset tokens are in the link (single use, 30 minutes, `no-referrer`) |
| Privacy: export, deletion, retention | Met | Export (#22), deletion (#13), retention (#21), Meta deletion callback (#12) | Legal text (owner) |

## V9 Communications

| Area | Status | Evidence | Gap |
|---|---|---|---|
| TLS everywhere; HSTS | Partial | HSTS header (2 years, `includeSubDomains`) | TLS termination at the hosting platform (owner) |

## V10 Malicious code

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Dependency vulnerabilities | Met | `npm audit --omit=dev`: 0 (#24); lockfile; CI | — |
| Secrets in the repository and bundles | Met | `check:secrets` in CI | — |

## V11 Business logic

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Limits on business flows | Met | Plan quotas, rate limits, AI spending cap, tripwire, kill switch, credit alerts (#19, #20); one export at a time (#31) | Credit enforcement is PR 4.6 |
| Duplicate and sequence protection | Met | Atomic publish claim; publish ledger and reconciliation (#33); approval before every publish | — |

## V12 Files and resources

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Upload limits and type checks | Met | 15 MB per file, 50 MB per upload, magic-byte detection, zip-bomb limits for DOCX and PPTX | — |
| Active content | Met | SVGs with scripts or event handlers are refused; assets are served with `default-src 'none'` and `nosniff` | — |
| Storage paths | Met | Keys built on the server from IDs; prefix rules (`storage/index.ts`) | — |

## V13 API and web services

| Area | Status | Evidence | Gap |
|---|---|---|---|
| CSRF on state changes | Met | Server actions (Next.js checks Origin against Host); `SameSite=Lax`; the signed OAuth state | GET exports can be triggered cross-site but only download to the victim |
| Webhooks and callbacks | Met | Stripe signature (`constructEvent`); Meta `signed_request` HMAC; cron bearer secret with rate-limited failures | Meta: no age limit without `issued_at` (low) |

## V14 Configuration

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Security headers | Met | CSP with nonces, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `nosniff` | — |
| Configuration validation | Met | `config.ts` refuses unsafe production configuration; container CI checks it | — |
| Debug off in production | Met | Production build; mock AI refused in production unless explicitly allowed | — |

## Summary

- **Gaps:**
  - password length and breached-password check (2.1.1, 2.1.7): owner decision D-26;
  - credential-change notifications (2.2.3): needs email (D-7).
- **Partial:**
  - threat model;
  - RLS coverage;
  - idle timeout and session length (D-27);
  - active-session list;
  - log integrity;
  - SSRF egress firewall;
  - TLS at hosting.
- **Everything else:** met, with evidence in tests or browser checks.
