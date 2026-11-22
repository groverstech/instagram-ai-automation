import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";

const { getDb, schema } = await import("./db/client");
const totp = await import("./auth/totp");
const { startEnrolment, confirmEnrolment, completeMfaChallenge, disableMfa, regenerateRecoveryCodes, mfaRequiredForAdmins, mfaRequiredFor, mfaStatus, MfaError } = await import("./auth/mfa");
const { checkConfig } = await import("./config");

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
let n = 0;

async function setup(role: "owner" | "editor" = "editor") {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `mfa${n++}@x.test`, name: "M", passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "W" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role, status: "active" });
  const sessionId = `sess-${u.id}`;
  await db.insert(schema.sessions).values({ id: sessionId, userId: u.id, expiresAt: new Date(T0 + 3600_000) });
  return { user: u, sessionId };
}
async function enrolled(role: "owner" | "editor" = "editor") {
  const s = await setup(role);
  const { secret } = await startEnrolment(s.user.id);
  const { recoveryCodes } = await confirmEnrolment(s.user.id, s.sessionId, totp.totpAt(secret, T0), T0);
  return { ...s, secret, recoveryCodes };
}

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
  delete process.env.MFA_REQUIRED_FOR_ADMINS;
});

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const key = Buffer.from("12345678901234567890");
    for (const [t, code] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ] as const) {
      expect(totp.hotp(key, Math.floor(t / 30), 8)).toBe(code);
    }
    expect(totp.base32Decode(totp.base32Encode(key)).equals(key)).toBe(true);
  });

  it("accepts the previous, current and next step only, and refuses reuse", () => {
    const secret = totp.newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = T0;
    const step = totp.stepAt(now);
    for (const d of [-1, 0, 1]) expect(totp.verifyTotp(secret, totp.totpAt(secret, now + d * 30_000), now)).toBe(step + d);
    expect(totp.verifyTotp(secret, totp.totpAt(secret, now - 90_000), now)).toBeNull();
    expect(totp.verifyTotp(secret, totp.totpAt(secret, now), now, step)).toBeNull(); // already used
    expect(totp.verifyTotp(secret, "12345", now)).toBeNull();
    expect(totp.otpauthUri(secret, "a@b.c")).toBe(`otpauth://totp/BrandPilot:a%40b.c?secret=${secret}&issuer=BrandPilot&algorithm=SHA1&digits=6&period=30`);
  });
});

describe("two-step verification", () => {
  it("enrolment: pending until a code confirms; then on, ten recovery codes stored only as keyed hashes; this session verified", async () => {
    const s = await setup();
    const db = await getDb();
    const { secret, qrSvgDataUrl } = await startEnrolment(s.user.id);
    expect(qrSvgDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    let [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id));
    expect(u.mfaEnabledAt).toBeNull();
    expect(u.mfaPendingSecretEnc).not.toContain(secret); // encrypted
    await expect(confirmEnrolment(s.user.id, s.sessionId, "000000", T0)).rejects.toBeInstanceOf(MfaError);
    const { recoveryCodes } = await confirmEnrolment(s.user.id, s.sessionId, totp.totpAt(secret, T0), T0);
    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id));
    expect(u.mfaEnabledAt).toBeInstanceOf(Date);
    expect(u.mfaPendingSecretEnc).toBeNull();
    expect(u.mfaRecoveryHashes).toHaveLength(10);
    expect(JSON.stringify(u.mfaRecoveryHashes)).not.toContain(recoveryCodes[0].replace("-", ""));
    const [sess] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.sessionId));
    expect(sess.mfaVerifiedAt).toBeInstanceOf(Date);
    expect(await db.$count(schema.auditEvents, eq(schema.auditEvents.action, "mfa.enable"))).toBeGreaterThan(0);
  });

  it("sign-in challenge: a fresh code completes it once; wrong or replayed codes fail and are audited; a recovery code works once", async () => {
    const s = await enrolled();
    const db = await getDb();
    const pending = `pending-${s.user.id}`;
    await db.insert(schema.sessions).values({ id: pending, userId: s.user.id, expiresAt: new Date(T0 + 600_000) });
    const later = T0 + 60_000; // a later step than the one used at enrolment
    await expect(completeMfaChallenge(pending, s.user.id, "111111", "203.0.113.1", later)).rejects.toThrow(/isn't right/);
    expect(await completeMfaChallenge(pending, s.user.id, totp.totpAt(s.secret, later), "203.0.113.1", later)).toBe("totp");
    const [ps] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, pending));
    expect(ps.mfaVerifiedAt).toBeInstanceOf(Date);
    await expect(completeMfaChallenge(pending, s.user.id, totp.totpAt(s.secret, later), null, later)).rejects.toThrow(/isn't right/); // replay
    expect(await completeMfaChallenge(pending, s.user.id, s.recoveryCodes[0].toUpperCase(), null, later)).toBe("recovery");
    await expect(completeMfaChallenge(pending, s.user.id, s.recoveryCodes[0], null, later)).rejects.toThrow(/isn't right/); // used up
    expect((await mfaStatus(s.user.id)).recoveryCodesLeft).toBe(9);
    const logins = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "auth.login"));
    expect(logins.filter((e) => e.actorUserId === s.user.id).map((e) => (e.details as { mfa: string }).mfa).sort()).toEqual(["recovery", "totp"]);
    expect(await db.$count(schema.auditEvents, eq(schema.auditEvents.action, "auth.mfa_failed"))).toBeGreaterThan(0);
  });

  it("code guessing is rate-limited", async () => {
    const s = await enrolled();
    // The enrolment confirmation counts too: 1 + 9 wrong guesses reach the limit of 10 per 15 minutes.
    for (let i = 0; i < 9; i++) await expect(completeMfaChallenge(s.sessionId, s.user.id, String(100000 + i), null, T0)).rejects.toThrow(/isn't right/);
    await expect(completeMfaChallenge(s.sessionId, s.user.id, totp.totpAt(s.secret, T0 + 30_000), null, T0 + 30_000)).rejects.toThrow(/Too many/i);
  });

  it("required for owners and admins when configured (default: staging and production); they can't turn it off", async () => {
    expect(mfaRequiredForAdmins({ NODE_ENV: "development" })).toBe(false);
    expect(mfaRequiredForAdmins({ DEPLOY_ENV: "production", NODE_ENV: "production" })).toBe(true);
    expect(mfaRequiredForAdmins({ DEPLOY_ENV: "staging", NODE_ENV: "production", MFA_REQUIRED_FOR_ADMINS: "false" })).toBe(false);
    process.env.MFA_REQUIRED_FOR_ADMINS = "true";
    const owner = await enrolled("owner");
    const editor = await enrolled("editor");
    expect(await mfaRequiredFor(owner.user.id)).toBe(true);
    expect(await mfaRequiredFor(editor.user.id)).toBe(false);
    await expect(disableMfa(owner.user.id, totp.totpAt(owner.secret, T0 + 30_000), T0 + 30_000)).rejects.toThrow(/required for organisation owners and admins/);
    await expect(disableMfa(editor.user.id, "000000", T0 + 30_000)).rejects.toThrow(/isn't right/);
    await disableMfa(editor.user.id, totp.totpAt(editor.secret, T0 + 30_000), T0 + 30_000);
    expect((await mfaStatus(editor.user.id)).enabled).toBe(false);
  });

  it("new recovery codes replace the old ones", async () => {
    const s = await enrolled();
    const { recoveryCodes } = await regenerateRecoveryCodes(s.user.id, totp.totpAt(s.secret, T0 + 30_000), T0 + 30_000);
    expect(recoveryCodes).not.toEqual(s.recoveryCodes);
    await expect(completeMfaChallenge(s.sessionId, s.user.id, s.recoveryCodes[1], null, T0 + 60_000)).rejects.toThrow(/isn't right/);
    expect(await completeMfaChallenge(s.sessionId, s.user.id, recoveryCodes[1], null, T0 + 60_000)).toBe("recovery");
  });

  it("configuration: invalid values are refused; turning the requirement off in production warns", () => {
    const keys = (env: Record<string, string>, level: string) => checkConfig(env).filter((p) => p.level === level).map((p) => p.key);
    expect(keys({ MFA_REQUIRED_FOR_ADMINS: "maybe" }, "error")).toContain("MFA_REQUIRED_FOR_ADMINS");
    expect(keys({ DEPLOY_ENV: "production", NODE_ENV: "production", MFA_REQUIRED_FOR_ADMINS: "false" }, "warning")).toContain("MFA_REQUIRED_FOR_ADMINS");
  });
});
