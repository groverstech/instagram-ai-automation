import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";

const { getDb, schema } = await import("./db/client");
const totp = await import("./auth/totp");
const { startEnrolment, confirmEnrolment } = await import("./auth/mfa");
const { requireRecentSecondFactor, confirmStepUp, signOutOtherSessions, safeNext, StepUpRequired, STEP_UP_WINDOW_MS } = await import("./auth/step-up");
const { changeRoleFor, inviteMemberFor } = await import("./members");
type SessionUser = import("./auth/session").SessionUser;

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
let n = 0;

async function owner(withMfa: boolean) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `su${n++}@x.test`, name: "O", passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "W", plan: "agency" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role: "owner", status: "active" });
  const sessionId = `s-${u.id}`;
  await db.insert(schema.sessions).values({ id: sessionId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  const session: SessionUser = { sessionId, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } };
  let secret = "";
  if (withMfa) {
    secret = (await startEnrolment(u.id)).secret;
    await confirmEnrolment(u.id, sessionId, totp.totpAt(secret, T0), T0); // marks this session verified at T0
  }
  return { user: u, workspaceId: w.id, session, secret };
}

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
});

describe("step-up verification for sensitive actions", () => {
  it("people without two-step verification aren't asked", async () => {
    const o = await owner(false);
    await expect(requireRecentSecondFactor(o.session, T0)).resolves.toBeUndefined();
  });

  it("with MFA on, a factor verified in the last 15 minutes passes; an older one asks again; a code refreshes it", async () => {
    const o = await owner(true);
    await expect(requireRecentSecondFactor(o.session, T0 + 60_000)).resolves.toBeUndefined();
    await expect(requireRecentSecondFactor(o.session, T0 + STEP_UP_WINDOW_MS + 1)).rejects.toBeInstanceOf(StepUpRequired);
    const later = T0 + STEP_UP_WINDOW_MS + 60_000;
    await expect(confirmStepUp(o.session, "000000", later)).rejects.toThrow(/isn't right/);
    expect(await confirmStepUp(o.session, totp.totpAt(o.secret, later), later)).toBe("totp");
    await expect(requireRecentSecondFactor(o.session, later + 1000)).resolves.toBeUndefined();
    const db = await getDb();
    expect(await db.$count(schema.auditEvents, eq(schema.auditEvents.action, "mfa.step_up"))).toBeGreaterThan(0);
  });

  it("member changes ask for a fresh factor (real clock: the enrolment verification is from the past)", async () => {
    const o = await owner(true);
    const db = await getDb();
    // Make the session's verification old.
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) }).where(eq(schema.sessions.id, o.session.sessionId));
    await expect(inviteMemberFor(o.session, o.workspaceId, "new@x.test", "editor")).rejects.toBeInstanceOf(StepUpRequired);
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date() }).where(eq(schema.sessions.id, o.session.sessionId));
    await inviteMemberFor(o.session, o.workspaceId, "new@x.test", "editor");
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.invitedEmail, "new@x.test"));
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) }).where(eq(schema.sessions.id, o.session.sessionId));
    await expect(changeRoleFor(o.session, o.workspaceId, m.id, "viewer")).rejects.toBeInstanceOf(StepUpRequired);
  });

  it("sign out everywhere else ends the other sessions only, and needs a fresh factor", async () => {
    const o = await owner(true);
    const db = await getDb();
    await db.insert(schema.sessions).values([
      { id: `other1-${o.user.id}`, userId: o.user.id, expiresAt: new Date(Date.now() + 86400_000) },
      { id: `other2-${o.user.id}`, userId: o.user.id, expiresAt: new Date(Date.now() + 86400_000) },
    ]);
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date() }).where(eq(schema.sessions.id, o.session.sessionId));
    expect(await signOutOtherSessions(o.session)).toBe(2);
    const left = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, o.user.id));
    expect(left.map((s) => s.id)).toEqual([o.session.sessionId]);
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) }).where(eq(schema.sessions.id, o.session.sessionId));
    await expect(signOutOtherSessions(o.session)).rejects.toBeInstanceOf(StepUpRequired);
  });

  it("/account/verify only continues to same-site paths", () => {
    expect(safeNext("/api/oauth/instagram/start?brand=abc-123")).toBe("/api/oauth/instagram/start?brand=abc-123");
    for (const bad of ["https://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "/x\"><script>", ""]) expect(safeNext(bad)).toBe("/dashboard");
  });
});
