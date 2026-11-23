import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-reviewer-"));

const { getDb, schema } = await import("./db/client");
const { verifyPassword } = await import("./auth/password");
const { setupReviewer, REVIEW_BRAND } = await import("./reviewer");
const { renderCreativePng } = await import("./creative/render");

describe("platform reviewer account", () => {
  it("creates a reviewer with an organisation, a brand, a renderable creative and approved Instagram and Facebook posts", async () => {
    const r = await setupReviewer({ email: " Reviewer@Example.com " });
    expect(r.email).toBe("reviewer@example.com");
    expect(r.password).toMatch(/^[\w-]{20}$/);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
    expect(u.passwordHash).not.toContain(r.password);
    expect(await verifyPassword(r.password, u.passwordHash)).toBe(true);
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, r.userId));
    expect(m).toMatchObject({ workspaceId: r.workspaceId, role: "owner", status: "active", brandIds: null });
    const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, r.brandId));
    expect(b.name).toBe(REVIEW_BRAND);
    const posts = await db.select().from(schema.posts).where(eq(schema.posts.brandId, r.brandId));
    expect(posts.map((p) => [p.platform, p.status, p.creativeId === r.creativeId, Boolean(p.approvedAt), p.approvedBy === r.userId]).sort()).toEqual([
      ["facebook", "approved", true, true, true],
      ["instagram", "approved", true, true, true],
    ]);
    for (const p of posts) expect(p.scheduledAt!.getTime()).toBeGreaterThan(Date.now()); // listed in the calendar, not scheduled
    const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, r.creativeId));
    expect((await renderCreativePng(c, b)).subarray(1, 4).toString()).toBe("PNG");
  });

  it("has two-step verification on, so mandatory MFA for owners doesn't stop a reviewer: password plus a recovery code signs in", async () => {
    process.env.DEPLOY_ENV = "production"; // MFA_REQUIRED_FOR_ADMINS defaults to true here
    try {
      const r = await setupReviewer({ email: "mfa-reviewer@example.com" });
      expect(r.recoveryCodes).toHaveLength(10);
      expect(r.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
      const { mfaStatus, checkSecondFactor } = await import("./auth/mfa");
      const st = await mfaStatus(r.userId);
      expect(st).toMatchObject({ enabled: true, required: true, recoveryCodesLeft: 10 });
      expect(await checkSecondFactor(r.userId, r.recoveryCodes[0], Date.now())).toBe("recovery");
      expect(await checkSecondFactor(r.userId, r.recoveryCodes[0], Date.now())).toBeNull(); // single use
      const db = await getDb();
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
      expect(u.mfaSecretEnc).not.toContain(r.totpSecret);
      expect(JSON.stringify(u.mfaRecoveryHashes)).not.toContain(r.recoveryCodes[1]);
    } finally {
      delete process.env.DEPLOY_ENV;
    }
  });

  it("refuses to overwrite without --reset; --reset recreates it with a new password and removes the old organisation", async () => {
    await expect(setupReviewer({ email: "reviewer@example.com" })).rejects.toThrow(/already exists.*--reset/);
    const db = await getDb();
    const [before] = await db.select().from(schema.users).where(eq(schema.users.email, "reviewer@example.com"));
    const [oldMember] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, before.id));
    const r = await setupReviewer({ email: "reviewer@example.com", reset: true });
    expect(r.userId).not.toBe(before.id);
    expect(await db.$count(schema.workspaces, eq(schema.workspaces.id, oldMember.workspaceId))).toBe(0);
    expect(await db.$count(schema.users, eq(schema.users.email, "reviewer@example.com"))).toBe(1);
  });

  it("never resets a real account that shares an organisation with other people", async () => {
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ email: "real@example.com", name: "Real", passwordHash: "x" }).returning();
    const [colleague] = await db.insert(schema.users).values({ email: "colleague@example.com", name: "C", passwordHash: "x" }).returning();
    const [w] = await db.insert(schema.workspaces).values({ name: "Real org" }).returning();
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: w.id, userId: owner.id, role: "owner", status: "active" },
      { workspaceId: w.id, userId: colleague.id, role: "editor", status: "active" },
    ]);
    await expect(setupReviewer({ email: "real@example.com", reset: true })).rejects.toThrow(/organisation with other members.*Nothing was changed/);
    expect(await db.$count(schema.workspaces, eq(schema.workspaces.id, w.id))).toBe(1);
    expect(await db.$count(schema.users, eq(schema.users.id, owner.id))).toBe(1);
  });
});
