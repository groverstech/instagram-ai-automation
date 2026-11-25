/**
 * Sign-up doesn't reveal whether an address has an account (gate S5, follow-up F1), wherever email
 * verification is required (staging and production; forced here with EMAIL_VERIFICATION=required).
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.EMAIL_PROVIDER = "memory";
process.env.EMAIL_VERIFICATION = "required";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-signup-enum-"));

let ip = "198.51.100.1";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": ip }),
  cookies: async () => ({ get: () => undefined, set() {}, delete() {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { signUp } = await import("@/app/actions/auth");
const { getDb, schema } = await import("./db/client");
const { hashPassword } = await import("./auth/password");
const { memoryOutbox } = await import("./email");
const { verifyEmail } = await import("./auth/verify-email");

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const outcome = (p: Promise<unknown>) => p.then((r) => ({ returned: r }), (e: Error) => ({ threw: e.message }));
const sessionsFor = async (email: string) => {
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return u ? db.$count(schema.sessions, eq(schema.sessions.userId, u.id)) : 0;
};

describe("sign-up with verification required", () => {
  it("a new address and an address that already has an account get the same answer; nobody is signed in", async () => {
    const db = await getDb();
    await db.insert(schema.users).values({ email: "taken@x.test", name: "Owner", passwordHash: await hashPassword("owners-password-1"), emailVerifiedAt: new Date() });
    const [before] = await db.select().from(schema.users).where(eq(schema.users.email, "taken@x.test"));
    ip = "198.51.100.10";
    const fresh = await outcome(signUp({}, form({ name: "New", email: "fresh@x.test", password: "supersecret-1", workspace: "Fresh Studio", type: "business" })));
    const taken = await outcome(signUp({}, form({ name: "Intruder", email: "taken@x.test", password: "supersecret-2", workspace: "Other", type: "business" })));
    // Identical: the same redirect, no error message, no form state.
    expect(fresh).toEqual({ threw: "REDIRECT /verify-email?sent=1" });
    expect(taken).toEqual(fresh);
    // Nobody is signed in by sign-up.
    expect(await sessionsFor("fresh@x.test")).toBe(0);
    expect(await sessionsFor("taken@x.test")).toBe(0);
    // The existing account is untouched: same password, no second account, no new organisation.
    const [after] = await db.select().from(schema.users).where(eq(schema.users.email, "taken@x.test"));
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe("Owner");
    expect(await db.$count(schema.workspaces, eq(schema.workspaces.name, "Other"))).toBe(0);
    // Each address gets the email that fits it.
    const mail = memoryOutbox();
    expect(mail.filter((m) => m.to === "fresh@x.test").map((m) => m.subject)).toEqual(["Confirm your email for BrandPilot"]);
    const notice = mail.filter((m) => m.to === "taken@x.test");
    expect(notice.map((m) => m.subject)).toEqual(["Someone tried to create a BrandPilot account with your email"]);
    expect(notice[0].text).toMatch(/\/login/);
    expect(notice[0].text).not.toContain("supersecret-2");
    // Audited without revealing anything to the person signing up.
    expect(await db.$count(schema.auditEvents, eq(schema.auditEvents.action, "auth.signup_existing_email"))).toBe(1);
  });

  it("the new account confirms its address from the email and then signs in", async () => {
    const link = memoryOutbox().filter((m) => m.to === "fresh@x.test").at(-1)!.text.match(/token=([^\s]+)/)![1];
    expect(await verifyEmail(decodeURIComponent(link))).toMatchObject({ ok: true });
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, "fresh@x.test"));
    expect(u.emailVerifiedAt).not.toBeNull();
  });

  it("repeated attempts on an existing address don't flood its inbox", async () => {
    ip = "198.51.100.20";
    const before = memoryOutbox().filter((m) => m.to === "taken@x.test").length;
    for (let i = 0; i < 12; i++) {
      ip = `198.51.100.${30 + i}`; // different IPs, so the per-IP sign-up limit isn't what stops it
      expect(await outcome(signUp({}, form({ name: "X", email: "taken@x.test", password: "supersecret-3", workspace: "W", type: "business" })))).toEqual({ threw: "REDIRECT /verify-email?sent=1" });
    }
    const sent = memoryOutbox().filter((m) => m.to === "taken@x.test").length - before;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(12);
  });
});
