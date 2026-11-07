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
  const roleByWs = new Map(memberships.map((m) => [m.workspaceId, m.role]));
  const brands = await db
    .select()
    .from(schema.brands)
    .where(inArray(schema.brands.workspaceId, [...roleByWs.keys()]));
  return brands.map((b) => ({ brand: b, role: roleByWs.get(b.workspaceId)! }));
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
    .select({ brand: schema.brands, role: schema.workspaceMembers.role })
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
  if (!r) throw new AccessError();
  if (!roleAtLeast(r.role, min)) throw new AccessError(`This action needs the ${min} role or higher.`);
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
  if (!m || !roleAtLeast(m.role, min)) throw new AccessError();
  return { session, role: m.role };
}
