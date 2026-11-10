import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-authforms-"));

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

const { logIn, signUp } = await import("@/app/actions/auth");
const { getDb, schema } = await import("./db/client");
const { hashPassword } = await import("./auth/password");

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

/**
 * Regression: React 19 resets a form after its action, which cleared the email after a failed
 * sign-in. The actions now return what was typed (never the password) for the form to show again.
 */
describe("sign-in and sign-up keep what was typed after an error", () => {
  it("a failed sign-in returns the error and the email as typed, never the password", async () => {
    const db = await getDb();
    await db.insert(schema.users).values({ email: "keep@x.test", name: "Keep", passwordHash: await hashPassword("right-password-1") });
    ip = "198.51.100.10";
    for (const email of ["keep@x.test", " Keep@X.test ", "nobody@x.test"]) {
      const r = await logIn({}, form({ email, password: "wrong-password-1" }));
      expect(r).toEqual({ error: "Email or password is incorrect.", values: { email } });
      expect(JSON.stringify(r)).not.toContain("wrong-password-1");
    }
  });

  it("a rate-limited sign-in also keeps the email", async () => {
    ip = "198.51.100.20";
    let r: Awaited<ReturnType<typeof logIn>> = {};
    for (let i = 0; i < 11; i++) r = await logIn({}, form({ email: "limited@x.test", password: "pw-attempt-123" }));
    expect(r.error).toMatch(/Too many sign-in attempts/);
    expect(r.values).toEqual({ email: "limited@x.test" });
    expect(JSON.stringify(r)).not.toContain("pw-attempt-123");
  });

  it("a successful sign-in still redirects to the dashboard", async () => {
    ip = "198.51.100.30";
    await expect(logIn({}, form({ email: "keep@x.test", password: "right-password-1" }))).rejects.toThrow("REDIRECT /dashboard");
  });

  it("a failed sign-up keeps name, email, workspace and type, never the password", async () => {
    ip = "198.51.100.40";
    const typed = { name: "Ada", email: "keep@x.test", workspace: "Ada Studio", type: "agency" };
    const exists = await signUp({}, form({ ...typed, password: "supersecret-9" }));
    expect(exists).toEqual({ error: "An account with this email already exists.", values: typed });
    const invalid = await signUp({}, form({ ...typed, email: "new@x.test", password: "short" }));
    expect(invalid).toEqual({ error: "Use at least 8 characters", values: { ...typed, email: "new@x.test" } });
    expect(JSON.stringify([exists, invalid])).not.toMatch(/supersecret-9|short"/);
  });

  it("echoed values are length-capped", async () => {
    ip = "198.51.100.50";
    const r = await logIn({}, form({ email: "a".repeat(5000), password: "x" }));
    expect(r.values?.email).toHaveLength(320);
  });
});
