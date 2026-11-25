import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { audit } from "./audit";
import { requireBrandForUser, requireWorkspaceRoleForUser } from "./auth/guard";
import { requireRecentSecondFactor } from "./auth/step-up";
import { verifyPassword } from "./auth/password";
import type { SessionUser } from "./auth/session";
import { enforce } from "./ratelimit";
import { purgeBrand, purgeWorkspace } from "./purge";

/**
 * Self-service deletion (PR 4.3; data-deletion page, launch gate D3): a brand, an organisation, or
 * your own account. Each removes the data from the database and the brand's stored files.
 *
 * Kept, because they hold no brand content and other obligations need them:
 *   - the AI usage ledger (`usage_events`), for billing reconciliation;
 *   - the Security log (`audit_events`), for security investigations;
 *   - Stripe's own records.
 * Their rows keep the deleted internal IDs (and, in `social.connect` events, platform account IDs)
 * but no names, text or files.
 *
 * Refused (nothing is deleted) while an AI job is still running for a brand, while a post is being
 * published, while an organisation has a paid subscription that is still active, or when deleting an
 * account would leave an organisation with other members but no owner.
 */
export class DeletionError extends Error {}

const LIVE_SUBSCRIPTION = ["active", "trialing", "past_due", "unpaid", "incomplete"];

/** Re-check the password before deleting an organisation or account (rate-limited like sign-in). */
async function confirmPassword(userId: string, password: string) {
  await enforce("login", { key: `reauth:${userId}` });
  const db = await getDb();
  const [u] = await db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId));
  if (!u || !password || !(await verifyPassword(password, u.hash))) throw new DeletionError("That password isn't right.");
}

async function brandBlocker(brandId: string, name: string): Promise<string | null> {
  const db = await getDb();
  const [task] = await db
    .select({ id: schema.aiTasks.id })
    .from(schema.aiTasks)
    .where(and(eq(schema.aiTasks.brandId, brandId), inArray(schema.aiTasks.status, ["queued", "running"])))
    .limit(1);
  if (task) return `An AI job is still running for ${name}. Wait for it to finish, then try again.`;
  const [pub] = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(and(eq(schema.posts.brandId, brandId), eq(schema.posts.status, "publishing")))
    .limit(1);
  if (pub) return `A post for ${name} is being published right now. Try again in a minute.`;
  return null;
}

async function workspaceBlocker(workspaceId: string): Promise<string | null> {
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  if (!ws) return null;
  if (ws.stripeSubscriptionId && LIVE_SUBSCRIPTION.includes(ws.subscriptionStatus ?? "")) {
    return `${ws.name} has an active subscription. Cancel it in Billing first, then delete the organisation.`;
  }
  for (const b of await db.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(eq(schema.brands.workspaceId, workspaceId))) {
    const why = await brandBlocker(b.id, b.name);
    if (why) return why;
  }
  return null;
}

/** Delete a brand. Organisation owners and admins with access to every brand; confirmed by typing its name. */
export async function deleteBrandFor(session: SessionUser, brandId: string, confirmName: string) {
  const { brand } = await requireBrandForUser(session, brandId, "viewer");
  await requireWorkspaceRoleForUser(session, brand.workspaceId, "admin");
  // Irreversible: a recent second factor, like member, billing and social-account changes (F3b).
  await requireRecentSecondFactor(session);
  if ((confirmName ?? "").trim() !== brand.name.trim()) throw new DeletionError("Type the brand's name exactly to confirm.");
  const why = await brandBlocker(brand.id, brand.name);
  if (why) throw new DeletionError(why);
  const out = await purgeBrand(brand.id);
  await audit({ action: "brand.delete", workspaceId: brand.workspaceId, brandId: brand.id, actorUserId: session.user.id, targetType: "brand", targetId: brand.id, details: { filesRemoved: out.filesRemoved } });
  return out;
}

/** Delete an organisation with all its brands. Owners only; confirmed with their password. */
export async function deleteWorkspaceFor(session: SessionUser, workspaceId: string, password: string) {
  await requireWorkspaceRoleForUser(session, workspaceId, "owner");
  await requireRecentSecondFactor(session);
  await confirmPassword(session.user.id, password);
  const why = await workspaceBlocker(workspaceId);
  if (why) throw new DeletionError(why);
  // Recorded first: the event keeps the organisation's ID for the Security log's retention period.
  await audit({ action: "workspace.delete", workspaceId, actorUserId: session.user.id, targetType: "workspace", targetId: workspaceId });
  return purgeWorkspace(workspaceId);
}

export type AccountDeletionPlan = {
  /** Organisations where you're the only active member: deleted with your account. */
  deleted: { id: string; name: string }[];
  /** Organisations you just leave (another owner remains). */
  left: { id: string; name: string }[];
  /** Organisations that stop the deletion: other members, and you're the only owner. */
  blocked: { id: string; name: string }[];
};

/** What deleting your account would do, for the confirmation screen. */
export async function accountDeletionPlan(userId: string): Promise<AccountDeletionPlan> {
  const db = await getDb();
  const mine = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId, role: schema.workspaceMembers.role, name: schema.workspaces.name })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(and(eq(schema.workspaceMembers.userId, userId), eq(schema.workspaceMembers.status, "active")));
  const plan: AccountDeletionPlan = { deleted: [], left: [], blocked: [] };
  for (const m of mine) {
    const others = await db
      .select({ role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, m.workspaceId), eq(schema.workspaceMembers.status, "active"), ne(schema.workspaceMembers.userId, userId)));
    const entry = { id: m.workspaceId, name: m.name };
    if (!others.length) plan.deleted.push(entry);
    else if (m.role === "owner" && !others.some((o) => o.role === "owner")) plan.blocked.push(entry);
    else plan.left.push(entry);
  }
  return plan;
}

/** Delete your own account, confirmed with your password. Organisations only you belong to are deleted with it. */
export async function deleteAccountFor(session: SessionUser, password: string) {
  await requireRecentSecondFactor(session);
  await confirmPassword(session.user.id, password);
  const plan = await accountDeletionPlan(session.user.id);
  if (plan.blocked.length) {
    throw new DeletionError(`Make another member an owner of ${plan.blocked.map((w) => w.name).join(", ")}, or delete ${plan.blocked.length === 1 ? "that organisation" : "those organisations"}, first.`);
  }
  for (const w of plan.deleted) {
    const why = await workspaceBlocker(w.id);
    if (why) throw new DeletionError(why);
  }
  await audit({ action: "account.delete", actorUserId: session.user.id, targetType: "user", targetId: session.user.id, details: { organisationsDeleted: plan.deleted.length, organisationsLeft: plan.left.length } });
  for (const w of plan.left) {
    await audit({ action: "member.remove", workspaceId: w.id, actorUserId: session.user.id, targetType: "user", targetId: session.user.id, details: { reason: "account_deleted" } });
  }
  for (const w of plan.deleted) await purgeWorkspace(w.id);
  const db = await getDb();
  await db.delete(schema.users).where(eq(schema.users.id, session.user.id)); // sessions and memberships cascade
  return plan;
}
