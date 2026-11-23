"use server";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { hashPassword, needsRehash, verifyDummy, verifyPassword } from "@/server/auth/password";
import { createSession, destroySession, getSession } from "@/server/auth/session";
import { audit } from "@/server/audit";
import { headers } from "next/headers";
import { enforce, RateLimitError } from "@/server/ratelimit";
import { keyedHash, sha256 } from "@/server/crypto";
import { clientIp as ipFrom } from "@/server/client-ip";

/** Client IP from the trusted proxy hop (see src/server/client-ip.ts). */
async function clientIp() {
  return ipFrom(await headers());
}

/** Brute-force protection; keys are hashed so emails/IPs never appear in the limiter table. */
async function limited(kind: "login" | "signup", ...parts: string[]): Promise<string | null> {
  try {
    for (const p of parts) await enforce("login", { key: sha256(`${kind}:${p}`) });
    return null;
  } catch (e) {
    if (e instanceof RateLimitError) return e.message;
    throw e;
  }
}

/**
 * Result of a failed sign-in or sign-up. `values` echoes what the person typed (never the
 * password) so the form can show it again: React resets a form after its action runs.
 */
export type AuthFormState = { error?: string; values?: { email?: string; name?: string; workspace?: string; type?: string } };

const echo = (v: FormDataEntryValue | null) => String(v ?? "").slice(0, 320);

const SignUp = z.object({
  name: z.string().trim().min(1, "Enter your name"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(256, "Use at most 256 characters"),
  workspace: z.string().trim().min(1, "Name your workspace"),
  type: z.enum(["creator", "business", "agency"]),
});

export async function signUp(_: unknown, fd: FormData): Promise<AuthFormState> {
  const values = { name: echo(fd.get("name")), email: echo(fd.get("email")), workspace: echo(fd.get("workspace")), type: echo(fd.get("type")) };
  const parsed = SignUp.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message, values };
  const { name, email, password, workspace, type } = parsed.data;
  const ip = await clientIp();
  const blocked = await limited("signup", `ip:${ip}`);
  if (blocked) return { error: blocked, values };
  // Private beta: invited emails only. Checked before the account lookup, with one message for
  // every uninvited email, so this can't be used to find out whether an address has an account.
  const { mayCreateAccount, markInviteUsed, NOT_INVITED } = await import("@/server/beta-invites");
  if (!(await mayCreateAccount(email))) return { error: NOT_INVITED, values };
  const db = await getDb();
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (exists) return { error: "An account with this email already exists.", values };
  const [user] = await db.insert(schema.users).values({ name, email, passwordHash: await hashPassword(password) }).returning();
  const { emailVerificationRequired, sendVerification } = await import("@/server/auth/verify-email");
  const mustVerify = emailVerificationRequired();

  // Invitations for this email are accepted only once the address is verified (or the invitation
  // link is opened while signed in): signing up with someone else's address must not claim them.
  // In development with verification optional they're accepted straight away, as before.
  const pending = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.invitedEmail, email), isNull(schema.workspaceMembers.userId), eq(schema.workspaceMembers.status, "invited")));
  let accepted = 0;
  if (!mustVerify && pending.length) {
    const { acceptInvitesForVerifiedEmail } = await import("@/server/members");
    accepted = await acceptInvitesForVerifiedEmail(user.id, email);
  }
  let workspaceId: string | null = null;
  if (!pending.length) {
    const [ws] = await db.insert(schema.workspaces).values({ name: workspace, type }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
    workspaceId = ws.id;
  }
  await markInviteUsed(email);
  await audit({ action: "auth.signup", workspaceId, actorUserId: user.id, targetType: "user", targetId: user.id, ip, details: { pendingInvites: pending.length, acceptedInvites: accepted } });
  const sent = await sendVerification(user.id);
  await audit({ action: "auth.verification_sent", actorUserId: user.id, targetType: "user", targetId: user.id, ip, details: { delivered: sent.delivered } });
  await createSession(user.id);
  redirect(mustVerify ? "/verify-email" : pending.length ? "/dashboard" : "/onboarding");
}

/** "Send the link again" on the verification page (signed in, rate-limited per account). */
export async function resendVerificationAction(): Promise<{ ok: boolean; message: string }> {
  const s = await getSession();
  if (!s) return { ok: false, message: "Sign in first." };
  const { resendVerification } = await import("@/server/auth/verify-email");
  try {
    const r = await resendVerification(s.user.id);
    return { ok: true, message: r.delivered ? `We sent a new link to ${s.user.email}.` : "We couldn't send the email right now. Try again later, or contact support." };
  } catch (e) {
    if (e instanceof RateLimitError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function logIn(_: unknown, fd: FormData): Promise<AuthFormState> {
  const values = { email: echo(fd.get("email")) };
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "").slice(0, 256);
  const ip = await clientIp();
  const blocked = await limited("login", `email:${email}`, `ip:${ip}`);
  if (blocked) {
    await audit({ action: "auth.login_failed", outcome: "denied", ip, details: { reason: "rate_limited", emailHash: keyedHash(`email:${email}`) } });
    return { error: blocked, values };
  }
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  // Same hashing work whether or not the account exists, so timing doesn't reveal registered emails.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
  if (!user || !ok) {
    await audit({ action: "auth.login_failed", outcome: "denied", actorUserId: user?.id ?? null, ip, details: { reason: user ? "wrong_password" : "unknown_email", emailHash: keyedHash(`email:${email}`) } });
    return { error: "Email or password is incorrect.", values };
  }
  // Upgrade older password hashes transparently now that we know the password.
  if (needsRehash(user.passwordHash)) await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, user.id));
  // Where to go after signing in (an invitation link, for example): same-site paths only.
  const { safeNext } = await import("@/server/auth/step-up");
  const next = safeNext(String(fd.get("next") ?? "/dashboard"));
  if (user.mfaEnabledAt) {
    // Second step: the session can only complete sign-in until a code is verified (auth/mfa.ts).
    await createSession(user.id, { pendingMfa: true });
    redirect(next === "/dashboard" ? "/login/mfa" : `/login/mfa?next=${encodeURIComponent(next)}`);
  }
  await audit({ action: "auth.login", actorUserId: user.id, targetType: "user", targetId: user.id, ip });
  await createSession(user.id);
  redirect(next);
}

export async function logOut() {
  const s = await getSession();
  if (s) await audit({ action: "auth.logout", actorUserId: s.user.id, targetType: "user", targetId: s.user.id });
  await destroySession();
  redirect("/login");
}

export type RecoveryFormState = { error?: string; sent?: boolean; email?: string };

/** Forgot password: always the same answer, whether or not the email has an account. */
export async function requestPasswordResetAction(_: unknown, fd: FormData): Promise<RecoveryFormState> {
  const email = echo(fd.get("email"));
  const { requestPasswordReset } = await import("@/server/auth/recovery");
  const r = await requestPasswordReset(email, await clientIp());
  return r.ok ? { sent: true, email } : { error: r.error, email };
}

/** Set a new password from a reset link, then sign in again. */
export async function resetPasswordAction(_: unknown, fd: FormData): Promise<RecoveryFormState> {
  const token = String(fd.get("token") ?? "");
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  const { resetPassword, RecoveryError } = await import("@/server/auth/recovery");
  try {
    await resetPassword(token, password, await clientIp());
  } catch (e) {
    if (e instanceof RecoveryError) return { error: e.message };
    throw e;
  }
  redirect("/login?reset=1");
}
