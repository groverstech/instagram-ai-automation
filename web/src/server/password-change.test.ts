/** Changing the password while signed in (ASVS 2.1.5). */
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.EMAIL_PROVIDER = "memory";

const { getDb, schema } = await import("./db/client");
const { hashPassword, verifyPassword } = await import("./auth/password");
const { changePassword, PasswordChangeError } = await import("./auth/password-change");
const { memoryOutbox } = await import("./email");
const { RateLimitError } = await import("./ratelimit");

async function account(email: string) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email, name: "Pat", passwordHash: await hashPassword("old-password-1") }).returning();
  for (const id of [`this-${u.id}`, `other1-${u.id}`, `other2-${u.id}`]) await db.insert(schema.sessions).values({ id, userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  return { sessionId: `this-${u.id}`, user: { id: u.id, email, name: "Pat" } };
}

describe("change password", () => {
  it("needs the current password: a wrong one changes nothing and is audited", async () => {
    const s = await account("wrong@x.test");
    await expect(changePassword(s, "not-the-password", "new-password-2")).rejects.toBeInstanceOf(PasswordChangeError);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id));
    expect(await verifyPassword("old-password-1", u.passwordHash)).toBe(true);
    expect(await db.$count(schema.sessions, eq(schema.sessions.userId, s.user.id))).toBe(3);
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "auth.password_change_failed"), eq(schema.auditEvents.targetId, s.user.id)))).toBe(1);
  });

  it("refuses a too-short password or the same one", async () => {
    const s = await account("rules@x.test");
    await expect(changePassword(s, "old-password-1", "short")).rejects.toThrow(/at least 8/);
    await expect(changePassword(s, "old-password-1", "old-password-1")).rejects.toThrow(/different/);
  });

  it("changes it, signs out every other session (not this one), audits and emails the holder", async () => {
    const s = await account("ok@x.test");
    expect(await changePassword(s, "old-password-1", "new-password-2")).toEqual({ otherSessionsEnded: 2 });
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id));
    expect(await verifyPassword("new-password-2", u.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password-1", u.passwordHash)).toBe(false);
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.userId, s.user.id))).map((x) => x.id)).toEqual([s.sessionId]);
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "auth.password_changed"), eq(schema.auditEvents.targetId, s.user.id)))).toBe(1);
    const mail = memoryOutbox().filter((m) => m.to === "ok@x.test");
    expect(mail.map((m) => m.subject)).toEqual(["Your BrandPilot password was changed"]);
    expect(mail[0].text).not.toContain("new-password-2");
  });

  it("guessing the current password is rate-limited like sign-in", async () => {
    const s = await account("guess@x.test");
    let limited = false;
    // Fixed 15-minute windows: pin the clock mid-window so the attempts can't straddle a boundary.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:07:00Z") });
    try {
      for (let i = 0; i < 15 && !limited; i++) {
        try {
          await changePassword(s, `guess-${i}-xxxx`, "new-password-3");
        } catch (e) {
          if (e instanceof RateLimitError) limited = true;
        }
      }
    } finally {
      vi.useRealTimers();
    }
    expect(limited).toBe(true);
  });
});
