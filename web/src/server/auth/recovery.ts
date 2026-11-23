import "server-only";
import { notifyAccountChange } from "./notify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db/client";
import { randomToken, sha256 } from "../crypto";
import { hashPassword } from "./password";
import { audit } from "../audit";
import { log } from "../log";
import { enforce, RateLimitError } from "../ratelimit";

/**
 * Account recovery (launch gate S11).
 *
 * Forgot password (self-service):
 *   - The answer is the same whether or not the email has an account; timing is evened out too.
 *   - Rate-limited per email and per client IP.
 *   - A token is random (256 bits), stored only as a SHA-256, valid for 30 minutes, single use.
 *     Issuing a new one voids the previous ones.
 *   - It goes by email through the email hook. Until a provider is configured (O3), the log driver
 *     records that it wasn't sent, and staging/production refuse to "send" at all. The operator
 *     path below is the fallback.
 *   - Resetting ends every session of the account. Two-step verification is NOT bypassed: the next
 *     sign-in still asks for the second factor.
 *
 * Operator recovery (npm run users), for invite-only beta support. The operator confirms the
 * person's identity out of band first:
 *   - reset-link: a reset link valid for 24 hours, handed to the person directly.
 *   - reset-mfa: turns off two-step verification after the person lost both their authenticator
 *     and their recovery codes. Ends all sessions. Owners and admins must enrol again at their next
 *     sign-in wherever MFA is required.
 * Both are audited with the operator's name and a reason.
 */

export const RESET_TTL_MS = 30 * 60 * 1000;
export const OPERATOR_RESET_TTL_MS = 24 * 3600 * 1000;
export const MIN_PASSWORD = 8;

export class RecoveryError extends Error {}

const Email = z.string().trim().toLowerCase().email().max(320);

function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

async function issue(userId: string, ttlMs: number, issuedBy: string) {
  const db = await getDb();
  const token = randomToken(32);
  // Void older unused tokens: only the newest link works.
  await db.update(schema.passwordResets).set({ usedAt: new Date() }).where(and(eq(schema.passwordResets.userId, userId), isNull(schema.passwordResets.usedAt)));
  await db.insert(schema.passwordResets).values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs), issuedBy });
  return `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

/** Forgot-password request. Never reveals whether the email has an account. */
export async function requestPasswordReset(rawEmail: string, ip: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const parsed = Email.safeParse(rawEmail);
  if (!parsed.success) return { ok: false, error: "Enter a valid email address." };
  const email = parsed.data;
  try {
    await enforce("login", { key: sha256(`reset:ip:${ip}`) });
    await enforce("login", { key: sha256(`reset:email:${email}`) });
  } catch (e) {
    if (e instanceof RateLimitError) return { ok: false, error: e.message };
    throw e;
  }
  const db = await getDb();
  const [user] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.email, email));
  if (user) {
    const link = await issue(user.id, RESET_TTL_MS, "self");
    await audit({ action: "auth.password_reset_requested", actorUserId: user.id, targetType: "user", targetId: user.id, ip });
    try {
      const { sendEmail } = await import("../email");
      await sendEmail({
        to: user.email,
        subject: "Reset your BrandPilot password",
        text: `Someone asked to reset the password for this BrandPilot account. If it was you, open this link within 30 minutes:\n\n${link}\n\nIf it wasn't you, ignore this email: your password stays the same.`,
        tag: "auth.password_reset",
      });
    } catch (e) {
      // No provider (O3): the request is recorded; an operator can issue a link instead.
      log.warn("auth.password_reset_email_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Even out the timing of known and unknown emails.
  const spent = Date.now() - started;
  if (spent < 400) await new Promise((r) => setTimeout(r, 400 - spent));
  return { ok: true };
}

/** Whether a reset link is still usable (for showing the form or an "expired" message). */
export async function resetTokenValid(token: string) {
  if (!token || token.length > 200) return false;
  const db = await getDb();
  const [r] = await db
    .select({ id: schema.passwordResets.id })
    .from(schema.passwordResets)
    .where(and(eq(schema.passwordResets.tokenHash, sha256(token)), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, new Date())));
  return Boolean(r);
}

/** Set a new password with a reset token. Single use; ends every session of the account. */
export async function resetPassword(token: string, password: string, ip: string | null = null) {
  if (password.length < MIN_PASSWORD) throw new RecoveryError(`Use at least ${MIN_PASSWORD} characters.`);
  if (password.length > 256) throw new RecoveryError("Use at most 256 characters.");
  const db = await getDb();
  const now = new Date();
  // Claim the token atomically: a link can't be used twice, even concurrently.
  const [claimed] = await db
    .update(schema.passwordResets)
    .set({ usedAt: now })
    .where(and(eq(schema.passwordResets.tokenHash, sha256(token ?? "")), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, now)))
    .returning({ userId: schema.passwordResets.userId, issuedBy: schema.passwordResets.issuedBy });
  if (!claimed) throw new RecoveryError("This reset link has expired or was already used. Ask for a new one.");
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, claimed.userId));
  const ended = await db.delete(schema.sessions).where(eq(schema.sessions.userId, claimed.userId)).returning({ id: schema.sessions.id });
  await notifyAccountChange(claimed.userId, "password_reset");
  await audit({ action: "auth.password_reset", actorUserId: claimed.userId, targetType: "user", targetId: claimed.userId, ip, details: { via: claimed.issuedBy.startsWith("operator") ? "operator_link" : "email_link", ended: ended.length } });
  return { userId: claimed.userId };
}

async function userByEmail(rawEmail: string) {
  const email = Email.parse(rawEmail);
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u) throw new RecoveryError(`No account with the email ${email}.`);
  return u;
}

function operator(by: string, reason: string) {
  const b = by.trim();
  const r = reason.trim();
  if (!b) throw new RecoveryError("--by <your name> is required: it's recorded with the change.");
  if (r.length < 5) throw new RecoveryError("--reason is required: say how you confirmed the person's identity.");
  return { by: b.slice(0, 100), reason: r.slice(0, 300) };
}

/** Operator: a reset link valid for 24 hours, for handing to the person directly. */
export async function operatorResetLink(rawEmail: string, by: string, reason: string) {
  const op = operator(by, reason);
  const u = await userByEmail(rawEmail);
  const link = await issue(u.id, OPERATOR_RESET_TTL_MS, `operator:${op.by}`);
  await audit({ action: "auth.password_reset_issued", actorType: "system", targetType: "user", targetId: u.id, details: { by: op.by, reason: op.reason } });
  return { link, email: u.email };
}

/** Operator: turn off two-step verification (lost authenticator and recovery codes). Ends all sessions. */
export async function operatorResetMfa(rawEmail: string, by: string, reason: string) {
  const op = operator(by, reason);
  const u = await userByEmail(rawEmail);
  if (!u.mfaEnabledAt && !u.mfaPendingSecretEnc) throw new RecoveryError(`${u.email} doesn't have two-step verification on.`);
  const db = await getDb();
  await db.update(schema.users).set({ mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryHashes: [] }).where(eq(schema.users.id, u.id));
  const ended = await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).returning({ id: schema.sessions.id });
  await audit({ action: "mfa.reset_by_operator", actorType: "system", targetType: "user", targetId: u.id, details: { by: op.by, reason: op.reason, ended: ended.length } });
  return { email: u.email, sessionsEnded: ended.length };
}
