import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { randomToken, sha256 } from "../crypto";
import { audit } from "../audit";
import { log } from "../log";
import { isStrict } from "../config";
import { appUrl, sendEmail } from "../email";
import { enforce } from "../ratelimit";

/**
 * Email verification (docs/EMAIL.md).
 *
 * - A new account gets a link by email: random 256-bit token, stored only as a SHA-256, valid for
 *   24 hours, single use, bound to the address it was sent to. Sending a new one voids the old ones.
 * - Verifying accepts the organisation invitations waiting for that address. Until then an
 *   invitation can't be claimed just by signing up with someone else's email.
 * - EMAIL_VERIFICATION=required (the default in staging and production): an unverified account
 *   reaches only the "check your inbox" page, and the access guards refuse every brand and
 *   organisation action. "optional" (the default in development) shows a reminder instead.
 */
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
type Env = Record<string, string | undefined>;

export class VerificationError extends Error {}

export function emailVerificationRequired(env: Env = process.env) {
  const v = (env.EMAIL_VERIFICATION ?? "").trim().toLowerCase();
  if (v === "required") return true;
  if (v === "optional") return isStrict(env); // never optional in staging or production
  return isStrict(env);
}

/** Issue a link and send it. Returns whether the email provider reported delivery. */
export async function sendVerification(userId: string): Promise<{ delivered: boolean }> {
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, verified: schema.users.emailVerifiedAt }).from(schema.users).where(eq(schema.users.id, userId));
  if (!u || u.verified) return { delivered: false };
  const token = randomToken(32);
  await db.update(schema.emailVerifications).set({ usedAt: new Date() }).where(and(eq(schema.emailVerifications.userId, u.id), isNull(schema.emailVerifications.usedAt)));
  await db.insert(schema.emailVerifications).values({ userId: u.id, email: u.email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) });
  const link = `${appUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  try {
    const r = await sendEmail({
      to: u.email,
      subject: "Confirm your email for BrandPilot",
      text: `Hi ${u.name || "there"},\n\nConfirm this email address for your BrandPilot account by opening this link within 24 hours:\n\n${link}\n\nIf you didn't create an account, ignore this email.`,
      tag: "auth.verify_email",
    });
    return { delivered: r.delivered };
  } catch (e) {
    log.warn("auth.verify_email_send_failed", { error: e instanceof Error ? e.message : String(e) });
    return { delivered: false };
  }
}

/**
 * Someone tried to create an account with an address that already has one (S5): tell the owner,
 * without creating anything. Rate-limited per account, so sign-up can't be used to flood an inbox.
 */
export async function notifyExistingAccount(userId: string): Promise<{ delivered: boolean }> {
  const db = await getDb();
  const [u] = await db.select({ email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
  if (!u) return { delivered: false };
  try {
    await enforce("email", { key: sha256(`signup-existing:${userId}`) });
  } catch {
    return { delivered: false };
  }
  try {
    const r = await sendEmail({
      to: u.email,
      subject: "Someone tried to create a BrandPilot account with your email",
      text: `Hi ${u.name || "there"},\n\nSomeone just tried to create a new BrandPilot account with this email address, which already has an account. Nothing was changed.\n\nIf it was you, sign in instead: ${appUrl()}/login\nForgot your password? Reset it here: ${appUrl()}/forgot-password\n\nIf it wasn't you, you can ignore this email.`,
      tag: "auth.signup_existing",
    });
    return { delivered: r.delivered };
  } catch (e) {
    log.warn("auth.signup_existing_send_failed", { error: e instanceof Error ? e.message : String(e) });
    return { delivered: false };
  }
}

/** "Send it again", rate-limited per account. */
export async function resendVerification(userId: string) {
  await enforce("email", { key: sha256(`verify:${userId}`) });
  return sendVerification(userId);
}

export type VerifyResult = { ok: true; acceptedInvites: number } | { ok: false; error: string };
const INVALID = "This link is invalid or has expired. Sign in and send a new one.";

/** Use a verification link: single use, unexpired, and only for the address it was sent to. */
export async function verifyEmail(token: string, ip: string | null = null): Promise<VerifyResult> {
  if (!token || token.length > 200) return { ok: false, error: INVALID };
  const db = await getDb();
  const now = new Date();
  const [claimed] = await db
    .update(schema.emailVerifications)
    .set({ usedAt: now })
    .where(and(eq(schema.emailVerifications.tokenHash, sha256(token)), isNull(schema.emailVerifications.usedAt), gt(schema.emailVerifications.expiresAt, now)))
    .returning();
  if (!claimed) return { ok: false, error: INVALID };
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, claimed.userId));
  // The address changed since the link was sent: the link proves nothing about the new one.
  if (!u || u.email !== claimed.email) return { ok: false, error: INVALID };
  if (!u.emailVerifiedAt) await db.update(schema.users).set({ emailVerifiedAt: now }).where(eq(schema.users.id, u.id));
  const { acceptInvitesForVerifiedEmail } = await import("../members");
  const accepted = await acceptInvitesForVerifiedEmail(u.id, u.email);
  await audit({ action: "auth.email_verified", actorUserId: u.id, targetType: "user", targetId: u.id, ip, details: { acceptedInvites: accepted } });
  return { ok: true, acceptedInvites: accepted };
}

export async function isEmailVerified(userId: string) {
  const db = await getDb();
  const [u] = await db.select({ at: schema.users.emailVerifiedAt }).from(schema.users).where(eq(schema.users.id, userId));
  return Boolean(u?.at);
}
