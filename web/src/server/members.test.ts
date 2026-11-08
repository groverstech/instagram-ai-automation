import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";

const { getDb, schema } = await import("./db/client");
const m = await import("./members");
const { AccessError, listAccessibleBrands, requireBrandForUser } = await import("./auth/guard");
type SessionUser = import("./auth/session").SessionUser;

const sess = (id: string, sessionId = `s-${id}`): SessionUser => ({ sessionId, activeBrandId: null, user: { id, email: `${id}@x.test`, name: id } });
let ownerId = "", adminId = "", editorId = "", clientId = "", outsiderId = "";
let ws = "", wsOther = "";
let b1 = "", b2 = "", b3 = "", other = "";

async function user(name: string) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}@x.test`, name, passwordHash: "x" }).returning();
  await db.insert(schema.sessions).values({ id: `s-${u.id}`, userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  return u.id;
}

beforeAll(async () => {
  const db = await getDb();
  [ownerId, adminId, editorId, clientId, outsiderId] = await Promise.all(["owner", "admin", "editor", "client", "outsider"].map(user));
  const [w] = await db.insert(schema.workspaces).values({ name: "Agency", type: "agency", plan: "agency" }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: "Other org", plan: "agency" }).returning();
  ws = w.id;
  wsOther = w2.id;
  const brands = await db.insert(schema.brands).values([{ workspaceId: ws, name: "Kora" }, { workspaceId: ws, name: "Northwind" }, { workspaceId: ws, name: "Lumen" }, { workspaceId: wsOther, name: "Rival" }]).returning();
  [b1, b2, b3, other] = brands.map((b) => b.id);
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: ws, userId: ownerId, role: "owner" },
    { workspaceId: ws, userId: adminId, role: "admin" },
    { workspaceId: ws, userId: editorId, role: "editor" },
    { workspaceId: wsOther, userId: outsiderId, role: "owner" },
  ]);
});

describe("Settings: multi-brand client access", () => {
  it("invites a client with access to several brands and enforces it everywhere", async () => {
    const db = await getDb();
    const inv = await m.inviteMemberFor(sess(adminId), ws, "client@x.test", "editor", [b1, b3]);
    expect(inv.brandIds?.sort()).toEqual([b1, b3].sort());
    expect(inv.status).toBe("active"); // the user already exists
    const ids = (await listAccessibleBrands(clientId)).map((x) => x.brand.id).sort();
    expect(ids).toEqual([b1, b3].sort());
    await expect(requireBrandForUser(sess(clientId), b2, "viewer")).rejects.toBeInstanceOf(AccessError);
    expect((await requireBrandForUser(sess(clientId), b3, "editor")).brand.name).toBe("Lumen");
    // Switching: allowed brands only.
    await m.switchBrandFor(sess(clientId), b3);
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.userId, clientId)))[0].activeBrandId).toBe(b3);
    await expect(m.switchBrandFor(sess(clientId), b2)).rejects.toBeInstanceOf(AccessError);
    await expect(m.switchBrandFor(sess(clientId), other)).rejects.toBeInstanceOf(AccessError);
  });

  it("changes a client's brands, and moves their session off a revoked brand", async () => {
    const db = await getDb();
    const [member] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, clientId));
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.userId, clientId)))[0].activeBrandId).toBe(b3);
    await m.setMemberBrandsFor(sess(ownerId), ws, member.id, [b1, b2]);
    expect((await listAccessibleBrands(clientId)).map((x) => x.brand.id).sort()).toEqual([b1, b2].sort());
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.userId, clientId)))[0].activeBrandId).toBeNull();
    await m.setMemberBrandsFor(sess(ownerId), ws, member.id, null);
    expect((await listAccessibleBrands(clientId)).map((x) => x.brand.id).sort()).toEqual([b1, b2, b3].sort());
    await m.setMemberBrandsFor(sess(ownerId), ws, member.id, [b1, b2]);
  });

  it("validates scopes and protects roles", async () => {
    const db = await getDb();
    const [member] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, clientId));
    await expect(m.setMemberBrandsFor(sess(ownerId), ws, member.id, [])).rejects.toThrow(/at least one brand/);
    await expect(m.setMemberBrandsFor(sess(ownerId), ws, member.id, [b1, other])).rejects.toThrow(/isn't in this workspace/);
    await expect(m.inviteMemberFor(sess(ownerId), ws, "newadmin@x.test", "admin", [b1])).rejects.toThrow(/Admins and owners always have access/);
    await expect(m.changeRoleFor(sess(ownerId), ws, member.id, "admin")).rejects.toThrow(/specific brands/);
    const [owner] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, ownerId));
    await expect(m.setMemberBrandsFor(sess(ownerId), ws, owner.id, [b1])).rejects.toThrow(/own brand access|Admins and owners/);
    await expect(m.inviteMemberFor(sess(adminId), ws, "client@x.test", "viewer", null)).rejects.toThrow(/already a member/);
  });

  it("only workspace admins of the same organisation can manage access", async () => {
    const db = await getDb();
    const [member] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, clientId));
    await expect(m.setMemberBrandsFor(sess(editorId), ws, member.id, [b1])).rejects.toBeInstanceOf(AccessError);
    await expect(m.setMemberBrandsFor(sess(clientId), ws, member.id, [b1, b2, b3])).rejects.toBeInstanceOf(AccessError); // can't widen own access
    await expect(m.setMemberBrandsFor(sess(outsiderId), ws, member.id, null)).rejects.toBeInstanceOf(AccessError);
    // An admin of another org can't touch this org's members, even by guessing ids.
    await expect(m.setMemberBrandsFor(sess(outsiderId), wsOther, member.id, null)).rejects.toThrow(/Member not found/);
    await expect(m.removeMemberFor(sess(outsiderId), wsOther, member.id)).rejects.toThrow(/Member not found/);
    await expect(m.inviteMemberFor(sess(outsiderId), ws, "x@x.test", "editor", null)).rejects.toBeInstanceOf(AccessError);
  });

  it("shows each viewer only what they may see on the Settings page", async () => {
    const asOwner = await m.workspaceSettingsFor(sess(ownerId), ws, b2);
    expect(asOwner.scoped).toBe(false);
    expect(asOwner.brands.map((b) => b.name)).toEqual(["Kora", "Northwind", "Lumen"]);
    expect(asOwner.brands.find((b) => b.id === b2)!.active).toBe(true);
    expect(asOwner.brands.find((b) => b.id === b1)!.access).toEqual({ all: 3, scoped: 1 });
    expect(asOwner.members).toHaveLength(4);
    expect(asOwner.canAddBrand).toBe(true);

    const asClient = await m.workspaceSettingsFor(sess(clientId), ws, b1);
    expect(asClient.scoped).toBe(true);
    expect(asClient.brands.map((b) => b.name)).toEqual(["Kora", "Northwind"]);
    expect(asClient.members.map((x) => x.userId)).toEqual([clientId]);
    expect(asClient.canAddBrand).toBe(false);

    await expect(m.workspaceSettingsFor(sess(outsiderId), ws, b1)).rejects.toBeInstanceOf(AccessError);
  });

  it("respects the plan's brand limit for adding brands", async () => {
    const db = await getDb();
    await db.update(schema.workspaces).set({ plan: "starter" }).where(eq(schema.workspaces.id, ws));
    expect((await m.workspaceSettingsFor(sess(ownerId), ws, b1)).canAddBrand).toBe(false);
    await db.update(schema.workspaces).set({ plan: "agency" }).where(eq(schema.workspaces.id, ws));
  });
});
