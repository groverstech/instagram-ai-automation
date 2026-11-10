import "server-only";
import { and, desc, eq, gt, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { keyedHash } from "./crypto";
import { redact, log } from "./log";
import type { AuditOutcome } from "./db/schema";

/**
 * Security audit log (ADR-006). Append-only record of security-sensitive actions: sign-in and
 * sign-up, membership and role changes, brand-scope changes, social account connections,
 * billing changes, and approvals that override checks.
 *
 * Writing an audit event never breaks the action it records: failures are logged instead. Details
 * pass through the same redaction as logs, so secrets and tokens can't be stored even by mistake.
 */
export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.signup"
  | "auth.logout"
  | "member.invite"
  | "member.role_change"
  | "member.brand_scope_change"
  | "member.remove"
  | "workspace.update"
  | "brand.create"
  | "social.connect"
  | "social.disconnect"
  | "billing.checkout_started"
  | "billing.plan_changed"
  | "creative.approve_override"
  | "access.denied"
  | "audit.view";

export type AuditEvent = {
  action: AuditAction;
  workspaceId?: string | null;
  brandId?: string | null;
  actorUserId?: string | null;
  actorType?: "user" | "system" | "agent";
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  ip?: string | null;
  details?: Record<string, unknown>;
};

/**
 * Events that people outside the organisation, or a script, can trigger over and over. Each
 * source (the signed-in user, else the client IP) records at most NOISE_LIMIT of each per
 * NOISE_WINDOW_SEC; the next one is recorded once as a "further events not recorded" marker, and
 * the rest of the window is only counted. Flooding requests can't flood the audit table.
 */
const NOISY = new Set<AuditAction>(["access.denied", "auth.login_failed"]);
export const NOISE_LIMIT = 20;
export const NOISE_WINDOW_SEC = 600;

/** How many noisy events this source has produced in the current window, counting this one. */
async function noiseCount(action: AuditAction, source: string, now = new Date()) {
  const db = await getDb();
  const windowMs = NOISE_WINDOW_SEC * 1000;
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(schema.rateLimitBuckets)
    .values({ key: `audit:${action}:${keyedHash(source)}`, windowStart: start, count: 1 })
    .onConflictDoUpdate({ target: [schema.rateLimitBuckets.key, schema.rateLimitBuckets.windowStart], set: { count: sql`${schema.rateLimitBuckets.count} + 1` } })
    .returning({ count: schema.rateLimitBuckets.count });
  return row.count;
}

export async function audit(e: AuditEvent) {
  try {
    const db = await getDb();
    let details = e.details ?? {};
    if (NOISY.has(e.action)) {
      const source = e.actorUserId ? `user:${e.actorUserId}` : e.ip && e.ip !== "unknown" ? `ip:${e.ip}` : "anonymous";
      const n = await noiseCount(e.action, source);
      if (n > NOISE_LIMIT + 1) return;
      if (n === NOISE_LIMIT + 1) {
        details = { ...details, suppressed: true };
        log.warn("audit.suppressed", { action: e.action, limit: NOISE_LIMIT, windowSec: NOISE_WINDOW_SEC });
      }
    }
    await db.insert(schema.auditEvents).values({
      action: e.action,
      workspaceId: e.workspaceId ?? null,
      brandId: e.brandId ?? null,
      actorUserId: e.actorUserId ?? null,
      actorType: e.actorType ?? "user",
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      outcome: e.outcome ?? "success",
      ipHash: e.ip && e.ip !== "unknown" ? keyedHash(`ip:${e.ip}`) : null,
      details: (redact(details) as Record<string, unknown>) ?? {},
    });
  } catch (err) {
    log.error("audit.write_failed", { action: e.action, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Whose events a viewer may see. `brandIds: null` = the whole organisation; an array = only events
 * about those brands (organisation-wide and account events are excluded). Derived from the
 * viewer's membership scope, never from the role alone.
 */
export type AuditScope = { brandIds: string[] | null };

/**
 * A workspace's audit trail, newest first. The caller has already authorised the viewer (see
 * auditTrailFor).
 *
 * - **Whole-organisation scope:** the workspace's own events, plus account-level sign-in events
 *   (sign-in, failed sign-in, sign-out) of the workspace's current members, **only from when they
 *   joined this workspace**. Those events aren't tied to one workspace, so they can't otherwise
 *   be attributed. A member's history from before they joined, and everyone else's events, stay
 *   hidden. Failed sign-ins for unknown emails belong to no tenant and appear in no log.
 * - **Brand scope:** only this workspace's events about those brands.
 */
export async function auditTrail(workspaceId: string, opts: { limit?: number; before?: Date; scope?: AuditScope } = {}) {
  const db = await getDb();
  const e = schema.auditEvents;
  const brandIds = opts.scope?.brandIds ?? null;
  const where = brandIds
    ? brandIds.length
      ? and(eq(e.workspaceId, workspaceId), inArray(e.brandId, brandIds))
      : sql`false`
    : or(
        eq(e.workspaceId, workspaceId),
        and(
          isNull(e.workspaceId),
          like(e.action, "auth.%"),
          sql`exists (select 1 from ${schema.workspaceMembers} wm where wm.workspace_id = ${workspaceId} and wm.user_id = ${e.actorUserId} and wm.status = 'active' and wm.created_at <= ${e.createdAt})`,
        ),
      );
  return db
    .select()
    .from(e)
    .where(and(where, opts.before ? lt(e.createdAt, opts.before) : undefined))
    .orderBy(desc(e.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

export type AuditRow = {
  id: string;
  action: string;
  outcome: string;
  actorType: string;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  brandId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
};

/**
 * Detail fields the Security log may show. Everything else stays on the server (email hashes,
 * user and platform account ids), whatever a call site stored.
 */
const SHOWN_DETAILS = ["from", "to", "role", "plan", "status", "platform", "reason", "needed", "scope", "type", "scopedBrands", "existingUser", "member", "acceptedInvites", "suppressed"] as const;
export function shownDetails(d: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SHOWN_DETAILS) {
    const v = d?.[k];
    const scalar = v === null || ["string", "number", "boolean"].includes(typeof v);
    const ids = Array.isArray(v) && v.every((x) => typeof x === "string"); // brand ids (scope changes)
    if (v !== undefined && (scalar || ids)) out[k] = v;
  }
  if (Array.isArray(d?.accounts)) out.accounts = d.accounts.length; // a count, never platform ids
  return out;
}

/** Viewing the log is itself audited, at most once per viewer and workspace per hour. */
const VIEW_AUDIT_EVERY_MS = 60 * 60 * 1000;

/**
 * The Settings "Security log". Needs an active owner or admin membership of this workspace. What
 * the viewer sees follows their membership's brand scope (see AuditScope), so an admin role alone
 * never widens it. Refusals are recorded as `access.denied`.
 *
 * Actor names are shown only for current members of this workspace (and "System"), so the log
 * never reveals who someone outside the organisation is.
 */
export async function auditTrailFor(session: import("./auth/session").SessionUser, workspaceId: string, limit = 50): Promise<{ rows: AuditRow[]; scope: AuditScope }> {
  const { AccessError } = await import("./auth/guard");
  const { roleAtLeast } = await import("@/lib/roles");
  const db = await getDb();
  const wm = schema.workspaceMembers;
  const [me] = await db
    .select()
    .from(wm)
    .where(and(eq(wm.workspaceId, workspaceId), eq(wm.userId, session.user.id), eq(wm.status, "active")))
    .limit(1);
  if (!me || !roleAtLeast(me.role, "admin")) {
    await audit({ action: "access.denied", workspaceId, actorUserId: session.user.id, outcome: "denied", targetType: "security_log", targetId: workspaceId, details: { needed: "admin", member: Boolean(me) } });
    throw new AccessError();
  }
  // Only brands that still belong to this workspace count towards a brand scope.
  let brandIds: string[] | null = null;
  if (Array.isArray(me.brandIds)) {
    const owned = me.brandIds.length ? await db.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.workspaceId, workspaceId), inArray(schema.brands.id, me.brandIds))) : [];
    brandIds = owned.map((b) => b.id);
  }
  const scope: AuditScope = { brandIds };

  const [recent] = await db
    .select({ id: schema.auditEvents.id })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.action, "audit.view"), eq(schema.auditEvents.workspaceId, workspaceId), eq(schema.auditEvents.actorUserId, session.user.id), gt(schema.auditEvents.createdAt, new Date(Date.now() - VIEW_AUDIT_EVERY_MS))))
    .limit(1);
  if (!recent) await audit({ action: "audit.view", workspaceId, actorUserId: session.user.id, targetType: "security_log", targetId: workspaceId, details: { scope: brandIds ? "brands" : "organisation" } });

  const rows = await auditTrail(workspaceId, { limit, scope });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x)))];
  const members = actorIds.length
    ? await db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(wm)
        .innerJoin(schema.users, eq(schema.users.id, wm.userId))
        .where(and(eq(wm.workspaceId, workspaceId), inArray(wm.userId, actorIds)))
    : [];
  const nameOf = new Map(members.map((u) => [u.id, u.name || u.email]));
  return {
    scope,
    rows: rows.map((r) => ({
      id: r.id,
      action: r.action,
      outcome: r.outcome,
      actorType: r.actorType,
      actorName: r.actorUserId ? (nameOf.get(r.actorUserId) ?? "Not a current member") : r.actorType === "system" ? "System" : null,
      targetType: r.targetType,
      targetId: r.targetId,
      brandId: r.brandId,
      details: shownDetails(r.details),
      createdAt: r.createdAt,
    })),
  };
}
