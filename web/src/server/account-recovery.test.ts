/**
 * S11: account recovery (auth/recovery.ts). Forgot password without account enumeration, single-use
 * short-lived reset tokens stored as hashes, sessions ended on reset, MFA kept; audited operator
 * recovery for lost passwords and lost second factors.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.APP_URL = "https://app.example.test";

const { getDb, schema } = await import("./db/client");
const rec = await import("./auth/recovery");
const { hashPassword, verifyPassword } = await import("./auth/password");
const { sha256 } = await import("./crypto");

const tokenOf = (link: string) => decodeURIComponent(new URL(link).searchParams.get("token")!);
let n = 0;
async function user(opts: { mfa?: boolean } = {}) {
  const db = await getDb();
  const [u] = await db
    .insert(schema.users)
    .values({ email: `rec${n++}@x.test`, name: "R", passwordHash: await hashPassword("old-password-1"), ...(opts.mfa ? { mfaSecretEnc: "v1.x.y", mfaEnabledAt: new Date(), mfaRecoveryHashes: ["a:b"] } : {}) })
    .returning();
  await db.insert(schema.sessions).values([
    { id: `s1-${u.id}`, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) },
    { id: `s2-${u.id}`, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) },
  ]);
  return u;
}

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
});

describe("forgot password", () => {
  it("answers the same for known and unknown emails, stores only a hash, and audits real requests", async () => {
    const u = await user();
    expect(await rec.requestPasswordReset(u.email, "203.0.113.1")).toEqual({ ok: true });
    expect(await rec.requestPasswordReset("nobody@x.test", "203.0.113.1")).toEqual({ ok: true });
    expect(await rec.requestPasswordReset("not-an-email", "203.0.113.1")).toEqual({ ok: false, error: "Enter a valid email address." });
    const db = await getDb();
    const rows = await db.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(rec.RESET_TTL_MS);
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "auth.password_reset_requested"), eq(schema.auditEvents.targetId, u.id)))).toBe(1);
  });

  it("is rate-limited per email", async () => {
    const u = await user();
    let last: Awaited<ReturnType<typeof rec.requestPasswordReset>> = { ok: true };
    for (let i = 0; i < 11; i++) last = await rec.requestPasswordReset(u.email, `198.51.100.${i}`);
    expect(last).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
  });
});

describe("resetting the password", () => {
  it("sets the new password once, ends every session, keeps two-step verification, and voids older links", async () => {
    const u = await user({ mfa: true });
    const first = await rec.operatorResetLink(u.email, "support", "verified by phone");
    const second = await rec.operatorResetLink(u.email, "support", "verified by phone");
    expect(await rec.resetTokenValid(tokenOf(first.link))).toBe(false); // superseded
    expect(await rec.resetTokenValid(tokenOf(second.link))).toBe(true);
    await expect(rec.resetPassword(tokenOf(second.link), "short")).rejects.toThrow(/at least 8/);
    await rec.resetPassword(tokenOf(second.link), "brand-new-password-2");
    const db = await getDb();
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(await verifyPassword("brand-new-password-2", after.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password-1", after.passwordHash)).toBe(false);
    expect(after.mfaEnabledAt).not.toBeNull(); // the second factor is still required
    expect(await db.$count(schema.sessions, eq(schema.sessions.userId, u.id))).toBe(0);
    await expect(rec.resetPassword(tokenOf(second.link), "another-password-3")).rejects.toThrow(/expired or was already used/);
    const [ev] = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "auth.password_reset"), eq(schema.auditEvents.targetId, u.id)));
    expect(ev.details).toMatchObject({ via: "operator_link", ended: 2 });
  });

  it("an expired link is refused; two concurrent uses succeed only once", async () => {
    const u = await user();
    const db = await getDb();
    await db.insert(schema.passwordResets).values({ userId: u.id, tokenHash: sha256("expired-token"), expiresAt: new Date(Date.now() - 1000), issuedBy: "self" });
    await expect(rec.resetPassword("expired-token", "brand-new-password-2")).rejects.toThrow(/expired/);
    const { link } = await rec.operatorResetLink(u.email, "support", "verified by phone");
    const t = tokenOf(link);
    const results = await Promise.allSettled([rec.resetPassword(t, "racer-password-a"), rec.resetPassword(t, "racer-password-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("operator recovery", () => {
  it("needs a name and a reason; unknown emails are reported", async () => {
    const u = await user();
    await expect(rec.operatorResetLink(u.email, "", "verified by phone")).rejects.toThrow(/--by/);
    await expect(rec.operatorResetLink(u.email, "support", "")).rejects.toThrow(/--reason/);
    await expect(rec.operatorResetLink("ghost@x.test", "support", "verified by phone")).rejects.toThrow(/No account/);
    const { link } = await rec.operatorResetLink(u.email, "support", "verified by phone");
    expect(link.startsWith("https://app.example.test/reset-password?token=")).toBe(true);
  });

  it("reset-mfa turns off two-step verification, ends sessions, and is audited with who and why", async () => {
    const u = await user({ mfa: true });
    const r = await rec.operatorResetMfa(u.email, "support", "owner confirmed by video call");
    expect(r.sessionsEnded).toBe(2);
    const db = await getDb();
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after).toMatchObject({ mfaSecretEnc: null, mfaEnabledAt: null, mfaRecoveryHashes: [] });
    const [ev] = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "mfa.reset_by_operator"), eq(schema.auditEvents.targetId, u.id)));
    expect(ev.details).toMatchObject({ by: "support", reason: "owner confirmed by video call" });
    await expect(rec.operatorResetMfa(u.email, "support", "again please")).rejects.toThrow(/doesn't have two-step/);
  });
});
