/**
 * F4: Security log export (same authorisation, scope and detail allow-list as Settings; step-up;
 * audited) and audit-log retention.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
delete process.env.AUDIT_RETENTION_DAYS;

const { getDb, schema } = await import("./db/client");
const { audit, auditExportFor, auditExportReadyFor, csvCell, purgeExpiredAuditEvents, auditRetentionDays } = await import("./audit");
const { AccessError } = await import("./auth/guard");
const { StepUpRequired } = await import("./auth/step-up");
const { checkConfig } = await import("./config");
type SessionUser = import("./auth/session").SessionUser;

let n = 0;
async function org() {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: `Org ${n}` }).returning();
  const mk = async (role: "owner" | "editor", name: string) => {
    const [u] = await db.insert(schema.users).values({ email: `ax${n++}@x.test`, name, passwordHash: "x" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role, status: "active" });
    const s: SessionUser = { sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } };
    await db.insert(schema.sessions).values({ id: s.sessionId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
    return s;
  };
  return { ws: w.id, owner: await mk("owner", "Asha, Owner"), editor: await mk("editor", "Ed") };
}

beforeEach(() => {
  delete process.env.AUDIT_RETENTION_DAYS;
});

describe("Security log export", () => {
  it("CSV and JSON with the Settings allow-list: no hidden detail fields; actor names for members only; audited", async () => {
    const o = await org();
    await audit({ action: "member.invite", workspaceId: o.ws, actorUserId: o.owner.user.id, targetType: "member", targetId: "m1", details: { role: "editor", emailHash: "secret-hash", platformAccountId: "123" } });
    await audit({ action: "workspace.update", workspaceId: o.ws, actorUserId: "someone-else", details: { type: "agency" } });
    const other = await org();
    await audit({ action: "member.invite", workspaceId: other.ws, actorUserId: other.owner.user.id, details: { role: "viewer" } });

    const csv = await auditExportFor(o.owner, o.ws, { format: "csv" });
    expect(csv.contentType).toMatch(/text\/csv/);
    expect(csv.filename).toMatch(/^security-log-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe("time,action,outcome,actor,actorType,targetType,targetId,brandId,details");
    expect(csv.body).toContain("member.invite");
    expect(csv.body).toContain('"Asha, Owner"');
    expect(csv.body).toContain("Not a current member");
    expect(csv.body).not.toContain("secret-hash");
    expect(csv.body).not.toContain("platformAccountId");
    expect(csv.body).not.toContain("viewer"); // another organisation's event

    const json = JSON.parse((await auditExportFor(o.owner, o.ws, { format: "json" })).body);
    expect(json.scope).toBe("organisation");
    expect(json.events.find((e: { action: string }) => e.action === "member.invite").details).toEqual({ role: "editor" });

    const db = await getDb();
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "audit.export"), eq(schema.auditEvents.workspaceId, o.ws)));
    expect(ev.map((e) => (e.details as { type: string }).type).sort()).toEqual(["csv", "json"]);
  });

  it("only events in the window; editors are refused and the refusal is recorded", async () => {
    const o = await org();
    const db = await getDb();
    await db.insert(schema.auditEvents).values({ action: "workspace.update", workspaceId: o.ws, actorType: "user", outcome: "success", createdAt: new Date(Date.now() - 40 * 86400_000), details: { type: "old-one" } });
    expect((await auditExportFor(o.owner, o.ws, { format: "csv", sinceDays: 30 })).body).not.toContain("old-one");
    expect((await auditExportFor(o.owner, o.ws, { format: "csv", sinceDays: 60 })).body).toContain("old-one");
    await expect(auditExportFor(o.editor, o.ws, { format: "csv" })).rejects.toBeInstanceOf(AccessError);
    await expect(auditExportReadyFor(o.editor, o.ws)).rejects.toBeInstanceOf(AccessError);
    const denied = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "access.denied"), eq(schema.auditEvents.actorUserId, o.editor.user.id)));
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  it("with two-step verification on, exporting needs a recent second factor", async () => {
    const o = await org();
    const db = await getDb();
    await db.update(schema.users).set({ mfaEnabledAt: new Date() }).where(eq(schema.users.id, o.owner.user.id));
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.sessions.id, o.owner.sessionId));
    await expect(auditExportReadyFor(o.owner, o.ws)).rejects.toBeInstanceOf(StepUpRequired);
    await expect(auditExportFor(o.owner, o.ws, { format: "csv" })).rejects.toBeInstanceOf(StepUpRequired);
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date() }).where(eq(schema.sessions.id, o.owner.sessionId));
    await expect(auditExportReadyFor(o.owner, o.ws)).resolves.toBeUndefined();
  });

  it("CSV cells: quoting, and spreadsheet formulas neutralised", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });
});

describe("retention", () => {
  it("deletes events older than AUDIT_RETENTION_DAYS (default 400), keeps newer ones, records the purge", async () => {
    const db = await getDb();
    const o = await org();
    const day = 86400_000;
    await db.insert(schema.auditEvents).values([
      { action: "workspace.update", workspaceId: o.ws, actorType: "user", outcome: "success", createdAt: new Date(Date.now() - 500 * day), details: { type: "ancient" } },
      { action: "workspace.update", workspaceId: o.ws, actorType: "user", outcome: "success", createdAt: new Date(Date.now() - 200 * day), details: { type: "older" } },
      { action: "workspace.update", workspaceId: o.ws, actorType: "user", outcome: "success", createdAt: new Date(Date.now() - 10 * day), details: { type: "recent" } },
    ]);
    const types = async () => (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.workspaceId, o.ws), eq(schema.auditEvents.action, "workspace.update")))).map((e) => (e.details as { type: string }).type).sort();
    const first = await purgeExpiredAuditEvents(new Date(), 1); // batch of 1: the loop continues
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    expect(await types()).toEqual(["older", "recent"]);
    process.env.AUDIT_RETENTION_DAYS = "100";
    await purgeExpiredAuditEvents();
    expect(await types()).toEqual(["recent"]);
    const purges = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "audit.retention_purge"));
    expect(purges.length).toBeGreaterThanOrEqual(2);
    expect((await purgeExpiredAuditEvents()).deleted).toBe(0);
  });

  it("configuration: at least 90 days; an invalid value falls back to 400 and is a config error", () => {
    expect(auditRetentionDays({})).toBe(400);
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: "730" })).toBe(730);
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: "30" })).toBe(400);
    const errs = (v: string) => checkConfig({ AUDIT_RETENTION_DAYS: v }).filter((p) => p.key === "AUDIT_RETENTION_DAYS" && p.level === "error");
    expect(errs("30")).toHaveLength(1);
    expect(errs("forever")).toHaveLength(1);
    expect(errs("365")).toHaveLength(0);
  });
});
