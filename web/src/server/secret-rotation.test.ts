/**
 * S3: rotating APP_SECRET without signing anyone out of their social accounts or two-step
 * verification (crypto.ts key ids and APP_SECRET_PREVIOUS; secrets-rotate.ts).
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
const OLD = "old-secret-old-secret-old-secret-0001";
const NEW = "new-secret-new-secret-new-secret-0002";
process.env.APP_SECRET = OLD;
delete process.env.APP_SECRET_PREVIOUS;

const c = await import("./crypto");
const { getDb, schema } = await import("./db/client");
const { reencryptAll, rotationStatus } = await import("./secrets-rotate");
const { newRecoveryCodes } = await import("./auth/totp");
const { checkSecondFactor } = await import("./auth/mfa");
const { checkConfig } = await import("./config");

const rotate = () => {
  process.env.APP_SECRET = NEW;
  process.env.APP_SECRET_PREVIOUS = OLD;
};
beforeEach(() => {
  process.env.APP_SECRET = OLD;
  delete process.env.APP_SECRET_PREVIOUS;
});

/** The pre-key-id format: base64(iv | tag | ciphertext) under sha256(secret). */
function legacyEncrypt(plain: string, secret: string) {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const ci = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([ci.update(plain, "utf8"), ci.final()]);
  return Buffer.concat([iv, ci.getAuthTag(), ct]).toString("base64");
}

describe("versioned encryption", () => {
  it("new values carry the key id; old-format values still decrypt; after a rotation both keys read and only the new one writes", () => {
    const before = c.encrypt("token-a");
    expect(before).toMatch(/^v1\.[0-9a-f]{8}\./);
    const legacy = legacyEncrypt("token-legacy", OLD);
    expect(c.decrypt(legacy)).toBe("token-legacy");
    expect(c.keyIdOf(legacy)).toBe("legacy");
    const oldId = c.keyIdOf(before);

    rotate();
    expect(c.keys().map((k) => k.current)).toEqual([true, false]);
    expect(c.decrypt(before)).toBe("token-a");
    expect(c.decrypt(legacy)).toBe("token-legacy");
    const after = c.encrypt("token-b");
    expect(c.keyIdOf(after)).not.toBe(oldId);

    delete process.env.APP_SECRET_PREVIOUS; // old key removed too early
    expect(() => c.decrypt(before)).toThrow(/key id .* APP_SECRET_PREVIOUS/);
    expect(() => c.decrypt(legacy)).toThrow(c.DecryptError);
    expect(c.decrypt(after)).toBe("token-b");
  });

  it("signed tokens (OAuth state, media links) from before a rotation stay valid until they expire", () => {
    const t = c.sign({ x: 1, exp: Date.now() + 60_000 });
    rotate();
    expect(c.verify(t)).toMatchObject({ x: 1 });
    delete process.env.APP_SECRET_PREVIOUS;
    expect(c.verify(t)).toBeNull();
    expect(c.verify(c.sign({ x: 2 }))).toMatchObject({ x: 2 });
  });
});

describe("rotation end to end", () => {
  it("re-encrypts tokens and two-step secrets; recovery codes keep working; status shows what still needs the old key", async () => {
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ email: "rot@x.test", name: "R", passwordHash: "x" }).returning();
    const codes = newRecoveryCodes();
    const legacyHash = (code: string) => crypto.createHmac("sha256", crypto.createHash("sha256").update(OLD).digest()).update(`bp-recovery:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`).digest("hex");
    await db
      .update(schema.users)
      .set({ mfaSecretEnc: legacyEncrypt("JBSWY3DPEHPK3PXP", OLD), mfaEnabledAt: new Date(), mfaRecoveryHashes: [...codes.hashes.slice(0, 9), legacyHash("abcd-efgh")] })
      .where(eq(schema.users.id, u.id));
    const [w] = await db.insert(schema.workspaces).values({ name: "W" }).returning();
    const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "B" }).returning();
    await db.insert(schema.socialAccounts).values({ brandId: b.id, platform: "instagram", externalId: "1", name: "ig", accessTokenEnc: c.encrypt("ig-access"), refreshTokenEnc: legacyEncrypt("ig-refresh", OLD) });

    rotate();
    const s1 = await rotationStatus();
    expect(s1.previous).toHaveLength(1);
    expect(Object.keys(s1.encrypted.find((e) => e.column === "social_accounts.accessTokenEnc")!.byKey)).toEqual([s1.previous[0]]);

    // Recovery codes issued under the old secret (tagged and untagged) still sign in.
    expect(await checkSecondFactor(u.id, codes.codes[0], Date.now())).toBe("recovery");
    expect(await checkSecondFactor(u.id, "abcd-efgh", Date.now())).toBe("recovery");

    const dry = await reencryptAll({ dryRun: true, by: "test" });
    expect(dry.reencrypted).toBe(3);
    const r = await reencryptAll({ by: "test" });
    expect(r).toMatchObject({ reencrypted: 3, failed: [] });
    expect((await reencryptAll({ by: "test" })).reencrypted).toBe(0);

    const s2 = await rotationStatus();
    for (const e of s2.encrypted) for (const k of Object.keys(e.byKey)) expect(k).toBe(s2.current);
    expect(Object.keys(s2.recoveryCodes.byKey)).toEqual([s2.previous[0]]); // 8 codes left, under the old key

    // With the old key gone, re-encrypted values still read.
    delete process.env.APP_SECRET_PREVIOUS;
    const [acct] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, b.id));
    expect(c.decrypt(acct.accessTokenEnc)).toBe("ig-access");
    expect(c.decrypt(acct.refreshTokenEnc!)).toBe("ig-refresh");
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(c.decrypt(after.mfaSecretEnc!)).toBe("JBSWY3DPEHPK3PXP");
    const [ev] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "config.secrets_reencrypt"));
    expect(ev).toBeTruthy();
  });

  it("a value under an unknown key is reported, not fatal", async () => {
    const db = await getDb();
    const [w] = await db.insert(schema.workspaces).values({ name: "W2" }).returning();
    const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "B2" }).returning();
    await db.insert(schema.socialAccounts).values({ brandId: b.id, platform: "facebook", externalId: "2", name: "fb", accessTokenEnc: legacyEncrypt("x", "some-other-secret-some-other-secret-xx") });
    const r = await reencryptAll({ by: "test" });
    expect(r.failed.some((f) => f.startsWith("social_accounts.accessTokenEnc"))).toBe(true);
  });

  it("new recovery codes are tagged with the current key id", () => {
    rotate();
    const { hashes } = newRecoveryCodes();
    const cur = c.keys()[0].id;
    expect(hashes.every((h) => h.startsWith(`${cur}:`))).toBe(true);
  });

  it("configuration: a short previous secret is an error; the same as the current one is a warning", () => {
    const probs = (env: Record<string, string>) => checkConfig(env).filter((p) => p.key === "APP_SECRET_PREVIOUS").map((p) => p.level);
    expect(probs({ APP_SECRET: NEW, APP_SECRET_PREVIOUS: "short" })).toEqual(["error"]);
    expect(probs({ APP_SECRET: NEW, APP_SECRET_PREVIOUS: NEW })).toEqual(["warning"]);
    expect(probs({ APP_SECRET: NEW, APP_SECRET_PREVIOUS: OLD })).toEqual([]);
  });
});
