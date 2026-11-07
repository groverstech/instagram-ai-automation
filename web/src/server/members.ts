import "server-only";
import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db/client";
import { AccessError, inBrandScope, requireBrandForUser, requireWorkspaceRoleForUser } from "./auth/guard";
import { setActiveBrand, type SessionUser } from "./auth/session";
import { assertCanAdd } from "./quota";
import { PLANS, type PlanId } from "@/lib/plans";
import type { Role } from "@/lib/roles";

/**
 * Workspace members, brand-scoped (client) access and brand switching. Every function takes the
 * signed-in session explicitly and authorises it here, so server actions stay thin and the rules
 * are testable without cookies.
 */

export class MemberError extends Error {}

const BrandIds = z.array(z.string().min(1).max(64)).max(200).nullable();

/** Validate a client-user brand scope: brands must belong to this workspace; scoped users can't be admins. */
export async function checkScope(workspaceId: string, role: Role, brandIds: string[] | null | undefined) {
  if (brandIds == null) return null;
  const ids = [...new Set(BrandIds.parse(brandIds) ?? [])];
  if (!ids.length) throw new MemberError("Choose at least one brand, or give access to all brands.");
  if (role === "owner" || role === "admin") throw new MemberError("Admins and owners always have access to every brand. Use the editor or viewer role for client access.");
  const db = await getDb();
  const rows = await db.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.workspaceId, workspaceId), inArray(schema.brands.id, ids)));
  if (rows.length !== ids.length) throw new MemberError("One of those brands isn't in this workspace.");
  return ids;
}

async function memberOf(workspaceId: string, memberId: string) {
  const db = await getDb();
  const [m] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.id, memberId), eq(schema.workspaceMembers.workspaceId, workspaceId)));
  if (!m) throw new MemberError("Member not found.");
  return m;
}

export async function inviteMemberFor(session: SessionUser, workspaceId: string, email: string, role: Role, brandIds?: string[] | null) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  if (role === "owner") throw new MemberError("Invite as admin, then transfer ownership.");
  const scope = await checkScope(workspaceId, role, brandIds);
  const e = z.string().trim().toLowerCase().email("Enter a valid email").parse(email);
  await assertCanAdd(workspaceId, "seats");
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, e));
  const [exists] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), user ? eq(schema.workspaceMembers.userId, user.id) : eq(schema.workspaceMembers.invitedEmail, e)));
  if (exists) throw new MemberError("That person is already a member or has a pending invitation.");
  const [m] = await db
    .insert(schema.workspaceMembers)
    .values(user ? { workspaceId, userId: user.id, role, status: "active", invitedEmail: e, brandIds: scope } : { workspaceId, invitedEmail: e, role, status: "invited", brandIds: scope })
    .returning();
  return m;
}

export async function changeRoleFor(session: SessionUser, workspaceId: string, memberId: string, role: Role) {
  const { role: mine } = await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  if (role === "owner" && mine !== "owner") throw new MemberError("Only the owner can grant ownership.");
  const m = await memberOf(workspaceId, memberId);
  if (Array.isArray(m.brandIds) && (role === "owner" || role === "admin")) throw new MemberError("This member only has access to specific brands. Give them access to all brands first.");
  const db = await getDb();
  if (m.role === "owner" && role !== "owner") {
    const [{ n }] = await db.select({ n: count() }).from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, "owner")));
    if (n <= 1) throw new MemberError("A workspace needs at least one owner.");
  }
  await db.update(schema.workspaceMembers).set({ role }).where(eq(schema.workspaceMembers.id, memberId));
}

/** Limit a member to specific brands (client access), or pass null for every brand. */
export async function setMemberBrandsFor(session: SessionUser, workspaceId: string, memberId: string, brandIds: string[] | null) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  const m = await memberOf(workspaceId, memberId);
  if (m.userId === session.user.id) throw new MemberError("You can't change your own brand access.");
  const scope = await checkScope(workspaceId, m.role, brandIds);
  const db = await getDb();
  await db.update(schema.workspaceMembers).set({ brandIds: scope }).where(eq(schema.workspaceMembers.id, memberId));
  // Sessions whose active brand is no longer allowed fall back to an allowed brand on next load
  // (requireActiveBrand). Clear it now so no request keeps using a revoked brand.
  if (scope && m.userId) {
    const sessions = await db.select({ id: schema.sessions.id, active: schema.sessions.activeBrandId }).from(schema.sessions).where(eq(schema.sessions.userId, m.userId));
    for (const s of sessions) if (s.active && !scope.includes(s.active)) await db.update(schema.sessions).set({ activeBrandId: null }).where(eq(schema.sessions.id, s.id));
  }
  return scope;
}

export async function removeMemberFor(session: SessionUser, workspaceId: string, memberId: string) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  const m = await memberOf(workspaceId, memberId);
  if (m.role === "owner") throw new MemberError("Transfer ownership before removing the owner.");
  if (m.userId === session.user.id) throw new MemberError("You can't remove yourself.");
  const db = await getDb();
  await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, memberId));
}

/** Switch the session's active brand. Only brands the user may access (workspace + brand scope). */
export async function switchBrandFor(session: SessionUser, brandId: string) {
  const access = await requireBrandForUser(session, z.string().min(1).max(64).parse(brandId), "viewer");
  await setActiveBrand(session.sessionId, brandId);
  return access;
}

export type BrandRow = { id: string; name: string; createdAt: Date; active: boolean; colors: string[]; access: { all: number; scoped: number } };
export type MemberRow = { id: string; role: Role; brandIds: string[] | null; status: string; invitedEmail: string | null; userId: string | null; name: string | null; email: string | null };

/**
 * Everything the Settings page shows for one workspace, already filtered for the viewer:
 * brand-scoped (client) members see only their brands and their own membership.
 */
export async function workspaceSettingsFor(session: SessionUser, workspaceId: string, activeBrandId: string) {
  const { role, brandIds: myScope } = await requireWorkspaceRoleForUser(session, workspaceId, "viewer");
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  if (!ws) throw new AccessError();
  const allMembers: MemberRow[] = await db
    .select({ id: schema.workspaceMembers.id, role: schema.workspaceMembers.role, brandIds: schema.workspaceMembers.brandIds, status: schema.workspaceMembers.status, invitedEmail: schema.workspaceMembers.invitedEmail, userId: schema.workspaceMembers.userId, name: schema.users.name, email: schema.users.email })
    .from(schema.workspaceMembers)
    .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  const allBrands = await db.select({ id: schema.brands.id, name: schema.brands.name, createdAt: schema.brands.createdAt, colors: schema.brands.colors }).from(schema.brands).where(eq(schema.brands.workspaceId, workspaceId));
  const scoped = Array.isArray(myScope);
  const brands: BrandRow[] = allBrands
    .filter((b) => inBrandScope(myScope, b.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((b) => ({
      ...b,
      active: b.id === activeBrandId,
      access: scoped ? { all: 0, scoped: 0 } : { all: allMembers.filter((m) => !m.brandIds).length, scoped: allMembers.filter((m) => m.brandIds?.includes(b.id)).length },
    }));
  const members = scoped ? allMembers.filter((m) => m.userId === session.user.id) : allMembers;
  const plan = PLANS[(ws.plan as PlanId) ?? "starter"] ?? PLANS.starter;
  return { workspace: ws, role, scoped, brands, members, brandLimit: plan.brands, canAddBrand: !scoped && (role === "owner" || role === "admin") && allBrands.length < plan.brands };
}
