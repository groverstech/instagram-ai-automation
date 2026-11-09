import "server-only";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { getSession, type SessionUser } from "./session";
import { roleAtLeast, type Role } from "@/lib/roles";

export class AccessError extends Error {
  constructor(message = "You don't have access to this resource.") {
    super(message);
  }
}

/**
 * Record a refused access in the audit log, against the organisation that owns the resource (so
 * its owners see cross-tenant and out-of-scope attempts), then return the error to throw.
 */
async function denied(session: SessionUser, target: { workspaceId: string | null; brandId?: string | null; type: string; id: string }, reason: string, err: AccessError) {
  const { audit } = await import("../audit");
  await audit({ action: "access.denied", outcome: "denied", workspaceId: target.workspaceId, brandId: target.brandId ?? null, actorUserId: session.user.id, targetType: target.type, targetId: target.id, details: { reason } });
  return err;
}

export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Brands the user can see, with their role in each brand's workspace. */
export async function listAccessibleBrands(userId: string) {
  const db = await getDb();
  const memberships = await db
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.userId, userId), eq(schema.workspaceMembers.status, "active")));
  if (!memberships.length) return [];
  const byWs = new Map(memberships.map((m) => [m.workspaceId, m]));
  const brands = await db
    .select()
    .from(schema.brands)
    .where(inArray(schema.brands.workspaceId, [...byWs.keys()]));
  return brands.filter((b) => inBrandScope(byWs.get(b.workspaceId)!.brandIds, b.id)).map((b) => ({ brand: b, role: byWs.get(b.workspaceId)!.role }));
}

/** Client users can be limited to specific brands; null/undefined scope = all workspace brands. */
export function inBrandScope(brandIds: string[] | null | undefined, brandId: string) {
  return !Array.isArray(brandIds) || brandIds.includes(brandId);
}

export type BrandAccess = {
  session: SessionUser;
  brand: typeof schema.brands.$inferSelect;
  role: Role;
};

/** Resolve brand → workspace → membership for the current user. Throws if insufficient. */
export async function requireBrand(brandId: string, min: Role = "viewer"): Promise<BrandAccess> {
  const session = await getSession();
  if (!session) throw new AccessError("Not signed in.");
  return requireBrandForUser(session, brandId, min);
}

export async function requireBrandForUser(session: SessionUser, brandId: string, min: Role): Promise<BrandAccess> {
  const db = await getDb();
  const rows = await db
    .select({ brand: schema.brands, role: schema.workspaceMembers.role, brandIds: schema.workspaceMembers.brandIds })
    .from(schema.brands)
    .innerJoin(
      schema.workspaceMembers,
      and(
        eq(schema.workspaceMembers.workspaceId, schema.brands.workspaceId),
        eq(schema.workspaceMembers.userId, session.user.id),
        eq(schema.workspaceMembers.status, "active"),
      ),
    )
    .where(eq(schema.brands.id, brandId))
    .limit(1);
  const r = rows[0];
  if (!r || !inBrandScope(r.brandIds, r.brand.id)) {
    const [owner] = r ? [r.brand] : await db.select({ workspaceId: schema.brands.workspaceId }).from(schema.brands).where(eq(schema.brands.id, brandId)).limit(1);
    // Unknown brand ids aren't recorded: there's no organisation to attribute them to.
    if (!owner) throw new AccessError();
    throw await denied(session, { workspaceId: owner.workspaceId, brandId, type: "brand", id: brandId }, r ? "outside_brand_scope" : "not_a_member", new AccessError());
  }
  if (!roleAtLeast(r.role, min)) throw await denied(session, { workspaceId: r.brand.workspaceId, brandId, type: "brand", id: brandId }, `needs_${min}`, new AccessError(`This action needs the ${min} role or higher.`));
  return { session, brand: r.brand, role: r.role };
}

/** For pages: the active brand (or first accessible), redirecting to onboarding when none. */
export async function requireActiveBrand(): Promise<BrandAccess> {
  const session = await requireUser();
  const all = await listAccessibleBrands(session.user.id);
  if (!all.length) redirect("/onboarding");
  const picked = all.find((b) => b.brand.id === session.activeBrandId) ?? all[0];
  return { session, brand: picked.brand, role: picked.role };
}

export async function requireWorkspaceRole(workspaceId: string, min: Role) {
  const session = await getSession();
  if (!session) throw new AccessError("Not signed in.");
  return requireWorkspaceRoleForUser(session, workspaceId, min);
}

export async function requireWorkspaceRoleForUser(session: SessionUser, workspaceId: string, min: Role) {
  const db = await getDb();
  const [m] = await db
    .select()
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, session.user.id),
        eq(schema.workspaceMembers.status, "active"),
      ),
    )
    .limit(1);
  if (!m || !roleAtLeast(m.role, min)) {
    const [ws] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
    if (!ws) throw new AccessError();
    throw await denied(session, { workspaceId, type: "workspace", id: workspaceId }, m ? `needs_${min}` : "not_a_member", new AccessError());
  }
  // Brand-scoped (client) members can't administer the workspace as a whole.
  if (Array.isArray(m.brandIds) && roleAtLeast(min, "admin")) throw await denied(session, { workspaceId, type: "workspace", id: workspaceId }, "outside_brand_scope", new AccessError("Your access is limited to specific brands."));
  return { session, role: m.role, brandIds: m.brandIds };
}
