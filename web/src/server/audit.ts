import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
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
  | "creative.approve_override";

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

export async function audit(e: AuditEvent) {
  try {
    const db = await getDb();
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
      details: (redact(e.details ?? {}) as Record<string, unknown>) ?? {},
    });
  } catch (err) {
    log.error("audit.write_failed", { action: e.action, error: err instanceof Error ? err.message : String(err) });
  }
}

/** A workspace's audit trail, newest first (owners/admins only; the caller checks the role). */
export async function auditTrail(workspaceId: string, opts: { limit?: number; before?: Date } = {}) {
  const db = await getDb();
  return db
    .select()
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.workspaceId, workspaceId), opts.before ? lt(schema.auditEvents.createdAt, opts.before) : undefined))
    .orderBy(desc(schema.auditEvents.createdAt))
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
 * The Settings "Security log": workspace owners and admins with access to every brand only.
 * Brand-scoped (client) users are refused, because the log covers the whole organisation.
 */
export async function auditTrailFor(session: import("./auth/session").SessionUser, workspaceId: string, limit = 50): Promise<AuditRow[]> {
  const { requireWorkspaceRoleForUser } = await import("./auth/guard");
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  const rows = await auditTrail(workspaceId, { limit });
  const ids = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x)))];
  const db = await getDb();
  const { inArray } = await import("drizzle-orm");
  const users = ids.length ? await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name || u.email]));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    outcome: r.outcome,
    actorType: r.actorType,
    actorName: r.actorUserId ? (nameOf.get(r.actorUserId) ?? "Former user") : r.actorType === "system" ? "System" : null,
    targetType: r.targetType,
    targetId: r.targetId,
    brandId: r.brandId,
    details: r.details,
    createdAt: r.createdAt,
  }));
}
