import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-audit-"));

const { getDb, schema } = await import("./db/client");
const { audit, auditTrail, auditTrailFor } = await import("./audit");
const { requireBrandForUser, requireWorkspaceRoleForUser, AccessError } = await import("./auth/guard");
const { changeRoleFor, inviteMemberFor } = await import("./members");

/**
 * Security log isolation: organisation and brand scope, refusals, and auditing of access.
 * Two organisations: A (agency, brands A1 and A2) and B (brand B1).
 */
type U = { id: string; email: string; name: string };
const sess = (u: U) => ({ sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } });
const HOUR = 3600_000;

let A: { id: string }, B: { id: string }, A1: { id: string }, A2: { id: string }, B1: { id: string };
let ownerA: U, adminA: U, scopedAdminA: U, clientA: U, viewerA: U, ownerB: U, both: U;

beforeAll(async () => {
  const db = await getDb();
  const user = async (email: string, name: string) => (await db.insert(schema.users).values({ email, name, passwordHash: "x" }).returning())[0] as U;
  [ownerA, adminA, scopedAdminA, clientA, viewerA, ownerB, both] = await Promise.all([
    user("owner-a@x.test", "Owner A"),
    user("admin-a@x.test", "Admin A"),
    user("scoped-admin-a@x.test", "Scoped Admin A"),
    user("client-a@x.test", "Client A"),
    user("viewer-a@x.test", "Viewer A"),
    user("owner-b@x.test", "Owner B"),
    user("both@x.test", "Both Orgs"),
  ]);
  [A] = await db.insert(schema.workspaces).values({ name: "Org A", plan: "agency", type: "agency" }).returning();
  [B] = await db.insert(schema.workspaces).values({ name: "Org B", plan: "agency" }).returning();
  [A1] = await db.insert(schema.brands).values({ workspaceId: A.id, name: "A One" }).returning();
  [A2] = await db.insert(schema.brands).values({ workspaceId: A.id, name: "A Two" }).returning();
  [B1] = await db.insert(schema.brands).values({ workspaceId: B.id, name: "B One" }).returning();

  const now = Date.now();
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: A.id, userId: ownerA.id, role: "owner" },
    { workspaceId: A.id, userId: adminA.id, role: "admin" },
    // The app never creates brand-scoped admins (checkScope refuses them). Inserted directly to
    // prove the log follows the membership scope, not the role.
    { workspaceId: A.id, userId: scopedAdminA.id, role: "admin", brandIds: [A1.id, B1.id] },
    { workspaceId: A.id, userId: clientA.id, role: "editor", brandIds: [A1.id] },
    { workspaceId: A.id, userId: viewerA.id, role: "viewer" },
    { workspaceId: B.id, userId: ownerB.id, role: "owner" },
    // "both" joined B two hours ago and A one hour ago.
    { workspaceId: B.id, userId: both.id, role: "editor", createdAt: new Date(now - 2 * HOUR) },
    { workspaceId: A.id, userId: both.id, role: "editor", createdAt: new Date(now - HOUR) },
  ]);

  // Events: organisation-level and brand-level in both organisations.
  await audit({ action: "workspace.update", workspaceId: A.id, actorUserId: ownerA.id, details: { name: "Org A" } });
  await audit({ action: "brand.create", workspaceId: A.id, brandId: A1.id, actorUserId: ownerA.id });
  await audit({ action: "social.connect", workspaceId: A.id, brandId: A2.id, actorUserId: adminA.id, details: { platform: "instagram" } });
  await audit({ action: "workspace.update", workspaceId: B.id, actorUserId: ownerB.id, details: { name: "Org B" } });
  await audit({ action: "brand.create", workspaceId: B.id, brandId: B1.id, actorUserId: ownerB.id });
  // Account-level sign-in events (no workspace) for "both": one before joining either org, one
  // between joining B and A, one after joining both.
  await db.insert(schema.auditEvents).values([
    { action: "auth.login", actorUserId: both.id, createdAt: new Date(now - 3 * HOUR), details: { n: 1 } },
    { action: "auth.login", actorUserId: both.id, createdAt: new Date(now - 90 * 60_000), details: { n: 2 } },
  ]);
  await audit({ action: "auth.login", actorUserId: both.id, details: { n: 3 } });
  await audit({ action: "auth.login", actorUserId: ownerB.id }); // B-only member
});

const logFor = async (u: U, ws: { id: string }) => (await auditTrailFor(sess(u), ws.id)).rows;
const denials = async (ws: { id: string }) =>
  (await getDb()).select().from(schema.auditEvents).where(and(eq(schema.auditEvents.workspaceId, ws.id), eq(schema.auditEvents.action, "access.denied")));

describe("Security log: organisation isolation", () => {
  it("an owner sees their organisation's events and none of another organisation's", async () => {
    const rows = await logFor(ownerA, A);
    const brands = rows.map((r) => r.brandId).filter(Boolean);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["workspace.update", "brand.create", "social.connect"]));
    expect(brands).not.toContain(B1.id);
    expect(rows.some((r) => (r.details as { name?: string }).name === "Org B")).toBe(false);
    expect(rows.some((r) => r.actorName === "Owner B")).toBe(false);
  });

  it("refuses an owner of another organisation, and records the attempt in the target's log", async () => {
    const before = (await denials(A)).length;
    await expect(auditTrailFor(sess(ownerB), A.id)).rejects.toBeInstanceOf(AccessError);
    const after = await denials(A);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ actorUserId: ownerB.id, outcome: "denied", targetType: "security_log", details: { needed: "admin", member: false } });
    // A's owner sees the attempt, but not who the outsider is.
    const seen = (await logFor(ownerA, A)).find((r) => r.action === "access.denied" && r.targetType === "security_log");
    expect(seen?.actorName).toBe("Not a current member");
  });

  it("shows members' sign-ins only from when they joined that organisation", async () => {
    const nOf = (rows: Awaited<ReturnType<typeof logFor>>) =>
      rows.filter((r) => r.action === "auth.login" && r.actorName === "Both Orgs").map((r) => (r.details as { n: number }).n).sort();
    expect(nOf(await logFor(ownerA, A))).toEqual([3]); // joined A an hour ago
    expect(nOf(await logFor(ownerB, B))).toEqual([2, 3]); // joined B two hours ago
    // B-only members' sign-ins never appear in A.
    expect((await logFor(ownerA, A)).some((r) => r.actorName === "Owner B")).toBe(false);
  });

  it("drops a former member's sign-ins once they leave", async () => {
    const db = await getDb();
    const [tmp] = await db.insert(schema.users).values({ email: "leaver@x.test", name: "Leaver", passwordHash: "x" }).returning();
    const [m] = await db.insert(schema.workspaceMembers).values({ workspaceId: A.id, userId: tmp.id, role: "editor", createdAt: new Date(Date.now() - HOUR) }).returning();
    await audit({ action: "auth.login", actorUserId: tmp.id });
    expect((await auditTrail(A.id)).some((r) => r.actorUserId === tmp.id)).toBe(true);
    await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, m.id));
    expect((await auditTrail(A.id)).some((r) => r.actorUserId === tmp.id)).toBe(false);
  });
});

describe("Security log: roles and brand scope", () => {
  it("an unscoped admin sees the whole organisation", async () => {
    const r = await auditTrailFor(sess(adminA), A.id);
    expect(r.scope.brandIds).toBeNull();
    expect(new Set(r.rows.map((x) => x.brandId))).toEqual(new Set([null, A1.id, A2.id]));
  });

  it("an admin role alone doesn't widen access: a brand-scoped admin sees only their brands' events", async () => {
    const r = await auditTrailFor(sess(scopedAdminA), A.id);
    // B1 in the stored scope belongs to another organisation and is ignored.
    expect(r.scope.brandIds).toEqual([A1.id]);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.brandId).toBe(A1.id);
    // No organisation-wide events (workspace changes, sign-ins, other brands).
    expect(r.rows.some((x) => x.action === "workspace.update" || x.action.startsWith("auth."))).toBe(false);
  });

  it("refuses editors, viewers and brand-scoped clients, and records each refusal", async () => {
    for (const u of [clientA, viewerA, both]) {
      const before = (await denials(A)).length;
      await expect(auditTrailFor(sess(u), A.id)).rejects.toBeInstanceOf(AccessError);
      const after = await denials(A);
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({ actorUserId: u.id, details: { needed: "admin", member: true } });
    }
  });

  it("records viewing the log, at most once an hour per viewer", async () => {
    const db = await getDb();
    const views = () => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "audit.view"), eq(schema.auditEvents.actorUserId, adminA.id)));
    const n = (await views()).length;
    await auditTrailFor(sess(adminA), A.id);
    await auditTrailFor(sess(adminA), A.id);
    expect((await views()).length).toBe(n === 0 ? 1 : n);
    expect((await views())[0]).toMatchObject({ workspaceId: A.id, details: { scope: "organisation" } });
  });
});

describe("Refused access is audited against the owning organisation", () => {
  it("cross-tenant brand access is refused and recorded in the brand's organisation", async () => {
    const before = (await denials(A)).length;
    await expect(requireBrandForUser(sess(ownerB), A1.id, "viewer")).rejects.toBeInstanceOf(AccessError);
    const d = (await denials(A)).at(-1)!;
    expect((await denials(A)).length).toBe(before + 1);
    expect(d).toMatchObject({ actorUserId: ownerB.id, brandId: A1.id, targetType: "brand", details: { reason: "not_a_member" } });
    // Nothing about it lands in B's log.
    expect((await denials(B)).some((x) => x.brandId === A1.id)).toBe(false);
  });

  it("out-of-scope and insufficient-role brand access are refused and recorded", async () => {
    await expect(requireBrandForUser(sess(clientA), A2.id, "viewer")).rejects.toBeInstanceOf(AccessError);
    expect((await denials(A)).at(-1)).toMatchObject({ actorUserId: clientA.id, brandId: A2.id, details: { reason: "outside_brand_scope" } });
    await expect(requireBrandForUser(sess(viewerA), A1.id, "editor")).rejects.toThrow(/editor role/);
    expect((await denials(A)).at(-1)).toMatchObject({ actorUserId: viewerA.id, details: { reason: "needs_editor" } });
    // Allowed access records nothing.
    const n = (await denials(A)).length;
    await requireBrandForUser(sess(clientA), A1.id, "editor");
    await requireBrandForUser(sess(viewerA), A2.id, "viewer");
    expect((await denials(A)).length).toBe(n);
  });

  it("workspace administration by outsiders and brand-scoped members is refused and recorded", async () => {
    await expect(requireWorkspaceRoleForUser(sess(ownerB), A.id, "viewer")).rejects.toBeInstanceOf(AccessError);
    expect((await denials(A)).at(-1)).toMatchObject({ actorUserId: ownerB.id, targetType: "workspace", details: { reason: "not_a_member" } });
    await expect(requireWorkspaceRoleForUser(sess(scopedAdminA), A.id, "admin")).rejects.toThrow(/limited to specific brands/);
    expect((await denials(A)).at(-1)).toMatchObject({ actorUserId: scopedAdminA.id, details: { reason: "outside_brand_scope" } });
    // Real member operations across tenants go through the same guard.
    const [clientMembership] = await (await getDb()).select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, A.id), eq(schema.workspaceMembers.userId, clientA.id)));
    await expect(changeRoleFor(sess(ownerB), A.id, clientMembership.id, "viewer")).rejects.toBeInstanceOf(AccessError);
    await expect(inviteMemberFor(sess(ownerB), A.id, "intruder@x.test", "admin")).rejects.toBeInstanceOf(AccessError);
    expect((await denials(A)).filter((x) => x.actorUserId === ownerB.id).length).toBeGreaterThanOrEqual(3);
  });

  it("unknown brand and workspace ids are refused without writing anything", async () => {
    const db = await getDb();
    const count = async () => (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "access.denied"))).length;
    const n = await count();
    await expect(requireBrandForUser(sess(ownerB), "no-such-brand", "viewer")).rejects.toBeInstanceOf(AccessError);
    await expect(requireWorkspaceRoleForUser(sess(ownerB), "no-such-workspace", "viewer")).rejects.toBeInstanceOf(AccessError);
    expect(await count()).toBe(n);
  });
});
