import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { audit } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { isStrict } from "../config";
import { enforce } from "../ratelimit";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "./totp";

/**
 * Two-step verification (FOLLOW_UPS F3): authenticator-app codes (TOTP) with one-time recovery codes.
 *
 * - Enrolment: a new secret is held as pending until a first code proves the app has it; then MFA is
 *   on and ten recovery codes are shown once (only keyed hashes are stored).
 * - Sign-in: after the password, a session waits for the second factor (session.ts); a TOTP code
 *   (each usable once) or an unused recovery code completes it.
 * - Required for owners and admins when MFA_REQUIRED_FOR_ADMINS is true (default: on in staging and
 *   production, off in development so local demos and tests run without an authenticator).
 * - Attempts are rate-limited like sign-in; every change and failure is in the Security log.
 */
export class MfaError extends Error {}

type Env = Record<string, string | undefined>;

export function mfaRequiredForAdmins(env: Env = process.env): boolean {
  const v = env.MFA_REQUIRED_FOR_ADMINS?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return isStrict(env);
}

/** Owners and admins (of any organisation) must use MFA when the requirement is on. */
export async function mfaRequiredFor(userId: string, env: Env = process.env): Promise<boolean> {
  if (!mfaRequiredForAdmins(env)) return false;
  const db = await getDb();
  const n = await db.$count(schema.workspaceMembers, and(eq(schema.workspaceMembers.userId, userId), eq(schema.workspaceMembers.status, "active"), inArray(schema.workspaceMembers.role, ["owner", "admin"])));
  return n > 0;
}

async function userRow(userId: string) {
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw new MfaError("Account not found.");
  return u;
}

export async function mfaStatus(userId: string) {
  const u = await userRow(userId);
  return { enabled: Boolean(u.mfaEnabledAt), enabledAt: u.mfaEnabledAt, recoveryCodesLeft: u.mfaRecoveryHashes.length, required: await mfaRequiredFor(userId) };
}

/** Step 1: a new secret to add to an authenticator app (kept pending until confirmed). */
export async function startEnrolment(userId: string) {
  const u = await userRow(userId);
  if (u.mfaEnabledAt) throw new MfaError("Two-step verification is already on.");
  const secret = newTotpSecret();
  const db = await getDb();
  await db.update(schema.users).set({ mfaPendingSecretEnc: encrypt(secret) }).where(eq(schema.users.id, userId));
  const uri = otpauthUri(secret, u.email);
  const { toString } = await import("qrcode");
  const svg = await toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { secret, uri, qrSvgDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
}

/** Step 2: the first code from the app turns MFA on. Returns the recovery codes (shown once). */
export async function confirmEnrolment(userId: string, sessionId: string, code: string, now = Date.now()) {
  await enforce("login", { key: `mfa:${userId}` });
  const u = await userRow(userId);
  if (u.mfaEnabledAt) throw new MfaError("Two-step verification is already on.");
  if (!u.mfaPendingSecretEnc) throw new MfaError("Start the setup again.");
  const secret = decrypt(u.mfaPendingSecretEnc);
  const step = verifyTotp(secret, code, now);
  if (step === null) throw new MfaError("That code isn't right. Check your authenticator app's time and try the current code.");
  const { codes, hashes } = newRecoveryCodes();
  const db = await getDb();
  await db
    .update(schema.users)
    .set({ mfaSecretEnc: u.mfaPendingSecretEnc, mfaPendingSecretEnc: null, mfaEnabledAt: new Date(now), mfaLastStep: step, mfaRecoveryHashes: hashes })
    .where(eq(schema.users.id, userId));
  // The session that enrolled has just proved the second factor.
  await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(now) }).where(eq(schema.sessions.id, sessionId));
  await audit({ action: "mfa.enable", actorUserId: userId, targetType: "user", targetId: userId });
  return { recoveryCodes: codes };
}

/** Check a TOTP or recovery code for a user with MFA on. Consumes the code. */
async function checkSecondFactor(userId: string, code: string, now: number): Promise<"totp" | "recovery" | null> {
  const u = await userRow(userId);
  if (!u.mfaEnabledAt || !u.mfaSecretEnc) return null;
  const db = await getDb();
  const step = verifyTotp(decrypt(u.mfaSecretEnc), code, now, u.mfaLastStep);
  if (step !== null) {
    // Compare-and-set on the last used step: if a concurrent sign-in used this code first, this loses.
    const unchanged = u.mfaLastStep === null ? isNull(schema.users.mfaLastStep) : eq(schema.users.mfaLastStep, u.mfaLastStep);
    const [ok] = await db.update(schema.users).set({ mfaLastStep: step }).where(and(eq(schema.users.id, userId), unchanged)).returning({ id: schema.users.id });
    return ok ? "totp" : null;
  }
  const h = hashRecoveryCode(code);
  if (code.replace(/[^a-z0-9]/gi, "").length === 8 && u.mfaRecoveryHashes.includes(h)) {
    // Consumed only if still present: a recovery code can't be used twice, even concurrently.
    const [ok] = await db
      .update(schema.users)
      .set({ mfaRecoveryHashes: u.mfaRecoveryHashes.filter((x) => x !== h) })
      .where(and(eq(schema.users.id, userId), sql`${schema.users.mfaRecoveryHashes} @> ${JSON.stringify([h])}::jsonb`))
      .returning({ id: schema.users.id });
    return ok ? "recovery" : null;
  }
  return null;
}

/** Complete sign-in for a session waiting for its second factor. */
export async function completeMfaChallenge(sessionId: string, userId: string, code: string, ip: string | null, now = Date.now()) {
  await enforce("login", { key: `mfa:${userId}` });
  const how = await checkSecondFactor(userId, code, now);
  if (!how) {
    await audit({ action: "auth.mfa_failed", outcome: "denied", actorUserId: userId, targetType: "user", targetId: userId, ip });
    throw new MfaError("That code isn't right.");
  }
  const db = await getDb();
  await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(now) }).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)));
  await audit({ action: "auth.login", actorUserId: userId, targetType: "user", targetId: userId, ip, details: { mfa: how } });
  if (how === "recovery") await audit({ action: "mfa.recovery_used", actorUserId: userId, targetType: "user", targetId: userId, details: { left: (await userRow(userId)).mfaRecoveryHashes.length } });
  return how;
}

/** Turn MFA off with a current code. Refused while it's required for this user. */
export async function disableMfa(userId: string, code: string, now = Date.now()) {
  await enforce("login", { key: `mfa:${userId}` });
  if (await mfaRequiredFor(userId)) throw new MfaError("Two-step verification is required for organisation owners and admins, so it can't be turned off.");
  if (!(await checkSecondFactor(userId, code, now))) {
    await audit({ action: "auth.mfa_failed", outcome: "denied", actorUserId: userId, targetType: "user", targetId: userId, details: { during: "disable" } });
    throw new MfaError("That code isn't right.");
  }
  const db = await getDb();
  await db.update(schema.users).set({ mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryHashes: [] }).where(eq(schema.users.id, userId));
  await audit({ action: "mfa.disable", actorUserId: userId, targetType: "user", targetId: userId });
}

/** New recovery codes (the old ones stop working), confirmed with a current code. */
export async function regenerateRecoveryCodes(userId: string, code: string, now = Date.now()) {
  await enforce("login", { key: `mfa:${userId}` });
  if (!(await checkSecondFactor(userId, code, now))) throw new MfaError("That code isn't right.");
  const { codes, hashes } = newRecoveryCodes();
  const db = await getDb();
  await db.update(schema.users).set({ mfaRecoveryHashes: hashes }).where(eq(schema.users.id, userId));
  await audit({ action: "mfa.recovery_regenerated", actorUserId: userId, targetType: "user", targetId: userId });
  return { recoveryCodes: codes };
}
