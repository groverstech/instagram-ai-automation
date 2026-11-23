/**
 * Invitation-only sign-up for the private beta (beta-invites.ts). Before this, anyone who found the
 * sign-up page could create an organisation and start using AI features.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-invite-"));

let ip = "198.51.100.60";
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
const { addBetaInvite, revokeBetaInvite, signupMode, NOT_INVITED, BetaInviteError } = await import("./beta-invites");
const { checkConfig } = await import("./config");

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
let n = 0;
/** Sign up; returns the form state, or "created" when it redirected (account made). */
async function trySignUp(email: string) {
  ip = `198.51.100.${70 + (n++ % 100)}`; // a fresh IP each time, clear of the sign-up rate limit
  try {
    return await signUp({}, form({ name: "N", email, password: "a-strong-password", workspace: "W", type: "business" }));
  } catch (e) {
    if (String((e as Error).message).startsWith("REDIRECT")) return "created";
    throw e;
  }
}
const accounts = async (email: string) => (await getDb()).$count(schema.users, eq(schema.users.email, email));

afterEach(() => {
  delete process.env.SIGNUP_MODE;
});

describe("invitation-only sign-up", () => {
  it("defaults: invite_only in staging and production, open elsewhere; an unknown value fails closed", () => {
    expect(signupMode({ DEPLOY_ENV: "production" })).toBe("invite_only");
    expect(signupMode({ DEPLOY_ENV: "staging" })).toBe("invite_only");
    expect(signupMode({ DEPLOY_ENV: "development" })).toBe("open");
    expect(signupMode({})).toBe("open");
    expect(signupMode({ DEPLOY_ENV: "production", SIGNUP_MODE: "open" })).toBe("open");
    expect(signupMode({ SIGNUP_MODE: "invite-only" })).toBe("invite_only"); // typo: fails closed
    expect(checkConfig({ SIGNUP_MODE: "invite-only" }).map((p) => p.key)).toContain("SIGNUP_MODE");
    expect(checkConfig({ DEPLOY_ENV: "production", SIGNUP_MODE: "open" }).some((p) => p.key === "SIGNUP_MODE" && p.level === "warning")).toBe(true);
  });

  it("an uninvited email is refused, and no account or organisation is created", async () => {
    process.env.SIGNUP_MODE = "invite_only";
    const before = await (await getDb()).$count(schema.workspaces);
    expect(await trySignUp("stranger@x.test")).toMatchObject({ error: NOT_INVITED, values: { email: "stranger@x.test" } });
    expect(await accounts("stranger@x.test")).toBe(0);
    expect(await (await getDb()).$count(schema.workspaces)).toBe(before);
  });

  it("an email on the beta list can sign up once; the invitation is then used", async () => {
    process.env.SIGNUP_MODE = "invite_only";
    await addBetaInvite("  Beta.User@X.test ", "ops", "pilot agency");
    expect(await trySignUp("beta.user@x.test")).toBe("created");
    expect(await accounts("beta.user@x.test")).toBe(1);
    const [inv] = await (await getDb()).select().from(schema.betaInvites).where(eq(schema.betaInvites.email, "beta.user@x.test"));
    expect(inv.usedAt).toBeInstanceOf(Date);
    await expect(addBetaInvite("beta.user@x.test", "ops")).rejects.toBeInstanceOf(BetaInviteError);
    const db = await getDb();
    expect(await db.$count(schema.auditEvents, eq(schema.auditEvents.action, "beta.invite_add"))).toBeGreaterThan(0);
  });

  it("an email with a pending organisation invitation can sign up and joins that organisation", async () => {
    process.env.SIGNUP_MODE = "invite_only";
    const db = await getDb();
    const [w] = await db.insert(schema.workspaces).values({ name: "Agency" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, invitedEmail: "client@x.test", role: "viewer", status: "invited" });
    expect(await trySignUp("client@x.test")).toBe("created");
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.invitedEmail, "client@x.test"));
    expect(m).toMatchObject({ workspaceId: w.id, status: "active" });
  });

  it("a revoked invitation no longer works", async () => {
    process.env.SIGNUP_MODE = "invite_only";
    await addBetaInvite("revoked@x.test", "ops");
    expect(await revokeBetaInvite("revoked@x.test", "ops")).toBe(true);
    expect(await trySignUp("revoked@x.test")).toMatchObject({ error: NOT_INVITED });
  });

  it("an uninvited email gets the same refusal whether or not it has an account (no enumeration)", async () => {
    process.env.SIGNUP_MODE = "invite_only";
    const db = await getDb();
    await db.insert(schema.users).values({ email: "existing@x.test", name: "E", passwordHash: "x" });
    const a = await trySignUp("existing@x.test");
    const b = await trySignUp("never-seen@x.test");
    expect(a).toMatchObject({ error: NOT_INVITED });
    expect(b).toMatchObject({ error: NOT_INVITED });
  });

  it("open mode is unchanged: anyone can sign up", async () => {
    process.env.SIGNUP_MODE = "open";
    expect(await trySignUp("anyone@x.test")).toBe("created");
  });
});
