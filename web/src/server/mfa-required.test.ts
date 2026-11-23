/**
 * Required two-step verification is enforced for server actions and API routes, not only by the page
 * layout's redirect (F3a/F3b). Before this, an owner or admin who was required to have MFA but hadn't
 * set it up passed every step-up check ("people without MFA aren't asked"), so a password alone could
 * export the organisation, change members, billing or social connections by calling actions or API
 * routes directly. Also: deleting data asks for a recent second factor like other sensitive actions.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";

const { getDb, schema } = await import("./db/client");
const totp = await import("./auth/totp");
const { startEnrolment, confirmEnrolment, MfaEnrolmentRequired } = await import("./auth/mfa");
const { requireRecentSecondFactor, StepUpRequired, STEP_UP_WINDOW_MS } = await import("./auth/step-up");
const { requireBrandForUser, requireWorkspaceRoleForUser } = await import("./auth/guard");
const { exportReadyFor } = await import("./tenant-export");
const { inviteMemberFor } = await import("./members");
const { deleteBrandFor } = await import("./deletion");
const { checkConfig } = await import("./config");
type SessionUser = import("./auth/session").SessionUser;

let n = 0;

async function member(role: "owner" | "admin" | "editor", opts: { mfa?: boolean } = {}) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `mr${n++}@x.test`, name: "M", passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "W", plan: "agency" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: `Brand ${n}` }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role, status: "active" });
  const sessionId = `s-${u.id}`;
  await db.insert(schema.sessions).values({ id: sessionId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  // As tests and some callers build it: without the optional mfaEnabled flag.
  const session: SessionUser = { sessionId, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } };
  if (opts.mfa) {
    const secret = (await startEnrolment(u.id)).secret;
    await confirmEnrolment(u.id, sessionId, totp.totpAt(secret, Date.now()), Date.now());
  }
  return { user: u, workspaceId: w.id, brand: b, session };
}

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
});
afterEach(() => {
  delete process.env.MFA_REQUIRED_FOR_ADMINS;
});

describe("required MFA is enforced for actions and API routes, not only pages", () => {
  it("an owner who hasn't set up required MFA is refused by the guards, step-up and the export", async () => {
    process.env.MFA_REQUIRED_FOR_ADMINS = "true";
    const o = await member("owner");
    await expect(requireWorkspaceRoleForUser(o.session, o.workspaceId, "viewer")).rejects.toBeInstanceOf(MfaEnrolmentRequired);
    await expect(requireBrandForUser(o.session, o.brand.id, "viewer")).rejects.toBeInstanceOf(MfaEnrolmentRequired);
    await expect(requireRecentSecondFactor(o.session)).rejects.toBeInstanceOf(MfaEnrolmentRequired);
    await expect(exportReadyFor(o.session, o.workspaceId)).rejects.toBeInstanceOf(MfaEnrolmentRequired);
    await expect(inviteMemberFor(o.session, o.workspaceId, "x@x.test", "editor")).rejects.toBeInstanceOf(MfaEnrolmentRequired);
    // Nothing was changed.
    const db = await getDb();
    expect(await db.$count(schema.workspaceMembers, eq(schema.workspaceMembers.invitedEmail, "x@x.test"))).toBe(0);
  });

  it("an admin is refused too; an editor (not an owner or admin anywhere) isn't affected", async () => {
    process.env.MFA_REQUIRED_FOR_ADMINS = "true";
    const a = await member("admin");
    await expect(requireBrandForUser(a.session, a.brand.id, "editor")).rejects.toBeInstanceOf(MfaEnrolmentRequired);
    const e = await member("editor");
    await expect(requireBrandForUser(e.session, e.brand.id, "editor")).resolves.toMatchObject({ role: "editor" });
    await expect(requireRecentSecondFactor(e.session)).resolves.toBeUndefined();
  });

  it("once MFA is set up, the guards pass and step-up asks for a recent factor as before", async () => {
    process.env.MFA_REQUIRED_FOR_ADMINS = "true";
    const o = await member("owner", { mfa: true });
    await expect(requireWorkspaceRoleForUser(o.session, o.workspaceId, "owner")).resolves.toMatchObject({ role: "owner" });
    await expect(requireRecentSecondFactor(o.session)).resolves.toBeUndefined(); // verified at enrolment
    await expect(requireRecentSecondFactor(o.session, Date.now() + STEP_UP_WINDOW_MS + 60_000)).rejects.toBeInstanceOf(StepUpRequired);
  });

  it("where MFA isn't required (development default), nothing changes for owners without it", async () => {
    process.env.MFA_REQUIRED_FOR_ADMINS = "false";
    const o = await member("owner");
    await expect(requireWorkspaceRoleForUser(o.session, o.workspaceId, "owner")).resolves.toMatchObject({ role: "owner" });
    await expect(requireRecentSecondFactor(o.session)).resolves.toBeUndefined();
  });
});

describe("deleting data asks for a recent second factor", () => {
  it("a brand deletion with a stale factor is refused, and the brand stays; with a fresh one it goes", async () => {
    const o = await member("owner", { mfa: true });
    const db = await getDb();
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) }).where(eq(schema.sessions.id, o.session.sessionId));
    await expect(deleteBrandFor(o.session, o.brand.id, o.brand.name)).rejects.toBeInstanceOf(StepUpRequired);
    expect(await db.$count(schema.brands, eq(schema.brands.id, o.brand.id))).toBe(1);
    await db.update(schema.sessions).set({ mfaVerifiedAt: new Date() }).where(eq(schema.sessions.id, o.session.sessionId));
    await deleteBrandFor(o.session, o.brand.id, o.brand.name);
    expect(await db.$count(schema.brands, eq(schema.brands.id, o.brand.id))).toBe(0);
  });
});

describe("configuration check", () => {
  const names = (env: Record<string, string>) => checkConfig(env).map((p) => p.key);
  it("a missing OPENAI_API_KEY is reported even when CREDITS_MODE is invalid, and not when IMAGE_PROVIDER is invalid", () => {
    expect(names({ CREDITS_MODE: "bogus" })).toEqual(expect.arrayContaining(["CREDITS_MODE", "OPENAI_API_KEY"]));
    expect(names({ IMAGE_PROVIDER: "bogus" })).toContain("IMAGE_PROVIDER");
    expect(names({ IMAGE_PROVIDER: "bogus" })).not.toContain("OPENAI_API_KEY");
    expect(names({ IMAGE_PROVIDER: "none" })).not.toContain("OPENAI_API_KEY");
  });
});
