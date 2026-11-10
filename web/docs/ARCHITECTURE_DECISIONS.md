# Architecture decisions (Phase 4 infrastructure baseline)

Decisions made in PR 4.0, with their impact on later phases. Decisions that are still open are
marked **pending**.

## ADR-001: One container image, three roles; hosting stays open

- **Context:** production needs web servers, background workers and a migration step. The hosting
  platform hasn't been chosen.
- **Decision:**
  - One image (`web/Dockerfile`) with roles `web` (default), `worker` and `migrate`.
  - A small entrypoint `exec`s each process so it receives `SIGTERM` directly.
  - TypeScript roles run as `node --import tsx`, a single process. The tsx CLI's child process was
    killed by `SIGTERM` before it could drain (found by testing the image).
  - `next.config` is plain JavaScript, because `next.config.ts` makes `next start` try to install
    TypeScript at run time, which hung the production container (also found by testing the image).
- **Consequences:**
  - The same artifact runs on any container platform, and switching hosts changes only deployment
    configuration.
  - **Pending:** the hosting platform, and the deploy pipeline that depends on it. CI builds and
    smoke-tests the image but pushes and deploys nothing.
- **Future phases:** workers scale per queue (`WORKER_QUEUES`). The video pipeline (P4-8) can add a
  `media` role in the same image.

## ADR-002: Explicit deployment environment and fail-fast configuration

- **Context:** `NODE_ENV=production` is also used by every local `next start` (demos, E2E runs),
  so it can't decide how strict to be. Misconfiguration was previously found only at use time.
- **Decision:**
  - `DEPLOY_ENV` (development, test, demo, staging, production).
  - `src/server/config.ts` validates every variable at boot for the web, worker and migrate roles.
  - In staging and production, errors stop the process; elsewhere they are warnings.
  - **Fail closed:** an unknown `DEPLOY_ENV` is treated as strict and refused; invalid values of
    other settings are errors rather than silent defaults; the container image defaults to
    `DEPLOY_ENV=production`, so forgetting it can't switch the safeguards off.
  - Only variable names are ever reported.
- **Consequences:**
  - Existing local, demo and E2E setups keep working unchanged.
  - Production can't start in demo AI mode, on PGlite, on local disk (without the explicit
    opt-in), with a weak secret, or with half-configured integrations.
- **Future phases:** each new integration (R2, email, Sentry, platform apps) adds its checks here.

## ADR-003: Migrations under an advisory lock, as a separate deploy step

- **Context:** migrations ran at every app start with no lock. Several instances starting together
  could race.
- **Decision:**
  - On Postgres, migrations run on one connection holding a session advisory lock
    (`src/server/db/migrate.ts`).
  - `npm run db:migrate` (the `migrate` role) is the deploy step.
  - App instances **never migrate on start in staging or production** (`MIGRATE_ON_START` is off
    there by default, and production refuses `true`). Development, demo and test keep migrating
    on start, so local setups are unchanged.
  - Readiness reports pending migrations.
  - All migrations are additive (expand and contract).
- **Consequences:**
  - Verified on real Postgres: three concurrent runs apply each migration exactly once.
  - Rollback is redeploying the previous image; the schema stays compatible.
- **Future phases:** migrations 0008–0014 (PRs 4.1–4.9) follow the same rules, each with an upgrade
  test. Large-table index changes run `CONCURRENTLY` in a separate step.

## ADR-004: Provider-independent storage; no silent dependency on local disk

- **Context:** all files were on local disk, which ties production to one server.
- **Decision:**
  - `StorageProvider` interface (`put`, `get`, `remove`, `exists`, `health`) with drivers chosen by
    `STORAGE_DRIVER`.
  - `local` exists now. `s3` (Cloudflare R2 and AWS S3 through one S3-compatible adapter) arrives in
    PR 4.2, and selecting it earlier fails loudly instead of silently falling back.
  - Staging and production refuse local disk unless `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true` is set
    deliberately, for a single-instance pilot.
  - Writes are atomic (temp file, then rename, with a unique temp name per write). Keys are
    validated so nothing can escape the storage root.
- **Consequences:**
  - Existing callers are unchanged, since everything already went through `storage`.
  - **Production can't run multi-instance until PR 4.2**, which is deliberate.
- **Future phases:** PR 4.2 adds the S3 driver, tenant key layout, presigned URLs, render cache and
  migration job behind this interface.

## ADR-005: Security headers and trusted client IPs

- **Decision:**
  - Every response carries HSTS, `nosniff`, a strict referrer policy, `X-Frame-Options: DENY`, a
    Permissions-Policy, COOP and a minimal CSP (`frame-ancestors 'none'; base-uri 'self';
    form-action 'self'; object-src 'none'`), without `X-Powered-By`.
  - The client IP comes from the trusted proxy hop (`TRUSTED_PROXY_HOPS`) or an edge header
    (`CLIENT_IP_HEADER`), never the client-controlled leftmost `X-Forwarded-For` entry.
- **Consequences:** with one overwriting proxy, behaviour is identical to before; behind appending
  proxies, IP-based limits can no longer be bypassed.
- **Follow-up:** a `script-src` CSP needs per-request nonces for Next's inline scripts, and is
  tracked separately (SECURITY.md).

## ADR-006: Append-only security audit log

- **Decision:**
  - An `audit_events` table records sign-ins (including failures), sign-ups, membership, role and
    brand-scope changes, workspace changes, brand creation, social connections, billing changes
    and creative approval overrides.
  - IPs are stored only as keyed hashes. Details pass through log redaction.
  - Rows survive user and brand deletion (no cascades).
  - Writing an audit event never breaks the action it records.
  - Owners and admins read it in **Settings → Security log**. What they see follows their
    membership's brand scope, never the role alone: whole-organisation access sees organisation
    events and members' sign-ins (only from when each member joined); a brand-scoped viewer would
    see only those brands' events. Editors, viewers, client users and outsiders are refused.
  - Refused access (other organisations' brands or workspaces, out-of-scope brands, insufficient
    role, the log itself) is recorded as `access.denied` against the organisation that owns the
    resource. Viewing the log is recorded too (`audit.view`, at most hourly per viewer).
- **Future phases:** autonomous-agent actions (P4-6 `agent_actions`) and credit changes (PR 4.5)
  build on the same pattern. Retention and export come in PR 4.9.

## ADR-007: Vendor-neutral monitoring and email hooks

- **Context:** the error-tracking and email providers haven't been chosen.
- **Decision:**
  - `captureError` gives every unexpected error a reference ID and a structured log line, and
    forwards it to registered reporters. Next's `onRequestError` uses it.
  - Database and system error messages are never shown to users.
  - Every response carries `X-Request-Id`.
  - `sendEmail` has a `log` driver that never claims delivery and is refused in staging and
    production.
- **Consequences:** adding Sentry (or another tracker) or an email provider is a small adapter, with
  no call-site changes. **Pending:** both provider choices.

## ADR-008: Background jobs, safe to retry and never duplicate a publish

- **Context:** a review of the job system found two duplicate-publish paths:
  - "publish now" racing the scheduler. **Reproduced**: the same post was published 3 times.
  - A publish job re-claimed after its worker died mid-flight.
- **Decision:**
  - The post moves to `publishing` with one conditional update, so only one caller can publish.
  - The queue lets each job type decide what happens when its previous run was interrupted.
    A publish that had started (post in `publishing`) is **never re-sent automatically**: the post
    is marked failed with "check the account before retrying". One interrupted before it started
    runs again (nothing was sent, and the atomic claim still blocks a post that already went
    out). Metric syncs, which are idempotent, retry normally.
  - Workers take queue roles and drain gracefully.
- **Consequences:**
  - A crash can at worst leave a post *maybe* published, flagged for a human, never published twice
    by the system.
  - AI tasks keep their existing durable engine (claims, heartbeats, idempotent steps, recovery).
- **Future phases:** the publish-attempt ledger with platform reconciliation (PR 4.4) replaces the
  human check with an automatic read-back where the platform API allows it.
