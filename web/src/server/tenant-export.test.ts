/**
 * D4: organisation data export (tenant-export.ts). Owners only, step-up, rate-limited, audited;
 * every brand's data and files; no secrets; nothing from other organisations.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-export-store-"));

const { getDb, schema } = await import("./db/client");
const { exportWorkspaceFor, exportReadyFor, stripSecrets, exportSlot, ExportBusyError, exportFileBudgetBytes } = await import("./tenant-export");
const { storage } = await import("./storage");
const { AccessError } = await import("./auth/guard");
const { StepUpRequired } = await import("./auth/step-up");
const { RateLimitError } = await import("./ratelimit");
type SessionUser = import("./auth/session").SessionUser;

let n = 0;
async function org(name: string) {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name }).returning();
  const mk = async (role: "owner" | "admin" | "editor") => {
    const [u] = await db.insert(schema.users).values({ email: `tx${n++}@x.test`, name: `${name} ${role}`, passwordHash: "scrypt$never-exported", mfaSecretEnc: "mfa-secret-never-exported" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role, status: "active" });
    const s: SessionUser = { sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } };
    await db.insert(schema.sessions).values({ id: s.sessionId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
    return s;
  };
  const owner = await mk("owner");
  const admin = await mk("admin");
  const editor = await mk("editor");
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: `${name} Brand` }).returning();
  const assetPath = `brands/${b.id}/assets/logo.png`;
  const imagePath = `brands/${b.id}/creatives/c1.png`;
  await storage.put(assetPath, Buffer.from(`logo of ${name}`), "image/png");
  await storage.put(imagePath, Buffer.from(`image of ${name}`), "image/png");
  await db.insert(schema.brandAssets).values({ brandId: b.id, kind: "logo", name: "logo.png", path: assetPath, mime: "image/png" });
  await db.insert(schema.brandAssets).values({ brandId: b.id, kind: "product", name: "gone.png", path: `brands/${b.id}/assets/gone.png`, mime: "image/png" });
  await db.insert(schema.creatives).values({ brandId: b.id, format: "instagram_portrait", style: "photo", concept: { headline: `${name} launch` }, imagePath });
  await db.insert(schema.socialAccounts).values({ brandId: b.id, platform: "instagram", externalId: "ig-1", name: `${name} IG`, accessTokenEnc: "token-never-exported", refreshTokenEnc: "refresh-never-exported" });
  await db.insert(schema.brandMemories).values({ brandId: b.id, kind: "fact", content: `${name} makes stoneware`, source: "user" });
  // A post with two publish attempts (the ledger, PR 4.4a): a failure, then success.
  const [p] = await db.insert(schema.posts).values({ brandId: b.id, platform: "instagram", title: `${name} post`, status: "published" }).returning();
  await db.insert(schema.publishAttempts).values([
    { postId: p.id, platform: "instagram", attempt: 1, idempotencyKey: `idem-never-exported-${name}-1`, status: "failed", error: `${name} timeout` },
    { postId: p.id, platform: "instagram", attempt: 2, idempotencyKey: `idem-never-exported-${name}-2`, status: "succeeded", externalId: `${name}-ig-post` },
  ]);
  return { ws: w.id, owner, admin, editor, brand: b.id };
}

const unzip = async (body: Buffer) => {
  const z = await JSZip.loadAsync(body);
  const data = JSON.parse(await z.file("data.json")!.async("string"));
  const all = (await Promise.all(Object.values(z.files).map((f) => f.async("string")))).join("\n");
  return { z, data, all };
};

describe("organisation data export", () => {
  it("owners get every brand's data and files, nothing secret and nothing from other organisations; audited", async () => {
    const a = await org("Kora");
    await org("Other");
    const out = await exportWorkspaceFor(a.owner, a.ws);
    expect(out.filename).toMatch(/^brandpilot-kora-\d{4}-\d{2}-\d{2}\.zip$/);
    const { z, data, all } = await unzip(out.body);
    expect(data.format).toBe("brandpilot-organisation-export");
    expect(data.organisation.name).toBe("Kora");
    expect(data.members.map((m: { email: string }) => m.email)).toHaveLength(3);
    expect(data.brands.map((b: { name: string }) => b.name)).toEqual(["Kora Brand"]);
    expect(data.creatives[0].concept).toEqual({ headline: "Kora launch" });
    expect(data.brandMemories[0].content).toBe("Kora makes stoneware");
    expect(data.socialAccounts[0]).toMatchObject({ platform: "instagram", name: "Kora IG" });
    expect(data.socialAccounts[0]).not.toHaveProperty("accessTokenEnc");
    expect(data.brandMemories[0]).not.toHaveProperty("embedding");
    // Publishing history: this organisation's attempts only, without internal idempotency keys.
    expect(data.publishAttempts.map((r: { attempt: number; status: string; externalId: string | null }) => [r.attempt, r.status, r.externalId]).sort()).toEqual([
      [1, "failed", null],
      [2, "succeeded", "Kora-ig-post"],
    ]);
    expect(data.publishAttempts[0]).not.toHaveProperty("idempotencyKey");
    // Files at their storage paths; a missing one is listed, not fatal.
    expect(await z.file(`files/brands/${a.brand}/assets/logo.png`)!.async("string")).toBe("logo of Kora");
    expect(await z.file(`files/brands/${a.brand}/creatives/c1.png`)!.async("string")).toBe("image of Kora");
    expect(data.files).toContainEqual({ path: `brands/${a.brand}/assets/gone.png`, skipped: "missing" });
    expect(z.file("README.txt")).not.toBeNull();
    for (const secret of ["never-exported", "scrypt$", "Other"]) expect(all).not.toContain(secret);
    const db = await getDb();
    const [ev] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "workspace.export"));
    expect(ev).toMatchObject({ workspaceId: a.ws, actorUserId: a.owner.user.id });
    expect((ev.details as { status: string }).status).toMatch(/1 brands, 1 posts, 1 creatives, 2 files, 1 skipped/);
  });

  it("admins and editors are refused", async () => {
    const a = await org("Refuse");
    await expect(exportWorkspaceFor(a.admin, a.ws)).rejects.toBeInstanceOf(AccessError);
    await expect(exportWorkspaceFor(a.editor, a.ws)).rejects.toBeInstanceOf(AccessError);
    await expect(exportReadyFor(a.admin, a.ws)).rejects.toBeInstanceOf(AccessError);
    const other = await org("Elsewhere");
    await expect(exportWorkspaceFor(other.owner, a.ws)).rejects.toBeInstanceOf(AccessError);
  });

  it("with two-step verification on, needs a recent second factor", async () => {
    const a = await org("Stepup");
    const db = await getDb();
    await db.update(schema.users).set({ mfaEnabledAt: new Date() }).where(eq(schema.users.id, a.owner.user.id));
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(Date.now() - 3600_000) }).where(eq(schema.sessions.id, a.owner.sessionId));
    await expect(exportReadyFor(a.owner, a.ws)).rejects.toBeInstanceOf(StepUpRequired);
    await expect(exportWorkspaceFor(a.owner, a.ws)).rejects.toBeInstanceOf(StepUpRequired);
  });

  it("files over the size budget are listed rather than bundled; three exports an hour per person", async () => {
    const a = await org("Budget");
    const out = await exportWorkspaceFor(a.owner, a.ws, { fileBudgetBytes: 15 });
    const { data } = await unzip(out.body);
    expect(data.files.filter((f: { skipped?: string }) => f.skipped === "over_budget")).toHaveLength(1);
    await exportWorkspaceFor(a.owner, a.ws);
    await exportWorkspaceFor(a.owner, a.ws);
    await expect(exportWorkspaceFor(a.owner, a.ws)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("one export at a time per process; the file budget is configurable within bounds", async () => {
    const a = await org("Busy");
    let release!: () => void;
    const held = exportSlot(() => new Promise<void>((r) => (release = r)));
    await expect(exportWorkspaceFor(a.owner, a.ws)).rejects.toBeInstanceOf(ExportBusyError);
    release();
    await held;
    expect((await exportWorkspaceFor(a.owner, a.ws)).body.length).toBeGreaterThan(0);
    const mb = (v?: string) => exportFileBudgetBytes(v === undefined ? {} : { EXPORT_FILE_BUDGET_MB: v }) / 1024 / 1024;
    expect([mb(), mb("250"), mb("1"), mb("99999"), mb("lots")]).toEqual([100, 250, 10, 1000, 100]);
  });

  it("strips secret-looking columns by name", () => {
    expect(stripSecrets({ id: "1", accessTokenEnc: "x", passwordHash: "x", claimToken: "x", embedding: [1], inputTokens: 5, name: "n" })).toEqual({ id: "1", inputTokens: 5, name: "n" });
  });
});
