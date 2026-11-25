/**
 * Email (docs/EMAIL.md): provider drivers, verification links, invitations (create, email, accept,
 * resend, expire, revoke) and the verification requirement in the access guards. The memory driver
 * stands in for the inbox; provider HTTP calls go to a stubbed fetch. Nothing is sent anywhere.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.EMAIL_PROVIDER = "memory";
delete process.env.DEPLOY_ENV;

const { getDb, schema } = await import("./db/client");
const email = await import("./email");
const verify = await import("./auth/verify-email");
const m = await import("./members");
const { requireBrandForUser, AccessError } = await import("./auth/guard");
const { checkConfig } = await import("./config");
const { RateLimitError } = await import("./ratelimit");
const { notifyAccountChange } = await import("./auth/notify");
type SessionUser = import("./auth/session").SessionUser;

let n = 0;
async function user(o: { verified?: boolean; email?: string } = {}) {
  const db = await getDb();
  const e = o.email ?? `u${n++}-${Date.now()}@x.test`;
  const [u] = await db.insert(schema.users).values({ email: e, name: "User", passwordHash: "x", emailVerifiedAt: o.verified === false ? null : new Date() }).returning();
  const s: SessionUser = { sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name }, emailVerified: Boolean(u.emailVerifiedAt) };
  await db.insert(schema.sessions).values({ id: s.sessionId, userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  return s;
}
async function org() {
  const db = await getDb();
  const admin = await user();
  const [w] = await db.insert(schema.workspaces).values({ name: `Org ${n++}`, plan: "agency" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Brand" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: admin.user.id, role: "owner" });
  return { ws: w.id, brand: b.id, admin };
}
const inbox = (to: string) => email.memoryOutbox().filter((x) => x.to === to);
const linkToken = (text: string, path: string) => new URL(text.match(new RegExp(`https?://\\S+/${path}\\?token=\\S+`))![0]).searchParams.get("token")!;

afterEach(() => {
  delete process.env.EMAIL_VERIFICATION;
  vi.useRealTimers();
});

describe("email providers", () => {
  it("development drivers are refused in staging and production; real providers need a key and a sender", () => {
    for (const p of ["log", "file", "memory", ""]) expect(() => email.emailProvider({ EMAIL_PROVIDER: p, DEPLOY_ENV: "production" })).toThrow(email.EmailNotConfigured);
    expect(() => email.emailProvider({ EMAIL_PROVIDER: "postmark", EMAIL_FROM: "a@b.c" })).toThrow(/EMAIL_API_KEY/);
    expect(() => email.emailProvider({ EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "k" })).toThrow(/EMAIL_FROM/);
    expect(email.emailProvider({ EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "k", EMAIL_FROM: "B <a@b.c>", DEPLOY_ENV: "production" }).name).toBe("postmark");
    expect(() => email.emailProvider({ EMAIL_PROVIDER: "sendmail" })).toThrow(/Unknown/);
    const errs = (env: Record<string, string>) => checkConfig(env).filter((p) => p.level === "error").map((p) => p.key);
    expect(errs({ EMAIL_PROVIDER: "postmark" })).toEqual(expect.arrayContaining(["EMAIL_API_KEY", "EMAIL_FROM"]));
    expect(errs({ EMAIL_PROVIDER: "file", DEPLOY_ENV: "staging" })).toContain("EMAIL_PROVIDER");
    expect(errs({ EMAIL_VERIFICATION: "optional", DEPLOY_ENV: "production" })).toContain("EMAIL_VERIFICATION");
  });

  it("Postmark and Resend adapters send the documented request; errors never contain the key or recipient", async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const real = globalThis.fetch;
    let status = 200;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(status === 200 ? { MessageID: "pm-1", id: "rs-1" } : { Message: "Invalid sender", message: "Invalid sender" }), { status });
    }) as typeof fetch;
    try {
      const msg = { to: "person@example.com", subject: "S", text: "T", tag: "auth.verify_email" };
      expect(await email.postmarkDriver("pm-secret", "B <a@b.c>").send(msg)).toEqual({ delivered: true, provider: "postmark", id: "pm-1" });
      expect(calls[0]).toMatchObject({ url: "https://api.postmarkapp.com/email", headers: { "X-Postmark-Server-Token": "pm-secret" }, body: { From: "B <a@b.c>", To: "person@example.com", Subject: "S", TextBody: "T", MessageStream: "outbound" } });
      expect(await email.resendDriver("rs-secret", "B <a@b.c>").send(msg)).toEqual({ delivered: true, provider: "resend", id: "rs-1" });
      expect(calls[1]).toMatchObject({ url: "https://api.resend.com/emails", headers: { authorization: "Bearer rs-secret" }, body: { from: "B <a@b.c>", to: ["person@example.com"], tags: [{ name: "category", value: "auth_verify_email" }] } });
      status = 422;
      const e = await email.postmarkDriver("pm-secret", "B <a@b.c>").send(msg).catch((x: Error) => x);
      expect(e).toBeInstanceOf(email.EmailSendError);
      expect((e as Error).message).toBe("Email provider answered 422: Invalid sender");
      expect((e as Error).message).not.toMatch(/pm-secret|person@/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("email verification", () => {
  it("required by default in staging and production, optional in development; never optional when strict", () => {
    expect(verify.emailVerificationRequired({})).toBe(false);
    expect(verify.emailVerificationRequired({ DEPLOY_ENV: "production" })).toBe(true);
    expect(verify.emailVerificationRequired({ EMAIL_VERIFICATION: "required" })).toBe(true);
    expect(verify.emailVerificationRequired({ EMAIL_VERIFICATION: "optional", DEPLOY_ENV: "staging" })).toBe(true);
  });

  it("a link is single use, works only for the newest email, expires after 24 hours, and is bound to the address", async () => {
    const u = await user({ verified: false });
    await verify.sendVerification(u.user.id);
    const first = linkToken(inbox(u.user.email).at(-1)!.text, "verify-email");
    await verify.sendVerification(u.user.id);
    const second = linkToken(inbox(u.user.email).at(-1)!.text, "verify-email");
    expect(await verify.verifyEmail(first)).toMatchObject({ ok: false }); // voided by the newer link
    expect(await verify.verifyEmail(second)).toEqual({ ok: true, acceptedInvites: 0 });
    expect(await verify.verifyEmail(second)).toMatchObject({ ok: false }); // single use
    expect(await verify.isEmailVerified(u.user.id)).toBe(true);
    const db = await getDb();
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "auth.email_verified"), eq(schema.auditEvents.actorUserId, u.user.id)))).toBe(1);
    // Expiry.
    const v = await user({ verified: false });
    await verify.sendVerification(v.user.id);
    const t = linkToken(inbox(v.user.email).at(-1)!.text, "verify-email");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + verify.VERIFY_TTL_MS + 1000 });
    expect(await verify.verifyEmail(t)).toMatchObject({ ok: false });
    vi.useRealTimers();
    // The address changed after the link was sent: the link proves nothing about the new one.
    const w = await user({ verified: false });
    await verify.sendVerification(w.user.id);
    const tw = linkToken(inbox(w.user.email).at(-1)!.text, "verify-email");
    await db.update(schema.users).set({ email: `changed-${w.user.email}` }).where(eq(schema.users.id, w.user.id));
    expect(await verify.verifyEmail(tw)).toMatchObject({ ok: false });
    expect(await verify.isEmailVerified(w.user.id)).toBe(false);
    for (const bad of ["", "x".repeat(300), "not-a-token"]) expect(await verify.verifyEmail(bad)).toMatchObject({ ok: false });
  });

  it("sending again is rate-limited per account; an already verified account gets nothing", async () => {
    const u = await user({ verified: false });
    for (let i = 0; i < 5; i++) await verify.resendVerification(u.user.id);
    await expect(verify.resendVerification(u.user.id)).rejects.toBeInstanceOf(RateLimitError);
    const v = await user();
    expect(await verify.sendVerification(v.user.id)).toEqual({ delivered: false });
    expect(inbox(v.user.email)).toEqual([]);
  });

  it("when required, the access guards refuse an unverified account (actions and routes, not only pages)", async () => {
    process.env.EMAIL_VERIFICATION = "required";
    const o = await org();
    const db = await getDb();
    const u = await user({ verified: false });
    await db.insert(schema.workspaceMembers).values({ workspaceId: o.ws, userId: u.user.id, role: "editor" });
    await expect(requireBrandForUser(u, o.brand, "viewer")).rejects.toThrow(/Confirm your email address first/);
    await expect(requireBrandForUser(u, o.brand, "viewer")).rejects.toBeInstanceOf(AccessError);
    await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, u.user.id));
    await expect(requireBrandForUser(u, o.brand, "viewer")).resolves.toBeTruthy(); // checked against the database
    process.env.EMAIL_VERIFICATION = "optional";
    const x = await user({ verified: false });
    await db.insert(schema.workspaceMembers).values({ workspaceId: o.ws, userId: x.user.id, role: "editor" });
    await expect(requireBrandForUser(x, o.brand, "viewer")).resolves.toBeTruthy();
  });
});

describe("invitations", () => {
  it("are emailed with a single-use link; signing up with the address doesn't join until it's verified; verifying joins", async () => {
    const o = await org();
    const addr = `new-${Date.now()}@x.test`;
    const inv = await m.inviteMemberFor(o.admin, o.ws, addr, "editor");
    expect(inv).toMatchObject({ status: "invited", delivered: true });
    expect(inbox(addr).at(-1)!.subject).toMatch(/invited you to Org/);
    // The person signs up with that address but hasn't verified it: not a member yet.
    const u = await user({ verified: false, email: addr });
    const db = await getDb();
    expect(await db.$count(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, o.ws), eq(schema.workspaceMembers.userId, u.user.id)))).toBe(0);
    await verify.sendVerification(u.user.id);
    const r = await verify.verifyEmail(linkToken(inbox(addr).at(-1)!.text, "verify-email"));
    expect(r).toEqual({ ok: true, acceptedInvites: 1 });
    const [mem] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, o.ws), eq(schema.workspaceMembers.userId, u.user.id)));
    expect(mem).toMatchObject({ role: "editor", status: "active", inviteTokenHash: null });
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "member.invite_accept"), eq(schema.auditEvents.workspaceId, o.ws)))).toBe(1);
  });

  it("accepting with the link: only the invited address, once; it also verifies that address", async () => {
    const o = await org();
    const addr = `link-${Date.now()}@x.test`;
    await m.inviteMemberFor(o.admin, o.ws, addr, "viewer");
    const token = linkToken(inbox(addr).at(-1)!.text, "invite");
    expect(await m.inviteInfo(token)).toMatchObject({ email: addr, role: "viewer" });
    const stranger = await user();
    await expect(m.acceptInviteFor(stranger, token)).rejects.toThrow(/different email address/);
    const invitee = await user({ verified: false, email: addr });
    expect(await m.acceptInviteFor(invitee, token)).toMatchObject({ alreadyMember: false });
    expect(await verify.isEmailVerified(invitee.user.id)).toBe(true);
    await expect(m.acceptInviteFor(invitee, token)).rejects.toThrow(/invalid, has expired/);
    expect(await m.inviteInfo(token)).toBeNull();
  });

  it("resend replaces the link; revoking or expiry makes it invalid; duplicates are refused", async () => {
    const o = await org();
    const addr = `re-${Date.now()}@x.test`;
    const inv = await m.inviteMemberFor(o.admin, o.ws, addr, "editor");
    const old = linkToken(inbox(addr).at(-1)!.text, "invite");
    await expect(m.inviteMemberFor(o.admin, o.ws, addr, "viewer")).rejects.toThrow(/already a member or has a pending invitation/);
    await m.resendInviteFor(o.admin, o.ws, inv.id);
    const fresh = linkToken(inbox(addr).at(-1)!.text, "invite");
    expect(fresh).not.toBe(old);
    expect(await m.inviteInfo(old)).toBeNull();
    expect(await m.inviteInfo(fresh)).not.toBeNull();
    // Expiry (7 days).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + m.INVITE_TTL_MS + 1000 });
    expect(await m.inviteInfo(fresh)).toBeNull();
    const late = await user({ email: addr });
    expect(await m.acceptInvitesForVerifiedEmail(late.user.id, addr)).toBe(0);
    vi.useRealTimers();
    // Revoke.
    await m.removeMemberFor(o.admin, o.ws, inv.id);
    expect(await m.inviteInfo(fresh)).toBeNull();
    const db = await getDb();
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "member.invite_revoke"), eq(schema.auditEvents.workspaceId, o.ws)))).toBe(1);
    expect(await db.$count(schema.auditEvents, and(eq(schema.auditEvents.action, "member.invite_resend"), eq(schema.auditEvents.workspaceId, o.ws)))).toBe(1);
  });

  it("only admins of the organisation invite; invitations are rate-limited", async () => {
    const o = await org();
    const other = await org();
    await expect(m.inviteMemberFor(other.admin, o.ws, "x@x.test", "editor")).rejects.toBeInstanceOf(AccessError);
    const db = await getDb();
    const ed = await user();
    await db.insert(schema.workspaceMembers).values({ workspaceId: o.ws, userId: ed.user.id, role: "editor" });
    await expect(m.inviteMemberFor(ed, o.ws, "y@x.test", "editor")).rejects.toBeInstanceOf(AccessError);
    await db.update(schema.plans).set({ limits: { brands: 50, seats: 500, socialAccounts: 50, aiRunsPerMonth: 5000 } }).where(eq(schema.plans.key, "agency"));
    let limited: unknown = null;
    for (let i = 0; i < 25 && !limited; i++) limited = await m.inviteMemberFor(o.admin, o.ws, `bulk${i}-${Date.now()}@x.test`, "viewer").then(() => null, (e: unknown) => e);
    expect(limited).toBeInstanceOf(RateLimitError);
  });
});

describe("security notifications", () => {
  it("credential and two-step changes are emailed to the account holder", async () => {
    const u = await user();
    await notifyAccountChange(u.user.id, "password_reset");
    await notifyAccountChange(u.user.id, "mfa_disabled");
    expect(inbox(u.user.email).map((x) => x.subject)).toEqual(["Your BrandPilot password was changed", "Two-step verification was turned off"]);
  });
});
